// Teacher side: answer student questions and read anonymous feedback for their own courses.
const router = require('express').Router();
const { db } = require('../lib/db');
const { requireTeacher } = require('../lib/auth');
router.use(requireTeacher);
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };

function myCourse(req, res) {
  const c = db.prepare('SELECT * FROM courses WHERE id=? AND teacher_id=?').get(Number(req.params.id), req.user.id);
  if (!c) { res.status(404).render('error', { title: 'Not found', message: 'Course not found.' }); return null; }
  return c;
}
router.get('/courses/:id/questions', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const open = db.prepare('SELECT * FROM questions WHERE course_id=? AND answer IS NULL ORDER BY id').all(course.id);
  const done = db.prepare('SELECT * FROM questions WHERE course_id=? AND answer IS NOT NULL ORDER BY answered_at DESC LIMIT 30').all(course.id);
  const reviews = db.prepare('SELECT rating,comment,created_at FROM reviews WHERE course_id=? ORDER BY id DESC LIMIT 30').all(course.id);
  const avg = db.prepare('SELECT ROUND(AVG(rating),1) a, COUNT(*) n FROM reviews WHERE course_id=?').get(course.id);
  res.render('teacher/questions', { title: 'Questions & feedback', course, tab: 'questions', open, done, reviews, avg });
});
router.post('/courses/:id/questions/:qid', (req, res) => {
  const course = myCourse(req, res); if (!course) return;
  const answer = String(req.body.answer || '').trim();
  if (answer.length < 2 || answer.length > 1500) { flash(req, 'warn', 'Write an answer (up to 1500 characters).'); return res.redirect('/teacher/courses/' + course.id + '/questions'); }
  const r = db.prepare("UPDATE questions SET answer=?, answered_by=?, answered_at=datetime('now') WHERE id=? AND course_id=? AND answer IS NULL").run(answer, req.user.id, Number(req.params.qid), course.id);
  flash(req, r.changes ? 'ok' : 'warn', r.changes ? 'Answer sent.' : 'That question was already answered.');
  res.redirect('/teacher/courses/' + course.id + '/questions');
});
module.exports = router;
