// n8n connection. The site sends SIGNED events to your n8n webhook (so n8n can text students on WhatsApp/SMS),
// and n8n can call the site back (token-protected) to get AI answers. Secrets are stored encrypted / hashed.
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { money } = require('./util');

db.exec(`CREATE TABLE IF NOT EXISTS n8n_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), event TEXT NOT NULL, status TEXT NOT NULL, detail TEXT)`);

const DEFAULT_FROM = '0880035290';
function secret() { try { const e = getSetting('n8n_secret_enc'); return e ? decrypt(e) : ''; } catch { return ''; } }
function config() {
  return { url: getSetting('n8n_webhook_url') || '', enabled: getSetting('n8n_enabled') === 'yes', secret: secret(),
    includePhone: getSetting('n8n_include_phone') === 'yes', from: getSetting('school_msg_number') || DEFAULT_FROM, hasToken: !!getSetting('n8n_token_hash') };
}
function validUrl(u) {
  let x; try { x = new URL(String(u)); } catch { return null; }
  const local = process.env.N8N_ALLOW_LOCAL === '1';
  if (x.protocol !== 'https:' && !(local && x.protocol === 'http:')) return null;
  const h = x.hostname.toLowerCase();
  if (!local && (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1)/.test(h))) return null;
  return x.toString();
}
const newSecret = () => crypto.randomBytes(32).toString('hex');
function saveSecret(s) { setSetting('n8n_secret_enc', encrypt(s)); }
function saveToken(t) { setSetting('n8n_token_hash', crypto.createHash('sha256').update(t).digest('hex')); }
function tokenOk(t) {
  const h = getSetting('n8n_token_hash'); if (!h || !t) return false;
  const a = Buffer.from(crypto.createHash('sha256').update(String(t)).digest('hex')), b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const log = (event, status, detail) => { try { db.prepare('INSERT INTO n8n_log (event,status,detail) VALUES (?,?,?)').run(event, status, String(detail || '').slice(0, 200)); db.prepare('DELETE FROM n8n_log WHERE id < (SELECT MAX(id)-200 FROM n8n_log)').run(); } catch {} };

// Sends one signed event. Never throws; callers do not wait for it.
async function emit(event, data, { force = false } = {}) {
  const c = config();
  if (!force && (!c.enabled || !c.url || !c.secret)) return { ok: false, skipped: true };
  const url = validUrl(c.url); if (!url || !c.secret) { log(event, 'failed', 'Webhook address or secret is not valid'); return { ok: false, error: 'Webhook address or secret is not valid.' }; }
  const body = JSON.stringify({ event, id: crypto.randomUUID(), time: new Date().toISOString(), school: 'Liberia Gateway Online College', send_from: c.from, data });
  const sig = 'sha256=' + crypto.createHmac('sha256', c.secret).update(body).digest('hex');
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lgoc-event': event, 'x-lgoc-signature': sig }, body, signal: AbortSignal.timeout(6000), redirect: 'error' });
    log(event, r.ok ? 'sent' : 'failed', r.ok ? '' : 'n8n answered ' + r.status);
    return { ok: r.ok, status: r.status };
  } catch (e) { log(event, 'failed', 'Could not reach n8n'); return { ok: false, error: 'Could not reach n8n.' }; }
}

// ---- event helpers (minimal data: no passwords, no payment references, no complaint text) ----
function person(userId) {
  const u = db.prepare('SELECT full_name_enc, phone_enc, student_no, role FROM users WHERE id=?').get(userId); if (!u) return {};
  const p = { name: decrypt(u.full_name_enc), student_no: u.student_no || null };
  if (config().includePhone) { try { p.phone = u.phone_enc ? decrypt(u.phone_enc) : ''; } catch { p.phone = ''; } }
  return p;
}
const fire = (event, data) => { emit(event, data).catch(() => {}); };
const events = {
  studentSignedUp: (userId) => fire('student_signed_up', person(userId)),
  teacherApplied: (userId) => fire('teacher_applied', { name: person(userId).name }),
  paymentSubmitted: (enrollmentId, amountCents, method) => {
    const e = db.prepare('SELECT e.user_id, c.title FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.id=?').get(enrollmentId); if (!e) return;
    fire('payment_submitted', { ...person(e.user_id), course: e.title, amount: money(amountCents), method });
  },
  paymentConfirmed: (paymentId) => {
    const p = db.prepare("SELECT p.amount_cents, p.method, e.user_id, e.fee_cents, e.id AS eid, c.title FROM payments p JOIN enrollments e ON e.id=p.enrollment_id JOIN courses c ON c.id=e.course_id WHERE p.id=?").get(paymentId); if (!p) return;
    const paid = db.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM payments WHERE enrollment_id=? AND status='confirmed'").get(p.eid).n;
    fire('payment_confirmed', { ...person(p.user_id), course: p.title, amount: money(p.amount_cents), balance: money(Math.max(0, p.fee_cents - paid)), fully_paid: paid >= p.fee_cents });
  },
  certificateIssued: (certId) => {
    const c = db.prepare('SELECT c.cert_no, c.course_title, c.course_type, e.user_id FROM certificates c JOIN enrollments e ON e.id=c.enrollment_id WHERE c.id=?').get(certId); if (!c) return;
    fire('certificate_issued', { ...person(c.user_id), course: c.course_title, level: c.course_type, certificate_no: c.cert_no });
  },
  complaintReceived: (id) => fire('complaint_received', { complaint_id: id }),
  questionAsked: (courseId, questionId) => { const c = db.prepare('SELECT title FROM courses WHERE id=?').get(courseId); fire('question_asked', { course: c ? c.title : '', question_id: questionId }); }
};

module.exports = { config, emit, events, validUrl, newSecret, saveSecret, saveToken, tokenOk, DEFAULT_FROM };
