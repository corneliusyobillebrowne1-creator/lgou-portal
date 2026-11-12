// Tests the six-person AI staff team against a FAKE Anthropic server (no cost, no real AI).
const http = require('http'), { spawn } = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const APP = 4520, FAKE = 4521, BASE = 'http://localhost:' + APP;
let pass = 0, failed = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { failed++; console.log('  FAIL ' + n + (x ? ' -> ' + x : '')); } };
const prompts = []; let calls = 0;
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    calls++; const j = JSON.parse(b), sys = j.system || '', u = String(j.messages[0].content); prompts.push(sys + '\n' + u);
    let text;
    if (sys.includes('PLAN MODE')) text = 'Sure: ' + JSON.stringify({ summary: 'Promote the diploma.', tasks: [
      { agent: 'content', title: 'Write the diploma post', instructions: 'Write one honest Facebook post.', due_in_days: 2, priority: 'high' },
      { agent: 'finance', title: 'Fees summary', instructions: 'Summarise fees.', due_in_days: 3 },
      { agent: 'hacker', title: 'Bad agent', instructions: 'x' }, { agent: 'designer', title: '', instructions: 'no title' }] });
    else if (sys.includes('REVIEW MODE')) text = (u.includes('REJECT_TEST') && !u.includes('REVISED')) ? '{"decision":"reject","feedback":"Add a call to action."}' : u.includes('UNCLEAR_TEST') ? 'I like it!' : '{"decision":"approve","feedback":"Good and honest work."}';
    else if (u.includes('CHAT SO FAR')) text = 'Hello owner, this is the fake reply.';
    else if (u.includes('DIRECTOR FEEDBACK TO FIX')) text = 'REVISED draft with call to action';
    else if (u.includes('XSS_TEST')) text = 'DRAFT <script>alert(1)</script> =cmd';
    else text = 'DRAFT: ' + u.split('\n')[0];
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }));
  });
});
function client() {
  const jar = {};
  const req = async (m, p, form) => {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') };
    let body; if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(BASE + p, { method: m, headers, body, redirect: 'manual' });
    (r.headers.getSetCookie() || []).forEach(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); });
    return { status: r.status, text: await r.text(), loc: r.headers.get('location'), h: r.headers };
  };
  const csrf = (h) => (h.match(/name="_csrf" value="([a-f0-9]+)"/) || [])[1];
  return { get: (p) => req('GET', p), raw: req, post: async (p, f, tp) => req('POST', p, { ...f, _csrf: csrf((await req('GET', tp || '/login')).text) }) };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgou-team-'));
  await new Promise(r => fake.listen(FAKE, r));
  const app = spawn('node', ['server.js'], { env: { ...process.env, PORT: APP, DATA_DIR: dir + '/data', BACKUP_DIR: dir + '/b', ADMIN_PASSWORD: 'TestAdmin123', ANTHROPIC_BASE_URL: 'http://localhost:' + FAKE, TEAM_TICK_MS: '300', WRITE_LIMIT: '1000' }, stdio: 'ignore' });
  await sleep(3000);
  const Database = require('better-sqlite3');
  const dbq = (sql, ...a) => { const d = new Database(dir + '/data/lgou.db', { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
  const dba = (sql, ...a) => { const d = new Database(dir + '/data/lgou.db', { readonly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
  const waitFor = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(250); } return false; };
  try {
    const anon = client(); let r = await anon.get('/team');
    check('team area is closed to visitors', r.status === 302 && /login/.test(r.loc || ''), r.status);
    r = await anon.get('/team/api/status'); check('status API closed to visitors', r.status === 302);
    const adm = client(); await adm.post('/login', { username: 'admin', password: 'TestAdmin123' });
    r = await adm.get('/team');
    check('owner sees the team page', r.status === 200 && r.text.includes('Your AI staff team'));
    check('AI-key warning shown before key saved', r.text.includes('AI key is not saved'));
    const roles = dba('SELECT key,name,title FROM ai_agents ORDER BY sort');
    check('six fixed agents seeded', roles.length === 6 && ['director', 'secretary', 'content', 'designer', 'support', 'finance'].every((k, i) => roles[i].key === k));
    check('every agent is shown on the page', roles.every(a => r.text.includes(a.name)));
    for (const k of ['director', 'secretary', 'content', 'designer', 'support', 'finance']) { r = await adm.get('/team/agent/' + k); check('workspace opens: ' + k, r.status === 200 && r.text.includes('Responsibilities')); }
    r = await adm.get('/team/agent/nobody'); check('unknown agent is 404', r.status === 404);

    // student cannot enter
    const stu = client();
    await stu.post('/signup', { username: 'teamstu', password: 'Str0ngPass!word1', password2: 'Str0ngPass!word1', confirm: 'Str0ngPass!word1', full_name: 'Team Student', email: 'teamstu-private@example.com', phone: '0770999111', county: 'Montserrado' }, '/signup');
    await stu.post('/login', { username: 'teamstu', password: 'Str0ngPass!word1' });
    r = await stu.get('/team'); check('students cannot open the team area', r.status !== 200);
    r = await stu.post('/team/instruct', { target: 'all', text: 'do evil' }, '/portal'); check('students cannot give instructions', r.status !== 200 || !r.text.includes('Sent to'));

    // no key yet: tasks wait
    await adm.post('/team/tasks', { agent: 'content', title: 'Waiting task', instructions: 'Write a post', priority: 'normal' }, '/team');
    await sleep(1200);
    check('without an AI key the task simply waits (queued)', dbq("SELECT status s FROM ai_tasks WHERE title='Waiting task'").s === 'queued');
    await adm.post('/admin/assistant/key', { api_key: 'sk-ant-test-0123456789abcdefghij' }, '/admin/assistant');
    check('queued task runs after key is saved: work -> Director review -> approved', await waitFor(() => (dbq("SELECT status s FROM ai_tasks WHERE title='Waiting task'") || {}).s === 'approved'));
    let t = dbq("SELECT * FROM ai_tasks WHERE title='Waiting task'");
    check('agent output saved permanently', /^DRAFT: TASK #/.test(t.result || ''), t.result);
    check('Director feedback saved', t.feedback === 'Good and honest work.');
    const lg = dba('SELECT actor,action FROM ai_log WHERE task_id=? ORDER BY id', t.id).map(x => x.actor + ':' + x.action);
    check('Secretary log has assigned/started/submitted/approved', ['owner:task assigned to content', 'content:started', 'content:submitted for approval', 'director:approved'].every(x => lg.includes(x)), lg.join(' | '));
    check('approved work became a report for the owner', !!dbq("SELECT id FROM ai_reports WHERE task_id=? AND body LIKE '%Director''s final feedback%'", t.id));
    check('agents talked in the team chat', !!dbq("SELECT id FROM ai_messages WHERE channel='team' AND sender='content' AND task_id=?", t.id) && !!dbq("SELECT id FROM ai_messages WHERE channel='team' AND sender='director' AND body LIKE '%APPROVED%'"));

    // rejection -> revision
    await adm.post('/team/tasks', { agent: 'designer', title: 'Reject once', instructions: 'REJECT_TEST make a flyer', priority: 'high' }, '/team');
    check('reject then revise then approve', await waitFor(() => (dbq("SELECT status s FROM ai_tasks WHERE title='Reject once'") || {}).s === 'approved'));
    t = dbq("SELECT * FROM ai_tasks WHERE title='Reject once'");
    check('one revision was made with the Director feedback', t.revisions === 1 && /REVISED/.test(t.result));
    check('rejection recorded in log', !!dbq("SELECT id FROM ai_log WHERE task_id=? AND action LIKE 'rejected%'", t.id));

    // unclear review -> owner decides
    await adm.post('/team/tasks', { agent: 'secretary', title: 'Unclear review', instructions: 'UNCLEAR_TEST notes' }, '/team');
    check('unclear Director review waits for the owner', await waitFor(() => (dbq("SELECT status s FROM ai_tasks WHERE title='Unclear review'") || {}).s === 'review'));
    t = dbq("SELECT id FROM ai_tasks WHERE title='Unclear review'");
    r = await adm.get('/team'); check('owner sees it under "Needs your decision"', r.text.includes('Needs your decision') && r.text.includes('Unclear review'));
    await adm.post('/team/tasks/' + t.id + '/approve', { note: 'Fine by me' }, '/team/tasks/' + t.id);
    check('owner can approve', dbq('SELECT status s FROM ai_tasks WHERE id=?', t.id).s === 'approved');
    check('owner decision logged', !!dbq("SELECT id FROM ai_log WHERE task_id=? AND actor='owner' AND action='approved'", t.id));

    // whole-team instruction (plan mode)
    await adm.post('/team/instruct', { target: 'all', text: 'Promote the diploma this week' }, '/team');
    check('whole-team instruction becomes subtasks (invalid ones dropped)', await waitFor(() => dbq("SELECT COUNT(*) n FROM ai_tasks WHERE created_by='director'").n === 2));
    check('subtasks assigned to the right members', !!dbq("SELECT id FROM ai_tasks WHERE agent='content' AND title='Write the diploma post' AND priority='high' AND due_at IS NOT NULL") && !!dbq("SELECT id FROM ai_tasks WHERE agent='finance' AND title='Fees summary'"));
    check('subtasks then complete', await waitFor(() => dbq("SELECT COUNT(*) n FROM ai_tasks WHERE created_by='director' AND status='approved'").n === 2));
    // direct instruction to one member
    await adm.post('/team/instruct', { target: 'support', text: 'Prepare a short FAQ for fees' }, '/team');
    check('instruction to one member creates a task for them', !!dbq("SELECT id FROM ai_tasks WHERE agent='support' AND created_by='owner' AND title LIKE 'Owner instruction%'"));
    // quick preset
    await adm.post('/team/quick', { agent: 'content', i: '0' }, '/team/agent/content');
    check('quick shortcut makes a task', !!dbq("SELECT id FROM ai_tasks WHERE agent='content' AND title='Facebook post'"));
    r = await adm.post('/team/tasks', { agent: 'nobody', title: 'x', instructions: 'y' }, '/team'); r = await adm.get('/team');
    check('invalid agent refused', !dbq("SELECT id FROM ai_tasks WHERE title='x'"));

    // chat
    await adm.post('/team/chat', { channel: 'team', text: 'Hello team from owner' }, '/team/chat');
    r = await adm.get('/team/chat'); check('owner message and Director reply in team chat', r.text.includes('Hello team from owner') && r.text.includes('fake reply'));
    await adm.post('/team/chat', { channel: 'dm:finance', text: 'Daniel, how are fees?' }, '/team/agent/finance');
    check('direct chat reply from Daniel', !!dbq("SELECT id FROM ai_messages WHERE channel='dm:finance' AND sender='finance' AND body LIKE '%fake reply%'"));
    await adm.post('/team/chat', { channel: 'dm:../../x', text: 'bad' }, '/team/chat'); check('bad chat channel refused', !dbq("SELECT id FROM ai_messages WHERE channel LIKE '%x'"));

    // privacy: complaint with personal details never reaches the AI; finance matches DB
    await anon.post('/trust/complaint', { name: 'Secret Person', contact: 'secret-contact@example.com', message: 'The video is slow' }, '/trust');
    await adm.post('/team/instruct', { target: 'support', text: 'Summarise complaints' }, '/team');
    await waitFor(() => dbq("SELECT status s FROM ai_tasks WHERE agent='support' AND title LIKE 'Owner instruction: Summarise%'").s === 'approved');
    const all = prompts.join('\n');
    check('support context includes complaint text', all.includes('The video is slow'));
    check('no names, emails or phones ever sent to the AI', !all.includes('Secret Person') && !all.includes('secret-contact@') && !all.includes('teamstu-private') && !all.includes('0770999111') && !all.includes('sk-ant-test'));
    await adm.post('/team/finance', { kind: 'income', category: 'Tutoring', amount: '25.50', entry_date: '2026-11-01', note: 'test' }, '/team/finance');
    await adm.post('/team/finance', { kind: 'expense', category: '=HYPERLINK("x")', amount: '10', entry_date: '2026-11-02', note: '' }, '/team/finance');
    await adm.post('/team/finance', { kind: 'expense', category: 'Bad', amount: '-5', entry_date: '2026-11-02', note: '' }, '/team/finance');
    check('finance entries saved; negative refused', dbq('SELECT COUNT(*) n FROM finance_entries').n === 2);
    r = await adm.get('/team/finance'); check('finance page shows totals', r.status === 200 && r.text.includes('$25.50'));
    r = await adm.get('/team/finance?format=csv'); check('finance CSV neutralises formulas', r.status === 200 && r.text.includes("\"'=HYPERLINK") && /attachment/.test(r.h.get('content-disposition')));

    // XSS + downloads + csv
    await adm.post('/team/tasks', { agent: 'content', title: 'XSS <b>x</b>', instructions: 'XSS_TEST please' }, '/team');
    await waitFor(() => dbq("SELECT status s FROM ai_tasks WHERE title LIKE 'XSS%'").s === 'approved');
    t = dbq("SELECT id FROM ai_tasks WHERE title LIKE 'XSS%'");
    r = await adm.get('/team/tasks/' + t.id); check('AI text and titles are escaped (no XSS)', !r.text.includes('<script>alert(1)') && r.text.includes('&lt;script&gt;') && !r.text.includes('<b>x</b>'));
    r = await adm.get('/team/tasks/' + t.id + '/download'); check('task downloads as a safe .md attachment', r.status === 200 && /attachment; filename="task-\d+-[a-z0-9-]+\.md"/.test(r.h.get('content-disposition')));
    r = await adm.get('/team/tasks?format=csv'); check('history CSV neutralises formula-like AI text', r.status === 200 && !/,"=cmd/.test(r.text) && r.text.includes('assigned_to'));
    r = await adm.get('/team/tasks?status=approved&agent=content'); check('history filter works', r.status === 200 && r.text.includes('Facebook post'));
    r = await adm.get('/team/log'); check('Secretary log page + CSV', r.status === 200 && (await adm.get('/team/log?format=csv')).text.includes('submitted for approval'));
    const rep = dbq('SELECT id FROM ai_reports ORDER BY id DESC'); r = await adm.get('/team/reports/' + rep.id + '?download=1'); check('report downloads', r.status === 200 && /attachment/.test(r.h.get('content-disposition')));
    r = await adm.get('/team/reports'); check('reports list', r.status === 200 && r.text.includes('Waiting task'));

    // cancel / retry / state rules
    await adm.post('/team/settings', { enabled: '', cap: '60', model: '' }, '/team/settings');
    await adm.post('/team/tasks', { agent: 'content', title: 'Paused team', instructions: 'p' }, '/team'); await sleep(1500);
    check('switched-off team does not work', dbq("SELECT status s FROM ai_tasks WHERE title='Paused team'").s === 'queued');
    t = dbq("SELECT id FROM ai_tasks WHERE title='Paused team'"); await adm.post('/team/tasks/' + t.id + '/cancel', {}, '/team/tasks/' + t.id);
    check('owner can cancel', dbq('SELECT status s FROM ai_tasks WHERE id=?', t.id).s === 'cancelled');
    await adm.post('/team/tasks/' + t.id + '/approve', {}, '/team/tasks/' + t.id); check('cannot approve a cancelled task', dbq('SELECT status s FROM ai_tasks WHERE id=?', t.id).s === 'cancelled');

    // daily cap
    await adm.post('/team/settings', { enabled: 'on', cap: '5', model: 'bad model!' }, '/team/settings');
    check('model name validated', dbq("SELECT value v FROM settings WHERE key='team_model'").v === '');
    const used = dbq("SELECT value v FROM settings WHERE key LIKE 'team_calls_%'").v; const before = calls;
    await adm.post('/team/tasks', { agent: 'finance', title: 'Over cap', instructions: 'cap' }, '/team'); await sleep(2500);
    check('daily AI limit stops further calls', calls === before && dbq("SELECT status s FROM ai_tasks WHERE title='Over cap'").s === 'queued', used + ' calls=' + (calls - before));

    // CSRF
    const raw = await adm.raw('POST', '/team/instruct', { target: 'all', text: 'no token' }); check('forms without CSRF token are refused', raw.status === 403 || raw.status === 400 || !dbq("SELECT id FROM ai_tasks WHERE title LIKE '%no token%'"));
    r = await adm.get('/team'); check('page auto-refresh script is external (CSP safe)', r.text.includes('src="/team.js"') && !/<script>[^<]/.test(r.text));
    check('AI key never shown in team pages', !r.text.includes('sk-ant-test'));
  } finally {
    app.kill(); fake.close();
    console.log(`\n${pass} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
