// Teacher-platform smoke test. Start the server on a FRESH data dir first, then:
//   BASE=http://localhost:3112 ADMIN_PASSWORD=... DATA_DIR=... node test/teacher_smoke.js
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'admin';
const Database = require('better-sqlite3');

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
    return { status: r.status, text: await r.text(), loc: r.headers.get('location'), headers: r.headers };
  }
  const csrfOf = (html) => (html.match(/name="_csrf" value="([a-f0-9]+)"/) || [])[1];
  return {
    get: (p) => req('GET', p),
    // tokenPage: any page that carries a CSRF token for this session ('/verify' once logged in, '/login' when anonymous)
    async post(p, form, tokenPage = '/verify') {
      const page = await req('GET', tokenPage);
      return req('POST', p, { ...form, _csrf: csrfOf(page.text) });
    }
  };
}
const id = (s, re) => { const m = String(s || '').match(re); return m ? Number(m[1]) : null; };

const T1 = { full_name: 'Grace Wiah', username: 'grace_w', email: 'grace.wiah@example.com', phone: '+231 88 111 2222', county: 'Montserrado',
  headline: 'Secondary school mathematics teacher', subjects: 'Mathematics, Computer basics', experience_years: '8',
  qualifications: 'B.Sc Mathematics, University of Liberia; 8 years teaching at a secondary school.',
  bio: 'I have taught mathematics for eight years and love helping adult learners gain confidence.',
  password: 'Teach2026ok', confirm: 'Teach2026ok', has_classroom: '1', consent: '1' };
const LINK = 'https://classroom.google.com/c/NjQ5MTIzNDU2Nzg5';

