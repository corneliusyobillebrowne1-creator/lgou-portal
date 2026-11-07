const site = require('./lib/site');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');

const { db } = require('./lib/db');
const { decrypt, SESSION_SECRET } = require('./lib/crypto');
const SqliteStore = require('./lib/sessionStore');
const { money, fmtDate, DISCLAIMER, CLASSROOM_NOTE, initials } = require('./lib/util');
const { homeFor } = require('./lib/auth');
const { runBackup, listBackups } = require('./lib/backup');

const isProd = process.env.NODE_ENV === 'production';
const app = express();

// Hosts like Render and Vercel put a proxy in front; trust it so HTTPS detection and client IPs are right.
if (process.env.TRUST_PROXY || process.env.VERCEL) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');

// ---- force HTTPS everywhere in production (needs TRUST_PROXY so the host's X-Forwarded-Proto is believed) ----
const forceHttps = process.env.FORCE_HTTPS === 'true' || (isProd && !!(process.env.TRUST_PROXY || process.env.VERCEL) && process.env.FORCE_HTTPS !== 'false');
if (forceHttps) {
  app.use((req, res, next) => {
    if (req.secure) return next();
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
    return res.status(400).send('HTTPS is required.');
  });
}

// ---- security headers (CSP allows only our own files + the YouTube player) ----
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https://i.ytimg.com'],
      frameSrc: ['https://www.youtube-nocookie.com', 'https://www.youtube.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: isProd ? [] : null
    }
  },
  hsts: forceHttps ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }, // YouTube embeds need a referrer
  crossOriginEmbedderPolicy: false
}));

app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, file) => {
    if (/[\\/](sw\.js|manifest\.webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    if (/manifest\.webmanifest$/.test(file)) res.setHeader('Content-Type', 'application/manifest+json');
  }
}));

app.use(rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
// Tighter cap on anything that changes data (payments, enrolments, applications, assistant) per IP.
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, skip: req => req.method === 'GET' || req.method === 'HEAD' });
app.use(writeLimiter);

app.use(session({
  name: 'lgou.sid',
  secret: SESSION_SECRET,
  store: new SqliteStore(db),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true' || (isProd && process.env.COOKIE_SECURE !== 'false') || forceHttps, // automatic in production; set COOKIE_SECURE=false only for plain-http testing
    maxAge: 2 * 60 * 60 * 1000
  }
}));

// ---- per-request locals, current user, CSRF ----
app.use((req, res, next) => {
  res.locals.csrfToken = () => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    return req.session.csrf;
  };
  res.locals.money = money;
  res.locals.fmtDate = fmtDate;
  res.locals.DISCLAIMER = DISCLAIMER;
  res.locals.currentPath = req.path;
  res.locals.user = null;
  res.locals.teacher = null;
  res.locals.homeFor = homeFor;
  res.locals.initials = initials;
  res.locals.CLASSROOM_NOTE = CLASSROOM_NOTE;
  res.locals.typeLabel = site.typeLabel;
  res.locals.durationLabel = site.durationLabel;
  res.locals.badgeClass = site.badgeClass;
  res.locals.siteInfo = site.info();
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;

  if (req.session.userId) {
    const u = db.prepare('SELECT id,username,role,active,full_name_enc,student_no,must_change FROM users WHERE id=?').get(req.session.userId);
    if (u && u.active) {
      u.full_name = decrypt(u.full_name_enc);
      req.user = u;
      res.locals.user = u;
      if (u.role === 'teacher') {
        req.teacher = db.prepare('SELECT * FROM teacher_profiles WHERE user_id=?').get(u.id) || null;
        res.locals.teacher = req.teacher;
      }
    } else {
      delete req.session.userId; // account removed or disabled
    }
  }
  next();
});

app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const t = String((req.body && req.body._csrf) || '');
    const s = String(req.session.csrf || '');
    if (!t || !s || t.length !== s.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(s))) {
      return res.status(403).render('error', {
        title: 'Request blocked',
        message: 'Your session expired or the form was invalid. Go back, refresh the page and try again.'
      });
    }
  }
  next();
});

// Accounts whose password was reset by the office must choose a new one before doing anything else.
app.use((req, res, next) => {
  if (req.user && req.user.must_change && !['/account', '/logout'].includes(req.path)) {
    if (req.method === 'GET') { req.session.flash = { type: 'warn', msg: 'Please choose a new password to continue.' }; return res.redirect('/account'); }
    return res.status(403).render('error', { title: 'Change your password', message: 'Please choose a new password first (My account).' });
  }
  next();
});

app.use('/', require('./routes/public'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/teacherApply'));
app.use('/portal', require('./routes/student'));
app.use('/teacher', require('./routes/teacher'));
app.use('/admin/assistant', require('./routes/assistant'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`Liberia Gateway Online College portal running on port ${PORT}`);
  });

  // ---- automatic daily database backup ----
  async function autoBackup() {
    try { await runBackup(); } catch (e) { console.error('Auto-backup failed:', e.message); }
  }
  const last = listBackups()[0];
  if (!last || Date.now() - last.mtime.getTime() > 24 * 3600 * 1000) autoBackup();
  setInterval(autoBackup, 24 * 3600 * 1000).unref();
}

// On Vercel the app runs as a serverless function (see api/index.js), so we export it instead of listening.
module.exports = app;
