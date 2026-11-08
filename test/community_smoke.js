// Trust page, complaints, course Q&A, ratings, success stories, referrals, reminders.
// Start on a FRESH data dir:  BASE=http://localhost:3170 ADMIN_PASSWORD=TestAdmin123 DATA_DIR=... node test/community_smoke.js
const path = require('path'), Database = require('better-sqlite3');
const BASE = process.env.BASE || 'http://localhost:3000', ADMIN_PW = process.env.ADMIN_PASSWORD || 'admin';
let pass = 0, failed = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { failed++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };
function client() {
  const jar = {};
  async function req(method, p, form) {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') };
    let body; if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(BASE + p, { method, headers, body, redirect: 'manual' });
    (r.headers.getSetCookie ? r.headers.getSetCookie() : []).forEach(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); });
    return { status: r.status, text: await r.text(), loc: r.headers.get('location') };
  }
  const tok = h => (h.match(/name="_csrf" value="([a-f0-9]+)"/) || [])[1];
  return { get: p => req('GET', p), raw: req, async post(p, form, page = '/verify') { const g = await req('GET', page); return req('POST', p, { ...form, _csrf: tok(g.text) }); } };
}
const PW = 'Str0ngPass!word1';
const reg = async (c, u, ref) => { await c.get('/signup' + (ref ? '?ref=' + ref : '')); const r = await c.post('/signup', { full_name: 'Test ' + u, username: u, email: u + '@example.com', phone: '', password: PW, confirm: PW }, '/signup' + (ref ? '?ref=' + ref : '')); return r; };
(async () => {
  const db = new Database(path.join(process.env.DATA_DIR, 'lgou.db'), { readonly: true });
  const anon = client(), adm = client(), s1 = client(), s2 = client(), t1 = client();
  await adm.post('/login', { username: 'admin', password: ADMIN_PW }, '/login');

  console.log('Trust page');
  let r = await anon.get('/trust');
  check('trust page is public', r.status === 200 && r.text.includes('Trust &amp; quality'));
  check('shows the honest default (no accreditation claimed)', r.text.includes('No government accreditation or recognition is claimed'));
  check('numbers hidden by default', !r.text.includes('Our numbers'));
  await adm.post('/admin/settings', { show_stats: 'yes' }, '/admin/settings');
  check('numbers show once the admin turns them on', (await anon.get('/trust')).text.includes('Our numbers'));
  await adm.post('/admin/settings', { refund_policy: 'Refunds are decided by the office within the first week.' }, '/admin/settings');
  check('admin can edit the refund statement', (await anon.get('/trust')).text.includes('decided by the office within the first week'));

  console.log('Complaints');
  const xss = '<script>alert(9)</script>';
  r = await anon.raw('POST', '/trust/complaint', { name: 'Mary', contact: '0770111222', message: 'No token message here' });
  check('complaint without CSRF token is blocked', r.status === 403);
  r = await anon.post('/trust/complaint', { name: 'Mary ' + xss, contact: '0770111222', message: 'The payment page was confusing. ' + xss }, '/trust');
  check('complaint accepted', r.status === 302 && r.loc === '/trust');
  const raw = db.prepare('SELECT * FROM complaints ORDER BY id DESC LIMIT 1').get();
  check('complaint text is encrypted in the database', raw && !raw.message_enc.includes('payment page') && !raw.name_enc.includes('Mary'));
  r = await adm.get('/admin/complaints');
  check('admin can read it, script tags are escaped', r.text.includes('payment page was confusing') && !r.text.includes(xss));
  r = await adm.post('/admin/complaints/' + raw.id, { status: 'resolved', note: 'Called back' }, '/admin/complaints');
  check('admin can resolve it', db.prepare('SELECT status s FROM complaints WHERE id=?').get(raw.id).s === 'resolved');
  r = await anon.post('/trust/complaint', { name: 'M', contact: '1', message: 'x' }, '/trust'); check('too-short complaint refused', db.prepare('SELECT COUNT(*) n FROM complaints').get().n === 1);
  let blocked = 0; for (let i = 0; i < 7; i++) { const x = await anon.post('/trust/complaint', { name: 'Spam', contact: '0770000000', message: 'spam spam spam ' + i }, '/trust'); if (x.status === 429) blocked++; }
  check('complaint form is rate limited', blocked > 0, 'blocked=' + blocked);
  check('a student cannot open complaints', (await (async () => { await reg(s1, 'com_a'); return s1.get('/admin/complaints'); })()).status === 403);

  console.log('Setup: school course, student pays, teacher course');
  await adm.post('/admin/courses/1/lessons', { title: 'Lesson one', youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, '/admin/courses/1');
  const cid = db.prepare("SELECT id FROM courses WHERE active=1 AND (SELECT COUNT(*) FROM lessons l WHERE l.course_id=courses.id)>0 ORDER BY id LIMIT 1").get().id;
  await s1.post('/login', { username: 'com_a', password: PW }, '/login');
  r = await s1.post('/portal/enroll/' + cid, {}, '/courses/' + cid);
  const e1 = db.prepare("SELECT e.id, e.fee_cents FROM enrollments e JOIN users u ON u.id=e.user_id WHERE u.username='com_a'").get();
  r = await s1.get('/portal/qa/' + e1.id);
  check('unpaid student cannot use Q&A', r.status === 302 && /pay/.test(r.loc || ''), r.status + ' ' + r.loc);
  await s1.post('/portal/pay/' + e1.id, { amount: String(e1.fee_cents / 100), method: 'Orange Money', reference: 'ref-qa-1' }, '/portal/pay/' + e1.id);
  const pid = db.prepare('SELECT id FROM payments WHERE enrollment_id=?').get(e1.id).id;
  await adm.post('/admin/payments/' + pid + '/confirmed', {}, '/admin/payments');

  console.log('Q&A and ratings');
  r = await s1.get('/portal/qa/' + e1.id); check('paid student opens Q&A page', r.status === 200 && r.text.includes('Ask a question'));
  await s1.post('/portal/qa/' + e1.id, { body: 'How long is each lesson? ' + xss }, '/portal/qa/' + e1.id);
  const q = db.prepare('SELECT * FROM questions ORDER BY id DESC LIMIT 1').get();
  check('question saved', !!q && q.user_id === db.prepare("SELECT id FROM users WHERE username='com_a'").get().id);
  check('script tags in a question are escaped', !(await s1.get('/portal/qa/' + e1.id)).text.includes(xss));
  r = await adm.get('/admin/questions'); check('admin sees the question', r.text.includes('How long is each lesson'));
  await adm.post('/admin/questions/' + q.id, { answer: 'About ten minutes each.' }, '/admin/questions');
  check('answer reaches the student', (await s1.get('/portal/qa/' + e1.id)).text.includes('About ten minutes each'));
  for (let i = 0; i < 6; i++) await s1.post('/portal/qa/' + e1.id, { body: 'Another question number ' + i }, '/portal/qa/' + e1.id);
  check('a student cannot pile up more than 5 unanswered questions', db.prepare('SELECT COUNT(*) n FROM questions WHERE user_id=? AND answer IS NULL').get(q.user_id).n === 5);
  await reg(s2, 'com_b'); await s2.post('/login', { username: 'com_b', password: PW }, '/login');
  check("another student cannot open someone else's Q&A page", (await s2.get('/portal/qa/' + e1.id)).status === 404);
  await s2.post('/portal/review/' + e1.id, { rating: '1', comment: 'hijack' }, '/portal');
  check("another student cannot rate through someone else's enrollment", db.prepare('SELECT COUNT(*) n FROM reviews').get().n === 0);
  await s1.post('/portal/review/' + e1.id, { rating: '9', comment: 'bad' }, '/portal/qa/' + e1.id); check('rating above 5 refused', db.prepare('SELECT COUNT(*) n FROM reviews').get().n === 0);
  await s1.post('/portal/review/' + e1.id, { rating: '4', comment: 'Clear lessons ' + xss }, '/portal/qa/' + e1.id);
  await s1.post('/portal/review/' + e1.id, { rating: '5', comment: 'Clear lessons' }, '/portal/qa/' + e1.id);
  check('one rating per enrollment (second one updates it)', db.prepare('SELECT COUNT(*) n, MAX(rating) r FROM reviews').get().n === 1 && db.prepare('SELECT rating r FROM reviews').get().r === 5);
  r = await anon.get('/courses/' + cid); check('course page shows the average rating', r.text.includes('&#9733;') && r.text.includes('1 student rating'));
  r = await anon.get('/'); check('course card shows the rating', r.text.includes('1 rating'));
  r = await adm.get('/admin/quality'); check('quality report lists the course and comment', r.text.includes('★ 5 (1)') && r.text.includes('Clear lessons'));
  check('share buttons on the course page', (await anon.get('/courses/' + cid)).text.includes('wa.me'));

  console.log('Teacher answers only their own course');
  const T = { full_name: 'Grace Wiah', username: 'grace_c', email: 'grace.c@example.com', phone: '+231 88 111 2222', county: 'Montserrado', headline: 'Secondary school mathematics teacher', subjects: 'Mathematics, Computer basics', experience_years: '8', qualifications: 'B.Sc Mathematics, University of Liberia; 8 years teaching at a secondary school.', bio: 'I have taught mathematics for eight years and love helping adult learners gain confidence.', password: 'Teach2026ok', confirm: 'Teach2026ok', has_classroom: '1', consent: '1' };
  await t1.post('/teach', T, '/login');
  const tid = db.prepare("SELECT id FROM users WHERE username='grace_c'").get().id;
  await adm.post('/admin/teachers/' + tid + '/decision', { decision: 'approved', note: '' }, '/admin/teachers');
  r = await t1.post('/teacher/courses', { title: 'Practical Maths', type: 'certificate', fee: '15', duration_weeks: '6', pass_mark: '50', classroom_url: 'https://classroom.google.com/c/NjQ5MTIzNDU2Nzg5', summary: 'Everyday maths for small business owners.', description: 'Live weekly classes.', active: '1' }, '/teacher');
  const tcid = (r.loc || '').match(/\/teacher\/courses\/(\d+)/); const tc = tcid ? Number(tcid[1]) : null;
  await adm.post('/admin/courses/' + tc + '/approval', { decision: 'approved', note: '' }, '/admin/course-approvals');
  await s2.post('/portal/enroll/' + tc, {}, '/courses/' + tc);
  const e2 = db.prepare("SELECT e.id, e.fee_cents FROM enrollments e JOIN users u ON u.id=e.user_id WHERE u.username='com_b'").get();
  await s2.post('/portal/pay/' + e2.id, { amount: String(e2.fee_cents / 100), method: 'Orange Money', reference: 'ref-qa-2' }, '/portal/pay/' + e2.id);
  await adm.post('/admin/payments/' + db.prepare('SELECT id FROM payments WHERE enrollment_id=?').get(e2.id).id + '/confirmed', {}, '/admin/payments');
  await s2.post('/portal/qa/' + e2.id, { body: 'When is the first class?' }, '/portal/qa/' + e2.id);
  const q2 = db.prepare('SELECT id FROM questions WHERE course_id=?').get(tc);
  check('teacher sees the question on their course', (await t1.get('/teacher/courses/' + tc + '/questions')).text.includes('When is the first class'));
  check("teacher cannot open another course's questions", (await t1.get('/teacher/courses/' + cid + '/questions')).status === 404);
  await t1.post('/teacher/courses/' + cid + '/questions/' + q.id, { answer: 'hijack' }, '/teacher/courses/' + tc + '/questions');
  check("teacher cannot answer a question on someone else's course", db.prepare('SELECT answer a FROM questions WHERE id=?').get(q.id).a === 'About ten minutes each.');
  await t1.post('/teacher/courses/' + tc + '/questions/' + q2.id, { answer: 'Monday at 4pm.' }, '/teacher/courses/' + tc + '/questions');
  check('teacher answer reaches the student', (await s2.get('/portal/qa/' + e2.id)).text.includes('Monday at 4pm'));
  check('student cannot open teacher Q&A page', (await s2.get('/teacher/courses/' + tc + '/questions')).status === 403);

  console.log('Success stories');
  await adm.post('/admin/stories', { name: 'Ruth', course: 'Computer Basics', quote: 'I got my first office job after the course.' }, '/admin/stories');
  check('story without permission box is refused', db.prepare('SELECT COUNT(*) n FROM stories').get().n === 0);
  await adm.post('/admin/stories', { name: 'Ruth', course: 'Computer Basics', quote: 'I got my first office job after the course. ' + xss, consent: 'yes' }, '/admin/stories');
  r = await anon.get('/trust'); check('story shows on trust page, escaped', r.text.includes('first office job') && !r.text.includes(xss));
  await adm.post('/admin/stories/' + db.prepare('SELECT id FROM stories').get().id + '/toggle', {}, '/admin/stories');
  check('admin can hide a story', !(await anon.get('/trust')).text.includes('first office job'));

  console.log('Referrals');
  r = await s1.get('/portal'); const code = (r.text.match(/signup\?ref=([A-F0-9]+)/) || [])[1];
  check('student gets an invite link with a code', !!code);
  const s3 = client(); await reg(s3, 'com_friend', code);
  const me = db.prepare("SELECT id FROM users WHERE username='com_a'").get().id;
  check('friend who joins through the link is counted', db.prepare("SELECT referred_by r FROM users WHERE username='com_friend'").get().r === me);
  check('invite counter shows 1', (await s1.get('/portal')).text.includes('<strong>1</strong> friend joined'));
  const s4 = client(); await reg(s4, 'com_noref', 'ZZZZZZZZZZ');
  check('a made-up code is ignored', db.prepare("SELECT referred_by r FROM users WHERE username='com_noref'").get().r == null);

  console.log('Reminders & access');
  r = await adm.get('/admin/growth'); check('admin growth hub loads', r.status === 200 && r.text.includes('Quality report'));
  r = await adm.get('/admin/reminders'); check('reminders page loads', r.status === 200);
  r = await adm.post('/admin/reminders/unpaid', {}, '/admin/reminders'); check('sending reminders does not crash', r.status === 302);
  for (const p of ['/admin/growth', '/admin/quality', '/admin/questions', '/admin/stories', '/admin/reminders']) check('student blocked from ' + p, (await s1.get(p)).status === 403);
  check('anonymous visitor redirected from admin quality', (await anon.get('/admin/quality')).status === 302);

  console.log('\n' + pass + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
