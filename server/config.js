// Configuration: reads .env (no dependencies), environment variables and
// auto-generated secrets stored in DATA_DIR/secrets.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
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
const env = (k, d = '') => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : (fileEnv[k] !== undefined && fileEnv[k] !== '' ? fileEnv[k] : d));
const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

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
  publicUrl: env('PUBLIC_URL', `http://localhost:${env('PORT', '3000')}`).replace(/\/$/, ''),
  demo: argv.includes('--demo') || bool(env('DEMO', 'false')),
  testMode: bool(env('NS_TEST', 'false')),
  sessionSecret: env('SESSION_SECRET', secrets.sessionSecret),
  cookieSecure: bool(env('COOKIE_SECURE', 'false')),

  whatsapp: {
    provider: env('WHATSAPP_PROVIDER', 'simulator'), // simulator | cloud | dialog360
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
    mode: env('AI_MODE', 'off'), // off | n8n | anthropic | openai
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

  routinesMode: env('ROUTINES_MODE', 'internal'), // internal | n8n
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
