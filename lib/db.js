const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { DATA_DIR, encrypt } = require('./crypto');

const db = new Database(path.join(DATA_DIR, 'lgou.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---- users table (roles: student, teacher, admin). Existing databases are upgraded in place. ----
const USERS_COLS = `
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','teacher','admin')),
  full_name_enc TEXT NOT NULL,
  email_enc TEXT,
  email_idx TEXT UNIQUE,
  phone_enc TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  last_login TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`;
const existingUsers = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
if (!existingUsers) {
  db.exec(`CREATE TABLE users (${USERS_COLS});`);
} else if (!existingUsers.sql.includes("'teacher'")) {
  // SQLite cannot alter a CHECK constraint, so rebuild the table (the documented safe procedure).
  db.pragma('foreign_keys = OFF');
  db.exec(`BEGIN;
    CREATE TABLE users_new (${USERS_COLS});
    INSERT INTO users_new (id,username,password_hash,role,full_name_enc,email_enc,email_idx,phone_enc,active,failed_count,locked_until,last_login,created_at)
      SELECT id,username,password_hash,role,full_name_enc,email_enc,email_idx,phone_enc,active,failed_count,locked_until,last_login,created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
  COMMIT;`);
  db.pragma('foreign_keys = ON');
}

db.exec(`
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('certificate','diploma','associate')),
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  fee_cents INTEGER NOT NULL DEFAULT 0,
  duration_weeks INTEGER NOT NULL DEFAULT 4,
  pass_mark INTEGER NOT NULL DEFAULT 50,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  youtube_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  fee_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','requested','certified')),
  request_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, course_id)
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL,
  reference_enc TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lesson_progress (
  id INTEGER PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (enrollment_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS exam_results (
  id INTEGER PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
  score INTEGER NOT NULL,
  pass_mark INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY,
  enrollment_id INTEGER NOT NULL UNIQUE REFERENCES enrollments(id),
  cert_no TEXT NOT NULL UNIQUE,
  verify_code TEXT NOT NULL UNIQUE,
  student_name_enc TEXT NOT NULL,
  course_title TEXT NOT NULL,
  course_type TEXT NOT NULL,
  score INTEGER,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','revoked')),
  issued_by INTEGER REFERENCES users(id),
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id, position);
CREATE INDEX IF NOT EXISTS idx_enroll_user ON enrollments(user_id);
CREATE INDEX IF NOT EXISTS idx_pay_enroll ON payments(enrollment_id, status);
`);

// ---- additions for teachers (columns are added only if missing, so old databases upgrade cleanly) ----
function addColumn(table, col, ddl) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
addColumn('courses', 'teacher_id', 'INTEGER REFERENCES users(id)');            // NULL = course run by the school itself
addColumn('courses', 'approval_status', "TEXT NOT NULL DEFAULT 'approved'");   // pending | approved | rejected | suspended
addColumn('courses', 'classroom_url', 'TEXT');                                 // teacher's Google Classroom link
addColumn('courses', 'admin_note', 'TEXT');
addColumn('users', 'must_change', 'INTEGER NOT NULL DEFAULT 0');
addColumn('enrollments', 'completion_recommended', 'INTEGER NOT NULL DEFAULT 0');
addColumn('enrollments', 'recommended_score', 'INTEGER');

// Older databases only allowed certificate/diploma. SQLite cannot alter a CHECK, so rebuild the courses table once.
if (!db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='courses'").get().sql.includes("'associate'")) {
  const C = 'id,title,type,summary,description,fee_cents,duration_weeks,pass_mark,active,created_at,teacher_id,approval_status,classroom_url,admin_note';
  db.pragma('foreign_keys = OFF');
  db.exec(`BEGIN;
    CREATE TABLE courses_new (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('certificate','diploma','associate')),
      summary TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      fee_cents INTEGER NOT NULL DEFAULT 0, duration_weeks INTEGER NOT NULL DEFAULT 4, pass_mark INTEGER NOT NULL DEFAULT 50,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      teacher_id INTEGER REFERENCES users(id), approval_status TEXT NOT NULL DEFAULT 'approved', classroom_url TEXT, admin_note TEXT);
    INSERT INTO courses_new (${C}) SELECT ${C} FROM courses;
    DROP TABLE courses;
    ALTER TABLE courses_new RENAME TO courses;
  COMMIT;`);
  db.pragma('foreign_keys = ON');
  if (db.pragma('foreign_key_check').length) throw new Error('Database upgrade check failed (foreign keys).');
}

// Class times set by teachers (weekly pattern text + dated sessions). Times are Liberia time (GMT).
addColumn('courses', 'class_schedule', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS class_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  starts_on TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT,
  topic TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_class_sessions ON class_sessions(course_id, starts_on)`);

// Record of every email the college tries to send (no email bodies stored, address is masked).
db.exec(`CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER, kind TEXT NOT NULL, ref_id INTEGER, to_masked TEXT, subject TEXT, status TEXT NOT NULL, error TEXT)`);

// Student numbers: LGOC-800, LGOC-801, ... (plain running numbers, no year). The next number is kept in the settings table.
addColumn('users', 'student_no', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_student_no ON users(student_no)');
const STUDENT_NO_START = 800;
function assignStudentNo(id) {
  db.transaction(() => {
    const u = db.prepare("SELECT student_no FROM users WHERE id=? AND role='student'").get(id);
    if (!u || u.student_no) return;
    const cur = db.prepare("SELECT value FROM settings WHERE key='student_no_next'").get();
    const n = Math.max(STUDENT_NO_START, parseInt(cur && cur.value, 10) || STUDENT_NO_START);
    db.prepare('UPDATE users SET student_no=? WHERE id=?').run('LGOC-' + n, id);
    db.prepare("INSERT INTO settings (key,value) VALUES ('student_no_next',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n + 1));
  })();
}
// One-time: renumber every existing student in the order they joined, starting at 800 (old LGOC-2026-00012 style is retired).
if (!db.prepare("SELECT 1 FROM settings WHERE key='student_no_v2'").get()) {
  db.transaction(() => {
    db.prepare("UPDATE users SET student_no=NULL WHERE role='student'").run();
    db.prepare("DELETE FROM settings WHERE key='student_no_next'").run();
    db.prepare("SELECT id FROM users WHERE role='student' ORDER BY id").all().forEach(r => assignStudentNo(r.id));
    db.prepare("INSERT INTO settings (key,value) VALUES ('student_no_v2','1')").run();
  })();
}
// Safety net: anyone still without a number (e.g. restored from an old backup) gets the next one.
db.prepare("SELECT id FROM users WHERE role='student' AND student_no IS NULL ORDER BY id").all().forEach(r => assignStudentNo(r.id));

db.exec(`CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);

db.exec(`
CREATE TABLE IF NOT EXISTS teacher_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  headline TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  subjects TEXT NOT NULL DEFAULT '',
  qualifications TEXT NOT NULL DEFAULT '',
  experience_years INTEGER NOT NULL DEFAULT 0,
  county TEXT NOT NULL DEFAULT '',
  admin_note TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS course_groups (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (course_id, name)
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES course_groups(id) ON DELETE CASCADE,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, enrollment_id)
);
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS attendance_records (
  session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('present','absent','late','excused')),
  PRIMARY KEY (session_id, enrollment_id)
);
CREATE TABLE IF NOT EXISTS grade_items (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'assignment' CHECK (category IN ('quiz','assignment','exam','participation')),
  max_score REAL NOT NULL CHECK (max_score > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS grades (
  item_id INTEGER NOT NULL REFERENCES grade_items(id) ON DELETE CASCADE,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  graded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (item_id, enrollment_id)
);
CREATE INDEX IF NOT EXISTS idx_courses_teacher ON courses(teacher_id);
CREATE INDEX IF NOT EXISTS idx_att_course ON attendance_sessions(course_id, session_date);
CREATE INDEX IF NOT EXISTS idx_items_course ON grade_items(course_id);
`);

function audit(userId, action, detail, ip) {
  db.prepare('INSERT INTO audit_log (user_id, action, detail, ip) VALUES (?,?,?,?)')
    .run(userId || null, action, detail || null, ip || null);
}
function getSetting(key, fallback = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

// ---- first-run seed ----
if (!getSetting('payment_instructions')) {
  setSetting('payment_instructions',
    'Send your fee by mobile money or bank transfer to the account details the school office gives you, ' +
    'then enter the amount and the transaction reference below. The admin will confirm your payment.');
}

if (!getSetting('teacher_max_fee_cents')) setSetting('teacher_max_fee_cents', '5000'); // teachers may charge at most $50 per course (admin can change)

if (db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!password) { password = crypto.randomBytes(9).toString('base64url'); generated = true; }
  db.prepare("INSERT INTO users (username,password_hash,role,full_name_enc) VALUES (?,?,?,?)")
    .run(username, bcrypt.hashSync(password, 12), 'admin', encrypt('Administrator'));
  console.log('\n=====================================================');
  console.log(' First-run admin account created');
  console.log('   username: ' + username);
  if (generated) console.log('   password: ' + password + '   (shown only once - change it after login)');
  else console.log('   password: (taken from ADMIN_PASSWORD)');
  console.log('=====================================================\n');
}

if (db.prepare('SELECT COUNT(*) n FROM courses').get().n === 0) {
  const ins = db.prepare('INSERT INTO courses (title,type,summary,description,fee_cents,duration_weeks) VALUES (?,?,?,?,?,?)');
  ins.run('Computer Basics & Digital Literacy', 'certificate', 'Start here: using a computer, the internet, email and office tools.',
    'A beginner-friendly short course. You will learn to use a computer, browse safely, send email and create simple documents.', 1000, 4);
  ins.run('Introduction to Web Design', 'certificate', 'Learn how websites are built with HTML and CSS.',
    'Short practical course covering the basics of HTML, CSS and publishing a simple website.', 1500, 6);
  ins.run('Diploma in Business Administration', 'diploma', 'Core business, management and entrepreneurship skills.',
    'A longer diploma programme covering management basics, accounting fundamentals, marketing and starting a small business.', 4000, 12);
  ins.run('Diploma in Information Technology', 'diploma', 'Networking, hardware, software and IT support foundations.',
    'A diploma programme covering computer hardware, operating systems, networks and IT support skills.', 4500, 12);
}

// ---- AI assistant: every change it makes (or proposes) is recorded here so an admin can undo or approve it ----
db.exec(`CREATE TABLE IF NOT EXISTS ai_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,              -- 'edit' (applied by the assistant) or 'fee' (proposal, needs admin approval)
  course_id INTEGER NOT NULL,
  summary TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  status TEXT NOT NULL,            -- applied | reverted | pending | approved | rejected
  decided_by INTEGER
)`);

// ---- more starter courses (added once, including on databases created by earlier versions) ----
// The school adds the YouTube lessons in Admin > Courses; until a course has lessons (or a teacher's Classroom link)
// it shows as "Coming soon" and cannot be enrolled in.
if (!getSetting('seed_more_courses_v1')) {
  const more = [
    // [title, type, summary, description, fee_cents, weeks]
    ['Microsoft Office Essentials', 'certificate', 'Word, Excel and PowerPoint for school, work and business.',
      'Learn to write and format documents in Word, organise numbers and make simple formulas in Excel, and build clear presentations in PowerPoint.', 1500, 6],
    ['Digital Marketing & Social Media', 'certificate', 'Promote a business online with Facebook, WhatsApp, Instagram and more.',
      'Learn how to plan content, build an audience, write posts that sell, run simple paid adverts and measure what works.', 1500, 6],
    ['Graphic Design Basics', 'certificate', 'Design logos, posters and social media graphics.',
      'Learn colour, fonts and layout, and how to create professional posters, flyers and logos with free design tools.', 1500, 6],
    ['English Communication & Report Writing', 'certificate', 'Speak, write and present clearly in English.',
      'Improve spoken and written English for work: emails, letters, reports, meetings and interviews.', 1000, 4],
    ['Basic Accounting & Bookkeeping', 'certificate', 'Keep clear money records for a shop, farm or small business.',
      'Learn cash books, receipts, simple ledgers, profit and loss, and how to keep records that banks and partners trust.', 1500, 6],
    ['Small Business & Entrepreneurship Skills', 'certificate', 'Start and grow a small business step by step.',
      'Learn how to find a business idea, test it, price products, manage money, find customers and plan for growth.', 1200, 5],
    ['Customer Service Excellence', 'certificate', 'Serve customers well and keep them coming back.',
      'Learn communication, handling complaints, teamwork and professional behaviour for shops, offices, hotels and call centres.', 1000, 4],
    ['Typing & Data Entry Skills', 'certificate', 'Type fast and accurately and enter data with confidence.',
      'Build touch-typing speed and accuracy and learn good practice for data entry in spreadsheets and forms.', 800, 4],
    ['Cyber Safety & Online Security', 'certificate', 'Protect your phone, accounts and money online.',
      'Learn strong passwords, spotting scams and fake messages, safe mobile money use, and protecting personal information.', 1000, 4],
    ['Computer & Phone Troubleshooting Basics', 'certificate', 'Find and fix common computer and phone problems.',
      'Learn basic hardware parts, software problems, malware cleanup, data backup and how to troubleshoot step by step.', 1200, 5],
    ['Project Management Fundamentals', 'certificate', 'Plan, schedule and deliver projects on time.',
      'Learn goals, work plans, budgets, risks, teamwork and reporting using simple tools anyone can use.', 1500, 6],
    ['Agriculture & Farm Business Basics', 'certificate', 'Better farming practice and running a farm as a business.',
      'Learn crop and soil basics, record keeping, costing, post-harvest handling and selling produce at a profit.', 1200, 5],
    ['Health, Safety & First Aid Awareness', 'certificate', 'Basic workplace safety and first aid knowledge.',
      'Learn hygiene, accident prevention, basic first aid and how to respond calmly in an emergency. Awareness course; not a medical qualification.', 1000, 4],
    ['Diploma in Accounting & Finance', 'diploma', 'Accounting principles, bookkeeping, budgeting and finance for business.',
      'A longer diploma covering bookkeeping, financial statements, budgeting, costing, basic taxation concepts and spreadsheet skills.', 4000, 12],
    ['Diploma in Digital Marketing', 'diploma', 'Full digital marketing skills from strategy to results.',
      'A diploma covering marketing basics, social media, content, email and messaging marketing, simple advertising and measuring results.', 4000, 12],
    ['Diploma in Project Management', 'diploma', 'Manage projects for companies, NGOs and communities.',
      'A diploma covering project planning, scheduling, budgeting, risk, monitoring and evaluation, and reporting.', 4000, 12],
    ['Diploma in Office Administration', 'diploma', 'Run an office: records, communication, Office software and organisation.',
      'A diploma covering business writing, filing and records, Microsoft Office, scheduling, customer care and professional conduct.', 3500, 12]
  ];
  const ins = db.prepare('INSERT INTO courses (title,type,summary,description,fee_cents,duration_weeks) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM courses WHERE title=?)');
  db.transaction(() => { more.forEach(c => ins.run(...c, c[0])); })();
  setSetting('seed_more_courses_v1', '1');
}

// ---- Associate of Arts (AA) degree programmes (added once) ----
if (!getSetting('seed_aa_v1')) {
  const aa = [
    ['Associate of Arts (AA) in General Studies', 'A broad two-year foundation in communication, mathematics, social science and study skills.',
      'A two-year Associate of Arts programme giving a broad foundation: academic writing and communication, basic mathematics, social science, ICT and study skills. Suitable for students who want a flexible first degree level or a base for further study.'],
    ['Associate of Arts (AA) in Business Administration', 'Two-year degree in management, accounting, marketing and entrepreneurship.',
      'A two-year Associate of Arts programme covering principles of management, accounting, marketing, business communication, entrepreneurship and small business operations.'],
    ['Associate of Arts (AA) in Information Technology', 'Two-year degree in computing, networks, software and IT support.',
      'A two-year Associate of Arts programme covering computer systems, networking, programming basics, databases, cyber safety and IT support practice.'],
    ['Associate of Arts (AA) in Accounting & Finance', 'Two-year degree in bookkeeping, financial reporting, budgeting and finance.',
      'A two-year Associate of Arts programme covering bookkeeping, financial statements, costing, budgeting, basic taxation concepts and spreadsheet skills.']
  ];
  const ins = db.prepare("INSERT INTO courses (title,type,summary,description,fee_cents,duration_weeks,pass_mark) SELECT ?,'associate',?,?,?,?,60 WHERE NOT EXISTS (SELECT 1 FROM courses WHERE title=?)");
  db.transaction(() => { aa.forEach(c => ins.run(c[0], c[1], c[2], 30000, 96, c[0])); })();
  setSetting('seed_aa_v1', '1');
}

module.exports = { db, audit, getSetting, setSetting, assignStudentNo };


// ---- community & quality features: complaints, course Q&A, ratings, success stories, referrals ----
db.exec(`
CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  name_enc TEXT NOT NULL, contact_enc TEXT NOT NULL, message_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  answer TEXT, answered_by INTEGER REFERENCES users(id), answered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL UNIQUE REFERENCES enrollments(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, course TEXT, quote TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
addColumn('users', 'referral_code', 'TEXT');
addColumn('users', 'referred_by', 'INTEGER');
