// Minimal HTTP framework on node:http — router, JSON bodies, cookies,
// static files and server-sent events. No external packages.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { isIP, BlockList } from 'node:net';

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (msg, extra) => new HttpError(400, msg, extra);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, msg);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.csv': 'text/csv; charset=utf-8', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.db': 'application/octet-stream',
};
export const contentType = (file) => TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, opts, handler) {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '\\/?$');
    this.routes.push({ method, re, keys, handler, opts });
  }
  get(p, o, h) { this.add('GET', p, o, h); }
  post(p, o, h) { this.add('POST', p, o, h); }
  put(p, o, h) { this.add('PUT', p, o, h); }
  patch(p, o, h) { this.add('PATCH', p, o, h); }
  del(p, o, h) { this.add('DELETE', p, o, h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); }
      catch { throw bad('That address is not valid'); }
      return { route: r, params };
    }
    return null;
  }
}

// How much of an oversized upload is read and thrown away so the sender still
// receives the "too large" answer (closing mid-upload shows up as a network error).
const DISCARD_LIMIT = 16 * 1024 * 1024;
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let tooLarge = false; let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    req.on('data', (c) => {
      size += c.length;
      if (tooLarge) { if (size > limit + DISCARD_LIMIT) { done(reject, new HttpError(413, 'That upload is too large')); req.destroy(); } return; }
      if (size > limit) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => (tooLarge ? done(reject, new HttpError(413, 'That upload is too large')) : done(resolve, Buffer.concat(chunks))));
    req.on('error', (e) => done(reject, e));
    // The sender went away before finishing: stop waiting for the rest.
    req.on('close', () => { if (!req.complete) done(reject, new HttpError(400, 'The upload was interrupted')); });
  });
}
export function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
      catch { throw bad('Invalid cookie encoding'); }
    }
  }
  return out;
}

// Content Security Policy: only this site's own scripts run, so injected markup cannot
// execute code even if a value slipped past escaping.
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
const PAGE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const normalizeIp = (value) => String(value || '').trim().replace(/^::ffff:/, '');
const PRIVATE_NETS = new BlockList();
for (const [net, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['100.64.0.0', 10]]) PRIVATE_NETS.addSubnet(net, bits, 'ipv4');
PRIVATE_NETS.addAddress('::1', 'ipv6'); PRIVATE_NETS.addSubnet('fc00::', 7, 'ipv6');
const isPrivate = (ip) => { const fam = isIP(ip); return fam ? PRIVATE_NETS.check(ip, fam === 6 ? 'ipv6' : 'ipv4') : false; };

/**
 * Trusted reverse proxies: exact addresses or CIDR ranges ("172.30.97.10",
 * "172.30.97.0/24", "::1"). Invalid entries are ignored with a warning.
 */
const matcherCache = new WeakMap();
export function trustMatcher(list = []) {
  if (matcherCache.has(list)) return matcherCache.get(list);
  const block = new BlockList(); let count = 0;
  for (const raw of list) {
    const entry = normalizeIp(raw); if (!entry) continue;
    const [addr, bits] = entry.split('/'); const fam = isIP(addr);
    const n = bits === undefined ? null : Number(bits);
    if (!fam || (n !== null && (!Number.isInteger(n) || n < 0 || n > (fam === 6 ? 128 : 32)))) { console.warn(`TRUSTED_PROXY_IPS: ignoring invalid entry "${raw}"`); continue; }
    if (n === null) block.addAddress(addr, fam === 6 ? 'ipv6' : 'ipv4'); else block.addSubnet(addr, n, fam === 6 ? 'ipv6' : 'ipv4');
    count++;
  }
  const match = (ip) => { const fam = isIP(ip); return count > 0 && !!fam && block.check(ip, fam === 6 ? 'ipv6' : 'ipv4'); };
  matcherCache.set(list, match);
  return match;
}

// Set when requests carry X-Forwarded-For from a private address that is not
// trusted: the app is behind a proxy that is not configured, so every user
// would share the proxy's address (login limits, audit, sessions).
let proxyMisconfig = null;
export const proxyWarning = () => proxyMisconfig;

export function clientIp(req, trustedProxies = []) {
  const remote = normalizeIp(req.socket?.remoteAddress);
  const trusted = trustMatcher(trustedProxies);
  if (!trusted(remote)) {
    if (req.headers['x-forwarded-for'] && isPrivate(remote) && !proxyMisconfig) proxyMisconfig = { remote, at: new Date().toISOString() };
    return remote;
  }
  // Walk from the immediate peer toward the client. Never trust the leftmost
  // value merely because the request arrived through a proxy.
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(normalizeIp);
  let current = remote;
  for (let i = chain.length - 1; i >= 0 && trusted(current); i--) {
    if (!isIP(chain[i])) break;
    current = chain[i];
  }
  return current;
}

