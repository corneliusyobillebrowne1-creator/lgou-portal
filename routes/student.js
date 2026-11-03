const router = require('express').Router();
const { db, audit, getSetting } = require('../lib/db');
const { encrypt, decrypt } = require('../lib/crypto');
const { requireStudent } = require('../lib/auth');
const { enrollmentRows, publicCourses, PUBLIC_OK } = require('../lib/queries');
const { parseMoney } = require('../lib/util');
const site = require('../lib/site');

router.use(requireStudent);

const { getMethods, methodNames } = require('../lib/payments');

// Always loads the enrollment through the logged-in student's id, so nobody can open another student's record.
function myEnrollment(req, res) {
  const e = enrollmentRows('e.id=? AND e.user_id=?', [Number(req.params.id), req.user.id])[0];
  if (!e) { res.status(404).render('error', { title: 'Not found', message: 'Enrollment not found.' }); return null; }
  return e;
}

router.get('/', (req, res) => {
  const enrollments = enrollmentRows('e.user_id=?', [req.user.id]);
  const available = publicCourses('c.id NOT IN (SELECT course_id FROM enrollments WHERE user_id=?)', [req.user.id]);
  res.render('student/dashboard', { title: 'My Portal', enrollments, available, news: site.announcements(3) });
});

// Academic transcript: every programme with progress, grade average and any qualification issued. Only the student's own records.
router.get('/transcript', (req, res) => {
  const rows = enrollmentRows('e.user_id=?', [req.user.id]).map(e => {
    const g = db.prepare(`SELECT COALESCE(SUM(g.score),0) AS got, COALESCE(SUM(i.max_score),0) AS max FROM grades g
      JOIN grade_items i ON i.id=g.item_id WHERE g.enrollment_id=? AND g.score IS NOT NULL`).get(e.id);
    const cert = db.prepare("SELECT cert_no, issued_at, status FROM certificates WHERE enrollment_id=?").get(e.id);
    return { ...e, gradePct: g.max ? Math.round((g.got * 1000) / g.max) / 10 : null, cert };
  });
  res.render('student/transcript', { title: 'Transcript', rows, generated: new Date().toISOString() });
});

router.post('/enroll/:courseId', (req, res) => {
  const course = publicCourses('c.id=?', [Number(req.params.courseId)])[0];
  if (!course) return res.status(404).render('error', { title: 'Not found', message: 'Course not found or not open for enrolment.' });
  if (!course.ready) {
    req.session.flash = { type: 'warn', msg: 'Enrolment for this course opens soon, once its lessons are added.' };
    return res.redirect('/courses/' + course.id);
  }
  db.prepare('INSERT OR IGNORE INTO enrollments (user_id,course_id,fee_cents) VALUES (?,?,?)')
    .run(req.user.id, course.id, course.fee_cents);
  const e = db.prepare('SELECT id FROM enrollments WHERE user_id=? AND course_id=?').get(req.user.id, course.id);
  audit(req.user.id, 'enroll', course.title, req.ip);
  res.redirect('/portal/pay/' + e.id);
});

router.get('/pay/:id', (req, res) => {
  const e = myEnrollment(req, res); if (!e) return;
  const payments = db.prepare('SELECT * FROM payments WHERE enrollment_id=? ORDER BY id DESC').all(e.id)
    .map(p => ({ ...p, reference: decrypt(p.reference_enc) }));
  res.render('student/pay', {
    title: 'Pay fees', e, payments, methods: getMethods(),
    instructions: getSetting('payment_instructions'), error: null
  });
});

router.post('/pay/:id', (req, res) => {
  const e = myEnrollment(req, res); if (!e) return;
  const amount = parseMoney(req.body.amount);
  const method = String(req.body.method || '');
  const ref = String(req.body.reference || '').trim();
  const fail = (error) => {
    const payments = db.prepare('SELECT * FROM payments WHERE enrollment_id=? ORDER BY id DESC').all(e.id)
      .map(p => ({ ...p, reference: decrypt(p.reference_enc) }));
    return res.status(400).render('student/pay', { title: 'Pay fees', e, payments, methods: getMethods(), instructions: getSetting('payment_instructions'), error });
  };
  if (!amount || amount <= 0) return fail('Enter a valid amount, for example 10 or 10.50.');
  if (amount > e.owed_cents) return fail('That is more than the balance you owe.');
  if (!methodNames().includes(method)) return fail('Choose a payment method.');
  if (ref.length < 4 || ref.length > 60) return fail('Enter the transaction reference or receipt number (4-60 characters).');
  db.prepare('INSERT INTO payments (enrollment_id,user_id,amount_cents,method,reference_enc) VALUES (?,?,?,?,?)')
    .run(e.id, req.user.id, amount, method, encrypt(ref));
  audit(req.user.id, 'payment_submitted', `enrollment ${e.id}`, req.ip);
  req.session.flash = { type: 'ok', msg: 'Payment submitted. You will get access once the school confirms it.' };
  res.redirect('/portal/pay/' + e.id);
});

// A course's live-class link is only handed out to students whose fee is confirmed, for an approved course
// whose teacher is still approved. The link is never printed in any public page.
function classroomAccess(e) {
  if (!e.has_classroom) return { ok: false, why: 'This course has no Google Classroom link.' };
  if (!e.paid_full) return { ok: false, why: 'Your fee must be paid and confirmed first.' };
  const open = db.prepare(`SELECT 1 FROM courses c WHERE c.id=? AND c.approval_status='approved' AND (c.teacher_id IS NULL OR EXISTS (
      SELECT 1 FROM teacher_profiles tp JOIN users tu ON tu.id=tp.user_id WHERE tp.user_id=c.teacher_id AND tp.status='approved' AND tu.active=1))`).get(e.course_id);
  if (!open) return { ok: false, why: 'This class is not available right now. Please contact the school office.' };
  return { ok: true };
}

