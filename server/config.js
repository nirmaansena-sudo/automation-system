// Configuration: reads .env (no dependencies), environment variables and
// auto-generated secrets stored in DATA_DIR/secrets.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFileProblems = []; // shown at start-up and in the health panel
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const raw = fs.readFileSync(file);
  // Notepad's "Unicode" (UTF-16) saves two bytes per letter: nothing would be read at all.
  if (raw.includes(0)) { envFileProblems.push({ fatal: true, text: 'The .env file is not saved as plain text. In Notepad choose File → Save as → Encoding: UTF-8, then start again.' }); return out; }
  const text = raw.toString('utf8').replace(/^\uFEFF/, '');
  for (const [i, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) { envFileProblems.push({ text: `Line ${i + 1} of the .env file is ignored because it has no "=": ${line.slice(0, 40)}` }); continue; }
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = parseEnvFile(path.join(ROOT, '.env'));
const knownKeys = new Set(['DOMAIN', 'NS_TEST', 'NS_DEFAULT_DATA_DIR', 'NS_DISABLE_WORKERS']); // every setting this program reads
const env = (k, d = '') => { knownKeys.add(k); return process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : (fileEnv[k] !== undefined && fileEnv[k] !== '' ? fileEnv[k] : d); };
const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
const word = (v) => String(v).trim().toLowerCase(); // "Cloud " and "cloud" mean the same

const dataDir = path.resolve(ROOT, env('DATA_DIR', process.env.NS_DEFAULT_DATA_DIR || './data'));
fs.mkdirSync(dataDir, { recursive: true });

// Secrets that the owner does not need to type for local testing.
const secretsFile = path.join(dataDir, 'secrets.json');
let secrets = {};
try { secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8')); } catch { secrets = {}; }
let changed = false;
for (const k of ['sessionSecret', 'automationKey', 'verifyToken', 'websiteSecret', 'n8nSecret']) {
  if (!secrets[k]) { secrets[k] = crypto.randomBytes(24).toString('base64url'); changed = true; }
}
if (changed) fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));

const argv = process.argv.slice(2);

export const config = {
  root: ROOT,
  dataDir,
  dbFile: path.join(dataDir, env('DB_FILE', 'nirmaan.db')),
  mediaDir: path.join(dataDir, 'media'),
  backupDir: path.join(dataDir, 'backups'),
  backupPassword: env('BACKUP_PASSWORD'),
  backupOffsiteDir: env('BACKUP_OFFSITE_DIR') ? path.resolve(env('BACKUP_OFFSITE_DIR')) : '',
  trustedProxies: env('TRUSTED_PROXY_IPS').split(',').map(s => s.trim()).filter(Boolean),
  routing: { osrmUrl: env('OSRM_BASE_URL').replace(/\/$/, '') },
  transcription: { url: env('TRANSCRIPTION_URL'), token: env('TRANSCRIPTION_TOKEN'), timeoutMs: Number(env('TRANSCRIPTION_TIMEOUT_MS', '25000')), dailyLimit: Number(env('TRANSCRIPTION_DAILY_LIMIT', '25')) },
  port: Number(env('PORT', '3000')),
  host: env('HOST', '0.0.0.0'),
  publicUrl: env('PUBLIC_URL', `http://localhost:${env('PORT', '3000')}`).trim().replace(/\/+$/, ''),
  demo: argv.includes('--demo') || bool(env('DEMO', 'false')),
  testMode: bool(env('NS_TEST', 'false')),
  sessionSecret: env('SESSION_SECRET', secrets.sessionSecret),
  cookieSecure: bool(env('COOKIE_SECURE', 'false')),

  whatsapp: {
    provider: word(env('WHATSAPP_PROVIDER', 'simulator')), // simulator | cloud | dialog360
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    businessAccountId: env('WHATSAPP_BUSINESS_ACCOUNT_ID'),
    appSecret: env('WHATSAPP_APP_SECRET'),
    verifyToken: env('WHATSAPP_VERIFY_TOKEN', secrets.verifyToken),
    graphVersion: env('WHATSAPP_GRAPH_VERSION', 'v24.0'),
    graphBase: env('WHATSAPP_GRAPH_BASE', 'https://graph.facebook.com'),
    dialogApiKey: env('DIALOG360_API_KEY'),
    dialogBase: env('DIALOG360_BASE_URL', 'https://waba-v2.360dialog.io'),
    requestTimeoutMs: Number(env('WHATSAPP_TIMEOUT_MS', '15000')),
    coexistence: bool(env('WHATSAPP_COEXISTENCE', 'false')),
  },

  ai: {
    mode: word(env('AI_MODE', 'off')), // off | n8n | anthropic | openai
    apiKey: env('AI_API_KEY'),
    model: env('AI_MODEL', ''),
    baseUrl: env('AI_BASE_URL', ''),
    timeoutMs: Number(env('AI_TIMEOUT_MS', '9000')),
    dailyLimit: Number(env('AI_DAILY_LIMIT', '200')),
  },

  n8n: {
    baseUrl: env('N8N_BASE_URL', '').replace(/\/$/, ''),
    eventsPath: env('N8N_EVENTS_PATH', '/webhook/ns-events'),
    aiPath: env('N8N_AI_PATH', '/webhook/ns-ai-understand'),
    secret: env('N8N_SHARED_SECRET', secrets.n8nSecret),
  },

  routinesMode: word(env('ROUTINES_MODE', 'internal')), // internal | n8n
  routineFallbackMin: Number(env('ROUTINE_FALLBACK_MIN', '20')),
  automationKey: env('AUTOMATION_API_KEY', secrets.automationKey),
  websiteSecret: env('WEBSITE_FORM_SECRET', secrets.websiteSecret),
  ownerAlertPhone: env('OWNER_ALERT_PHONE', ''),
  workersEnabled: !bool(env('NS_DISABLE_WORKERS', 'false')),
};

