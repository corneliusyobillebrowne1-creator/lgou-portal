// Owner-only AI staff team area. Every route needs an admin login; every form is CSRF-checked site-wide.
const router = require('express').Router();
const { db, audit, getSetting, setSetting } = require('../lib/db');
const { requireAdmin } = require('../lib/auth');
const team = require('../lib/team');
const ai = require('../lib/collegeai');
const { money, parseMoney } = require('../lib/util');
router.use(requireAdmin);
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const one = (sql, ...a) => (db.prepare(sql).get(...a) || {}).n || 0;
const ST = ['queued', 'working', 'review', 'approved', 'rejected', 'failed', 'cancelled'];
const csvCell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
const sendCsv = (res, name, head, rows) => { res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, 'x-content-type-options': 'nosniff' }); res.send('﻿' + [head.map(csvCell).join(',')].concat(rows.map(r => r.map(csvCell).join(','))).join('\r\n')); };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'file';
const sig = () => JSON.stringify(team.counts()) + one('SELECT MAX(id) n FROM ai_messages') + one('SELECT MAX(id) n FROM ai_reports');
const names = () => { const m = { owner: 'You (owner)', system: 'System' }; team.agents().forEach(a => m[a.key] = a.name); return m; };
const view = (res, v, title, data) => res.render('team/' + v, { title, agents: team.agents(), names: names(), STS: ST, sig: sig(), aiOn: ai.hasKey(), ...data });
const taskRows = (where, ...a) => db.prepare(`SELECT t.*, (SELECT name FROM ai_agents WHERE key=t.agent) AS aname FROM ai_tasks t ${where}`).all(...a);

router.get('/', (req, res) => {
  const c = team.counts();
  view(res, 'index', 'AI Team', { c, review: taskRows("WHERE status='review' ORDER BY id DESC LIMIT 20"), recent: taskRows('ORDER BY id DESC LIMIT 12'),
    reports: db.prepare('SELECT * FROM ai_reports ORDER BY id DESC LIMIT 5').all(), calls: team.callsToday(), cap: team.cap(), on: team.teamOn() });
});

router.get('/agent/:key', (req, res) => {
  const a = team.agent(req.params.key); if (!a) return res.status(404).render('error', { title: 'Not found', message: 'No such team member.' });
  const ch = a.key === 'director' ? 'team' : 'dm:' + a.key;
  view(res, 'agent', a.name + ' - ' + a.title, { a, presets: team.PRESETS[a.key] || [], mine: taskRows('WHERE agent=? ORDER BY id DESC LIMIT 30', a.key),
    chan: ch, msgs: db.prepare('SELECT * FROM ai_messages WHERE channel=? ORDER BY id DESC LIMIT 30').all(ch).reverse(), reports: db.prepare('SELECT * FROM ai_reports WHERE agent=? ORDER BY id DESC LIMIT 5').all(a.key) });
});

function assign(req, res, back) {
  try {
    const b = req.body;
    const id = team.createTask({ title: b.title, instructions: b.instructions, agent: b.agent, by: b.by === 'director' ? 'director' : 'owner', priority: b.priority, due: b.due, kind: b.kind === 'report' ? 'report' : 'work' });
    audit(req.user.id, 'team_task_created', String(id), req.ip); flash(req, 'ok', `Task #${id} assigned. It starts within a few seconds.`);
  } catch (e) { flash(req, 'error', e.message); }
  res.redirect(back);
}
router.post('/tasks', (req, res) => assign(req, res, '/team/tasks'));
router.post('/quick', (req, res) => {
  const a = team.agent(req.body.agent), p = a && (team.PRESETS[a.key] || [])[parseInt(req.body.i, 10)];
  if (!p) { flash(req, 'error', 'Unknown shortcut.'); return res.redirect('/team'); }
  const id = team.createTask({ title: p[0], instructions: p[1], agent: a.key, by: 'owner' }); flash(req, 'ok', `Task #${id} started.`); res.redirect('/team/agent/' + a.key);
});
router.post('/instruct', (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 3000), target = String(req.body.target || 'all');
  if (text.length < 3) { flash(req, 'error', 'Please write your instruction.'); return res.redirect('/team'); }
  try {
    if (target === 'all') { const id = team.createTask({ title: 'Owner instruction: ' + text.slice(0, 80), instructions: text, agent: 'director', by: 'owner', kind: 'plan', priority: 'high' }); team.say('team', 'owner', 'Instruction for the whole team: ' + text, id); flash(req, 'ok', 'Sent to the whole team. The Director will turn it into tasks.'); }
    else { const id = team.createTask({ title: 'Owner instruction: ' + text.slice(0, 80), instructions: text, agent: target, by: 'owner', priority: 'high' }); flash(req, 'ok', `Task #${id} sent to ${team.agent(target).name}.`); }
    audit(req.user.id, 'team_instruction', target, req.ip);
  } catch (e) { flash(req, 'error', e.message); }
  res.redirect('/team');
});

