# Security report - Liberia Gateway Online College portal (7 Nov 2026)

Every item was checked against the code, not assumed. "Tested" = covered by test/security_smoke.js (33 checks, all passing) or the older suites.

| # | Item | Result |
|---|------|--------|
| 1 | Real login, hashed passwords | Already in place: bcrypt cost 12, constant-time check, lock after 5 fails. Tested. |
| 2 | API keys on the server only | Already in place: keys are saved encrypted (AES-256-GCM) in the database or read from host env vars, and are never sent to the browser or shown back. Tested (email/assistant suites). |
| 3 | Users see only their own data | Already in place: every student route re-checks ownership; role re-read from DB each request. Tested (another student gets blocked from payment, lessons, certificate). Note: SQLite has no row-level security, so this is enforced in code, not the database engine. |
| 4 | HTTPS everywhere, server-side checks | FIXED: in production, plain http is redirected (301) and HSTS is sent; cookies are Secure automatically. All form input is validated on the server. Tested. |
| 5 | XSS and SQL injection | Already in place: strict CSP (no inline scripts), all output escaped, all queries parameterised (3 dynamic column names come from fixed allow-lists). Tested. |
| 6 | Login rate limit, CSRF, secure cookies | CSRF + login limiter existed. ADDED: a 60/min per-IP cap on every data-changing request. Cookies: HttpOnly, SameSite=Lax, Secure in production. Tested. |
| 7 | Password reset links expire | There is NO reset link: the office issues a temporary password. FIXED: that password must be changed at next login, all the user's old sessions are signed out, and changing a password signs out other devices. Tested. |
| 8 | Limit file uploads | The app has no file upload feature, so nothing to exploit. Certificates are generated, not uploaded. |
| 9 | Lock admin pages | Already in place and tested. |
| 10 | Recheck every price on the server | Already in place: fees come from the database; amounts above the balance or negative are refused; students cannot confirm their own payments. Tested. |
| 11 | Debug mode off | No debug mode exists; errors show a generic page, never stack traces. Tested. |
| 12 | Update risky packages | npm audit: 0 vulnerabilities (nodemailer was upgraded earlier). |
| 13 | Delete unused packages | None found (ejs is used as the template engine). |
| 14 | Scan git history for leaked keys | 14 commits scanned for API-key, token and private-key patterns: nothing real. Only fake values inside test files. No .env or database was ever committed. Nothing to rotate. |

## Still your job
- On your host set NODE_ENV=production, TRUST_PROXY=1 (already in render.yaml) and your own ENCRYPTION_KEY and SESSION_SECRET.
- Change the admin password after first login; add your Brevo / Anthropic keys only in Admin > Settings or host env vars.
- Free Render/Vercel demos lose data; use the paid plan with a disk for real students.
- Not tested against real Brevo/Anthropic/Windows; a professional penetration test is advisable before handling real money.
