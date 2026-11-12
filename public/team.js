// Refreshes the AI Team pages when something changed, but never while you are typing.
(function () {
  var page = document.getElementById('teampage'); if (!page) return;
  var sig = page.getAttribute('data-sig');
  setInterval(function () {
    if (document.hidden) return;
    var a = document.activeElement; if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    fetch('/team/api/status', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { if (j && j.sig !== sig) location.reload(); }).catch(function () {});
  }, 6000);
})();