router.get('/classroom/:id', (req, res) => {
  const e = myEnrollment(req, res); if (!e) return;
  const a = classroomAccess(e);
  if (!a.ok) { req.session.flash = { type: 'warn', msg: a.why }; return res.redirect(e.paid_full ? '/portal' : '/portal/pay/' + e.id); }
  audit(req.user.id, 'classroom_opened', `enrollment ${e.id}`, req.ip);
  res.redirect(e.classroom_url);
});

router.get('/learn/:id', (req, res) => {
  const e = myEnrollment(req, res); if (!e) return;
  if (!e.paid_full) {
    req.session.flash = { type: 'warn', msg: 'Your fee must be paid and confirmed before you can start the course.' };
    return res.redirect('/portal/pay/' + e.id);
  }
  const lessons = db.prepare('SELECT * FROM lessons WHERE course_id=? ORDER BY position, id').all(e.course_id);
  const done = new Set(db.prepare('SELECT lesson_id FROM lesson_progress WHERE enrollment_id=?').all(e.id).map(r => r.lesson_id));
  const current = lessons.find(l => l.id === Number(req.query.lesson))
    || lessons.find(l => !done.has(l.id)) || lessons[0] || null;
  const teacher = e.teacher_id ? db.prepare('SELECT full_name_enc FROM users WHERE id=?').get(e.teacher_id) : null;
  res.render('student/learn', { title: e.course_title, e, lessons, done, current, classroom: classroomAccess(e), teacherName: teacher ? decrypt(teacher.full_name_enc) : null });
});

router.post('/learn/:id/complete/:lessonId', (req, res) => {
  const e = myEnrollment(req, res); if (!e) return;
  if (!e.paid_full) return res.redirect('/portal/pay/' + e.id);
  const lesson = db.prepare('SELECT * FROM lessons WHERE id=? AND course_id=?').get(Number(req.params.lessonId), e.course_id);
  if (!lesson) return res.status(404).render('error', { title: 'Not found', message: 'Lesson not found.' });
  db.prepare('INSERT OR IGNORE INTO lesson_progress (enrollment_id,lesson_id) VALUES (?,?)').run(e.id, lesson.id);
  const next = db.prepare(`SELECT id FROM lessons WHERE course_id=? AND id NOT IN
    (SELECT lesson_id FROM lesson_progress WHERE enrollment_id=?) ORDER BY position, id LIMIT 1`).get(e.course_id, e.id);
  res.redirect('/portal/learn/' + e.id + (next ? '?lesson=' + next.id : ''));
});

// Attendance and grades recorded by the teacher - a student sees only their own.
router.get('/results/:id', (req, res) => {
  const e = myEnrollment(req, res); if (!e) return;
  const attendance = db.prepare(`SELECT s.session_date, s.topic, r.status FROM attendance_sessions s
    LEFT JOIN attendance_records r ON r.session_id=s.id AND r.enrollment_id=? WHERE s.course_id=? ORDER BY s.session_date DESC, s.id DESC`).all(e.id, e.course_id);
  const grades = db.prepare(`SELECT i.title, i.category, i.max_score, g.score FROM grade_items i
    LEFT JOIN grades g ON g.item_id=i.id AND g.enrollment_id=? WHERE i.course_id=? ORDER BY i.id`).all(e.id, e.course_id);
  const marked = attendance.filter(a => a.status);
  const counted = marked.filter(a => a.status !== 'excused');
  const attPct = counted.length ? Math.round((counted.filter(a => a.status === 'present' || a.status === 'late').length * 100) / counted.length) : null;
  const gs = grades.filter(g => g.score !== null);
  const gradePct = gs.length ? Math.round((gs.reduce((s, g) => s + g.score, 0) * 1000) / gs.reduce((s, g) => s + g.max_score, 0)) / 10 : null;
  res.render('student/results', { title: 'Attendance & grades', e, attendance, grades, attPct, gradePct });
});

router.post('/request-certificate/:id', (req, res) => {
  const e = myEnrollment(req, res); if (!e) return;
  let msg;
  if (e.status !== 'enrolled') msg = { type: 'warn', msg: 'A certificate request already exists for this course.' };
  else if (!e.paid_full) msg = { type: 'warn', msg: 'Your fee must be fully paid before you can request a certificate.' };
  else if (!e.eligible) msg = { type: 'warn', msg: e.teacher_id ? 'Your teacher has not yet recommended you for completion.' : 'Finish all lessons first.' };
  else {
    db.prepare("UPDATE enrollments SET status='requested', request_note=NULL WHERE id=?").run(e.id);
    audit(req.user.id, 'certificate_requested', `enrollment ${e.id}`, req.ip);
    msg = { type: 'ok', msg: 'Certificate requested. The school will review your studies.' };
  }
  req.session.flash = msg;
  res.redirect('/portal');
});

router.get('/certificate/:id', (req, res) => {
  const e = myEnrollment(req, res); if (!e) return;
  const cert = db.prepare("SELECT * FROM certificates WHERE enrollment_id=?").get(e.id);
  if (!cert) {
    req.session.flash = { type: 'warn', msg: 'No certificate has been issued for this course yet.' };
    return res.redirect('/portal');
  }
  res.render('certificate', { cert: { ...cert, student_name: decrypt(cert.student_name_enc) }, baseUrl: req.protocol + '://' + req.get('host') });
});

module.exports = router;
