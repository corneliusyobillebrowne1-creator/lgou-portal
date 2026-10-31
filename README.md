# Liberia Gateway Online University – Teacher & Student Portal

Public website, student portal, **teacher platform** and admin/ERP dashboard, with encrypted data and
database backups. Node.js + Express + SQLite (one database file, no separate server to install).

## Run it

Requires Node.js 18 or newer.

```bash
npm install
npm start            # http://localhost:3000
```

The first start creates the admin account and prints the username and a random password **once**.
To choose your own: `ADMIN_USERNAME=registrar ADMIN_PASSWORD='ChooseAStrongOne9' npm start`.
Log in at `/login`, then change the password under **Account**.

**Want it online without commands?** See `DEPLOY.md` (one-click Render setup using `render.yaml`).

**Upgrading from the first version?** Just start the new code on your existing `data/` folder. The
database is upgraded in place (students, payments and certificates are kept).

## How it works

| Who | What they do |
|---|---|
| **Visitor** | Sees courses, fees, teacher profiles, how to enroll, how to apply as a teacher, about the school, and can verify a certificate |
| **Teacher** | Applies at `/teach` → admin reviews → once approved gets a dashboard: create courses, set a small fee, paste their Google Classroom link, make student lists, mark attendance, record grades, view each student's progress, recommend finishing students for a certificate |
| **Student** | Signs up, enrols, pays the fee, then clicks **Join Google Classroom** in the portal for live lessons, live quizzes and assignments; sees own attendance and grades; requests a certificate |
| **Admin** | Reviews teacher applications and teacher courses, confirms payments, oversees all students/teachers/payments, approves completions, issues and revokes certificates, backups |

### Google Classroom integration
The portal **does not build live video or quizzes**. Each teacher pastes the invite link of their own
Google Classroom (`https://classroom.google.com/...` only – anything else is rejected). Live lessons,
live quizzes and assignments happen there. The portal keeps the records that Classroom does not:
enrolment, fees, attendance, grades, progress, certificates.

- The Classroom link is **never printed on public pages**. Students reach it through
  `/portal/classroom/<enrolment>`, which only redirects once the fee is **confirmed**, the course is
  approved and the teacher is still approved. Suspending a teacher cuts off access immediately.
- Google may ask the teacher to admit a student the first time they join. Teachers can also invite students
  by email inside Classroom.
- Quiz scores from Classroom are typed into the teacher's gradebook here.

### Teacher approval and course approval
1. A teacher applies (account is created, but only a status page works until approved).
2. Admin → **Teachers** → approve / reject / suspend, each with a note the teacher can see.
3. Approved teachers create courses; fees are capped (default $50, change under Admin → Settings).
4. Admin → **Course approvals** → approve / reject. Only approved courses (of approved teachers) appear on the website
   and can be enrolled in. Rejected courses show the reason and can be resubmitted.

### Certificates for teacher courses
The teacher enters a final score and clicks **Recommend**; the student can then request the certificate and
the admin team gives the final approval (score pre-filled). School video courses still complete by watching all lessons.

## Security built in

- Passwords hashed with bcrypt (cost 12); strength rules; account lock after 5 failed logins; login rate limits
- Names, emails, phone numbers and payment references encrypted in the database (AES-256-GCM); emails checked for duplicates through a keyed hash
- Three separate roles (student / teacher / admin). Every request re-checks the role from the database; teachers can only ever load **their own** courses, lists, attendance sheets and gradebooks; students only their own records
- Teachers see student **names and usernames only** – never emails, phone numbers or payment references
- Teacher applications cannot use tools until approved; suspending a teacher hides their profile and courses
- Sessions stored server-side, HttpOnly + SameSite cookies, new session id at login, 2-hour idle timeout
- CSRF token on every form; all database queries parameterised; templates auto-escape output; no inline scripts (strict Content-Security-Policy)
- Optional admin IP allow-list; activity log of logins and admin/teacher actions

## Backups

Automatic every 24 hours into `backups/` (newest 14 kept); Admin → Settings & Backups has "Back up now";
`npm run backup` works from cron. Backups hold encrypted data: keep a copy of the key (`data/.enc.key`
or your `ENCRYPTION_KEY`) **separately**, and copy backups off the server regularly.

## Going live checklist

1. Serve over **HTTPS**, then set `COOKIE_SECURE=true`, `NODE_ENV=production`, and `TRUST_PROXY=1` if behind a proxy.
2. Set `ENCRYPTION_KEY` and `SESSION_SECRET` as environment variables and keep them out of the code folder.
3. Keep `data/` and `backups/` private and backed up off-site.
4. Edit the payment instructions and fee cap (Admin → Settings). The four starter courses are examples
   (placeholder fees, no videos) – replace or close them.
5. Optional: `ADMIN_ALLOWED_IPS=1.2.3.4` to limit the admin dashboard.
6. Decide who is allowed to teach: admin review is the only gate, so read applications carefully
   (consider asking applicants for references or ID in person before approving).

## Environment variables

`PORT`, `HOST`, `NODE_ENV`, `COOKIE_SECURE`, `TRUST_PROXY`, `ENCRYPTION_KEY`, `SESSION_SECRET`,
`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_ALLOWED_IPS`, `DATA_DIR`, `BACKUP_DIR`.

## Tests

With a server running on a **fresh** `DATA_DIR`:

```bash
BASE=http://localhost:3000 ADMIN_PASSWORD=... node test/smoke.js                       # students, YouTube lessons, certificates
BASE=http://localhost:3000 ADMIN_PASSWORD=... DATA_DIR=./data node test/teacher_smoke.js   # teachers, Classroom, attendance, grades, isolation
```

## Good next features

Email notifications and password reset by email; upload of teacher ID/credential documents; automatic
mobile-money gateway; teacher payouts / revenue share reports; PDF certificate download with QR code;
CSV export of attendance and grades; Google sign-in; multiple admin roles (registrar / accountant).