fs.mkdirSync(config.mediaDir, { recursive: true });
fs.mkdirSync(config.backupDir, { recursive: true });

export function publicSecretsForOwner() {
  return {
    automationKey: config.automationKey,
    verifyToken: config.whatsapp.verifyToken,
    websiteSecret: config.websiteSecret,
    n8nSecret: config.n8n.secret,
  };
}

/**
 * Check the settings before the system starts. `errors` stop the start with a plain
 * explanation (a typing mistake must never leave the system quietly doing something
 * else, such as "sending" WhatsApp messages to nowhere). `warnings` are shown at
 * start-up and in the dashboard's health panel.
 */
export function configProblems() {
  const errors = []; const warnings = [];
  const w = config.whatsapp;
  for (const p of envFileProblems) (p.fatal ? errors : warnings).push(p.text);
  for (const k of Object.keys(fileEnv)) if (!knownKeys.has(k)) warnings.push(`The .env file has a setting this system does not know: ${k}. Check the spelling.`);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) errors.push(`PORT must be a number from 1 to 65535 (it is "${env('PORT', '3000')}").`);
  if (!['simulator', 'cloud', 'dialog360'].includes(w.provider)) errors.push(`WHATSAPP_PROVIDER must be simulator, cloud or dialog360 (it is "${w.provider}").`);
  if (!['off', 'n8n', 'anthropic', 'openai'].includes(config.ai.mode)) errors.push(`AI_MODE must be off, n8n, anthropic or openai (it is "${config.ai.mode}").`);
  if (!['internal', 'n8n'].includes(config.routinesMode)) errors.push(`ROUTINES_MODE must be internal or n8n (it is "${config.routinesMode}").`);
  let url = null;
  try { url = new URL(config.publicUrl); } catch { url = null; }
  const portOk = Number.isInteger(config.port) && config.port >= 1 && config.port <= 65535;
  if ((portOk || env('PUBLIC_URL')) && (!url || !['http:', 'https:'].includes(url.protocol))) errors.push(`PUBLIC_URL must be a full address that starts with http:// or https:// (it is "${config.publicUrl}").`);
  for (const [k, v] of [['WHATSAPP_TIMEOUT_MS', w.requestTimeoutMs], ['AI_TIMEOUT_MS', config.ai.timeoutMs], ['AI_DAILY_LIMIT', config.ai.dailyLimit], ['ROUTINE_FALLBACK_MIN', config.routineFallbackMin], ['TRANSCRIPTION_TIMEOUT_MS', config.transcription.timeoutMs], ['TRANSCRIPTION_DAILY_LIMIT', config.transcription.dailyLimit]]) {
    if (!Number.isFinite(v) || v < 0) errors.push(`${k} must be a number (it is "${env(k)}").`);
  }
  if (config.backupPassword && config.backupPassword.length < 16) errors.push('BACKUP_PASSWORD must be at least 16 characters (or leave it empty to use the generated backup key).');
  if (errors.length) return { errors, warnings };

  const missing = [];
  if (w.provider === 'cloud') { if (!w.token) missing.push('WHATSAPP_TOKEN'); if (!w.phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID'); if (!w.appSecret) missing.push('WHATSAPP_APP_SECRET'); }
  if (w.provider === 'dialog360' && !w.dialogApiKey) missing.push('DIALOG360_API_KEY');
  if (missing.length) warnings.push(`WhatsApp is set to "${w.provider}" but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} empty in .env: messages cannot be sent or received until this is filled in.`);
  const local = /^(localhost|127\.|\[?::1)/.test(url.hostname);
  if (w.provider !== 'simulator' && local) warnings.push('PUBLIC_URL is a localhost address: quotation and project links sent to clients will not open on their phones. Set it to your public https address.');
  if (config.cookieSecure && url.protocol === 'http:') warnings.push('COOKIE_SECURE is true but PUBLIC_URL is plain http: browsers will not keep the dashboard login on other computers. Use the https address, or set COOKIE_SECURE=false while testing on this PC.');
  if (!config.cookieSecure && url.protocol === 'https:') warnings.push('PUBLIC_URL is https but COOKIE_SECURE is not true: set COOKIE_SECURE=true so logins are only ever sent over https.');
  if (['anthropic', 'openai'].includes(config.ai.mode) && (!config.ai.apiKey || !config.ai.model)) warnings.push(`AI_MODE is "${config.ai.mode}" but AI_API_KEY or AI_MODEL is empty: AI understanding stays off (buttons and keyword rules still work).`);
  if ((config.ai.mode === 'n8n' || config.routinesMode === 'n8n') && !config.n8n.baseUrl) warnings.push('n8n is selected (AI_MODE or ROUTINES_MODE) but N8N_BASE_URL is empty: this system does that work itself until n8n is connected.');
  return { errors, warnings };
}