router.get('/tasks', (req, res) => {
  const st = ST.includes(req.query.status) ? req.query.status : '', ag = team.KEYS.includes(req.query.agent) ? req.query.agent : '';
  const rows = taskRows(`WHERE (?='' OR status=?) AND (?='' OR agent=?) ORDER BY id DESC LIMIT 300`, st, st, ag, ag);
  if (req.query.format === 'csv') return sendCsv(res, 'task-history', ['id', 'created', 'assigned_to', 'status', 'priority', 'due', 'title', 'result', 'feedback'], rows.map(t => [t.id, t.created_at, t.aname, t.status, t.priority, t.due_at, t.title, t.result, t.feedback]));
  view(res, 'tasks', 'Work history', { rows, st, ag });
});
router.get('/tasks/:id', (req, res) => {
  const t = taskRows('WHERE t.id=?', +req.params.id || 0)[0]; if (!t) return res.status(404).render('error', { title: 'Not found', message: 'No such task.' });
  view(res, 'task', 'Task #' + t.id, { t, log: db.prepare('SELECT * FROM ai_log WHERE task_id=? ORDER BY id').all(t.id), subs: taskRows('WHERE parent_id=? ORDER BY id', t.id) });
});
router.get('/tasks/:id/download', (req, res) => {
  const t = db.prepare('SELECT * FROM ai_tasks WHERE id=?').get(+req.params.id || 0); if (!t) return res.status(404).end();
  const a = team.agent(t.agent);
  res.set({ 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="task-${t.id}-${slug(t.title)}.md"`, 'x-content-type-options': 'nosniff' });
  res.send(`# ${t.title}\n\nTask #${t.id} | ${a.name} (${a.title}) | status: ${t.status} | created ${t.created_at}\n\n## Instructions\n${t.instructions}\n\n## Work\n${t.result || '(nothing yet)'}\n\n## Director feedback\n${t.feedback || '-'}\n`);
});
router.post('/tasks/:id/:act', (req, res) => {
  const id = +req.params.id || 0, t = db.prepare('SELECT * FROM ai_tasks WHERE id=?').get(id), act = req.params.act;
  if (!t) return res.status(404).end();
  const note = String(req.body.note || '').trim().slice(0, 1000);
  if (act === 'approve' && ['review', 'rejected'].includes(t.status)) { team.approve(id, 'owner', note); flash(req, 'ok', 'Approved.'); }
  else if (act === 'reject' && ['review', 'approved'].includes(t.status)) { team.touch(id, "status='queued', feedback=?, revisions=revisions+1", note || 'The owner asked for changes.'); team.log('owner', 'sent back for changes', id, note); flash(req, 'ok', 'Sent back to the team member.'); }
  else if (act === 'cancel' && ['queued', 'review', 'failed'].includes(t.status)) { team.finish(id, 'owner', 'cancelled', note); flash(req, 'ok', 'Cancelled.'); }
  else if (act === 'retry' && ['failed', 'cancelled', 'rejected'].includes(t.status)) { team.touch(id, "status='queued', attempts=0"); team.log('owner', 'retry', id, ''); flash(req, 'ok', 'Queued again.'); }
  else flash(req, 'error', 'That cannot be done in the task\'s current state.');
  audit(req.user.id, 'team_task_' + act, String(id), req.ip); res.redirect('/team/tasks/' + id);
});
router.post('/run-now', async (req, res) => { const n = await team.drain(3); flash(req, 'ok', n ? `Worked on ${n} task(s).` : 'Nothing to run (or the AI key/limit is not ready).'); res.redirect(req.get('referer') && /^https?:\/\/[^/]+\/team/.test(req.get('referer')) ? new URL(req.get('referer')).pathname : '/team'); });

router.get('/log', (req, res) => {
  const rows = db.prepare('SELECT * FROM ai_log ORDER BY id DESC LIMIT 500').all();
  if (req.query.format === 'csv') return sendCsv(res, 'secretary-log', ['time', 'who', 'action', 'task', 'detail'], rows.map(l => [l.at, l.actor, l.action, l.task_id, l.detail]));
  view(res, 'log', 'Secretary\'s log', { rows });
});
router.get('/chat', (req, res) => view(res, 'chat', 'Team chat', { chan: 'team', msgs: db.prepare("SELECT * FROM ai_messages WHERE channel='team' ORDER BY id DESC LIMIT 60").all().reverse() }));
router.post('/chat', async (req, res) => {
  const ch = String(req.body.channel || 'team'), text = String(req.body.text || '').trim().slice(0, 1000);
  if (!(ch === 'team' || (ch.startsWith('dm:') && team.KEYS.includes(ch.slice(3)))) || !text) { flash(req, 'error', 'Write a message first.'); return res.redirect('/team/chat'); }
  await team.chatReply(ch, text);
  res.redirect(ch === 'team' ? '/team/chat' : '/team/agent/' + ch.slice(3));
});
router.get('/reports', (req, res) => view(res, 'reports', 'Reports', { rows: db.prepare('SELECT r.*, (SELECT name FROM ai_agents WHERE key=r.agent) aname FROM ai_reports r ORDER BY id DESC LIMIT 200').all() }));
router.get('/reports/:id', (req, res) => {
  const r = db.prepare('SELECT r.*, (SELECT name FROM ai_agents WHERE key=r.agent) aname FROM ai_reports r WHERE id=?').get(+req.params.id || 0); if (!r) return res.status(404).render('error', { title: 'Not found', message: 'No such report.' });
  if (req.query.download) { res.set({ 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="report-${r.id}-${slug(r.title)}.md"`, 'x-content-type-options': 'nosniff' }); return res.send(`# ${r.title}\n\n${r.created_at} | ${r.aname}\n\n${r.body}\n`); }
  view(res, 'report', r.title, { r });
});

// ---- finance records (Daniel's books). Entered by the owner; real payments are read from the college payments table.
router.get('/finance', (req, res) => {
  const entries = db.prepare('SELECT * FROM finance_entries ORDER BY entry_date DESC, id DESC LIMIT 200').all();
  if (req.query.format === 'csv') return sendCsv(res, 'finance-records', ['date', 'type', 'category', 'amount_usd', 'note'], entries.map(e => [e.entry_date, e.kind, e.category, (e.amount_cents / 100).toFixed(2), e.note]));
  view(res, 'finance', 'Finance records', { entries, f: team.financeFacts(), money });
});
router.post('/finance', (req, res) => {
  const b = req.body, cents = parseMoney(b.amount);
  if (!['income', 'expense'].includes(b.kind) || !cents || cents <= 0 || cents > 1e9 || !/^\d{4}-\d{2}-\d{2}$/.test(b.entry_date || '') || !String(b.category || '').trim()) { flash(req, 'error', 'Please give type, date, category and an amount above zero.'); return res.redirect('/team/finance'); }
  db.prepare('INSERT INTO finance_entries (kind,category,amount_cents,note,entry_date,created_by) VALUES (?,?,?,?,?,?)').run(b.kind, String(b.category).trim().slice(0, 60), cents, String(b.note || '').trim().slice(0, 200), b.entry_date, 'owner');
  team.log('owner', 'finance entry added', null, `${b.kind} ${b.category} ${money(cents)}`); audit(req.user.id, 'team_finance_add', b.kind, req.ip); flash(req, 'ok', 'Saved.'); res.redirect('/team/finance');
});
router.post('/finance/:id/delete', (req, res) => { db.prepare('DELETE FROM finance_entries WHERE id=?').run(+req.params.id || 0); team.log('owner', 'finance entry deleted', null, '#' + req.params.id); audit(req.user.id, 'team_finance_delete', req.params.id, req.ip); flash(req, 'ok', 'Deleted.'); res.redirect('/team/finance'); });

router.get('/settings', (req, res) => view(res, 'settings', 'Team settings', { s: { on: team.teamOn(), auto: getSetting('team_auto', 'off') === 'on', cap: team.cap(), model: getSetting('team_model', '') }, calls: team.callsToday() }));
router.post('/settings', (req, res) => {
  setSetting('team_enabled', req.body.enabled === 'on' ? 'on' : 'off'); setSetting('team_auto', req.body.auto === 'on' ? 'on' : 'off');
  setSetting('team_daily_cap', String(Math.min(2000, Math.max(5, parseInt(req.body.cap, 10) || 60))));
  const m = String(req.body.model || '').trim(); setSetting('team_model', /^[A-Za-z0-9._-]{0,60}$/.test(m) ? m : '');
  audit(req.user.id, 'team_settings', '', req.ip); flash(req, 'ok', 'Saved.'); res.redirect('/team/settings');
});
router.get('/api/status', (req, res) => res.json({ sig: sig() }));
module.exports = router;
