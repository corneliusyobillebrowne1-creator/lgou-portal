// Public: "Teach with us" - teachers register and apply. The account can only log in to a status page
// until the admin team approves the application.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db, audit } = require('../lib/db');
const { encrypt, blindIndex } = require('../lib/crypto');
const { passwordProblem, COUNTIES } = require('../lib/util');
const { homeFor } = require('../lib/auth');

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).render('error', { title: 'Too many attempts', message: 'Too many applications from this connection. Please try again later.' })
});

router.get('/teach', (req, res) => {
  res.render('teach', { title: 'Teach with us', form: {}, error: null, counties: COUNTIES });
});

router.post('/teach', limiter, async (req, res, next) => {
  try {
    if (req.user) return res.redirect(homeFor(req.user));
    const b = req.body;
    const f = {
      full_name: String(b.full_name || '').trim(), username: String(b.username || '').trim(),
      email: String(b.email || '').trim(), phone: String(b.phone || '').trim(), county: String(b.county || ''),
      headline: String(b.headline || '').trim(), subjects: String(b.subjects || '').trim(),
      qualifications: String(b.qualifications || '').trim(), bio: String(b.bio || '').trim(),
      experience_years: parseInt(b.experience_years, 10)
    };
    const pw = String(b.password || '');
    const fail = (error) => res.status(400).render('teach', { title: 'Teach with us', form: f, error, counties: COUNTIES });

    if (f.full_name.length < 2 || f.full_name.length > 80) return fail('Enter your full name.');
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(f.username)) return fail('Username must be 3-30 characters: letters, numbers, dot, dash or underscore.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email) || f.email.length > 120) return fail('Enter a valid email address.');
    if (f.phone && !/^[0-9+\-\s()]{6,20}$/.test(f.phone)) return fail('Enter a valid phone number or leave it blank.');
    if (!COUNTIES.includes(f.county)) return fail('Choose the county where you live.');
    if (f.headline.length < 5 || f.headline.length > 100) return fail('Enter a short headline (5-100 characters), e.g. "Secondary school mathematics teacher".');
    if (f.subjects.length < 3 || f.subjects.length > 150) return fail('List the subjects you want to teach (3-150 characters).');
    if (f.qualifications.length < 10 || f.qualifications.length > 800) return fail('Describe your qualifications (10-800 characters).');
    if (f.bio.length < 30 || f.bio.length > 1200) return fail('Write a short bio of at least 30 characters (max 1200).');
    if (!(f.experience_years >= 0 && f.experience_years <= 60)) return fail('Enter your years of teaching experience (0-60).');
    if (!b.has_classroom) return fail('You must confirm that you have a Google account and can create classes in Google Classroom.');
    if (!b.consent) return fail('Please agree that your name and profile will be shown publicly if you are approved.');
    if (pw !== String(b.confirm || '')) return fail('The two passwords do not match.');
    const pwErr = passwordProblem(pw);
    if (pwErr) return fail(pwErr);

    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(f.username)) return fail('That username is already taken.');
    const idx = blindIndex(f.email);
    if (db.prepare('SELECT 1 FROM users WHERE email_idx=?').get(idx)) return fail('An account with that email already exists.');

    const hash = await bcrypt.hash(pw, 12);
    const tx = db.transaction(() => {
      const info = db.prepare(`INSERT INTO users (username,password_hash,role,full_name_enc,email_enc,email_idx,phone_enc)
        VALUES (?,?,'teacher',?,?,?,?)`).run(f.username, hash, encrypt(f.full_name), encrypt(f.email), idx, encrypt(f.phone));
      db.prepare(`INSERT INTO teacher_profiles (user_id,headline,bio,subjects,qualifications,experience_years,county)
        VALUES (?,?,?,?,?,?,?)`).run(info.lastInsertRowid, f.headline, f.bio, f.subjects, f.qualifications, f.experience_years, f.county);
      return info.lastInsertRowid;
    });
    const id = tx();
    audit(id, 'teacher_applied', f.username, req.ip);
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.userId = id;
      req.session.flash = { type: 'ok', msg: 'Application received. The admin team will review it and you will see the result here when you log in.' };
      req.session.save(() => res.redirect('/teacher'));
    });
  } catch (e) { next(e); }
});

module.exports = router;
