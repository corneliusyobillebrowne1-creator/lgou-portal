const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db, audit, getSetting, setSetting } = require('../lib/db');
const { encrypt, decrypt } = require('../lib/crypto');
const { requireAdmin } = require('../lib/auth');
const { enrollmentRows } = require('../lib/queries');
const { parseMoney, youtubeId } = require('../lib/util');
const { runBackup, listBackups } = require('../lib/backup');

router.use(requireAdmin);

const { methodNames, saveMethods, methodsText } = require('../lib/payments');
const mailer = require('../lib/mailer');
const emails = require('../lib/emails');
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const notFound = (res, what) => res.status(404).render('error', { title: 'Not found', message: what + ' not found.' });

// ---------- dashboard ----------
router.get('/', (req, res) => {
  const one = (sql) => db.prepare(sql).get().n;
  const stats = {
    students: one("SELECT COUNT(*) n FROM users WHERE role='student'"),
    enrollments: one('SELECT COUNT(*) n FROM enrollments'),
    revenue: one("SELECT COALESCE(SUM(amount_cents),0) n FROM payments WHERE status='confirmed'"),
    pendingPayments: one("SELECT COUNT(*) n FROM payments WHERE status='pending'"),
    owed: one(`SELECT COALESCE(SUM(MAX(e.fee_cents - COALESCE((SELECT SUM(amount_cents) FROM payments p
      WHERE p.enrollment_id=e.id AND p.status='confirmed'),0), 0)),0) n FROM enrollments e`),
    certRequests: one("SELECT COUNT(*) n FROM enrollments WHERE status='requested'"),
    certsIssued: one("SELECT COUNT(*) n FROM certificates WHERE status='valid'"),
    teachersPending: one("SELECT COUNT(*) n FROM teacher_profiles WHERE status='pending'"),
    teachersApproved: one("SELECT COUNT(*) n FROM teacher_profiles WHERE status='approved'"),
    coursesPending: one("SELECT COUNT(*) n FROM courses WHERE approval_status='pending'")
  };
  const activity = db.prepare(`SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
    ORDER BY a.id DESC LIMIT 12`).all();
  res.render('admin/index', { title: 'Admin Dashboard', stats, activity, lastBackup: listBackups()[0] || null });
});

// ---------- students ----------
router.get('/students', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let rows = db.prepare(`SELECT u.*,
      (SELECT COUNT(*) FROM enrollments e WHERE e.user_id=u.id) AS enrolled,
      (SELECT COALESCE(SUM(MAX(e.fee_cents - COALESCE((SELECT SUM(amount_cents) FROM payments p
        WHERE p.enrollment_id=e.id AND p.status='confirmed'),0), 0)),0) FROM enrollments e WHERE e.user_id=u.id) AS owed_cents
    FROM users u WHERE u.role='student' ORDER BY u.id DESC`).all()
    .map(u => ({ ...u, full_name: decrypt(u.full_name_enc), email: decrypt(u.email_enc), phone: decrypt(u.phone_enc) }));
  if (q) rows = rows.filter(u => [u.username, u.full_name, u.email, u.phone].some(v => String(v).toLowerCase().includes(q)));
  res.render('admin/students', { title: 'Students', students: rows, q });
});

router.get('/students/:id', (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND role='student'").get(Number(req.params.id));
  if (!u) return notFound(res, 'Student');
  const student = { ...u, full_name: decrypt(u.full_name_enc), email: decrypt(u.email_enc), phone: decrypt(u.phone_enc) };
  const enrollments = enrollmentRows('e.user_id=?', [u.id]);
  const payments = db.prepare(`SELECT p.*, c.title AS course_title FROM payments p
    JOIN enrollments e ON e.id=p.enrollment_id JOIN courses c ON c.id=e.course_id
    WHERE p.user_id=? ORDER BY p.id DESC`).all(u.id).map(p => ({ ...p, reference: decrypt(p.reference_enc) }));
  res.render('admin/student', { title: student.full_name, s: student, enrollments, payments, methods: methodNames() });
});

