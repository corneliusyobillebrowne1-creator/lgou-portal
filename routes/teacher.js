const router = require('express').Router();
const { db, audit, getSetting } = require('../lib/db');
const { requireTeacherAny, requireTeacher } = require('../lib/auth');
const { parseMoney, classroomUrl, parseScore, validDate, COUNTIES } = require('../lib/util');
const { enrollmentRows } = require('../lib/queries');
const { roster, studentStats, statFor } = require('../lib/teaching');

router.use(requireTeacherAny);

// ---------- status page / dashboard (a teacher awaiting approval only ever sees the status page) ----------
router.get('/', (req, res) => {
  const tp = req.teacher;
  if (!tp || tp.status !== 'approved') return res.render('teacher/status', { title: 'Application status', tp });
  const courses = db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) AS enrolled,
      (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id AND
        (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.enrollment_id=e.id AND p.status='confirmed') >= e.fee_cents) AS active_students
    FROM courses c WHERE c.teacher_id=? ORDER BY c.id DESC`).all(req.user.id);
  const totals = {
    courses: courses.length,
    pending: courses.filter(c => c.approval_status === 'pending').length,
    students: courses.reduce((s, c) => s + c.active_students, 0),
    awaiting: courses.reduce((s, c) => s + (c.enrolled - c.active_students), 0)
  };
  res.render('teacher/dashboard', { title: 'Teacher dashboard', courses, totals });
});

// Everything below needs an APPROVED teacher.
router.use(requireTeacher);

const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const maxFee = () => parseInt(getSetting('teacher_max_fee_cents', '5000'), 10) || 5000;

// Loads a course only if it belongs to the logged-in teacher - this is what stops one teacher opening another's class.
function myCourse(req, res) {
  const c = db.prepare('SELECT * FROM courses WHERE id=? AND teacher_id=?').get(Number(req.params.id), req.user.id);
  if (!c) { res.status(404).render('error', { title: 'Not found', message: 'Course not found.' }); return null; }
  return c;
}

// ---------- profile ----------
router.get('/profile', (req, res) => {
  res.render('teacher/profile', { title: 'My public profile', p: req.teacher, counties: COUNTIES, error: null });
});

router.post('/profile', (req, res) => {
  const b = req.body;
  const p = {
    headline: String(b.headline || '').trim(), subjects: String(b.subjects || '').trim(), bio: String(b.bio || '').trim(),
    qualifications: String(b.qualifications || '').trim(), county: String(b.county || ''), experience_years: parseInt(b.experience_years, 10)
  };
  const fail = (error) => res.status(400).render('teacher/profile', { title: 'My public profile', p: { ...req.teacher, ...p }, counties: COUNTIES, error });
  if (p.headline.length < 5 || p.headline.length > 100) return fail('Headline must be 5-100 characters.');
  if (p.subjects.length < 3 || p.subjects.length > 150) return fail('List your subjects (3-150 characters).');
  if (p.bio.length < 30 || p.bio.length > 1200) return fail('Bio must be 30-1200 characters.');
  if (p.qualifications.length < 10 || p.qualifications.length > 800) return fail('Qualifications must be 10-800 characters.');
  if (!COUNTIES.includes(p.county)) return fail('Choose a county.');
  if (!(p.experience_years >= 0 && p.experience_years <= 60)) return fail('Years of experience must be 0-60.');
  db.prepare('UPDATE teacher_profiles SET headline=?,subjects=?,bio=?,qualifications=?,county=?,experience_years=? WHERE user_id=?')
    .run(p.headline, p.subjects, p.bio, p.qualifications, p.county, p.experience_years, req.user.id);
  audit(req.user.id, 'teacher_profile_updated', null, req.ip);
  flash(req, 'ok', 'Profile saved.');
  res.redirect('/teacher/profile');
});

// ---------- courses ----------
function courseFields(body) {
  const title = String(body.title || '').trim();
  const type = body.type === 'diploma' ? 'diploma' : 'certificate';
  const fee = parseMoney(body.fee);
  const weeks = parseInt(body.duration_weeks, 10);
  const pass = parseInt(body.pass_mark, 10);
  const link = classroomUrl(body.classroom_url);
  if (title.length < 3 || title.length > 120) return { error: 'Enter a course title (3-120 characters).' };
  if (fee === null) return { error: 'Enter a valid fee, e.g. 15 or 15.50.' };
  if (fee > maxFee()) return { error: `The maximum fee for a teacher course is $${(maxFee() / 100).toFixed(2)}. Courses here are meant to be affordable.` };
  if (!(weeks >= 1 && weeks <= 104)) return { error: 'Duration must be 1-104 weeks.' };
  if (!(pass >= 0 && pass <= 100)) return { error: 'Pass mark must be 0-100.' };
  if (!link) return { error: 'Paste your Google Classroom link. It must be a https://classroom.google.com/... address (the class invite link).' };
  return {
    value: {
      title, type, summary: String(body.summary || '').trim().slice(0, 200), description: String(body.description || '').trim().slice(0, 4000),
      fee, weeks, pass, link, active: body.active ? 1 : 0
    }
  };
}

router.get('/courses', (req, res) => {
  const courses = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) AS enrolled
    FROM courses c WHERE c.teacher_id=? ORDER BY c.id DESC`).all(req.user.id);
  res.render('teacher/courses', { title: 'My courses', courses, maxFee: maxFee() });
});

