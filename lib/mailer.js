// Sends email through either Brevo's HTTPS API (works on free hosting where SMTP ports are blocked) or any SMTP server.
// Settings are edited by the admin (Admin > Settings > Email); secrets are stored encrypted and never shown again.
const nodemailer = require('nodemailer');
const { db, getSetting, setSetting } = require('./db');
const { encrypt, decrypt } = require('./crypto');

const BREVO = () => (process.env.BREVO_API_BASE || 'https://api.brevo.com').replace(/\/+$/, '');
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const validEmail = (e) => typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e);
const oneLine = (v, n = 150) => String(v || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
const mask = (e) => String(e || '').replace(/^(.).*(@.*)$/, '$1***$2');

function sec(key) { try { const v = getSetting(key); return v ? decrypt(v) : ''; } catch { return ''; } }

function config() {
  const provider = getSetting('email_provider') || (process.env.BREVO_API_KEY ? 'brevo' : process.env.SMTP_HOST ? 'smtp' : 'off');
  return {
    provider,
    fromName: oneLine(getSetting('email_from_name') || process.env.MAIL_FROM_NAME || 'Liberia Gateway Online College', 80),
    fromEmail: oneLine(getSetting('email_from_address') || process.env.MAIL_FROM_EMAIL || '', 254),
    brevoKey: sec('email_brevo_key_enc') || process.env.BREVO_API_KEY || '',
    smtp: {
      host: oneLine(getSetting('smtp_host') || process.env.SMTP_HOST || '', 200),
      port: Number(getSetting('smtp_port') || process.env.SMTP_PORT || 587),
      secure: (getSetting('smtp_secure') || process.env.SMTP_SECURE || '') === '1' || (getSetting('smtp_secure') || process.env.SMTP_SECURE) === 'true',
      user: oneLine(getSetting('smtp_user') || process.env.SMTP_USER || '', 200),
      pass: sec('smtp_pass_enc') || process.env.SMTP_PASS || ''
    }
  };
}
function status() {
  const c = config();
  const ready = c.provider === 'brevo' ? !!(c.brevoKey && validEmail(c.fromEmail))
    : c.provider === 'smtp' ? !!(c.smtp.host && validEmail(c.fromEmail)) : false;
  return { provider: c.provider, ready, fromName: c.fromName, fromEmail: c.fromEmail, hasBrevoKey: !!c.brevoKey, hasSmtpPass: !!c.smtp.pass,
    smtp: { host: c.smtp.host, port: c.smtp.port, secure: c.smtp.secure, user: c.smtp.user } };
}

function save(b) {
  const prov = ['off', 'brevo', 'smtp'].includes(b.email_provider) ? b.email_provider : 'off';
  setSetting('email_provider', prov);
  setSetting('email_from_name', oneLine(b.email_from_name, 80));
  setSetting('email_from_address', oneLine(b.email_from_address, 254));
  if (String(b.email_brevo_key || '').trim()) setSetting('email_brevo_key_enc', encrypt(String(b.email_brevo_key).trim().slice(0, 300)));
  setSetting('smtp_host', oneLine(b.smtp_host, 200));
  setSetting('smtp_port', String(parseInt(b.smtp_port, 10) || 587));
  setSetting('smtp_secure', b.smtp_secure ? '1' : '0');
  setSetting('smtp_user', oneLine(b.smtp_user, 200));
  if (String(b.smtp_pass || '').trim()) setSetting('smtp_pass_enc', encrypt(String(b.smtp_pass).trim().slice(0, 300)));
}

// message: { to, toName, subject, html, text, attachments:[{filename, content:Buffer}] }  ->  { ok, error }
async function send(message) {
  const c = config(), st = status();
  if (!st.ready) return { ok: false, error: 'Email is not set up yet (Admin > Settings > Email).' };
  if (!validEmail(message.to)) return { ok: false, error: 'The student has no valid email address.' };
  const subject = oneLine(message.subject, 200), toName = oneLine(message.toName, 100);
  try {
    if (c.provider === 'brevo') {
      const body = { sender: { name: c.fromName, email: c.fromEmail }, to: [{ email: message.to, name: toName || undefined }], subject, htmlContent: message.html, textContent: message.text };
      if (message.attachments && message.attachments.length) body.attachment = message.attachments.map(a => ({ name: a.filename, content: a.content.toString('base64') }));
      const r = await fetch(BREVO() + '/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': c.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000)
      });
      if (!r.ok) return { ok: false, error: r.status === 401 ? 'The email service rejected the API key.' : 'The email service returned an error (' + r.status + ').' };
      return { ok: true };
    }
    const t = nodemailer.createTransport({
      host: c.smtp.host, port: c.smtp.port, secure: c.smtp.secure, auth: c.smtp.user ? { user: c.smtp.user, pass: c.smtp.pass } : undefined,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 25000
    });
    await t.sendMail({ from: { name: c.fromName, address: c.fromEmail }, to: { name: toName, address: message.to }, subject, html: message.html, text: message.text, attachments: message.attachments });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Could not send: ' + oneLine(e.code || e.message, 120) };
  }
}

// Looks up the student's address, builds the message, sends and records the result. Never throws.
async function sendToUser(userId, kind, refId, build) {
  let res, subject = '', to = '';
  try {
    const u = db.prepare('SELECT full_name_enc, email_enc FROM users WHERE id=?').get(userId);
    to = u && u.email_enc ? decrypt(u.email_enc) : '';
    const name = u ? decrypt(u.full_name_enc) : '';
    const m = await build({ name, email: to });
    subject = m.subject;
    res = await send({ ...m, to, toName: name });
  } catch (e) { res = { ok: false, error: 'Could not prepare the email.' }; }
  db.prepare('INSERT INTO email_log (user_id,kind,ref_id,to_masked,subject,status,error) VALUES (?,?,?,?,?,?,?)')
    .run(userId, kind, refId, mask(to), subject, res.ok ? 'sent' : 'failed', res.ok ? null : res.error);
  return res;
}

module.exports = { config, status, save, send, sendToUser, validEmail, mask };
