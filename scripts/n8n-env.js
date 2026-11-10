// Prints the environment n8n needs (used by start-n8n-windows.bat / start-n8n.sh).
// Usage: node scripts/n8n-env.js [cmd|sh]
import { config } from '../server/config.js';
import fs from 'node:fs';
import path from 'node:path';

const fileEnv = {};
try {
  for (const line of fs.readFileSync(path.join(config.root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) fileEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }
const vars = {
  GENERIC_TIMEZONE: 'Asia/Kolkata',
  TZ: 'Asia/Kolkata',
  N8N_BLOCK_ENV_ACCESS_IN_NODE: 'false',
  N8N_SECURE_COOKIE: 'false',
  N8N_DIAGNOSTICS_ENABLED: 'false',
  NS_BACKEND_URL: `http://localhost:${config.port}`,
  NS_AUTOMATION_KEY: config.automationKey,
  NS_N8N_SECRET: config.n8n.secret,
  NS_AI_BASE_URL: process.env.AI_BASE_URL || fileEnv.AI_BASE_URL || 'https://api.openai.com/v1',
  NS_AI_API_KEY: process.env.AI_API_KEY || fileEnv.AI_API_KEY || '',
  NS_AI_MODEL: process.env.AI_MODEL || fileEnv.AI_MODEL || '',
};
const shell = process.argv[2] || (process.platform === 'win32' ? 'cmd' : 'sh');
for (const [k, v] of Object.entries(vars)) {
  if (shell === 'cmd') console.log(`set "${k}=${v}"`);
  else console.log(`export ${k}='${String(v).replace(/'/g, "'\\''")}'`);
}
