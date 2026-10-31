// Database backups: consistent online snapshot using SQLite's backup API, keeps the newest 14.
// NOTE: backups contain *encrypted* personal fields. Keep the encryption key (data/.enc.key or
// the ENCRYPTION_KEY env var) stored SEPARATELY - without it, backups cannot be read.
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { DATA_DIR } = require('./crypto');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, '..', 'backups');
const KEEP = 14;

async function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `lgou-${stamp}.db`);
  await db.backup(file);
  fs.chmodSync(file, 0o600);
  const all = listBackups();
  all.slice(KEEP).forEach(b => fs.unlinkSync(path.join(BACKUP_DIR, b.name)));
  return file;
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(n => /^lgou-.*\.db$/.test(n))
    .map(n => { const s = fs.statSync(path.join(BACKUP_DIR, n)); return { name: n, size: s.size, mtime: s.mtime }; })
    .sort((a, b) => b.mtime - a.mtime);
}

module.exports = { runBackup, listBackups, BACKUP_DIR };
