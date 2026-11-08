(function () {
  // Phone menu button
  var btn = document.getElementById('navtoggle'), hdr = document.querySelector('.site-header');
  if (btn && hdr) {
    btn.addEventListener('click', function () {
      var open = hdr.classList.toggle('open'); btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  // Keep the active tab in view on small screens
  var on = document.querySelector('.subnav a.on');
  if (on && on.scrollIntoView) { try { on.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {} }
  // Tables become tidy stacked cards on phones: label each cell with its column heading
  Array.prototype.forEach.call(document.querySelectorAll('main table'), function (t) {
    var heads = Array.prototype.map.call(t.querySelectorAll('thead th'), function (h) { return h.textContent.trim(); });
    if (!heads.length) return;
    t.classList.add('stack');
    Array.prototype.forEach.call(t.querySelectorAll('tbody tr'), function (r) {
      Array.prototype.forEach.call(r.children, function (c, i) { if (heads[i]) c.setAttribute('data-label', heads[i]); });
    });
  });
})();
