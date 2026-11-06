# Setting up email (receipts and certificates)

Students get an email when:
- a payment is confirmed: a **receipt**; once the fee is fully paid it also says they are **selected and approved** for the course;
- you approve completion: their **certificate, diploma or AA degree as a PDF**.
Students can also press "Email me a copy" in their portal, and you can resend anything from **Admin > Emails**.

The college needs an email service to send them. Easiest free option: **Brevo** (brevo.com, free plan is about 300 emails a day; check their current limits).

1. Create a free Brevo account.
2. Add and verify a **sender** email address (Brevo emails you a link). Use an address you own, for example your school Gmail.
3. In Brevo open **SMTP & API** and create an **API key**. Copy it.
4. In the college site: **Admin > Settings > Email**. Choose "Brevo (HTTPS API)", type the sender name, the verified sender address, paste the API key, and press **Save email settings**.
5. Type your own email in "Send a test email to" and press **Send test email**. Check the inbox and the spam folder.

Your API key is stored encrypted and never shown again. Do not send it to anyone.

## On free hosting that wipes the database
Settings are stored in the database, so a wipe removes them. Instead, add these in the host's Environment Variables:
`BREVO_API_KEY`, `MAIL_FROM_EMAIL` (your verified sender), `MAIL_FROM_NAME`. The site then sends email automatically with no setup page. Also set `SITE_URL` to your public link (for example `https://lgoc-college.onrender.com`) so links in emails are correct.

## Notes
- Emails use each student's sign-up email address. If a student has no valid address, the email is skipped and shown as failed in Admin > Emails.
- SMTP also works (Settings > Email > SMTP), but free hosts such as Render's free plan block SMTP ports, so use Brevo there.