router.post('/courses', (req, res) => {
  const f = courseFields(req.body);
  if (f.error) { flash(req, 'warn', f.error); return res.redirect('/teacher/courses'); }
  const v = f.value;
  const info = db.prepare(`INSERT INTO courses (title,type,summary,description,fee_cents,duration_weeks,pass_mark,active,teacher_id,approval_status,classroom_url)
    VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`).run(v.title, v.type, v.summary, v.description, v.fee, v.weeks, v.pass, v.active, req.user.id, v.link);
  audit(req.user.id, 'teacher_course_created', v.title, req.ip);
  flash(req, 'ok', 'Course submitted. It will appear on the website once the admin team approves it.');
  res.redirect('/teacher/courses/' + info.lastInsertRowid);
});

router.get('/courses/:id', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  res.render('teacher/course', { title: course.title, course, tab: 'details', maxFee: maxFee() });
});

router.post('/courses/:id', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const f = courseFields(req.body);
  if (f.error) { flash(req, 'warn', f.error); return res.redirect('/teacher/courses/' + course.id); }
  const v = f.value;
  db.prepare(`UPDATE courses SET title=?,type=?,summary=?,description=?,fee_cents=?,duration_weeks=?,pass_mark=?,active=?,classroom_url=? WHERE id=? AND teacher_id=?`)
    .run(v.title, v.type, v.summary, v.description, v.fee, v.weeks, v.pass, v.active, v.link, course.id, req.user.id);
  audit(req.user.id, 'teacher_course_updated', `${v.title} (fee ${v.fee} cents)`, req.ip);
  flash(req, 'ok', 'Course saved. (Fee changes apply to new enrolments only.)');
  res.redirect('/teacher/courses/' + course.id);
});

router.post('/courses/:id/resubmit', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  if (course.approval_status !== 'rejected') { flash(req, 'warn', 'Only rejected courses can be resubmitted.'); return res.redirect('/teacher/courses/' + course.id); }
  db.prepare("UPDATE courses SET approval_status='pending', admin_note=NULL WHERE id=?").run(course.id);
  audit(req.user.id, 'teacher_course_resubmitted', course.title, req.ip);
  flash(req, 'ok', 'Course resubmitted for approval.');
  res.redirect('/teacher/courses/' + course.id);
});

