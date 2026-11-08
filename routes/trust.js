// Public "Trust & quality" page and the complaints form.
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { db, audit, getSetting } = require('../lib/db');
const { encrypt } = require('../lib/crypto');
const site = require('../lib/site');
const { publicTeachers } = require('../lib/queries');

const DEFAULT_REFUND = 'Please ask the college office about fees and refunds before you pay. Every payment is checked by the college, and you receive an email receipt when it is confirmed.';
const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).render('error', { title: 'Too many messages', message: 'Too many messages from this device. Please try again later, or call the college office.' }) });
const one = (sql) => db.prepare(sql).get().n;

router.get('/trust', (req, res) => {
  const stats = getSetting('show_stats') === 'yes' ? {
    students: one("SELECT COUNT(*) n FROM users WHERE role='student' AND active=1"),
    certs: one("SELECT COUNT(*) n FROM certificates WHERE status='valid'"),
    teachers: publicTeachers(1000).length,
    courses: one("SELECT COUNT(*) n FROM courses WHERE active=1 AND approval_status='approved'")
  } : null;
  res.render('trust', { title: 'Trust & quality', accreditation: site.info().accreditation, refund: getSetting('refund_policy') || DEFAULT_REFUND,
    teachers: publicTeachers(12), stories: db.prepare('SELECT * FROM stories WHERE active=1 ORDER BY id DESC LIMIT 6').all(), stats, form: {} });
});

router.post('/trust/complaint', limiter, (req, res) => {
  const f = { name: String(req.body.name || '').trim(), contact: String(req.body.contact || '').trim(), message: String(req.body.message || '').trim() };
  const bad = (msg) => { req.session.flash = { type: 'warn', msg }; return res.redirect('/trust#feedback'); };
  if (f.name.length < 2 || f.name.length > 80) return bad('Please enter your name.');
  if (f.contact.length < 5 || f.contact.length > 120) return bad('Please enter a phone number or email so we can reply.');
  if (f.message.length < 10 || f.message.length > 2000) return bad('Please write your message (10 to 2000 characters).');
  const info = db.prepare('INSERT INTO complaints (user_id,name_enc,contact_enc,message_enc) VALUES (?,?,?,?)')
    .run(req.user ? req.user.id : null, encrypt(f.name), encrypt(f.contact), encrypt(f.message));
  audit(req.user ? req.user.id : null, 'complaint_received', String(info.lastInsertRowid), req.ip);
  req.session.flash = { type: 'ok', msg: 'Thank you. Your message has reached the college office. We will contact you.' };
  res.redirect('/trust');
});

module.exports = router;
