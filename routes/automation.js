// Public chat box endpoint + the token-protected endpoint n8n calls.
const router = require('express').Router();
const express = require('express');
const rateLimit = require('express-rate-limit');
const ai = require('../lib/collegeai');
const n8n = require('../lib/n8n');
const site = require('../lib/site');

const FALLBACK = () => 'Sorry, the assistant is not available right now. ' + site.info().contact;
const lim = (max) => rateLimit({ windowMs: 60 * 1000, max, standardHeaders: true, legacyHeaders: false, handler: (req, res) => res.status(429).json({ answer: 'Please slow down a little and try again in a minute.' }) });

function cleanHistory(raw) {
  try { const a = JSON.parse(String(raw || '[]')); return Array.isArray(a) ? a.slice(-4).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string').map(m => ({ role: m.role, text: m.text.slice(0, 500) })) : []; } catch { return []; }
}
async function reply(q, h) {
  q = String(q || '').trim();
  if (q.length < 2) return { status: 400, answer: 'Please type your question.' };
  try {
    const answer = await ai.answer(q, h);
    // Grace (AI Support Officer) keeps the last 90 days of website chat so she can write support summaries.
    try { require('../lib/db').db.prepare('INSERT INTO support_chats (question, answer) VALUES (?,?)').run(q.slice(0, 400), answer.slice(0, 1500)); } catch (e) { /* table is created by lib/team.js */ }
    return { status: 200, answer };
  }
  catch (e) { return { status: 503, answer: e.message === 'busy' ? 'Lots of people are asking right now. ' + site.info().contact : FALLBACK() }; }
}

// website chat box (same-origin form post, CSRF-protected by the site-wide check)
router.post('/ask-college', lim(8), async (req, res) => { const r = await reply(req.body.q, cleanHistory(req.body.h)); res.status(r.status).json({ answer: r.answer }); });

// n8n -> site: Authorization: Bearer <token>. Not cookie-based, so no CSRF; the token is the protection.
router.post('/api/n8n/ask', lim(120), express.json({ limit: '10kb' }), async (req, res) => {
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!n8n.tokenOk(t)) return res.status(401).json({ error: 'Invalid token.' });
  const r = await reply(req.body && req.body.question, []);
  res.status(r.status).json({ answer: r.answer });
});
module.exports = router;
