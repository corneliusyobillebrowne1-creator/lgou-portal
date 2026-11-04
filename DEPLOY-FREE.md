# Quick free link to show friends (Render free plan)

This gives you a public web address like `https://lgoc-college.onrender.com` in about 10 minutes, with no card needed to start.

**Important: this is a demo link, not a real school server.**
- The free plan goes to sleep after 15 minutes without visitors. The next visitor waits about a minute while it wakes up.
- The free plan cannot keep files. Every time it sleeps, restarts or is redeployed, the database is wiped and starts fresh (accounts, payments, announcements and edits are lost; the built-in courses come back).
- Use it to show the website to friends. Before real students pay money, move to the paid plan with a disk (see `DEPLOY.md`).

## Steps
1. Go to https://render.com and sign up (you can use your GitHub login).
2. Click **New +** then **Web Service**, choose **Public Git Repository**, and paste:
   `https://github.com/corneliusyobillebrowne1-creator/lgou-portal`
   then **Connect**.
3. Fill in:
   - Name: `lgoc-college` (this becomes part of your link)
   - Branch: `main`  -  Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. Under **Environment Variables** add these (you type the values yourself; never share the admin password):

   | Name | Value |
   |---|---|
   | NODE_VERSION | 22 |
   | NODE_ENV | production |
   | COOKIE_SECURE | true |
   | TRUST_PROXY | 1 |
   | ADMIN_USERNAME | admin |
   | ADMIN_PASSWORD | a strong password you choose (letters + numbers, 12+ characters) |
   | ENCRYPTION_KEY | any long random text (40+ characters) |
   | SESSION_SECRET | another long random text (40+ characters) |

5. Click **Create Web Service**. Wait for "Live" (about 3-5 minutes), then open your link and send it to friends.
6. Admin login: `<your link>/login` with `admin` and the password from step 4.

## Updating the site later
Push the new files to the GitHub repository; Render redeploys automatically (and the demo database resets).
