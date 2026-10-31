# Put the website online without typing commands (Render)

You need: a free GitHub account, a free Render account, and a card for Render (about $7/month plus about $0.25/month
for the 1 GB disk, as listed on Render's pricing page when this was written - check current prices).

**Do not use Render's Free instance type for this site.** Free instances sleep after 15 minutes without visitors and
cannot keep permanent files, so student records, payments and grades stored in the database would be lost.
The paid instance in `render.yaml` keeps the database on a permanent disk.

## One-time setup (about 15 minutes)

1. **Put the code on GitHub**
   - Create a GitHub account, click **New repository**, name it `lgou-portal`, choose **Private**, create it.
   - Unzip the download on your computer. Open the unzipped `lgou` folder, select everything inside it
     (the files `package.json`, `server.js`, `render.yaml` and the folders `lib`, `routes`, `views`, `public`, `scripts`, `test`),
     then on the repository page click **Add file → Upload files** and drag them in. Click **Commit changes**.
   - Make sure `package.json` and `render.yaml` are at the top level of the repository, not inside another folder.
2. **Create the site on Render**
   - Sign up at render.com with your GitHub account.
   - Click **New → Blueprint**, pick your `lgou-portal` repository, and continue.
   - Render shows the plan from `render.yaml`. It asks for one value: **ADMIN_PASSWORD**. Type a strong password
     (this is your admin login; the username is `admin`). Click **Apply / Deploy**.
3. **Wait about 5 minutes.** When the deploy shows **Live**, click the address Render gives you
   (it looks like `https://lgou-portal-xxxx.onrender.com`). Log in at `/login` with `admin` and your password.
4. **Set up the school**: Admin → Settings (payment instructions, teacher fee limit), replace the starter courses,
   then review teacher applications as they arrive.

## Your own web address (optional)
In Render open the service → **Settings → Custom Domains** and follow the steps for a domain you have bought.

## Updating the site later
Upload the changed files to GitHub the same way. Render redeploys automatically. The database stays on the disk.

## Keeping your data safe
- The site makes a database backup every 24 hours onto the same disk, and Render also snapshots the disk daily.
  Those are on the same service, so also download a backup from **Admin → Settings & Backups** now and then and
  keep it elsewhere.
- Render generated your `ENCRYPTION_KEY`. Copy it from the service's **Environment** page and keep it somewhere safe
  and separate: without it, backups cannot be read.
- A service with a disk is down for a few seconds during each deploy. That is normal.
