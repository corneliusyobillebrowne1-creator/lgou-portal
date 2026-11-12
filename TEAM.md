# Your AI staff team (Director, Secretary, Content, Designer, Support, Finance)

Open **AI Team** in the admin menu (or go to `/team`). Only the admin/owner login can enter.

## Set up (2 minutes)
1. Log in as admin. Go to **Admin → AI assistant** and save your Anthropic API key (stored encrypted).
2. Open **AI Team → Settings**. Choose a daily AI-call limit (default 60) so your bill cannot run away.
3. Press a **Quick task** on any member, or send an instruction on the Overview page.

## The six members (always labelled AI)
| Member | Job |
|---|---|
| Samuel – Director | Plans, assigns, reviews, approves/rejects, final feedback to you |
| Miriam – Secretary | Records, summaries, notes, reminders; her **log** keeps every task, date, submission and decision |
| Joe – Content & Social | Posts, captions, articles, scripts for Facebook/TikTok/YouTube/Instagram |
| Ruth – Designer | Flyer/poster/thumbnail concepts, image prompts, storyboards, branding |
| Grace – Support | Reads website-chat questions and complaints, writes support summaries and FAQs |
| Daniel – Finance | Income/expense summaries from payments + your finance records |

## How work flows
You (or the Director) give a task → the member writes it → it goes to the Director → the Director **approves** (saved as a report) or **rejects** with feedback (member rewrites, up to 2 times). If the Director's answer is unclear, or the work is the Director's own or a report, it waits for **your** decision. You can approve, send back, retry or cancel any task at any time.
"Whole team" instructions go to the Director, who turns them into up to 6 tasks.

## Where everything is
Work history (filter + CSV), Team chat, Reports (download .md), Secretary's log (CSV), Finance records (CSV). Everything is saved permanently in the college database and is included in your backups.

## Important honesty notes
- The members are AI. They only **write drafts**. They cannot post to social media, send emails/WhatsApp, move money or change the website. You copy what you approve.
- AI can be wrong. The Director's review is also AI, so **you have the final say**. Check numbers and claims before using them.
- Student names, phone numbers and emails are never sent to the AI. Complaint and chat text is sent (visitors might type personal details into it). Website-chat questions are kept 90 days.
- 24/7 work needs an always-on host (Render paid plan). On Vercel/free hosting the background worker cannot run: use **Run pending work now**.
- Tested only with a fake AI server, not against the live AI service.
- Optional: **Settings → Daily summaries** makes the Secretary and Support write a summary every day (and Daniel on Mondays), with no action from you.
