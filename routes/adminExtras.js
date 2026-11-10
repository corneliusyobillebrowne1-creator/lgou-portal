// Admin: quality report, complaints, course questions, success stories, reminder emails.
const router = require('express').Router();
const { db, audit } = require('../lib/db');
const { decrypt } = require('../lib/crypto');
const { requireAdmin } = require('../lib/auth');
const { enrollmentRows } = require('../lib/queries');
const mailer = require('../lib/mailer');
const emails = require('../lib/emails');
const { money } = require('../lib/util');
const n8n = require('../lib/n8n');
const { getSetting, setSetting } = require('../lib/db');
const ai = require('../lib/collegeai');
router.use(requireAdmin);
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const one = (sql, ...a) => db.prepare(sql).get(...a).n;

router.get('/growth', (req, res) => {
  res.render('admin/growth', { title: 'Quality & growth', n: {
    complaints: one("SELECT COUNT(*) n FROM complaints WHERE status='open'"),
    questions: one('SELECT COUNT(*) n FROM questions WHERE answer IS NULL'),
    reviews: one('SELECT COUNT(*) n FROM reviews'),
    stories: one('SELECT COUNT(*) n FROM stories WHERE active=1'),
    referred: one('SELECT COUNT(*) n FROM users WHERE referred_by IS NOT NULL')
  } });
});

// ---- quality report ----
router.get('/quality', (req, res) => {
  const rows = db.prepare(`SELECT c.id, c.title, c.type, c.teacher_id,
      (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) AS enrolled,
      (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id AND e.status='certified') AS certified,
      (SELECT ROUND(AVG(rating),1) FROM reviews r WHERE r.course_id=c.id) AS rating,
      (SELECT COUNT(*) FROM reviews r WHERE r.course_id=c.id) AS reviews,
      (SELECT COUNT(*) FROM questions q WHERE q.course_id=c.id AND q.answer IS NULL) AS open_q,
      (SELECT full_name_enc FROM users u WHERE u.id=c.teacher_id) AS tname
    FROM courses c WHERE c.approval_status='approved' ORDER BY c.title`).all()
    .map(r => ({ ...r, teacher: r.tname ? decrypt(r.tname) : 'College', completion: r.enrolled ? Math.round(r.certified * 100 / r.enrolled) : 0, low: r.reviews >= 3 && r.rating < 3.5 }));
  const comments = db.prepare(`SELECT r.rating, r.comment, r.created_at, c.title FROM reviews r JOIN courses c ON c.id=r.course_id WHERE r.comment<>'' ORDER BY r.id DESC LIMIT 25`).all();
  res.render('admin/quality', { title: 'Quality report', rows, comments });
});

// ---- complaints ----
router.get('/complaints', (req, res) => {
  const items = db.prepare('SELECT * FROM complaints ORDER BY status, id DESC LIMIT 200').all()
    .map(c => ({ ...c, name: decrypt(c.name_enc), contact: decrypt(c.contact_enc), message: decrypt(c.message_enc) }));
  res.render('admin/complaints', { title: 'Complaints & messages', items });
});
router.post('/complaints/:id', (req, res) => {
  const status = req.body.status === 'resolved' ? 'resolved' : 'open';
  db.prepare('UPDATE complaints SET status=?, admin_note=? WHERE id=?').run(status, String(req.body.note || '').trim().slice(0, 500), Number(req.params.id));
  audit(req.user.id, 'complaint_' + status, req.params.id, req.ip); flash(req, 'ok', 'Saved.'); res.redirect('/admin/complaints');
});

// ---- questions on school-run courses (teacher-run courses are answered by their teachers, but admin can too) ----
router.get('/questions', (req, res) => {
  const items = db.prepare(`SELECT q.*, c.title, c.teacher_id FROM questions q JOIN courses c ON c.id=q.course_id WHERE q.answer IS NULL ORDER BY q.id LIMIT 100`).all();
  res.render('admin/questions', { title: 'Student questions', items });
});
router.post('/questions/:id', (req, res) => {
  const a = String(req.body.answer || '').trim();
  if (a.length < 2 || a.length > 1500) { flash(req, 'warn', 'Write an answer (up to 1500 characters).'); return res.redirect('/admin/questions'); }
  db.prepare("UPDATE questions SET answer=?, answered_by=?, answered_at=datetime('now') WHERE id=? AND answer IS NULL").run(a, req.user.id, Number(req.params.id));
  flash(req, 'ok', 'Answer sent.'); res.redirect('/admin/questions');
});