router.post('/students/:id/toggle', (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND role='student'").get(Number(req.params.id));
  if (!u) return notFound(res, 'Student');
  const next = u.active ? 0 : 1;
  db.prepare('UPDATE users SET active=? WHERE id=?').run(next, u.id);
  if (!next) db.prepare('DELETE FROM sessions WHERE data LIKE ?').run('%"userId":' + u.id + '%');
  audit(req.user.id, next ? 'student_enabled' : 'student_disabled', u.username, req.ip);
  flash(req, 'ok', `Account ${next ? 'enabled' : 'disabled'}.`);
  res.redirect('/admin/students/' + u.id);
});

router.post('/students/:id/reset-password', async (req, res, next) => {
  try {
    const u = db.prepare("SELECT * FROM users WHERE id=? AND role='student'").get(Number(req.params.id));
    if (!u) return notFound(res, 'Student');
    const temp = crypto.randomBytes(6).toString('base64url') + '7';
    db.prepare('UPDATE users SET password_hash=?, failed_count=0, locked_until=0 WHERE id=?').run(await bcrypt.hash(temp, 12), u.id);
    audit(req.user.id, 'student_password_reset', u.username, req.ip);
    flash(req, 'ok', `Temporary password for ${u.username}: ${temp}  (give it to the student and ask them to change it under My account)`);
    res.redirect('/admin/students/' + u.id);
  } catch (e) { next(e); }
});

// ---------- enrollment actions (fee adjust, manual payment) ----------
router.post('/enrollments/:id/fee', (req, res) => {
  const e = db.prepare('SELECT * FROM enrollments WHERE id=?').get(Number(req.params.id));
  if (!e) return notFound(res, 'Enrollment');
  const fee = parseMoney(req.body.fee);
  if (fee === null) { flash(req, 'warn', 'Enter a valid fee amount (0 for free).'); return res.redirect('/admin/students/' + e.user_id); }
  db.prepare('UPDATE enrollments SET fee_cents=? WHERE id=?').run(fee, e.id);
  audit(req.user.id, 'fee_adjusted', `enrollment ${e.id}: ${e.fee_cents} -> ${fee} cents`, req.ip);
  flash(req, 'ok', 'Fee updated.');
  res.redirect('/admin/students/' + e.user_id);
});

router.post('/enrollments/:id/payment', async (req, res) => {
  const e = db.prepare('SELECT * FROM enrollments WHERE id=?').get(Number(req.params.id));
  if (!e) return notFound(res, 'Enrollment');
  const amount = parseMoney(req.body.amount);
  const method = String(req.body.method || '');
  const ref = String(req.body.reference || '').trim() || 'Recorded by admin';
  if (!amount || !methodNames().includes(method)) { flash(req, 'warn', 'Enter a valid amount and payment method.'); return res.redirect('/admin/students/' + e.user_id); }
  const ins = db.prepare(`INSERT INTO payments (enrollment_id,user_id,amount_cents,method,reference_enc,status,reviewed_by,reviewed_at)
    VALUES (?,?,?,?,?,'confirmed',?,datetime('now'))`).run(e.id, e.user_id, amount, method, encrypt(ref), req.user.id);
  audit(req.user.id, 'payment_recorded', `enrollment ${e.id}: ${amount} cents`, req.ip);
  const mr = await emails.emailReceipt(Number(ins.lastInsertRowid), emails.baseUrl(req));
  flash(req, 'ok', 'Payment recorded and confirmed.' + emails.note(mr, 'Receipt'));
  res.redirect('/admin/students/' + e.user_id);
});

