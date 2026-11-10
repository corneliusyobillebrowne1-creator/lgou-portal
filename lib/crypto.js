// Field-level encryption (AES-256-GCM) for personal & payment data.
// Keys come from env vars, or are generated once into data/ (file mode 0600).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Where the database lives. If the host gives us no writable disk (e.g. Render free plan, Vercel), fall back to a
// TEMPORARY folder so the site still starts instead of crashing. Data there is lost on restart; the admin sees a warning.
let DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
let TEMP_STORAGE = false;
try { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); fs.accessSync(DATA_DIR, fs.constants.W_OK); }
catch (e) {
  const tmp = path.join(require('os').tmpdir(), 'lgoc-data');
  console.warn('WARNING: cannot write to ' + DATA_DIR + ' (' + e.code + '). Using TEMPORARY storage ' + tmp + ' - data will be LOST on restart. Use a host with a persistent disk for real students.');
  DATA_DIR = tmp; TEMP_STORAGE = true; process.env.DATA_DIR = tmp; process.env.BACKUP_DIR = path.join(require('os').tmpdir(), 'lgoc-backups');
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}
if (process.env.VERCEL) TEMP_STORAGE = true;

function secret(file, envName) {
  if (process.env[envName]) {
    return crypto.createHash('sha256').update(process.env[envName]).digest();
  }
  const f = path.join(DATA_DIR, file);
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
}

const ENC_KEY = secret('.enc.key', 'ENCRYPTION_KEY');
const IDX_KEY = crypto.createHmac('sha256', ENC_KEY).update('blind-index').digest();
const SESSION_SECRET = secret('.session.key', 'SESSION_SECRET').toString('hex');

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return '';
  try {
    const raw = Buffer.from(String(blob).slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch (e) {
    return '[unreadable]';
  }
}

// Deterministic keyed hash so we can enforce unique emails without storing them in plaintext.
function blindIndex(v) {
  return crypto.createHmac('sha256', IDX_KEY).update(String(v).trim().toLowerCase()).digest('hex');
}

module.exports = { DATA_DIR, TEMP_STORAGE, encrypt, decrypt, blindIndex, SESSION_SECRET };