// ---- success stories (only add a story with the student's permission) ----
router.get('/stories', (req, res) => res.render('admin/stories', { title: 'Success stories', items: db.prepare('SELECT * FROM stories ORDER BY id DESC').all() }));
router.post('/stories', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80), course = String(req.body.course || '').trim().slice(0, 120), quote = String(req.body.quote || '').trim().slice(0, 600);
  if (name.length < 2 || quote.length < 10 || req.body.consent !== 'yes') { flash(req, 'warn', 'Enter a name and the story, and confirm the student gave permission.'); return res.redirect('/admin/stories'); }
  db.prepare('INSERT INTO stories (name,course,quote) VALUES (?,?,?)').run(name, course, quote);
  audit(req.user.id, 'story_added', name, req.ip); flash(req, 'ok', 'Story published on the Trust page.'); res.redirect('/admin/stories');
});
router.post('/stories/:id/toggle', (req, res) => { db.prepare('UPDATE stories SET active=1-active WHERE id=?').run(Number(req.params.id)); res.redirect('/admin/stories'); });
router.post('/stories/:id/delete', (req, res) => { db.prepare('DELETE FROM stories WHERE id=?').run(Number(req.params.id)); res.redirect('/admin/stories'); });

// ---- reminder emails ----
function candidates(kind) {
  if (kind === 'unpaid') return enrollmentRows("e.status='enrolled' AND e.created_at < datetime('now','-3 days')").filter(e => !e.paid_full && e.pending_cents === 0);
  return enrollmentRows("e.status='enrolled' AND e.created_at < datetime('now','-14 days')").filter(e => e.paid_full && e.lesson_total > 0 && e.lesson_done < e.lesson_total &&
    !db.prepare("SELECT 1 FROM lesson_progress WHERE enrollment_id=? AND completed_at > datetime('now','-14 days')").get(e.id));
}
const recentlyMailed = (uid, kind) => !!db.prepare("SELECT 1 FROM email_log WHERE user_id=? AND kind=? AND created_at > datetime('now','-7 days')").get(uid, kind);
router.get('/reminders', (req, res) => {
  const count = (k) => { const seen = new Set(); candidates(k).forEach(e => { if (!recentlyMailed(e.user_id, 'reminder_' + k)) seen.add(e.id); }); return seen.size; };
  res.render('admin/reminders', { title: 'Reminder emails', counts: { unpaid: count('unpaid'), inactive: count('inactive') }, email: mailer.status ? mailer.status() : null });
});
router.post('/reminders/:kind', async (req, res) => {
  const kind = req.params.kind === 'inactive' ? 'inactive' : 'unpaid'; const base = emails.baseUrl(req);
  let sent = 0, failed = 0;
  for (const e of candidates(kind).slice(0, 100)) {
    if (recentlyMailed(e.user_id, 'reminder_' + kind)) continue;
    const r = await mailer.sendToUser(e.user_id, 'reminder_' + kind, e.id, async ({ name }) => {
      const E = emails.esc;
      const inner = kind === 'unpaid'
        ? `<p>Dear ${E(name)},</p><p>You enrolled in <strong>${E(e.course_title)}</strong>, but your fee is not complete yet. Balance: <strong>${E(money(e.owed_cents))}</strong>.</p><p>Log in to your student portal and open <em>Pay fee</em> to see how to pay. If you need help, call the college office.</p><p><a href="${E(base)}/portal">Open my portal</a></p>`
        : `<p>Dear ${E(name)},</p><p>We miss you in <strong>${E(e.course_title)}</strong>. You have finished ${e.lesson_done} of ${e.lesson_total} lessons. A little each day is enough.</p><p><a href="${E(base)}/portal/learn/${e.id}">Continue my lessons</a></p>`;
      return { subject: kind === 'unpaid' ? 'Your fee for ' + e.course_title : 'Continue your course: ' + e.course_title,
        text: kind === 'unpaid' ? `Your fee for ${e.course_title} is not complete. Balance ${money(e.owed_cents)}. Log in to your portal to pay.` : `Continue ${e.course_title} in your student portal: ${base}/portal`, html: emails.wrap(inner) };
    });
    r.ok ? sent++ : failed++;
  }
  audit(req.user.id, 'reminders_' + kind, sent + ' sent, ' + failed + ' failed', req.ip);
  flash(req, sent || !failed ? 'ok' : 'warn', `${sent} reminder(s) sent${failed ? ', ' + failed + ' could not be sent (check Emails settings)' : ''}.`);
  res.redirect('/admin/reminders');
});