// ---------- payments ----------
router.get('/payments', (req, res) => {
  const status = ['pending', 'confirmed', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const payments = db.prepare(`SELECT p.*, u.username, u.full_name_enc, c.title AS course_title, e.fee_cents,
      (SELECT t.full_name_enc FROM users t WHERE t.id=c.teacher_id) AS tname_enc
    FROM payments p JOIN users u ON u.id=p.user_id JOIN enrollments e ON e.id=p.enrollment_id
    JOIN courses c ON c.id=e.course_id WHERE p.status=? ORDER BY p.id DESC LIMIT 300`).all(status)
    .map(p => ({ ...p, full_name: decrypt(p.full_name_enc), reference: decrypt(p.reference_enc), teacher_name: p.tname_enc ? decrypt(p.tname_enc) : null }));
  res.render('admin/payments', { title: 'Payments', payments, status });
});

function reviewPayment(decision) {
  return async (req, res) => {
    const p = db.prepare("SELECT * FROM payments WHERE id=? AND status='pending'").get(Number(req.params.id));
    if (!p) { flash(req, 'warn', 'That payment is no longer pending.'); return res.redirect('/admin/payments'); }
    db.prepare("UPDATE payments SET status=?, reviewed_by=?, reviewed_at=datetime('now') WHERE id=?").run(decision, req.user.id, p.id);
    audit(req.user.id, 'payment_' + decision, `payment ${p.id} (${p.amount_cents} cents)`, req.ip);
    let extra = '';
    if (decision === 'confirmed') extra = emails.note(await emails.emailReceipt(p.id, emails.baseUrl(req)), 'Receipt');
    flash(req, 'ok', 'Payment ' + decision + '.' + extra);
    res.redirect('/admin/payments');
  };
}
router.post('/payments/:id/confirmed', reviewPayment('confirmed'));
router.post('/payments/:id/rejected', reviewPayment('rejected'));

// ---------- courses & YouTube lessons ----------
function courseFields(body) {
  const fee = parseMoney(body.fee);
  const weeks = parseInt(body.duration_weeks, 10);
  const pass = parseInt(body.pass_mark, 10);
  const title = String(body.title || '').trim();
  const type = ['diploma', 'associate'].includes(body.type) ? body.type : 'certificate';
  if (title.length < 3 || title.length > 120) return { error: 'Enter a course title (3-120 characters).' };
  if (fee === null) return { error: 'Enter a valid fee, e.g. 15 or 15.50.' };
  if (!(weeks >= 1 && weeks <= 104)) return { error: 'Duration must be 1-104 weeks.' };
  if (!(pass >= 0 && pass <= 100)) return { error: 'Pass mark must be 0-100.' };
  return {
    value: [title, type, String(body.summary || '').trim().slice(0, 200), String(body.description || '').trim().slice(0, 4000), fee, weeks, pass, body.active ? 1 : 0]
  };
}

router.get('/courses', (req, res) => {
  const courses = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id) AS lesson_count,
    (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) AS students,
    (SELECT t.full_name_enc FROM users t WHERE t.id=c.teacher_id) AS tname_enc FROM courses c ORDER BY c.type, c.title`).all()
    .map(c => ({ ...c, teacher_name: c.tname_enc ? decrypt(c.tname_enc) : null }));
  res.render('admin/courses', { title: 'Courses', courses, error: null });
});

// ---------- course approvals (courses created by teachers) ----------
router.get('/course-approvals', (req, res) => {
  const courses = db.prepare(`SELECT c.*, (SELECT t.full_name_enc FROM users t WHERE t.id=c.teacher_id) AS tname_enc
    FROM courses c WHERE c.teacher_id IS NOT NULL AND c.approval_status='pending' ORDER BY c.id`).all()
    .map(c => ({ ...c, teacher_name: decrypt(c.tname_enc) }));
  res.render('admin/course_approvals', { title: 'Course approvals', courses });
});

router.post('/courses/:id/approval', (req, res) => {
  const c = db.prepare('SELECT * FROM courses WHERE id=?').get(Number(req.params.id));
  if (!c) return notFound(res, 'Course');
  const back = req.body.back === 'course' ? '/admin/courses/' + c.id : '/admin/course-approvals';   // fixed whitelist, never a user-supplied URL
  const decision = String(req.body.decision || '');
  if (!['approved', 'rejected', 'suspended'].includes(decision)) { flash(req, 'warn', 'Invalid decision.'); return res.redirect(back); }
  const note = String(req.body.note || '').trim().slice(0, 300) || null;
  if (decision !== 'approved' && c.teacher_id && !note) { flash(req, 'warn', 'Please give the teacher a short reason; they will see it.'); return res.redirect(back); }
  db.prepare('UPDATE courses SET approval_status=?, admin_note=? WHERE id=?').run(decision, decision === 'approved' ? null : note, c.id);
  audit(req.user.id, 'course_' + decision, c.title, req.ip);
  flash(req, 'ok', `Course ${decision}.`);
  res.redirect(back);
});

// ---------- teachers ----------
router.get('/teachers', (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'suspended'].includes(req.query.status) ? req.query.status : 'pending';
  const counts = {};
  db.prepare('SELECT status, COUNT(*) n FROM teacher_profiles GROUP BY status').all().forEach(r => { counts[r.status] = r.n; });
  const teachers = db.prepare(`SELECT tp.*, u.username, u.full_name_enc, u.email_enc,
      (SELECT COUNT(*) FROM courses c WHERE c.teacher_id=tp.user_id) AS course_count
    FROM teacher_profiles tp JOIN users u ON u.id=tp.user_id WHERE tp.status=? ORDER BY tp.created_at DESC`).all(status)
    .map(t => ({ ...t, full_name: decrypt(t.full_name_enc), email: decrypt(t.email_enc) }));
  res.render('admin/teachers', { title: 'Teachers', teachers, status, counts });
});

router.get('/teachers/:id', (req, res) => {
  const t = db.prepare(`SELECT tp.*, u.username, u.full_name_enc, u.email_enc, u.phone_enc, u.last_login, u.active FROM teacher_profiles tp
    JOIN users u ON u.id=tp.user_id WHERE tp.user_id=?`).get(Number(req.params.id));
  if (!t) return notFound(res, 'Teacher');
  const teacher = { ...t, full_name: decrypt(t.full_name_enc), email: decrypt(t.email_enc), phone: decrypt(t.phone_enc) };
  const courses = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) AS students,
      (SELECT COALESCE(SUM(p.amount_cents),0) FROM payments p JOIN enrollments e ON e.id=p.enrollment_id WHERE e.course_id=c.id AND p.status='confirmed') AS revenue
    FROM courses c WHERE c.teacher_id=? ORDER BY c.id DESC`).all(t.user_id);
  res.render('admin/teacher', { title: teacher.full_name, t: teacher, courses });
});

