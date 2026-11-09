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

  // Auto-submit filter selects
  document.querySelectorAll('select[data-autosubmit]').forEach(function (el) { el.addEventListener('change', function () { el.form.submit(); }); });

  // Help dialogs: [data-open-dialog="id"] opens <dialog id>, [data-close-dialog] or a click on the backdrop closes it
  document.addEventListener('click', function (e) {
    var open = e.target.closest && e.target.closest('[data-open-dialog]');
    if (open) { var d = document.getElementById(open.getAttribute('data-open-dialog')); if (d && d.showModal) d.showModal(); return; }
    if (e.target.closest && e.target.closest('[data-close-dialog]')) { var dd = e.target.closest('dialog'); if (dd) dd.close(); return; }
    if (e.target.tagName === 'DIALOG' && e.target.classList.contains('help-dialog')) e.target.close();
  });

  // Confirm before destructive submits
  document.addEventListener('submit', function (e) {
    var f = e.target;
    var src = e.submitter && e.submitter.hasAttribute('data-confirm') ? e.submitter : f;
    var msg = (isZh() && src.getAttribute('data-confirm-zh')) || src.getAttribute('data-confirm');
    if (msg && msg.indexOf('{n}') > -1) {
      var n = f.querySelectorAll('input[name="ids"]:checked').length;
      if (!n) { e.preventDefault(); window.alert('Select at least one product first.'); return; }
      msg = msg.replace('{n}', n);
    }
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
  // Duplicate alert: tick only the extra copies (the oldest of each group stays unticked)
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-select-dups]');
    if (!b) return;
    document.querySelectorAll('input[name="ids"]').forEach(function (c) { c.checked = c.hasAttribute('data-dupextra'); });
    if (all) all.checked = false;
    count();
    var first = document.querySelector('input[data-dupextra]');
    if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

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
        ? L(n + ' photo' + (n > 1 ? 's' : '') + ' selected. They upload when you save. <u>Add more</u>', '已选择 ' + n + ' 张图片，保存时上传。<u>继续添加</u>')
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

  // Spreadsheet upload box: drag & drop, click to choose, or paste (a copied file, or copied spreadsheet cells -> CSV).
  (function () {
  var fz = document.querySelector('[data-filedrop]');
  if (fz && window.DataTransfer) {
    var fin = fz.querySelector('input[type=file]');
    var chip = fz.querySelector('[data-file]');
    var allowed = (fin.getAttribute('accept') || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s.charAt(0) === '.'; });
    var FMAX = 20 * 1024 * 1024;
    var esc2 = function (x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var size = function (n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
    var msg = document.createElement('p'); msg.className = 'dz-note'; msg.setAttribute('role', 'status'); fz.after(msg);
    var showFile = function () {
      var f = fin.files && fin.files[0];
      fz.classList.toggle('has-file', !!f);
      chip.hidden = !f;
      chip.innerHTML = f ? '<span class="dz-name">' + esc2(f.name) + '</span> <small>' + size(f.size) + '</small><button type="button" class="dz-remove" aria-label="Remove file">×</button>' : '';
      if (f) chip.querySelector('button').addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation(); fin.value = ''; msg.innerHTML = ''; showFile();
      });
    };
    var take = function (f) {
      var ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      if (allowed.length && allowed.indexOf(ext) < 0) { msg.innerHTML = L('“' + esc2(f.name) + '” is not allowed. Use ' + allowed.join(' or ') + '.', '“' + esc2(f.name) + '” 格式不支持，请使用 ' + allowed.join(' 或 ') + '。'); return false; }
      if (f.size > FMAX) { msg.innerHTML = L('“' + esc2(f.name) + '” is over 20 MB.', '“' + esc2(f.name) + '” 超过 20 MB。'); return false; }
      var d = new DataTransfer(); d.items.add(f); fin.files = d.files; msg.innerHTML = ''; showFile(); return true;
    };
    var takeList = function (list) {
      if (!list || !list.length) return;
      var ok = take(list[0]);
      if (ok && list.length > 1) msg.innerHTML = L('Only one file at a time. Using the first.', '一次只能上传一个文件，已使用第一个。');
    };
    // Copied spreadsheet cells arrive as tab-separated text: turn them into a CSV file.
    var tsvToCsv = function (text) {
      var rows = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
      return rows.map(function (r) { return r.split('\t').map(function (c) { return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(','); }).join('\r\n') + '\r\n';
    };
    fin.addEventListener('change', function () { msg.innerHTML = ''; showFile(); });
    ['dragenter', 'dragover'].forEach(function (ev) { fz.addEventListener(ev, function (e) { e.preventDefault(); fz.classList.add('over'); }); });
    ['dragleave', 'dragend'].forEach(function (ev) { fz.addEventListener(ev, function () { fz.classList.remove('over'); }); });
    fz.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); fz.classList.remove('over'); takeList(e.dataTransfer && e.dataTransfer.files); });
    // A near-miss drop elsewhere on the page uploads here instead of opening the file in the browser tab
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { if (!fz.contains(e.target)) { e.preventDefault(); takeList(e.dataTransfer && e.dataTransfer.files); } });
    document.addEventListener('paste', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('input:not([type=file]), textarea, select, [contenteditable]')) return; // typing somewhere else
      if (document.querySelector('[data-filebox]:hover, [data-filebox]:focus-within')) return; // a file box on this page takes it
      var cd = e.clipboardData; if (!cd) return;
      if (cd.files && cd.files.length) { e.preventDefault(); takeList(cd.files); return; }
      var text = cd.getData && cd.getData('text/plain');
      if (text && text.indexOf('\t') >= 0 && text.replace(/\n+$/, '').indexOf('\n') >= 0) {
        e.preventDefault();
        take(new File([tsvToCsv(text)], 'pasted-data.csv', { type: 'text/csv' }));
      }
    });
    showFile();
  }
  })();

  // Multi-file drop box (development projects): drag & drop, choose, or paste screenshots / copied files.
  (function () {
    var zones = Array.prototype.slice.call(document.querySelectorAll('[data-filebox]'));
    if (!zones.length || !window.DataTransfer) return;
    var MAXB = 20 * 1024 * 1024, last = null;
    var esc = function (x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var size = function (n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
    var key = function (f) { return f.name + '|' + f.size + '|' + f.lastModified; };
    var stamp = function () { var d = new Date(), p = function (n) { return ('0' + n).slice(-2); }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };
    var hasFiles = function (e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0; };
    zones.forEach(function (zone) {
      var input = zone.querySelector('input[type=file]'), list = zone.querySelector('[data-list]'), note = zone.querySelector('[data-note]'), main = zone.querySelector('[data-main]');
      var box = zone.querySelector('.mdrop-box'), idle = main.innerHTML, dt = new DataTransfer();
      var MAXN = parseInt(zone.getAttribute('data-max'), 10) || 20;
      var allowed = (input.getAttribute('accept') || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
      var describe = zone.hasAttribute('data-describe'), metaEl = zone.querySelector('[data-meta]');
      var KINDS = [['drawing', 'Drawing / CAD', 'e.g. Housing – 2D drawing rev B'], ['image', 'Image / reference', 'e.g. Reference photo – colour and finish'], ['spec', 'Specification', 'e.g. Material and performance requirements'], ['certificate', 'Certificate / test report', 'e.g. Required test report (FCC / CE)'], ['other', 'Other', 'e.g. What is this file?']];
      var guess = function (n) { var e = (n.match(/\.[^.]+$/) || [''])[0].toLowerCase(), l = n.toLowerCase();
        if (/^\.(step|stp|iges?|dxf|dwg|ai|stl)$/.test(e) || /draw|cad/.test(l)) return 'drawing';
        if (/^\.(png|jpe?g|webp|gif)$/.test(e)) return 'image';
        if (/cert|test.?report|fcc|rohs|reach|astm|en71/.test(l)) return 'certificate';
        if (/^\.(pdf|docx?|xlsx?|csv|txt|pptx?)$/.test(e)) return 'spec';
        return 'other'; };
      var meta = {}; // per file: kind, label, internal, controlling
      var syncMeta = function () {
        if (!metaEl) return;
        metaEl.value = JSON.stringify(Array.prototype.map.call(dt.files, function (f) { var m = meta[key(f)] || {}; return { kind: m.kind || guess(f.name), label: m.label || '', internal: !!m.internal, controlling: !!m.controlling && (m.kind || guess(f.name)) === 'drawing' }; }));
        var btn = zone.closest('form') && zone.closest('form').querySelector('[data-upload-btn]');
        if (btn) { btn.disabled = !dt.files.length; btn.textContent = dt.files.length ? 'Upload ' + dt.files.length + ' file' + (dt.files.length > 1 ? 's' : '') : 'Upload'; }
      };
      var render = function () {
        list.innerHTML = '';
        Array.prototype.forEach.call(dt.files, function (f, i) {
          var li = document.createElement('li');
          var m = meta[key(f)] = meta[key(f)] || { kind: guess(f.name), label: '', internal: false, controlling: false };
          if (describe) {
            li.className = 'dz-item';
            var opts = KINDS.map(function (k) { return '<option value="' + k[0] + '"' + (k[0] === m.kind ? ' selected' : '') + '>' + k[1] + '</option>'; }).join('');
            li.innerHTML = '<div class="dz-top"><span class="dz-name" title="' + esc(f.name) + '">' + esc(f.name) + '</span><small>' + size(f.size) + '</small></div>' +
              '<div class="dz-fields"><label><span>Type</span><select data-k="kind">' + opts + '</select></label>' +
              '<label class="grow"><span>What is this file?</span><input data-k="label" maxlength="120" value="' + esc(m.label) + '" placeholder="' + esc((KINDS.filter(function (k) { return k[0] === m.kind; })[0] || KINDS[4])[2]) + '"></label></div>' +
              '<div class="dz-checks"><label class="chk"><input type="checkbox" data-k="internal"' + (m.internal ? ' checked' : '') + '> Internal only</label>' +
              '<label class="chk"' + (m.kind === 'drawing' ? '' : ' hidden') + '><input type="checkbox" data-k="controlling"' + (m.controlling ? ' checked' : '') + '> Controlling drawing</label></div>';
            li.addEventListener('input', function (e) { var k = e.target.getAttribute('data-k'); if (!k) return; m[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; syncMeta(); });
            li.addEventListener('change', function (e) { if (e.target.getAttribute('data-k') === 'kind') { m.kind = e.target.value; if (m.kind !== 'drawing') m.controlling = false; render(); } });
          } else {
            li.innerHTML = '<span class="dz-name" title="' + esc(f.name) + '">' + esc(f.name) + '</span><small>' + size(f.size) + '</small>';
          }
          var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'dz-remove'; rm.setAttribute('aria-label', 'Remove'); rm.textContent = '×';
          rm.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            var next = new DataTransfer(); Array.prototype.forEach.call(dt.files, function (g, j) { if (j !== i) next.items.add(g); });
            dt = next; input.files = dt.files; note.innerHTML = ''; render();
          });
          if (describe) li.querySelector('.dz-top').appendChild(rm); else li.appendChild(rm); list.appendChild(li);
        });
        box.classList.toggle('has-files', dt.files.length > 0);
        syncMeta();
        var n = dt.files.length;
        main.innerHTML = n ? (MAXN === 1 ? L('Ready to upload. <u>Choose another</u>', '已选择，保存时上传。<u>重新选择</u>') : L(n + ' file' + (n > 1 ? 's' : '') + ' ready. <u>Add more</u>', '已选择 ' + n + ' 个文件。<u>继续添加</u>')) : idle;
      };
      var add = function (files) {
        var skipped = [], have = {};
        if (MAXN === 1 && files.length) dt = new DataTransfer(); // single-file box: a new file replaces the old one
        Array.prototype.forEach.call(dt.files, function (f) { have[key(f)] = 1; });
        Array.prototype.forEach.call(MAXN === 1 ? Array.prototype.slice.call(files, 0, 1) : files, function (f) {
          if (/^image\/(png|jpeg)$/.test(f.type) && /^image\.(png|jpe?g)$/i.test(f.name)) f = new File([f], 'pasted-image-' + stamp() + (f.type === 'image/png' ? '.png' : '.jpg'), { type: f.type, lastModified: Date.now() });
          var ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
          if (allowed.length && allowed.indexOf(ext) < 0) { skipped.push(f.name + ' (type not allowed)'); return; }
          if (f.size > MAXB) { skipped.push(f.name + ' (over 20 MB)'); return; }
          if (have[key(f)]) return;
          if (dt.files.length >= MAXN) { skipped.push(f.name + ' (limit ' + MAXN + ' files)'); return; }
          dt.items.add(f); have[key(f)] = 1;
        });
        input.files = dt.files;
        note.innerHTML = skipped.length ? L('Skipped: ' + esc(skipped.join(', ')), '已跳过：' + esc(skipped.join('，'))) : '';
        render();
      };
      input.addEventListener('change', function () { var picked = Array.prototype.slice.call(input.files); input.files = dt.files; add(picked); });
      ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { if (!hasFiles(e)) return; e.preventDefault(); box.classList.add('over'); }); });
      ['dragleave', 'dragend'].forEach(function (ev) { zone.addEventListener(ev, function () { box.classList.remove('over'); }); });
      zone.addEventListener('drop', function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); box.classList.remove('over'); last = zone; add(e.dataTransfer.files); });
      zone.addEventListener('mouseenter', function () { last = zone; }); zone.addEventListener('focusin', function () { last = zone; });
      zone._add = add;
      // After a failed/validated submit the form is rebuilt by the server, so nothing to restore here.
      var form = zone.closest('form'); if (form) form.addEventListener('submit', syncMeta);
      render();
    });
    document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-fl-toggle]'); if (!b) return; var row = b.closest('.fl-row'), f = row && row.querySelector('.fl-edit'); if (f) { f.hidden = !f.hidden; if (!f.hidden) { var i = f.querySelector('input[name=label]'); if (i) i.focus(); } } });
    // A near-miss drop must not make the browser open the file in this tab
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', function (e) { if (hasFiles(e) && !e.target.closest('[data-filebox]')) e.preventDefault(); });
    document.addEventListener('paste', function (e) {
      var cd = e.clipboardData; if (!cd || !cd.files || !cd.files.length) return; // plain text pastes are left alone
      var form = e.target && e.target.closest && e.target.closest('form');
      var zone = (form && form.querySelector('[data-filebox]')) || document.querySelector('[data-filebox]:hover') || (document.querySelector('[data-filedrop]') ? null : last || (zones.length === 1 ? zones[0] : null));
      if (!zone) return;
      e.preventDefault(); zone._add(cd.files);
    });
  })();

  // Supplier picker (development project invites): popup with search, select all shown, chips for the selection.
  (function () {
    var form = document.querySelector('[data-invite]'); if (!form) return;
    var dlg = form.querySelector('[data-pick-dlg]'), q = form.querySelector('[data-pick-q]'), all = form.querySelector('[data-pick-all]');
    var boxes = Array.prototype.slice.call(dlg.querySelectorAll('input[name=supplier_ids]'));
    var chips = form.querySelector('[data-picked]'), none = form.querySelector('[data-pick-none]'), count = form.querySelector('[data-pick-count]');
    var empty = form.querySelector('[data-pick-empty]'), btn = form.querySelector('[data-invite-btn]'), open = form.querySelector('[data-pick-open]');
    var esc = function (x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var shown = function () { return boxes.filter(function (b) { return !b.closest('li').hidden; }); };
    var sync = function () {
      var sel = boxes.filter(function (b) { return b.checked; });
      chips.innerHTML = sel.map(function (b) { return '<span class="pick-chip">' + esc(b.getAttribute('data-name')) + '<button type="button" data-unpick="' + esc(b.value) + '" aria-label="Remove">×</button></span>'; }).join('');
      none.hidden = sel.length > 0;
      count.textContent = sel.length + ' selected';
      open.textContent = sel.length ? 'Change selection' : '+ Choose suppliers';
      btn.disabled = !sel.length; btn.textContent = sel.length ? 'Invite ' + sel.length + ' supplier' + (sel.length > 1 ? 's' : '') : 'Invite selected';
      var vis = shown(); all.checked = vis.length > 0 && vis.every(function (b) { return b.checked; }); all.indeterminate = !all.checked && vis.some(function (b) { return b.checked; });
    };
    var filter = function () {
      var words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean), n = 0;
      dlg.querySelectorAll('.pick-list li').forEach(function (li) { var h = li.querySelector('input').getAttribute('data-q'); var ok = words.every(function (w) { return h.indexOf(w) >= 0; }); li.hidden = !ok; if (ok) n++; });
      empty.hidden = n > 0; sync();
    };
    open.addEventListener('click', function () { if (dlg.showModal) dlg.showModal(); q.focus(); q.select(); });
    dlg.querySelectorAll('[data-pick-done]').forEach(function (b) { b.addEventListener('click', function () { dlg.close(); }); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    form.querySelector('[data-pick-clear]').addEventListener('click', function () { boxes.forEach(function (b) { b.checked = false; }); sync(); });
    q.addEventListener('input', filter);
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var v = shown(); if (v.length === 1) { v[0].checked = !v[0].checked; sync(); } } });
    all.addEventListener('change', function () { shown().forEach(function (b) { b.checked = all.checked; }); sync(); });
    boxes.forEach(function (b) { b.addEventListener('change', sync); });
    chips.addEventListener('click', function (e) { var id = e.target.getAttribute && e.target.getAttribute('data-unpick'); if (!id) return; boxes.forEach(function (b) { if (b.value === id) b.checked = false; }); sync(); });
    form.addEventListener('submit', function (e) { if (!boxes.some(function (b) { return b.checked; })) { e.preventDefault(); open.click(); } });
    sync();
  })();

  // Message times in the viewer's own time zone; attachment previews in a popup.
  (function () {
    var lang = document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en-US';
    document.querySelectorAll('time[data-local]').forEach(function (el) {
      var d = new Date(el.getAttribute('datetime')); if (isNaN(d)) return;
      var opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
      if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
      try { el.textContent = d.toLocaleString(lang, opts); el.title = d.toLocaleString(lang, { dateStyle: 'full', timeStyle: 'short' }); } catch (e) {}
    });
    var dlg = null;
    var build = function () {
      dlg = document.createElement('dialog'); dlg.className = 'lightbox';
      dlg.innerHTML = '<button type="button" class="lb-nav lb-prev" aria-label="Previous">‹</button><button type="button" class="lb-nav lb-next" aria-label="Next">›</button><span class="lb-count"></span><div class="lb-bar"><a class="lb-dl" download>' + L('Download', '下载') + '</a><a class="lb-open" target="_blank" rel="noopener">' + L('Open in new tab', '新标签页打开') + '</a><button type="button" class="lb-x" aria-label="Close">×</button></div><div class="lb-body"></div>';
      document.body.appendChild(dlg);
      dlg.querySelector('.lb-x').addEventListener('click', function () { dlg.close(); });
      dlg.addEventListener('click', function (e) { if (e.target === dlg || e.target.classList.contains('lb-body')) dlg.close(); });
      dlg.addEventListener('close', function () { dlg.querySelector('.lb-body').innerHTML = ''; group = []; });
      dlg.querySelector('.lb-prev').addEventListener('click', function () { step(-1); });
      dlg.querySelector('.lb-next').addEventListener('click', function () { step(1); });
      dlg.addEventListener('keydown', function (e) { if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1); });
    };
    // Photos that belong together (data-gallery) can be paged with the arrows / ← →.
    var group = [], idx = 0;
    var show = function (b) {
      var url = b.getAttribute('data-preview'), body = dlg.querySelector('.lb-body');
      body.innerHTML = '';
      if (b.getAttribute('data-type') === 'image') { var im = document.createElement('img'); im.src = url; im.alt = ''; body.appendChild(im); dlg.classList.remove('doc'); }
      else { var fr = document.createElement('iframe'); fr.src = url; fr.title = 'Preview'; body.appendChild(fr); dlg.classList.add('doc'); }
      dlg.querySelector('.lb-dl').href = b.getAttribute('data-dl') || url;
      dlg.querySelector('.lb-open').href = url;
      var many = group.length > 1;
      dlg.classList.toggle('multi', many);
      dlg.querySelector('.lb-count').textContent = many ? (idx + 1) + ' / ' + group.length : '';
    };
    var step = function (d) { if (group.length < 2) return; idx = (idx + d + group.length) % group.length; show(group[idx]); };
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-preview]'); if (!b) return;
      if (!b.getAttribute('data-preview')) return;
      e.preventDefault(); if (!dlg) build();
      var g = b.getAttribute('data-gallery'), seen = {};
      group = g ? Array.prototype.filter.call(document.querySelectorAll('[data-preview][data-gallery="' + g + '"]'), function (x) {
        var u = x.getAttribute('data-preview'); if (!u || seen[u]) return false; seen[u] = 1; return x.offsetParent !== null || x === b; }) : [b];
      idx = Math.max(0, group.findIndex(function (x) { return x.getAttribute('data-preview') === b.getAttribute('data-preview'); }));
      show(b);
      if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else window.open(b.getAttribute('data-preview'), '_blank');
    });
  })();

  // Samples: show the detected carrier under a tracking-number field, and read a waybill photo with AI to fill the ship form.
  (function () {
    var detect = function (v) { v = String(v || '').toUpperCase().replace(/[\s-]/g, '');
      if (/^1Z[0-9A-Z]{16}$/.test(v)) return 'UPS'; if (/^\d{10}$/.test(v) || /^JJD\d{10,}$/.test(v)) return 'DHL Express';
      if (/^(\d{12}|\d{15}|\d{20}|\d{22})$/.test(v)) return 'FedEx'; return ''; };
    document.querySelectorAll('[data-detect-carrier]').forEach(function (inp) {
      var out = inp.parentNode.querySelector('[data-detect-out]');
      if (!out) { out = document.createElement('span'); out.className = 'detect'; inp.parentNode.appendChild(out); }
      var run = function () { var c = detect(inp.value); out.innerHTML = c ? '✓ ' + L('Detected: ', '已识别：') + c : ''; };
      inp.addEventListener('input', run); run();
    });
    var form = document.querySelector('[data-waybill-form]'); if (!form) return;
    var input = form.querySelector('input[name=waybill]'), msg = form.querySelector('[data-waybill-result]');
    if (!input || !window.fetch) return;
    var read = function () {
      var f = input.files && input.files[0]; if (!f) return;
      var fd = new FormData(); fd.append('waybill', f);
      msg.hidden = false; msg.className = 'read busy'; msg.innerHTML = L('Reading the waybill…', '正在识别运单…');
      fetch(form.getAttribute('data-waybill-form'), { method: 'POST', body: fd, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok || !j.tracking_number) { msg.className = 'read warn'; msg.innerHTML = L('Could not read it. Please type the tracking number.', '无法识别，请手动填写运单号。'); return; }
        var set = function (n, v) { var el = form.querySelector('[name=' + n + ']'); if (el && v != null && v !== '' && !el.value) { el.value = v; el.dispatchEvent(new Event('input')); } };
        var tn = form.querySelector('[name=tracking_no]'); if (tn) { tn.value = j.tracking_number; tn.dispatchEvent(new Event('input')); }
        if (j.carrier && j.carrier !== 'unknown') { var c = form.querySelector('[name=carrier]'); if (c) c.value = j.carrier; }
        set('weight_kg', j.weight_kg); set('boxes', j.pieces); set('declared_value', j.declared_value); if (j.ship_date) { var d = form.querySelector('[name=shipped_at]'); if (d) d.value = j.ship_date; }
        var safe = function (x) { return String(x).replace(/[^0-9A-Za-z .]/g, ''); };
        msg.className = 'read'; msg.innerHTML = '✓ ' + L('Read from the photo: ', '已识别：') + safe((j.carrier || '').toUpperCase()) + ' · ' + safe(j.tracking_number) + (j.weight_kg ? ' · ' + safe(j.weight_kg) + ' kg' : '') + '. ' + L('Please check below.', '请核对。');
      }).catch(function () { msg.className = 'read warn'; msg.innerHTML = L('Could not read it. Please type the tracking number.', '无法识别，请手动填写运单号。'); });
    };
    input.addEventListener('change', read);
  })();

  // Single choice popup (e.g. supplier on "Request a sample"): search, click a row to choose.
  document.querySelectorAll('[data-single-pick]').forEach(function (box) {
    var dlg = box.querySelector('[data-pick-dlg]'), q = box.querySelector('[data-pick-q]'), val = box.querySelector('[data-pick-value]'), label = box.querySelector('[data-pick-label]');
    var rows = Array.prototype.slice.call(dlg.querySelectorAll('.pick1-row')), count = box.querySelector('[data-pick-count]'), empty = box.querySelector('[data-pick-empty]');
    var filter = function () { var w = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean), n = 0;
      rows.forEach(function (r) { var ok = w.every(function (x) { return r.getAttribute('data-q').indexOf(x) >= 0; }); r.parentNode.hidden = !ok; if (ok) n++; });
      count.textContent = n + ' supplier' + (n === 1 ? '' : 's'); empty.hidden = n > 0; };
    var choose = function (r) { var changed = val.value !== r.getAttribute('data-id'); val.value = r.getAttribute('data-id'); label.textContent = r.getAttribute('data-name'); rows.forEach(function (x) { x.classList.toggle('on', x === r); }); box.classList.remove('invalid'); dlg.close();
      // Opened from the pencil next to the supplier name: save straight away.
      if (box.getAttribute('data-autosave') === '1') { box.removeAttribute('data-autosave'); var fm = box.closest('form'); if (changed && fm) { if (fm.requestSubmit) fm.requestSubmit(); else fm.submit(); } } };
    dlg.addEventListener('close', function () { setTimeout(function () { box.removeAttribute('data-autosave'); }, 0); });
    document.querySelectorAll('[data-change-supplier]').forEach(function (btn) { if (box.closest('#edit')) btn.addEventListener('click', function () { box.setAttribute('data-autosave', '1'); dlg.showModal(); q.value = ''; filter(); q.focus(); }); });
    box.querySelector('[data-pick-open]').addEventListener('click', function () { dlg.showModal(); q.value = ''; filter(); q.focus(); });
    box.querySelector('[data-pick-close]').addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    rows.forEach(function (r) { r.addEventListener('click', function () { choose(r); }); });
    q.addEventListener('input', filter);
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var v = rows.filter(function (r) { return !r.parentNode.hidden; }); if (v.length) choose(v[0]); } });
    var form = box.closest('form');
    if (form) form.addEventListener('submit', function (e) { if (!val.value) { e.preventDefault(); box.classList.add('invalid'); box.querySelector('[data-pick-open]').click(); } });
  });

  // New sample: switch between "Request a sample" and "Already shipped".
  (function () {
    var form = document.querySelector('[data-sample-mode]'); if (!form) return;
    var apply = function () { var m = (form.querySelector('input[name=mode]:checked') || {}).value || 'request';
      form.querySelectorAll('[data-for]').forEach(function (el) { el.hidden = el.getAttribute('data-for') !== m; });
      var tn = form.querySelector('[name=tracking_no]'); if (tn) tn.required = m === 'shipped';
      var due = form.querySelector('[name=due_ship_date]'); if (due) due.disabled = m === 'shipped'; };
    form.querySelectorAll('input[name=mode]').forEach(function (r) { r.addEventListener('change', apply); });
    apply();
  })();

  // Import review: open it as a full-screen window (more room for the row fields).
  (function () {
    var dlg = document.querySelector('[data-rv-modal]'); if (!dlg || !dlg.showModal) return;
    var reopen = document.querySelector('.rv-reopen');
    try { if (dlg.open) dlg.close(); dlg.showModal(); } catch (e) { return; }
    var closeBtn = dlg.querySelector('[data-rv-modal-close]');
    if (closeBtn) closeBtn.addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('close', function () { if (reopen) reopen.hidden = false; });
    var openBtn = document.querySelector('[data-rv-modal-open]');
    if (openBtn) openBtn.addEventListener('click', function () { reopen.hidden = true; dlg.showModal(); });
  })();

  // Import review: live count, select-all, no accidental approve with Enter, no double submit.
  (function () {
    var rv = document.querySelector('[data-import-review]'); if (!rv) return;
    var uses = function () { return Array.prototype.slice.call(rv.querySelectorAll('.rv-use')); };
    var countEl = rv.querySelector('[data-count]'); var all = rv.querySelector('[data-review-all]');
    var approve = rv.querySelector('[data-approve]');
    var sync = function () {
      var u = uses(); var n = u.filter(function (c) { return c.checked; }).length;
      if (countEl) countEl.textContent = n;
      if (all) all.checked = n === u.length && n > 0;
      u.forEach(function (c) { var tr = c.closest('tr'); if (tr) tr.classList.toggle('rv-off', !c.checked); });
      if (approve) approve.disabled = n === 0;
    };
    rv.addEventListener('change', function (e) { if (e.target.classList && e.target.classList.contains('rv-use')) sync(); });
    if (all) all.addEventListener('change', function () { uses().forEach(function (c) { c.checked = all.checked; }); sync(); });
    // Pop-up with the full product: open from the picture, previous / next, mirror the main fields both ways
    var esc = function (x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var field = function (rn, key) { return rv.querySelector('[name="r_' + rn + '_' + key + '"]') || rv.querySelector('[name="x_' + rn + '_' + key + '"]'); };
    var num = function (rn, key) { var el = field(rn, key); var v = el ? String(el.value).trim().replace(',', '.') : ''; var n = v === '' ? null : Number(v); return n !== null && isFinite(n) ? n : null; };
    var autosize = function (ta) {
      ta.style.height = 'auto';
      var cap = ta.closest('.rv-desc') && ta.closest('.rv-desc').classList.contains('open') ? Infinity : 220;
      ta.style.height = Math.min(ta.scrollHeight + 2, cap) + 'px';
      ta.style.overflowY = ta.scrollHeight + 2 > cap ? 'auto' : 'hidden';
    };
    var openDlg = function (d) {
      if (!d || !d.showModal) return;
      if (!d.open) d.showModal();
      d.querySelectorAll('textarea[data-autosize]').forEach(autosize);
      calc(d);
      var f = d.querySelector('.rv-dlg-form'); if (f) f.scrollTop = 0;
    };
    // Calculated values (same rules as the product analysis: best of 6 carton orientations, capped by container payload)
    var CONT = {}; try { CONT = JSON.parse(rv.getAttribute('data-containers') || '{}'); } catch (e) { CONT = {}; }
    var fit = function (l, w, h, gw, c) {
      var f = Math.floor; var o = [[l, w, h], [l, h, w], [w, l, h], [w, h, l], [h, l, w], [h, w, l]];
      var best = 0; o.forEach(function (x) { var n = f(c.l / x[0]) * f(c.w / x[1]) * f(c.h / x[2]); if (n > best) best = n; });
      var byW = gw > 0 ? f(c.payloadKg / gw) : Infinity;
      return { cartons: Math.min(best, byW), by: byW < best ? 'weight' : 'size' };
    };
    var calc = function (d) {
      var box = d.querySelector('[data-calc]'); if (!box) return;
      var rn = box.getAttribute('data-rn');
      var l = num(rn, 'carton_l_cm'), w = num(rn, 'carton_w_cm'), h = num(rn, 'carton_h_cm'), gw = num(rn, 'carton_gw_kg'), nw = num(rn, 'carton_nw_kg');
      var upc = num(rn, 'units_per_carton'), inner = num(rn, 'units_per_inner'), unitW = num(rn, 'unit_net_weight_kg');
      var hasDims = l > 0 && w > 0 && h > 0;
      var cbm = hasDims ? l * w * h / 1e6 : null;
      var issues = []; var missing = [];
      if (!(upc > 0)) missing.push('units per carton'); if (!hasDims) missing.push('carton size'); if (!(gw > 0)) missing.push('gross weight');
      if (missing.length) issues.push('Missing: ' + missing.join(', ') + ' (needed to calculate freight)');
      if (nw !== null && gw !== null && nw > gw) issues.push('Net weight is higher than gross weight');
      if (unitW && upc && nw && Math.abs(unitW * upc - nw) / nw > 0.25) issues.push('Unit weight × units per carton = ' + (Math.round(unitW * upc * 100) / 100) + ' kg, but the carton net weight is ' + nw + ' kg');
      if (inner && upc && upc % inner !== 0) issues.push('Units per carton (' + upc + ') is not a multiple of the inner pack (' + inner + ')');
      if (hasDims && gw && cbm > 0 && gw / cbm > 600) issues.push('Gross weight looks very high for this carton size (' + Math.round(gw / cbm) + ' kg/CBM)');
      var rows = ['20GP', '40GP', '40HQ'].map(function (code) {
        var sup = num(rn, 'supplier_qty_' + code.toLowerCase());
        var c = CONT[code]; var r = hasDims && c ? fit(l, w, h, gw, c) : null;
        var calcQty = r && upc > 0 ? r.cartons * upc : null;
        var st = '<span class="rv-st muted">—</span>';
        if (calcQty !== null && sup !== null) {
          var diff = calcQty ? Math.abs(sup - calcQty) / calcQty : 1;
          if (diff <= 0.05) st = '<span class="rv-st ok">✓ matches</span>';
          else { st = '<span class="rv-st warn">⚠ supplier is ' + Math.round(diff * 100) + '% ' + (sup > calcQty ? 'higher' : 'lower') + '</span>'; issues.push(code + ': supplier says ' + sup + ' pcs, the carton size gives ' + calcQty + ' pcs'); }
        } else if (calcQty !== null) st = '<span class="rv-st muted">not provided</span>';
        else if (sup !== null) st = '<span class="rv-st muted">cannot check</span>';
        return '<tr><th>' + code + '</th><td class="r">' + (sup === null ? '<span class="rv-na">—</span>' : sup) + '</td><td class="r">' + (r ? r.cartons + ' ctn' : '<span class="rv-na">—</span>') + '</td><td class="r">' + (calcQty === null ? '<span class="rv-na">—</span>' : '<b>' + calcQty + '</b>') + '</td><td>' + st + (r && r.by === 'weight' ? ' <span class="rv-st muted">weight-limited</span>' : '') + '</td></tr>';
      });
      box.innerHTML = '<div class="rv-calc-head"><span>Calculated by Lulyboo</span><span class="rv-calc-cbm">Carton CBM <b>' + (cbm === null ? '—' : (Math.round(cbm * 10000) / 10000) + ' m³') + '</b></span></div>' +
        '<table class="rv-calc-t"><thead><tr><th></th><th class="r">Supplier qty</th><th class="r">Cartons</th><th class="r">Calculated qty</th><th>Check</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>' +
        (issues.length ? '<ul class="rv-issues">' + issues.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '<p class="rv-ok">✓ No inconsistencies found</p>');
      var badge = d.querySelector('[data-calc-badge]');
      if (badge) { badge.hidden = !issues.length; badge.textContent = issues.length ? '⚠ ' + issues.length : ''; }
    };
    rv.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target : null; if (!t) return;
      var o = t.closest('[data-rv-open]');
      if (o) { openDlg(document.getElementById(o.getAttribute('data-rv-open'))); return; }
      var c = t.closest('[data-rv-close]');
      if (c) { var dd = c.closest('dialog'); if (dd) dd.close(); return; }
      var nav = t.closest('[data-rv-nav]');
      if (nav) { var tid = nav.getAttribute('data-rv-nav'); var cur = nav.closest('dialog'); var nx = tid && document.getElementById(tid); if (nx) { cur.close(); openDlg(nx); } return; }
      var pic = t.closest('[data-rv-pic]');
      if (pic) {
        var side = pic.closest('.rv-dlg-media'); var hero = side.querySelector('[data-rv-hero]');
        if (hero) { hero.href = pic.getAttribute('data-rv-pic'); hero.querySelector('img').src = pic.getAttribute('data-rv-pic'); }
        side.querySelectorAll('[data-rv-pic]').forEach(function (b) { b.classList.toggle('on', b === pic); });
        return;
      }
      var ex = t.closest('[data-rv-expand]');
      if (ex) { var dsc = ex.closest('.rv-desc'); dsc.classList.toggle('open'); ex.textContent = dsc.classList.contains('open') ? 'Collapse' : 'Expand'; autosize(dsc.querySelector('textarea')); return; }
      var ai = t.closest('[data-rv-ai]');
      if (ai) { runAi(ai); return; }
      var use = t.closest('[data-rv-ai-use]');
      if (use) { var out = use.closest('[data-rv-ai-out]'); var ta = out.closest('.rv-desc').querySelector('textarea'); ta.value = out.getAttribute('data-clean') || ''; autosize(ta); out.hidden = true; return; }
      var sg = t.closest('[data-rv-ai-apply]');
      if (sg) { var f = field(sg.getAttribute('data-rn'), sg.getAttribute('data-key')); if (f) { f.value = sg.getAttribute('data-val'); f.dispatchEvent(new Event('input', { bubbles: true })); sg.textContent = 'Applied ✓'; sg.disabled = true; } return; }
      var no = t.closest('[data-rv-ai-dismiss]');
      if (no) { no.closest('[data-rv-ai-out]').hidden = true; return; }
      if (e.target.tagName === 'DIALOG') e.target.close(); // click on the backdrop
    });
    // Optional AI clean-up of the description (and specs stated in it / on the picture). Nothing changes until "Use this".
    var runAi = function (btn) {
      var rn = btn.getAttribute('data-rn'); var d = btn.closest('dialog'); var out = d.querySelector('[data-rv-ai-out]');
      var ta = d.querySelector('textarea[name="x_' + rn + '_description"]');
      var tokenEl = rv.querySelector('input[name="token"]');
      if (!ta.value.trim()) { out.hidden = false; out.innerHTML = '<p class="rv-ai-err">There is no description to clean up.</p>'; return; }
      var label = btn.textContent; btn.disabled = true; btn.textContent = 'Working…'; out.hidden = false; out.innerHTML = '<p class="rv-na">Reading the description' + (d.querySelector('[data-rv-hero]') ? ' and the picture' : '') + '…</p>';
      var body = new URLSearchParams({ token: tokenEl ? tokenEl.value : '', row: rn, text: ta.value, name: (field(rn, 'product_name') || {}).value || '', materials: (field(rn, 'materials') || {}).value || '', size: (field(rn, 'product_size_cm') || {}).value || '' });
      fetch(rv.getAttribute('data-action') + '/ai-describe', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body, credentials: 'same-origin' })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Unexpected response' }; }); })
        .then(function (j) {
          if (!j.ok) { out.innerHTML = '<p class="rv-ai-err">' + esc(j.error || 'AI failed') + '</p>'; return; }
          var chips = Object.keys(j.suggestions || {}).filter(function (k) { var f = field(rn, k); return f && !String(f.value).trim(); }).map(function (k) {
            return '<li><span class="rv-na">' + esc(k.replace(/_/g, ' ')) + '</span> <b>' + esc(j.suggestions[k]) + '</b> <button type="button" class="rv-linkbtn" data-rv-ai-apply data-rn="' + esc(rn) + '" data-key="' + esc(k) + '" data-val="' + esc(j.suggestions[k]) + '">Fill</button></li>';
          }).join('');
          out.setAttribute('data-clean', j.description || '');
          out.innerHTML = '<div class="rv-ai-head"><b>✦ AI suggestion</b><span class="rv-na">Review it, then use or dismiss</span></div><pre class="rv-ai-text">' + esc(j.description) + '</pre>' +
            (chips ? '<ul class="rv-ai-sg">' + chips + '</ul>' : '') + '<div class="rv-ai-act"><button type="button" class="btn small" data-rv-ai-use>Use this description</button> <button type="button" class="btn small ghost" data-rv-ai-dismiss>Dismiss</button></div>';
        })
        .catch(function () { out.innerHTML = '<p class="rv-ai-err">Could not reach the server.</p>'; })
        .then(function () { btn.disabled = false; btn.textContent = label; });
    };
    var mirror = function (e) {
      var k = e.target.getAttribute && e.target.getAttribute('data-sync');
      if (k) {
        rv.querySelectorAll('[data-sync="' + k + '"]').forEach(function (el) { if (el !== e.target) el.value = e.target.value; });
        if (k.slice(-13) === '_product_name') { var dlg = document.getElementById('rv-dlg-' + k.split('_')[1]); var t = dlg && dlg.querySelector('[data-rv-title]'); if (t) t.textContent = e.target.value; }
      }
      var nm = e.target.name || '';
      var sku = /^x_(\d+)_supplier_sku$/.exec(nm);
      if (sku) { var d2 = document.getElementById('rv-dlg-' + sku[1]); if (d2) { var chip = d2.querySelector('[data-rv-sku-chip]'); chip.hidden = !e.target.value.trim(); chip.querySelector('[data-rv-sku]').textContent = e.target.value; } }
      if (e.target.matches && e.target.matches('textarea[data-autosize]')) autosize(e.target);
      // recalculate the packing check for the product that was edited
      var rnum = (k && /^r_(\d+)_/.exec(k)) || /^(?:x|r)_(\d+)_/.exec(nm);
      if (rnum) { var dd2 = document.getElementById('rv-dlg-' + rnum[1]); if (dd2 && dd2.open) calc(dd2); }
    };
    rv.addEventListener('input', mirror); rv.addEventListener('change', mirror);
    // Unit inside the field: the selected unit converts what is shown; the stored value stays in cm / kg / days.
    var groups = Array.prototype.slice.call(rv.querySelectorAll('[data-unit-group]'));
    var round = function (n) { return String(Math.round(n * 10000) / 10000); };
    var canonEls = function (g) { return g.getAttribute('data-canon').split('|').map(function (sel) { return rv.querySelector(sel); }); };
    var disps = function (g) { return Array.prototype.slice.call(g.querySelectorAll('.rv-disp')); };
    var factor = function (g) { var f = JSON.parse(g.getAttribute('data-factors')); return f[g.querySelector('.rv-u-sel').value] || 1; };
    var render = function (g) {
      var c = canonEls(g); var d = disps(g); var f = factor(g);
      d.forEach(function (el, i) { var v = c[i] ? c[i].value : ''; el.value = (v === '' || f === 1 || isNaN(Number(v))) ? v : round(Number(v) * f); });
    };
    groups.forEach(function (g) {
      g.addEventListener('input', function (e) {
        if (!e.target.classList.contains('rv-disp')) return;
        var d = disps(g); var i = d.indexOf(e.target); var c = canonEls(g)[i]; var f = factor(g);
        var v = e.target.value.trim(); var n = Number(v.replace(',', '.'));
        c.value = (v === '' || f === 1 || isNaN(n)) ? v : round(n / f);
        c.dispatchEvent(new Event('input', { bubbles: true }));
      });
      g.querySelector('.rv-u-sel').addEventListener('change', function () { render(g); });
    });
    // Edits made in the table update the pop-up fields as well
    rv.addEventListener('input', function (e) {
      if (!e.target.getAttribute || !e.target.getAttribute('data-sync')) return;
      groups.forEach(function (g) { if (canonEls(g).indexOf(e.target) > -1) render(g); });
    });
    // Group assignment of the category
    var catSel = rv.querySelector('[data-rv-cat]');
    var apply = rv.querySelector('[data-rv-cat-apply]');
    if (apply) apply.addEventListener('click', function () {
      if (!catSel.value) { catSel.focus(); return; }
      var n = 0;
      uses().forEach(function (c) {
        if (!c.checked) return;
        var tr = c.closest('tr'); var s = tr && tr.querySelector('select[name$="_category"]');
        if (s) { s.value = catSel.value; s.dispatchEvent(new Event('change', { bubbles: true })); n++; }
      });
      apply.textContent = apply.getAttribute('data-done') || apply.textContent;
      if (!n) window.alert('Tick at least one row first.');
    });
    var nocat = rv.querySelector('[data-rv-nocat]');
    if (nocat) nocat.addEventListener('click', function () {
      uses().forEach(function (c) { var tr = c.closest('tr'); var s = tr && tr.querySelector('select[name$="_category"]'); c.checked = !!s && !s.value; });
      sync();
    });
    var form = rv.querySelector('[data-review-form]');
    if (form) {
      form.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); });
      form.addEventListener('submit', function () { if (approve) setTimeout(function () { approve.disabled = true; }, 0); });
    }
    sync();
  })();

  // Step-by-step product wizard: one step at a time, validated before moving on. No reloads.
  var wiz = document.querySelector('[data-wizard]');
  if (wiz) {
    var steps = Array.prototype.slice.call(wiz.querySelectorAll('.wstep'));
    var tabs = Array.prototype.slice.call(wiz.querySelectorAll('[data-goto]'));
    var back = wiz.querySelector('[data-back]'), next = wiz.querySelector('[data-next]'), fin = wiz.querySelector('[data-finish]');
    var stepInput = wiz.querySelector('[data-step-input]');
    var cur = 0;
    wiz.classList.add('js');
    var fieldsOf = function (i) { return Array.prototype.slice.call(steps[i].querySelectorAll('input, select, textarea')); };
    var valid = function (i) {
      var bad = fieldsOf(i).filter(function (el) { return !el.disabled && el.willValidate && !el.checkValidity(); })[0];
      if (bad) { show(i); bad.reportValidity(); return false; }
      return true;
    };
    var val = function (id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
    var esc = function (x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var review = function () {
      var box = wiz.querySelector('[data-review]');
      if (!box) return;
      var files = wiz.querySelector('input[name=images]');
      var photos = (parseInt(box.getAttribute('data-photos'), 10) || 0) + (files && files.files ? files.files.length : 0);
      var price = val('f_unit_price'), cur$ = val('f_currency');
      var dims = [val('f_carton_l_cm'), val('f_carton_w_cm'), val('f_carton_h_cm')];
      var hasDims = dims.every(function (d) { return d !== ''; });
      var set = function (k, v) { var el = box.querySelector('[data-sum="' + k + '"]'); if (el) el.innerHTML = v === '' ? '—' : esc(v); };
      set('product_name', val('f_product_name'));
      set('category', val('f_category'));
      set('price', price ? price + ' ' + cur$ + (val('f_incoterm') ? ' ' + val('f_incoterm') : '') : '');
      set('moq', val('f_moq'));
      set('carton', hasDims ? dims.join(' × ') + ' cm' + (val('f_units_per_carton') ? ' · ' + val('f_units_per_carton') + ' pcs' : '') : '');
      set('photos', String(photos));
      var checks = [
        [!!val('f_product_name'), 'Product name', '产品名称', 1],
        [!!price, 'Unit price', '单价', 2],
        [photos > 0 || !!val('f_photo_link'), 'Photos or a photo link', '图片或图片链接', 0],
        [hasDims && !!val('f_units_per_carton'), 'Carton size and units per carton', '外箱尺寸和装箱数', 3],
        [!!val('f_carton_gw_kg'), 'Carton gross weight', '外箱毛重', 3],
      ];
      var missing = checks.filter(function (c) { return !c[0]; });
      box.querySelector('[data-checklist]').innerHTML = (missing.length
        ? '<li class="hint">' + L('Missing (you can still submit, but complete quotes are reviewed first):', '尚未填写（仍可提交，但信息完整的报价会优先审核）：') + '</li>'
        : '<li class="ok">' + L('All key information is filled in.', '关键信息已填写完整。') + '</li>')
        + missing.map(function (c) { return '<li class="miss"><button type="button" class="link" data-jump="' + c[3] + '">' + L(c[1], c[2]) + '</button></li>'; }).join('');
    };
    var show = function (i, scroll) {
      cur = Math.max(0, Math.min(steps.length - 1, i));
      steps.forEach(function (s, j) { s.classList.toggle('on', j === cur); });
      tabs.forEach(function (b, j) {
        b.classList.toggle('on', j === cur); b.classList.toggle('done', j < cur);
        if (j === cur) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      });
      back.hidden = cur === 0; next.hidden = cur === steps.length - 1; fin.hidden = cur !== steps.length - 1;
      stepInput.value = cur;
      if (cur === steps.length - 1) review();
      if (scroll) wiz.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    next.addEventListener('click', function () { if (valid(cur)) show(cur + 1, true); });
    back.addEventListener('click', function () { show(cur - 1, true); });
    tabs.forEach(function (b, j) {
      b.addEventListener('click', function () {
        for (var k = cur; k < j; k++) if (!valid(k)) return;
        show(j, true);
      });
    });
    wiz.addEventListener('click', function (e) {
      var j = e.target.closest && e.target.closest('[data-jump]');
      if (j) show(parseInt(j.getAttribute('data-jump'), 10), true);
    });
    // Browser validation on submit: jump to the step that holds the problem field
    wiz.addEventListener('invalid', function (e) {
      var s = e.target.closest('.wstep');
      if (s && steps.indexOf(s) !== cur) show(steps.indexOf(s));
    }, true);
    // Enter moves to the next step instead of submitting (except in text areas)
    wiz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'submit' && cur < steps.length - 1) {
        e.preventDefault(); if (valid(cur)) show(cur + 1, true);
      }
    });
    // AI helpers (buttons stay hidden if the server has no AI key: first call reports it)
    var aiBody = function () {
      var p = new URLSearchParams();
      Array.prototype.forEach.call(wiz.querySelectorAll('input:not([type=file]):not([type=hidden]), select, textarea'), function (el) { if (el.name && el.value) p.append(el.name, el.value); });
      var box = wiz.querySelector('[data-review]');
      var files = wiz.querySelector('input[name=images]');
      p.append('photos', String((box ? parseInt(box.getAttribute('data-photos'), 10) || 0 : 0) + (files && files.files ? files.files.length : 0)));
      return p.toString();
    };
    var aiCall = function (what, btn) {
      btn.disabled = true; btn.classList.add('busy');
      return fetch('/portal/ai/' + what, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: aiBody(), credentials: 'same-origin' })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .catch(function () { return { ok: false }; })
        .then(function (d) { btn.disabled = false; btn.classList.remove('busy'); return d; });
    };
    var PL = function (en, zh) { return document.documentElement.classList.contains('zh') ? zh : en; };
    var bi = function (m) { var mm = /⟪([\s\S]*?)⟫⟦([\s\S]*?)⟧/.exec(m || ''); return mm ? PL(mm[1], mm[2]) : m; };
    var msgOf = function (d) { return d && d.message ? bi(d.message) : PL('AI is unavailable right now.', 'AI 暂时不可用。'); };
    var desc = wiz.querySelector('#f_description');
    var dBtn = wiz.querySelector('[data-ai="describe"]');
    if (desc && dBtn) {
      var lab = wiz.querySelector('label[for="f_description"]');
      (lab || desc).insertAdjacentElement(lab ? 'beforeend' : 'beforebegin', dBtn); dBtn.hidden = false; dBtn.classList.add('ai-inline');
      dBtn.addEventListener('click', function () {
        aiCall('describe', dBtn).then(function (d) {
          if (d && d.ok && d.description) { if (!desc.value || confirm(PL('Replace the current description?', '替换当前描述？'))) desc.value = d.description; }
          else alert(msgOf(d));
        });
      });
    }
    var cBtn = wiz.querySelector('[data-ai="check"]');
    if (cBtn) {
      cBtn.hidden = false;
      cBtn.addEventListener('click', function () {
        var out = wiz.querySelector('[data-ai-result]');
        aiCall('check', cBtn).then(function (d) {
          if (!d || !d.ok) { out.innerHTML = '<li class="miss">' + esc(msgOf(d)) + '</li>'; return; }
          out.innerHTML = d.issues.length ? d.issues.map(function (x) { return '<li class="miss">' + esc(x) + '</li>'; }).join('') : '<li class="ok">' + L('AI found nothing to fix.', 'AI 未发现需要修改的地方。') + '</li>';
        });
      });
    }
    show(parseInt(wiz.getAttribute('data-start'), 10) || 0);
  }

  // Attach-files box (request log): drag & drop, choose, or paste files/screenshots anywhere on the page; list with remove.
  (function () {
    var zone = document.querySelector('[data-multidrop]');
    if (!zone || !window.DataTransfer) return;
    var input = zone.querySelector('input[type=file]');
    var list = document.querySelector('[data-multilist]');
    var note = document.querySelector('[data-multinote]');
    var MAXN = 10, MAXB = 20 * 1024 * 1024;
    var dt = new DataTransfer();
    var key = function (f) { return f.name + '|' + f.size + '|' + f.lastModified; };
    var size = function (n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
    var render = function () {
      list.innerHTML = '';
      Array.prototype.forEach.call(dt.files, function (f, i) {
        var li = document.createElement('li');
        var name = document.createElement('span'); name.className = 'dz-name'; name.textContent = f.name;
        var sz = document.createElement('small'); sz.textContent = size(f.size);
        var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'dz-remove'; rm.setAttribute('aria-label', 'Remove ' + f.name); rm.textContent = '\u00d7';
        rm.addEventListener('click', function () {
          var next = new DataTransfer();
          Array.prototype.forEach.call(dt.files, function (g, j) { if (j !== i) next.items.add(g); });
          dt = next; input.files = dt.files; render();
        });
        li.appendChild(name); li.appendChild(sz); li.appendChild(rm); list.appendChild(li);
      });
      zone.classList.toggle('has-file', dt.files.length > 0);
    };
    var add = function (files) {
      var skipped = [], have = {};
      Array.prototype.forEach.call(dt.files, function (f) { have[key(f)] = 1; });
      Array.prototype.forEach.call(files, function (f) {
        if (f.size > MAXB) { skipped.push(f.name + ' (over 20 MB)'); return; }
        if (have[key(f)]) return;
        if (dt.files.length >= MAXN) { skipped.push(f.name + ' (limit ' + MAXN + ')'); return; }
        dt.items.add(f); have[key(f)] = 1;
      });
      input.files = dt.files;
      note.textContent = skipped.length ? 'Skipped: ' + skipped.join(', ') : '';
      render();
    };
    input.addEventListener('change', function () { var picked = Array.prototype.slice.call(input.files); input.files = dt.files; add(picked); });
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'dragend'].forEach(function (ev) { zone.addEventListener(ev, function () { zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.remove('over'); add(e.dataTransfer.files); });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { if (!zone.contains(e.target)) { e.preventDefault(); add(e.dataTransfer.files); } });
    // Pasting a file or screenshot works even while typing in the Text box; pasted text is left alone.
    document.addEventListener('paste', function (e) {
      var files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) { e.preventDefault(); add(files); }
    });
  })();

  // Close the account menu when clicking elsewhere or pressing Escape
  (function () {
    var d = document.querySelector('.user-menu'); if (!d) return;
    document.addEventListener('click', function (e) { if (d.open && !d.contains(e.target)) d.open = false; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') d.open = false; });
  })();

  // Main navigation: click to open a group (hover also works on desktop), Escape / outside click closes, "Menu" toggles on small screens
  (function () {
    var nav = document.getElementById('mainnav'); if (!nav) return;
    var toggle = document.querySelector('.nav-toggle');
    var groups = nav.querySelectorAll('.nav-group');
    var closeAll = function (except) { Array.prototype.forEach.call(groups, function (g) { if (g !== except) { g.classList.remove('open'); g.querySelector('.nav-btn').setAttribute('aria-expanded', 'false'); } }); };
    Array.prototype.forEach.call(groups, function (g) {
      var btn = g.querySelector('.nav-btn');
      btn.addEventListener('click', function () { var open = !g.classList.contains('open'); closeAll(g); g.classList.toggle('open', open); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); });
    });
    document.addEventListener('click', function (e) { if (!nav.contains(e.target) && !(toggle && toggle.contains(e.target))) closeAll(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeAll(); if (toggle) { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); } } });
    if (toggle) toggle.addEventListener('click', function () { var o = nav.classList.toggle('open'); toggle.setAttribute('aria-expanded', o ? 'true' : 'false'); });
  })();
  // Selects that go somewhere / re-filter as soon as they change
  document.querySelectorAll('[data-autosubmit]').forEach(function (el) { el.addEventListener('change', function () { el.form && el.form.submit(); }); });
  document.querySelectorAll('[data-goto]').forEach(function (el) { el.addEventListener('change', function () { if (el.value) window.location.href = el.value; }); });

  // Long descriptions: clamp with a toggle; links to #duty open the folded section
  (function () {
    var t = document.querySelector('[data-clamp-toggle]'), box = document.querySelector('[data-clamp]');
    if (t && box) t.addEventListener('click', function () { var open = box.classList.toggle('clamp') === false; t.textContent = open ? 'Show less' : 'Show full description'; t.setAttribute('aria-expanded', open ? 'true' : 'false'); });
    var openHash = function () { var el = location.hash && document.querySelector(location.hash); if (el && el.tagName === 'DETAILS') el.open = true; };
    window.addEventListener('hashchange', openHash); openHash();
  })();

  // Product workspace: tabs (no extra requests: all panels are in the page), sticky header, AI description, unsaved-change guard
  (function () {
    var root = document.querySelector('[data-pw]'); if (!root) return;
    var key = 'lb-tab-' + root.getAttribute('data-product');
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.pw-tab'));
    var panels = Array.prototype.slice.call(root.querySelectorAll('[data-panel]'));
    var names = panels.map(function (p) { return p.getAttribute('data-panel'); });
    var store = function (v) { try { if (v === undefined) return sessionStorage.getItem(key); sessionStorage.setItem(key, v); } catch (e) { return null; } };
    var show = function (name, focus) {
      if (names.indexOf(name) < 0) name = 'overview';
      tabs.forEach(function (t) { var on = t.getAttribute('data-tab') === name; t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); });
      panels.forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== name; });
      store(name);
    };
    var fromHash = function () {
      var h = (location.hash || '').slice(1); if (!h) return false;
      var el = document.getElementById(h); if (!el) return false;
      var panel = h.indexOf('tab-') === 0 ? el : el.closest('[data-panel]');
      if (!panel) return false;
      show(panel.getAttribute('data-panel'));
      for (var d = el; d && d !== root; d = d.parentElement) if (d.tagName === 'DETAILS') d.open = true;
      if (h.indexOf('tab-') !== 0) el.scrollIntoView();
      return true;
    };
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { show(t.getAttribute('data-tab')); try { history.replaceState(null, '', '#tab-' + t.getAttribute('data-tab')); } catch (e) {} });
      t.addEventListener('keydown', function (e) {
        var n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
        if (n === null) return; e.preventDefault(); var t2 = tabs[(n + tabs.length) % tabs.length]; show(t2.getAttribute('data-tab'), true);
      });
    });
    if (!fromHash()) show(store() || 'overview');
    window.addEventListener('hashchange', fromHash);
    document.addEventListener('click', function (e) {
      var g = e.target.closest && e.target.closest('[data-goto-tab]'); if (g) { e.preventDefault(); show(g.getAttribute('data-goto-tab')); window.scrollTo(0, 0); }
      var o = e.target.closest && e.target.closest('[data-open-edit]'); if (o) { e.preventDefault(); show('overview'); var ed = document.getElementById('edit'); if (ed) { ed.open = true; ed.scrollIntoView(); } var mm = document.querySelector('.more-menu'); if (mm) mm.open = false; }
      var mm2 = document.querySelector('.more-menu'); if (mm2 && mm2.open && !mm2.contains(e.target)) mm2.open = false;
    });
    // Forms that jump to a tab after posting (AI actions land on Review)
    document.querySelectorAll('form[data-go-tab]').forEach(function (f) { f.addEventListener('submit', function () { store(f.getAttribute('data-go-tab')); }); });
    // Compact sticky header
    var head = document.querySelector('[data-pw-head]');
    // The compact header is shorter; the lost height is added back as margin so the page
    // below doesn't jump (on short pages that jump used to flip the header back and forth).
    if (head) {
      var topBar = document.querySelector('header.top');
      var setTop = function () { var h = topBar && getComputedStyle(topBar).position === 'sticky' ? topBar.offsetHeight : 0; document.documentElement.style.setProperty('--top-h', h + 'px'); };
      setTop(); window.addEventListener('resize', setTop);
      var baseMb = parseFloat(getComputedStyle(head).marginBottom) || 0, tick = false;
      var setStuck = function (on) {
        if (on === head.classList.contains('stuck')) return;
        var before = head.offsetHeight;
        head.classList.toggle('stuck', on);
        head.style.marginBottom = on ? (baseMb + Math.max(0, before - head.offsetHeight)) + 'px' : '';
      };
      var onScroll = function () {
        if (tick) return; tick = true;
        requestAnimationFrame(function () { tick = false; var y = window.scrollY; if (y > 120) setStuck(true); else if (y < 60) setStuck(false); });
      };
      window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
    }
    // Unsaved changes: Save is disabled until something changes; leaving the page warns
    var dirtyCount = 0;
    root.querySelectorAll('form[data-guard]').forEach(function (f) {
      var save = f.querySelector('[data-save]'), note = f.querySelector('[data-dirty-note]'), dirty = false;
      var snap = function () { return new URLSearchParams(new FormData(f)).toString(); };
      var base = snap();
      if (save) save.disabled = true;
      var check = function () { var d = snap() !== base; if (d !== dirty) { dirtyCount += d ? 1 : -1; dirty = d; } if (save) save.disabled = !d; if (note) note.hidden = !d; };
      f.addEventListener('input', check); f.addEventListener('change', check);
      f.addEventListener('submit', function () { if (dirty) { dirtyCount--; dirty = false; } });
    });
    window.addEventListener('beforeunload', function (e) { if (dirtyCount > 0) { e.preventDefault(); e.returnValue = ''; } });
    // AI description suggestion (needs approval before anything is saved)
    var btn = root.querySelector('[data-ai-describe]');
    if (btn) {
      var box = root.querySelector('[data-ai-box]'), txt = root.querySelector('[data-ai-text]'), msg = root.querySelector('[data-ai-msg]');
      btn.addEventListener('click', function () {
        msg.hidden = true; btn.disabled = true; var label = btn.textContent; btn.textContent = 'Working…';
        fetch(btn.getAttribute('data-url'), { method: 'POST', credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
          if (j.ok) { txt.value = j.description; box.hidden = false; txt.focus(); } else { msg.textContent = j.error || 'AI could not clean up the description.'; msg.hidden = false; }
        }).catch(function () { msg.textContent = 'AI could not be reached. Try again.'; msg.hidden = false; }).then(function () { btn.disabled = false; btn.textContent = label; });
      });
      var dis = root.querySelector('[data-ai-discard]'); if (dis) dis.addEventListener('click', function () { box.hidden = true; });
    }
  })();
})();
