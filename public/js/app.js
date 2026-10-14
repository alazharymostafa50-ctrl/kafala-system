/* سلوك الواجهة العام — لا يحتوي على أي منطق أمني (الأمان مطبق في الخادم) */
(function () {
  'use strict';
  var body = document.body;
  try { if (localStorage.getItem('navCollapsed') === '1' && window.innerWidth > 860) body.classList.add('collapsed'); } catch (e) { /* تجاهل */ }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-toggle-nav]');
    if (t) {
      if (window.innerWidth <= 860) body.classList.toggle('navopen');
      else { body.classList.toggle('collapsed'); try { localStorage.setItem('navCollapsed', body.classList.contains('collapsed') ? '1' : '0'); } catch (err) { /* تجاهل */ } }
      return;
    }
    if (e.target.closest('[data-close-nav]')) body.classList.remove('navopen');
    var p = e.target.closest('[data-print]');
    if (p) { e.preventDefault(); window.print(); }
  });

  // تأكيد العمليات الحساسة + منع الإرسال المزدوج
  var dlg = document.getElementById('confirmDlg');
  var pending = null;
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.dataset.confirm && !f.dataset.confirmed) {
      e.preventDefault();
      pending = f;
      document.getElementById('confirmMsg').textContent = f.dataset.confirm;
      if (dlg && dlg.showModal) dlg.showModal(); else if (window.confirm(f.dataset.confirm)) { f.dataset.confirmed = '1'; f.requestSubmit ? f.requestSubmit() : f.submit(); }
      return;
    }
    if (f.dataset.submitting) { e.preventDefault(); return; }
    if ((f.method || '').toLowerCase() === 'post') {
      f.dataset.submitting = '1';
      var btns = f.querySelectorAll('button[type=submit], button:not([type])');
      btns.forEach(function (b) { b.disabled = true; });
      setTimeout(function () { delete f.dataset.submitting; btns.forEach(function (b) { b.disabled = false; }); }, 8000);
    }
  });
  if (dlg) {
    document.getElementById('confirmYes').addEventListener('click', function () {
      dlg.close();
      if (pending) { pending.dataset.confirmed = '1'; if (pending.requestSubmit) pending.requestSubmit(); else pending.submit(); delete pending.dataset.confirmed; pending = null; }
    });
    document.getElementById('confirmNo').addEventListener('click', function () { dlg.close(); pending = null; });
  }

  // زر إظهار/إخفاء كلمة المرور لكل خانة كلمة مرور
  document.querySelectorAll('input[type=password]').forEach(function (inp) {
    var wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.setAttribute('aria-label', 'إظهار كلمة المرور');
    var eye = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    var eyeOff = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.4 10.4 0 0112 19C5 19 1 12 1 12a18.5 18.5 0 015.1-5.9M9.9 4.2A9.6 9.6 0 0112 4c7 0 11 7 11 7a18.6 18.6 0 01-2.2 3.2M14.1 14.1a3 3 0 11-4.2-4.2"/><path d="M1 1l22 22"/></svg>';
    function render() {
      var shown = inp.type === 'text';
      btn.innerHTML = (shown ? eyeOff : eye) + '<span>' + (shown ? 'إخفاء' : 'إظهار') + '</span>';
      btn.setAttribute('aria-label', shown ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
    }
    btn.addEventListener('click', function () { inp.type = inp.type === 'password' ? 'text' : 'password'; render(); inp.focus(); });
    // إعادة الإخفاء قبل الإرسال حتى لا يحفظها المتصفح كنص عادي
    if (inp.form) inp.form.addEventListener('submit', function () { inp.type = 'password'; render(); });
    render();
    wrap.appendChild(btn);
  });

  // حساب العمر فورًا عند إدخال تاريخ الميلاد
  document.querySelectorAll('[data-age-for]').forEach(function (out) {
    var inp = document.getElementById(out.dataset.ageFor);
    function upd() {
      if (!inp.value) { out.textContent = ''; return; }
      var b = new Date(inp.value), n = new Date();
      var a = n.getFullYear() - b.getFullYear();
      if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
      out.textContent = isNaN(a) ? '' : ('العمر: ' + a + ' سنة');
    }
    inp.addEventListener('input', upd); upd();
  });

  // إظهار الحقول الشرطية (قوائم أو أزرار اختيار)
  document.querySelectorAll('[data-show-when]').forEach(function (el) {
    var parts = el.dataset.showWhen.split('=');
    var srcs = document.querySelectorAll('[name="' + parts[0] + '"]');
    if (!srcs.length) return;
    var vals = parts[1].split('|');
    function current() {
      for (var i = 0; i < srcs.length; i++) { var s = srcs[i]; if (s.type === 'radio') { if (s.checked) return s.value; } else return s.value; }
      return '';
    }
    function upd() { el.classList.toggle('hidden', vals.indexOf(current()) === -1); }
    srcs.forEach(function (s) { s.addEventListener('change', upd); });
    upd();
  });

  // التوجيه التلقائي عند تغيير القوائم
  document.querySelectorAll('select[data-autosubmit]').forEach(function (s) { s.addEventListener('change', function () { s.form.submit(); }); });

  // الرسوم البيانية
  var chartEl = document.getElementById('mainChart');
  if (chartEl && window.Chart) {
    var d = JSON.parse(chartEl.dataset.chart);
    Chart.defaults.font.family = 'Cairo, sans-serif';
    new Chart(chartEl, {
      type: 'bar',
      data: { labels: d.labels, datasets: [
        { label: 'التبرعات المحصلة', data: d.donations, backgroundColor: '#11704f' },
        { label: 'المستحق للأسر', data: d.due, backgroundColor: '#b8963e' },
        { label: 'المصروف للأسر', data: d.disbursed, backgroundColor: '#7fb69a' },
        { label: 'المصروفات الأخرى', data: d.expenses, backgroundColor: '#c97a2b' }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', rtl: true } },
        animation: false, scales: { x: { reverse: true }, y: { position: 'right', beginAtZero: true, ticks: { callback: function (v) { return v.toLocaleString('en-US'); } } } } }
    });
  }
})();