router.post('/teachers/:id/decision', (req, res) => {
  const t = db.prepare('SELECT * FROM teacher_profiles WHERE user_id=?').get(Number(req.params.id));
  if (!t) return notFound(res, 'Teacher');
  const decision = String(req.body.decision || '');
  if (!['approved', 'rejected', 'suspended'].includes(decision)) { flash(req, 'warn', 'Invalid decision.'); return res.redirect('/admin/teachers/' + t.user_id); }
  const note = String(req.body.note || '').trim().slice(0, 300) || null;
  if (decision !== 'approved' && !note) { flash(req, 'warn', 'Please write a short reason; the teacher will see it.'); return res.redirect('/admin/teachers/' + t.user_id); }
  db.prepare("UPDATE teacher_profiles SET status=?, admin_note=?, reviewed_by=?, reviewed_at=datetime('now') WHERE user_id=?")
    .run(decision, decision === 'approved' ? null : note, req.user.id, t.user_id);
  audit(req.user.id, 'teacher_' + decision, `teacher ${t.user_id}`, req.ip);
  flash(req, 'ok', `Teacher ${decision}.`);
  res.redirect('/admin/teachers/' + t.user_id);
});

router.post('/teachers/:id/reset-password', async (req, res, next) => {
  try {
    const u = db.prepare("SELECT * FROM users WHERE id=? AND role='teacher'").get(Number(req.params.id));
    if (!u) return notFound(res, 'Teacher');
    const temp = crypto.randomBytes(6).toString('base64url') + '7';
    db.prepare('UPDATE users SET password_hash=?, failed_count=0, locked_until=0 WHERE id=?').run(await bcrypt.hash(temp, 12), u.id);
    audit(req.user.id, 'teacher_password_reset', u.username, req.ip);
    flash(req, 'ok', `Temporary password for ${u.username}: ${temp}  (give it to the teacher and ask them to change it under Account)`);
    res.redirect('/admin/teachers/' + u.id);
  } catch (e) { next(e); }
});

router.post('/courses', (req, res) => {
  const f = courseFields(req.body);
  if (f.error) { flash(req, 'warn', f.error); return res.redirect('/admin/courses'); }
  const info = db.prepare(`INSERT INTO courses (title,type,summary,description,fee_cents,duration_weeks,pass_mark,active)
    VALUES (?,?,?,?,?,?,?,?)`).run(...f.value);
  audit(req.user.id, 'course_created', f.value[0], req.ip);
  flash(req, 'ok', 'Course created. Now add its YouTube lessons below.');
  res.redirect('/admin/courses/' + info.lastInsertRowid);
});

