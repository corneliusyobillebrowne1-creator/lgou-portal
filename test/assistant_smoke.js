// Tests the AI assistant against a FAKE Anthropic server (no real API calls, no cost).
// Run via: node test/assistant_smoke.js  (it starts the fake API and the app itself)
const http = require('http'), { spawn } = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const APP = 4510, FAKE = 4511, BASE = 'http://localhost:' + APP;
let pass = 0, failed = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { failed++; console.log('  FAIL ' + n + (x ? ' -> ' + x : '')); } };

const seenKeys = [];
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    seenKeys.push(req.headers['x-api-key']);
    const j = JSON.parse(b), last = j.messages[j.messages.length - 1];
    const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (Array.isArray(last.content) && last.content[0].type === 'tool_result') return send({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'RESULT ' + last.content.map(c => c.content).join(' | ') }] });
    const t = String(last.content);
    const tool = (name, input) => send({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name, input }] });
    if (t.includes('BADKEY')) { res.statusCode = 401; return res.end('{}'); }
    if (t.includes('finance')) return tool('get_overview', {});
    if (t.includes('rewrite')) return tool('update_course_text', { course_id: 5, summary: 'Learn Word, Excel and PowerPoint step by step.' });
    if (t.includes('fee')) return tool('propose_fee_change', { course_id: 5, new_fee_usd: 30, reason: 'test' });
    if (t.includes('confirm')) return tool('confirm_payment', { payment_id: 1 });
    send({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello admin' }] });
  });
});

function client() {
  const jar = {};
  const req = async (m, p, form) => {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') };
    let body; if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(BASE + p, { method: m, headers, body, redirect: 'manual' });
    (r.headers.getSetCookie() || []).forEach(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); });
    return { status: r.status, text: await r.text(), loc: r.headers.get('location') };
  };
  const csrf = (h) => (h.match(/name="_csrf" value="([a-f0-9]+)"/) || [])[1];
  return { get: (p) => req('GET', p), post: async (p, f, tp) => req('POST', p, { ...f, _csrf: csrf((await req('GET', tp || '/login')).text) }) };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgou-ai-'));
  await new Promise(r => fake.listen(FAKE, r));
  const app = spawn('node', ['server.js'], { env: { ...process.env, PORT: APP, DATA_DIR: dir + '/data', BACKUP_DIR: dir + '/b', ADMIN_PASSWORD: 'TestAdmin123', ANTHROPIC_BASE_URL: 'http://localhost:' + FAKE }, stdio: 'ignore' });
  await sleep(3000);
  const Database = require('better-sqlite3');
  const dbq = (sql, ...a) => { const d = new Database(dir + '/data/lgou.db', { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
  try {
    const anon = client();
    let r = await anon.get('/admin/assistant');
    check('assistant page is closed to visitors', r.status === 302 && /login/.test(r.loc || ''), r.status + ' ' + r.loc);
    const adm = client();
    await adm.post('/login', { username: 'admin', password: 'TestAdmin123' });
    r = await adm.get('/admin/assistant');
    check('admin sees assistant page, key not set', r.status === 200 && r.text.includes('No key. Assistant is off.'));
    r = await adm.post('/admin/assistant/ask', { message: 'hello' }, '/admin/assistant');
    r = await adm.get('/admin/assistant');
    check('asking without a key is refused', r.text.includes('Save an API key first'));
    await adm.post('/admin/assistant/key', { api_key: 'sk-ant-test-0123456789abcdefghij' }, '/admin/assistant');
    r = await adm.get('/admin/assistant');
    check('key saved', r.text.includes('Key saved'));
    const stored = dbq("SELECT value v FROM settings WHERE key='ai_api_key_enc'").v;
    check('key is stored encrypted, not in plain text', stored && !stored.includes('sk-ant-test'));
    check('key is never shown back on the page', !r.text.includes('sk-ant-test'));

    await adm.post('/admin/assistant/ask', { message: 'hello' }, '/admin/assistant');
    r = await adm.get('/admin/assistant');
    check('assistant replies', r.text.includes('Hello admin'));
    check('API key was sent to the AI service', seenKeys.includes('sk-ant-test-0123456789abcdefghij'));

    await adm.post('/admin/assistant/ask', { message: 'finance please' }, '/admin/assistant');
    r = await adm.get('/admin/assistant');
    check('read tool works (overview returned to model)', r.text.includes('RESULT') && r.text.includes('collected'));

    const before = dbq('SELECT summary s FROM courses WHERE id=5').s;
    await adm.post('/admin/assistant/ask', { message: 'rewrite it' }, '/admin/assistant');
    check('edit applied to course text', dbq('SELECT summary s FROM courses WHERE id=5').s === 'Learn Word, Excel and PowerPoint step by step.');
    const act = dbq("SELECT id FROM ai_actions WHERE kind='edit' AND status='applied'");
    check('edit is logged', !!act);
    r = await adm.post('/admin/assistant/actions/' + act.id + '/undo', {}, '/admin/assistant');
    check('undo restores the original text', dbq('SELECT summary s FROM courses WHERE id=5').s === before);

    const feeBefore = dbq('SELECT fee_cents f FROM courses WHERE id=5').f;
    await adm.post('/admin/assistant/ask', { message: 'change the fee' }, '/admin/assistant');
    check('fee proposal does NOT change the fee', dbq('SELECT fee_cents f FROM courses WHERE id=5').f === feeBefore);
    const prop = dbq("SELECT id FROM ai_actions WHERE kind='fee' AND status='pending'");
    check('fee proposal waits for approval', !!prop);
    r = await adm.get('/admin/assistant');
    check('proposal visible with Approve button', r.text.includes('Approve'));
    await adm.post('/admin/assistant/actions/' + prop.id + '/approve', {}, '/admin/assistant');
    check('admin approval applies the fee', dbq('SELECT fee_cents f FROM courses WHERE id=5').f === 3000);

    const payBefore = dbq("SELECT COUNT(*) n FROM payments WHERE status='confirmed'").n;
    await adm.post('/admin/assistant/ask', { message: 'confirm the payment' }, '/admin/assistant');
    r = await adm.get('/admin/assistant');
    check('payment confirmation is not possible for the assistant', r.text.includes('Unknown tool') && dbq("SELECT COUNT(*) n FROM payments WHERE status='confirmed'").n === payBefore);

    await adm.post('/admin/assistant/ask', { message: 'BADKEY' }, '/admin/assistant');
    r = await adm.get('/admin/assistant');
    check('rejected key gives a friendly message', r.text.includes('API key was rejected'));

    // a student must not reach it
    const stu = client();
    await stu.post('/signup', { username: 'aistudent', password: 'Str0ngPass!word1', password2: 'Str0ngPass!word1', confirm: 'Str0ngPass!word1', full_name: 'AI Student', email: 'ai@example.com', phone: '', county: 'Montserrado' }, '/signup');
    await stu.post('/login', { username: 'aistudent', password: 'Str0ngPass!word1' });
    r = await stu.get('/admin/assistant');
    check('students cannot open the assistant', r.status !== 200);
    r = await stu.post('/admin/assistant/actions/' + prop.id + '/approve', {}, '/portal');
    check('students cannot approve proposals', r.status !== 200 || !r.text.includes('Fee change approved'));
  } finally {
    app.kill(); fake.close();
    console.log(`\n${pass} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
