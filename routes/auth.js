const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db, audit, assignStudentNo } = require('../lib/db');
const { encrypt, blindIndex } = require('../lib/crypto');
const { requireLogin, homeFor } = require('../lib/auth');
const { passwordProblem } = require('../lib/util');

const tooMany = (req, res) => res.status(429).render('error', {
  title: 'Too many attempts', message: 'Too many attempts. Please wait a few minutes and try again.'
});
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, handler: tooMany });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, handler: tooMany });

const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-password', 12);
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

function startSession(req, res, user) {
  req.session.regenerate(err => {
    if (err) throw err;
    req.session.userId = user.id;
    req.session.save(() => res.redirect(homeFor(user)));
  });
}

router.get('/signup', (req, res) => {
  if (/^[A-Z0-9]{6,12}$/.test(String(req.query.ref || ''))) req.session.ref = String(req.query.ref);
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('signup', { title: 'Create account', form: {}, error: null });
});

router.post('/signup', signupLimiter, async (req, res, next) => {
  try {
    const f = {
      full_name: String(req.body.full_name || '').trim(),
      username: String(req.body.username || '').trim(),
      email: String(req.body.email || '').trim(),
      phone: String(req.body.phone || '').trim()
    };
    const pw = String(req.body.password || '');
    const fail = (error) => res.status(400).render('signup', { title: 'Create account', form: f, error });

    if (f.full_name.length < 2 || f.full_name.length > 80) return fail('Please enter your full name (as it should appear on your certificate).');
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(f.username)) return fail('Username must be 3-30 characters: letters, numbers, dot, dash or underscore.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email) || f.email.length > 120) return fail('Please enter a valid email address.');
    if (f.phone && !/^[0-9+\-\s()]{6,20}$/.test(f.phone)) return fail('Please enter a valid phone number or leave it blank.');
    if (pw !== String(req.body.confirm || '')) return fail('The two passwords do not match.');
    const pwErr = passwordProblem(pw);
    if (pwErr) return fail(pwErr);

    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(f.username)) return fail('That username is already taken.');
    const idx = blindIndex(f.email);
    if (db.prepare('SELECT 1 FROM users WHERE email_idx=?').get(idx)) return fail('An account with that email already exists.');

    const hash = await bcrypt.hash(pw, 12);
    const info = db.prepare(`INSERT INTO users (username,password_hash,role,full_name_enc,email_enc,email_idx,phone_enc)
      VALUES (?,?,?,?,?,?,?)`).run(f.username, hash, 'student', encrypt(f.full_name), encrypt(f.email), idx, encrypt(f.phone));
    assignStudentNo(info.lastInsertRowid);
    if (req.session.ref) { const r = db.prepare("SELECT id FROM users WHERE referral_code=? AND role='student'").get(req.session.ref); if (r) db.prepare('UPDATE users SET referred_by=? WHERE id=?').run(r.id, info.lastInsertRowid); }
    audit(info.lastInsertRowid, 'signup', f.username, req.ip);
    startSession(req, res, { id: info.lastInsertRowid, role: 'student' });
  } catch (e) { next(e); }
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('login', { title: 'Log in', error: null, username: '' });
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const generic = 'Incorrect username or password.';
    const show = (error, status = 401) => res.status(status).render('login', { title: 'Log in', error, username });

    const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (u && u.locked_until > Date.now()) {
      return show('This account is temporarily locked after too many failed attempts. Try again in a few minutes.', 429);
    }
    const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok || !u.active) {
      if (u) {
        const fails = u.failed_count + 1;
        if (fails >= MAX_FAILS) {
          db.prepare('UPDATE users SET failed_count=0, locked_until=? WHERE id=?').run(Date.now() + LOCK_MS, u.id);
          audit(u.id, 'account_locked', null, req.ip);
        } else {
          db.prepare('UPDATE users SET failed_count=? WHERE id=?').run(fails, u.id);
        }
        audit(u.id, 'login_failed', null, req.ip);
      }
      return show(u && !u.active && ok ? 'This account has been disabled. Please contact the school office.' : generic);
    }
    db.prepare("UPDATE users SET failed_count=0, locked_until=0, last_login=datetime('now') WHERE id=?").run(u.id);
    audit(u.id, 'login', null, req.ip);
    startSession(req, res, u);
  } catch (e) { next(e); }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('lgou.sid');
    res.redirect('/');
  });
});

router.get('/account', requireLogin, (req, res) => {
  res.render('account', { title: 'My account', error: null });
});

router.post('/account', requireLogin, async (req, res, next) => {
  try {
    const cur = String(req.body.current || '');
    const pw = String(req.body.password || '');
    const fail = (error) => res.status(400).render('account', { title: 'My account', error });
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!(await bcrypt.compare(cur, u.password_hash))) return fail('Your current password is incorrect.');
    if (pw !== String(req.body.confirm || '')) return fail('The new passwords do not match.');
    const pwErr = passwordProblem(pw);
    if (pwErr) return fail(pwErr);
    if (pw === cur) return fail('Choose a password different from the current one.');
    db.prepare('UPDATE users SET password_hash=?, must_change=0 WHERE id=?').run(await bcrypt.hash(pw, 12), u.id);
    db.prepare("DELETE FROM sessions WHERE json_extract(data,'$.userId')=? AND sid<>?").run(u.id, req.sessionID); // sign out other devices
    audit(u.id, 'password_changed', null, req.ip);
    req.session.flash = { type: 'ok', msg: 'Your password has been changed.' };
    res.redirect(homeFor(u));
  } catch (e) { next(e); }
});

module.exports = router;
