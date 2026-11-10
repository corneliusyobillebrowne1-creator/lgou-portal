# Automation with n8n (optional)

n8n is a separate free tool (n8n.io, cloud or self-hosted). The college website talks to it in two directions.
Nothing here is tested against a real n8n, WhatsApp or SMS service yet: try it with a test message first.

## A. Website -> n8n (send texts when things happen)
1. In n8n create a workflow that starts with a **Webhook** node (method POST). Copy its production URL.
2. Website: Admin > Quality & growth > **Automation & social**. Paste the URL, choose "Send events to n8n: Yes".
   If you want n8n to text students, set "Include the student's phone number" to Yes.
3. Press **Create secret** and copy it into n8n (it is shown once). Press **Send test event**.
4. In n8n, check the signature before trusting an event: HMAC-SHA256 of the raw request body with the secret, hex, compared to the header `x-lgoc-signature` (format `sha256=<hex>`).
5. Add a **Switch** on `event`, then a WhatsApp / SMS node for each:
   - `student_signed_up`: welcome message
   - `payment_submitted`: "we received your payment, the office will confirm"
   - `payment_confirmed`: "payment confirmed, balance X"
   - `certificate_issued`: "your certificate is ready"
   - `complaint_received`, `question_asked`, `teacher_applied`: notify the office
   Events never contain passwords, payment references or complaint text.

## B. n8n -> website (AI answers to incoming messages)
1. Press **Create token** on the Automation page (shown once).
2. In n8n: trigger on an incoming WhatsApp/SMS message -> **HTTP Request** node:
   POST `https://YOUR-SITE/api/n8n/ask`, header `Authorization: Bearer <token>`, JSON body `{"question": "<the message text>"}`.
   The reply JSON is `{"answer": "..."}`; send that back with a WhatsApp/SMS node.
3. The AI only knows public college information. It cannot see any student's account.

## About the number 0880 035 290
A number is not connected by the website itself. WhatsApp automation needs a **WhatsApp Business Platform (Cloud API)** account from Meta, and a number that is not already on a normal WhatsApp app. SMS needs a provider that serves Liberia. Until then, use the free **WhatsApp Business app** (auto-greeting + quick replies) on that phone. Put the number in the "School WhatsApp number" box to add a Chat link to the site.
