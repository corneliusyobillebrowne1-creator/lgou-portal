const { db, getSetting } = require('./db');

const TYPE = { certificate: 'Certificate', diploma: 'Diploma', associate: 'AA Degree' };
const typeLabel = (t) => TYPE[t] || t;
const badgeClass = (t) => (t === 'diploma' ? 'diploma' : t === 'associate' ? 'degree' : '');

const DEFAULT_ADMISSIONS =
  'Certificate courses: open to anyone who can read and write and has a phone or computer with internet.\n' +
  'Diploma programmes: a high school education or equivalent is recommended.\n' +
  'Associate of Arts (AA) degree programmes: a high school diploma or equivalent. The college office decides each case.';
const DEFAULT_ACCREDITATION =
  'Liberia Gateway Online College is a private online college. Its certificates, diplomas and Associate of Arts (AA) degrees are awarded by the college only. ' +
  'No government accreditation or recognition is claimed on this site unless it is stated here by the college. Please ask the college office for the current status before you rely on a qualification for study or employment elsewhere.';

function durationLabel(w) {
  w = Number(w) || 0;
  if (w >= 48) { const y = Math.round((w / 52) * 10) / 10; return y + (y === 1 ? ' year' : ' years'); }
  return w + (w === 1 ? ' week' : ' weeks');
}

const DEFAULT_CONTACT = 'Call us on 0880 035 290 or 0770 370 287 for any question about admissions, fees, payments or your classes.';

const host = (u, hosts) => { try { const x = new URL(u); return x.protocol === 'https:' && hosts.some(h => x.hostname === h || x.hostname.endsWith('.' + h)) ? x.toString() : ''; } catch { return ''; } };
function socials() {
  const wa = String(getSetting('whatsapp_number') || '').replace(/\D/g, '');
  const intl = wa ? (wa.startsWith('231') ? wa : '231' + wa.replace(/^0/, '')) : '';
  return { whatsapp: intl ? 'https://wa.me/' + intl : '', facebook: host(getSetting('facebook_url') || '', ['facebook.com', 'fb.com']), tiktok: host(getSetting('tiktok_url') || '', ['tiktok.com']) };
}
function info() {
  return {
    contact: getSetting('college_contact') || DEFAULT_CONTACT,
    phones: ((getSetting('college_contact') || DEFAULT_CONTACT).match(/0\d{3}\s?\d{3}\s?\d{3}/g) || []).slice(0, 4).map(p => ({ show: p, tel: p.replace(/\s/g, '') })),
    admissions: getSetting('admission_requirements') || DEFAULT_ADMISSIONS,
    accreditation: getSetting('accreditation_statement') || DEFAULT_ACCREDITATION,
    chat: !!getSetting('ai_api_key_enc') && getSetting('ai_public_enabled') !== 'no',
    social: socials()
  };
}
const announcements = (n = 3) => db.prepare('SELECT * FROM announcements WHERE active=1 ORDER BY id DESC LIMIT ?').all(n);

module.exports = { durationLabel, typeLabel, badgeClass, info, announcements, DEFAULT_ADMISSIONS, DEFAULT_ACCREDITATION };
