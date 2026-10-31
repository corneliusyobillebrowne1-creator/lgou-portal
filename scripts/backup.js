// Run manually:  npm run backup      (or schedule with cron)
const { runBackup } = require('../lib/backup');
runBackup().then(f => { console.log('Backup written:', f); process.exit(0); })
  .catch(e => { console.error('Backup failed:', e); process.exit(1); });
