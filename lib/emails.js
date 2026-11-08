const { db } = require('./db');
const { decrypt } = require('./crypto');
const { money, fmtDate, DISCLAIMER } = require('./util');
const { sendToUser } = require('./mailer');
const site = require('./site');
const { buildCertificatePdf } = require('./certpdf');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baseUrl = (req) => (process.env.SITE_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
const KIND = { associate: 'Associate of Arts (AA) Degree', diploma: 'Diploma', certificate: 'Certificate' };

function wrap(inner) {
  const info = site.info();
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:auto;color:#1b1b1b">
  <div style="background:#0b2a5b;color:#fff;padding:16px 20px;border-bottom:4px solid #c9971c"><strong style="font-size:18px">Liberia Gateway Online College</strong></div>
  <div style="padding:20px;line-height:1.5">${inner}</div>
  <div style="padding:14px 20px;font-size:12px;color:#666;border-top:1px solid #ddd">${esc(info.contact)}<br><br>${esc(DISCLAIMER)}</div></div>`;
}
const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;color:#555">${esc(k)}</td><td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`;

// ---- payment receipt (+ "selected and approved" once the fee is fully paid) ----
function receiptBuilder(paymentId, base) {
  return async ({ name }) => {
    const p = db.prepare(`SELECT p.*, c.title AS course_title, c.type AS course_type, c.class_schedule, e.fee_cents, e.id AS enrollment_id
      FROM payments p JOIN enrollments e ON e.id=p.enrollment_id JOIN courses c ON c.id=e.course_id WHERE p.id=? AND p.status='confirmed'`).get(paymentId);
    if (!p) throw new Error('payment');
    const paid = db.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM payments WHERE enrollment_id=? AND status='confirmed'").get(p.enrollment_id).n;
    const balance = Math.max(0, p.fee_cents - paid), full = balance === 0;
    const no = 'RCT-' + String(p.created_at || '').slice(0, 4) + '-' + String(p.id).padStart(5, '0');
    const level = KIND[p.course_type] || 'course';
    const status = full
      ? `<p style="background:#e8f5e9;border-left:4px solid #2e7d32;padding:10px 12px"><strong>Congratulations, ${esc(name)}! You have been selected and approved for ${esc(p.course_title)}.</strong><br>Your fee is fully paid and your place is confirmed. Log in to your student portal to start.${p.class_schedule ? '<br>Class times: ' + esc(p.class_schedule) + ' (Liberia time).' : ''}</p>`
      : `<p style="background:#fff8e1;border-left:4px solid #c9971c;padding:10px 12px">Your payment has been received. Balance remaining: <strong>${esc(money(balance))}</strong>. Your place in <strong>${esc(p.course_title)}</strong> is approved as soon as the full fee is paid.</p>`;
    const html = wrap(`<h2 style="margin-top:0">Payment receipt</h2><p>Dear ${esc(name)},</p><p>Thank you. The college has confirmed your payment.</p>
      <table style="border-collapse:collapse">${row('Receipt no.', no)}${row('Date', fmtDate(p.reviewed_at || p.created_at))}${row('Programme', p.course_title + ' (' + level + ')')}
      ${row('Amount paid now', money(p.amount_cents))}${row('Payment method', p.method)}${row('Total paid so far', money(paid))}${row('Programme fee', money(p.fee_cents))}${row('Balance', money(balance))}</table>
      ${status}<p><a href="${esc(base)}/portal" style="background:#0b2a5b;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px;display:inline-block">Open my student portal</a></p>`);
    const text = `Payment receipt ${no}\n\nDear ${name},\nThe college has confirmed your payment of ${money(p.amount_cents)} (${p.method}) for ${p.course_title}.\nTotal paid: ${money(paid)} of ${money(p.fee_cents)}. Balance: ${money(balance)}.\n` +
      (full ? `\nYou have been selected and approved for ${p.course_title}. Log in: ${base}/portal\n` : `\nYour place is approved when the full fee is paid.\n`) + '\nLiberia Gateway Online College';
    return { subject: (full ? 'Approved: ' + p.course_title + ' - receipt ' : 'Payment receipt ') + no, html, text };
  };
}
function emailReceipt(paymentId, base) {
  const p = db.prepare('SELECT user_id FROM payments WHERE id=?').get(paymentId);
  if (!p) return Promise.resolve({ ok: false, error: 'Payment not found.' });
  return sendToUser(p.user_id, 'receipt', paymentId, receiptBuilder(paymentId, base));
}

// ---- certificate / diploma / AA degree, with the PDF attached ----
function certificateBuilder(certId, base) {
  return async ({ name }) => {
    const c = db.prepare("SELECT * FROM certificates WHERE id=? AND status='valid'").get(certId);
    if (!c) throw new Error('certificate');
    const studentName = decrypt(c.student_name_enc);
    const pdf = await buildCertificatePdf({ ...c, student_name: studentName }, base);
    const kind = KIND[c.course_type] || 'Certificate';
    const html = wrap(`<h2 style="margin-top:0">Congratulations, ${esc(name)}!</h2>
      <p>You have successfully completed <strong>${esc(c.course_title)}</strong>. Your <strong>${esc(kind)}</strong> from Liberia Gateway Online College is attached to this email as a PDF.</p>
      <table style="border-collapse:collapse">${row('Certificate no.', c.cert_no)}${row('Verification code', c.verify_code)}${row('Issued', fmtDate(c.issued_at))}</table>
      <p>Anyone can check it at <a href="${esc(base)}/verify">${esc(base)}/verify</a> using the number and code above. You can also open or print it any time from your student portal.</p>`);
    const text = `Congratulations ${name}!\nYour ${kind} for ${c.course_title} is attached (PDF).\nCertificate no: ${c.cert_no}\nVerification code: ${c.verify_code}\nVerify at ${base}/verify\n\nLiberia Gateway Online College`;
    return { subject: 'Your ' + kind + ': ' + c.course_title, html, text, attachments: [{ filename: c.cert_no + '.pdf', content: pdf, contentType: 'application/pdf' }] };
  };
}
function emailCertificate(certId, base) {
  const c = db.prepare('SELECT e.user_id FROM certificates c JOIN enrollments e ON e.id=c.enrollment_id WHERE c.id=?').get(certId);
  if (!c) return Promise.resolve({ ok: false, error: 'Certificate not found.' });
  return sendToUser(c.user_id, 'certificate', certId, certificateBuilder(certId, base));
}

const note = (r, what) => (r.ok ? ` ${what} emailed to the student.` : ` (Email not sent: ${r.error})`);
module.exports = { emailReceipt, emailCertificate, baseUrl, note, esc, wrap };
