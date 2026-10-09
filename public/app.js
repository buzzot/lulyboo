// Small progressive enhancements. Everything works without JS.
(function () {
  var root = document.documentElement;
  var isZh = function () { return root.classList.contains('zh'); };
  // Bilingual snippet for text built in the browser (CSS shows the active language)
  var L = function (en, zh) { return '<span class="i-en">' + en + '</span><span class="i-zh" lang="zh-CN">' + zh + '</span>'; };

  // Language switch: no reload. Remembered in a cookie (read by the server on the next page) and localStorage.
  document.querySelectorAll('.lang-switch [data-lang]').forEach(function (b) {
    b.addEventListener('click', function () {
      var zh = b.getAttribute('data-lang') === 'zh';
      root.classList.toggle('zh', zh);
      root.setAttribute('lang', zh ? 'zh-CN' : 'en');
      document.querySelectorAll('.lang-switch [data-lang]').forEach(function (x) { x.setAttribute('aria-pressed', String((x.getAttribute('data-lang') === 'zh') === zh)); });
      document.cookie = 'lb_lang=' + (zh ? 'zh' : 'en') + '; path=/; max-age=31536000; SameSite=Lax';
      try { localStorage.setItem('lb_lang', zh ? 'zh' : 'en'); } catch (e) { /* storage unavailable */ }
    });
  });

  // Confirm before destructive submits
  document.addEventListener('submit', function (e) {
    var f = e.target;
    var src = e.submitter && e.submitter.hasAttribute('data-confirm') ? e.submitter : f;
    var msg = (isZh() && src.getAttribute('data-confirm-zh')) || src.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
    var btn = e.submitter;
    if (btn && btn.hasAttribute('data-busy')) {
      btn.dataset.label = btn.textContent;
      btn.textContent = 'Working… (up to a minute)';
      setTimeout(function () { btn.disabled = true; }, 0);
      document.body.classList.add('busy');
    }
  });

  // Select-all checkbox + counter in the product list
  var all = document.querySelector('[data-checkall]');
  var counter = document.querySelector('[data-selcount]');
  function count() {
    if (!counter) return;
    var n = document.querySelectorAll('input[name="ids"]:checked').length;
    counter.textContent = n + ' selected';
  }
  if (all) all.addEventListener('change', function () {
    document.querySelectorAll('input[name="ids"]').forEach(function (c) { c.checked = all.checked; });
    count();
  });
  document.addEventListener('change', function (e) { if (e.target.name === 'ids') count(); });

  // Copy portal link
  document.querySelectorAll('[data-copybtn]').forEach(function (b) {
    b.addEventListener('click', function () {
      var i = document.querySelector('[data-copy]');
      i.select();
      (navigator.clipboard ? navigator.clipboard.writeText(i.value) : Promise.reject()).catch(function () { document.execCommand('copy'); });
      b.textContent = 'Copied';
    });
  });

  // Live container fit on the product form (mirrors src/calc.js)
  var box = document.querySelector('[data-live-fit] .live-fit');
  if (box) {
    var C = { '20GP': [589, 235, 239, 17200], '40GP': [1203, 235, 239, 20000], '40HQ': [1203, 235, 269, 20000] };
    var val = function (id) { var el = document.getElementById(id); return el ? parseFloat(el.value) : NaN; };
    var fit = function (l, w, h, gw, c) {
      var o = [[l, w, h], [l, h, w], [w, l, h], [w, h, l], [h, l, w], [h, w, l]], best = 0;
      o.forEach(function (d) { var n = Math.floor(c[0] / d[0]) * Math.floor(c[1] / d[1]) * Math.floor(c[2] / d[2]); if (n > best) best = n; });
      return gw > 0 ? Math.min(best, Math.floor(c[3] / gw)) : best;
    };
    var update = function () {
      var l = val('f_carton_l_cm'), w = val('f_carton_w_cm'), h = val('f_carton_h_cm'), gw = val('f_carton_gw_kg'), upc = val('f_units_per_carton');
      if (!(l > 0 && w > 0 && h > 0)) { box.innerHTML = L('Enter the carton size and units per carton to see how many fit.', '请输入外箱尺寸和装箱数，系统将计算装柜数量。'); return; }
      var cbm = l * w * h / 1e6;
      var en = ['Carton ' + cbm.toFixed(4) + ' CBM'], zh = ['外箱 ' + cbm.toFixed(4) + ' 立方米'];
      Object.keys(C).forEach(function (k) {
        var n = fit(l, w, h, gw, C[k]);
        en.push(k + ': ' + n.toLocaleString() + ' ctns' + (upc > 0 ? ' = ' + (n * upc).toLocaleString() + ' pcs' : ''));
        zh.push(k + '：' + n.toLocaleString() + ' 箱' + (upc > 0 ? ' = ' + (n * upc).toLocaleString() + ' 件' : ''));
      });
      box.innerHTML = L(en.join(' · '), zh.join(' · '));
    };
    ['f_carton_l_cm', 'f_carton_w_cm', 'f_carton_h_cm', 'f_carton_gw_kg', 'f_units_per_carton'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.addEventListener('input', update);
    });
    update();
  }

  // Photo drop zone: drag & drop, choose, or paste images; previews with remove.
  var zone = document.querySelector('[data-dropzone]');
  if (zone && window.DataTransfer) {
    var input = zone.querySelector('input[type=file]');
    var previews = document.querySelector('[data-previews]');
    var max = parseInt(zone.getAttribute('data-max'), 10) || 10;
    var MAX_BYTES = 20 * 1024 * 1024;
    var dt = new DataTransfer();
    var note = document.createElement('p'); note.className = 'dz-note'; previews.after(note);
    var key = function (f) { return f.name + '|' + f.size + '|' + f.lastModified; };
    var add = function (list) {
      var skipped = [];
      var have = {}; Array.prototype.forEach.call(dt.files, function (f) { have[key(f)] = 1; });
      Array.prototype.forEach.call(list, function (f) {
        if (!/^image\//.test(f.type)) { skipped.push([f.name + ' (not an image)', f.name + '（不是图片）']); return; }
        if (f.size > MAX_BYTES) { skipped.push([f.name + ' (over 20 MB)', f.name + '（超过 20 MB）']); return; }
        if (have[key(f)]) return;
        if (dt.files.length >= max) { skipped.push([f.name + ' (limit ' + max + ')', f.name + '（超过 ' + max + ' 张上限）']); return; }
        dt.items.add(f); have[key(f)] = 1;
      });
      input.files = dt.files;
      var esc = function (x) { return x.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
      note.innerHTML = skipped.length ? L('Skipped: ' + esc(skipped.map(function (x) { return x[0]; }).join(', ')), '已跳过：' + esc(skipped.map(function (x) { return x[1]; }).join('，'))) : '';
      render();
    };
    var render = function () {
      previews.innerHTML = '';
      Array.prototype.forEach.call(dt.files, function (f, i) {
        var fig = document.createElement('figure');
        var img = document.createElement('img'); img.src = URL.createObjectURL(f); img.alt = '';
        var cap = document.createElement('figcaption'); cap.textContent = f.size >= 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB';
        var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'dz-remove'; rm.setAttribute('aria-label', 'Remove'); rm.textContent = '×';
        rm.addEventListener('click', function () {
          var next = new DataTransfer();
          Array.prototype.forEach.call(dt.files, function (g, j) { if (j !== i) next.items.add(g); });
          dt = next; input.files = dt.files; render();
        });
        fig.appendChild(img); fig.appendChild(cap); fig.appendChild(rm); previews.appendChild(fig);
      });
      zone.classList.toggle('has-files', dt.files.length > 0);
      var main = zone.querySelector('.dz-main');
      var n = dt.files.length;
      main.innerHTML = n
        ? L(n + ' photo' + (n > 1 ? 's' : '') + ' ready, click Save to upload. <u>Add more</u>', '已选择 ' + n + ' 张图片，点击保存即可上传。<u>继续添加</u>')
        : L('Drag &amp; drop photos here, or <u>choose files</u>', '将图片拖到此处，或<u>点击选择文件</u>');
    };
    input.addEventListener('change', function () {
      var picked = Array.prototype.slice.call(input.files);
      input.files = dt.files; // keep earlier picks
      add(picked);
    });
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'dragend'].forEach(function (ev) { zone.addEventListener(ev, function () { zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) { e.preventDefault(); zone.classList.remove('over'); add(e.dataTransfer.files); });
    // Don't let a near-miss drop open the image in the browser tab
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { if (!zone.contains(e.target)) { e.preventDefault(); add(e.dataTransfer.files); } });
    document.addEventListener('paste', function (e) {
      var files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) { e.preventDefault(); add(files); }
    });
  }
})();
