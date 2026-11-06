(function () {
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  var btn = document.getElementById('installapp'), hint = document.getElementById('iosinstall'), deferred = null;
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (standalone) return;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    if (btn) btn.hidden = false;
  });
  if (btn) btn.addEventListener('click', function () {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.then(function () { deferred = null; btn.hidden = true; });
  });
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (ios && hint) hint.hidden = false;
  window.addEventListener('appinstalled', function () { if (btn) btn.hidden = true; if (hint) hint.hidden = true; });
})();
