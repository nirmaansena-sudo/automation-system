// Usage: node scripts/backup.js validate ARCHIVE [--key-file FILE]
//        node scripts/backup.js restore ARCHIVE NEW_DIRECTORY [--key-file FILE]
// Passwords belong in BACKUP_PASSWORD, never command-line arguments.
const args = process.argv.slice(2); const command = args.shift(); const file = args.shift();
const destination = command === 'restore' ? args.shift() : null;
const keyAt = args.indexOf('--key-file'); const options = keyAt >= 0 ? { keyFile: args[keyAt + 1] } : {};
if (!['validate', 'restore'].includes(command) || !file || (command === 'restore' && !destination)) {
  console.error('Usage: node scripts/backup.js validate ARCHIVE [--key-file FILE]\n       node scripts/backup.js restore ARCHIVE NEW_DIRECTORY [--key-file FILE]'); process.exit(1);
}
try {
  const { validateBackup, restoreBackup } = await import('../server/lib/backups.js');
  const result = command === 'restore' ? restoreBackup(file, destination, options) : validateBackup(file, options);
  console.log(JSON.stringify(result, null, 2));
  if (command === 'restore') console.log('Validated restore created. Review configuration/runtime.json and configuration/.env, stop the old server, and point DATA_DIR to this directory before restarting. Keep the original backup key separately. No live data was overwritten.');
} catch (e) { console.error(e.message); process.exitCode = 1; }
