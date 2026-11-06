// Tests receipts + certificate emails against a FAKE Brevo API (no real emails are sent).
const http = require('http'), { spawn } = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const APP = 4520, FAKE = 4521, BASE = 'http://localhost:' + APP;
let pass = 0, failed = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { failed++; console.log('  FAIL ' + n + (x ? ' -> ' + x : '')); } };
const sent = []; let failNext = false;
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    if (failNext) { res.statusCode = 401; return res.end('{}'); }
    sent.push({ key: req.headers['api-key'], url: req.url, body: JSON.parse(b) });
    res.setHeader('content-type', 'application/json'); res.end('{"messageId":"x"}');
  });
});
function client() {
  const jar = {};
  const req = async (m, p, form) => {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') };
    let body; if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(BASE + p, { method: m, headers, body, redirect: 'manual' });
    (r.headers.getSetCookie() || []).forEach(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); });
    return { status: r.status, text: await r.text(), loc: r.headers.get('location') };
  };
  const csrf = (h) => (h.match(/name="_csrf" value="([a-f0-9]+)"/) || [])[1];
  return { get: (p) => req('GET', p), post: async (p, f, tp) => req('POST', p, { ...f, _csrf: csrf((await req('GET', tp || '/login')).text) }) };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgou-mail-'));
  await new Promise(r => fake.listen(FAKE, r));
  const app = spawn('node', ['server.js'], { env: { ...process.env, PORT: APP, DATA_DIR: dir + '/data', BACKUP_DIR: dir + '/b', ADMIN_PASSWORD: 'TestAdmin123', BREVO_API_BASE: 'http://localhost:' + FAKE }, stdio: 'ignore' });
  await sleep(3000);
  const Database = require('better-sqlite3');
  const q = (sql, ...a) => { const d = new Database(dir + '/data/lgou.db', { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
  try {
    const adm = client(), stu = client(), anon = client();
    await adm.post('/login', { username: 'admin', password: 'TestAdmin123' });
    let r = await anon.get('/admin/emails'); check('email log is closed to visitors', r.status === 302);
    await adm.post('/admin/courses/1/lessons', { title: 'L1', youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, '/admin/courses/1');
    await stu.post('/signup', { full_name: 'Mary Kollie', username: 'mary_k', email: 'mary@example.com', password: 'Learn2026ok', confirm: 'Learn2026ok' }, '/signup');
    await stu.post('/login', { username: 'mary_k', password: 'Learn2026ok' });
    await stu.post('/portal/enroll/1', {}, '/portal');
    const fee = q('SELECT fee_cents f FROM enrollments WHERE id=1').f;
    const part = Math.max(100, Math.floor(fee / 2 / 100) * 100);
    await stu.post('/portal/pay/1', { amount: (part / 100).toFixed(2), method: 'Orange Money', reference: 'OM-5555' }, '/portal/pay/1');

    // email not set up yet -> confirm still works, failure is logged
    await adm.post('/admin/payments/1/confirmed', {}, '/admin/payments');
    check('payment confirmed even when email is not set up', q("SELECT status s FROM payments WHERE id=1").s === 'confirmed');
    check('failed email is logged, nothing sent', sent.length === 0 && q("SELECT status s FROM email_log ORDER BY id DESC").s === 'failed');

    // set up Brevo
    await adm.post('/admin/settings', { email_provider: 'brevo', email_from_name: 'LGOC Test', email_from_address: 'school@example.com', email_brevo_key: 'xkeysib-secret-123456', smtp_host: '', smtp_port: '587', smtp_user: '' }, '/admin/settings');
    r = await adm.get('/admin/settings');
    check('email shows ready; API key never shown back', r.text.includes('Ready.') && !r.text.includes('xkeysib-secret-123456'));
    check('API key stored encrypted', !q("SELECT value v FROM settings WHERE key='email_brevo_key_enc'").v.includes('xkeysib'));
    await adm.post('/admin/email/test', { to: 'owner@example.com' }, '/admin/settings');
    check('test email goes out with the saved key', sent.length === 1 && sent[0].key === 'xkeysib-secret-123456' && sent[0].body.to[0].email === 'owner@example.com');

    // resend partial receipt from log
    const logId = q("SELECT id FROM email_log WHERE kind='receipt' ORDER BY id DESC").id;
    await adm.post('/admin/emails/' + logId + '/resend', {}, '/admin/emails');
    let m = sent[sent.length - 1];
    check('partial receipt: sent to the student, shows balance, NOT yet "approved"', m.body.to[0].email === 'mary@example.com' && /Payment receipt RCT-/.test(m.body.subject) && /Balance remaining/.test(m.body.htmlContent) && !/selected and approved/.test(m.body.htmlContent));
    check('receipt does not contain the payment reference', !JSON.stringify(m.body).includes('OM-5555'));

    // pay the rest (admin records) -> approved email
    const owed = fee - part;
    await adm.post('/admin/enrollments/1/payment', { amount: (owed / 100).toFixed(2), method: 'Orange Money', reference: 'cash' }, '/admin/students/2');
    m = sent[sent.length - 1];
    check('full payment: "selected and approved" email sent', /selected and approved/.test(m.body.htmlContent) && /^Approved:/.test(m.body.subject), m.body.subject);

    // completion -> certificate by email with PDF
    await stu.post('/portal/learn/1/complete/1', {}, '/portal/learn/1');
    await stu.post('/portal/request-certificate/1', {}, '/portal');
    const before = sent.length;
    await adm.post('/admin/approvals/1/approve', { score: '85' }, '/admin/approvals');
    m = sent[sent.length - 1];
    const att = m.body.attachment && m.body.attachment[0];
    check('certificate email sent on approval', sent.length === before + 1 && m.body.to[0].email === 'mary@example.com' && /Certificate/.test(m.body.subject));
    check('certificate attached as a real PDF', att && /\.pdf$/.test(att.name) && Buffer.from(att.content, 'base64').slice(0, 5).toString() === '%PDF-');
    check('email contains the verification code', /Verification code/.test(m.body.htmlContent));

    // student asks for another copy; rate limited
    const n1 = sent.length;
    await stu.post('/portal/email-certificate/1', {}, '/portal');
    check('student can email themselves a copy only after 5 minutes', sent.length === n1);   // just sent on approval, so blocked
    // failure handling
    failNext = true;
    await adm.post('/admin/certificates/1/email', {}, '/admin/certificates');
    failNext = false;
    r = await adm.get('/admin/emails');
    check('rejected key is reported in the email log', r.text.includes('rejected the API key'));
    await adm.post('/admin/certificates/1/email', {}, '/admin/certificates');
    check('admin can email the certificate again', sent.length === n1 + 1);

    // access control
    r = await stu.get('/admin/emails'); check('students cannot open the email log', r.status !== 200);
    r = await stu.post('/admin/emails/' + logId + '/resend', {}, '/portal'); check('students cannot resend emails', sent.length === n1 + 1);
    // SMTP path (fake local SMTP server)
    const { SMTPServer } = require('smtp-server'); let got = '';
    const smtp = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, sess, cb) { stream.on('data', d => got += d); stream.on('end', cb); } });
    await new Promise(r => smtp.listen(4522, '127.0.0.1', r));
    await adm.post('/admin/settings', { email_provider: 'smtp', email_from_name: 'LGOC', email_from_address: 'school@example.com', smtp_host: '127.0.0.1', smtp_port: '4522', smtp_user: '' }, '/admin/settings');
    await adm.post('/admin/email/test', { to: 'owner@example.com' }, '/admin/settings');
    await sleep(500);
    check('SMTP provider delivers the message', got.includes('Subject: Test email from Liberia Gateway Online College') && got.includes('owner@example.com'));
    smtp.close();
  } finally {
    app.kill(); fake.close();
    console.log(`\n${pass} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
  }
})();
