// Security checks against a running server on a FRESH data dir:
//   BASE=http://localhost:3150 ADMIN_PASSWORD=TestAdmin123 DATA_DIR=... node test/security_smoke.js
const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'admin';
const Database = require('better-sqlite3');
const path = require('path');
let pass = 0, failed = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { failed++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };
function client(extra = {}) {
  const jar = {};
  async function req(method, p, form, hdrs = {}) {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '), ...extra, ...hdrs };
    let body; if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(BASE + p, { method, headers, body, redirect: 'manual' });
    const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    raw.forEach(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); });
    return { status: r.status, text: await r.text(), loc: r.headers.get('location'), headers: r.headers, setCookie: raw };
  }
  const tok = h => (h.match(/name="_csrf" value="([a-f0-9]+)"/) || [])[1];
  return { get: p => req('GET', p), raw: req,
    async post(p, form, page = '/verify') { const g = await req('GET', page); return req('POST', p, { ...form, _csrf: tok(g.text) }); } };
}
const sid = (r) => (r.text.match(/\/portal\/pay\/(\d+)/) || [])[1];
(async () => {
  const db = new Database(path.join(process.env.DATA_DIR, 'lgou.db'), { readonly: true });
  console.log('Headers & transport');
  const home = await client().get('/');
  const h = home.headers;
  check('CSP present, no inline script allowed', /script-src 'self'/.test(h.get('content-security-policy') || '') && !/unsafe-inline/.test(h.get('content-security-policy') || ''));
  check('clickjacking blocked (frame-ancestors none)', /frame-ancestors 'none'/.test(h.get('content-security-policy') || ''));
  check('nosniff header', h.get('x-content-type-options') === 'nosniff');
  check('X-Powered-By hidden', !h.get('x-powered-by'));
  const r404 = await client().get('/definitely-not-here');
  check('errors do not leak stack traces', r404.status === 404 && !/at .*\.js:\d+/.test(r404.text));

  console.log('Login, cookies, injection');
  const anon = client();
  const lg = await anon.post('/login', { username: "admin' OR '1'='1", password: "x' OR '1'='1" }, '/login');
  check('SQL injection in login is rejected', lg.status === 401);
  const noCsrf = await client().raw('POST', '/login', { username: 'admin', password: ADMIN_PW });
  check('POST without CSRF token is blocked (403)', noCsrf.status === 403);
  const adm = client();
  const ok = await adm.post('/login', { username: 'admin', password: ADMIN_PW }, '/login');
  const ck = ok.setCookie.join(' ');
  check('admin can log in', ok.status === 302);
  check('session cookie is HttpOnly + SameSite', /HttpOnly/i.test(ck) && /SameSite=Lax/i.test(ck));
  check('passwords are bcrypt-hashed in DB', db.prepare("SELECT password_hash h FROM users WHERE username='admin'").get().h.startsWith('$2'));
  check('names/emails are encrypted at rest', /^v1:/.test(db.prepare("SELECT full_name_enc e FROM users WHERE username='admin'").get().e));

  console.log('Access control');
  const a1 = await client().get('/admin/'); check('admin pages locked to anonymous users', a1.status === 302 && /login/.test(a1.loc || ''), a1.status);
  const stu = client(), stu2 = client();
  const su = (u, e) => ({ full_name: 'Test ' + u, username: u, email: e, phone: '', county: 'Montserrado', password: 'Str0ngPass!word1', confirm: 'Str0ngPass!word1' });
  await stu.post('/signup', su('sec_a', 'a@example.com'), '/signup'); await stu.post('/login', { username: 'sec_a', password: 'Str0ngPass!word1' }, '/login');
  await stu2.post('/signup', su('sec_b', 'b@example.com'), '/signup'); await stu2.post('/login', { username: 'sec_b', password: 'Str0ngPass!word1' }, '/login');
  check('student cannot open admin dashboard', [302, 403, 404].includes((await stu.get('/admin/')).status));
  check('student cannot open admin payments', [302, 403, 404].includes((await stu.get('/admin/payments')).status));
  check('student cannot open teacher area', [302, 403, 404].includes((await stu.get('/teacher/')).status));
  check('student cannot POST admin actions', [302, 403, 404].includes((await stu.post('/admin/students/1/reset-password', {})).status));
  await adm.post('/admin/courses/1/lessons', { title: 'Lesson one', youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, '/admin/courses/1');
  const course = db.prepare("SELECT id, fee_cents FROM courses WHERE active=1 AND approval_status='approved' AND (SELECT COUNT(*) FROM lessons l WHERE l.course_id=courses.id)>0 ORDER BY id LIMIT 1").get();
  const en = await stu.post('/portal/enroll/' + course.id, {}, '/courses/' + course.id);
  const enr = db.prepare("SELECT e.id, e.fee_cents FROM enrollments e JOIN users u ON u.id=e.user_id WHERE u.username='sec_a'").get();
  check('enrolment price comes from the server, not the form', !!enr && enr.fee_cents === course.fee_cents);

  console.log('Other-people\'s data (IDOR)');
  const own = await stu.get('/portal/pay/' + enr.id); check('owner can open own payment page', own.status === 200);
  const other = await stu2.get('/portal/pay/' + enr.id); check("another student cannot open someone else's payment page", other.status !== 200, other.status);
  const learn = await stu2.get('/portal/learn/' + enr.id); check("another student cannot open someone else's lessons", learn.status !== 200, learn.status);
  const cert = await stu2.get('/portal/certificate/' + enr.id); check("another student cannot open someone else's certificate", cert.status !== 200, cert.status);

  console.log('Prices & payments');
  const over = await stu.post('/portal/pay/' + enr.id, { amount: String((course.fee_cents / 100) * 10), method: 'Cash', reference: 'x' }, '/portal/pay/' + enr.id);
  check('cannot pay more than the balance owed', db.prepare('SELECT COUNT(*) n FROM payments WHERE enrollment_id=?').get(enr.id).n === 0);
  const neg = await stu.post('/portal/pay/' + enr.id, { amount: '-5', method: 'Cash', reference: 'x' }, '/portal/pay/' + enr.id);
  check('negative amounts refused', db.prepare('SELECT COUNT(*) n FROM payments WHERE enrollment_id=?').get(enr.id).n === 0);
  const sneaky = await stu.post('/portal/enroll/' + course.id, { fee_cents: '1', fee: '0.01' }, '/courses/' + course.id);
  check('client-sent fee fields are ignored', db.prepare('SELECT fee_cents f FROM enrollments WHERE id=?').get(enr.id).f === course.fee_cents);
  const good = await stu.post('/portal/pay/' + enr.id, { amount: '1', method: 'Orange Money', reference: 'ref1' }, '/portal/pay/' + enr.id);
  const pay = db.prepare('SELECT id,status FROM payments WHERE enrollment_id=?').get(enr.id);
  check('a student payment starts as pending, never auto-confirmed', pay && pay.status === 'pending');

  console.log('XSS');
  const xss = '<script>alert(1)</script>';
  await stu.post('/signup', { ...su('xss_u', 'x@example.com'), full_name: xss }, '/signup');
  await adm.get('/admin/students');
  const list = await adm.get('/admin/students');
  check('script tags in names are escaped on admin pages', !list.text.includes(xss));

  console.log('Forced password change after office reset');
  const uid = db.prepare("SELECT id FROM users WHERE username='sec_b'").get().id;
  const rs = await adm.post('/admin/students/' + uid + '/reset-password', {}, '/admin/students/' + uid);
  const dbw = new Database(path.join(process.env.DATA_DIR, 'lgou.db'), { readonly: true });
  const temp = ((await adm.get('/admin/students/' + uid)).text.match(/Temporary password for sec_b: ([^\s<&]+)/) || [])[1];
  check('old session of the reset user is signed out', (await stu2.get('/portal/')).status === 302);
  check('temporary password shown to admin', !!temp);
  const s3 = client(); await s3.post('/login', { username: 'sec_b', password: temp }, '/login');
  const dash = await s3.get('/portal/');
  check('temp-password user is sent to change password first', dash.status === 302 && /\/account/.test(dash.loc || ''), dash.status + ' ' + dash.loc);
  const same = await s3.post('/account', { current: temp, password: temp, confirm: temp }, '/account');
  check('cannot "change" to the same password', same.status === 400);
  const chg = await s3.post('/account', { current: temp, password: 'BrandNew#Pass42x', confirm: 'BrandNew#Pass42x' }, '/account');
  check('password change succeeds', chg.status === 302);
  check('portal opens after changing', (await s3.get('/portal/')).status === 200);

  console.log('Rate limiting');
  const bf = client(); let blocked = 0;
  for (let i = 0; i < 30; i++) { const r = await bf.post('/login', { username: 'nobody' + i, password: 'wrong' }, '/login'); if (r.status === 429) blocked++; }
  check('login is rate limited after repeated attempts', blocked > 0, 'blocked=' + blocked);

  console.log('\n' + pass + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
