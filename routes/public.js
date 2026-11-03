const router = require('express').Router();
const { db } = require('../lib/db');
const { decrypt } = require('../lib/crypto');
const { publicCourses, publicTeachers } = require('../lib/queries');
const site = require('../lib/site');
const { getMethods } = require('../lib/payments');

router.get('/', (req, res) => {
  const courses = publicCourses();
  const fees = courses.map(c => c.fee_cents);
  res.render('home', {
    title: 'Home',
    news: site.announcements(3),
    associates: courses.filter(c => c.type === 'associate'),
    certificates: courses.filter(c => c.type === 'certificate'),
    diplomas: courses.filter(c => c.type === 'diploma'),
    teachers: publicTeachers(6),
    feeRange: fees.length ? { min: Math.min(...fees), max: Math.max(...fees) } : null
  });
});

router.get('/admissions', (req, res) => {
  res.render('admissions', { title: 'Admissions', methods: getMethods().map(m => m.name), associates: publicCourses("c.type='associate'") });
});

router.get('/about', (req, res) => {
  const courses = publicCourses();
  res.render('about', { title: 'About the college', counts: {
    associate: courses.filter(c => c.type === 'associate').length, diploma: courses.filter(c => c.type === 'diploma').length,
    certificate: courses.filter(c => c.type === 'certificate').length, teachers: publicTeachers(1000).length } });
});

router.get('/courses/:id', (req, res) => {
  const course = publicCourses('c.id=?', [Number(req.params.id)])[0];
  if (!course) return res.status(404).render('error', { title: 'Not found', message: 'Course not found.' });
  const lessons = db.prepare('SELECT title FROM lessons WHERE course_id=? ORDER BY position, id').all(course.id);
  res.render('course', { title: course.title, course, lessons });
});

router.get('/teachers', (req, res) => {
  res.render('teachers', { title: 'Our teachers', teachers: publicTeachers(200) });
});

router.get('/teachers/:id', (req, res) => {
  const t = publicTeachers(1000).find(x => x.user_id === Number(req.params.id));
  if (!t) return res.status(404).render('error', { title: 'Not found', message: 'Teacher not found.' });
  res.render('teacher_public', { title: t.full_name, t, courses: publicCourses('c.teacher_id=?', [t.user_id]) });
});

// Certificate verification - looked up by the long random verification code printed on the certificate.
router.get('/verify', (req, res) => {
  const code = String(req.query.code || '').trim().toLowerCase();
  let result = null;
  if (code) {
    const c = db.prepare('SELECT * FROM certificates WHERE verify_code=?').get(code);
    result = c ? { found: true, cert: { ...c, student_name: decrypt(c.student_name_enc) } } : { found: false };
  }
  res.render('verify', { title: 'Verify a Certificate', code, result });
});

module.exports = router;
