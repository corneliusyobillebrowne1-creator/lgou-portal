// CSP blocks inline handlers, so the print button is wired here.
var b = document.getElementById('printbtn');
if (b) b.addEventListener('click', function () { window.print(); });
