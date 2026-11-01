const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { db, audit, getSetting, setSetting } = require('../lib/db');
const { encrypt } = require('../lib/crypto');
const { requireAdmin } = require('../lib/auth');
const { ask, apiKey } = require('../lib/assistant');

router.use(requireAdmin);
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const DAILY_LIMIT = () => Number(getSetting('ai_daily_limit')) || 50;
const askLimiter = rateLimit({ windowMs: 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false });

router.get('/', (req, res) => {
  const actions = db.prepare('SELECT * FROM ai_actions ORDER BY id DESC LIMIT 40').all();
  res.render('admin/assistant', {
    title: 'School assistant', hasKey: !!apiKey(), chat: req.session.aiChat || [],
    pending: actions.filter(a => a.status === 'pending'), recent: actions.filter(a => a.status !== 'pending'),
    model: getSetting('ai_model') || 'claude-sonnet-5-5'
  });
});

router.post('/key', (req, res) => {
  const k = String(req.body.api_key || '').trim();
  if (!k) { setSetting('ai_api_key_enc', ''); audit(req.user.id, 'ai_key_removed', '', req.ip); flash(req, 'ok', 'API key removed. The assistant is switched off.'); }
  else if (!/^[\x21-\x7e]{20,300}$/.test(k)) flash(req, 'warn', 'That does not look like an API key.');
  else { setSetting('ai_api_key_enc', encrypt(k)); audit(req.user.id, 'ai_key_saved', '', req.ip); flash(req, 'ok', 'API key saved (stored encrypted). You can now use the assistant.'); }
  res.redirect('/admin/assistant');
});

router.post('/ask', askLimiter, async (req, res, next) => {
  try {
    const q = String(req.body.message || '').trim().slice(0, 1500);
    if (!q) return res.redirect('/admin/assistant');
    if (!apiKey()) { flash(req, 'warn', 'Save an API key first.'); return res.redirect('/admin/assistant'); }
    const day = 'ai_count_' + new Date().toISOString().slice(0, 10);
    const used = Number(getSetting(day)) || 0;
    if (used >= DAILY_LIMIT()) { flash(req, 'warn', 'Daily assistant limit reached. It resets tomorrow.'); return res.redirect('/admin/assistant'); }
    setSetting(day, String(used + 1));
    const chat = (req.session.aiChat || []).slice(-8);
    chat.push({ role: 'user', text: q });
    let reply;
    try { reply = await ask(chat, req.user.id); } catch (e) { reply = 'Sorry, I could not answer: ' + e.message; }
    chat.push({ role: 'assistant', text: reply });
    req.session.aiChat = chat.slice(-10);
    audit(req.user.id, 'ai_question', '', req.ip);
    res.redirect('/admin/assistant');
  } catch (e) { next(e); }
});

router.post('/clear', (req, res) => { req.session.aiChat = []; res.redirect('/admin/assistant'); });

router.post('/actions/:id/undo', (req, res) => {
  const a = db.prepare("SELECT * FROM ai_actions WHERE id=? AND kind='edit' AND status='applied'").get(Number(req.params.id));
  if (!a) { flash(req, 'warn', 'That change cannot be undone.'); return res.redirect('/admin/assistant'); }
  const before = JSON.parse(a.before_json);
  db.transaction(() => {
    for (const f of Object.keys(before)) if (['title', 'summary', 'description'].includes(f)) db.prepare(`UPDATE courses SET ${f}=? WHERE id=?`).run(before[f], a.course_id);
    db.prepare("UPDATE ai_actions SET status='reverted', decided_by=? WHERE id=?").run(req.user.id, a.id);
  })();
  audit(req.user.id, 'ai_edit_undone', 'action ' + a.id, req.ip);
  flash(req, 'ok', 'Change undone.');
  res.redirect('/admin/assistant');
});

function decide(status) {
  return (req, res) => {
    const a = db.prepare("SELECT * FROM ai_actions WHERE id=? AND kind='fee' AND status='pending'").get(Number(req.params.id));
    if (!a) { flash(req, 'warn', 'That proposal is no longer pending.'); return res.redirect('/admin/assistant'); }
    db.transaction(() => {
      if (status === 'approved') db.prepare('UPDATE courses SET fee_cents=? WHERE id=?').run(JSON.parse(a.after_json).fee_cents, a.course_id);
      db.prepare('UPDATE ai_actions SET status=?, decided_by=? WHERE id=?').run(status, req.user.id, a.id);
    })();
    audit(req.user.id, 'ai_fee_' + status, 'action ' + a.id, req.ip);
    flash(req, 'ok', status === 'approved' ? 'Fee change approved and applied to new enrolments (existing enrolments keep their fee).' : 'Proposal rejected.');
    res.redirect('/admin/assistant');
  };
}
router.post('/actions/:id/approve', decide('approved'));
router.post('/actions/:id/reject', decide('rejected'));

module.exports = router;
