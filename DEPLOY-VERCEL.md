# Free demo link on Vercel

**Demo only.** Vercel runs the site as short-lived "serverless" functions with no permanent disk. That means:
- The database lives in temporary storage that is wiped whenever Vercel restarts or scales the function (often after a few minutes of no visitors).
- Several copies can run at once, each with its own empty database, so a friend who signs up may later appear "logged out" or find their account missing.
- Browsing works well (homepage, programmes, admissions, about, course pages). Treat sign-ups, payments and teacher areas as a preview.
- For a link where logins reliably work for a while, use Render (`DEPLOY-FREE.md`). For real students and money, use the paid plan in `DEPLOY.md`.

## Steps
1. Go to https://vercel.com and sign up with GitHub.
2. Click **Add New... > Project**, find `lgou-portal` in your GitHub list and click **Import**.
3. Leave **Framework Preset** as "Other" and leave Build/Output settings empty.
4. Open **Environment Variables** and add (type the values yourself; never share them):

   | Name | Value |
   |---|---|
   | NODE_ENV | production |
   | COOKIE_SECURE | true |
   | TRUST_PROXY | 1 |
   | ADMIN_USERNAME | admin |
   | ADMIN_PASSWORD | a strong password (letters + numbers, 12+ characters) |
   | ENCRYPTION_KEY | any long random text (40+ characters) |
   | SESSION_SECRET | another long random text (40+ characters) |

5. Click **Deploy**. After about a minute Vercel shows your link, like `https://lgou-portal.vercel.app`.
6. Admin login: `<your link>/login` with `admin` and your password.

If a page shows an error after deploying, open the project in Vercel, go to **Logs**, and send me the error text (not your passwords).
