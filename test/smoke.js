// End-to-end smoke test. Run the server first, then:  BASE=http://localhost:3111 ADMIN_PASSWORD=... DATA_DIR=... BACKUP_DIR=... node test/smoke.js
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'admin';

let pass = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

function client() {
  const jar = {};
  async function req(method, p, form) {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') };
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(BASE + p, { method, headers, body, redirect: 'manual' });
    (r.headers.getSetCookie ? r.headers.getSetCookie() : []).forEach(c => {
      const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1);
    });
    const text = await r.text();
    return { status: r.status, text, loc: r.headers.get('location'), headers: r.headers };
  }
  const csrfOf = (html) => (html.match(/name="_csrf" value="([a-f0-9]+)"/) || [])[1];
  return {
    get: (p) => req('GET', p),
    // fetches a page to get a CSRF token, then posts the form
    async post(p, form, tokenPage) {
      const page = await req('GET', tokenPage || '/login');
      return req('POST', p, { ...form, _csrf: csrfOf(page.text) });
    },
    raw: req
  };
}

(async () => {
  console.log('Public pages');
  const anon = client();
  let r = await anon.get('/');
  check('homepage loads with courses and fees', r.status === 200 && r.text.includes('Computer Basics') && r.text.includes('$10.00'));
  check('homepage shows the disclaimer', r.text.includes('awarded by Liberia Gateway Online University only'));
  check('CSP header present', (r.headers.get('content-security-policy') || '').includes("frame-src https://www.youtube-nocookie.com"));
  r = await anon.get('/admin');
  check('anonymous cannot open /admin (redirected to login)', r.status === 302 && r.loc === '/login');
  r = await anon.get('/portal');
  check('anonymous cannot open /portal', r.status === 302 && r.loc === '/login');
  r = await anon.raw('POST', '/login', { username: 'x', password: 'y' });
  check('POST without CSRF token is blocked', r.status === 403);

  console.log('Student sign-up & login');
  const stu = client();
  r = await stu.post('/signup', { full_name: 'Mary Kollie', username: 'mary_k', email: 'mary.kollie@example.com', phone: '+231 77 000 1111', password: 'weak', confirm: 'weak' }, '/signup');
  check('weak password rejected', r.status === 400);
  r = await stu.post('/signup', { full_name: 'Mary Kollie', username: 'mary_k', email: 'mary.kollie@example.com', phone: '+231 77 000 1111', password: 'Learn2026ok', confirm: 'Learn2026ok' }, '/signup');
  check('sign-up succeeds and redirects to portal', r.status === 302 && r.loc === '/portal', r.status + ' ' + r.loc);
  r = await stu.get('/portal');
  check('student portal loads', r.status === 200 && r.text.includes('Mary Kollie'));
  r = await stu.get('/admin');
  check('student blocked from admin dashboard (403)', r.status === 403);
  r = await stu.get('/admin/students');
  check('student blocked from student records (403)', r.status === 403);
  const dup = client();
  r = await dup.post('/signup', { full_name: 'Someone Else', username: 'other', email: 'MARY.KOLLIE@example.com', password: 'Learn2026ok', confirm: 'Learn2026ok' }, '/signup');
  check('duplicate email rejected (case-insensitive)', r.status === 400);

  console.log('Admin sets up course lessons');
  const adm = client();
  r = await adm.post('/login', { username: 'admin', password: ADMIN_PW });
  check('admin login works', r.status === 302 && r.loc === '/admin', r.status + ' ' + r.loc);
  r = await adm.get('/admin');
  check('admin dashboard loads', r.status === 200 && r.text.includes('Admin dashboard'));
  r = await adm.post('/admin/courses/1/lessons', { title: 'Bad link', youtube: 'https://evil.example.com/watch?v=dQw4w9WgXcQ' }, '/admin/courses/1');
  r = await adm.get('/admin/courses/1');
  check('non-YouTube link is rejected', !r.text.includes('Bad link'));
  await adm.post('/admin/courses/1/lessons', { title: 'Lesson one', youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, '/admin/courses/1');
  await adm.post('/admin/courses/1/lessons', { title: 'Lesson two', youtube: 'https://youtu.be/9bZkp7q19f0' }, '/admin/courses/1');
  r = await adm.get('/admin/courses/1');
  check('two YouTube lessons stored (ids extracted)', r.text.includes('dQw4w9WgXcQ') && r.text.includes('9bZkp7q19f0'));

  console.log('Enrol, pay, confirm');
  r = await stu.post('/portal/enroll/1', {}, '/portal');
  check('enrol redirects to payment page', r.status === 302 && r.loc === '/portal/pay/1', r.loc);
  r = await anon.get('/');
  check('homepage lists the added courses with Coming soon + search box', r.text.includes('Microsoft Office Essentials') && r.text.includes('Coming soon') && r.text.includes('id="coursesearch"'));
  r = await anon.get('/filter.js');
  check('search script is served as an external file (CSP-safe)', r.status === 200 && r.text.includes('coursesearch'));
  r = await stu.post('/portal/enroll/5', {}, '/portal');
  check('course without lessons cannot be enrolled', r.status === 302 && r.loc === '/courses/5', r.loc);
  r = await stu.get('/portal');
  check('student dashboard shows Coming soon and no Enroll for it', r.text.includes('Coming soon') && !r.text.includes('/portal/enroll/5'));
  r = await stu.get('/portal/learn/1');
  check('lessons locked until fee is confirmed', r.status === 302 && r.loc === '/portal/pay/1');
  r = await stu.post('/portal/pay/1', { amount: '10.00', method: 'Orange Money', reference: 'OM-77889900' }, '/portal/pay/1');
  check('payment submitted', r.status === 302);
  r = await stu.get('/portal/learn/1');
  check('still locked while payment is only pending', r.status === 302);
  r = await adm.get('/admin/payments');
  check('admin sees pending payment with reference', r.text.includes('OM-77889900') && r.text.includes('Mary Kollie'));
  r = await adm.post('/admin/payments/1/confirmed', {}, '/admin/payments');
  check('admin confirms payment', r.status === 302);

  console.log('Learning & certificate');
  r = await stu.get('/portal/learn/1');
  check('student sees embedded YouTube lesson', r.status === 200 && r.text.includes('youtube-nocookie.com/embed/dQw4w9WgXcQ'));
  r = await stu.post('/portal/request-certificate/1', {}, '/portal');
  r = await stu.get('/portal');
  check('cannot request certificate before finishing lessons', !r.text.includes('under review'));
  await stu.post('/portal/learn/1/complete/1', {}, '/portal/learn/1');
  await stu.post('/portal/learn/1/complete/2', {}, '/portal/learn/1');
  r = await stu.get('/portal');
  check('progress shows 100% and request button appears', r.text.includes('100%') && r.text.includes('Request certificate'));
  await stu.post('/portal/request-certificate/1', {}, '/portal');
  r = await adm.get('/admin/approvals');
  check('admin sees certificate request', r.text.includes('Mary Kollie') && r.text.includes('Approve'));
  r = await adm.post('/admin/approvals/1/approve', { score: '30' }, '/admin/approvals');
  r = await adm.get('/admin/approvals');
  check('failing score does not issue a certificate', r.text.includes('Mary Kollie'));
  r = await adm.post('/admin/approvals/1/approve', { score: '85' }, '/admin/approvals');
  check('passing score approves', r.status === 302 && r.loc === '/admin/certificates', r.loc);
  r = await stu.get('/portal/certificate/1');
  check('student can open certificate with disclaimer', r.status === 200 && r.text.includes('Mary Kollie') && r.text.includes('awarded by Liberia Gateway Online University only'));
  r = await adm.get('/admin/certificates');
  const code = (r.text.match(/code ([a-f0-9]{16})/) || [])[1];
  check('verification code issued', !!code);
  r = await anon.get('/verify?code=' + code);
  check('public verification says valid', r.text.includes('Valid certificate') && r.text.includes('Mary Kollie'));
  r = await anon.get('/verify?code=0000000000000000');
  check('unknown code is not found', r.text.includes('No certificate was found'));
  await adm.post('/admin/certificates/1/toggle', {}, '/admin/certificates');
  r = await anon.get('/verify?code=' + code);
  check('revoked certificate shows as revoked', r.text.includes('revoked'));

  console.log('Isolation between students');
  const stu2 = client();
  await stu2.post('/signup', { full_name: 'John Doe', username: 'john_d', email: 'john@example.com', password: 'Learn2026ok', confirm: 'Learn2026ok' }, '/signup');
  r = await stu2.get('/portal/learn/1');
  check("student 2 cannot open student 1's enrollment", r.status === 404);
  r = await stu2.get('/portal/certificate/1');
  check("student 2 cannot open student 1's certificate", r.status === 404);

  console.log('Admin student records');
  r = await adm.get('/admin/students?q=kollie');
  check('admin can search and decrypt student records', r.text.includes('mary.kollie@example.com'));

  console.log('Brute-force protection');
  const bf = client();
  for (let i = 0; i < 5; i++) await bf.post('/login', { username: 'john_d', password: 'wrong' + i });
  r = await bf.post('/login', { username: 'john_d', password: 'Learn2026ok' });
  check('account locks after repeated failures (even with right password)', r.status === 429, String(r.status));

  console.log('Data protection');
  const dataDir = process.env.DATA_DIR;
  if (dataDir) {
    const blob = fs.readdirSync(dataDir).filter(f => f.startsWith('lgou.db')).map(f => fs.readFileSync(path.join(dataDir, f)).toString('latin1')).join('');
    check('email not stored in plaintext in database', !blob.includes('mary.kollie@example.com'));
    check('full name not stored in plaintext in database', !blob.includes('Mary Kollie'));
    check('payment reference not stored in plaintext', !blob.includes('OM-77889900'));
    check('password not stored in plaintext', !blob.includes('Learn2026ok'));
    check('passwords are bcrypt hashes', blob.includes('$2a$12$') || blob.includes('$2b$12$'));
  }

  console.log('Backups');
  r = await adm.post('/admin/backup', {}, '/admin/settings');
  const bdir = process.env.BACKUP_DIR;
  if (bdir) check('backup file created', fs.readdirSync(bdir).some(f => /^lgou-.*\.db$/.test(f)));

  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