// ---------- students, lists (groups), progress, completion ----------
router.get('/courses/:id/students', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const rows = roster(course.id);
  const stats = studentStats(course.id);
  const groups = db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id) AS n
    FROM course_groups g WHERE g.course_id=? ORDER BY g.name`).all(course.id);
  const mem = db.prepare(`SELECT m.enrollment_id, g.name FROM group_members m JOIN course_groups g ON g.id=m.group_id WHERE g.course_id=?`).all(course.id);
  const lists = new Map();
  mem.forEach(m => { if (!lists.has(m.enrollment_id)) lists.set(m.enrollment_id, []); lists.get(m.enrollment_id).push(m.name); });
  const students = rows.map(r => ({ ...r, stats: statFor(stats, r.id), lists: lists.get(r.id) || [] }));
  res.render('teacher/students', { title: 'Students - ' + course.title, course, tab: 'students', students, groups });
});

router.post('/courses/:id/groups', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const name = String(req.body.name || '').trim();
  if (name.length < 2 || name.length > 40) { flash(req, 'warn', 'List name must be 2-40 characters.'); return res.redirect(`/teacher/courses/${course.id}/students`); }
  try {
    const info = db.prepare('INSERT INTO course_groups (course_id,name) VALUES (?,?)').run(course.id, name);
    audit(req.user.id, 'group_created', `${course.title}: ${name}`, req.ip);
    flash(req, 'ok', 'List created. Now choose its students.');
    return res.redirect(`/teacher/courses/${course.id}/groups/${info.lastInsertRowid}`);
  } catch (e) {
    flash(req, 'warn', 'You already have a list with that name.');
    res.redirect(`/teacher/courses/${course.id}/students`);
  }
});

function myGroup(req, res, course) {
  const g = db.prepare('SELECT * FROM course_groups WHERE id=? AND course_id=?').get(Number(req.params.gid), course.id);
  if (!g) { res.status(404).render('error', { title: 'Not found', message: 'List not found.' }); return null; }
  return g;
}

router.get('/courses/:id/groups/:gid', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const group = myGroup(req, res, course); if (!group) return;
  const members = new Set(db.prepare('SELECT enrollment_id FROM group_members WHERE group_id=?').all(group.id).map(r => r.enrollment_id));
  const students = roster(course.id).filter(r => r.paid_full);
  res.render('teacher/group', { title: group.name, course, tab: 'students', group, students, members });
});

router.post('/courses/:id/groups/:gid', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const group = myGroup(req, res, course); if (!group) return;
  const valid = new Set(roster(course.id).filter(r => r.paid_full).map(r => r.id));   // only this course's paying students
  let chosen = req.body.enr || [];
  if (!Array.isArray(chosen)) chosen = [chosen];
  chosen = [...new Set(chosen.map(Number))].filter(id => valid.has(id));
  db.transaction(() => {
    db.prepare('DELETE FROM group_members WHERE group_id=?').run(group.id);
    const ins = db.prepare('INSERT INTO group_members (group_id,enrollment_id) VALUES (?,?)');
    chosen.forEach(id => ins.run(group.id, id));
  })();
  audit(req.user.id, 'group_updated', `${course.title}: ${group.name} (${chosen.length})`, req.ip);
  flash(req, 'ok', `List saved with ${chosen.length} student(s).`);
  res.redirect(`/teacher/courses/${course.id}/students`);
});

router.post('/courses/:id/groups/:gid/delete', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const group = myGroup(req, res, course); if (!group) return;
  db.prepare('DELETE FROM course_groups WHERE id=?').run(group.id);
  flash(req, 'ok', 'List deleted.');
  res.redirect(`/teacher/courses/${course.id}/students`);
});

// Teacher recommends a student for the certificate; the admin team still gives the final approval.
router.post('/courses/:id/recommend/:eid', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const e = enrollmentRows('e.id=? AND e.course_id=?', [Number(req.params.eid), course.id])[0];
  const back = `/teacher/courses/${course.id}/students`;
  if (!e) { flash(req, 'warn', 'Student not found in this course.'); return res.redirect(back); }
  if (e.status !== 'enrolled') { flash(req, 'warn', 'This student has already requested or received a certificate.'); return res.redirect(back); }
  if (req.body.action === 'withdraw') {
    db.prepare('UPDATE enrollments SET completion_recommended=0, recommended_score=NULL WHERE id=?').run(e.id);
    audit(req.user.id, 'completion_withdrawn', `enrollment ${e.id}`, req.ip);
    flash(req, 'ok', 'Recommendation withdrawn.');
    return res.redirect(back);
  }
  const score = parseInt(req.body.score, 10);
  if (!e.paid_full) { flash(req, 'warn', 'The student has not fully paid the fee.'); return res.redirect(back); }
  if (!(score >= 0 && score <= 100)) { flash(req, 'warn', 'Enter a final score from 0 to 100.'); return res.redirect(back); }
  db.prepare('UPDATE enrollments SET completion_recommended=1, recommended_score=? WHERE id=?').run(score, e.id);
  audit(req.user.id, 'completion_recommended', `enrollment ${e.id} score ${score}`, req.ip);
  flash(req, 'ok', 'Recommended. The student can now request the certificate, and the admin team will approve it.');
  res.redirect(back);
});

// ---------- attendance ----------
const ATT = ['present', 'late', 'absent', 'excused'];

// ---------- class times (students see these in their portal) ----------
const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
router.get('/courses/:id/schedule', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const sessions = db.prepare('SELECT * FROM class_sessions WHERE course_id=? ORDER BY starts_on DESC, start_time DESC LIMIT 100').all(course.id);
  res.render('teacher/schedule', { title: 'Class times - ' + course.title, course, tab: 'schedule', sessions, today: new Date().toISOString().slice(0, 10) });
});
router.post('/courses/:id/schedule/weekly', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  db.prepare('UPDATE courses SET class_schedule=? WHERE id=? AND teacher_id=?').run(String(req.body.class_schedule || '').trim().slice(0, 300) || null, course.id, req.user.id);
  audit(req.user.id, 'class_schedule_updated', course.title, req.ip);
  flash(req, 'ok', 'Weekly class times saved. Students can see them in their portal.');
  res.redirect(`/teacher/courses/${course.id}/schedule`);
});
router.post('/courses/:id/schedule', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const date = String(req.body.starts_on || ''), start = String(req.body.start_time || ''), end = String(req.body.end_time || '');
  const topic = String(req.body.topic || '').trim().slice(0, 120);
  if (!validDate(date) || !validTime(start) || (end && !validTime(end))) { flash(req, 'warn', 'Enter a valid date and start time (end time is optional).'); return res.redirect(`/teacher/courses/${course.id}/schedule`); }
  db.prepare('INSERT INTO class_sessions (course_id,starts_on,start_time,end_time,topic) VALUES (?,?,?,?,?)').run(course.id, date, start, end || null, topic);
  audit(req.user.id, 'class_session_added', `${course.title} ${date} ${start}`, req.ip);
  flash(req, 'ok', 'Class added to the timetable.');
  res.redirect(`/teacher/courses/${course.id}/schedule`);
});
router.post('/courses/:id/schedule/:sid/delete', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  db.prepare('DELETE FROM class_sessions WHERE id=? AND course_id=?').run(Number(req.params.sid), course.id);
  res.redirect(`/teacher/courses/${course.id}/schedule`);
});

router.get('/courses/:id/attendance', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const sessions = db.prepare(`SELECT s.*,
      (SELECT COUNT(*) FROM attendance_records r WHERE r.session_id=s.id AND r.status IN ('present','late')) AS here,
      (SELECT COUNT(*) FROM attendance_records r WHERE r.session_id=s.id) AS marked
    FROM attendance_sessions s WHERE s.course_id=? ORDER BY s.session_date DESC, s.id DESC`).all(course.id);
  res.render('teacher/attendance', { title: 'Attendance - ' + course.title, course, tab: 'attendance', sessions, today: new Date().toISOString().slice(0, 10) });
});

router.post('/courses/:id/attendance', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const date = String(req.body.session_date || ''); const topic = String(req.body.topic || '').trim().slice(0, 120);
  if (!validDate(date)) { flash(req, 'warn', 'Enter a valid date.'); return res.redirect(`/teacher/courses/${course.id}/attendance`); }
  const info = db.prepare('INSERT INTO attendance_sessions (course_id,session_date,topic) VALUES (?,?,?)').run(course.id, date, topic);
  audit(req.user.id, 'attendance_session_created', `${course.title} ${date}`, req.ip);
  res.redirect(`/teacher/courses/${course.id}/attendance/${info.lastInsertRowid}`);
});

function mySession(req, res, course) {
  const s = db.prepare('SELECT * FROM attendance_sessions WHERE id=? AND course_id=?').get(Number(req.params.sid), course.id);
  if (!s) { res.status(404).render('error', { title: 'Not found', message: 'Class session not found.' }); return null; }
  return s;
}

router.get('/courses/:id/attendance/:sid', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const session = mySession(req, res, course); if (!session) return;
  const groups = db.prepare('SELECT * FROM course_groups WHERE course_id=? ORDER BY name').all(course.id);
  const gid = groups.find(g => g.id === Number(req.query.group)) ? Number(req.query.group) : null;
  let students = roster(course.id).filter(r => r.paid_full);
  if (gid) {
    const ids = new Set(db.prepare('SELECT enrollment_id FROM group_members WHERE group_id=?').all(gid).map(r => r.enrollment_id));
    students = students.filter(r => ids.has(r.id));
  }
  const marks = new Map(db.prepare('SELECT enrollment_id, status FROM attendance_records WHERE session_id=?').all(session.id).map(r => [r.enrollment_id, r.status]));
  res.render('teacher/attendance_sheet', { title: 'Mark attendance', course, tab: 'attendance', session, students, marks, groups, gid });
});

router.post('/courses/:id/attendance/:sid', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const session = mySession(req, res, course); if (!session) return;
  const valid = new Set(roster(course.id).filter(r => r.paid_full).map(r => r.id));
  const up = db.prepare(`INSERT INTO attendance_records (session_id,enrollment_id,status) VALUES (?,?,?)
    ON CONFLICT(session_id,enrollment_id) DO UPDATE SET status=excluded.status`);
  let n = 0;
  db.transaction(() => {
    valid.forEach(id => { const st = req.body['st_' + id]; if (ATT.includes(st)) { up.run(session.id, id, st); n++; } });
  })();
  audit(req.user.id, 'attendance_marked', `${course.title} ${session.session_date} (${n})`, req.ip);
  flash(req, 'ok', `Attendance saved for ${n} student(s).`);
  res.redirect(`/teacher/courses/${course.id}/attendance`);
});

router.post('/courses/:id/attendance/:sid/delete', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const session = mySession(req, res, course); if (!session) return;
  db.prepare('DELETE FROM attendance_sessions WHERE id=?').run(session.id);
  flash(req, 'ok', 'Class session deleted.');
  res.redirect(`/teacher/courses/${course.id}/attendance`);
});

// ---------- grades ----------
const CATS = ['quiz', 'assignment', 'exam', 'participation'];

router.get('/courses/:id/grades', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const items = db.prepare('SELECT * FROM grade_items WHERE course_id=? ORDER BY id').all(course.id);
  const students = roster(course.id).filter(r => r.paid_full);
  const stats = studentStats(course.id);
  const scores = new Map(db.prepare(`SELECT g.item_id, g.enrollment_id, g.score FROM grades g JOIN grade_items i ON i.id=g.item_id WHERE i.course_id=?`).all(course.id)
    .map(g => [g.item_id + '_' + g.enrollment_id, g.score]));
  res.render('teacher/grades', { title: 'Grades - ' + course.title, course, tab: 'grades', items, students: students.map(s => ({ ...s, stats: statFor(stats, s.id) })), scores });
});

router.post('/courses/:id/grade-items', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const title = String(req.body.title || '').trim(); const max = parseScore(req.body.max_score);
  const category = CATS.includes(req.body.category) ? req.body.category : 'assignment';
  const back = `/teacher/courses/${course.id}/grades`;
  if (title.length < 2 || title.length > 100) { flash(req, 'warn', 'Enter a title for the quiz or assignment.'); return res.redirect(back); }
  if (!max || Number.isNaN(max) || max <= 0 || max > 1000) { flash(req, 'warn', 'Enter the maximum score (more than 0).'); return res.redirect(back); }
  db.prepare('INSERT INTO grade_items (course_id,title,category,max_score) VALUES (?,?,?,?)').run(course.id, title, category, max);
  audit(req.user.id, 'grade_item_created', `${course.title}: ${title}`, req.ip);
  flash(req, 'ok', 'Added. Enter each student\'s mark below.');
  res.redirect(back);
});

router.post('/courses/:id/grade-items/:iid/delete', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  db.prepare('DELETE FROM grade_items WHERE id=? AND course_id=?').run(Number(req.params.iid), course.id);
  flash(req, 'ok', 'Removed (its marks were deleted too).');
  res.redirect(`/teacher/courses/${course.id}/grades`);
});

router.post('/courses/:id/grades', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const back = `/teacher/courses/${course.id}/grades`;
  const items = db.prepare('SELECT * FROM grade_items WHERE course_id=?').all(course.id);
  const students = roster(course.id).filter(r => r.paid_full);
  const up = db.prepare(`INSERT INTO grades (item_id,enrollment_id,score) VALUES (?,?,?)
    ON CONFLICT(item_id,enrollment_id) DO UPDATE SET score=excluded.score, graded_at=CURRENT_TIMESTAMP`);
  const del = db.prepare('DELETE FROM grades WHERE item_id=? AND enrollment_id=?');
  const writes = []; let bad = null;
  for (const it of items) for (const s of students) {
    const raw = req.body[`s_${it.id}_${s.id}`];
    if (raw === undefined) continue;
    const v = parseScore(raw);
    if (Number.isNaN(v) || (v !== null && v > it.max_score)) { bad = `Invalid mark for ${s.student_name} in "${it.title}" (must be 0 to ${it.max_score}).`; break; }
    writes.push([it.id, s.id, v]);
  }
  if (bad) { flash(req, 'warn', bad + ' Nothing was saved.'); return res.redirect(back); }
  db.transaction(() => writes.forEach(([i, e, v]) => (v === null ? del.run(i, e) : up.run(i, e, v))))();
  audit(req.user.id, 'grades_saved', `${course.title} (${writes.length} entries)`, req.ip);
  flash(req, 'ok', 'Grades saved.');
  res.redirect(back);
});

module.exports = router;
