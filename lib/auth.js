function deny(res, status, message) {
  return res.status(status).render('error', { title: status === 403 ? 'Access denied' : 'Error', message });
}

const homeFor = (u) => (!u ? '/login' : u.role === 'admin' ? '/admin' : u.role === 'teacher' ? '/teacher' : '/portal');

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireStudent(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'student') return res.redirect(homeFor(req.user));
  next();
}

// Admin area: must be logged in as admin, and (optionally) come from an allowed IP.
// Set ADMIN_ALLOWED_IPS="1.2.3.4,5.6.7.8" to restrict the dashboard to specific addresses.
function requireAdmin(req, res, next) {
  const allow = (process.env.ADMIN_ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(req.ip)) return deny(res, 403, 'The admin area is not available from this location.');
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') return deny(res, 403, 'You do not have permission to open this page.');
  next();
}

// Any logged-in teacher account (even one still waiting for approval) may see the status page.
function requireTeacherAny(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'teacher') return deny(res, 403, 'This area is for teachers only.');
  next();
}

// Teacher tools: only teachers whose application the admin team has approved.
function requireTeacher(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'teacher') return deny(res, 403, 'This area is for teachers only.');
  if (!req.teacher || req.teacher.status !== 'approved') return res.redirect('/teacher');
  next();
}

module.exports = { requireLogin, requireStudent, requireAdmin, requireTeacher, requireTeacherAny, deny, homeFor };
