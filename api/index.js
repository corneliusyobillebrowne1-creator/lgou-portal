// Vercel entry point. Vercel's disk is read-only except /tmp, and /tmp is wiped often, so this is a DEMO setup only.
process.env.VERCEL = process.env.VERCEL || '1';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/lgoc/data';
process.env.BACKUP_DIR = process.env.BACKUP_DIR || '/tmp/lgoc/backups';
module.exports = require('../server.js');