router.get('/courses/:id', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(Number(req.params.id));
  if (!course) return notFound(res, 'Course');
  const lessons = db.prepare('SELECT * FROM lessons WHERE course_id=? ORDER BY position, id').all(course.id);
  const tr = course.teacher_id ? db.prepare('SELECT full_name_enc FROM users WHERE id=?').get(course.teacher_id) : null;
  res.render('admin/course', { title: course.title, course, lessons, teacherName: tr ? decrypt(tr.full_name_enc) : null });
});

router.post('/courses/:id', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(Number(req.params.id));
  if (!course) return notFound(res, 'Course');
  const f = courseFields(req.body);
  if (f.error) { flash(req, 'warn', f.error); return res.redirect('/admin/courses/' + course.id); }
  db.prepare(`UPDATE courses SET title=?,type=?,summary=?,description=?,fee_cents=?,duration_weeks=?,pass_mark=?,active=? WHERE id=?`)
    .run(...f.value, course.id);
  audit(req.user.id, 'course_updated', f.value[0], req.ip);
  flash(req, 'ok', 'Course saved. (Fee changes apply to new enrollments only.)');
  res.redirect('/admin/courses/' + course.id);
});

router.post('/courses/:id/lessons', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(Number(req.params.id));
  if (!course) return notFound(res, 'Course');
  const title = String(req.body.title || '').trim();
  const yt = youtubeId(req.body.youtube);
  if (title.length < 2 || title.length > 150) { flash(req, 'warn', 'Enter a lesson title.'); return res.redirect('/admin/courses/' + course.id); }
  if (!yt) { flash(req, 'warn', 'That does not look like a valid YouTube video link. Paste the full video URL (e.g. https://www.youtube.com/watch?v=...).'); return res.redirect('/admin/courses/' + course.id); }
  const maxPos = db.prepare('SELECT COALESCE(MAX(position),0) m FROM lessons WHERE course_id=?').get(course.id).m;
  const pos = parseInt(req.body.position, 10) > 0 ? parseInt(req.body.position, 10) : maxPos + 1;
  db.prepare('INSERT INTO lessons (course_id,title,youtube_id,position) VALUES (?,?,?,?)').run(course.id, title, yt, pos);
  audit(req.user.id, 'lesson_added', `${course.title}: ${title}`, req.ip);
  flash(req, 'ok', 'Lesson added.');
  res.redirect('/admin/courses/' + course.id);
});

router.post('/lessons/:id/delete', (req, res) => {
  const l = db.prepare('SELECT * FROM lessons WHERE id=?').get(Number(req.params.id));
  if (!l) return notFound(res, 'Lesson');
  db.prepare('DELETE FROM lessons WHERE id=?').run(l.id);
  audit(req.user.id, 'lesson_deleted', l.title, req.ip);
  flash(req, 'ok', 'Lesson removed.');
  res.redirect('/admin/courses/' + l.course_id);
});

// ---------- completion approvals & certificates ----------
router.get('/approvals', (req, res) => {
  const pending = enrollmentRows("e.status='requested'").map(e => {
    const u = db.prepare('SELECT username, full_name_enc FROM users WHERE id=?').get(e.user_id);
    return { ...e, username: u.username, full_name: decrypt(u.full_name_enc) };
  });
  res.render('admin/approvals', { title: 'Approve Completions', pending });
});

