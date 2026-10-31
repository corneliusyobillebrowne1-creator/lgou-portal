// Minimal SQLite-backed session store (sessions survive restarts, nothing extra to install).
const session = require('express-session');

class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.getStmt = db.prepare('SELECT data, expires FROM sessions WHERE sid=?');
    this.setStmt = db.prepare('INSERT INTO sessions (sid,data,expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data, expires=excluded.expires');
    this.delStmt = db.prepare('DELETE FROM sessions WHERE sid=?');
    this.touchStmt = db.prepare('UPDATE sessions SET expires=? WHERE sid=?');
    this.cleanup();
    setInterval(() => this.cleanup(), 15 * 60 * 1000).unref();
  }
  cleanup() { this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); }
  expiry(sess) {
    return sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 2 * 3600 * 1000;
  }
  get(sid, cb) {
    try {
      const r = this.getStmt.get(sid);
      if (!r || r.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(r.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try { this.setStmt.run(sid, JSON.stringify(sess), this.expiry(sess)); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { this.delStmt.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) {
    try { this.touchStmt.run(this.expiry(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}
module.exports = SqliteStore;