// ---- automation (n8n), messaging number, social links, website chat ----
router.get('/automation', (req, res) => {
  const once = req.session.once || null; delete req.session.once;
  res.render('admin/automation', { title: 'Automation & social', c: n8n.config(), once, log: db.prepare('SELECT * FROM n8n_log ORDER BY id DESC LIMIT 20').all(),
    chatOn: ai.enabled(), hasKey: !!getSetting('ai_api_key_enc'), chatCap: getSetting('ai_public_daily_cap', '300'), publicEnabled: getSetting('ai_public_enabled') !== 'no',
    social: { whatsapp: getSetting('whatsapp_number') || '', facebook: getSetting('facebook_url') || '', tiktok: getSetting('tiktok_url') || '' }, base: emails.baseUrl(req) });
});
router.post('/automation', (req, res) => {
  const b = req.body; const url = String(b.n8n_webhook_url || '').trim();
  if (url && !n8n.validUrl(url)) { flash(req, 'warn', 'The n8n webhook address must be a public https:// address.'); return res.redirect('/admin/automation'); }
  setSetting('n8n_webhook_url', url);
  setSetting('n8n_enabled', b.n8n_enabled === 'yes' ? 'yes' : 'no');
  setSetting('n8n_include_phone', b.n8n_include_phone === 'yes' ? 'yes' : 'no');
  const num = String(b.school_msg_number || '').replace(/[^0-9+]/g, '').slice(0, 16); setSetting('school_msg_number', num || n8n.DEFAULT_FROM);
  setSetting('ai_public_enabled', b.ai_public_enabled === 'no' ? 'no' : 'yes');
  const cap = parseInt(b.chat_cap, 10); if (cap >= 10 && cap <= 5000) setSetting('ai_public_daily_cap', String(cap));
  const wa = String(b.whatsapp_number || '').replace(/[^0-9+]/g, '').slice(0, 16); setSetting('whatsapp_number', wa);
  const sx = require('../lib/site'); const dummy = {};
  for (const [k, hosts] of [['facebook_url', ['facebook.com', 'fb.com']], ['tiktok_url', ['tiktok.com']]]) {
    const v = String(b[k] || '').trim(); let ok = !v;
    if (v) { try { const u = new URL(v); ok = u.protocol === 'https:' && hosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h)); } catch {} }
    if (!ok) { flash(req, 'warn', 'The ' + k.replace('_url', '') + ' link must be a https:// address on the real site.'); return res.redirect('/admin/automation'); }
    setSetting(k, v);
  }
  audit(req.user.id, 'automation_settings', '', req.ip); flash(req, 'ok', 'Saved.'); res.redirect('/admin/automation');
});
router.post('/automation/secret', (req, res) => { const s = n8n.newSecret(); n8n.saveSecret(s); req.session.once = { kind: 'Signing secret', value: s }; audit(req.user.id, 'n8n_secret_created', '', req.ip); res.redirect('/admin/automation'); });
router.post('/automation/token', (req, res) => { const t = n8n.newSecret(); n8n.saveToken(t); req.session.once = { kind: 'Access token for n8n', value: t }; audit(req.user.id, 'n8n_token_created', '', req.ip); res.redirect('/admin/automation'); });
router.post('/automation/test', async (req, res) => {
  const r = await n8n.emit('test', { message: 'Test from the college website', note: 'If you see this in n8n, the connection works.' }, { force: true });
  flash(req, r.ok ? 'ok' : 'warn', r.ok ? 'Test event sent. Check your n8n workflow.' : 'Test failed: ' + (r.error || ('n8n answered ' + r.status) || 'check the address and secret') + '.');
  res.redirect('/admin/automation');
});

module.exports = router;
