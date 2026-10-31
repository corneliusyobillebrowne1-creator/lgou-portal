const { db } = require('./db');
const { decrypt } = require('./crypto');

// A course is visible to the public / open to enrolment only when: open, approved by admin,
// and (if run by a teacher) that teacher is still approved and active.
const PUBLIC_OK = `c.active=1 AND c.approval_status='approved' AND (c.teacher_id IS NULL OR EXISTS (
  SELECT 1 FROM teacher_profiles tp JOIN users tu ON tu.id=tp.user_id
  WHERE tp.user_id=c.teacher_id AND tp.status='approved' AND tu.active=1))`;

// Public-safe course rows (the Classroom link is never included - students get it through a checked route).
function publicCourses(extra = '1=1', params = []) {
  const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id) AS lesson_count,
      (SELECT full_name_enc FROM users u WHERE u.id=c.teacher_id) AS tname_enc
    FROM courses c WHERE ${PUBLIC_OK} AND ${extra} ORDER BY c.type, c.title`).all(...params);
  return rows.map(r => {
    const live = !!r.classroom_url;
    delete r.classroom_url;
    return { ...r, live, teacher_name: r.tname_enc ? decrypt(r.tname_enc) : null };
  });
}

function publicTeachers(limit = 100) {
  return db.prepare(`SELECT tp.*, u.full_name_enc,
      (SELECT COUNT(*) FROM courses c WHERE c.teacher_id=tp.user_id AND ${PUBLIC_OK}) AS course_count
    FROM teacher_profiles tp JOIN users u ON u.id=tp.user_id
    WHERE tp.status='approved' AND u.active=1 ORDER BY tp.reviewed_at DESC, tp.user_id DESC LIMIT ?`).all(limit)
    .map(t => ({ ...t, full_name: decrypt(t.full_name_enc) }));
}

// Enrollments with course info, money owed, lesson progress and certificate eligibility.
function enrollmentRows(where, params = []) {
  const rows = db.prepare(`
    SELECT e.*, c.title AS course_title, c.type AS course_type, c.pass_mark, c.teacher_id, c.classroom_url, c.approval_status,
      (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.enrollment_id=e.id AND p.status='confirmed') AS paid_cents,
      (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.enrollment_id=e.id AND p.status='pending') AS pending_cents,
      (SELECT COUNT(*) FROM lessons l WHERE l.course_id=e.course_id) AS lesson_total,
      (SELECT COUNT(*) FROM lesson_progress lp JOIN lessons l ON l.id=lp.lesson_id WHERE lp.enrollment_id=e.id) AS lesson_done
    FROM enrollments e JOIN courses c ON c.id=e.course_id
    WHERE ${where} ORDER BY e.created_at DESC, e.id DESC`).all(...params);
  return rows.map(r => {
    const paid_full = r.paid_cents >= r.fee_cents;
    const lessons_complete = r.lesson_total > 0 && r.lesson_done >= r.lesson_total;
    return {
      ...r,
      owed_cents: Math.max(0, r.fee_cents - r.paid_cents),
      paid_full,
      percent: r.lesson_total ? Math.round((r.lesson_done * 100) / r.lesson_total) : 0,
      lessons_complete,
      has_classroom: !!r.classroom_url,
      // Teacher-led courses: the teacher recommends completion. School video courses: all lessons finished.
      eligible: paid_full && (r.teacher_id ? !!r.completion_recommended : lessons_complete)
    };
  });
}

module.exports = { enrollmentRows, publicCourses, publicTeachers, PUBLIC_OK };
