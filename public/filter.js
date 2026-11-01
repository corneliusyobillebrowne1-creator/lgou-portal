(function () {
  var box = document.getElementById('coursesearch');
  if (!box) return;
  var cards = Array.prototype.slice.call(document.querySelectorAll('.coursecard'));
  var count = document.getElementById('coursecount');
  box.addEventListener('input', function () {
    var q = box.value.trim().toLowerCase(), shown = 0;
    cards.forEach(function (c) {
      var ok = !q || (c.getAttribute('data-title') || '').indexOf(q) !== -1;
      c.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    count.textContent = q ? shown + ' found' : '';
  });
})();