(async () => {
  const db = new Database(path.join(process.env.DATA_DIR, 'lgou.db'), { readonly: true });
  const anon = client(), adm = client(), t1 = client(), t2 = client(), stu = client(), stu2 = client();

  console.log('Public teacher pages');
  let r = await anon.get('/teach');
  check('"Teach with us" page explains how to apply', r.status === 200 && r.text.includes('Teacher application') && r.text.includes('Google Classroom'));
  r = await anon.get('/teachers');
  check('teachers page loads (empty at first)', r.status === 200);
  r = await anon.get('/');
  check('homepage has enroll steps, fee info, teachers and apply sections', ['How students enroll', 'Fee information', 'Meet our teachers', 'Teach with us'].every(s => r.text.includes(s)));
  check('homepage states Google Classroom integration note', r.text.includes('does not host video'));

  console.log('Teacher application');
  r = await anon.post('/teach', { ...T1, consent: '' }, '/login');
  check('application without public-profile consent is refused', r.status === 400);
  r = await anon.post('/teach', { ...T1, password: 'weak', confirm: 'weak' }, '/login');
  check('weak teacher password refused', r.status === 400);
  r = await t1.post('/teach', T1, '/login');
  check('valid application creates account and goes to status page', r.status === 302 && r.loc === '/teacher', r.status + ' ' + r.loc);
  r = await t1.get('/teacher');
  check('pending teacher sees "Under review"', r.status === 200 && r.text.includes('Under review'));
  r = await t1.get('/teacher/courses');
  check('pending teacher blocked from teacher tools', r.status === 302 && r.loc === '/teacher');
  r = await t1.post('/teacher/courses', { title: 'Sneaky', type: 'certificate', fee: '5', duration_weeks: '4', pass_mark: '50', classroom_url: LINK }, '/teacher');
  check('pending teacher cannot create a course', r.status === 302 && r.loc === '/teacher' && !db.prepare("SELECT 1 FROM courses WHERE title='Sneaky'").get());
  r = await t1.get('/admin');
  check('teacher blocked from admin dashboard (403)', r.status === 403);
  r = await t1.get('/portal');
  check('teacher is not allowed into the student portal', r.status === 302 && r.loc === '/teacher');
  r = await anon.get('/teachers');
  check('pending teacher is NOT listed publicly', !r.text.includes('Grace Wiah'));
  r = await anon.post('/teach', { ...T1, username: 'other', email: 'GRACE.WIAH@example.com' }, '/login');
  check('duplicate email refused for teacher application', r.status === 400);

  console.log('Admin reviews the application');
  r = await adm.post('/login', { username: 'admin', password: ADMIN_PW }, '/login');
  check('admin login works', r.status === 302 && r.loc === '/admin');
  r = await adm.get('/admin');
  check('admin dashboard shows teacher-application stat', r.text.includes('Teacher applications') && r.text.includes('Courses to approve'));
  r = await adm.get('/admin/teachers');
  const tid = id(r.text, /\/admin\/teachers\/(\d+)/);
  check('admin sees pending application with decrypted email', !!tid && r.text.includes('grace.wiah@example.com'));
  r = await adm.post(`/admin/teachers/${tid}/decision`, { decision: 'rejected', note: '' }, '/admin/teachers');
  r = await t1.get('/teacher');
  check('rejecting needs a note (still pending)', r.text.includes('Under review'));
  r = await adm.post(`/admin/teachers/${tid}/decision`, { decision: 'approved', note: '' }, '/admin/teachers');
  r = await adm.get(`/admin/teachers/${tid}`);
  check('admin teacher page shows qualifications and approved status', r.text.includes('B.Sc Mathematics') && r.text.includes('>approved<'));
  r = await anon.get('/teachers');
  check('approved teacher appears on public teachers page', r.text.includes('Grace Wiah') && r.text.includes('Secondary school mathematics teacher'));
  check('public teachers page never shows email', !r.text.includes('grace.wiah@example.com'));
  r = await anon.get(`/teachers/${tid}`);
  check('public teacher profile loads with bio', r.status === 200 && r.text.includes('eight years'));

  console.log('Teacher creates a course');
  r = await t1.get('/teacher');
  check('teacher dashboard unlocked after approval', r.status === 200 && r.text.includes('My courses'));
  const base = { title: 'Practical Mathematics for Business', type: 'certificate', fee: '15', duration_weeks: '6', pass_mark: '50',
    summary: 'Everyday maths for small business owners.', description: 'Live weekly classes.', classroom_url: LINK, active: '1' };
  await t1.post('/teacher/courses', { ...base, classroom_url: 'https://evil.example.com/classroom.google.com/c/abc' });
  r = await t1.get('/teacher/courses');
  check('non-Google link is rejected', !db.prepare("SELECT 1 FROM courses WHERE title=?").get(base.title));
  await t1.post('/teacher/courses', { ...base, classroom_url: 'http://classroom.google.com/c/abc' });
  check('plain http link is rejected', !db.prepare("SELECT 1 FROM courses WHERE title=?").get(base.title));
  await t1.post('/teacher/courses', { ...base, classroom_url: 'javascript:alert(1)' });
  check('javascript: link is rejected', !db.prepare("SELECT 1 FROM courses WHERE title=?").get(base.title));
  await t1.post('/teacher/courses', { ...base, fee: '500' });
  check('fee above the school maximum is rejected', !db.prepare("SELECT 1 FROM courses WHERE title=?").get(base.title));
  r = await t1.post('/teacher/courses', base);
  const cid = id(r.loc, /\/teacher\/courses\/(\d+)/);
  check('valid course is created and waits for approval', !!cid && db.prepare('SELECT approval_status s FROM courses WHERE id=?').get(cid).s === 'pending');
  r = await anon.get('/');
  check('pending course is NOT on the public homepage', !r.text.includes('Practical Mathematics'));
  r = await anon.get(`/courses/${cid}`);
  check('pending course page is not public (404)', r.status === 404);

  console.log('Admin approves the course');
  r = await adm.get('/admin/course-approvals');
  check('admin sees the course to approve with teacher name', r.text.includes('Practical Mathematics') && r.text.includes('Grace Wiah'));
  await adm.post(`/admin/courses/${cid}/approval`, { decision: 'approved', note: '' }, '/admin/course-approvals');
  r = await anon.get('/');
  check('approved course appears on homepage with teacher and live-classes badge', r.text.includes('Practical Mathematics') && r.text.includes('Taught by Grace Wiah') && r.text.includes('Live classes'));
  check('Classroom link is NOT on the homepage', !r.text.includes('classroom.google.com/c/'));
  r = await anon.get(`/courses/${cid}`);
  check('public course page works and hides the Classroom link', r.status === 200 && !r.text.includes('classroom.google.com/c/'));

  console.log('Student enrols, pays and joins Classroom');
  r = await stu.post('/signup', { full_name: 'Mary Kollie', username: 'mary_k', email: 'mary.kollie@example.com', phone: '+231 77 000 1111', password: 'Learn2026ok', confirm: 'Learn2026ok' }, '/login');
  check('student signs up', r.status === 302 && r.loc === '/portal');
  r = await stu.post(`/portal/enroll/${cid}`, {});
  const eid = id(r.loc, /\/portal\/pay\/(\d+)/);
  check('student enrols in teacher course', !!eid, r.loc);
  r = await stu.get(`/portal/classroom/${eid}`);
  check('Classroom link is withheld until the fee is confirmed', r.status === 302 && !String(r.loc).includes('google.com'), r.loc);
  await stu.post(`/portal/pay/${eid}`, { amount: '15.00', method: 'Orange Money', reference: 'OM-55667788' }, '/verify');
  r = await stu.get(`/portal/classroom/${eid}`);
  check('still withheld while payment is only pending', !String(r.loc).includes('google.com'));
  r = await adm.get('/admin/payments');
  const pid = id(r.text, /\/admin\/payments\/(\d+)\/confirmed/);
  check('admin payments page shows the teacher for the course', r.text.includes('teacher: Grace Wiah'));
  await adm.post(`/admin/payments/${pid}/confirmed`, {}, '/admin/payments');
  r = await stu.get(`/portal/classroom/${eid}`);
  check('after confirmation the student is redirected to the teacher\'s Classroom', r.status === 302 && r.loc === LINK, r.loc);
  r = await stu.get('/portal');
  check('student portal shows the Join Google Classroom button', r.text.includes('Join Google Classroom') && r.text.includes(`/portal/classroom/${eid}`));
  check('raw Classroom URL is not printed in the portal page', !r.text.includes('classroom.google.com/c/'));
  r = await stu.get(`/portal/learn/${eid}`);
  check('learn page shows Classroom box and teacher name', r.status === 200 && r.text.includes('Grace Wiah') && r.text.includes('Join Google Classroom'));

  console.log('Teacher dashboard: students, lists, attendance, grades');
  r = await t1.get(`/teacher/courses/${cid}/students`);
  check('teacher sees the student with paid status', r.text.includes('Mary Kollie') && r.text.includes('>paid<'));
  check('teacher does NOT see payment reference, email or phone', !r.text.includes('OM-55667788') && !r.text.includes('mary.kollie@example.com') && !r.text.includes('231 77 000'));
  r = await t1.post(`/teacher/courses/${cid}/groups`, { name: 'Morning class' });
  const gid = id(r.loc, /groups\/(\d+)/);
  check('teacher creates a student list', !!gid);
  await t1.post(`/teacher/courses/${cid}/groups/${gid}`, { enr: String(eid) });
  check('student added to the list', db.prepare('SELECT COUNT(*) n FROM group_members WHERE group_id=?').get(gid).n === 1);
  r = await t1.post(`/teacher/courses/${cid}/attendance`, { session_date: '2026-11-02', topic: 'Week 1 - percentages' });
  const sid = id(r.loc, /attendance\/(\d+)/);
  check('attendance session created', !!sid);
  r = await t1.post(`/teacher/courses/${cid}/attendance`, { session_date: '2026-13-45', topic: 'bad date' });
  check('invalid date refused', db.prepare("SELECT COUNT(*) n FROM attendance_sessions WHERE topic='bad date'").get().n === 0);
  await t1.post(`/teacher/courses/${cid}/attendance/${sid}`, { ['st_' + eid]: 'present' });
  r = await t1.post(`/teacher/courses/${cid}/attendance`, { session_date: '2026-11-09', topic: 'Week 2' });
  const sid2 = id(r.loc, /attendance\/(\d+)/);
  await t1.post(`/teacher/courses/${cid}/attendance/${sid2}`, { ['st_' + eid]: 'absent' });
  r = await t1.get(`/teacher/courses/${cid}/students`);
  check('attendance percentage computed (1 of 2 = 50%)', r.text.includes('50%'));
  r = await t1.get(`/teacher/courses/${cid}/attendance/${sid}?group=${gid}`);
  check('attendance sheet can be filtered by student list', r.status === 200 && r.text.includes('Mary Kollie'));
  await t1.post(`/teacher/courses/${cid}/grade-items`, { title: 'Quiz 1', category: 'quiz', max_score: '20' });
  const item = db.prepare('SELECT id FROM grade_items WHERE course_id=?').get(cid);
  check('grade item created', !!item);
  await t1.post(`/teacher/courses/${cid}/grades`, { [`s_${item.id}_${eid}`]: '25' });
  check('score above the maximum is rejected', !db.prepare('SELECT 1 FROM grades WHERE item_id=?').get(item.id));
  await t1.post(`/teacher/courses/${cid}/grades`, { [`s_${item.id}_${eid}`]: '17' });
  check('valid score saved', db.prepare('SELECT score FROM grades WHERE item_id=?').get(item.id).score === 17);
  r = await t1.get(`/teacher/courses/${cid}/students`);
  check('grade average shown in student progress (17/20 = 85%)', r.text.includes('85%'));

  console.log('Student sees results; certificate flow');
  r = await stu.get(`/portal/results/${eid}`);
  check('student sees own attendance and grades', r.status === 200 && r.text.includes('17 / 20') && r.text.includes('Week 1 - percentages') && r.text.includes('absent'));
  await stu.post(`/portal/request-certificate/${eid}`, {}, '/verify');
  check('student cannot request a certificate before the teacher recommends', db.prepare('SELECT status s FROM enrollments WHERE id=?').get(eid).s === 'enrolled');
  await t1.post(`/teacher/courses/${cid}/recommend/${eid}`, { score: '150' });
  check('invalid final score refused', db.prepare('SELECT completion_recommended c FROM enrollments WHERE id=?').get(eid).c === 0);
  await t1.post(`/teacher/courses/${cid}/recommend/${eid}`, { score: '85' });
  check('teacher recommends completion', db.prepare('SELECT completion_recommended c, recommended_score s FROM enrollments WHERE id=?').get(eid).s === 85);
  await stu.post(`/portal/request-certificate/${eid}`, {}, '/verify');
  check('student can now request the certificate', db.prepare('SELECT status s FROM enrollments WHERE id=?').get(eid).s === 'requested');
  r = await adm.get('/admin/approvals');
  check('admin sees teacher recommendation with score pre-filled', r.text.includes('teacher recommended (85%)') && r.text.includes('value="85"'));
  r = await adm.post(`/admin/approvals/${eid}/approve`, { score: '85' }, '/admin/approvals');
  check('admin approves and issues certificate', r.status === 302 && r.loc === '/admin/certificates', r.loc);
  r = await stu.get(`/portal/certificate/${eid}`);
  check('student can open the certificate', r.status === 200 && r.text.includes('Practical Mathematics for Business'));

  console.log('Isolation and access control');
  await t2.post('/teach', { ...T1, full_name: 'Peter Dolo', username: 'peter_d', email: 'peter.dolo@example.com' }, '/login');
  r = await adm.get('/admin/teachers');
  const tid2 = id(r.text, /\/admin\/teachers\/(\d+)/);
  await adm.post(`/admin/teachers/${tid2}/decision`, { decision: 'approved', note: '' }, '/admin/teachers');
  r = await t2.get('/teacher/courses');
  check('second teacher approved and can use tools', r.status === 200);
  for (const p of [`/teacher/courses/${cid}`, `/teacher/courses/${cid}/students`, `/teacher/courses/${cid}/attendance`, `/teacher/courses/${cid}/grades`, `/teacher/courses/${cid}/attendance/${sid}`, `/teacher/courses/${cid}/groups/${gid}`]) {
    r = await t2.get(p);
    check(`teacher 2 cannot open teacher 1's page ${p.replace('/teacher/courses/', '…/')}`, r.status === 404, String(r.status));
  }
  await t2.post(`/teacher/courses/${cid}`, { ...base, title: 'Hijacked', fee: '1' });
  check('teacher 2 cannot edit teacher 1\'s course', db.prepare('SELECT title FROM courses WHERE id=?').get(cid).title === base.title);
  await t2.post(`/teacher/courses/${cid}/grade-items`, { title: 'Injected', category: 'quiz', max_score: '10' });
  check('teacher 2 cannot add grade items to teacher 1\'s course', !db.prepare("SELECT 1 FROM grade_items WHERE title='Injected'").get());
  await t2.post(`/teacher/courses/${cid}/recommend/${eid}`, { score: '99' });
  r = await t2.post('/teacher/courses', { ...base, title: 'Peter Course' });
  const cid2 = id(r.loc, /\/teacher\/courses\/(\d+)/);
  r = await t2.post(`/teacher/courses/${cid2}/groups`, { name: 'Mine' });
  const gid2 = id(r.loc, /groups\/(\d+)/);
  await t2.post(`/teacher/courses/${cid2}/groups/${gid2}`, { enr: String(eid) });
  check('teacher 2 cannot put another course\'s student into their own list', db.prepare('SELECT COUNT(*) n FROM group_members WHERE group_id=?').get(gid2).n === 0);
  r = await stu2.post('/signup', { full_name: 'John Doe', username: 'john_d', email: 'john@example.com', password: 'Learn2026ok', confirm: 'Learn2026ok' }, '/login');
  r = await stu2.get(`/portal/results/${eid}`);
  check("student 2 cannot see student 1's grades", r.status === 404);
  r = await stu2.get(`/portal/classroom/${eid}`);
  check("student 2 cannot use student 1's Classroom access", r.status === 404);
  r = await stu2.get('/teacher');
  check('student cannot open teacher area (403)', r.status === 403);
  r = await anon.get('/teacher');
  check('anonymous cannot open teacher area', r.status === 302 && r.loc === '/login');
  r = await anon.get(`/portal/classroom/${eid}`);
  check('anonymous cannot use the Classroom redirect', r.status === 302 && r.loc === '/login');
  r = await t2.get('/admin/teachers');
  check('teacher cannot open admin teacher list', r.status === 403);
  r = await stu2.post(`/portal/enroll/${cid2}`, {});
  check('pending course cannot be enrolled in', r.status === 404);

  console.log('Suspension');
  await adm.post(`/admin/teachers/${tid}/decision`, { decision: 'suspended', note: 'Under investigation' }, '/admin/teachers');
  r = await anon.get('/');
  check('suspended teacher\'s courses and profile disappear from the public site', !r.text.includes('Practical Mathematics') && !r.text.includes('Grace Wiah'));
  r = await stu.get(`/portal/classroom/${eid}`);
  check('suspended teacher: students no longer get the Classroom link', !String(r.loc).includes('google.com'), r.loc);
  r = await t1.get('/teacher');
  check('suspended teacher sees the suspension note', r.text.includes('Suspended') && r.text.includes('Under investigation'));
  r = await t1.get('/teacher/courses');
  check('suspended teacher is blocked from tools', r.status === 302);
  await adm.post(`/admin/teachers/${tid}/decision`, { decision: 'approved', note: '' }, '/admin/teachers');
  r = await stu.get(`/portal/classroom/${eid}`);
  check('re-approval restores access', r.loc === LINK);

  console.log('Course approval workflow');
  await adm.post(`/admin/courses/${cid2}/approval`, { decision: 'rejected', note: 'Please add a fuller description' }, '/admin/course-approvals');
  r = await t2.get(`/teacher/courses/${cid2}`);
  check('rejected course shows the admin reason and a resubmit button', r.text.includes('Please add a fuller description') && r.text.includes('Resubmit'));
  await t2.post(`/teacher/courses/${cid2}/resubmit`, {});
  check('teacher resubmits, back to pending', db.prepare('SELECT approval_status s FROM courses WHERE id=?').get(cid2).s === 'pending');

  console.log('Data protection');
  const blob = require('fs').readdirSync(process.env.DATA_DIR).filter(f => f.startsWith('lgou.db')).map(f => require('fs').readFileSync(path.join(process.env.DATA_DIR, f)).toString('latin1')).join('');
  check('teacher email not stored in plaintext', !blob.includes('grace.wiah@example.com'));
  check('teacher phone not stored in plaintext', !blob.includes('+231 88 111 2222'));
  check('teacher name not stored in plaintext', !blob.includes('Grace Wiah'));
  check('teacher password stored only as a bcrypt hash', !blob.includes('Teach2026ok'));

  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
