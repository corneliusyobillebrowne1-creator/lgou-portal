// Student side of: course questions, course ratings, invite links.
const router = require('express').Router();
const { db } = require('../lib/db');
const { requireStudent } = require('../lib/auth');
const { enrollmentRows } = require('../lib/queries');
router.use(requireStudent);

const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
function myPaidEnrollment(req, res) {
  const e = enrollmentRows('e.id=? AND e.user_id=?', [Number(req.params.id), req.user.id])[0];
  if (!e) { res.status(404).render('error', { title: 'Not found', message: 'Enrollment not found.' }); return null; }
  if (!e.paid_full) { flash(req, 'warn', 'This opens once your fee is fully paid.'); res.redirect('/portal/pay/' + e.id); return null; }
  return e;
}

router.get('/qa/:id', (req, res) => {
  const e = myPaidEnrollment(req, res); if (!e) return;
  const mine = db.prepare('SELECT * FROM questions WHERE course_id=? AND user_id=? ORDER BY id DESC').all(e.course_id, req.user.id);
  const others = db.prepare('SELECT body,answer,answered_at FROM questions WHERE course_id=? AND user_id<>? AND answer IS NOT NULL ORDER BY id DESC LIMIT 20').all(e.course_id, req.user.id);
  const review = db.prepare('SELECT * FROM reviews WHERE enrollment_id=?').get(e.id);
  res.render('student/qa', { title: 'Questions & feedback', e, mine, others, review });
});

router.post('/qa/:id', (req, res) => {
  const e = myPaidEnrollment(req, res); if (!e) return;
  const body = String(req.body.body || '').trim();
  if (body.length < 5 || body.length > 600) { flash(req, 'warn', 'Write your question (5 to 600 characters).'); return res.redirect('/portal/qa/' + e.id); }
  const open = db.prepare('SELECT COUNT(*) n FROM questions WHERE course_id=? AND user_id=? AND answer IS NULL').get(e.course_id, req.user.id).n;
  if (open >= 5) { flash(req, 'warn', 'You already have 5 questions waiting for an answer. Please wait for a reply first.'); return res.redirect('/portal/qa/' + e.id); }
  const qi = db.prepare('INSERT INTO questions (course_id,user_id,body) VALUES (?,?,?)').run(e.course_id, req.user.id, body);
  require('../lib/n8n').events.questionAsked(e.course_id, Number(qi.lastInsertRowid));
  flash(req, 'ok', 'Question sent. Your teacher or the college will answer here.');
  res.redirect('/portal/qa/' + e.id);
});

router.post('/review/:id', (req, res) => {
  const e = myPaidEnrollment(req, res); if (!e) return;
  const rating = parseInt(req.body.rating, 10);
  const comment = String(req.body.comment || '').trim().slice(0, 500);
  if (!(rating >= 1 && rating <= 5)) { flash(req, 'warn', 'Choose a rating from 1 to 5.'); return res.redirect('/portal/qa/' + e.id); }
  db.prepare(`INSERT INTO reviews (enrollment_id,course_id,user_id,rating,comment) VALUES (?,?,?,?,?)
    ON CONFLICT(enrollment_id) DO UPDATE SET rating=excluded.rating, comment=excluded.comment, created_at=datetime('now')`).run(e.id, e.course_id, req.user.id, rating, comment);
  flash(req, 'ok', 'Thank you for your feedback. It helps us improve the course.');
  res.redirect('/portal/qa/' + e.id);
});

module.exports = router;
