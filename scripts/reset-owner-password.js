// Emergency access for the owner: sets a one-time temporary password and signs
// the owner out everywhere. It runs only where the data lives, so only someone
// with access to that computer or server can use it.
//   Windows PC (in the nirmaan-sena-system folder):
//     node scripts\reset-owner-password.js owner@example.com
//   Server (Docker):
//     docker compose exec app node scripts/reset-owner-password.js owner@example.com
// Add --disable-mfa only if the authenticator phone AND the recovery codes are lost.
// Then sign in with the printed password and change it under My security.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'));
const disableMfa = args.includes('--disable-mfa');
if (!email || args.filter((a) => !a.startsWith('--')).length !== 1 || args.some((a) => a.startsWith('--') && a !== '--disable-mfa')) {
  console.error('Usage: node scripts/reset-owner-password.js OWNER_EMAIL [--disable-mfa]');
  process.exit(1);
}

// Find the same data folder as the running system without creating anything.
function fromEnvFile(key) {
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { return ''; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.startsWith(`${key}=`)) continue;
    let val = line.slice(key.length + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else if (val.includes(' #')) val = val.slice(0, val.indexOf(' #')).trim();
    return val;
  }
  return '';
}
const setting = (key) => process.env[key] || fromEnvFile(key);
let dataDir = setting('DATA_DIR') || process.env.NS_DEFAULT_DATA_DIR || '';
// start-windows.bat keeps the data outside OneDrive; follow the same rule.
if (!dataDir && process.platform === 'win32' && /onedrive/i.test(ROOT) && process.env.LOCALAPPDATA) dataDir = path.join(process.env.LOCALAPPDATA, 'NirmaanSena', 'data');
dataDir = path.resolve(ROOT, dataDir || './data');
const dbFile = path.join(dataDir, setting('DB_FILE') || 'nirmaan.db');
if (!fs.existsSync(dbFile)) {
  console.error(`No database found at ${dbFile}`);
  console.error('Set DATA_DIR to the "Data folder" shown when the system starts, then run this again.');
  process.exit(1);
}

const { openDb, closeDb, one, run, insert, tx } = await import('../server/db/index.js');
const { hashSecret, randomToken, nowIso } = await import('../server/lib/util.js');
openDb(dbFile);
const owner = one("SELECT id, name FROM users WHERE role='owner' AND lower(email)=lower(?)", email.trim());
if (!owner) {
  console.error('No owner account has that email. Use the email the owner signs in with.');
  closeDb();
  process.exit(1);
}
const temporary = randomToken(12);
tx(() => {
  run('UPDATE users SET password_hash=?, updated_at=? WHERE id=?', hashSecret(temporary), nowIso(), owner.id);
  run('DELETE FROM sessions WHERE user_id=?', owner.id);
  if (disableMfa) run('DELETE FROM account_security WHERE user_id=?', owner.id);
  insert('audit_log', { at: nowIso(), actor: 'cli', action: 'user.owner_password_reset_cli', entity_type: 'user', entity_id: owner.id, data: JSON.stringify({ mfa_disabled: disableMfa }) });
});
closeDb();
console.log(`Temporary password for ${owner.name}: ${temporary}`);
console.log('The owner was signed out everywhere. Sign in with this password, then change it under My security.');
if (disableMfa) console.log('Two-step verification is off. Set it up again under My security.');
