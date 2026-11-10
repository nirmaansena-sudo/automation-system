// Minimal HTTP framework on node:http — router, JSON bodies, cookies,
// static files and server-sent events. No external packages.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';

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
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
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

const normalizeIp = (value) => String(value || '').trim().replace(/^::ffff:/, '');
export function clientIp(req, trustedProxies = []) {
  const remote = normalizeIp(req.socket?.remoteAddress);
  const trusted = new Set(trustedProxies.map(normalizeIp));
  if (!trusted.has(remote)) return remote;
  // Walk from the immediate peer toward the client. Never trust the leftmost
  // value merely because the request arrived through a proxy.
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(normalizeIp);
  let current = remote;
  for (let i = chain.length - 1; i >= 0 && trusted.has(current); i--) {
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
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN' });
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
  const safe = path.normalize(decodeURIComponent(relPath)).replace(/^(\.\.[/\\])+/, '');
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
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        ctx.rawBody = await readBody(req, opts.limit || 2 * 1024 * 1024);
        const type = String(req.headers['content-type'] || '');
        if (type.includes('application/json') && ctx.rawBody.length) {
          try { ctx.body = JSON.parse(ctx.rawBody.toString('utf8')); } catch { throw bad('Invalid JSON body'); }
        } else if (type.includes('application/x-www-form-urlencoded')) {
          ctx.body = Object.fromEntries(new URLSearchParams(ctx.rawBody.toString('utf8')));
        } else ctx.body = {};
      }
      if (before) await before(ctx, opts);
      const out = await m.route.handler(ctx);
      if (out !== undefined && !res.headersSent && !ctx.headersSent) ctx.json(out);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) (onError || console.error)(e, ctx || { method: req.method, path: url.pathname });
      const body = { error: status >= 500 ? 'Something went wrong on the server. It has been logged.' : e.message, ...(e.extra || {}) };
      if (ctx) ctx.json(body, status);
      else { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
    }
  });
}