router.post('/approvals/:id/approve', async (req, res) => {
  const e = enrollmentRows('e.id=?', [Number(req.params.id)])[0];
  if (!e || e.status !== 'requested') { flash(req, 'warn', 'That request is no longer pending.'); return res.redirect('/admin/approvals'); }
  const score = parseInt(req.body.score, 10);
  if (!(score >= 0 && score <= 100)) { flash(req, 'warn', 'Enter the final exam score (0-100).'); return res.redirect('/admin/approvals'); }
  if (!e.paid_full) { flash(req, 'warn', 'The fee is not fully paid yet.'); return res.redirect('/admin/approvals'); }
  if (!e.eligible) {
    flash(req, 'warn', e.teacher_id ? "The course teacher has not recommended this student for completion." : 'The student has not completed all lessons.');
    return res.redirect('/admin/approvals');
  }
  if (score < e.pass_mark) {
    db.prepare('INSERT INTO exam_results (enrollment_id,score,pass_mark,passed,recorded_by) VALUES (?,?,?,0,?)').run(e.id, score, e.pass_mark, req.user.id);
    flash(req, 'warn', `Score ${score} is below the pass mark (${e.pass_mark}). Result saved; use Reject to send it back to the student.`);
    return res.redirect('/admin/approvals');
  }
  const u = db.prepare('SELECT full_name_enc FROM users WHERE id=?').get(e.user_id);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO exam_results (enrollment_id,score,pass_mark,passed,recorded_by) VALUES (?,?,?,1,?)').run(e.id, score, e.pass_mark, req.user.id);
    const certNo = 'LGOC-' + new Date().getUTCFullYear() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    db.prepare(`INSERT INTO certificates (enrollment_id,cert_no,verify_code,student_name_enc,course_title,course_type,score,issued_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(e.id, certNo, crypto.randomBytes(8).toString('hex'), u.full_name_enc, e.course_title, e.course_type, score, req.user.id);
    db.prepare("UPDATE enrollments SET status='certified' WHERE id=?").run(e.id);
    return certNo;
  });
  const certNo = tx();
  audit(req.user.id, 'certificate_issued', `${certNo} (enrollment ${e.id})`, req.ip);
  const cid = db.prepare('SELECT id FROM certificates WHERE cert_no=?').get(certNo).id;
  const mr = await emails.emailCertificate(cid, emails.baseUrl(req));
  flash(req, 'ok', 'Approved. Certificate ' + certNo + ' has been issued.' + emails.note(mr, 'Certificate PDF'));
  res.redirect('/admin/certificates');
});

router.post('/approvals/:id/reject', (req, res) => {
  const e = db.prepare("SELECT * FROM enrollments WHERE id=? AND status='requested'").get(Number(req.params.id));
  if (!e) { flash(req, 'warn', 'That request is no longer pending.'); return res.redirect('/admin/approvals'); }
  const note = String(req.body.note || '').trim().slice(0, 300) || 'Not approved. Please contact the school office.';
  db.prepare("UPDATE enrollments SET status='enrolled', request_note=? WHERE id=?").run(note, e.id);
  audit(req.user.id, 'certificate_rejected', `enrollment ${e.id}`, req.ip);
  flash(req, 'ok', 'Request sent back to the student.');
  res.redirect('/admin/approvals');
});

router.get('/certificates', (req, res) => {
  const certs = db.prepare('SELECT * FROM certificates ORDER BY id DESC LIMIT 300').all()
    .map(c => ({ ...c, student_name: decrypt(c.student_name_enc) }));
  res.render('admin/certificates', { title: 'Certificates', certs });
});

router.get('/certificates/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM certificates WHERE id=?').get(Number(req.params.id));
  if (!c) return notFound(res, 'Certificate');
  res.render('certificate', { cert: { ...c, student_name: decrypt(c.student_name_enc) }, baseUrl: req.protocol + '://' + req.get('host') });
});

router.post('/certificates/:id/email', async (req, res) => {
  const r = await emails.emailCertificate(Number(req.params.id), emails.baseUrl(req));
  audit(req.user.id, 'certificate_emailed', 'certificate ' + req.params.id, req.ip);
  flash(req, r.ok ? 'ok' : 'warn', r.ok ? 'Certificate emailed to the student.' : 'Not sent: ' + r.error);
  res.redirect('/admin/certificates');
});

router.post('/certificates/:id/toggle', (req, res) => {
  const c = db.prepare('SELECT * FROM certificates WHERE id=?').get(Number(req.params.id));
  if (!c) return notFound(res, 'Certificate');
  const next = c.status === 'valid' ? 'revoked' : 'valid';
  db.prepare('UPDATE certificates SET status=? WHERE id=?').run(next, c.id);
  audit(req.user.id, 'certificate_' + next, c.cert_no, req.ip);
  flash(req, 'ok', `Certificate ${c.cert_no} is now ${next}.`);
  res.redirect('/admin/certificates');
});

// ---------- email: test, log, resend ----------
router.post('/email/test', async (req, res) => {
  const to = String(req.body.to || '').trim();
  if (!mailer.validEmail(to)) { flash(req, 'warn', 'Enter a valid email address to send the test to.'); return res.redirect('/admin/settings'); }
  const r = await mailer.send({ to, toName: 'Test', subject: 'Test email from Liberia Gateway Online College', text: 'This is a test. Your email settings work.', html: '<p>This is a test. Your email settings work.</p>' });
  audit(req.user.id, 'email_test', r.ok ? 'ok' : r.error, req.ip);
  flash(req, r.ok ? 'ok' : 'warn', r.ok ? 'Test email sent. Check the inbox (and spam folder).' : r.error);
  res.redirect('/admin/settings');
});
router.get('/emails', (req, res) => {
  const log = db.prepare('SELECT l.*, u.username FROM email_log l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 200').all();
  res.render('admin/emails', { title: 'Emails', log, mail: mailer.status() });
});
router.post('/emails/:id/resend', async (req, res) => {
  const l = db.prepare('SELECT * FROM email_log WHERE id=?').get(Number(req.params.id));
  if (!l || !['receipt', 'certificate'].includes(l.kind)) { flash(req, 'warn', 'That email cannot be resent.'); return res.redirect('/admin/emails'); }
  const r = l.kind === 'receipt' ? await emails.emailReceipt(l.ref_id, emails.baseUrl(req)) : await emails.emailCertificate(l.ref_id, emails.baseUrl(req));
  audit(req.user.id, 'email_resent', l.kind + ' ' + l.ref_id, req.ip);
  flash(req, r.ok ? 'ok' : 'warn', r.ok ? 'Email sent again.' : 'Not sent: ' + r.error);
  res.redirect('/admin/emails');
});

// ---------- announcements ----------
router.get('/announcements', (req, res) => {
  res.render('admin/announcements', { title: 'Announcements', items: db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 50').all() });
});
router.post('/announcements', (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120), body = String(req.body.body || '').trim().slice(0, 1000);
  if (title.length < 3) { flash(req, 'warn', 'Enter a title (at least 3 characters).'); return res.redirect('/admin/announcements'); }
  db.prepare('INSERT INTO announcements (title,body) VALUES (?,?)').run(title, body);
  audit(req.user.id, 'announcement_added', title, req.ip);
  flash(req, 'ok', 'Announcement published on the homepage and student portal.');
  res.redirect('/admin/announcements');
});
router.post('/announcements/:id/delete', (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id=?').run(Number(req.params.id));
  audit(req.user.id, 'announcement_deleted', 'id ' + req.params.id, req.ip);
  res.redirect('/admin/announcements');
});

// ---------- settings & backups ----------
router.get('/settings', (req, res) => {
  res.render('admin/settings', {
    title: 'Settings & Backups', instructions: getSetting('payment_instructions'), methodsText: methodsText(), mail: mailer.status(), site: require('../lib/site').info(), backups: listBackups(),
    maxFee: (parseInt(getSetting('teacher_max_fee_cents', '5000'), 10) / 100).toFixed(2)
  });
});

router.post('/settings', (req, res) => {
  const b = req.body, has = (k) => typeof b[k] === 'string';
  const txt = (k, max) => setSetting(k, String(b[k]).trim().slice(0, max));
  if (has('instructions')) txt('payment_instructions', 2000);
  if (has('methods')) saveMethods(b.methods);
  if (has('max_fee')) { const mf = parseMoney(b.max_fee); if (mf && mf > 0) setSetting('teacher_max_fee_cents', String(mf)); }
  if (has('college_contact')) txt('college_contact', 600);
  if (has('admission_requirements')) txt('admission_requirements', 1500);
  if (has('accreditation_statement')) txt('accreditation_statement', 1200);
  if (has('email_provider')) mailer.save(b);
  audit(req.user.id, 'settings_updated', Object.keys(b).filter(k => k !== '_csrf').join(','), req.ip);
  flash(req, 'ok', 'Settings saved.');
  res.redirect('/admin/settings');
});

router.post('/backup', async (req, res, next) => {
  try {
    await runBackup();
    audit(req.user.id, 'backup_created', null, req.ip);
    flash(req, 'ok', 'Backup created.');
    res.redirect('/admin/settings');
  } catch (e) { next(e); }
});

module.exports = router;
