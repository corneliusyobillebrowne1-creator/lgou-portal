function money(cents) {
  return '$' + (Number(cents || 0) / 100).toFixed(2);
}

// "12.50" -> 1250 ; returns null if invalid
function parseMoney(s) {
  s = String(s || '').trim().replace(/^\$/, '');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

// Accepts a YouTube URL (watch, youtu.be, embed, shorts) or a bare 11-char id. Returns id or null.
function youtubeId(input) {
  const s = String(input || '').trim();
  const ok = (id) => (id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null);
  if (ok(s)) return s;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  const host = u.hostname.replace(/^(www|m)\./, '');
  if (host === 'youtu.be') return ok(u.pathname.slice(1).split('/')[0]);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') return ok(u.searchParams.get('v'));
    const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([^/?]+)/);
    if (m) return ok(m[2]);
  }
  return null;
}

// Google Classroom link: must be https on classroom.google.com, nothing else (stops teachers pasting look-alike or phishing links).
function classroomUrl(input) {
  const s = String(input || '').trim();
  if (!s || s.length > 300) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'classroom.google.com' || u.username || u.password || u.port) return null;
  if (u.pathname.length < 3) return null;
  return u.href;
}

// "" -> null (no score) ; "12.5" -> 12.5 ; anything else -> NaN
function parseScore(s) {
  s = String(s === undefined ? '' : s).trim();
  if (s === '') return null;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) return NaN;
  return parseFloat(s);
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 2020 && d.getUTCFullYear() <= 2100;
}

function passwordProblem(pw) {
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 100) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain at least one letter and one number.';
  return null;
}

const COUNTIES = ['Bomi', 'Bong', 'Gbarpolu', 'Grand Bassa', 'Grand Cape Mount', 'Grand Gedeh', 'Grand Kru', 'Lofa', 'Margibi',
  'Maryland', 'Montserrado', 'Nimba', 'River Cess', 'River Gee', 'Sinoe', 'Outside Liberia'];

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}

function fmtDate(d) {
  if (!d) return '';
  let s = String(d);
  if (!s.includes('T')) s = s.replace(' ', 'T') + 'Z';
  const dt = new Date(s);
  return isNaN(dt) ? String(d) : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const DISCLAIMER =
  'Liberia Gateway Online University is a private, learning-focused online school. All certificates and diplomas ' +
  'issued through this portal are awarded by Liberia Gateway Online University only. Unless stated otherwise, they are ' +
  'not government degrees and are not issued or endorsed by YouTube, Google or the creators of the video lessons used ' +
  'as study material. Anyone can check a certificate on the Verify Certificate page.';

const CLASSROOM_NOTE =
  'Live lessons, live quizzes and class work take place in each teacher\'s own Google Classroom. This portal does not host video ' +
  'calls or quizzes itself; it handles registration, fees, enrolment records, attendance, grades and certificates, and links ' +
  'enrolled students to their teacher\'s Classroom. Google and Google Classroom are trademarks of Google LLC; this school is not affiliated with Google.';

module.exports = { money, parseMoney, youtubeId, fmtDate, DISCLAIMER, classroomUrl, parseScore, validDate, passwordProblem, COUNTIES, initials, CLASSROOM_NOTE };
