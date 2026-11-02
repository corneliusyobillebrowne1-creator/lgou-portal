// Payment methods are edited by the admin (Admin > Settings). One per line:  Name | details students should use
// e.g.  Orange Money | Send to 0770 000 000 (name: LGOU Office)
const { getSetting, setSetting } = require('./db');

const DEFAULT = 'Orange Money\nMTN Mobile Money\nBank transfer\nCash at school office';

function parse(text) {
  const seen = new Set(), out = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const i = line.indexOf('|');
    const name = (i === -1 ? line : line.slice(0, i)).replace(/\s+/g, ' ').trim().slice(0, 40);
    const details = (i === -1 ? '' : line.slice(i + 1)).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (name && !seen.has(name.toLowerCase()) && out.length < 12) { seen.add(name.toLowerCase()); out.push({ name, details }); }
  });
  return out;
}
function getMethods() {
  const m = parse(getSetting('payment_methods'));
  return m.length ? m : parse(DEFAULT);
}
const methodNames = () => getMethods().map(m => m.name);
function saveMethods(text) { setSetting('payment_methods', parse(text).map(m => m.details ? m.name + ' | ' + m.details : m.name).join('\n')); }
const methodsText = () => getMethods().map(m => m.details ? m.name + ' | ' + m.details : m.name).join('\n');

module.exports = { getMethods, methodNames, saveMethods, methodsText, parse };
