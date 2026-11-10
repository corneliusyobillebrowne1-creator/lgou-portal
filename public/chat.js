(function () {
  var fab = document.getElementById('chatfab'), box = document.getElementById('chatbox'); if (!fab || !box) return;
  var log = document.getElementById('chatlog'), form = document.getElementById('chatform'), q = document.getElementById('chatq'), hist = [], busy = false;
  function open(v) { box.hidden = !v; fab.setAttribute('aria-expanded', v ? 'true' : 'false'); if (v) q.focus(); }
  fab.addEventListener('click', function () { open(box.hidden); });
  document.getElementById('chatclose').addEventListener('click', function () { open(false); });
  function add(cls, text) { var p = document.createElement('p'); p.className = cls; p.textContent = text; log.appendChild(p); log.scrollTop = log.scrollHeight; return p; }
  form.addEventListener('submit', function (e) {
    e.preventDefault(); var text = q.value.trim(); if (!text || busy) return; busy = true; add('me', text); q.value = '';
    var wait = add('bot', '...');
    var body = new URLSearchParams({ q: text, h: JSON.stringify(hist.slice(-4)), _csrf: document.getElementById('chatcsrf').value });
    fetch('/ask-college', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), credentials: 'same-origin' })
      .then(function (r) { return r.json(); }).then(function (d) { wait.textContent = d.answer || 'Sorry, something went wrong.'; hist.push({ role: 'user', text: text }, { role: 'assistant', text: wait.textContent }); })
      .catch(function () { wait.textContent = 'Sorry, I could not connect. Please call the college.'; }).then(function () { busy = false; });
  });
})();
