// Builds the certificate / diploma / AA degree as a PDF (attached to the email).
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { DISCLAIMER, fmtDate } = require('./util');

const NAVY = '#0b2a5b', GOLD = '#c9971c';
const latin = (s) => String(s || '').replace(/[^\x20-\xff]/g, '?');
const KIND = { associate: 'Associate of Arts Degree', diploma: 'Diploma', certificate: 'Certificate of Completion' };

function buildCertificatePdf(cert, baseUrl) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: 'Certificate ' + cert.cert_no, Author: 'Liberia Gateway Online College' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width, H = doc.page.height, mid = W / 2;
    doc.rect(18, 18, W - 36, H - 36).lineWidth(5).stroke(NAVY);
    doc.rect(30, 30, W - 60, H - 60).lineWidth(1.5).stroke(GOLD);
    const logo = path.join(__dirname, '..', 'public', 'logo.png');
    if (fs.existsSync(logo)) doc.image(logo, mid - 42, 44, { width: 84 });
    doc.fillColor(NAVY).font('Times-Bold').fontSize(24).text('LIBERIA GATEWAY ONLINE COLLEGE', 0, 136, { width: W, align: 'center' });
    doc.fillColor(GOLD).font('Times-Bold').fontSize(20).text(latin((KIND[cert.course_type] || KIND.certificate).toUpperCase()), 0, 170, { width: W, align: 'center' });
    doc.fillColor('#333').font('Times-Roman').fontSize(13).text('This is to certify that', 0, 206, { width: W, align: 'center' });
    doc.fillColor(NAVY).font('Times-BoldItalic').fontSize(34).text(latin(cert.student_name), 40, 228, { width: W - 80, align: 'center' });
    doc.fillColor('#333').font('Times-Roman').fontSize(13).text('has successfully completed the ' + (cert.course_type === 'associate' ? 'associate degree' : cert.course_type) + ' programme', 0, 282, { width: W, align: 'center' });
    doc.fillColor(NAVY).font('Times-Bold').fontSize(22).text(latin(cert.course_title), 60, 306, { width: W - 120, align: 'center' });
    let y = 350;
    if (cert.score !== null && cert.score !== undefined) { doc.fillColor('#555').font('Times-Roman').fontSize(11).text('Final assessment score: ' + cert.score + '%', 0, y, { width: W, align: 'center' }); y += 18; }
    doc.fillColor('#333').font('Times-Roman').fontSize(12).text('Date issued: ' + fmtDate(cert.issued_at), 0, y, { width: W, align: 'center' });
    doc.fontSize(10).fillColor('#555').text('Certificate no. ' + cert.cert_no + '   |   Verify at ' + baseUrl + '/verify   |   Code: ' + cert.verify_code, 40, y + 22, { width: W - 80, align: 'center' });
    doc.fontSize(7.5).fillColor('#777').text(latin(DISCLAIMER), 60, H - 92, { width: W - 120, align: 'center' });
    doc.end();
  });
}
module.exports = { buildCertificatePdf };
