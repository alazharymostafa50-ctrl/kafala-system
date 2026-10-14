(function () {
  'use strict';
  var b = document.getElementById('printBtn');
  if (b) b.addEventListener('click', function () { window.print(); });
  if (location.search.indexOf('autoprint=1') !== -1) window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 300); });
})();
