// Teacher-side data helpers: rosters, attendance %, grade averages.
const { db } = require('./db');
const { decrypt } = require('./crypto');
const { enrollmentRows } = require('./queries');

// Every enrollment in a course with the student's name (decrypted). Only teachers of that course should call this.
function roster(courseId) {
  const rows = enrollmentRows('e.course_id=?', [courseId]);
  const users = db.prepare(`SELECT u.id, u.username, u.full_name_enc FROM users u
    WHERE u.id IN (SELECT user_id FROM enrollments WHERE course_id=?)`).all(courseId);
  const byId = new Map(users.map(u => [u.id, { username: u.username, name: decrypt(u.full_name_enc) }]));
  return rows.map(r => ({ ...r, student_name: byId.get(r.user_id).name, username: byId.get(r.user_id).username }))
    .sort((a, b) => a.student_name.localeCompare(b.student_name));
}

// Map enrollment_id -> { att_pct, att_sessions, grade_pct, graded }
function studentStats(courseId) {
  const out = new Map();
  const get = (id) => { if (!out.has(id)) out.set(id, { att: { present: 0, late: 0, absent: 0, excused: 0 }, score: 0, max: 0, graded: 0 }); return out.get(id); };
  db.prepare(`SELECT ar.enrollment_id id, ar.status, COUNT(*) n FROM attendance_records ar
    JOIN attendance_sessions s ON s.id=ar.session_id WHERE s.course_id=? GROUP BY ar.enrollment_id, ar.status`).all(courseId)
    .forEach(r => { get(r.id).att[r.status] = r.n; });
  db.prepare(`SELECT g.enrollment_id id, SUM(g.score) sc, SUM(gi.max_score) mx, COUNT(*) n FROM grades g
    JOIN grade_items gi ON gi.id=g.item_id WHERE gi.course_id=? GROUP BY g.enrollment_id`).all(courseId)
    .forEach(r => { const s = get(r.id); s.score = r.sc; s.max = r.mx; s.graded = r.n; });
  out.forEach(s => {
    const counted = s.att.present + s.att.late + s.att.absent;           // excused sessions are not counted against the student
    s.att_pct = counted ? Math.round(((s.att.present + s.att.late) * 100) / counted) : null;
    s.att_sessions = counted + s.att.excused;
    s.grade_pct = s.max ? Math.round((s.score * 1000) / s.max) / 10 : null;
  });
  return out;
}
const EMPTY = { att: { present: 0, late: 0, absent: 0, excused: 0 }, att_pct: null, att_sessions: 0, grade_pct: null, graded: 0 };
const statFor = (map, id) => map.get(id) || EMPTY;

module.exports = { roster, studentStats, statFor };