function makeCtx(req, res, url, trustedProxies) {
  const ctx = {
    req, res, url, method: req.method, path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    params: {}, body: null, rawBody: null, user: null,
    cookies: parseCookies(req.headers.cookie),
    ip: clientIp(req, trustedProxies),
    headersSent: false,
    setHeader(k, v) { res.setHeader(k, v); },
    json(data, status = 200) {
      if (res.headersSent) return;
      const s = JSON.stringify(data);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(s);
    },
    html(s, status = 200) {
      if (res.headersSent) return;
      // Server-rendered client pages (/q/ /p/ /v/) contain no scripts at all.
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': PAGE_CSP });
      res.end(s);
    },
    text(s, status = 200, type = 'text/plain; charset=utf-8') {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(s);
    },
    send(buf, type, extraHeaders = {}) {
      if (res.headersSent) return;
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, ...extraHeaders });
      res.end(buf);
    },
    redirect(loc, status = 302) { res.writeHead(status, { Location: loc }); res.end(); },
  };
  return ctx;
}

export function serveStatic(ctx, rootDir, relPath, { spaFallback } = {}) {
  let decoded;
  try { decoded = decodeURIComponent(relPath); } catch { throw notFound(); }
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(rootDir, safe);
  if (!file.startsWith(rootDir)) throw notFound();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    if (spaFallback) file = path.join(rootDir, spaFallback);
    else throw notFound();
  }
  const buf = fs.readFileSync(file);
  const type = contentType(file);
  ctx.res.writeHead(200, {
    'Content-Type': type, 'Content-Length': buf.length,
    'Cache-Control': type.startsWith('text/html') || type.includes('javascript') || type.startsWith('text/css') ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    ...(type.startsWith('text/html') ? { 'Content-Security-Policy': APP_CSP, 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' } : {}),
  });
  ctx.res.end(buf);
}

/** Server-sent events hub: browsers reload views when something changes. */
const sseClients = new Set();
export function sseHandler(ctx, filter) {
  ctx.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  ctx.res.write(': connected\n\n');
  const client = { res: ctx.res, filter };
  sseClients.add(client);
  const ping = setInterval(() => { try { ctx.res.write(': ping\n\n'); } catch { /* ignore */ } }, 25000);
  ctx.req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
  ctx.headersSent = true;
}
let pendingTopics = new Set(); let flushTimer = null;
export function broadcast(topic) {
  pendingTopics.add(topic);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    const topics = [...pendingTopics]; pendingTopics = new Set(); flushTimer = null;
    const data = `event: change\ndata: ${JSON.stringify({ topics })}\n\n`;
    for (const c of sseClients) {
      if (c.filter && !c.filter(topics)) continue;
      try { c.res.write(data); } catch { sseClients.delete(c); }
    }
  }, 150);
}

/**
 * Safety net: a value the database refuses (a missing required field, a link to
 * something that no longer exists, a duplicate) is the caller's input, so it gets
 * a plain explanation instead of "something went wrong". Nothing was saved.
 */
export function constraintMessage(e) {
  const m = /(FOREIGN KEY|NOT NULL|UNIQUE|CHECK) constraint failed(?::\s*(\S+))?/i.exec(String(e?.message || ''));
  if (!m) return null;
  const field = m[2] ? m[2].split('.').pop().replace(/_/g, ' ') : '';
  switch (m[1].toUpperCase()) {
    case 'FOREIGN KEY': return 'One of the selected items no longer exists. Refresh the page and choose again.';
    case 'NOT NULL': return field ? `A required detail is missing: ${field}.` : 'A required detail is missing.';
    case 'UNIQUE': return field ? `That ${field} is already in use.` : 'That already exists.';
    default: return 'One of the values is not allowed here.';
  }
}

export function createServer({ router, before, fallback, onError, trustedProxies = [] }) {
  return http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { res.writeHead(400); res.end(); return; }
    let ctx;
    try {
      ctx = makeCtx(req, res, url, trustedProxies);
      const m = router.match(req.method, url.pathname);
      if (!m) {
        if (fallback) { await fallback(ctx); return; }
        throw notFound();
      }
      ctx.params = m.params;
      const opts = m.route.opts || {};
      // Authenticate before reading the body, so anonymous requests cannot make the
      // server buffer large uploads (up to 40 MB on some routes).
      if (before) await before(ctx, opts);
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        ctx.rawBody = await readBody(req, opts.limit || 2 * 1024 * 1024);
        const type = String(req.headers['content-type'] || '');
        if (type.includes('application/json') && ctx.rawBody.length) {
          try { ctx.body = JSON.parse(ctx.rawBody.toString('utf8')); } catch { throw bad('Invalid JSON body'); }
          // Every endpoint takes named fields. A bare list, number, text or null is a mistake.
          if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw bad('Send the details as named fields');
        } else if (type.includes('application/x-www-form-urlencoded')) {
          ctx.body = Object.fromEntries(new URLSearchParams(ctx.rawBody.toString('utf8')));
        } else ctx.body = {};
      }
      const out = await m.route.handler(ctx);
      if (out !== undefined && !res.headersSent && !ctx.headersSent) ctx.json(out);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
      let status = e instanceof HttpError ? e.status : 500;
      let message = e.message;
      const constraint = status === 500 ? constraintMessage(e) : null;
      if (constraint) { status = 400; message = constraint; console.warn(`[${new Date().toISOString()}] ${req.method} ${url.pathname}: rejected by the database (${e.message})`); }
      if (status >= 500) (onError || console.error)(e, ctx || { method: req.method, path: url.pathname });
      const body = { error: status >= 500 ? 'Something went wrong on the server. It has been logged.' : message, ...(e.extra || {}) };
      if (ctx) ctx.json(body, status);
      else { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
    }
  });
}
