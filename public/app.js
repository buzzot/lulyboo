// In-page confirm (replaces window.confirm, which a browser can silently switch off after "don't allow more dialogs").
// window.ask(message, { ok, cancel, danger, detail }) → Promise<boolean>
(function () {
  var dlg = null, done = null;
  function build() {
    dlg = document.createElement('dialog'); dlg.className = 'rp-modal ask-dlg'; dlg.setAttribute('aria-labelledby', 'ask-t');
    dlg.innerHTML = '<div class="ask-b"><p id="ask-t" class="ask-m"></p><p class="ask-d sub"></p><div class="ask-a"><button type="button" class="btn ghost" data-ask="0"></button><button type="button" class="btn" data-ask="1"></button></div></div>';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', function (e) { var b = e.target.closest('[data-ask]'); if (b) { finish(b.getAttribute('data-ask') === '1'); } else if (e.target === dlg) finish(false); });
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); finish(false); });
  }
  function finish(v) { if (dlg.open) dlg.close(); var d = done; done = null; if (d) d(v); }
  window.ask = function (msg, o) {
    o = o || {}; if (!dlg) build();
    if (done) finish(false);
    var zh = document.documentElement.classList.contains('zh');
    dlg.querySelector('.ask-m').textContent = msg;
    var d = dlg.querySelector('.ask-d'); d.textContent = o.detail || ''; d.hidden = !o.detail;
    var ok = dlg.querySelector('[data-ask="1"]'); ok.textContent = o.ok || (zh ? '确定' : 'OK'); ok.classList.toggle('danger-btn', !!o.danger);
    dlg.querySelector('[data-ask="0"]').textContent = o.cancel || (zh ? '取消' : 'Cancel');
    return new Promise(function (res) { done = res; if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); ok.focus(); });
  };
})();

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
    if (msg && f.dataset.asked !== '1') {
      e.preventDefault(); var sb = e.submitter;
      window.ask(msg, { danger: /delete|remove|stop|cancel|删除/i.test(msg), ok: /^delete/i.test(msg) ? 'Delete' : /^remove/i.test(msg) ? 'Remove' : null }).then(function (yes) {
        if (!yes) return; f.dataset.asked = '1';
        try { if (f.requestSubmit) f.requestSubmit(sb && sb.form === f ? sb : undefined); else f.submit(); } finally { delete f.dataset.asked; }
      });
      return;
    }
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

  // Copy a fixed text (e.g. a thread's email address)
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-copy-text]'); if (!b) return;
    e.preventDefault(); // also keeps a <details> it sits in from toggling
    var v = b.getAttribute('data-copy-text');
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).catch(function () { window.prompt('Copy:', v); });
    var old = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = old; }, 1500);
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
  var fitBox = document.querySelector('[data-live-fit]');
  if (fitBox) {
    var C = { '20GP': [589, 235, 239, 17200], '40GP': [1203, 235, 239, 20000], '40HQ': [1203, 235, 269, 20000] };
    var val = function (id) { var el = document.getElementById(id); return el ? parseFloat(String(el.value).replace(',', '.')) : NaN; };
    var fit = function (l, w, h, gw, c) {
      var o = [[l, w, h], [l, h, w], [w, l, h], [w, h, l], [h, l, w], [h, w, l]], best = 0;
      o.forEach(function (d) { var n = Math.floor(c[0] / d[0]) * Math.floor(c[1] / d[1]) * Math.floor(c[2] / d[2]); if (n > best) best = n; });
      var byKg = gw > 0 ? Math.floor(c[3] / gw) : Infinity;
      return { n: Math.min(best, byKg), kg: byKg < best };
    };
    var setTxt = function (sel, v) { var el = fitBox.parentNode.querySelector(sel); if (el) el.innerHTML = v; };   // L() returns bilingual markup
    var update = function () {
      var l = val('f_carton_l_cm'), w = val('f_carton_w_cm'), h = val('f_carton_h_cm'), gw = val('f_carton_gw_kg'), upc = val('f_units_per_carton');
      var ok = l > 0 && w > 0 && h > 0, cbm = ok ? l * w * h / 1e6 : 0;
      var chip = document.querySelector('[data-fit-cbm]'); if (chip) chip.textContent = ok ? cbm.toFixed(3) + ' m³' : '— m³';
      setTxt('[data-fit-cbm-big]', ok ? cbm.toFixed(3) + ' m³' : '—');
      setTxt('[data-fit-per]', ok ? L('per carton', '每箱') + (upc > 0 ? ' · ' + upc + ' ' + L('pcs', '件') + (gw > 0 ? ' · ' + gw + ' kg' : '') : '') : L('Enter the carton size to see how many fit.', '请输入外箱尺寸，系统将计算装柜数量。'));
      var icon = fitBox.querySelector('.pcx-box');
      if (icon) { var m = Math.max(l, w, h) || 1; icon.style.setProperty('--l', ok ? (l / m) : .8); icon.style.setProperty('--h', ok ? (h / m) : .6); icon.classList.toggle('on', ok); }
      Object.keys(C).forEach(function (k) {
        var row = fitBox.querySelector('[data-fit-row="' + k + '"]'); if (!row) return;
        var r = ok ? fit(l, w, h, gw, C[k]) : null;
        row.querySelector('[data-fit-c]').innerHTML = r ? r.n.toLocaleString() + (r.kg ? ' <span class="pcx-kg" title="Limited by weight · 受重量限制">⚖</span>' : '') : '—';
        row.querySelector('[data-fit-u]').textContent = r && upc > 0 ? (r.n * upc).toLocaleString() : '—';
        row.classList.toggle('kg', !!(r && r.kg));
      });
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
          var typeOk = allowed.some(function (a) { return a.indexOf('/') > 0 && (a === f.type || (/\/\*$/.test(a) && f.type.indexOf(a.slice(0, -1)) === 0)); });
          if (allowed.length && allowed.indexOf(ext) < 0 && !typeOk) { skipped.push(f.name + ' (type not allowed)'); return; }
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
      var zone = (form && form.querySelector('[data-filebox]')) || document.querySelector('dialog[open] [data-filebox]') || document.querySelector('[data-filebox]:hover') || (document.querySelector('[data-filedrop]') ? null : last || (zones.length === 1 ? zones[0] : null));
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

  // Request log: "Show more" on long texts, and reload once background AI summaries are ready.
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-more]'); if (!b) return;
    var box = b.previousElementSibling; if (!box) return;
    var open = box.classList.toggle('clamp') === false; b.textContent = open ? 'Show less' : 'Show more';
  });
  (function () {
    var w = document.querySelector('[data-ai-wait]'); if (!w || !window.fetch) return;
    var tries = 0;
    var tick = function () {
      tries++;
      fetch(w.getAttribute('data-ai-wait'), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.pending) { if (j.missing === 0) location.reload(); else w.textContent = 'Some summaries could not be made'; return; }
        if (tries < 30) setTimeout(tick, 3000); else w.textContent = 'Summaries are taking long: refresh later';
      }).catch(function () {});
    };
    setTimeout(tick, 2500);
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
    var choose = function (r) { var changed = val.value !== r.getAttribute('data-id'); val.value = r.getAttribute('data-id'); label.textContent = r.getAttribute('data-name'); rows.forEach(function (x) { x.classList.toggle('on', x === r); }); box.classList.remove('invalid'); dlg.close(); var nf = box.closest('form') && box.closest('form').querySelector('[name=new_supplier]'); if (nf && nf.type !== 'hidden') nf.value = '';
      // Filters: apply as soon as a supplier is picked
      if (box.hasAttribute('data-pick-submit') && changed && box.closest('form')) { box.closest('form').submit(); return; }
      // Opened from the pencil next to the supplier name: save straight away.
      if (box.getAttribute('data-autosave') === '1') { box.removeAttribute('data-autosave'); var fm = box.closest('form'); if (changed && fm) { if (fm.requestSubmit) fm.requestSubmit(); else fm.submit(); } } };
    // set from code (e.g. the holiday popup fills in the supplier AI found)
    box._pick = function (id) { var r = rows.filter(function (x) { return x.getAttribute('data-id') === id; })[0]; val.value = r ? id : ''; label.textContent = r ? r.getAttribute('data-name') : (box.getAttribute('data-placeholder') || 'Choose a supplier…'); rows.forEach(function (x) { x.classList.toggle('on', x === r); }); box.classList.remove('invalid'); };
    dlg.addEventListener('close', function () { setTimeout(function () { box.removeAttribute('data-autosave'); }, 0); });
    document.querySelectorAll('[data-change-supplier]').forEach(function (btn) { if (box.closest('#edit')) btn.addEventListener('click', function () { box.setAttribute('data-autosave', '1'); dlg.showModal(); q.value = ''; filter(); q.focus(); }); });
    box.querySelector('[data-pick-open]').addEventListener('click', function () { dlg.showModal(); q.value = ''; filter(); q.focus(); });
    box.querySelector('[data-pick-close]').addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    rows.forEach(function (r) { r.addEventListener('click', function () { choose(r); }); });
    q.addEventListener('input', filter);
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var v = rows.filter(function (r) { return !r.parentNode.hidden; }); if (v.length) choose(v[0]); } });
    var form = box.closest('form');
    // A form may offer "or a new supplier" instead of picking one (name=new_supplier): either is enough.
    var alt = form && form.querySelector('[name=new_supplier]');
    if (alt && alt.type !== 'hidden') alt.addEventListener('input', function () {
      if (alt.value.trim()) { val.value = ''; label.textContent = 'Choose a supplier…'; rows.forEach(function (x) { x.classList.remove('on'); }); box.classList.remove('invalid'); }
    });
    // only a required picker blocks the form ("All suppliers" on a filter is a valid choice)
    if (form && val.hasAttribute('required')) form.addEventListener('submit', function (e) { if (!val.value && !(alt && alt.value.trim())) { e.preventDefault(); box.classList.add('invalid'); box.querySelector('[data-pick-open]').click(); } });
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
      // jump target = the step holding that field (the pricing step isn't there when Lulyboo keeps prices hidden)
      var stepOfField = function (id) { var el = document.getElementById(id); var sec = el && el.closest('.wstep'); var i = sec ? steps.indexOf(sec) : -1; return i < 0 ? 0 : i; };
      var checks = [
        [!!val('f_product_name'), 'Product name', '产品名称', stepOfField('f_product_name')],
        document.getElementById('f_unit_price') ? [!!price, 'Unit price', '单价', stepOfField('f_unit_price')] : null,
        [photos > 0 || !!val('f_photo_link'), 'Photos or a photo link', '图片或图片链接', 0],
        [hasDims && !!val('f_units_per_carton'), 'Carton size and units per carton', '外箱尺寸和装箱数', stepOfField('f_units_per_carton')],
        [!!val('f_carton_gw_kg'), 'Carton gross weight', '外箱毛重', stepOfField('f_carton_gw_kg')],
      ].filter(Boolean);
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
          if (d && d.ok && d.description) { if (!desc.value) desc.value = d.description; else window.ask(PL('Replace the current description?', '替换当前描述？')).then(function (y) { if (y) desc.value = d.description; }); }
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

  // Main navigation: hover opens a group's menu (desktop, short delay), the group name goes to the area's main page;
  // on touch / small screens the first tap opens the menu. Escape / outside click closes, "Menu" toggles on small screens.
  (function () {
    var nav = document.getElementById('mainnav'); if (!nav) return;
    var toggle = document.querySelector('.nav-toggle');
    var groups = Array.prototype.slice.call(nav.querySelectorAll('.nav-group'));
    var canHover = window.matchMedia ? window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 901px)') : { matches: false };
    var setOpen = function (g, open) { g.classList.toggle('open', open); g.querySelector('.nav-btn').setAttribute('aria-expanded', open ? 'true' : 'false'); };
    var closeAll = function (except) { groups.forEach(function (g) { if (g !== except) setOpen(g, false); }); };
    groups.forEach(function (g) {
      var btn = g.querySelector('.nav-btn'), tIn, tOut;
      g.addEventListener('mouseenter', function () { if (!canHover.matches) return; clearTimeout(tOut); tIn = setTimeout(function () { closeAll(g); setOpen(g, true); }, nav.querySelector('.nav-group.open') ? 0 : 110); });
      g.addEventListener('mouseleave', function () { if (!canHover.matches) return; clearTimeout(tIn); tOut = setTimeout(function () { setOpen(g, false); }, 220); });
      btn.addEventListener('click', function (e) {
        if (canHover.matches) return; // desktop: the name is a link to the area's main page
        if (!g.classList.contains('open')) { e.preventDefault(); closeAll(g); setOpen(g, true); }
      });
      btn.addEventListener('keydown', function (e) { if (e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); closeAll(g); setOpen(g, true); var first = g.querySelector('.nav-menu a'); if (first) first.focus(); } });
      g.addEventListener('focusout', function (e) { if (!g.contains(e.relatedTarget)) setOpen(g, false); });
    });
    document.addEventListener('click', function (e) { if (!nav.contains(e.target) && !(toggle && toggle.contains(e.target))) closeAll(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeAll(); if (toggle) { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); } } });
    if (toggle) toggle.addEventListener('click', function () { var o = nav.classList.toggle('open'); toggle.setAttribute('aria-expanded', o ? 'true' : 'false'); });
  })();

  // ⌘K / Ctrl+K quick jump: pages from the menu + suppliers, POs, projects, samples, RFQs, products from /admin/quick
  (function () {
    var ov = document.querySelector('[data-qk-ov]'); if (!ov) return;
    var q = ov.querySelector('[data-qk-q]'), res = ov.querySelector('[data-qk-res]');
    var pages = []; try { pages = JSON.parse(ov.querySelector('[data-qk-pages]').textContent); } catch (e) { /* none */ }
    var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    var key = document.querySelector('[data-qk-key]'); if (key && !isMac) key.textContent = 'Ctrl K';
    var rows = [], sel = 0, timer = null, seq = 0, recs = [], lastFocus = null;
    var ICON = { Page: '↗', Supplier: '🏭', PO: '🧾', Project: '🧪', Sample: '📦', RFQ: '✉', Product: '🏷️' };
    var esc = function (x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    function draw() {
      var w = q.value.trim().toLowerCase();
      var pg = pages.filter(function (p) { return !w || (p.t + ' ' + p.g + ' ' + p.d).toLowerCase().indexOf(w) >= 0; })
        .map(function (p) { return { type: 'Page', title: p.t, sub: p.g, href: p.h }; });
      if (w) pg = pg.slice(0, 6);
      rows = pg.concat(recs); if (sel >= rows.length) sel = 0;
      if (!rows.length) { res.innerHTML = '<li class="qk-empty">' + (w.length >= 2 ? 'Nothing found' : 'Type to search') + '</li>'; return; }
      var html = '', i = 0, head = function (t) { html += '<li class="qk-h" role="presentation">' + t + '</li>'; };
      if (pg.length) { head('Pages'); pg.forEach(function (r) { html += row(r, i++); }); }
      if (recs.length) { head('Records'); recs.forEach(function (r) { html += row(r, i++); }); }
      res.innerHTML = html; mark();
    }
    function row(r, i) { return '<li class="qk-r" role="option" data-i="' + i + '"><span class="qk-ic" aria-hidden="true">' + (ICON[r.type] || '•') + '</span><span class="qk-t"><b>' + esc(r.title) + '</b>' + (r.sub ? '<small>' + esc(r.sub) + '</small>' : '') + '</span><span class="qk-type">' + esc(r.type === 'Page' ? '' : r.type) + '</span></li>'; }
    function mark() { Array.prototype.forEach.call(res.querySelectorAll('.qk-r'), function (li) { var on = +li.getAttribute('data-i') === sel; li.classList.toggle('sel', on); li.setAttribute('aria-selected', on); if (on) li.scrollIntoView({ block: 'nearest' }); }); }
    function search() {
      clearTimeout(timer); var w = q.value.trim(); var my = ++seq;
      if (w.length < 2) { recs = []; draw(); return; }
      timer = setTimeout(function () {
        fetch('/admin/quick?q=' + encodeURIComponent(w), { headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : { results: [] }; })
          .then(function (j) { if (my !== seq) return; recs = j.results || []; draw(); }).catch(function () {});
      }, 140);
    }
    function open() { lastFocus = document.activeElement; ov.hidden = false; document.body.classList.add('qk-on'); q.value = ''; recs = []; sel = 0; draw(); setTimeout(function () { q.focus(); }, 0); }
    function close() { ov.hidden = true; document.body.classList.remove('qk-on'); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
    function go(i, newTab) { var r = rows[i]; if (!r) return; if (newTab) { window.open(r.href, '_blank'); return; } close(); window.location.href = r.href; }
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); if (ov.hidden) open(); else close(); return; }
      if (ov.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(rows.length - 1, sel + 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); go(sel, e.metaKey || e.ctrlKey); }
    });
    q.addEventListener('input', function () { sel = 0; draw(); search(); });
    res.addEventListener('mousemove', function (e) { var li = e.target.closest('.qk-r'); if (li && +li.getAttribute('data-i') !== sel) { sel = +li.getAttribute('data-i'); mark(); } });
    res.addEventListener('click', function (e) { var li = e.target.closest('.qk-r'); if (li) go(+li.getAttribute('data-i'), e.metaKey || e.ctrlKey); });
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('[data-qk-open]')) open(); });
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

// Request log: "Draft reply with AI" → popup with To / CC / Subject / editable AI message.
(function () {
  var dlg = document.querySelector('[data-reply-modal]'); if (!dlg) return;
  var url = null;
  var $ = function (s) { return dlg.querySelector(s); };
  var load = function () {
    $('[data-reply-loading]').hidden = false; $('[data-reply-fields]').hidden = true; $('[data-reply-error]').hidden = true;
    fetch(url, { method: 'POST', credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      $('[data-reply-loading]').hidden = true;
      if (j.error) { var e = $('[data-reply-error]'); e.textContent = j.error; e.hidden = false; return; }
      ['to', 'cc', 'subject', 'body'].forEach(function (k) { $('[data-f="' + k + '"]').value = j[k] || ''; });
      $('[data-reply-ctx]').textContent = j.replying_to ? 'Answering ' + (j.replying_to.from || 'the supplier') + ' · ' + new Date(j.replying_to.at).toLocaleString() : '';
      var pts = j.open_points || []; var list = $('[data-reply-list]'); list.innerHTML = '';
      pts.forEach(function (p) { var li = document.createElement('li'); li.textContent = p; list.appendChild(li); });
      $('[data-reply-points]').hidden = !pts.length;
      $('[data-reply-fields]').hidden = false;
    }).catch(function () { $('[data-reply-loading]').hidden = true; var e = $('[data-reply-error]'); e.textContent = 'Could not reach the server. Try again.'; e.hidden = false; });
  };
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-draft-reply]'); if (!b) return;
    url = b.getAttribute('data-draft-reply'); if (dlg.showModal) dlg.showModal(); load();
  });
  dlg.addEventListener('click', function (e) {
    if (e.target.closest('[data-reply-close]')) dlg.close();
    else if (e.target.closest('[data-reply-again]')) load();
    else if (e.target.closest('[data-reply-copy]')) {
      var t = 'To: ' + $('[data-f="to"]').value + '\nSubject: ' + $('[data-f="subject"]').value + '\n\n' + $('[data-f="body"]').value;
      var btn = e.target.closest('[data-reply-copy]');
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy text'; }, 1500); }).catch(function () {});
    }
  });
})();

// Container planning: edit one order line (port, ready date, CBM…) in a popup.
(function () {
  var dlg = document.querySelector('[data-edit-dlg]'); if (!dlg) return;
  var form = dlg.querySelector('[data-edit-form]');
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-edit-order]'); if (!b) return;
    var o; try { o = JSON.parse(b.getAttribute('data-edit-order')); } catch (x) { return; }
    form.action = '/admin/logistics/planning/' + o.id + '/edit';
    dlg.querySelector('[data-f-title]').textContent = o.po;
    dlg.querySelector('[data-f-sub]').textContent = [o.supplier, o.product].filter(Boolean).join(' · ');
    dlg.querySelectorAll('[data-f]').forEach(function (el) {
      var k = el.getAttribute('data-f');
      if (el.type === 'checkbox') el.checked = !!o[k]; else el.value = o[k] == null ? '' : o[k];
    });
    if (dlg.showModal) dlg.showModal();
    var first = dlg.querySelector(o.port ? '[data-f=ready_date]' : '[data-f=port]'); if (first) first.focus();
  });
  dlg.addEventListener('click', function (e) { if (e.target.closest('[data-edit-close]') || e.target === dlg) dlg.close(); });
})();

// Forwarder update check window — used on Load containers, Shipments and the PO page.
// Paste / drop an email → AI compares it with the container → tick what to update. Pages pass hooks
// (meta, added, done, box); without hooks the page reloads after a change.
(function () {
  var FB = '/admin/orders/shipping/fwd';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var toastEl = null;
  function toast(t) { toastEl = toastEl || document.querySelector('[data-lp-toast]'); if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'lp-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); } toastEl.textContent = t; toastEl.classList.add('on'); clearTimeout(toastEl._t); toastEl._t = setTimeout(function () { toastEl.classList.remove('on'); }, 2600); }
  function post(url, data) {
    var body = new URLSearchParams(); Object.keys(data || {}).forEach(function (k) { body.append(k, data[k] == null ? '' : data[k]); });
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Something went wrong (' + r.status + ')' }; }); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'Could not save'); return j; });
  }
  var DEF = {
    meta: function () { return { name: '', sub: '' }; },
    added: function () {},
    done: function (cid, j, msg) { toast(msg); setTimeout(function () { location.reload(); }, 700); },
    box: function (cid, box) { return post('/admin/logistics/planning/containers/' + cid, { box: box }).then(function () { toast('Container type changed'); }); },
  };
  var fd = null, F = null, H = DEF;
  function dlg() {
    if (fd) return fd;
    fd = document.createElement('dialog'); fd.className = 'rp-modal lp-fdlg'; fd.setAttribute('aria-labelledby', 'lp-fd-t'); document.body.appendChild(fd);
    bind(); return fd;
  }
  function fdOpen() { if (fd.showModal) { if (!fd.open) fd.showModal(); } else fd.setAttribute('open', ''); }
  function fdTop(t, extra) { return '<div class="rp-top"><h2 id="lp-fd-t">' + t + '</h2>' + (extra || '') + '<button type="button" class="icon-btn" data-fd-close aria-label="Close">×</button></div>'; }
  function fdInput() {
    var m = F.meta;
    fd.innerHTML = '<form class="lp-fd" data-fd-form>' + fdTop('Forwarder update' + (m.name ? ' · ' + esc(m.name) : ''), m.sub ? '<span class="sub">' + esc(m.sub) + '</span>' : '') +
      '<div class="lp-fd-drop" data-fd-drop tabindex="0"><b>Drop the email, PDF or screenshot here</b><span>or paste with ⌘V · <button type="button" class="link small" data-fd-choose>choose a file</button></span><input type="file" multiple hidden data-fd-file accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.xlsx,.csv,image/*,application/pdf"></div>' +
      '<div class="lp-fd-files" data-fd-files>' + F.files.map(function (f, i) { return '<span class="fw-chip">📄 ' + esc(f.name) + ' <button type="button" class="lp-x" data-fd-rm="' + i + '" aria-label="Remove">×</button></span>'; }).join('') + '</div>' +
      '<textarea rows="8" data-fd-text placeholder="…or paste the email text, including the subject line" aria-label="Email text">' + esc(F.text || '') + '</textarea>' +
      '<div class="lp-fd-acts"><span class="sub">AI reads it and compares with what the portal has — nothing changes until you choose.</span><span class="r"><button type="button" class="btn ghost" data-fd-close>Cancel</button><button type="button" class="btn" data-fd-check>Check</button></span></div></form>';
  }
  function fdBusy(t) { fd.innerHTML = '<div class="lp-fd">' + fdTop('Forwarder update') + '<div class="lp-fd-busy"><span class="lp-spin"></span>' + esc(t) + '</div></div>'; }
  var ALERT_I = { bad: '⚠', warn: '⚠', ok: '✓' };
  function fdView() {
    var v = F.view, diffN = v.rows.filter(function (r) { return r.state !== 'same'; }).length;
    var rows = v.rows.slice().sort(function (a, b) { return (a.state === 'same') - (b.state === 'same'); });
    var st = { same: ['SAME', 'same'], new: ['NEW', 'new'], changed: ['DIFFERENT', 'chg'], suggest: ['SUGGESTED', 'new'] };
    var ticked = rows.filter(function (r) { return r.state !== 'same' && (F.tick[r.key] != null ? F.tick[r.key] : r.tick); }).length;
    var probs = v.alerts.filter(function (a) { return a.level !== 'ok'; }).length;
    fd.innerHTML = '<div class="lp-fd">' + fdTop(esc(v.type) + (v.forwarder ? ' · ' + esc(v.forwarder) : ''), (diffN || probs ? '<span class="cp-tag wait">' + [probs ? probs + ' to check' : '', diffN ? diffN + ' difference' + (diffN > 1 ? 's' : '') : ''].filter(Boolean).join(' · ') + '</span>' : '<span class="cp-tag ok">All the same</span>')) +
      (v.container ? '' : '<p class="lp-warn">Not attached to a container.</p>') +
      (v.summary ? '<div class="lp-fd-sum"><b>✦ AI summary</b>' + esc(v.summary) + '</div>' : '') +
      (v.alerts.length ? '<div class="lp-fd-al">' + v.alerts.map(function (a, i) { return '<div class="lp-fd-a ' + a.level + '"><span>' + ALERT_I[a.level] + '</span><span>' + esc(a.text) + '</span>' + (a.action ? '<button type="button" class="btn small' + (a.action.kind === 'copy' ? ' ghost' : '') + '" data-fd-act="' + i + '">' + esc(a.action.label) + '</button>' : '<span></span>') + '</div>'; }).join('') + '</div>' : '') +
      (rows.length ? '<div class="table-wrap"><table class="lp-fd-t"><thead><tr><th></th><th>Field</th><th>In the portal</th><th>In the email</th><th></th></tr></thead><tbody>' + rows.map(function (r) {
        var on = r.state !== 'same' && (F.tick[r.key] != null ? F.tick[r.key] : r.tick), s2 = st[r.state] || st.new;
        return '<tr class="' + (r.state === 'same' ? 'same' : '') + '"><td><input type="checkbox" data-fd-tick="' + esc(r.key) + '"' + (on ? ' checked' : '') + (r.state === 'same' ? ' disabled' : '') + ' aria-label="Update ' + esc(r.label) + '"></td><td>' + esc(r.label) + '</td><td class="was">' + (esc(r.old) || '—') + '</td><td><b>' + esc(r.value) + '</b>' + (r.note ? ' <span class="sub">' + esc(r.note) + '</span>' : '') + '</td><td><span class="lp-fd-st ' + s2[1] + '">' + s2[0] + '</span></td></tr>';
      }).join('') + '</tbody></table></div>' : (v.read ? '' : '<p class="sub">Nothing readable found in it.</p>')) +
      (v.files.length ? '<div class="lp-fd-files">' + v.files.map(function (f) { return '<a class="fw-chip" href="' + f.url + (f.inline ? '?inline=1' : '') + '" target="_blank" rel="noopener">📄 ' + esc(f.name) + '</a>'; }).join('') + '</div>' : '') +
      (v.text ? '<details class="lp-orig"><summary>Original message' + (v.from ? ' from ' + esc(v.from) : '') + '</summary><pre>' + esc(v.text) + '</pre></details>' : '') +
      '<div class="lp-fd-acts"><button type="button" class="link small" data-fd-discard>Discard</button><span class="r"><button type="button" class="btn ghost" data-fd-log>Save to log only</button><button type="button" class="btn" data-fd-apply' + (ticked && v.container ? '' : ' disabled') + '>Update ' + ticked + ' field' + (ticked === 1 ? '' : 's') + '</button></span></div></div>';
  }
  function fdLoad(id) { fdBusy('Opening…'); fdOpen(); fetch(FB + '/' + id + '/view', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error); F.view = j.view; F.tick = {}; fdView(); }).catch(function (x) { fd.close(); toast(x.message); }); }
  function fdDone(cid, j, msg) { var uid = F.view && F.view.id; fd.close(); H.done(cid, j, msg, uid); }
  function addFiles(list) { for (var i = 0; i < list.length; i++) F.files.push(list[i]); F.text = (fd.querySelector('[data-fd-text]') || {}).value || F.text; fdInput(); }
  function bind() {
  fd.addEventListener('click', function (e) {
    if (e.target === fd || e.target.closest('[data-fd-close]')) { fd.close(); return; }
    var b;
    if (e.target.closest('[data-fd-choose]')) { fd.querySelector('[data-fd-file]').click(); return; }
    if ((b = e.target.closest('[data-fd-rm]'))) { F.text = fd.querySelector('[data-fd-text]').value; F.files.splice(Number(b.getAttribute('data-fd-rm')), 1); fdInput(); return; }
    if (e.target.closest('[data-fd-check]')) {
      F.text = fd.querySelector('[data-fd-text]').value;
      if (!F.text.trim() && !F.files.length) { toast('Paste the email or drop a file first'); return; }
      var body = new FormData(); body.append('container', F.cid); body.append('text', F.text); F.files.forEach(function (f) { body.append('file', f, f.name); });
      fdBusy('Reading and comparing…');
      fetch(FB + '/check', { method: 'POST', body: body, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error); if (j.customs) { location.href = '/admin/logistics/customs?review=' + encodeURIComponent(j.customs); return; } F.view = j.view; F.tick = {}; H.added(F.cid, j.view.id); fdView(); }).catch(function (x) { toast(x.message); fdInput(); });
      return;
    }
    if ((b = e.target.closest('[data-fd-act]'))) {
      var a = F.view.alerts[Number(b.getAttribute('data-fd-act'))].action;
      if (a.kind === 'box') { H.box(F.cid, a.box).then(function () { return fetch(FB + '/' + F.view.id + '/view', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) { if (j.ok) { F.view = j.view; fdView(); } }); }).catch(function (x) { toast(x.message); }); return; }
      if (a.kind === 'copy') { (navigator.clipboard ? navigator.clipboard.writeText(a.text) : Promise.reject()).then(function () { toast('Reply copied — paste it into your email'); }, function () { window.prompt('Copy this reply:', a.text); }); return; }
    }
    if (e.target.closest('[data-fd-apply]')) {
      var keys = F.view.rows.filter(function (r) { return r.state !== 'same' && (F.tick[r.key] != null ? F.tick[r.key] : r.tick); }).map(function (r) { return r.key; });
      fdBusy('Saving…'); var cid = F.cid;
      post(FB + '/' + F.view.id + '/apply', { only: keys.join(',') }).then(function (j) { fdDone(cid, j, 'Updated ' + keys.length + ' field' + (keys.length === 1 ? '' : 's') + ' — kept in the log'); }).catch(function (x) { toast(x.message); fdView(); });
      return;
    }
    if (e.target.closest('[data-fd-log]')) { var cid2 = F.cid; fdBusy('Saving…'); post(FB + '/' + F.view.id + '/logonly').then(function (j) { fdDone(cid2, j, 'Kept in the log — nothing changed'); }).catch(function (x) { toast(x.message); fdView(); }); return; }
    if (e.target.closest('[data-fd-discard]')) { var cid3 = F.cid; post(FB + '/' + F.view.id + '/discard').then(function () { fdDone(cid3, null, 'Discarded'); }).catch(function (x) { toast(x.message); }); return; }
  });
  fd.addEventListener('change', function (e) {
    var k = e.target.getAttribute && e.target.getAttribute('data-fd-tick'); if (k) { F.tick[k] = e.target.checked; fdView(); return; }
    if (e.target.hasAttribute && e.target.hasAttribute('data-fd-file') && e.target.files.length) addFiles(e.target.files);
  });
  fd.addEventListener('dragover', function (e) { var z = e.target.closest && e.target.closest('[data-fd-drop]'); if (z) { e.preventDefault(); z.classList.add('over'); } });
  fd.addEventListener('dragleave', function (e) { var z = e.target.closest && e.target.closest('[data-fd-drop]'); if (z) z.classList.remove('over'); });
  fd.addEventListener('drop', function (e) { var z = e.target.closest && e.target.closest('[data-fd-drop]'); if (!z) return; e.preventDefault(); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  fd.addEventListener('paste', function (e) { if (!fd.querySelector('[data-fd-drop]')) return; var fl = e.clipboardData && e.clipboardData.files; if (fl && fl.length) { e.preventDefault(); addFiles(fl); } });
  }
  function fdLog(cid) {
    fdBusy('Opening the log…'); fdOpen();
    fetch(FB + '/container/' + cid + '/log', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.error);
      fd.innerHTML = '<div class="lp-fd">' + fdTop('Forwarder log' + (F.meta.name ? ' · ' + esc(F.meta.name) : '')) + (j.log.length ? '<ul class="lp-fd-log">' + j.log.map(function (x) {
        return '<li><span class="d">' + esc(x.at) + '</span><span><b>' + esc(x.type) + '</b>' + (x.changes.length ? ' — ' + esc(x.changes.join(', ')) : x.summary ? ' — ' + esc(x.summary) : '') + '<span class="sub">' + esc(x.how) + x.files.map(function (f) { return ' · <a href="' + f.url + (f.inline ? '?inline=1' : '') + '" target="_blank" rel="noopener">📄 ' + esc(f.name) + '</a>'; }).join('') + '</span>' +
          (x.text ? '<details class="lp-orig"><summary>Original</summary><pre>' + esc(x.text) + '</pre></details>' : '') + '</span><span class="cp-tag ' + (x.status === 'accepted' ? 'ok' : '') + '">' + (x.status === 'accepted' ? 'Updated' : 'Logged') + '</span></li>';
      }).join('') + '</ul>' : '<p class="sub">Nothing logged yet.</p>') + '</div>';
    }).catch(function (x) { fd.close(); toast(x.message); });
  }
  function start(cid, hooks) { H = {}; Object.keys(DEF).forEach(function (k) { H[k] = (hooks && hooks[k]) || DEF[k]; }); dlg(); F = { cid: cid, files: [], text: '', tick: {}, meta: H.meta(cid) }; }
  window.FwdCheck = {
    input: function (cid, hooks) { start(cid, hooks); fdInput(); fdOpen(); var t = fd.querySelector('[data-fd-text]'); if (t) t.focus(); },
    review: function (cid, uid, hooks) { start(cid, hooks); fdLoad(uid); },
    log: function (cid, hooks) { start(cid, hooks); fdLog(cid); },
  };
  // any page: <button data-fwc="containerId" data-fwc-name="…" data-fwc-sub="…">, data-fwc-rev="updateId", data-fwc-log
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-fwc]'); if (!b) return; e.preventDefault();
    var cid = b.getAttribute('data-fwc'), hooks = { meta: function () { return { name: b.getAttribute('data-fwc-name') || '', sub: b.getAttribute('data-fwc-sub') || '' }; } };
    if (b.hasAttribute('data-fwc-rev')) window.FwdCheck.review(cid, b.getAttribute('data-fwc-rev'), hooks);
    else if (b.hasAttribute('data-fwc-log')) window.FwdCheck.log(cid, hooks);
    else window.FwdCheck.input(cid, hooks);
  });
})();

// Container planning → Load containers: drag PO lines into containers, cartons animate in, fill bar.
(function () {
  var root = document.querySelector('[data-loadplan]'); if (!root) return;
  var D; try { D = JSON.parse(root.getAttribute('data-loadplan')); } catch (x) { return; }
  var poolEl = root.querySelector('[data-lp-pool]'), metaEl = root.querySelector('[data-lp-poolmeta]'), boxesEl = root.querySelector('[data-lp-containers]');
  var toastEl = document.querySelector('[data-lp-toast]');
  var fresh = {}; // order id → animate its cartons on next render
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var n2 = function (v) { return (Math.round(v * 100) / 100).toFixed(2); };
  var int = function (v) { return Number(v || 0).toLocaleString('en-US'); };
  var byId = function (id) { for (var i = 0; i < D.orders.length; i++) if (D.orders[i].id === id) return D.orders[i]; return null; };
  var cById = function (id) { for (var i = 0; i < D.containers.length; i++) if (D.containers[i].id === id) return D.containers[i]; return null; };
  var sById = function (id) { for (var i = 0; i < D.sailings.length; i++) if (D.sailings[i].id === id) return D.sailings[i]; return null; };
  var itemsOf = function (c) { return D.orders.filter(function (o) { return o.container === c.id; }); };
  var cName = function (c) { return c.ref || ((D.box[c.box] && D.box[c.box].lcl ? 'LCL shipment ' : 'Container ') + c.no); }; // a real identifier once known
  var sumOf = function (c, k) { return itemsOf(c).reduce(function (a, o) { return a + (o[k] || 0); }, 0); };
  var LCLC = (D.box.LCL || { cap: 15 }).cap, ZONE = (D.box.LCL && D.box.LCL.zone) || [12, 20];
  var usedOf = function (c) { return itemsOf(c).reduce(function (a, o) { return a + (o.cbm || 0); }, 0); };
  function toast(t) { if (!toastEl) return; toastEl.textContent = t; toastEl.classList.add('on'); clearTimeout(toastEl._t); toastEl._t = setTimeout(function () { toastEl.classList.remove('on'); }, 2600); }
  function post(url, data) {
    var body = new URLSearchParams(); Object.keys(data || {}).forEach(function (k) { body.append(k, data[k] == null ? '' : data[k]); });
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Something went wrong (' + r.status + ')' }; }); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'Could not save'); return j; });
  }
  function fail(e) { toast(e.message || 'Could not save'); setTimeout(function () { location.reload(); }, 1400); }

  // Pool: one card per PO (supplier + PO). Drag the card to load the whole PO; "Split" lets you drag single products.
  var ctnOpts = function () { return D.containers.map(function (c) { return '<option value="' + c.id + '">' + esc(cName(c)) + (D.box[c.box].lcl ? '' : ' · ' + esc(D.box[c.box].name)) + '</option>'; }).join(''); };
  var linesOfPo = function (pk) { return D.orders.filter(function (o) { return o.pk === pk; }); };
  var lineName = function (o) { return o.po + (o.product && linesOfPo(o.pk).length > 1 ? ' (' + o.product + ')' : ''); };
  function groupBy(list) { var g = {}, order = []; list.forEach(function (o) { if (!g[o.pk]) { g[o.pk] = []; order.push(o.pk); } g[o.pk].push(o); }); return order.map(function (k) { return g[k]; }); }
  function volInput(o) { return '<div class="lp-vol"><input type="number" step="0.01" min="0" inputmode="decimal" placeholder="m³" aria-label="Volume of ' + esc(o.po + (o.product ? ' ' + o.product : '')) + ' in m³" data-lp-v="' + o.id + '"><button type="button" class="btn small" data-lp-savecbm="' + o.id + '">Save</button><small>volume required</small></div>'; }
  var opened = {}; // PO key → products list open
  var RANK = { overdue: 5, waiting: 4, production: 3, ready: 2, shipped: 1 };
  var WHEN = { overdue: 'bad', production: 'blue', ready: 'ok', waiting: 'warn' };
  function whenChip(ls) {
    var worst = ls.reduce(function (a, x) { return (RANK[x.st] || 0) > (RANK[a.st] || 0) ? x : a; }, ls[0]);
    var dated = ls.filter(function (x) { return x.ready; }).sort(function (a, b) { return a.ready < b.ready ? 1 : -1; });
    var last = dated[0], st = D.states[worst.st] || { label: worst.st };
    var text = worst.st === 'waiting' ? 'Waiting on us' : last ? 'Ready ' + last.readyText : 'No ready date';
    return '<span class="lp-when ' + (WHEN[worst.st] || 'grey') + '" title="' + esc(st.label + (last ? ' · ready ' + last.readyText : '') + (dated.length > 1 && dated[dated.length - 1].ready !== last.ready ? ' (some products earlier)' : '')) + '">' + esc(text) + '</span>';
  }
  var vol = function (v, est) { return (est ? '<span class="lp-est" title="Estimated from carton size — confirm with the packing list">≈</span> ' : '') + n2(v) + ' m³'; };
  function poolCard(ls) {
    var o = ls[0], pk = o.pk, all = linesOfPo(pk), loaded = all.filter(function (x) { return x.container; });
    var ready = ls.filter(function (x) { return x.cbm; }), tot = ready.reduce(function (a, x) { return a + x.cbm; }, 0), noVol = ls.filter(function (x) { return !x.cbm; });
    var est = ready.some(function (x) { return x.est; }), multi = all.length > 1, open = multi && opened[pk];
    var tip = function (x) { return [x.product || x.po, x.qty ? int(x.qty) + ' pcs' : '', x.cbm ? n2(x.cbm) + ' m³' + (x.est ? ' (estimated)' : '') : 'volume missing'].filter(Boolean).join(' · '); };
    var row = function (x) {
      if (x.container) { var c = cById(x.container); return '<div class="lp-pr done" title="' + esc(tip(x)) + '"><span class="lp-h"></span><span class="lp-pn">' + esc(x.product || x.po) + '</span><span class="lp-ptag">' + esc(c ? cName(c) : 'Loaded') + '</span></div>'; }
      if (!x.cbm) return '<div class="lp-pr nov" title="' + esc(tip(x)) + '"><span class="lp-h"></span><span class="lp-pn">' + esc(x.product || 'Volume of the PO') + '</span><input class="lp-pin" type="number" step="0.01" min="0" inputmode="decimal" placeholder="m³" aria-label="Volume of ' + esc(x.product || x.po) + ' in m³" data-lp-v="' + x.id + '"><button type="button" class="lp-pok" data-lp-savecbm="' + x.id + '" aria-label="Save volume">✓</button></div>';
      return '<div class="lp-pr" draggable="true" data-id="' + x.id + '" title="' + esc(tip(x)) + ' — drag to ship separately"><span class="lp-h" aria-hidden="true">⋮⋮</span><span class="lp-pn">' + esc(x.product || x.po) + (x.part ? ' <em class="lp-chip-pt">part ' + x.part + '</em>' : '') + '</span><span class="lp-pv">' + vol(x.cbm, x.est) + '</span>' + partActs(x) + '</div>';
    };
    var sub = esc(o.supplier) + (!multi && o.product ? ' · ' + esc(o.product) : '');
    var flags = (noVol.length ? '<span class="lp-flag warn">' + (multi ? noVol.length + ' needs m³' : 'needs m³') + '</span>' : '') + (loaded.length ? '<span class="lp-flag blue">' + loaded.length + ' of ' + all.length + ' loaded</span>' : '');
    return '<div class="lp-po' + (open ? ' open' : '') + (ready.length ? '' : ' nocbm') + '" style="--c:' + o.color + '"' + (ready.length ? ' draggable="true" data-po="' + esc(pk) + '"' : '') + ' title="' + esc(multi ? all.map(tip).join('\n') : tip(o)) + '">' +
      '<div class="lp-pm"><div class="lp-r1"><a class="lp-polink" draggable="false" href="/admin/orders/view?supplier=' + encodeURIComponent(pk.split('|')[0]) + '&amp;po=' + encodeURIComponent(o.po) + '" title="Open PO ' + esc(o.po) + '">' + esc(o.po) + '</a><span class="lp-v">' + (ready.length ? vol(tot, est) : '<em>m³ ?</em>') + '</span>' +
        (D.containers.length && ready.length ? '<button type="button" class="lp-ld-btn" data-lp-loadmenu="' + esc(pk) + '" aria-haspopup="true" aria-label="Load ' + esc(o.po) + ' into a container">Load ▾</button>' : '') + '</div>' +
      '<div class="lp-sup">' + sub + '</div>' +
      '<div class="lp-r3">' + whenChip(ls) + flags + (!multi ? (o.part ? '<span class="lp-flag vio">part ' + o.part + '</span>' : '') + partActs(o) : '') + (multi ? '<button type="button" class="lp-pbtn" data-lp-open="' + esc(pk) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' + all.length + ' products <span class="lp-car">▾</span></button>' : '') + '</div></div>' +
      (!multi && !o.cbm ? '<div class="lp-prs single">' + row(o) + '</div>' : '') +
      (open ? '<div class="lp-prs">' + all.map(row).join('') + (ready.length > 1 ? '<div class="lp-phint">Drag a product to ship it separately</div>' : '') + '</div>' : '') +
      '</div>';
  }
  // split helpers
  function canSplit(x) { return x.cbm > 0 && ((x.cartons || 0) > 1 || (!(x.cartons > 0) && (x.qty || 0) > 1)); }
  function siblings(x) { return D.orders.filter(function (y) { return y.root === x.root && y.id !== x.id; }); }
  function partActs(x) {
    var a = '';
    if (x.part && siblings(x).length) a += '<button type="button" class="link small lp-pa" data-lp-merge="' + x.id + '" title="Join this part with the rest of the line">Merge back</button>';
    if (canSplit(x)) a += '<button type="button" class="link small lp-pa" data-lp-splitone="' + x.id + '" title="Split by quantity">Split…</button>';
    return a;
  }
  function biggerBox(c, u) {
    var cur = D.box[c.box], best = null;
    Object.keys(D.box).forEach(function (b) { var t = D.box[b]; if (t.lcl || t.cap <= cur.cap || t.cap < u) return; if (!best || t.cap < D.box[best].cap) best = b; });
    return best;
  }
  // "Load ▾" menu: one shared popover
  var menu = document.createElement('div'); menu.className = 'lp-menu'; menu.hidden = true; menu.setAttribute('role', 'menu'); document.body.appendChild(menu);
  function openMenu(btn) {
    var pk = btn.getAttribute('data-lp-loadmenu');
    menu.innerHTML = D.containers.filter(function (c) { return !locked(c); }).map(function (c) {
      var t = D.box[c.box], free = t.lcl ? '' : n2(Math.max(0, t.cap - usedOf(c))) + ' m³ free';
      return '<button type="button" role="menuitem" data-lp-to="' + c.id + '" data-pk="' + esc(pk) + '"><span>' + esc(cName(c)) + '</span><small>' + esc(t.lcl ? 'LCL' : t.name + ' · ' + free) + '</small></button>';
    }).join('');
    var r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + window.scrollY + 4) + 'px'; menu.style.left = Math.max(8, r.right + window.scrollX - 220) + 'px';
    menu.hidden = false; var f = menu.querySelector('button'); if (f) f.focus();
  }
  document.addEventListener('click', function (e) {
    var it = e.target.closest('[data-lp-to]');
    if (it && menu.contains(it)) { menu.hidden = true; loadPo(it.getAttribute('data-pk'), it.getAttribute('data-lp-to')); return; }
    if (!e.target.closest('[data-lp-loadmenu]')) menu.hidden = true;
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') menu.hidden = true; });
  window.addEventListener('scroll', function () { menu.hidden = true; }, true);
  function renderPool() {
    var list = D.orders.filter(function (o) { return !o.container; }), groups = groupBy(list);
    var tot = list.reduce(function (a, o) { return a + (o.cbm || 0); }, 0), miss = list.filter(function (o) { return !o.cbm; }).length;
    metaEl.textContent = groups.length + ' PO' + (groups.length === 1 ? '' : 's') + ' · ' + n2(tot) + ' m³';
    poolEl.innerHTML = list.length ? groups.map(poolCard).join('') : '<div class="lp-empty">' + (D.orders.length ? 'Everything at this port is loaded.<br>Drag a PO back here to unload it.' : 'No open orders at this port.') + '</div>';
  }

  var QST = { sent: ['Waiting for reply', 'plan'], replied: ['Quoted', 'ok'], declined: ['Declined', 'done'], chosen: ['Chosen', 'ok'] };
  var money = function (v) { return v == null ? '' : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }); };
  function quotesHTML(c) {
    var qs = c.quotes || []; if (!qs.length) return '';
    var priced = qs.filter(function (q) { return q.total != null && q.status !== 'declined'; });
    var best = priced.length ? Math.min.apply(null, priced.map(function (q) { return q.total; })) : null;
    var replied = qs.filter(function (q) { return q.status !== 'sent'; }).length;
    return '<div class="lp-q"><div class="lp-qh"><h3>Quotes <span class="sub">' + replied + ' of ' + qs.length + ' replied</span></h3>' + (priced.length ? '<a class="lp-rh" href="/admin/logistics/rates">Prices kept in Rate history</a>' : '') + '</div>' +
      '<div class="table-wrap"><table class="list lp-qt"><thead><tr><th>Forwarder</th><th class="r">All-in USD</th><th>Carrier</th><th>ETD</th><th>ETA</th><th class="r">Transit</th><th>Valid until</th><th class="r">Free days</th><th>Status</th><th></th></tr></thead><tbody>' +
      qs.map(function (q) {
        var st = QST[q.status] || [q.status, 'plan'], isBest = best != null && q.total === best && priced.length > 1;
        var detail = (q.summary || q.reply || q.files.length || q.charges.length || q.notes) ?
          '<tr class="lp-qd"><td colspan="10"><details' + (q.status === 'chosen' ? ' open' : '') + '><summary>' + (q.summary ? esc(q.summary.length > 140 ? q.summary.slice(0, 140) + '…' : q.summary) : 'Details') + '</summary>' +
            (q.summary && q.summary.length > 140 ? '<p>' + esc(q.summary) + '</p>' : '') +
            (q.charges.length ? '<ul class="lp-charges">' + q.charges.map(function (x) { return '<li>' + esc(x.name) + (x.amount != null ? ': ' + esc((x.currency || '') + ' ' + Number(x.amount).toLocaleString('en-US')) : '') + (x.per ? ' <span class="sub">' + esc(x.per) + '</span>' : '') + '</li>'; }).join('') + '</ul>' : '') +
            (q.notes ? '<p><b>Notes:</b> ' + esc(q.notes) + '</p>' : '') +
            (q.files.length ? '<p class="lp-qfiles">' + q.files.map(function (f) { return '<a href="' + f.url + (f.inline ? '?inline=1" target="_blank" rel="noopener"' : '"') + '>📎 ' + esc(f.name) + '</a>'; }).join(' ') + '</p>' : '') +
            (q.reply ? '<details class="lp-orig"><summary>Original email' + (q.from ? ' from ' + esc(q.from) : '') + (q.replied ? ' · ' + esc(q.replied) : '') + '</summary><pre>' + esc(q.reply) + '</pre></details>' : '') +
          '</details></td></tr>' : '';
        return '<tr class="' + (q.status === 'chosen' ? 'lp-chosen' : q.status === 'declined' ? 'done' : '') + '"><td><b>' + esc(q.company) + '</b><div class="sub">' + esc(q.code) + (q.sent ? ' · sent ' + esc(q.sent) : '') + '</div></td>' +
          '<td class="r">' + (q.total != null ? '<b>' + money(q.total) + '</b>' + (isBest ? ' <span class="cp-tag ok">Lowest</span>' : '') + (q.ocean != null && q.ocean !== q.total ? '<div class="sub">ocean ' + money(q.ocean) + '</div>' : '') + (q.currency && q.currency !== 'USD' ? '<div class="sub">' + esc(q.currency) + '</div>' : '') : '—') + '</td>' +
          '<td>' + (esc(q.carrier) || '—') + (q.vessel ? '<div class="sub">' + esc(q.vessel) + '</div>' : '') + '</td><td>' + (esc(q.etdText) || '—') + '</td><td>' + (esc(q.etaText) || '—') + '</td><td class="r">' + (q.transit != null ? q.transit + ' d' : '—') + '</td>' +
          '<td' + (q.expired ? ' class="lp-exp" title="Expired"' : '') + '>' + (esc(q.validText) || '—') + '</td><td class="r">' + (q.free != null ? q.free : '—') + '</td>' +
          '<td><span class="cp-tag ' + st[1] + '">' + st[0] + '</span></td>' +
          '<td class="lp-qa">' + (q.status !== 'chosen' && q.status !== 'declined' && (q.total != null || q.etd) ? '<button type="button" class="btn small" data-lp-choose="' + q.id + '" data-c="' + c.id + '">Choose</button>' : '') +
            '<button type="button" class="link small" data-lp-qedit="' + q.id + '" data-c="' + c.id + '">' + (q.status === 'sent' ? 'Enter quote' : 'Edit') + '</button></td></tr>' + detail;
      }).join('') + '</tbody></table></div></div>';
  }
  function findQuote(cid, qid) { var c = cById(cid); if (!c) return null; for (var i = 0; i < c.quotes.length; i++) if (c.quotes[i].id === qid) return c.quotes[i]; return null; }

  function ctlHTML(c) {
    return '<div class="lp-ctl"><select data-lp-box="' + c.id + '" aria-label="Container type">' + Object.keys(D.box).map(function (b) { return '<option value="' + b + '"' + (b === c.box ? ' selected' : '') + '>' + esc(D.box[b].lcl ? 'LCL (shared container)' : D.box[b].name) + '</option>'; }).join('') + '</select>' +
      '<select data-lp-sail="' + c.id + '" aria-label="Sailing"><option value="">' + (D.sailings.length ? 'Choose sailing…' : 'No sailings loaded') + '</option>' + D.sailings.map(function (s) { return '<option value="' + s.id + '"' + (s.id === c.sailing ? ' selected' : '') + '>' + esc(s.label) + '</option>'; }).join('') + '</select>' +
      '<select data-lp-status="' + c.id + '" aria-label="Status">' + [['planned', 'Planned'], ['requested', 'Quotes requested']].map(function (x) { return '<option value="' + x[0] + '"' + (c.status === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>' +
      '<button type="button" class="icon-btn" title="Remove" aria-label="Remove ' + esc(cName(c)) + '" data-lp-del="' + c.id + '">×</button></div>';
  }
  // PO chips: ready date on the chip, details on hover / focus (supplier, items, link to the PO)
  function popHTML(o, ls) {
    var sid = String(o.pk).split('|')[0];
    var days = {}; ls.forEach(function (x) { if (x.ready) days[x.ready] = 1; });
    var mixed = Object.keys(days).length > 1;
    return '<span class="lp-pop" role="tooltip"><span class="lp-pop-h"><b>' + esc(o.po) + '</b><span>' + esc(o.supplier) + '</span></span>' +
      '<span class="lp-pop-r"><span>Ready</span><b>' + (readyOf(ls) ? esc(short(readyOf(ls))) + (mixed ? ' <em>last item</em>' : '') : '<em>not set</em>') + ctnTotal(ls) + '</b></span>' +
      '<span class="lp-pop-l">' + ls.map(function (x) { return '<span><span class="lp-pop-n">' + esc(x.product || '(whole PO)') + (x.part ? ' <em class="lp-chip-pt">part ' + x.part + '</em>' : '') + (canSplit(x) ? '<button type="button" class="link small lp-pop-s" data-lp-splitone="' + x.id + '">Split…</button>' : '') + '</span><span>' + (x.qty ? int(x.qty) + ' pcs' : '') + (ctnOf(x) ? ' · ' + int(ctnOf(x)) + ' ctns' : '') + (x.cbm ? ' · ' + n2(x.cbm) + ' m³' : '') + (mixed && x.ready ? ' · ' + esc(x.readyText) : '') + '</span></span>'; }).join('') + '</span>' +
      '<a class="lp-pop-a" href="/admin/orders/view?supplier=' + encodeURIComponent(sid) + '&po=' + encodeURIComponent(o.po) + '">Open PO →</a></span>';
  }
  // cartons on a line: given, else qty ÷ pcs per carton (rounded up); 0 when unknown
  function ctnOf(x) { return x.cartons || (x.upc && x.qty ? Math.ceil(x.qty / x.upc) : 0); }
  function ctnTotal(ls) {
    var t = 0, miss = 0; ls.forEach(function (x) { var c = ctnOf(x); if (c) t += c; else if (x.product) miss++; });
    if (!t) return '';
    return '<span class="lp-pop-c"' + (miss ? ' title="' + miss + ' line' + (miss === 1 ? '' : 's') + ' without packing — not counted"' : '') + '>' + int(t) + (miss ? '+' : '') + ' ctns</span>';
  }
  function readyOf(ls) { var d = ls.map(function (x) { return x.ready; }).filter(Boolean).sort(); return d.length ? d[d.length - 1] : null; }
  function short(d) { var x = new Date(d + 'T12:00:00Z'); return x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
  function chipsHTML(items) {
    if (!items.length) return '';
    var cid = items[0].container, lk = locked(cById(cid));
    return '<div class="lp-chips">' + groupBy(items).map(function (ls) {
      var o = ls[0], tot = ls.reduce(function (a, x) { return a + (x.cbm || 0); }, 0), all = linesOfPo(o.pk).length, rd = readyOf(ls);
      var part = all > ls.length ? ' <em class="lp-chip-part" title="' + ls.length + ' of ' + all + ' products of this PO are in this container">' + ls.length + '/' + all + '</em>' : '';
      if (ls.some(function (x) { return x.part; })) part += ' <em class="lp-chip-pt" title="Part of a split line — the rest ships separately">part</em>';
      return '<span class="lp-chip" style="--c:' + o.color + '"' + (lk ? '' : ' draggable="true"') + ' tabindex="0" data-po="' + esc(o.pk) + '" data-from="' + cid + '"><i></i><b>' + esc(o.po) + '</b> ' + esc(n2(tot) + ' m³') + part + '<span class="lp-chip-rd' + (rd ? '' : ' none') + '">' + (rd ? esc(short(rd)) : 'no date') + '</span>' + popHTML(o, ls) + (lk ? '' : '<button type="button" class="lp-x" data-lp-outpo="' + esc(o.pk) + '" data-from="' + cid + '" title="Unload" aria-label="Unload ' + esc(o.po) + '">×</button>') + '</span>';
    }).join('') + '</div>';
  }
  // Cargo ready: each PO's ready date, and the date everything is ready — what the forwarder needs
  function readyHTML(c, items, sail) {
    if (!items.length) return '';
    var gs = groupBy(items).map(function (ls) { return { o: ls[0], d: readyOf(ls) }; });
    gs.sort(function (a, b) { return (a.d || '9999') < (b.d || '9999') ? -1 : 1; });
    var dated = gs.filter(function (g) { return g.d; }), missing = gs.length - dated.length;
    var last = dated.length ? dated[dated.length - 1] : null;
    var load = c.loading || (sail ? addDays(sail.etd, -3) : '');
    var lcl = D.box[c.box] && D.box[c.box].lcl;
    var late = last && load && last.d > load;
    var lateDays = late ? Math.round((Date.parse(last.d) - Date.parse(load)) / 864e5) : 0;
    return '<div class="lp-ready"><div class="lp-ready-l">' + gs.map(function (g) {
      var bad = g.d && load && g.d > load;
      return '<span class="lp-ready-i' + (g === last ? ' last' : '') + (bad ? ' late' : '') + '"><i style="background:' + g.o.color + '"></i><b>' + esc(g.o.po) + '</b><span class="sub">' + esc(g.o.supplier) + '</span><span class="lp-ready-d">' + (g.d ? esc(short(g.d)) : '—') + '</span></span>';
    }).join('') + '</div>' +
      '<div class="lp-ready-s' + (late ? ' late' : '') + '">' + (last ? 'All cargo ready <b>' + esc(short(last.d)) + '</b><span class="sub">last: ' + esc(last.o.po) + ' · ' + esc(last.o.supplier) + (missing ? ' · ' + missing + ' PO' + (missing > 1 ? 's' : '') + ' without a date' : '') + '</span>' +
        (late ? '<span class="lp-ready-w">' + lateDays + ' day' + (lateDays > 1 ? 's' : '') + ' after the ' + (lcl ? 'CFS delivery' : 'loading') + ' date (' + esc(short(load)) + ')</span>' : '')
        : 'Cargo ready date <b>not set</b><span class="sub">add ready dates to the POs</span>') + '</div></div>';
  }
  function addDays(d, n) { var x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  function ldHTML(c, sail) {
    var lcl = D.box[c.box] && D.box[c.box].lcl, auto = sail ? addDays(sail.etd, -3) : '';
    return '<div class="lp-ld"><label>' + (lcl ? 'Delivery to CFS' : 'Loading date') + ' <input type="date" data-lp-ld="' + c.id + '" value="' + esc(c.loading || auto) + '"></label>' +
      '<span class="sub">' + (c.loading ? 'set by you' : sail ? 'ETD − 3 days' : 'choose a sailing or a date') + ' · each supplier is asked for shipping documents that day at 9:00 China time' + (c.containerNo ? ' · <b>' + esc(c.containerNo) + '</b>' : '') + '</span></div>';
  }
  // forwarder data once booked: POL ──🚢── POD with ETA
  function fwdLineHTML(c) {
    var f = c.fwd || {}, n = (c.fwdReview || []).length;
    if (!c.fwd && !n && !c.fwdLog) return '';
    var bits = [f.booking ? 'Booking <b>' + esc(f.booking) + '</b>' : '', esc(f.carrier), esc(f.vessel), f.etdText ? 'ETD <b>' + esc(f.etdText) + '</b>' : '', f.etaText ? 'ETA <b>' + esc(f.etaText) + '</b>' + (f.etaPrev ? ' <s>' + esc(f.etaPrev) + '</s>' : '') : '', f.cut ? esc(f.cutName) + ' <b>' + esc(f.cut) + '</b>' : '', f.hbl ? 'HBL ' + esc(f.hbl) : '', esc(f.no)].filter(Boolean);
    return '<div class="lp-fwl"><b class="lp-fwl-n">⚓ ' + esc(f.forwarder || 'Forwarder') + '</b><span class="sub">' + bits.join(' · ') + '</span>' +
      (n ? '<button type="button" class="lp-fwl-rev" data-lp-fwdrev="' + c.id + '">' + n + ' update' + (n > 1 ? 's' : '') + ' to review</button>' : '') +
      (c.fwdLog ? '<button type="button" class="link small" data-lp-fwdlog="' + c.id + '">Log (' + c.fwdLog + ')</button>' : '') +
      (f.track ? '<a class="fw-track" href="' + esc(f.track) + '" target="_blank" rel="noopener">Track ↗</a>' : '') + '</div>';
  }
  function voyHTML(c) {
    var f = c.fwd; if (!f || (!f.etd && !f.eta)) return fwdLineHTML(c);
    var a = Date.parse(f.etd), b = Date.parse(f.eta), t = Date.parse(D.today);
    var pct = f.stage === 'arrived' ? 100 : f.stage === 'booked' || !a || !b ? 0 : Math.max(4, Math.min(96, Math.round((t - a) / Math.max(1, b - a) * 100)));
    return '<div class="fw-voy"><b>' + esc(f.pol || D.portName) + '</b><span class="sub">' + esc(f.etdText) + '</span><div class="fw-bar"><i style="width:' + pct + '%"></i><em style="left:' + pct + '%">🚢</em></div><b>' + esc(f.pod || '—') + '</b><span class="sub fw-eta">' + (f.etaText ? 'ETA ' + esc(f.etaText) : '') + (f.etaPrev ? ' <s>' + esc(f.etaPrev) + '</s>' : '') + '</span></div>' + fwdLineHTML(c);
  }
  function footHTML(c, items, sail, canReq, why) {
    var sups = {}; items.forEach(function (o) { sups[o.supplier] = 1; });
    return ldHTML(c, sail) + '<div class="lp-foot"><span class="sub">' + (items.length ? '<b>' + groupBy(items).length + ' PO' + (groupBy(items).length > 1 ? 's' : '') + '</b>' + (groupBy(items).length !== items.length ? ' (' + items.length + ' products)' : '') + ' · ' + Object.keys(sups).length + ' supplier' + (Object.keys(sups).length > 1 ? 's' : '') + ' · ' + int(items.reduce(function (a, o) { return a + o.qty; }, 0)) + ' pcs' + (sail ? ' · ' + esc(sail.label.split(' · ')[1] || '') : '') : 'Empty — drag POs from the left') + '</span>' +
      '<div class="lp-acts"><button type="button" class="btn ghost small" data-lp-fwd="' + c.id + '" title="Paste or drop an email from the forwarder — AI compares it with this container">＋ Forwarder update</button><button type="button" class="btn ghost small" data-lp-ship="' + c.id + '"' + (items.length ? '' : ' disabled') + '>Mark shipped</button>' +
      (items.length ? '<button type="button" class="btn ' + (c.status === 'requested' ? '' : 'ghost ') + 'small" data-lp-book="' + c.id + '" title="The forwarder confirmed space and cargo: record it and lock this container">Confirm booking</button>' : '') +
      '<button type="button" class="btn ' + (c.status === 'requested' ? 'ghost ' : '') + 'small" data-lp-request="' + c.id + '"' + (canReq ? '' : ' disabled title="' + esc(why) + '"') + '>' + (c.quotes && c.quotes.length ? 'Ask more forwarders' : 'Request quotes') + '</button></div></div>';
  }
  // Booked: the forwarder confirmed space and cargo. The card is locked and compact: stages, confirmed vs planned, dates.
  function locked(c) { return !!c && c.status === 'booked'; }
  function stepsHTML(c) {
    var at = c.status === 'booked' ? 2 : c.status === 'requested' ? 1 : 0;
    return '<ol class="lp-steps" aria-label="Stage">' + ['Planned', 'Quotes', 'Booked', 'Sailed'].map(function (l, i) { return '<li class="' + (i < at ? 'done' : i === at ? 'now' : '') + '"' + (i === at ? ' aria-current="step"' : '') + '><i>' + (i < at ? '✓' : i + 1) + '</i>' + l + '</li>'; }).join('') + '</ol>';
  }
  // Booked Volume tile: how full the box is, against its real inside volume (40HQ 76.4 m³); the practical load used for
  // planning (65 m³) is a tick on the bar. grey < 60% · green up to the practical load · amber above it · red > 95%.
  function volTile(c, v, sub) {
    var t = D.box[c.box] || {};
    if (t.lcl || !t.inner || !(v > 0)) return '<div class="lp-st"><b>' + n2(v) + ' m³</b><span>Volume' + (t.name ? ' · ' + esc(t.name) : '') + '</span>' + sub + '</div>';
    var pct = v / t.inner * 100, capPct = t.cap / t.inner * 100;
    var lvl = pct > 95 ? 'over' : v > t.cap ? 'tight' : pct < 60 ? 'low' : 'ok';
    return '<div class="lp-st lp-volt"><div class="lp-vf"><b>' + n2(v) + ' m³</b><em class="' + lvl + '" title="' + n2(v) + ' of ' + n2(t.inner) + ' m³ inside volume">' + Math.round(pct) + '% full</em></div><span>Volume · ' + esc(t.name) + '</span>' +
      '<div class="lp-vbar" role="img" aria-label="' + Math.round(pct) + '% of the container volume"><i class="' + lvl + '" style="width:' + Math.min(100, pct).toFixed(1) + '%"></i><u style="left:' + capPct.toFixed(1) + '%" title="practical load ' + t.cap + ' m³"></u></div>' +
      '<div class="lp-vcap"><span>practical ' + t.cap + '</span><span>max ' + Math.round(t.inner) + ' m³</span></div>' + sub + '</div>';
  }
  function bookedHTML(c) {
    var items = itemsOf(c), f = c.fwd || {}, k = f.confirmed || {}, sail = sById(c.sailing);
    var ctnP = items.reduce(function (a, o) { return a + ctnOf(o); }, 0), cbmP = usedOf(c), kgP = sumOf(c, 'kg');
    var cmp = function (plan, conf, fmt, unit) {
      if (conf == null) return '<small>planned · not confirmed</small>';
      var d = Math.round((conf - plan) * 100) / 100, same = Math.abs(d) < (unit === 'm³' ? 0.05 * Math.max(1, plan) : 0.5);
      return '<small>planned ' + fmt(plan) + ' · ' + (same ? '<span class="lp-ok">confirmed ✓</span>' : '<span class="lp-diff">' + (d > 0 ? '+' : '−') + fmt(Math.abs(d)) + ' ' + unit + '</span>') + '</small>';
    };
    var st = function (v, l, sub) { return '<div class="lp-st"><b>' + v + '</b><span>' + l + '</span>' + (sub || '') + '</div>'; };
    var stats = '<div class="lp-stats lp-bkstats">' +
      volTile(c, k.cbm != null ? k.cbm : cbmP, cmp(cbmP, k.cbm, n2, 'm³')) +
      st(int(k.ctns != null ? k.ctns : ctnP) + ' ctns', 'Cartons', cmp(ctnP, k.ctns, int, 'ctns')) +
      st((k.kg != null ? int(Math.round(k.kg)) : kgP ? int(Math.round(kgP)) : '—') + ' kg', 'Gross weight', kgP || k.kg != null ? cmp(kgP, k.kg, function (v) { return int(Math.round(v)); }, 'kg') : '') +
      st(f.cut ? esc(f.cut) : c.loading ? esc(short(c.loading)) : '—', esc(f.cutName || (D.box[c.box].lcl ? 'CFS cut-off' : 'CY cut-off'))) +
      st(f.etdText ? esc(f.etdText) : sail ? esc(short(sail.etd)) : '—', 'ETD' + (f.etaText ? ' · ETA ' + esc(f.etaText) : '')) + '</div>';
    return '<section class="card lp-c lp-booked" data-c="' + c.id + '">' + stepsHTML(c) +
      '<div class="lp-ch"><h2>' + esc(cName(c)) + statusTag(c) + (f.forwarder ? ' <span class="lp-bk">' + esc(f.forwarder) + '</span>' : '') + '</h2>' +
        '<div class="lp-ctl"><button type="button" class="btn ghost small" data-lp-unlock="' + c.id + '" title="The forwarder rebooked or the cargo changed">🔓 Unlock to change</button></div></div>' +
      stats + '<div class="lp-lock">🔒 <span><b>Locked — cargo confirmed with the forwarder' + (k.at ? ' (' + esc(short(String(k.at).slice(0, 10))) + ')' : '') + '.</b> Its POs show <b>Booked</b> on Purchase orders and leave the to-do list. It moves to shipped when the forwarder sends the B/L or departure date, or with Mark shipped.</span></div>' +
      chipsHTML(items) + voyHTML(c) +
      '<div class="lp-foot"><span class="sub"><b>' + groupBy(items).length + ' PO' + (groupBy(items).length > 1 ? 's' : '') + '</b> · ' + int(items.reduce(function (a, o) { return a + o.qty; }, 0)) + ' pcs</span>' +
        '<div class="lp-acts"><button type="button" class="btn ghost small" data-lp-fwd="' + c.id + '">＋ Forwarder update</button><button type="button" class="btn ghost small" data-lp-book="' + c.id + '">Edit booking</button><button type="button" class="btn small" data-lp-ship="' + c.id + '">Mark shipped</button></div></div></section>';
  }
  function statusTag(c) { return c.status === 'booked' ? ' <span class="cp-tag ok">Booked</span>' + (c.fwd && c.fwd.booking ? ' <span class="lp-bk">' + esc(c.fwd.booking) + '</span>' : '') : c.status === 'requested' ? ' <span class="cp-tag wait">Quotes requested</span>' : ''; }
  // LCL: no box to fill — a carton pile per PO, totals and the chargeable freight tons (W/M).
  function lclHTML(c) {
    var items = itemsOf(c), u = usedOf(c), kg = sumOf(c, 'kg'), ctn = sumOf(c, 'cartons'), sail = sById(c.sailing), warns = [];
    var allKg = items.length && items.every(function (o) { return o.kg > 0; }), wm = Math.max(u, kg / 1000);
    var piles = groupBy(items).map(function (ls) {
      var o = ls[0], cbm = ls.reduce(function (a, x) { return a + (x.cbm || 0); }, 0), ctn = ls.reduce(function (a, x) { return a + (x.cartons || 0); }, 0);
      var n = Math.max(1, Math.min(48, Math.round(cbm / 0.25))), anim = ls.some(function (x) { return fresh[x.id]; }), b = '';
      for (var i = 0; i < n; i++) b += '<i class="lp-lc' + (anim ? ' anim' : '') + '" style="animation-delay:' + (anim ? Math.min(i, 30) * 30 : 0) + 'ms"></i>';
      return '<div class="lp-pile" style="--c:' + o.color + '" title="' + esc(o.po + ' · ' + n2(cbm) + ' m³' + (ctn ? ' · ' + int(ctn) + ' cartons' : '') + (ls.length > 1 ? ' · ' + ls.length + ' products' : '')) + '"><div class="lp-pilebox">' + b + '</div><span>' + esc(o.po) + '</span></div>';
    }).join('');
    if (items.length) {
      if (u >= ZONE[1]) warns.push('<div class="lp-warn">' + n2(u) + " m³ is container size — a 20' GP (" + D.box['20GP'].cap + ' m³) is usually cheaper. <button type="button" class="link small" data-lp-switch="' + c.id + '" data-box="20GP">Switch to 20\' GP</button></div>');
      else if (u >= ZONE[0]) warns.push('<div class="lp-warn">Between ' + ZONE[0] + ' and ' + ZONE[1] + " m³ a 20' GP can cost about the same as LCL — ask forwarders for both when you request quotes.</div>");
      else warns.push('<div class="lp-warn soft">Typical LCL size — sharing a container is usually cheapest below about ' + LCLC + ' m³.</div>');
      var noKg = items.filter(function (o) { return !o.kg; }), noCtn = items.filter(function (o) { return !o.cartons; });
      if (noKg.length) warns.push('<div class="lp-warn">' + esc(noKg.map(lineName).join(', ')) + ' — gross weight missing. LCL is charged by volume or weight, whichever is greater, so add it from the packing list.</div>');
      if (noCtn.length) warns.push('<div class="lp-warn soft">' + esc(noCtn.map(lineName).join(', ')) + ' — carton count missing. The CFS warehouse checks cartons on delivery.</div>');
      var est = items.filter(function (o) { return o.est; }); if (est.length) warns.push('<div class="lp-warn soft">' + esc(est.map(lineName).join(', ')) + ' volume is estimated from carton size — confirm with the packing list.</div>');
      if (sail) { var late = items.filter(function (o) { return o.ready && o.ready > sail.etd; }); if (late.length) warns.push('<div class="lp-warn">' + esc(late.map(lineName).join(', ')) + (late.length > 1 ? ' are' : ' is') + " ready after this sailing's ETD.</div>"); }
    }
    var stat = function (v, l, sub) { return '<div class="lp-st"><b>' + v + '</b><span>' + l + '</span>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>'; };
    return '<section class="card lp-c lp-lcl" data-c="' + c.id + '">' + stepsHTML(c) +
      '<div class="lp-ch"><h2>' + esc(cName(c)) + statusTag(c) + '</h2>' + ctlHTML(c) + '</div>' +
      '<div class="lp-stage lp-lclstage" data-lp-drop="' + c.id + '"><div class="lp-lbl3">LCL · shares a container with other shippers · goods go to the forwarder\'s CFS warehouse</div>' +
        (items.length ? '<div class="lp-piles">' + piles + '</div>' : '<div class="lp-dropmsg lp-lcldrop">Drop POs here</div>') + '</div>' +
      '<div class="lp-stats">' + stat(n2(u) + ' m³', 'Volume') + stat(allKg ? int(kg) + ' kg' : kg ? int(kg) + ' kg <i class="sub">+?</i>' : '—', 'Gross weight') + stat(ctn ? int(ctn) + (items.some(function (o) { return !o.cartons; }) ? ' <i class="sub">+?</i>' : '') : '—', 'Cartons') +
        stat(items.length ? n2(allKg ? wm : u) + ' W/M' : '—', 'Freight tons', items.length ? (allKg ? (u >= kg / 1000 ? 'charged by volume' : 'charged by weight') : 'weight missing — by volume so far') : 'the larger of m³ and tonnes') + '</div>' +
      chipsHTML(items) + readyHTML(c, items, sail) + warns.join('') + voyHTML(c) + quotesHTML(c) + footHTML(c, items, sail, items.length > 0, 'Load POs first') + '</section>';
  }
  function stageWidth() { var w = boxesEl.clientWidth || 900; return Math.max(320, Math.min(820, w - 40 - 200)); }
  function containerHTML(c, idx) {
    if (locked(c)) return bookedHTML(c);
    if (D.box[c.box] && D.box[c.box].lcl) return lclHTML(c);
    var t = D.box[c.box], items = itemsOf(c), u = usedOf(c), pct = u / t.cap * 100, over = u > t.cap;
    var W = c.box === '20GP' ? Math.round(stageWidth() * 0.55) : stageWidth();
    var cutW = W - 48, rowH = Math.max(18, Math.min(30, Math.round(cutW / t.cols * 0.5))), cutH = t.rows * rowH, H = cutH + 26;
    var cw = cutW / t.cols, ch = rowH, cell = t.cap / (t.cols * t.rows), slots = [], k = 0;
    items.forEach(function (o) {
      var n = (o.cbm || 0) / cell, whole = Math.floor(n), part = n - whole;
      for (var i = 0; i < whole; i++) slots.push({ o: o, k: k++, part: 1 });
      if (part > 0.15 || (!whole && n > 0)) slots.push({ o: o, k: k++, part: Math.max(part, 0.35) });
    });
    var inside = '', spill = '', cap = t.cols * t.rows;
    if (!over && slots.length > cap) slots = slots.slice(0, cap);   // rounding of part cartons: nothing spills when it fits
    slots.forEach(function (s) {
      var ov = s.k >= cap, oi = s.k - cap;
      var x = ov ? cutW + 44 + (oi % 3) * cw : Math.floor(s.k / t.rows) * cw;
      var y = ov ? cutH - (Math.floor(oi / 3) + 1) * ch : cutH - ((s.k % t.rows) + 1) * ch;
      var h = ch * s.part, anim = fresh[s.o.id];
      var b = '<div class="lp-ctn' + (s.part < 1 ? ' part' : '') + (ov ? ' over' : '') + (anim ? ' anim' : '') + '" title="' + esc(s.o.po + ' · ' + n2(s.o.cbm) + ' m³') + '" style="--c:' + s.o.color + ';--dx:' + Math.round(cutW - x + 40) + 'px;left:' + (x + 1.5) + 'px;top:' + (y + (ch - h) + 1.5) + 'px;width:' + (cw - 3) + 'px;height:' + (h - 3) + 'px;animation-delay:' + (anim ? Math.min(s.k % 60, 40) * 28 : 0) + 'ms"></div>';
      if (ov) spill += b; else inside += b;
    });
    var lvl = pct > 100 ? 'full' : pct > 85 ? 'mid' : '';
    var sail = sById(c.sailing), warns = [];
    if (over) { var big = biggerBox(c, u); warns.push('<div class="lp-warn bad lp-over"><span>Over by <b>' + n2(u - t.cap) + ' m³</b>.</span><span class="lp-over-a">' + (big ? '<button type="button" class="btn ghost small" data-lp-switch="' + c.id + '" data-box="' + big + '">Switch to ' + esc(D.box[big].name) + ' — fits</button>' : '') + '<button type="button" class="btn small" data-lp-split="' + c.id + '">Split to fit…</button></span></div>'); }
    if (sail) { var late = items.filter(function (o) { return o.ready && o.ready > sail.etd; }); if (late.length) warns.push('<div class="lp-warn">' + esc(late.map(lineName).join(', ')) + (late.length > 1 ? ' are' : ' is') + " ready after this sailing's ETD.</div>"); }
    var noCbm = items.filter(function (o) { return o.est; }); if (noCbm.length) warns.push('<div class="lp-warn soft">' + esc(noCbm.map(lineName).join(', ')) + ' volume is estimated from carton size — confirm with the packing list.</div>');
    if (!over && items.length && u <= LCLC) warns.push('<div class="lp-warn soft">Only ' + n2(u) + ' m³ — LCL (sharing a container) is usually cheaper. <button type="button" class="link small" data-lp-switch="' + c.id + '" data-box="LCL">Switch to LCL</button></div>');
    else if (!over && items.length && c.box !== '20GP' && u <= D.box['20GP'].cap) warns.push("<div class=\"lp-warn soft\">Only " + n2(u) + " m³ — a 20' GP may be cheaper.</div>");
    return '<section class="card lp-c" data-c="' + c.id + '">' + stepsHTML(c) +
      '<div class="lp-ch"><h2>' + esc(cName(c)) + statusTag(c) + '</h2>' + ctlHTML(c) + '</div>' +
      '<div class="lp-stage" data-lp-drop="' + c.id + '"><div class="lp-box" style="width:' + W + 'px;height:' + H + 'px">' +
        '<div class="lp-lbl">' + esc(t.name) + ' · ' + t.cap + ' m³ practical load</div><div class="lp-lbl2" style="left:' + (W - 70) + 'px">door →</div>' +
        '<div class="lp-shell"></div><div class="lp-door"></div>' +
        (spill ? '<div class="lp-spill" style="width:' + cutW + 'px;height:' + cutH + 'px">' + spill + '</div><div class="lp-spilllbl" style="left:' + (W + 20) + 'px">doesn\'t fit</div>' : '') +
        '<div class="lp-cut"><div class="lp-grid" style="background-size:' + cw + 'px ' + ch + 'px"></div>' + inside + (items.length ? '' : '<div class="lp-dropmsg">Drop POs here</div>') + '</div>' +
      '</div></div>' +
      '<div class="lp-fill"><div class="lp-track"><i class="' + lvl + '" style="width:' + Math.min(pct, 100) + '%"></i></div><div class="lp-fnum">' + n2(u) + ' / ' + t.cap + ' m³<small>' + Math.round(pct) + '% full · ' + n2(Math.max(0, t.cap - u)) + ' m³ left</small></div></div>' +
      chipsHTML(items) + readyHTML(c, items, sail) + warns.join('') + voyHTML(c) + quotesHTML(c) + footHTML(c, items, sail, items.length && !over, over ? 'Container is over capacity' : 'Load POs first') +
      '</section>';
  }
  function render() {
    renderPool();
    var open = D.containers.filter(function (c) { return !locked(c); }), bk = D.containers.filter(locked);
    boxesEl.innerHTML = D.containers.length ? open.map(containerHTML).join('') + (bk.length ? '<h3 class="lp-grp">Booked — waiting to sail <span>' + bk.length + '</span></h3>' + bk.map(containerHTML).join('') : '') : '<div class="card lp-none"><p>No containers yet at this port.</p></div>';
    var tip = root.querySelector('[data-lp-tip]'), waiting = D.orders.filter(function (o) { return !o.container; }).reduce(function (a, o) { return a + (o.cbm || 0); }, 0);
    var hasLcl = D.containers.some(function (c) { return D.box[c.box] && D.box[c.box].lcl; });
    if (tip) { tip.hidden = !(waiting > 0 && waiting <= LCLC && !hasLcl); tip.innerHTML = tip.hidden ? '' : '<span>Only <b>' + n2(waiting) + ' m³</b> waiting at ' + esc(D.portName || D.port) + ' — not enough for a container. Plan it as LCL?</span><button type="button" class="btn small" data-lp-addlcl>Add LCL shipment</button>'; }
    fresh = {};
  }

  function lockedMsg() { toast('Booked and locked — unlock it to change'); }
  function load(id, cid) {
    var o = byId(id), c = cById(cid); if (!o || !c || o.container === cid) return;
    if (locked(c) || locked(cById(o.container))) { lockedMsg(); return; }
    if (!o.cbm) { toast('Add the volume first'); return; }
    o.container = cid; fresh[id] = 1; render();
    var t = D.box[c.box]; if (!t.lcl && usedOf(c) > t.cap) toast(o.po + " doesn't fit — " + n2(usedOf(c) - t.cap) + ' m³ over');
    post(D.base + '/assign', { order: id, container: cid }).then(function (j) { if (applyMerge(j)) render(); }).catch(fail);
  }
  function unload(id) { var o = byId(id); if (!o || !o.container) return; if (locked(cById(o.container))) { lockedMsg(); return; } o.container = null; render(); post(D.base + '/assign', { order: id, container: '' }).then(function (j) { if (applyMerge(j)) render(); }).catch(fail); }
  function applyMerge(j) {
    if (!j || !j.removed || !j.removed.length) return false;
    D.orders = D.orders.filter(function (o) { return j.removed.indexOf(o.id) < 0; });
    (j.kept || []).forEach(function (k) { var o = byId(k.id); if (o) { o.qty = k.qty; o.cartons = k.cartons; o.cbm = k.cbm; o.kg = k.kg; o.est = k.est; o.part = k.part; o.container = k.container; } });
    D.orders.forEach(function (o) { if (o.part && !siblings(o).length) o.part = 0; });
    return true;
  }
  function assignAll(ls, cid) { return ls.reduce(function (p, o) { return p.then(function () { return post(D.base + '/assign', { order: o.id, container: cid || '' }).then(function (j) { if (applyMerge(j)) render(); }); }); }, Promise.resolve()); }
  function loadPo(pk, cid) {
    var c = cById(cid); if (!c) return; if (locked(c)) { lockedMsg(); return; }
    var ls = linesOfPo(pk).filter(function (o) { return !o.container && o.cbm; });
    if (!ls.length) { toast('Add the volume first'); return; }
    var left = linesOfPo(pk).filter(function (o) { return !o.container && !o.cbm; }).length;
    ls.forEach(function (o) { o.container = cid; fresh[o.id] = 1; }); render();
    var t = D.box[c.box];
    if (!t.lcl && usedOf(c) > t.cap) toast(ls[0].po + " doesn't fit — " + n2(usedOf(c) - t.cap) + ' m³ over');
    else if (left) toast(left + ' product' + (left > 1 ? 's' : '') + ' without volume stayed in Not loaded yet');
    assignAll(ls, cid).catch(fail);
  }
  function unloadPo(pk, from) {
    if (locked(cById(from))) { lockedMsg(); return; }
    var ls = linesOfPo(pk).filter(function (o) { return o.container && (!from || o.container === from); }); if (!ls.length) return;
    ls.forEach(function (o) { o.container = null; }); render(); assignAll(ls, '').catch(fail);
  }
  function movePo(pk, from, cid) {
    if (locked(cById(from)) || locked(cById(cid))) { lockedMsg(); return; }
    var ls = linesOfPo(pk).filter(function (o) { return o.container === from; }); if (!ls.length || from === cid) return;
    ls.forEach(function (o) { o.container = cid; fresh[o.id] = 1; }); render(); assignAll(ls, cid).catch(fail);
  }

  root.addEventListener('dragstart', function (e) {
    var el = e.target.closest && e.target.closest('[draggable="true"][data-id],[draggable="true"][data-po]'); if (!el) return;
    e.stopPropagation();
    e.dataTransfer.setData('text/plain', el.hasAttribute('data-id') ? el.getAttribute('data-id') : 'po:' + el.getAttribute('data-po') + '|' + (el.getAttribute('data-from') || ''));
    e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging');
  });
  root.addEventListener('dragend', function (e) { var el = e.target.closest && e.target.closest('[data-id],[data-po]'); if (el) el.classList.remove('dragging'); });
  root.addEventListener('dragover', function (e) { var z = e.target.closest('[data-lp-drop],[data-lp-pool]'); if (!z) return; e.preventDefault(); z.classList.add('over'); });
  root.addEventListener('dragleave', function (e) { var z = e.target.closest('[data-lp-drop],[data-lp-pool]'); if (z && !z.contains(e.relatedTarget)) z.classList.remove('over'); });
  root.addEventListener('drop', function (e) {
    var z = e.target.closest('[data-lp-drop],[data-lp-pool]'); if (!z) return; e.preventDefault(); z.classList.remove('over');
    var id = e.dataTransfer.getData('text/plain'); if (!id) return;
    var to = z.hasAttribute('data-lp-drop') ? z.getAttribute('data-lp-drop') : null;
    if (id.indexOf('po:') === 0) {
      var rest = id.slice(3), cut = rest.lastIndexOf('|'), pk = rest.slice(0, cut), from = rest.slice(cut + 1);
      if (to) { if (from) movePo(pk, from, to); else loadPo(pk, to); } else if (from) unloadPo(pk, from);
      return;
    }
    if (to) load(id, to); else unload(id);
  });
  root.addEventListener('change', function (e) {
    var el = e.target, id;
    if ((id = el.getAttribute('data-lp-quick'))) { if (el.value) load(id, el.value); return; }
    if ((id = el.getAttribute('data-lp-quickpo'))) { if (el.value) loadPo(id, el.value); return; }
    if ((id = el.getAttribute('data-lp-box'))) { var c = cById(id); c.box = el.value; itemsOf(c).forEach(function (o) { fresh[o.id] = 1; }); render(); post(D.base + '/containers/' + id, { box: el.value }).catch(fail); return; }
    if ((id = el.getAttribute('data-lp-ld'))) { cById(id).loading = el.value; render(); toast(el.value ? 'Loading date saved' : 'Loading date cleared'); post(D.base + '/containers/' + id, { loading_date: el.value }).catch(fail); return; }
    if ((id = el.getAttribute('data-lp-sail'))) { cById(id).sailing = el.value; render(); post(D.base + '/containers/' + id, { sailing: el.value }).catch(fail); return; }
    if ((id = el.getAttribute('data-lp-status'))) { cById(id).status = el.value; render(); post(D.base + '/containers/' + id, { status: el.value }).catch(fail); }
  });
  root.addEventListener('keydown', function (e) { var id = e.target.getAttribute && e.target.getAttribute('data-lp-v'); if (id && e.key === 'Enter') { e.preventDefault(); var b = root.querySelector('[data-lp-savecbm="' + id + '"]'); if (b) b.click(); } });
  root.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return; var id;
    if ((id = b.getAttribute('data-lp-out'))) { unload(id); return; }
    if ((id = b.getAttribute('data-lp-outpo'))) { unloadPo(id, b.getAttribute('data-from')); return; }
    if ((id = b.getAttribute('data-lp-open'))) { opened[id] = !opened[id]; renderPool(); return; }
    if (b.hasAttribute('data-lp-loadmenu')) { if (!menu.hidden) { menu.hidden = true; return; } openMenu(b); return; }
    if ((id = b.getAttribute('data-lp-split'))) { openSplit({ container: id }); return; }
    if ((id = b.getAttribute('data-lp-splitone'))) { openSplit({ line: id }); return; }
    if ((id = b.getAttribute('data-lp-merge'))) {
      b.disabled = true;
      post(D.base + '/merge', { order: id }).then(function (j) { applyMerge(j); render(); toast('Merged back into one line'); }).catch(fail);
      return;
    }
    if ((id = b.getAttribute('data-lp-switch'))) { var cs = cById(id), nb = b.getAttribute('data-box'); cs.box = nb; itemsOf(cs).forEach(function (o) { fresh[o.id] = 1; }); render(); toast(cName(cs) + ' — now ' + (D.box[nb].lcl ? 'LCL' : D.box[nb].name)); post(D.base + '/containers/' + id, { box: nb }).catch(fail); return; }
    if ((id = b.getAttribute('data-lp-savecbm'))) {
      var inp = root.querySelector('[data-lp-v="' + id + '"]'), v = parseFloat(String(inp.value).replace(',', '.'));
      if (!(v > 0)) { toast('Enter the volume in m³'); inp.focus(); return; }
      b.disabled = true;
      post(D.base + '/' + id + '/cbm', { cbm: v }).then(function (j) { var o = byId(id); o.cbm = j.cbm; o.est = false; render(); toast('Volume saved — you can load it now'); }).catch(function (x) { b.disabled = false; toast(x.message); });
      return;
    }
    if ((id = b.getAttribute('data-lp-unlock'))) {
      var cu = cById(id);
      window.ask('Unlock ' + cName(cu) + '?', { detail: 'It goes back to planning so you can change what is in it. Its POs leave "Booked". The confirmed booking stays saved — confirm again when the forwarder rebooks.', ok: 'Unlock' }).then(function (y) {
        if (!y) return; post(D.base + '/containers/' + id + '/unlock').then(function (j) { cu.status = j.status || 'planned'; render(); toast(cName(cu) + ' unlocked'); }).catch(fail);
      });
      return;
    }
    if ((id = b.getAttribute('data-lp-book'))) { openBook(cById(id)); return; }
    if ((id = b.getAttribute('data-lp-del'))) {
      var c = cById(id);
      var rmC = function () { itemsOf(c).forEach(function (o) { o.container = null; }); D.containers = D.containers.filter(function (x) { return x.id !== id; }); render(); post(D.base + '/containers/' + id + '/delete').then(function (j) { if (j.merged) location.reload(); }).catch(fail); };
      if (!itemsOf(c).length) rmC(); else window.ask('Remove ' + cName(c) + '?', { detail: 'Its POs go back to "Not loaded yet".', ok: 'Remove', danger: true }).then(function (y) { if (y) rmC(); });
      return;
    }
    if ((id = b.getAttribute('data-lp-ship'))) {
      var c2 = cById(id), n = itemsOf(c2).length, cap = D.box[c2.box] && D.box[c2.box].cap, used = usedOf(c2), shipBtn = b;
      var over = !D.box[c2.box].lcl && cap && used > cap;
      window.ask('Mark ' + cName(c2) + ' shipped? All ' + n + ' line' + (n > 1 ? 's' : '') + ' close and move to Shipments.', { ok: 'Mark shipped',
        detail: over ? 'The plan is ' + n2(used - cap) + ' m³ over the ' + n2(cap) + ' m³ practical load. That\'s fine if the forwarder confirmed everything was loaded — the real volume comes from the suppliers\' packing lists.' : '' }).then(function (y) {
        if (!y) return; shipBtn.disabled = true;
        post(D.base + '/containers/' + id + '/shipped').then(function () { D.orders = D.orders.filter(function (o) { return o.container !== id; }); D.containers = D.containers.filter(function (x) { return x.id !== id; }); render(); toast(cName(c2) + ' shipped — ' + n + ' line' + (n > 1 ? 's' : '') + ' moved to Shipments'); }).catch(fail);
      });
    }
  });
  // Confirm booking: booking no., forwarder, cut-off, ETD and the confirmed cartons / m³ / kg per PO (planned values prefilled).
  var bd = document.createElement('dialog'); bd.className = 'rp-modal lp-bkdlg'; bd.setAttribute('aria-labelledby', 'lp-bk-t'); document.body.appendChild(bd);
  // Forwarder: custom dropdown from the Forwarders list (+ earlier bookings); "Other…" opens a text box
  function fwPick(cur) {
    var list = (D.forwarders || []).slice(); if (cur && list.indexOf(cur) < 0) list.unshift(cur);
    var v = cur || '', lab = cur || 'Choose forwarder…';
    return '<details class="dd dd-sel" data-dd data-ddsel data-lp-fwpick><summary class="dd-field"><span data-ddsel-label>' + esc(lab) + '</span><span class="dd-car" aria-hidden="true">▾</span></summary><div class="dd-menu">' +
      list.map(function (n) { return '<button type="button" data-v="' + esc(n) + '" class="' + (n === cur ? 'on' : '') + '">' + esc(n) + '</button>'; }).join('') +
      '<button type="button" data-v="_other" class="dd-other">Other…</button></div><input type="hidden" name="forwarder" value="' + esc(v) + '"></details>' +
      '<input name="forwarder_other" class="lp-fwother" placeholder="Forwarder name" hidden aria-label="Other forwarder">' +
      (list.length ? '' : '<span class="sub">No forwarders yet — <a class="link small" href="/admin/logistics/forwarders" target="_blank" rel="noopener">add them</a> or choose Other.</span>');
  }
  bdFw();
  function bdFw() {
    document.addEventListener('change', function (e) {
      var inp = e.target; if (!inp.closest || !inp.closest('[data-lp-fwpick]') || inp.name !== 'forwarder') return;
      var other = inp.closest('.lp-bkfw').querySelector('.lp-fwother'); other.hidden = inp.value !== '_other'; if (!other.hidden) other.focus();
    });
  }
  // POs in this container without a passed inspection: warn (booking still allowed)
  function inspWarn(gs) {
    var bad = gs.map(function (ls) { return ls[0]; }).filter(function (o) { var g = (D.insp || {})[o.pk]; return g && !g.ok; });
    if (!bad.length) return '';
    return '<div class="lp-inspw" role="alert">⚠ <span><b>Inspection not passed:</b> ' + bad.map(function (o) { var g = D.insp[o.pk]; return esc(o.po) + ' (' + esc(g.text) + ')'; }).join(', ') + '. You can still confirm the booking — ship only after a Pass, or decide to ship anyway.</span></div>';
  }
  function openBook(c) {
    if (!c) return; var f = c.fwd || {}, k = f.confirmed || {}, gs = groupBy(itemsOf(c)), lcl = D.box[c.box] && D.box[c.box].lcl;
    var prev = function (po, key) { var x = (k.lines || []).filter(function (l) { return l.po === po; })[0]; return x && x[key] != null ? x[key] : null; };
    var rows = gs.map(function (ls, i) {
      var o = ls[0], ctn = ls.reduce(function (a, x) { return a + ctnOf(x); }, 0), cbm = ls.reduce(function (a, x) { return a + (x.cbm || 0); }, 0), kg = ls.reduce(function (a, x) { return a + (x.kg || 0); }, 0);
      var v = function (key, plan, dp) { var p = prev(o.po, key); return p != null ? p : plan ? (dp ? Math.round(plan * 100) / 100 : Math.round(plan)) : ''; };
      return '<tr><td><i class="lp-dot" style="background:' + o.color + '"></i><b>' + esc(o.po) + '</b> <span class="sub">' + esc(o.supplier) + '</span></td><td class="r sub">' + (ctn ? int(ctn) : '—') + '</td>' +
        '<td class="r"><input name="ctns_' + i + '" inputmode="numeric" value="' + v('ctns', ctn) + '" aria-label="Confirmed cartons ' + esc(o.po) + '"></td><td class="r"><input name="cbm_' + i + '" inputmode="decimal" value="' + v('cbm', cbm, 1) + '" aria-label="Confirmed m³ ' + esc(o.po) + '"></td><td class="r"><input name="kg_' + i + '" inputmode="decimal" value="' + v('kg', kg) + '" aria-label="Confirmed kg ' + esc(o.po) + '"></td></tr>';
    }).join('');
    bd.innerHTML = '<form data-lp-bk-form><div class="rp-top"><h2 id="lp-bk-t">Confirm booking · ' + esc(cName(c)) + '</h2><button type="button" class="icon-btn" data-lp-bk-close aria-label="Close">×</button></div>' +
      '<p class="sub rp-ctx">What the forwarder confirmed. Saving locks this container: its POs move to <b>Booked</b> and nothing can be dragged in or out until you unlock it.</p>' +
      '<div class="lp-bkf"><label>Booking no. <input name="booking" value="' + esc(f.booking || '') + '" autocomplete="off"></label><div class="lp-bkfw"><span class="lp-bkl">Forwarder</span>' + fwPick(f.forwarder || '') + '</div>' +
      '<label>' + (lcl ? 'CFS cut-off' : 'CY cut-off') + ' <input type="date" name="cutoff" value="' + esc(f.cutDay || c.loading || '') + '"></label><label>ETD <input type="date" name="etd" value="' + esc(f.etdDay || (sById(c.sailing) ? sById(c.sailing).etd : '')) + '"></label></div>' +
      inspWarn(gs) +
      '<div class="table-wrap"><table class="list compact lp-bkt"><thead><tr><th>PO</th><th class="r">Planned ctns</th><th class="r">Confirmed ctns</th><th class="r">m³</th><th class="r">kg</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="rp-actions"><button class="btn">Confirm &amp; lock</button><button type="button" class="btn ghost" data-lp-bk-close>Cancel</button><span class="sub">Forwarder emails and PDFs: use ＋ Forwarder update — AI reads them.</span></div></form>';
    bd.setAttribute('data-c', c.id); bd.showModal();
  }
  bd.addEventListener('click', function (e) { if (e.target.closest('[data-lp-bk-close]') || e.target === bd) bd.close(); });
  bd.addEventListener('submit', function (e) {
    e.preventDefault(); var form = e.target, cid = form.getAttribute('data-c') || bd.getAttribute('data-c');
    var c = D.containers.filter(function (x) { return x.id === cid; })[0]; if (!c) return;
    var data = {}; Array.prototype.forEach.call(form.elements, function (el) { if (el.name) data[el.name] = el.value; });
    var btn = form.querySelector('.btn'); btn.disabled = true;
    post(D.base + '/containers/' + cid + '/book', data).then(function (j) { c.status = 'booked'; c.fwd = j.fwd; if (j.loading) c.loading = j.loading; bd.close(); render(); toast(cName(c) + ' booked and locked'); }).catch(function (x) { btn.disabled = false; toast(x.message); });
  });
  // Split by quantity: "Split to fit…" on an over-full container (with suggestions), or "Split…" on one line.
  // Tick any number of lines; each starts at its full quantity and you reduce what stays. One button applies them all.
  var sd = document.createElement('dialog'); sd.className = 'rp-modal lp-sdlg'; sd.setAttribute('aria-labelledby', 'lp-sd-t'); document.body.appendChild(sd);
  var S = null; // { container, line, plan: { id: keep }, mem: { id: keep }, opt, opts }
  function unitOf(o) { var byC = (o.cartons || 0) > 1; var whole = byC ? o.cartons : o.qty; return { byC: byC, whole: whole, per: o.cbm / whole, u: byC ? 'ctns' : 'pcs' }; }
  function lateKey(o) { return o.ready || '9999-12-31'; }
  function moveCbm(o, keep) { var q = unitOf(o); return o.cbm * (q.whole - keep) / q.whole; }
  function planned() { return Object.keys(S.plan).filter(function (id) { var o = byId(id); return o && S.plan[id] < unitOf(o).whole; }); }
  function afterPlan(c, skip) { var u = usedOf(c); Object.keys(S.plan).forEach(function (id) { var o = byId(id); if (o && id !== skip && o.container === c.id) u -= moveCbm(o, S.plan[id]); }); return u; }
  function suggestions(c) {
    var t = D.box[c.box], items = itemsOf(c).filter(function (o) { return o.cbm; }), u = usedOf(c), ex = u - t.cap, out = [];
    if (ex <= 0) return out;
    var splits = [], wholes = [];
    items.forEach(function (o) {
      if (o.urgent) return;
      if (canSplit(o) && o.cbm > ex) {
        var q = unitOf(o), move = Math.ceil(ex / q.per - 1e-9), keep = q.whole - move, kc = o.cbm * keep / q.whole;
        if (keep >= 1 && !(kc < 1 && keep / q.whole < 0.1)) splits.push({ kind: 'split', parts: [{ o: o, keep: keep, move: move }], o: o, after: u - o.cbm + kc });
      }
      if (o.cbm >= ex) wholes.push({ kind: 'move', ids: [o.id], o: o, after: u - o.cbm });
    });
    splits.sort(function (a, b) { return lateKey(b.o) < lateKey(a.o) ? -1 : lateKey(b.o) > lateKey(a.o) ? 1 : b.after - a.after; });
    wholes.sort(function (a, b) { return lateKey(b.o) < lateKey(a.o) ? -1 : lateKey(b.o) > lateKey(a.o) ? 1 : a.o.cbm - b.o.cbm; });
    if (splits[0]) out.push(splits[0]);
    else {
      // no single line covers it: take from several lines, latest-ready first
      var left = ex, parts = [], pool = items.filter(function (o) { return !o.urgent && canSplit(o); }).sort(function (a, b) { return lateKey(b) < lateKey(a) ? -1 : lateKey(b) > lateKey(a) ? 1 : b.cbm - a.cbm; });
      for (var i = 0; i < pool.length && left > 1e-9; i++) {
        var o = pool[i], q = unitOf(o), mv = Math.min(q.whole - 1, Math.ceil(left / q.per - 1e-9));
        if (mv < 1) continue; parts.push({ o: o, keep: q.whole - mv, move: mv }); left -= mv * q.per;
      }
      if (parts.length > 1 && left <= 1e-9) out.push({ kind: 'split', parts: parts, after: u - parts.reduce(function (a, x) { return a + x.move * unitOf(x.o).per; }, 0) });
    }
    if (wholes[0]) out.push(wholes[0]);
    // the PO that is ready last: moving it out makes the cargo ready sooner
    var gs = groupBy(items), last = items.map(function (o) { return o.ready; }).filter(Boolean).sort().pop();
    if (last && gs.length > 1) {
      gs.forEach(function (ls) {
        if (readyOf(ls) !== last || ls.some(function (x) { return x.urgent; })) return;
        var rest = items.filter(function (x) { return ls.indexOf(x) < 0; }), after = u - ls.reduce(function (a, x) { return a + x.cbm; }, 0), nr = readyOf(rest);
        if (after <= t.cap && rest.length && (!nr || nr < last) && !(ls.length === 1 && wholes[0] && wholes[0].o === ls[0])) out.push({ kind: 'move', ids: ls.map(function (x) { return x.id; }), po: ls[0], after: after, earlier: nr });
      });
    }
    return out.slice(0, 3);
  }
  function optHTML(x, i, c) {
    var t = D.box[c.box], pct = x.after / t.cap * 100;
    var nm = function (o) { return esc(o.sku || o.product || o.po); };
    var what, why, tag;
    if (x.kind === 'split') {
      what = x.parts.length === 1 ? '<b>Split ' + esc(x.o.product || x.o.po) + ' (' + esc(x.o.po) + ')</b> — keep ' + int(x.parts[0].keep) + ' ' + unitOf(x.o).u + ', move ' + int(x.parts[0].move) + ' ' + unitOf(x.o).u + ' to the next shipment'
        : '<b>Split ' + x.parts.length + ' lines</b> — ' + x.parts.map(function (p) { return nm(p.o) + ' move ' + int(p.move) + ' ' + unitOf(p.o).u; }).join(' · ');
      why = x.parts.length === 1 ? (x.o.ready ? 'Ready ' + esc(short(x.o.ready)) : 'No ready date') + (x.o.ready && x.o.ready === readyOf(itemsOf(c)) ? ' — ready last' : '') + ' · not marked urgent · whole ' + (unitOf(x.o).byC ? 'cartons' : 'pieces') : 'No single line covers it — latest-ready lines first, not marked urgent';
      tag = '<span class="cp-tag ok">Best fill</span>';
    } else {
      what = x.po ? '<b>Move all of ' + esc(x.po.po) + ' out</b> — no split' : '<b>Move ' + esc(x.o.product || x.o.po) + (x.o.product ? ' (' + esc(x.o.po) + ')' : '') + ' out whole</b> — no split';
      why = x.po ? 'Cargo ready <b>' + esc(x.earlier ? short(x.earlier) : '—') + '</b> instead of ' + esc(short(readyOf(itemsOf(c)))) : (x.o.ready ? 'Ready ' + esc(short(x.o.ready)) : 'No ready date') + (x.o.ready && x.o.ready === readyOf(itemsOf(c)) ? ' — ready last' : '') + ' · not marked urgent';
      tag = x.po ? '<span class="cp-tag plan">Earliest</span>' : '<span></span>';
    }
    return '<label class="lp-sd-opt"><input type="radio" name="lp-sd-opt" value="' + i + '"' + (S.opt === i ? ' checked' : '') + '><span>' + what + '<span class="sub">' + why + '</span></span><b class="lp-sd-pct">' + Math.round(pct * 10) / 10 + '% full</b>' + tag + '</label>';
  }
  function qtyOf(o, k) { var q = unitOf(o); if (!q.byC) return k; if (k >= q.whole) return o.qty; return o.upc && o.upc * o.cartons === o.qty ? k * o.upc : Math.max(1, Math.min(o.qty - 1, Math.round(o.qty * k / q.whole))); }
  function sdRender() {
    var c = S.container ? cById(S.container) : null, t = c ? D.box[c.box] : null, u = c ? usedOf(c) : 0;
    var lines = c ? itemsOf(c).filter(function (o) { return o.cbm; }) : [byId(S.line)].filter(Boolean);
    var opts = S.opts = c ? suggestions(c) : [];
    var opt = S.opt != null ? opts[S.opt] : null;
    var after = c ? (opt && opt.kind === 'move' ? opt.after : afterPlan(c)) : 0;
    var n = planned().length;
    var head = c ? 'Fit ' + esc(cName(c)) + ' · ' + esc(t.name) : 'Split ' + esc((lines[0] && (lines[0].product || lines[0].po)) || '');
    var row = function (o) {
      var q = unitOf(o), on = S.plan[o.id] != null && !(opt && opt.kind === 'move'), ok = canSplit(o);
      var r = '<div class="lp-sd-it' + (on ? ' on' : '') + (ok ? '' : ' no') + '" data-sd-pick="' + (ok ? o.id : '') + '"><input type="checkbox"' + (on ? ' checked' : '') + (ok ? '' : ' disabled') + ' aria-label="Split ' + esc(o.product || o.po) + '"><span class="lp-sd-sku' + (o.sku ? '' : ' none') + '">' + (o.sku ? esc(o.sku) : '—') + '</span><span class="lp-sd-n">' + esc(o.product || o.po) + (o.part ? ' <em class="lp-chip-pt">part ' + o.part + '</em>' : '') + '</span>' +
        '<span class="r">' + (o.qty ? int(o.qty) + ' pcs' : '') + '</span><span class="r">' + (o.cartons ? int(o.cartons) + ' ctns' : '—') + '</span><span class="r">' + n2(o.cbm) + ' m³</span><span class="r' + (c && o.ready && o.ready === readyOf(lines) ? ' late' : '') + '">' + (o.ready ? esc(short(o.ready)) : '—') + '</span>' +
        '<button type="button" class="lp-star' + (o.urgent ? ' on' : '') + '" data-sd-star="' + o.id + '" title="' + (o.urgent ? 'Urgent — kept whole' : 'Mark urgent — keep whole') + '" aria-pressed="' + (o.urgent ? 'true' : 'false') + '" aria-label="Urgent">★</button></div>';
      if (on) {
        var k = S.plan[o.id], m = q.whole - k, f = function (x) { return x / q.whole; }, qa = qtyOf(o, k);
        var over = c ? afterPlan(c, o.id) - t.cap : 0;
        r += '<div class="lp-sd-x' + (m ? '' : ' full') + '"><div class="lp-sd-row"><span>' + (c ? 'Keep in this container' : 'Part 1') + '</span><span class="lp-step"><button type="button" data-sd-d="-1" data-id="' + o.id + '" aria-label="One less"' + (k <= 1 ? ' disabled' : '') + '>−</button><input type="number" min="1" max="' + q.whole + '" value="' + k + '" data-sd-keep="' + o.id + '" aria-label="Keep"><button type="button" data-sd-d="1" data-id="' + o.id + '" aria-label="One more"' + (k >= q.whole ? ' disabled' : '') + '>+</button></span><span class="sub">of ' + int(q.whole) + ' ' + q.u + (q.byC && o.upc ? ' · ' + int(o.upc) + ' pcs/ctn' : '') + ' · ' + (Math.round(q.per * 1000) / 1000) + ' m³/' + (q.byC ? 'ctn' : 'pc') + '</span>' + (c && over > 0 ? '<button type="button" class="link small" data-sd-fit="' + o.id + '">Fit exactly</button>' : '') + '</div>' +
          (m ? '<div class="lp-sd-two"><div class="a"><span>' + (c ? 'Stays in ' + esc(cName(c)) : 'Part 1') + '</span><b>' + int(k) + ' ' + q.u + (q.byC && o.qty ? ' · ' + int(qa) + ' pcs' : '') + '</b><span>' + n2(o.cbm * f(k)) + ' m³' + (o.kg ? ' · ' + int(Math.round(o.kg * f(k))) + ' kg' : '') + '</span></div>' +
            '<div class="b"><span>' + (o.container ? 'Back to “Not loaded yet” as a new part' : 'Part 2 — a new line in “Not loaded yet”') + '</span><b>' + int(m) + ' ' + q.u + (q.byC && o.qty ? ' · ' + int(o.qty - qa) + ' pcs' : '') + '</b><span>' + n2(o.cbm - o.cbm * f(k)) + ' m³' + (o.kg ? ' · ' + int(Math.round(o.kg - o.kg * f(k))) + ' kg' : '') + '</span></div></div>'
            : '<p class="sub lp-sd-hint">Full quantity — reduce what stays to split this line.</p>') +
          (q.byC ? '' : '<p class="sub">No carton count on this line — split by pieces; volume is estimated.</p>') + '</div>';
      }
      return r;
    };
    var pct = c ? after / t.cap * 100 : 0;
    var plan = planned().map(byId);
    var label = opt && opt.kind === 'move' ? 'Move out' : !n ? (c ? 'Split &amp; load' : 'Split') : n === 1 ? (c ? 'Split &amp; load' : 'Split') : 'Split ' + n + ' lines';
    sd.innerHTML = '<form method="dialog" class="lp-sd"><div class="rp-top"><h2 id="lp-sd-t">' + head + '</h2>' + (c && u > t.cap ? '<span class="cp-tag wait">Over by ' + n2(u - t.cap) + ' m³</span>' : '') + '<button type="button" class="icon-btn" data-sd-close aria-label="Close">×</button></div>' +
      (c ? (opts.length ? '<div class="lp-sd-sug"><div class="lp-sd-sh">✦ Suggested</div>' + opts.map(function (x, i) { return optHTML(x, i, c); }).join('') + '</div>' : '') : '') +
      (c ? '<p class="sub lp-sd-how">Tick the lines to split — each starts at its full quantity; reduce what stays.</p>' : '') +
      groupBy(lines).map(function (ls) { var o = ls[0]; return '<div class="lp-sd-po"><div class="lp-sd-ph"><i style="background:' + o.color + '"></i><b>' + esc(o.po) + '</b><span>' + esc(o.supplier) + '</span><span class="sub">' + (readyOf(ls) ? 'ready ' + esc(short(readyOf(ls))) + ' · ' : '') + n2(ls.reduce(function (a, x) { return a + x.cbm; }, 0)) + ' m³</span></div>' + ls.map(row).join('') + '</div>'; }).join('') +
      (plan.length > 1 ? '<div class="lp-sd-plan"><b>' + plan.length + ' lines to split:</b> ' + plan.map(function (o) { var q = unitOf(o); return esc(o.sku || o.product || o.po) + ' keep ' + int(S.plan[o.id]) + ' of ' + int(q.whole) + ' ' + q.u; }).join(' · ') + '</div>' : '') +
      '<div class="lp-sd-foot">' + (c ? '<div class="lp-track"><i class="' + (pct > 100 ? 'full' : pct > 85 ? 'mid' : '') + '" style="width:' + Math.min(100, pct) + '%"></i></div><b>' + n2(after) + ' / ' + t.cap + ' m³ · ' + Math.round(pct * 10) / 10 + '%</b>' : '<span></span>') +
        '<span class="lp-sd-acts"><button type="button" class="btn ghost" data-sd-close>Cancel</button><button type="button" class="btn" data-sd-go' + ((opt && opt.kind === 'move') || n ? '' : ' disabled') + '>' + label + '</button></span></div>' +
      '<p class="sub lp-sd-note">★ urgent: kept whole and never suggested for splitting.</p></form>';
  }
  function openSplit(o) {
    var line = o.line ? byId(o.line) : null;
    S = { container: o.container || null, line: o.line || null, plan: {}, mem: {}, opt: null };
    if (line) { S.plan[line.id] = unitOf(line).whole; if (line.container && D.box[cById(line.container).box] && !D.box[cById(line.container).box].lcl) S.container = line.container; }
    sdRender(); if (sd.showModal) sd.showModal(); else sd.setAttribute('open', '');
  }
  function setKeep(id, v) { var o = byId(id), q = unitOf(o); S.plan[id] = Math.max(1, Math.min(q.whole, Math.round(v))); S.opt = matchOpt(); }
  function fitKeep(id) { var o = byId(id), c = cById(S.container), q = unitOf(o), over = afterPlan(c, id) - D.box[c.box].cap; return over <= 0 ? q.whole : Math.max(1, q.whole - Math.ceil(over / q.per - 1e-9)); }
  function matchOpt() {
    var ids = planned();
    for (var i = 0; i < (S.opts || []).length; i++) {
      var x = S.opts[i]; if (x.kind !== 'split' || x.parts.length !== ids.length) continue;
      if (x.parts.every(function (p) { return S.plan[p.o.id] === p.keep; })) return i;
    }
    return null;
  }
  sd.addEventListener('click', function (e) {
    if (e.target === sd || e.target.closest('[data-sd-close]')) { sd.close(); return; }
    var b, id;
    if ((b = e.target.closest('[data-sd-star]'))) {
      e.preventDefault(); var o = byId(b.getAttribute('data-sd-star')); o.urgent = !o.urgent; S.opt = matchOpt(); sdRender(); render();
      post(D.base + '/urgent', { order: o.id, urgent: o.urgent ? '1' : '' }).catch(fail); return;
    }
    if ((b = e.target.closest('[data-sd-d]'))) { id = b.getAttribute('data-id'); setKeep(id, S.plan[id] + Number(b.getAttribute('data-sd-d'))); sdRender(); return; }
    if ((b = e.target.closest('[data-sd-fit]'))) { id = b.getAttribute('data-sd-fit'); setKeep(id, fitKeep(id)); sdRender(); return; }
    if ((b = e.target.closest('[data-sd-pick]')) && (id = b.getAttribute('data-sd-pick')) && !e.target.closest('.lp-sd-x')) {
      e.preventDefault();
      if (S.opt != null && S.opts[S.opt] && S.opts[S.opt].kind === 'move') S.opt = null;
      if (S.plan[id] != null) { S.mem[id] = S.plan[id]; delete S.plan[id]; } else S.plan[id] = S.mem[id] != null ? S.mem[id] : unitOf(byId(id)).whole;
      S.opt = matchOpt(); sdRender(); return;
    }
    if (e.target.closest('[data-sd-go]')) go();
  });
  sd.addEventListener('change', function (e) {
    if (e.target.name === 'lp-sd-opt') {
      var x = S.opts[Number(e.target.value)]; S.opt = Number(e.target.value);
      if (x.kind === 'split') { S.plan = {}; x.parts.forEach(function (p) { S.plan[p.o.id] = p.keep; }); }
      sdRender(); return;
    }
    var id = e.target.getAttribute && e.target.getAttribute('data-sd-keep');
    if (id) { var v = Math.round(Number(e.target.value) || 1); if (v === S.plan[id] && !S.typing) return; S.typing = false; setKeep(id, v); sdRender(); }
  });
  sd.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.hasAttribute && e.target.hasAttribute('data-sd-keep')) { e.preventDefault(); e.target.blur(); } });
  // never more than the line has: clamp as you type, update live keeping the cursor in the box
  sd.addEventListener('input', function (e) {
    var id = e.target.getAttribute && e.target.getAttribute('data-sd-keep'); if (!id || e.target.value === '') return;
    var max = unitOf(byId(id)).whole, v = Math.round(Number(e.target.value));
    if (v > max) { e.target.value = max; v = max; } else if (v < 1) { e.target.value = 1; v = 1; }
    setKeep(id, v);
    clearTimeout(S.tt); S.tt = setTimeout(function () { if (!sd.open) return; sdRender(); var inp = sd.querySelector('[data-sd-keep="' + id + '"]'); if (inp) { inp.focus(); var n = String(inp.value).length; try { inp.setSelectionRange(n, n); } catch (x) { /* number inputs */ } } }, 450);
  });
  function go() {
    clearTimeout(S.tt);
    var opt = S.opt != null ? S.opts[S.opt] : null, btn = sd.querySelector('[data-sd-go]'); btn.disabled = true;
    if (opt && opt.kind === 'move') {
      var ls = opt.ids.map(byId); ls.forEach(function (o) { o.container = null; }); sd.close(); render();
      toast((opt.po ? opt.po.po : (opt.o.product || opt.o.po)) + ' moved to Not loaded yet');
      assignAll(ls, '').catch(fail); return;
    }
    var ids = planned(), done = [], c0 = S.container ? cById(S.container) : null;
    if (!ids.length) return;
    btn.textContent = 'Splitting…';
    ids.reduce(function (p, id) {
      return p.then(function () {
        var o = byId(id);
        return post(D.base + '/split', { order: o.id, keep: S.plan[id] }).then(function (j) {
          var k = j.kept, pt = j.part, n = {}; Object.keys(o).forEach(function (key) { n[key] = o[key]; });
          o.qty = k.qty; o.cartons = k.cartons; o.cbm = k.cbm; o.kg = k.kg; o.est = k.est; o.part = k.part; o.root = k.root;
          n.id = pt.id; n.qty = pt.qty; n.cartons = pt.cartons; n.cbm = pt.cbm; n.kg = pt.kg; n.est = pt.est; n.part = pt.part; n.root = pt.root; n.container = null; n.urgent = o.urgent;
          D.orders.push(n); fresh[o.id] = 1; done.push(o);
        }).catch(function (x) { x.line = o; throw x; });
      });
    }, Promise.resolve()).then(function () {
      sd.close(); render();
      var t = c0 ? D.box[c0.box] : null, over = c0 && !t.lcl ? usedOf(c0) - t.cap : 0;
      toast((done.length > 1 ? done.length + ' lines split' : 'Split') + ' — the rest is in Not loaded yet' + (over > 0 ? ' · still ' + n2(over) + ' m³ over' : ''));
    }).catch(function (x) {
      sd.close(); render();
      toast((done.length ? done.length + ' split · ' : '') + (x.line ? (x.line.sku || x.line.product || x.line.po) + ' failed: ' : '') + x.message);
    });
  }

  // Forwarder update: shared check window (FwdCheck, above) with this page's live container cards
  var lpFwd = {
    meta: function (cid) { var c = cById(cid); return { name: cName(c), sub: (D.box[c.box].lcl ? 'LCL' : D.box[c.box].name) + (c.fwd && c.fwd.forwarder ? ' · ' + c.fwd.forwarder : '') }; },
    added: function (cid, uid) { var c = cById(cid); if (c) c.fwdReview = (c.fwdReview || []).concat([uid]); },
    done: function (cid, j, msg, uid) {
      var c = cById(cid); if (c) { c.fwdReview = (c.fwdReview || []).filter(function (x) { return x !== uid; }); if (j && j.container) { c.status = j.container.status === 'shipped' ? c.status : j.container.status; c.loading = j.container.loading || c.loading; c.containerNo = j.container.containerNo || c.containerNo; c.fwd = j.container.fwd; } if (j && j.log != null) c.fwdLog = j.log; }
      render(); toast(msg);
    },
    box: function (cid, box) { var c = cById(cid); if (!c) return Promise.resolve(); c.box = box; itemsOf(c).forEach(function (o) { fresh[o.id] = 1; }); render(); return post(D.base + '/containers/' + c.id, { box: box }).then(function () { toast(cName(c) + ' — now ' + D.box[box].name); }); },
  };
  root.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b || !window.FwdCheck) return; var id;
    if ((id = b.getAttribute('data-lp-fwd'))) { window.FwdCheck.input(id, lpFwd); return; }
    if ((id = b.getAttribute('data-lp-fwdrev'))) { window.FwdCheck.review(id, cById(id).fwdReview[0], lpFwd); return; }
    if ((id = b.getAttribute('data-lp-fwdlog'))) window.FwdCheck.log(id, lpFwd);
  });

  // Request quotations popup
  var rq = document.querySelector('[data-lp-req]'), rqForm = rq && rq.querySelector('[data-lp-req-form]'), rqId = null, fws = [];
  function fwRow(f, checked) {
    return '<label class="lp-fw-item"><input type="checkbox" value="' + esc(f.id) + '"' + (checked ? ' checked' : '') + '><span><b>' + esc(f.company) + '</b> ' + esc(f.contact ? '· ' + f.contact : '') + '<span class="sub">' + esc(f.email) + (f.sent ? ' · already asked' : '') + '</span></span></label>';
  }
  function drawFws(checkedIds) {
    var box = rq.querySelector('[data-lp-fw-list]');
    box.innerHTML = fws.length ? fws.map(function (f) { return fwRow(f, checkedIds ? checkedIds.indexOf(f.id) >= 0 : !f.sent); }).join('') : '<p class="sub">No forwarders yet — add one below.</p>';
    if (!fws.length) rq.querySelector('[data-lp-fw-add]').open = true;
  }
  var checkedFws = function () { return Array.prototype.map.call(rq.querySelectorAll('[data-lp-fw-list] input:checked'), function (i) { return i.value; }); };
  function rqDraft() {
    var keep = rq.querySelector('[data-lp-fw-list] input') ? checkedFws() : null;
    var contacts = rq.querySelector('[data-lp-req-contacts]').checked, both = rq.querySelector('[data-lp-req-both]').checked;
    rq.querySelector('[data-lp-req-loading]').hidden = false; rq.querySelector('[data-lp-req-fields]').hidden = true;
    return fetch(D.base + '/containers/' + rqId + '/request?contacts=' + (contacts ? 1 : 0) + '&both=' + (both ? 1 : 0), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'Could not prepare the request');
      var f = rqForm.elements; fws = j.forwarders || [];
      if (!f.cc.value) f.cc.value = j.draft.cc || '';
      f.subject.value = j.draft.subject; f.body.value = j.draft.body;
      drawFws(keep);
      rq.querySelector('[data-lp-req-loading]').hidden = true; rq.querySelector('[data-lp-req-fields]').hidden = false;
    }).catch(function (x) { rq.close(); toast(x.message); });
  }
  if (rq) {
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-lp-request]'); if (!b) return;
      rqId = b.getAttribute('data-lp-request'); rqForm.reset(); rq.querySelector('[data-lp-fw-list]').innerHTML = ''; rq.querySelector('[data-lp-req-note]').textContent = '';
      var rc = cById(rqId), lcl = !!(rc && D.box[rc.box] && D.box[rc.box].lcl), u = rc ? usedOf(rc) : 0;
      rq.querySelector('#lp-req-t').textContent = lcl ? 'Request LCL quotations' : 'Request quotations';
      rq.querySelector('[data-lp-req-bothrow]').hidden = !lcl;
      rq.querySelector('[data-lp-req-contacts]').checked = lcl; // CFS delivery: forwarders need the factories
      rq.querySelector('[data-lp-req-both]').checked = lcl && u >= ZONE[0] && u < ZONE[1];
      if (rq.showModal) rq.showModal(); rqDraft();
    });
    rq.addEventListener('change', function (e) { if (e.target.hasAttribute('data-lp-req-contacts') || e.target.hasAttribute('data-lp-req-both')) rqDraft(); });
    rq.addEventListener('click', function (e) {
      if (e.target.closest('[data-lp-req-close]') || e.target === rq) { rq.close(); return; }
      var add = e.target.closest('[data-lp-fw-save]'); if (!add) return;
      var v = function (k) { return rq.querySelector('[data-nf="' + k + '"]').value.trim(); };
      if (!v('company') || !v('email')) { rq.querySelector('[data-lp-req-note]').textContent = 'Company and email are required'; return; }
      add.disabled = true;
      var body = new URLSearchParams({ company: v('company'), contact_name: v('contact_name'), email: v('email') });
      fetch('/admin/logistics/forwarders', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body, credentials: 'same-origin' })
        .then(function (r) { return r.json(); }).then(function (j) {
          add.disabled = false; if (!j.ok) throw new Error(j.error);
          var keep = checkedFws(); keep.push(j.forwarder.id); fws.push(j.forwarder); drawFws(keep);
          rq.querySelectorAll('[data-nf]').forEach(function (i) { i.value = ''; }); rq.querySelector('[data-lp-req-note]').textContent = j.forwarder.company + ' added';
        }).catch(function (x) { add.disabled = false; rq.querySelector('[data-lp-req-note]').textContent = x.message; });
    });
    rqForm.addEventListener('submit', function (e) {
      e.preventDefault(); var f = rqForm.elements, btn = rq.querySelector('[data-lp-req-send]'), note = rq.querySelector('[data-lp-req-note]'), ids = checkedFws();
      if (!ids.length) { note.textContent = 'Tick at least one forwarder'; return; }
      btn.disabled = true; note.textContent = 'Sending ' + ids.length + ' email' + (ids.length > 1 ? 's' : '') + '…';
      post(D.base + '/containers/' + rqId + '/request', { forwarders: ids.join(','), cc: f.cc.value, subject: f.subject.value, body: f.body.value }).then(function (j) {
        rq.close(); toast('Sent to ' + j.sent.join(', ') + (j.failed.length ? ' — not sent: ' + j.failed.join('; ') : ''));
        setTimeout(function () { location.reload(); }, j.failed.length ? 3500 : 1200);
      }).catch(function (x) { btn.disabled = false; note.textContent = x.message; });
    });
  }

  // Quote: enter / edit by hand, choose
  var qd = document.querySelector('[data-lp-q]'), qForm = qd && qd.querySelector('[data-lp-q-form]'), qId = null;
  root.addEventListener('click', function (e) {
    var ch = e.target.closest('[data-lp-choose]');
    if (ch) {
      var q = findQuote(ch.getAttribute('data-c'), ch.getAttribute('data-lp-choose'));
      window.ask('Choose ' + q.company + (q.total != null ? ' at ' + money(q.total) : '') + ' for this container?', { ok: 'Choose' }).then(function (y) {
        if (!y) return; ch.disabled = true;
        post(D.base + '/quotes/' + q.id + '/choose').then(function () { location.reload(); }).catch(fail);
      });
      return;
    }
    var ed = e.target.closest('[data-lp-qedit]'); if (!ed || !qd) return;
    var q2 = findQuote(ed.getAttribute('data-c'), ed.getAttribute('data-lp-qedit')); if (!q2) return;
    qId = q2.id; var f = qForm.elements;
    qd.querySelector('#lp-q-t').textContent = q2.company; qd.querySelector('[data-lp-q-sub]').textContent = q2.code + (q2.to ? ' · ' + q2.to : '') + (q2.status === 'sent' ? ' · type in a quote you received by phone, WeChat or another email' : '');
    f.total_usd.value = q2.total == null ? '' : q2.total; f.ocean_usd.value = q2.ocean == null ? '' : q2.ocean; f.carrier.value = q2.carrier; f.vessel.value = q2.vessel;
    f.etd.value = q2.etd; f.eta.value = q2.eta; f.cy_cutoff.value = q2.cy; f.valid_until.value = q2.valid; f.free_days.value = q2.free == null ? '' : q2.free;
    f.status.value = q2.status === 'sent' ? 'replied' : q2.status; f.notes.value = q2.notes; qd.querySelector('[data-lp-q-note]').textContent = '';
    if (qd.showModal) qd.showModal(); f.total_usd.focus();
  });
  if (qd) {
    qd.addEventListener('click', function (e) { if (e.target.closest('[data-lp-q-close]') || e.target === qd) qd.close(); });
    qForm.addEventListener('submit', function (e) {
      e.preventDefault(); var data = {}; Array.prototype.forEach.call(qForm.elements, function (el) { if (el.name) data[el.name] = el.value; });
      post(D.base + '/quotes/' + qId, data).then(function () { location.reload(); }).catch(function (x) { qd.querySelector('[data-lp-q-note]').textContent = x.message; });
    });
  }

  var addBtn = document.querySelector('[data-lp-add]');
  function addBox(box, btn) {
    btn.disabled = true;
    post(D.base + '/containers', { port: D.port, box: box }).then(function (j) { D.containers.push(j.container); render(); btn.disabled = false; }).catch(function (x) { btn.disabled = false; toast(x.message); });
  }
  if (addBtn) addBtn.addEventListener('click', function () { addBox('40GP', addBtn); });
  root.addEventListener('click', function (e) { var b = e.target.closest('[data-lp-addlcl]'); if (b) addBox('LCL', b); });
  var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(render, 150); });
  render();
})();

// PO hover card: details of a PO line on [data-po-tip] (Container planning views). Fixed-position so scrolling tables don't clip it.
(function () {
  var tip = null, cur = null, hideT;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var int = function (v) { return Number(v).toLocaleString('en-US'); };
  var n2 = function (v) { return (Math.round(v * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }); };
  function row(k, v) { return v || v === 0 ? '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>' : ''; }
  function show(el) {
    var d; try { d = JSON.parse(el.getAttribute('data-po-tip')); } catch (x) { return; }
    clearTimeout(hideT); cur = el;
    if (!tip) { tip = document.createElement('div'); tip.className = 'po-tip'; tip.id = 'po-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    tip.innerHTML = '<div class="po-tip-h"><b>' + esc(d.po) + '</b>' + (d.status ? '<span class="cp-tag ' + esc(d.tag) + '">' + esc(d.status) + '</span>' : '') + '</div>' +
      '<div class="po-tip-s">' + esc(d.supplier) + '</div>' +
      (d.product ? '<div class="po-tip-p">' + esc(d.product) + (d.sku ? ' <span>' + esc(d.sku) + '</span>' : '') + '</div>' : '') +
      '<dl>' +
        row('Quantity', d.qty != null ? int(d.qty) + ' pcs' : '') +
        row('Volume', d.cbm != null ? n2(d.cbm) + ' m³' + (d.calc ? ' <i>calc.</i>' : '') : '<span class="po-tip-miss">not known</span>') +
        row('Cartons', d.cartons != null ? int(d.cartons) + (d.kg ? ' · ' + int(d.kg) + ' kg' : '') : '') +
        row('Packing', esc(d.pack)) +
        row('Ready', esc(d.ready)) + row('Inspection', esc(d.inspection)) + row('Port', esc(d.port)) +
        row('Production', esc(d.production)) + row('Waiting on us', d.waiting ? '<b class="po-tip-wait">' + esc(d.waiting) + '</b>' : '') +
        row('Container', esc(d.container)) + row('Documents', d.docs ? d.docs + ' file' + (d.docs > 1 ? 's' : '') : '') +
      '</dl>' +
      (d.poLines > 1 ? '<div class="po-tip-f">Whole PO: ' + d.poLines + ' lines · ' + int(d.poQty) + ' pcs' + (d.poCbm ? ' · ' + n2(d.poCbm) + ' m³' : '') + '</div>' : '') +
      '<div class="po-tip-f muted">Click to open the PO</div>';
    tip.hidden = false; tip.classList.add('on');
    el.setAttribute('aria-describedby', 'po-tip');
    // measure the text itself (not a stretched box), and open just to its right, top-aligned
    var rects = el.getClientRects(), r = rects.length ? rects[rects.length - 1] : el.getBoundingClientRect();
    var w = tip.offsetWidth, h = tip.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    var left = r.right + 8; if (left + w > vw - 8) left = Math.max(8, r.left - w - 8);
    var top = r.top - 10; if (top + h > vh - 8) top = Math.max(8, vh - h - 8); if (top < 8) top = 8;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }
  function hide() { if (tip) { tip.classList.remove('on'); tip.hidden = true; } if (cur) cur.removeAttribute('aria-describedby'); cur = null; }
  document.addEventListener('mouseover', function (e) { var el = e.target.closest && e.target.closest('[data-po-tip]'); if (el && el !== cur) show(el); });
  document.addEventListener('mouseout', function (e) { var el = e.target.closest && e.target.closest('[data-po-tip]'); if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) hideT = setTimeout(hide, 80); });
  document.addEventListener('focusin', function (e) { var el = e.target.closest && e.target.closest('[data-po-tip]'); if (el) show(el); });
  document.addEventListener('focusout', function (e) { if (e.target.closest && e.target.closest('[data-po-tip]')) hide(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, true);
})();

// Product page: fill the form from a file with AI → review popup (now vs from file, tick fields) → apply to the form (not saved).
(function () {
  var box = document.querySelector('[data-aifill]'); if (!box) return;
  var url = box.getAttribute('data-aifill'), drop = box.querySelector('[data-aifill-drop]'), file = box.querySelector('[data-aifill-file]');
  var status = box.querySelector('[data-aifill-status]'), dlg = document.querySelector('[data-aifill-dlg]'), rowsEl = dlg.querySelector('[data-aifill-rows]');
  var pick = dlg.querySelector('[data-aifill-pick]'), form = document.querySelector('.product-form'), data = null, scope = null;
  var PACK = ['units_per_inner', 'units_per_carton', 'carton_l_cm', 'carton_w_cm', 'carton_h_cm', 'carton_nw_kg', 'carton_gw_kg', 'product_size_cm', 'unit_net_weight_kg'];
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var GROUP = { product: 'Product', pricing: 'Pricing & terms', packing: 'Packing & carton', other: 'Other' };
  var el = function (k) { return form && form.elements[k]; };
  var cur = function (k) { var e = el(k); return e ? String(e.value || '').trim() : ''; };
  var isNum = function (v) { return /^-?\d+(\.\d+)?$/.test(v); };
  var same = function (a, b) { if (a === '' || b === '') return a === b; if (isNum(a) && isNum(b)) return parseFloat(a) === parseFloat(b); return a.toLowerCase() === b.toLowerCase(); };
  function setStatus(t, bad) { status.textContent = t; status.classList.toggle('bad', !!bad); }
  function rows() {
    var i = +pick.value, vals = (data.products[i] || {}).values || {}, html = '', last = '', n = 0;
    Object.keys(data.labels).forEach(function (k) {
      if (!(k in vals) || !el(k) || (scope && scope.indexOf(k) < 0)) return;
      var lab = data.labels[k], g = lab[2], now = cur(k), v = String(vals[k]), eq = same(now, v);
      if (g !== last) { html += '<tr class="aifill-g"><td colspan="4">' + esc(GROUP[g] || g) + '</td></tr>'; last = g; }
      var on = !eq; if (on) n++;
      html += '<tr class="' + (eq ? 'eq' : now ? 'chg' : 'new') + '"><td><input type="checkbox" data-k="' + esc(k) + '"' + (on ? ' checked' : '') + (eq ? ' disabled' : '') + ' aria-label="Apply ' + esc(lab[0]) + '"></td>' +
        '<td>' + esc(lab[0]) + '</td><td class="now">' + (now ? esc(now.length > 90 ? now.slice(0, 90) + '…' : now) : '<span class="sub">empty</span>') + '</td>' +
        '<td><input class="aifill-v" data-v="' + esc(k) + '" value="' + esc(v) + '"' + (v.length > 60 ? ' title="' + esc(v) + '"' : '') + '>' + (eq ? '<span class="sub"> same</span>' : now ? '<span class="aifill-tag">replaces</span>' : '') + '</td></tr>';
    });
    rowsEl.innerHTML = html || '<tr><td colspan="4" class="sub">' + (scope ? 'No carton or measurement data found in it.' : 'Nothing in this file matches the product fields.') + '</td></tr>';
    count();
  }
  function count() { var n = rowsEl.querySelectorAll('input[type=checkbox]:checked').length; dlg.querySelector('[data-aifill-count]').textContent = n + ' field' + (n === 1 ? '' : 's') + ' selected'; dlg.querySelector('[data-aifill-apply]').textContent = n ? 'Apply ' + n + ' field' + (n === 1 ? '' : 's') + ' to form' : 'Apply to form'; }
  function open(d) {
    data = d;
    pick.innerHTML = d.products.map(function (p, i) { return '<option value="' + i + '">' + esc(p.label) + '</option>'; }).join('');
    pick.value = d.best >= 0 ? d.best : 0;
    dlg.querySelector('[data-aifill-pickwrap]').hidden = d.products.length < 2;
    dlg.querySelector('[data-aifill-ctx]').textContent = [d.docType ? 'Read as: ' + d.docType : '', d.products.length > 1 ? d.products.length + ' products in the file' + (d.best < 0 ? ' — choose which one this is' : '') : '', d.stored ? 'saved to Documents' : ''].filter(Boolean).join(' · ');
    rows(); if (dlg.showModal) dlg.showModal();
  }
  // opts.pack: the Packing & Carton box (only packing / measurement fields are offered); opts.text: pasted text
  function send(f, opts) {
    opts = opts || {}; if (!f && !opts.text) return;
    var zone = opts.pack ? opts.zone : drop, say = opts.pack ? opts.say : setStatus;
    var fd = new FormData(); if (f) fd.append('file', f); if (opts.text) fd.append('text', opts.text);
    if (opts.pack) fd.append('scope', 'packing');
    if (f && !opts.pack && box.querySelector('[data-aifill-keep]').checked) fd.append('keep', '1');
    zone.classList.add('busy'); say('Reading ' + (f ? f.name : 'the pasted text') + ' with AI…');
    fetch(url, { method: 'POST', body: fd, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      zone.classList.remove('busy');
      if (!j.ok) throw new Error(j.error || 'Could not read the file');
      if (!j.products.length) { say('AI found no ' + (opts.pack ? 'carton or measurement data' : 'product details') + ' in ' + (f ? f.name : 'the pasted text') + '.', true); return; }
      say(''); scope = opts.pack ? PACK : null; statusTarget = opts.pack ? opts.say : setStatus; open(j);
    }).catch(function (e) { zone.classList.remove('busy'); say(e.message, true); });
    file.value = '';
  }
  var statusTarget = setStatus;
  // Packing & Carton: a small drop / paste box for measurement screenshots (Amazon listing, spec sheet, packing list…)
  (function () {
    var main = form && form.querySelector('.pcx .pcx-main'); if (!main) return;
    var row = document.createElement('div'); row.className = 'pcx-row pk-ai-row';
    row.innerHTML = '<div class="pcx-lbl">Fill with AI<small>screenshot · file · text</small></div><div class="pk-ai-cell"></div>';
    var z = document.createElement('div'); z.className = 'pk-ai'; z.setAttribute('data-pk-ai', '');
    z.innerHTML = '<span class="pk-ai-ic" aria-hidden="true">✦</span>' +
      '<textarea rows="1" class="pk-ai-in" aria-label="Paste a screenshot or the measurements" placeholder="Paste a screenshot (⌘V) or drop a file"></textarea>' +
      '<button type="button" class="pk-ai-b pk-ai-go" data-pk-read hidden>Read</button><button type="button" class="pk-ai-b" data-pk-choose title="Choose a file">File</button>' +
      '<input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.xlsx,.xlsm,.csv" hidden><span class="pk-ai-over" aria-hidden="true">Drop it here</span>';
    var note = document.createElement('p'); note.className = 'pk-ai-status'; note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
    row.querySelector('.pk-ai-cell').appendChild(z); row.querySelector('.pk-ai-cell').appendChild(note); main.insertBefore(row, main.firstChild);
    var ta = z.querySelector('textarea'), fi = z.querySelector('input[type=file]'), readBtn = z.querySelector('[data-pk-read]');
    var say = function (t, bad) { note.textContent = t; note.classList.toggle('bad', !!bad); };
    var go = function (f, text) { send(f, { pack: true, zone: z, say: say, text: text }); };
    z.querySelector('[data-pk-choose]').addEventListener('click', function () { fi.click(); });
    fi.addEventListener('change', function () { if (fi.files[0]) go(fi.files[0]); fi.value = ''; });
    ta.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f) { e.preventDefault(); go(new File([f], 'measurements-screenshot.' + ((f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')), { type: f.type }), ta.value.trim()); return; } }
    });
    ta.addEventListener('input', function () { readBtn.hidden = !ta.value.trim(); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; });
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ta.value.trim()) { e.preventDefault(); go(null, ta.value.trim()); } });
    readBtn.addEventListener('click', function () { if (ta.value.trim()) go(null, ta.value.trim()); });
    ['dragenter', 'dragover'].forEach(function (t) { z.addEventListener(t, function (e) { if ([].indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return; e.preventDefault(); z.classList.add('over'); }); });
    z.addEventListener('dragleave', function (e) { if (!z.contains(e.relatedTarget)) z.classList.remove('over'); });
    z.addEventListener('drop', function (e) { var f = e.dataTransfer.files && e.dataTransfer.files[0]; z.classList.remove('over'); if (f) { e.preventDefault(); go(f, ta.value.trim()); } });
  })();
  // Compact "Fill with AI" field: paste a screenshot / text, drop a file, or choose one
  var aiText = box.querySelector('[data-aifill-text]'), aiRead = box.querySelector('[data-aifill-read]');
  var shotFile = function (f, base) { return new File([f], base + '.' + ((f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')), { type: f.type }); };
  var fileFromPaste = function (e) { var items = (e.clipboardData && e.clipboardData.items) || []; for (var i = 0; i < items.length; i++) if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f) return f; } return null; };
  var sendMain = function (f, text) { send(f, { text: text }); if (f || text) { aiText.value = ''; aiRead.hidden = true; aiText.style.height = ''; } };
  file.addEventListener('change', function () { if (file.files[0]) sendMain(file.files[0], aiText.value.trim()); });
  box.querySelector('[data-aifill-choose]').addEventListener('click', function () { file.click(); });
  aiText.addEventListener('paste', function (e) { var f = fileFromPaste(e); if (!f) return; e.preventDefault(); sendMain(f.name && f.name !== 'image.png' ? f : shotFile(f, 'pasted-screenshot'), aiText.value.trim()); });
  aiText.addEventListener('input', function () { aiRead.hidden = !aiText.value.trim(); aiText.style.height = 'auto'; aiText.style.height = Math.min(aiText.scrollHeight, 160) + 'px'; });
  aiText.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && aiText.value.trim()) { e.preventDefault(); sendMain(null, aiText.value.trim()); } });
  aiRead.addEventListener('click', function () { if (aiText.value.trim()) sendMain(null, aiText.value.trim()); });
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { if ([].indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return; e.preventDefault(); drop.classList.add('over'); }); });
  drop.addEventListener('dragleave', function (e) { if (!drop.contains(e.relatedTarget)) drop.classList.remove('over'); });
  drop.addEventListener('drop', function (e) { var f = e.dataTransfer.files && e.dataTransfer.files[0]; drop.classList.remove('over'); if (f) { e.preventDefault(); sendMain(f, aiText.value.trim()); } });
  // ⌘V anywhere in the open Edit section (not inside another field) also works for screenshots
  document.addEventListener('paste', function (e) {
    var ed = document.getElementById('edit'); if (!ed || !ed.open || e.target === aiText) return;
    if (e.target.closest && e.target.closest('input,textarea,select,[contenteditable],[data-pk-ai],dialog')) return;
    var f = fileFromPaste(e); if (!f) return; e.preventDefault(); sendMain(shotFile(f, 'pasted-screenshot'), '');
  });
  pick.addEventListener('change', rows);
  rowsEl.addEventListener('change', count);
  rowsEl.addEventListener('input', function (e) { var k = e.target.getAttribute('data-v'); if (k) { var c = rowsEl.querySelector('input[data-k="' + k + '"]'); if (c && !c.disabled) { c.checked = true; count(); } } });
  dlg.addEventListener('click', function (e) {
    if (e.target.closest('[data-aifill-close]') || e.target === dlg) { dlg.close(); return; }
    if (e.target.closest('[data-aifill-all]')) { rowsEl.querySelectorAll('input[type=checkbox]:not(:disabled)').forEach(function (c) { c.checked = true; }); count(); return; }
    if (e.target.closest('[data-aifill-none]')) { rowsEl.querySelectorAll('input[type=checkbox]').forEach(function (c) { c.checked = false; }); count(); return; }
    if (!e.target.closest('[data-aifill-apply]')) return;
    var done = 0, skipped = [];
    rowsEl.querySelectorAll('input[type=checkbox]:checked').forEach(function (c) {
      var k = c.getAttribute('data-k'), v = rowsEl.querySelector('[data-v="' + k + '"]').value, f = el(k); if (!f) return;
      if (f.tagName === 'SELECT' && !Array.prototype.some.call(f.options, function (o) { return (o.value || o.text) === v; })) { skipped.push(data.labels[k][0] + ' "' + v + '"'); return; }
      f.value = v; f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true }));
      var hl = f.closest('.pcx-u') || f; hl.classList.add('aifill-hl'); setTimeout(function () { hl.classList.remove('aifill-hl'); }, 6000);
      done++;
    });
    dlg.close();
    statusTarget(done + ' field' + (done === 1 ? '' : 's') + ' filled — check them and click Save product.' + (skipped.length ? ' Not applied (not in the list): ' + skipped.join(', ') + '.' : ''));
    if (scope) { var tx = document.querySelector('[data-pk-ai] textarea'); if (tx) { tx.value = ''; tx.style.height = ''; var rb = document.querySelector('[data-pk-read]'); if (rb) rb.hidden = true; } }
    var ed = document.getElementById('edit'); if (ed) ed.open = true;
    var first = document.querySelector('.aifill-hl'); if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('[data-aifill-open]')) setTimeout(function () { drop.scrollIntoView({ block: 'center' }); aiText.focus(); }, 50); });
})();

// Supplier holidays popup (CRM calendar + supplier portal): read a notice with AI or type the dates, check, save.
(function () {
  var dlg = document.querySelector('[data-hol-dlg]'); if (!dlg) return;
  var L = function (en, zh) { return '<span class="i-en">' + en + '</span><span class="i-zh" lang="zh-CN">' + zh + '</span>'; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var bi = function (s) { var m = String(s || '').match(/^⟪([^⟫]*)⟫⟦([^⟧]*)⟧$/); return m ? L(esc(m[1]), esc(m[2])) : esc(s); };
  var stepRead = dlg.querySelector('[data-hol-step="read"]'), form = dlg.querySelector('[data-hol-step="form"]');
  var status = dlg.querySelector('[data-hol-status]'), fileIn = dlg.querySelector('[data-hol-file]'), drop = dlg.querySelector('[data-hol-drop]');
  var pick = dlg.querySelector('[data-hol-pick]'), found = [], token = '', attached = null;
  var textIn = dlg.querySelector('[data-hol-text]'), sup0 = dlg.querySelector('[data-hol-sup0]');
  var att = dlg.querySelector('[data-hol-att]'), hint = dlg.querySelector('[data-hol-hint]');
  function attach(f) {
    attached = f || null; att.hidden = !attached; hint.hidden = !!attached;
    dlg.querySelector('[data-hol-attname]').textContent = attached ? '📎 ' + (attached.name || 'screenshot.png') + ' · ' + Math.max(1, Math.round(attached.size / 1024)) + ' KB' : '';
    status.textContent = ''; status.classList.remove('bad');
  }
  var F = ['order_cutoff', 'order_cutoff_after', 'last_ship', 'first_ship', 'factory_from', 'factory_to', 'office_from', 'office_to'];
  function field(k) { return form.querySelector('[data-hf="' + k + '"]'); }
  function setSup(el, id) { if (!el) return; var b = el.closest('[data-single-pick]'); if (b && b._pick) b._pick(id || ''); else el.value = id || ''; }
  function show(step) { stepRead.hidden = step !== 'read'; form.hidden = step !== 'form'; }
  function title(en, zh) { dlg.querySelector('[data-hol-title]').innerHTML = L(en, zh); }
  function fill(h, quotes) {
    ['id', 'name', 'notes'].forEach(function (k) { var f = field(k); if (f && h[k] !== undefined) f.value = h[k] || ''; });
    if (h.supplier_id !== undefined) setSup(field('supplier_id'), h.supplier_id);
    F.forEach(function (k) {
      var f = field(k); if (!f) return; f.value = h[k] || '';
      f.classList.toggle('ai', !!(quotes && h[k]));
      var q = form.querySelector('[data-q="' + k + '"]'); if (q) q.textContent = quotes && quotes[k] ? '“' + quotes[k] + '”' : '';
    });
  }
  function open(mode, data) {
    form.reset(); found = []; token = ''; status.textContent = ''; status.classList.remove('bad');
    textIn.value = ''; attach(null); setSup(sup0, ''); setSup(field('supplier_id'), ''); field('file_token').value = ''; field('id').value = '';
    dlg.querySelector('[data-hol-pickwrap]').hidden = true; dlg.querySelector('[data-hol-src]').textContent = '';
    form.querySelectorAll('.hol-q').forEach(function (q) { q.textContent = ''; });
    var del = dlg.querySelector('[data-hol-delete]'); del.hidden = !data;
    if (data) { title('Edit holiday', '编辑假期'); fill(data, null); if (data.file) dlg.querySelector('[data-hol-src]').textContent = 'Notice: ' + data.file; show('form'); }
    else if (mode === 'manual') { title('Add holiday', '添加假期'); show('form'); }
    else { title('Add holiday schedule', '添加假期安排'); show('read'); }
    if (dlg.showModal) dlg.showModal();
    setTimeout(function () { var f = data || mode === 'manual' ? field('name') : (sup0 || textIn); if (f) f.focus(); }, 30);
  }
  document.addEventListener('click', function (e) {
    var o = e.target.closest && e.target.closest('[data-hol-open]');
    if (o) { open(o.getAttribute('data-hol-open')); return; }
    var ed = e.target.closest && e.target.closest('[data-hol-edit]');
    if (ed) { e.preventDefault(); try { open('edit', JSON.parse(ed.getAttribute('data-hol-edit'))); } catch (x) { /* bad data */ } }
  });
  dlg.addEventListener('click', function (e) {
    if (e.target.closest('[data-hol-close]') || e.target === dlg) { dlg.close(); return; }
    if (e.target.closest('[data-hol-manual]')) { title('Add holiday', '添加假期'); if (sup0) setSup(field('supplier_id'), sup0.value); show('form'); field('name').focus(); return; }
    if (e.target.closest('[data-hol-read]')) { send(); return; }
    if (e.target.closest('[data-hol-choose]')) { fileIn.click(); return; }
    if (e.target.closest('[data-hol-attx]')) { attach(null); return; }
    if (e.target.closest('[data-hol-delete]')) {
      var id = field('id').value; if (!id) return;
      window.ask(document.documentElement.lang === 'zh-CN' ? '删除此假期？' : 'Delete this holiday?', { danger: true }).then(function (y) { if (!y) return;
      var f = document.createElement('form'); f.method = 'post'; f.action = dlg.getAttribute('data-delete-base') + '/' + encodeURIComponent(id) + '/delete';
      var b = form.querySelector('[name="back"]'); if (b && b.value) { var i = document.createElement('input'); i.type = 'hidden'; i.name = 'back'; i.value = b.value; f.appendChild(i); }
      document.body.appendChild(f); f.submit(); });
    }
  });
  function send() {
    var file = attached, text = textIn.value.trim();
    if (!file && !text) { status.innerHTML = L('Paste the email text or a screenshot, or drop a file first.', '请先粘贴邮件内容或截图，或拖入文件。'); status.classList.add('bad'); return; }
    var fd = new FormData(); if (file) fd.append('file', file); if (text) fd.append('text', text);
    var sent = dlg.querySelector('[data-hol-sent]').value; if (sent) fd.append('sent', sent);
    drop.classList.add('busy'); status.classList.remove('bad'); status.innerHTML = L('Reading with AI…', 'AI 识别中…');
    fetch(dlg.getAttribute('data-read'), { method: 'POST', body: fd, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      drop.classList.remove('busy');
      if (!j.ok) throw new Error(j.error || 'Could not read it');
      found = j.holidays; token = j.fileToken || '';
      pick.innerHTML = found.map(function (h, i) { return '<option value="' + i + '">' + esc(h.name) + '</option>'; }).join('');
      dlg.querySelector('[data-hol-pickwrap]').hidden = found.length < 2;
      fill(found[0], found[0].quotes); field('file_token').value = token;
      var sup = field('supplier_id'); if (sup) setSup(sup, (sup0 && sup0.value) || j.supplierId || '');
      dlg.querySelector('[data-hol-src]').innerHTML = L('Green dates were read by AI — check each one. Quotes show where it found them.', '绿色日期由 AI 识别，请逐一核对。引号内为原文。') + (j.supplierName && sup && !sup.value ? ' · AI saw: ' + esc(j.supplierName) : '');
      title('Check what AI read', '核对 AI 识别结果'); show('form');
    }).catch(function (x) { drop.classList.remove('busy'); status.innerHTML = bi(x.message); status.classList.add('bad'); });
  }
  pick.addEventListener('change', function () { var h = found[+pick.value]; if (h) { fill(h, h.quotes); field('file_token').value = token; } });
  fileIn.addEventListener('change', function () { if (fileIn.files[0]) attach(fileIn.files[0]); fileIn.value = ''; });
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { if (!e.dataTransfer || [].indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return; e.preventDefault(); drop.classList.add('over'); }); });
  drop.addEventListener('dragleave', function (e) { if (!drop.contains(e.relatedTarget)) drop.classList.remove('over'); });
  drop.addEventListener('drop', function (e) { var f = e.dataTransfer.files && e.dataTransfer.files[0]; drop.classList.remove('over'); if (f) { e.preventDefault(); attach(f); } });
  // paste a screenshot straight from the clipboard (text pastes into the box as usual)
  textIn.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        var f = items[i].getAsFile(); if (!f) continue;
        e.preventDefault();
        if (!f.name || f.name === 'image.png') { try { f = new File([f], 'screenshot-' + new Date().toISOString().slice(0, 10) + '.' + ((f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')), { type: f.type }); } catch (x) { /* old browser keeps the blob */ } }
        attach(f); return;
      }
    }
  });
  form.addEventListener('input', function (e) { if (e.target.classList.contains('ai')) e.target.classList.remove('ai'); });
  form.addEventListener('submit', function (e) {
    if (!F.some(function (k) { var f = field(k); return f && f.value; })) { e.preventDefault(); dlg.querySelector('[data-hol-src]').innerHTML = L('Enter at least one date.', '请至少填写一个日期。'); }
  });
})();

// CRM calendar filters: CRM activities · supplier holidays · per supplier (remembered in this browser)
(function () {
  var bar = document.querySelector('[data-cal-filters]'); if (!bar) return;
  var KEY = 'lb-cal-filters', st = {};
  try { st = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (x) { st = {}; }
  var apply = function () {
    document.body.classList.toggle('cal-no-act', st.act === false);
    document.body.classList.toggle('cal-no-hol', st.hol === false);
    bar.querySelectorAll('[data-cal-toggle]').forEach(function (b) { var k = b.getAttribute('data-cal-toggle'); b.classList.toggle('on', st[k] !== false); b.setAttribute('aria-pressed', st[k] !== false); });
    bar.querySelectorAll('[data-cal-sup]').forEach(function (b) {
      var id = b.getAttribute('data-cal-sup'), on = !(st.off || []).includes(id);
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
      document.querySelectorAll('[data-sup="' + id + '"]').forEach(function (el) { el.classList.toggle('sup-off', !on); });
    });
  };
  bar.addEventListener('click', function (e) {
    var t = e.target.closest('[data-cal-toggle]'), s = e.target.closest('[data-cal-sup]');
    if (t) { var k = t.getAttribute('data-cal-toggle'); st[k] = st[k] === false; }
    else if (s) { var id = s.getAttribute('data-cal-sup'); st.off = st.off || []; var i = st.off.indexOf(id); if (i >= 0) st.off.splice(i, 1); else st.off.push(id); }
    else return;
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (x) { /* private mode */ }
    apply();
  });
  apply();
})();

// CRM calendar · "Supplier holidays · coming up": filter by stage and suppliers (multi), show 8 at a time
(function () {
  var card = document.querySelector('[data-hol-upcard]'); if (!card) return;
  var more = card.querySelector('[data-hol-upmore]'), none = card.querySelector('[data-hol-upnone]');
  var items = Array.prototype.slice.call(card.querySelectorAll('.hol-up > li')), all = false, N = 8;
  var kinds = Array.prototype.slice.call(card.querySelectorAll('[data-up-kind]'));
  var cbs = Array.prototype.slice.call(card.querySelectorAll('[data-up-sup-cb]'));
  var pop = card.querySelector('[data-up-sup-pop]'), btn = card.querySelector('[data-up-sup-btn]'), q = card.querySelector('[data-up-sup-q]');
  function apply() {
    var onK = kinds.filter(function (b) { return b.classList.contains('on'); }).map(function (b) { return b.getAttribute('data-up-kind'); });
    var onS = cbs.filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
    var shown = 0, match = 0;
    items.forEach(function (li) {
      var ok = (!kinds.length || onK.indexOf(li.getAttribute('data-kind')) >= 0) && (!cbs.length || onS.indexOf(li.getAttribute('data-sup')) >= 0) && !li.classList.contains('sup-off');
      if (ok) match++;
      li.hidden = !ok || (!all && shown >= N); if (!li.hidden) shown++;
    });
    if (none) none.hidden = match > 0;
    if (more) { more.hidden = match <= N; more.textContent = all ? 'Show fewer' : 'Show all ' + match; }
    if (btn) {
      var lbl = btn.querySelector('[data-up-sup-label]');
      lbl.textContent = onS.length === cbs.length ? 'All suppliers' : onS.length === 0 ? 'No suppliers' : onS.length === 1 ? cbs.filter(function (c) { return c.checked; })[0].parentNode.textContent.trim() : onS.length + ' suppliers';
      btn.classList.toggle('on', onS.length !== cbs.length);
    }
  }
  kinds.forEach(function (b) { b.addEventListener('click', function () { b.classList.toggle('on'); b.setAttribute('aria-pressed', b.classList.contains('on')); all = false; apply(); }); });
  cbs.forEach(function (c) { c.addEventListener('change', function () { all = false; apply(); }); });
  if (btn) {
    var setOpen = function (o) { pop.hidden = !o; btn.setAttribute('aria-expanded', o); if (o) { q.value = ''; filterList(); q.focus(); } };
    var filterList = function () { var w = q.value.trim().toLowerCase(); cbs.forEach(function (c) { c.closest('li').hidden = w && c.parentNode.textContent.toLowerCase().indexOf(w) < 0; }); };
    btn.addEventListener('click', function () { setOpen(pop.hidden); });
    q.addEventListener('input', filterList);
    card.querySelector('[data-up-sup-all]').addEventListener('click', function () { cbs.forEach(function (c) { if (!c.closest('li').hidden) c.checked = true; }); apply(); });
    card.querySelector('[data-up-sup-none]').addEventListener('click', function () { cbs.forEach(function (c) { c.checked = false; }); apply(); });
    document.addEventListener('click', function (e) { if (!pop.hidden && !e.target.closest('[data-up-sup]')) setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !pop.hidden) { setOpen(false); btn.focus(); } });
  }
  if (more) more.addEventListener('click', function () { all = !all; apply(); });
  var bar = document.querySelector('[data-cal-filters]'); if (bar) bar.addEventListener('click', function () { setTimeout(apply, 0); });
  apply();
})();

// CRM calendar · holiday reminder email: choose groups / suppliers / extra emails, check the draft, send
(function () {
  var dlg = document.querySelector('[data-rem-dlg]'); if (!dlg) return;
  var groups = Array.prototype.slice.call(dlg.querySelectorAll('[data-rem-group]'));
  var rows = Array.prototype.slice.call(dlg.querySelectorAll('[data-rem-list] > li'));
  var skip = dlg.querySelector('[data-rem-skip]'), q = dlg.querySelector('[data-rem-q]'), extra = dlg.querySelector('[data-rem-extra]');
  var count = dlg.querySelector('[data-rem-count]'), send = dlg.querySelector('[data-rem-send]'), none = dlg.querySelector('[data-rem-none]');
  var onGroups = function () { return groups.filter(function (b) { return b.classList.contains('on'); }).map(function (b) { return b.getAttribute('data-rem-group'); }); };
  var inGroup = function (li) { return onGroups().indexOf(li.getAttribute('data-status')) >= 0; };
  var cb = function (li) { return li.querySelector('[data-rem-cb]'); };
  // tick everyone in the chosen groups (minus confirmed when skipping); untick the rest
  function retick() { rows.forEach(function (li) { var c = cb(li); if (!c.disabled) c.checked = inGroup(li) && !(skip.checked && li.getAttribute('data-confirmed')); }); show(); }
  function show() {
    var w = q.value.trim().toLowerCase(), vis = 0;
    rows.forEach(function (li) { var on = (inGroup(li) || cb(li).checked) && (!w || li.getAttribute('data-name').indexOf(w) >= 0); li.hidden = !on; if (on) vis++; });
    none.hidden = vis > 0; tally();
  }
  function tally() {
    var n = rows.filter(function (li) { return cb(li).checked; }).length;
    var x = extra.value.split(/[\s,;]+/).filter(function (e) { return e.indexOf('@') > 0; }).length;
    var parts = []; if (n) parts.push(n + ' supplier' + (n === 1 ? '' : 's')); if (x) parts.push(x + ' other email' + (x === 1 ? '' : 's'));
    count.textContent = parts.length ? 'Will email ' + parts.join(' + ') : 'Nobody selected';
    send.textContent = parts.length ? 'Send to ' + parts.join(' + ') : 'Send'; send.disabled = !parts.length;
  }
  groups.forEach(function (b) { b.addEventListener('click', function () { b.classList.toggle('on'); b.setAttribute('aria-pressed', b.classList.contains('on')); retick(); }); });
  skip.addEventListener('change', retick); q.addEventListener('input', show); extra.addEventListener('input', tally);
  dlg.addEventListener('change', function (e) { if (e.target.matches('[data-rem-cb]')) tally(); });
  dlg.querySelector('[data-rem-form]').addEventListener('submit', function (e) {
    var fm = e.target; if (fm.dataset.asked === '1') { delete fm.dataset.asked; return; }
    e.preventDefault();
    window.ask(count.textContent.replace('Will email', 'Send the reminder to') + '?', { ok: 'Send' }).then(function (y) { if (y) { fm.dataset.asked = '1'; if (fm.requestSubmit) fm.requestSubmit(); else fm.submit(); } });
  });
  document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('[data-rem-open]')) { q.value = ''; retick(); dlg.showModal(); } });
  dlg.addEventListener('click', function (e) { if (e.target === dlg || e.target.closest('[data-rem-close]')) dlg.close(); });
  retick();
})();

// Development thread: "Reply to supplier" / "Add supplier's reply" tabs, and the manual reply form
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-rtab]')); if (!tabs.length) return;
  tabs.forEach(function (b) { b.addEventListener('click', function () {
    tabs.forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
    document.querySelectorAll('[data-rpane]').forEach(function (p) { p.hidden = p.getAttribute('data-rpane') !== b.getAttribute('data-rtab'); });
  }); });
  var form = document.querySelector('[data-mr-form]'); if (!form) return;
  var from = form.querySelector('[data-mr-from]'), other = form.querySelector('[data-mr-other]');
  var sync = function () { other.hidden = from.value !== '' ; if (!other.hidden) other.focus(); };
  from.addEventListener('change', sync); if (from.options.length === 1) other.hidden = false;
  form.addEventListener('submit', function (e) {
    var when = form.querySelector('[data-mr-when]'), iso = form.querySelector('[data-mr-iso]');
    if (when.value) { var d = new Date(when.value); if (!isNaN(d)) iso.value = d.toISOString(); } // browser's own time zone
    var body = form.querySelector('textarea[name=body]').value.trim(), files = Array.prototype.some.call(form.querySelectorAll('input[type=file]'), function (i) { return i.files.length; });
    if (!body && !files) { e.preventDefault(); alert('Paste the message or add a file first.'); return; }
    var btn = form.querySelector('.mr-act .btn'); btn.disabled = true; btn.textContent = form.querySelector('[name=ai]').checked || form.querySelector('[name=quote]').checked ? 'Reading with AI…' : 'Adding…';
  });
})();

// Development thread: AI email draft (follow-up / request) → check & edit → use as the reply
(function () {
  var dlg = document.querySelector('[data-ad-dlg]'); if (!dlg) return;
  var url = dlg.getAttribute('data-url'), status = dlg.querySelector('[data-ad-status]'), out = dlg.querySelector('[data-ad-out]');
  var text = dlg.querySelector('[data-ad-text]'), pend = dlg.querySelector('[data-ad-pending]'), busy = false;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var val = function (n) { var r = dlg.querySelector('input[name="' + n + '"]:checked'); return r ? r.value : ''; };
  var say = function (t, bad) { status.textContent = t; status.classList.toggle('bad', !!bad); };
  function write() {
    if (busy) return; busy = true;
    var btns = dlg.querySelectorAll('[data-ad-go]'); Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
    say('Reading the project and the conversation, writing the email…');
    var body = new URLSearchParams({ purpose: val('ad_purpose'), tone: val('ad_tone'), notes: dlg.querySelector('[data-ad-notes]').value, zh: dlg.querySelector('[data-ad-zh]').checked ? '1' : '' });
    fetch(url, { method: 'POST', body: body, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'Could not write the draft');
      say(''); out.hidden = false; text.value = j.body; text.focus(); text.setSelectionRange(0, 0); text.scrollTop = 0;
      pend.hidden = !(j.pending && j.pending.length);
      pend.querySelector('ul').innerHTML = (j.pending || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
    }).catch(function (e) { say(e.message, true); }).then(function () { busy = false; Array.prototype.forEach.call(btns, function (b) { b.disabled = false; }); });
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    if (e.target.closest('[data-ad-open]')) { say(''); dlg.showModal(); return; }
    if (!dlg.contains(e.target)) return;
    if (e.target === dlg || e.target.closest('[data-ad-close]')) { dlg.close(); return; }
    if (e.target.closest('[data-ad-go]')) { write(); return; }
    if (e.target.closest('[data-ad-copy]')) { var b = e.target.closest('[data-ad-copy]'); (navigator.clipboard ? navigator.clipboard.writeText(text.value) : Promise.reject()).then(function () { b.textContent = 'Copied ✓'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); }).catch(function () { text.select(); }); return; }
    if (e.target.closest('[data-ad-use]')) {
      var reply = document.querySelector('[data-reply-body]'); if (!reply) return;
      var tab = document.querySelector('[data-rtab="reply"]'); if (tab && !tab.classList.contains('on')) tab.click();
      reply.value = text.value; reply.dispatchEvent(new Event('input', { bubbles: true }));
      reply.style.height = 'auto'; reply.style.height = Math.min(reply.scrollHeight + 4, 520) + 'px';
      dlg.close(); reply.focus(); reply.scrollIntoView({ block: 'center', behavior: 'smooth' });
      reply.classList.add('aifill-hl'); setTimeout(function () { reply.classList.remove('aifill-hl'); }, 4000);
    }
  });
})();

// Shipping documents: draft editor popup for a request, reminder or missing-documents follow-up.
(function () {
  var dlg = document.querySelector('[data-sd-dlg]'); if (!dlg) return;
  var form = dlg.querySelector('[data-sd-form]'), el = form.elements, cur = null, draft = null;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var q = function (s) { return dlg.querySelector(s); };
  var EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
  var TAG = { have: ['have', 'Received'], miss: ['miss', 'Missing'], later: ['later', 'Later'], opt: ['opt', 'Optional'] };
  function chip(email, label, on) {
    return '<span class="sd-chip' + (on ? '' : ' off') + '" data-email="' + esc(email) + '"' + (on ? '' : ' title="Click to add"') + '>' + esc(email) + (label ? ' <small>' + esc(label) + '</small>' : '') + (on ? '<button type="button" aria-label="Remove ' + esc(email) + '">×</button>' : '') + '</span>';
  }
  function addChip(box, v) {
    v.split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (e) {
      if (box.querySelector('[data-email="' + e.toLowerCase().replace(/"/g, '') + '"]')) return;
      box.querySelector('[data-sd-add]').insertAdjacentHTML('beforebegin', chip(e.toLowerCase(), EMAIL.test(e) ? '' : 'check address', true));
      if (!EMAIL.test(e)) box.querySelector('[data-email="' + e.toLowerCase().replace(/"/g, '') + '"]').classList.add('bad');
    });
  }
  function itemRow(it) {
    var t = TAG[it.state];
    return '<div class="sd-it' + (it.on ? '' : ' off') + '"><input type="checkbox"' + (it.on ? ' checked' : '') + ' aria-label="Include"><input type="text" value="' + esc(it.text) + '" aria-label="Document">' +
      (it.note ? '<span class="sd-it-n">' + esc(it.note) + '</span>' : '') + (t ? '<span class="sd-st2 ' + t[0] + '">' + t[1] + '</span>' : '') + '<button type="button" class="sd-rm" title="Remove" aria-label="Remove">×</button></div>';
  }
  function fill(j) {
    draft = j;
    q('[data-sd-title]').textContent = j.title; q('[data-sd-ctx]').textContent = j.ctx;
    q('[data-sd-tabs]').innerHTML = j.kinds.length > 1 ? j.kinds.map(function (k) { return '<button type="button" data-sd-kind="' + k + '" class="' + (k === j.kind ? 'on' : '') + '">' + { request: 'First request', reminder: 'Reminder', missing: 'Missing documents' }[k] + '</button>'; }).join('') : '';
    q('[data-sd-tabs]').hidden = j.kinds.length < 2;
    cur.mode = j.mode; q('[data-sd-modes]').hidden = !j.choose;
    q('[data-sd-mseg]').innerHTML = j.choose ? Object.keys(j.modes).map(function (m) { return '<button type="button" role="radio" aria-checked="' + (m === j.mode) + '" data-sd-m="' + m + '" class="' + (m === j.mode ? 'on' : '') + '">' + esc(j.modes[m]) + '</button>'; }).join('') : '';
    var to = q('[data-sd-to]'), cc = q('[data-sd-cc]');
    to.querySelectorAll('.sd-chip').forEach(function (c) { c.remove(); }); cc.querySelectorAll('.sd-chip').forEach(function (c) { c.remove(); });
    to.querySelector('[data-sd-add]').insertAdjacentHTML('beforebegin', j.to.map(function (t) { return chip(t.email, t.label, t.on); }).join(''));
    if (j.cc.length) { cc.querySelector('[data-sd-add]').insertAdjacentHTML('beforebegin', j.cc.map(function (e) { return chip(e, '', true); }).join('')); q('[data-sd-ccrow]').hidden = false; } else q('[data-sd-ccrow]').hidden = true;
    el.subject.value = j.subject; q('[data-sd-code]').textContent = '[' + j.code + ']';
    el.intro.value = j.intro; q('[data-sd-greet]').innerHTML = 'Starts with <b>Dear ' + esc(j.greet) + ',</b>';
    q('[data-sd-fixed]').innerHTML = j.fixed ? '<i aria-hidden="true">▦</i><span><b>PO table added automatically</b> — ' + esc(j.fixed) + '</span>' : '';
    q('[data-sd-listlbl]').textContent = j.listLabel;
    q('[data-sd-items]').innerHTML = j.items.map(itemRow).join('') + '<div class="sd-addline"><input type="text" placeholder="+ Add a line, e.g. Certificate of origin" aria-label="Add a line"><button type="button">Add</button></div>';
    q('[data-sd-rcvrow]').hidden = !(j.kind === 'missing' && j.received.length); q('[data-sd-rcv]').checked = true; q('[data-sd-rcvlist]').textContent = j.received.join(', ');
    q('[data-sd-sum]').textContent = j.after || '';
    q('[data-sd-send]').textContent = j.kind === 'request' ? 'Send request' : 'Send'; q('[data-sd-send]').disabled = false; q('[data-sd-note]').textContent = '';
    q('[data-sd-loading]').hidden = true; q('[data-sd-fields]').hidden = false; q('[data-sd-actions]').hidden = false;
  }
  function load(kind) {
    cur.kind = kind; q('[data-sd-loading]').hidden = false; q('[data-sd-loading]').textContent = 'Preparing the email…'; q('[data-sd-fields]').hidden = true; q('[data-sd-actions]').hidden = true;
    var p = new URLSearchParams({ kind: kind }); ['id', 'supplier', 'po'].forEach(function (k) { if (cur[k]) p.set(k, cur[k]); });
    if (cur.mode !== undefined) p.set('mode', cur.mode);
    fetch('/admin/orders/shipping/draft?' + p, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'Could not prepare the email'); cur.kind = j.kind; fill(j);
    }).catch(function (x) { q('[data-sd-loading]').textContent = x.message; });
  }
  document.addEventListener('submit', function (e) {
    var f = e.target.closest && e.target.closest('[data-sd-open]'); if (!f) return; e.preventDefault();
    cur = { id: f.getAttribute('data-id') || '', supplier: f.getAttribute('data-supplier') || '', po: f.getAttribute('data-po') || '', mode: undefined };
    q('[data-sd-tabs]').innerHTML = ''; if (dlg.showModal) dlg.showModal(); load(f.getAttribute('data-kind') || 'request');
  }, true);
  dlg.addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest('[data-sd-close]') || t === dlg) { dlg.close(); return; }
    var k = t.closest('[data-sd-kind]'); if (k) { if (k.getAttribute('data-sd-kind') !== cur.kind) load(k.getAttribute('data-sd-kind')); return; }
    var mb = t.closest('[data-sd-m]'); if (mb) { var m = mb.getAttribute('data-sd-m'); cur.mode = cur.mode === m ? '' : m; load(cur.kind); return; }
    if (t.closest('[data-sd-cc-open]')) { q('[data-sd-ccrow]').hidden = false; q('[data-sd-cc] [data-sd-add]').focus(); return; }
    if (t.closest('[data-sd-reset]')) { el.intro.value = draft.intro; return; }
    if (t.matches('.sd-chip button')) { t.parentNode.remove(); return; }
    var off = t.closest('.sd-chip.off'); if (off) { off.classList.remove('off'); off.removeAttribute('title'); off.insertAdjacentHTML('beforeend', '<button type="button" aria-label="Remove">×</button>'); return; }
    if (t.closest('.sd-rcp') && !t.closest('.sd-chip')) { t.closest('.sd-rcp').querySelector('[data-sd-add]').focus(); return; }
    if (t.matches('.sd-rm')) { t.parentNode.remove(); return; }
    if (t.matches('.sd-addline button')) { var i = t.parentNode.querySelector('input'); if (!i.value.trim()) return; t.parentNode.insertAdjacentHTML('beforebegin', itemRow({ text: i.value.trim(), state: '', on: true })); i.value = ''; i.focus(); }
  });
  dlg.addEventListener('change', function (e) { if (e.target.matches('.sd-it input[type=checkbox]')) e.target.parentNode.classList.toggle('off', !e.target.checked); });
  dlg.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t.matches('[data-sd-add]') && (e.key === 'Enter' || e.key === ',' || e.key === ';') && t.value.trim()) { e.preventDefault(); addChip(t.closest('.sd-rcp'), t.value); t.value = ''; return; }
    if (t.matches('[data-sd-add]') && e.key === 'Backspace' && !t.value) { var last = t.closest('.sd-rcp').querySelectorAll('.sd-chip:not(.off)'); if (last.length) last[last.length - 1].remove(); return; }
    if (t.matches('.sd-addline input') && e.key === 'Enter') { e.preventDefault(); t.parentNode.querySelector('button').click(); return; }
    if (e.key === 'Enter' && t.matches('input[type=text]')) e.preventDefault();
  });
  dlg.addEventListener('focusout', function (e) { var t = e.target; if (t.matches('[data-sd-add]') && t.value.trim()) { addChip(t.closest('.sd-rcp'), t.value); t.value = ''; } });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var note = q('[data-sd-note]'), btn = q('[data-sd-send]');
    var emails = function (box) { return Array.prototype.map.call(box.querySelectorAll('.sd-chip:not(.off)'), function (c) { return c.getAttribute('data-email'); }); };
    var to = emails(q('[data-sd-to]')), cc = emails(q('[data-sd-cc]'));
    var items = Array.prototype.filter.call(dlg.querySelectorAll('.sd-it'), function (r) { return r.querySelector('input[type=checkbox]').checked; }).map(function (r) { return r.querySelector('input[type=text]').value.trim(); }).filter(Boolean);
    if (!to.length) { note.textContent = 'Add at least one recipient'; return; }
    var bad = to.concat(cc).filter(function (x) { return !EMAIL.test(x); }); if (bad.length) { note.textContent = 'Check this email address: ' + bad[0]; return; }
    if (!items.length) { note.textContent = 'Tick at least one document to ask for'; return; }
    btn.disabled = true; note.textContent = 'Sending…';
    if (!q('[data-sd-modes]').hidden && !cur.mode) { note.textContent = 'Choose how it ships: FCL, LCL or Courier'; return; }
    var body = new URLSearchParams({ kind: cur.kind, id: cur.id, supplier: cur.supplier, po: cur.po, mode: cur.mode || '', to: to.join(','), cc: cc.join(','), subject: el.subject.value, intro: el.intro.value, received: q('[data-sd-rcvrow]').hidden || q('[data-sd-rcv]').checked ? '1' : '0' });
    items.forEach(function (x) { body.append('item', x); });
    fetch('/admin/orders/shipping/send', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body, credentials: 'same-origin' })
      .then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) throw new Error(j.error || 'Could not send');
        note.textContent = '✓ Sent to ' + j.sent.join(', '); setTimeout(function () { location.hash = 'shipment'; location.reload(); }, 900);
      }).catch(function (x) { btn.disabled = false; note.textContent = x.message; });
  });
})();

// Forwarder documents: drop, choose or paste (⌘V) a screenshot / PDF onto the shipment — it uploads and AI reads it.
(function () {
  var forms = document.querySelectorAll('[data-fwd-drop]'); if (!forms.length) return;
  function send(form, files) {
    var input = form.querySelector('[data-fwd-file]'), dt = new DataTransfer();
    for (var i = 0; i < files.length; i++) dt.items.add(files[i]);
    input.files = dt.files;
    var z = form.querySelector('[data-fwd-zone]'); if (z) { z.classList.add('busy'); z.querySelector('span:nth-child(2)').textContent = 'Reading ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '…'; }
    if (form.requestSubmit) form.requestSubmit(); else form.submit();
  }
  function pasted(e) { var out = []; var items = (e.clipboardData && e.clipboardData.files) || []; for (var i = 0; i < items.length; i++) out.push(items[i]); return out; }
  forms.forEach(function (form) {
    var zone = form.querySelector('[data-fwd-zone]'), input = form.querySelector('[data-fwd-file]');
    form.querySelector('[data-fwd-choose]').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { if (input.files.length) send(form, input.files); });
    form.querySelector('[data-fwd-txtopen]').addEventListener('click', function () { var t = form.querySelector('[data-fwd-txt]'); t.hidden = !t.hidden; if (!t.hidden) t.querySelector('textarea').focus(); });
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function () { zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer.files.length) send(form, e.dataTransfer.files); });
    zone.addEventListener('paste', function (e) { var f = pasted(e); if (f.length) { e.preventDefault(); send(form, f); } });
  });
  // ⌘V anywhere on the page (outside fields) goes to the first drop strip when there is only one
  if (forms.length === 1) document.addEventListener('paste', function (e) {
    var t = e.target; if (t && (t.closest('input, textarea, [contenteditable]') || t.closest('[data-fwd-zone]'))) return;
    var f = pasted(e); if (!f.length) return;
    e.preventDefault(); send(forms[0], f);
  });
})();


// Customs entries (CBP 7501): add / review dialog on Logistics → Customs
(function () {
  var root = document.querySelector('[data-customs]'); if (!root) return;
  var C; try { C = JSON.parse(root.getAttribute('data-customs')); } catch (x) { return; }
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var usd = function (v, d) { return v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }); };
  var int = function (v) { return v == null ? '' : Number(v).toLocaleString('en-US'); };
  var dl = document.createElement('dialog'); dl.className = 'rp-modal cu-dlg'; dl.setAttribute('aria-labelledby', 'cu-t'); document.body.appendChild(dl);
  var S = { files: [], view: null };
  function open() { if (dl.showModal) { if (!dl.open) dl.showModal(); } else dl.setAttribute('open', ''); }
  function top(t, extra) { return '<div class="rp-top"><h2 id="cu-t">' + t + '</h2>' + (extra || '') + '<button type="button" class="icon-btn" data-cu-close aria-label="Close">×</button></div>'; }
  function busy(t) { dl.innerHTML = '<div class="lp-fd">' + top('Customs entry') + '<div class="lp-fd-busy"><span class="lp-spin"></span>' + esc(t) + '</div></div>'; }
  function input() {
    dl.innerHTML = '<div class="lp-fd">' + top('Add customs entry') +
      '<div class="lp-fd-drop" data-cu-drop tabindex="0"><b>Drop the entry summary (CBP 7501) here</b><span>PDF or a photo / screenshot (⌘V) · <button type="button" class="link small" data-cu-choose>choose a file</button></span><input type="file" multiple hidden data-cu-file accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,image/*,application/pdf"></div>' +
      '<div class="lp-fd-files">' + S.files.map(function (f, i) { return '<span class="fw-chip">📄 ' + esc(f.name) + ' <button type="button" class="lp-x" data-cu-rm="' + i + '" aria-label="Remove">×</button></span>'; }).join('') + '</div>' +
      '<div class="lp-fd-acts"><span class="sub">AI reads it, finds the shipment, POs and products, and checks the duty — nothing is saved until you choose.</span><span class="r"><button type="button" class="btn ghost" data-cu-close>Cancel</button><button type="button" class="btn" data-cu-read' + (S.files.length ? '' : ' disabled') + '>Read</button></span></div></div>';
  }
  var ICON = { bad: '⚠', warn: '⚠', ok: '✓', ai: '✦' };
  function view() {
    var v = S.view, probs = v.checks.filter(function (c) { return c.level === 'bad' || c.level === 'warn'; }).length + v.suggestions;
    var sugg = v.lines.filter(function (l) { return l.suggestion && (l.suggestion.verdict === 'suggest' || l.suggestion.verdict === 'ok'); });
    var act = function (c) {
      if (c.kind === 'declare' && v.broker) return '<button type="button" class="btn ghost small cu-act" data-cu-mail>Draft email</button>';
      if ((c.kind === 'rate' || c.kind === 'hts_prev') && c.level === 'warn' && c.product_id) return '<a class="btn ghost small cu-act" href="/admin/products/' + encodeURIComponent(c.product_id) + '#hts">Re-check product</a>';
      return '';
    };
    var alerts = v.checks.map(function (c) { return '<div class="lp-fd-a ' + c.level + '"><span>' + ICON[c.level] + '</span><span>' + (c.line ? '<b>Line ' + esc(c.line) + ':</b> ' : '') + esc(c.text) + '</span><span>' + act(c) + '</span></div>'; }).join('') +
      sugg.map(function (l) {
        var g = l.suggestion, names = (l.products || []).map(function (p) { return p.code; }).join(' & ');
        if (g.verdict === 'ok') return '<div class="lp-fd-a ok"><span>✓</span><span><b>Line ' + esc(l.no) + (names ? ', ' + esc(names) : '') + ':</b> ' + esc(l.hts) + ' fits — ' + esc(g.reason) + '</span><span></span></div>';
        var done = g.status !== 'open';
        return '<div class="lp-fd-a ai"><span>✦</span><span><b>HTS suggestion — line ' + esc(l.no) + (names ? ', ' + esc(names) : '') + ':</b> declared <span class="cu-mono">' + esc(l.hts) + '</span>, AI suggests <span class="cu-mono">' + esc(g.hts) + '</span> (' + esc(g.confidence) + ' confidence' + (g.same_duty ? ', same duty' : '') + '). ' + esc(g.reason) + ' <i>Confirm with your broker.</i>' +
          (done ? ' <b>' + (g.status === 'accepted' ? 'Saved ' + esc(g.hts) + ' on the product.' : g.status === 'kept' ? 'Kept ' + esc(l.hts) + '.' : 'Dismissed.') + '</b>' : '') + '</span>' +
          (done || !(l.products || []).some(function (p) { return p.product_id; }) ? '<span></span>' : '<span class="cu-sg"><button type="button" class="btn small" data-cu-hts="' + esc(l.no) + '" data-use="suggested">Use ' + esc(g.hts) + '</button><button type="button" class="btn ghost small" data-cu-hts="' + esc(l.no) + '" data-use="declared">Keep declared</button><button type="button" class="link small" data-cu-hts="' + esc(l.no) + '" data-use="dismiss">Dismiss</button></span>') + '</div>';
      }).join('');
    var rows = v.lines.map(function (l) {
      var prods = (l.products || []).map(function (p, pi) {
        var nm = esc(p.code) + (p.name && p.name !== p.code ? ' · ' + esc(p.name) : '');
        var diff = p.product_id && p.hts_on_file && String(p.hts_on_file).replace(/\D/g, '').slice(0, 8) !== String(l.hts || '').replace(/\D/g, '').slice(0, 8);
        var key = ' data-line="' + esc(l.no) + '" data-i="' + pi + '"';
        var box = '<span class="cu-pl" data-cu-pbox' + key + '>';
        if (p.product_id && p.how !== 'name') return box + '<span class="cu-pt ok" title="' + (p.how === 'sku' ? 'Matched by SKU' : p.how === 'manual' ? 'Linked by hand' : 'Confirmed') + '">✓ ' + nm + '</span>' + (diff ? '<span class="cu-pt w" title="The product file has a different HTS than this line declares">HTS on file ' + esc(String(p.hts_on_file).replace(/\D/g, '').replace(/^(\d{4})(\d{2})(\d{0,4}).*/, function (m, a, b, c) { return a + '.' + b + (c ? '.' + c : ''); })) + '</span>' : '') + ' <button type="button" class="link small" data-cu-pick' + key + '>Change</button></span>';
        if (p.product_id) return box + '<span class="cu-pt q" title="Suggested by name — confirm">? ' + nm + '</span> <button type="button" class="link small" data-cu-confirm' + key + '>Confirm</button> <button type="button" class="link small" data-cu-pick' + key + '>Change…</button></span>';
        return box + '<span class="cu-pt no">' + esc(p.code) + ' — no product</span> <button type="button" class="link small" data-cu-pick' + key + '>Link product…</button></span>';
      }).join('') + (l.pos || []).map(function (po) { return '<span class="cu-pt po">' + (/^PO/i.test(po) ? '' : 'PO ') + esc(po) + '</span>'; }).join('');
      var stack = '<span>' + '<span class="hts-tip" data-hts="' + esc(l.hts) + '" tabindex="0">' + esc(l.hts) + '</span>' + '<b>' + (l.rate == null ? esc(l.rate_text) : l.rate === 0 ? 'Free' : l.rate + '%') + '</b></span>' + l.extras.map(function (x) { return '<span>' + '<span class="hts-tip" data-hts="' + esc(x.code) + '" tabindex="0">' + esc(x.code) + '</span>' + (x.label ? ' · ' + esc(x.label.toLowerCase()) : '') + '<b>' + (x.rate == null ? esc(x.rate_text) : x.rate + '%') + '</b></span>'; }).join('');
      var per = (l.products || []).filter(function (p) { return p.per_pc != null; });
      return '<tr><td>' + esc(l.no) + '</td><td><b>' + esc(l.description) + '</b><div class="cu-mono">' + '<span class="hts-tip" data-hts="' + esc(l.hts) + '" tabindex="0">' + esc(l.hts) + '</span>' + (l.suggestion && l.suggestion.verdict === 'suggest' && l.suggestion.hts && l.suggestion.status === 'open' ? ' <span class="cu-sug">✦ ' + esc(l.suggestion.hts.slice(-4)) + '?</span>' : '') + '</div><div class="cu-pts">' + prods + '</div></td>' +
        '<td class="r">' + (l.qty != null ? int(l.qty) + ' ' + (l.unit === 'NO' ? 'pcs' : esc(l.unit.toLowerCase())) : '—') + (l.kg ? '<div class="sub">' + int(l.kg) + ' kg</div>' : '') + '</td>' +
        '<td class="r">' + usd(l.value, 0) + (l.value_pc ? '<div class="sub">' + usd(l.value_pc) + '/pc</div>' : '') + '</td><td><div class="cu-stack">' + stack + '</div></td>' +
        '<td class="r"><b>' + usd(l.duty) + '</b><div class="sub">' + l.rate_total + '%</div></td>' +
        '<td class="r">' + per.map(function (p) { return '<b>' + usd(p.per_pc) + '</b>' + (per.length > 1 ? ' <span class="sub">' + esc(p.code) + '</span>' : ''); }).join('<br>') + (per.length ? '<div class="sub">duty + fees' + (l.basis ? ' · split by ' + esc(l.basis) : '') + '</div>' : '') + '</td></tr>';
    }).join('');
    dl.innerHTML = '<div class="lp-fd">' + top('Entry ' + esc(v.entry_no || '') + ' · CBP 7501', v.status === 'saved' ? '<span class="cp-tag ok">Saved</span>' : probs ? '<span class="cp-tag wait">' + probs + ' to check</span>' : '<span class="cp-tag ok">All checks pass</span>') +
      '<div class="sub cu-meta">' + v.meta.map(esc).join(' · ') + '</div>' +
      '<div class="cu-links">' + (v.container ? '<span class="cu-ok">✓ ' + esc(v.container.name) + (v.container.reason ? ' — by ' + esc(v.container.reason) : '') + '</span>' : '<span class="cu-no">No container matched' + (v.hbls.length ? ' (house B/L ' + esc(v.hbls.join(', ')) + ')' : '') + '</span>') + (v.pos.length ? '<span class="cu-ok">✓ POs ' + esc(v.pos.join(', ')) + '</span>' : '') + '</div>' +
      '<div class="cu-kp"><div><span>Entered value</span><b>' + usd(v.value, 0) + '</b></div><div><span>Duty</span><b>' + usd(v.duty) + '</b><small>' + (v.rate != null ? v.rate + '% of value' : '') + '</small></div><div><span>MPF + HMF</span><b>' + usd(v.fees) + '</b><small>' + (v.mpf != null ? 'MPF ' + usd(v.mpf) + ' · HMF ' + usd(v.hmf) : '') + '</small></div><div><span>Total</span><b>' + usd(v.total) + '</b><small>' + (v.totalRate != null ? v.totalRate + '% of value' : '') + '</small></div></div>' +
      (alerts ? '<div class="lp-fd-al">' + alerts + '</div>' : '') +
      (v.broker ? '<div class="cu-ask"><span>Something here doesn\'t match? Ask the broker.</span><button type="button" class="btn ghost small" data-cu-mail>✉ Draft email to broker</button></div>' : '') +
      (v.linkSum && v.linkSum.total ? '<div class="cu-lsum ' + (v.linkSum.none || v.linkSum.toConfirm || v.linkSum.htsDiff.length ? 'w' : 'ok') + '"><b>Products:</b> ' + v.linkSum.linked + ' of ' + v.linkSum.total + ' linked' + (v.linkSum.toConfirm ? ' · ' + v.linkSum.toConfirm + ' to confirm' : '') + (v.linkSum.none ? ' · ' + v.linkSum.none + ' not found' : '') + (v.linkSum.htsDiff.length ? ' · <b>' + v.linkSum.htsDiff.length + ' HTS differ' + (v.linkSum.htsDiff.length === 1 ? 's' : '') + '</b> from the product file (' + v.linkSum.htsDiff.map(function (d) { return esc(d.code) + ': ' + esc(d.file) + ' vs ' + esc(d.declared); }).join('; ') + ')' : '') + '<span class="sub"> — each linked product gets this import on its Customs records</span></div>' : '') +
      '<div class="table-wrap"><table class="cu-lt"><thead><tr><th>Line</th><th>Goods · HTS</th><th class="r">Qty</th><th class="r">Value</th><th>Rates</th><th class="r">Duty</th><th class="r">Per pc</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="lp-fd-acts"><span class="sub">' + v.files.map(function (f) { return '<a href="' + f.url + (f.inline ? '?inline=1' : '') + '" target="_blank" rel="noopener">📄 ' + esc(f.name) + '</a>'; }).join(' ') + (v.status === 'saved' ? '' : ' · kept with the container, POs and products when saved') + '</span><span class="r">' +
        (v.status === 'saved' ? '<button type="button" class="btn" data-cu-close>Close</button>' : '<button type="button" class="link small" data-cu-discard>Discard</button><button type="button" class="btn" data-cu-save>Save entry</button>') + '</span></div></div>';
  }
  function mailView() {
    var m = S.view.broker;
    dl.innerHTML = '<div class="lp-fd">' + top('Email to the broker · entry ' + esc(S.view.entry_no || '')) +
      '<p class="sub cu-mail-n">Check the figures against the PDF first — a value the AI read wrong shows up as a mismatch too. Edit anything below, then open it in your email.</p>' +
      '<label class="cu-mail-f">To<input type="email" data-cu-m="to" value="' + esc(m.to) + '" placeholder="broker@example.com"></label>' +
      '<label class="cu-mail-f">Subject<input data-cu-m="subject" value="' + esc(m.subject) + '"></label>' +
      '<label class="cu-mail-f">Message<textarea rows="14" data-cu-m="body">' + esc(m.body) + '</textarea></label>' +
      (S.view.files.length ? '<p class="sub">Attach the 7501 in your email: ' + S.view.files.map(function (f) { return '<a href="' + f.url + '">⬇ ' + esc(f.name) + '</a>'; }).join(' ') + '</p>' : '') +
      '<div class="lp-fd-acts"><button type="button" class="link small" data-cu-back>← Back to the entry</button><span class="r"><button type="button" class="btn ghost" data-cu-copy>Copy text</button><button type="button" class="btn" data-cu-mailto>Open in email</button></span></div></div>';
  }
  function mailVals() { var o = {}; dl.querySelectorAll('[data-cu-m]').forEach(function (x) { o[x.getAttribute('data-cu-m')] = x.value; }); S.view.broker = o; return o; }
  function load(id) { busy('Opening…'); open(); fetch(C.base + '/' + encodeURIComponent(id) + '/view', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error); S.view = j.view; view(); }).catch(function (x) { dl.innerHTML = '<div class="lp-fd">' + top('Customs entry') + '<p class="lp-warn">' + esc(x.message) + '</p></div>'; }); }
  function post(url, data) { var b = new URLSearchParams(); Object.keys(data || {}).forEach(function (k) { b.append(k, data[k]); }); return fetch(url, { method: 'POST', body: b, credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error || 'Could not save'); return j; }); }
  function add(list) { for (var i = 0; i < list.length; i++) S.files.push(list[i]); input(); }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-cu-add],[data-cu-open]'); if (!b) return;
    if (b.hasAttribute('data-cu-add')) { S = { files: [], view: null }; input(); open(); } else load(b.getAttribute('data-cu-open'));
  });
  dl.addEventListener('click', function (e) {
    if (e.target === dl || e.target.closest('[data-cu-close]')) { dl.close(); if (S.changed) location.href = C.base; return; }
    var b;
    if (e.target.closest('[data-cu-choose]')) { dl.querySelector('[data-cu-file]').click(); return; }
    if ((b = e.target.closest('[data-cu-rm]'))) { S.files.splice(Number(b.getAttribute('data-cu-rm')), 1); input(); return; }
    if (e.target.closest('[data-cu-read]')) {
      var fd = new FormData(); S.files.forEach(function (f) { fd.append('file', f, f.name); });
      busy('Reading the entry, linking products and checking the HTS codes… (about 30 seconds)');
      fetch(C.base + '/read', { method: 'POST', body: fd, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error); S.view = j.view; S.changed = true; view(); }).catch(function (x) { input(); var n = dl.querySelector('.lp-fd-acts .sub'); if (n) { n.textContent = x.message; n.classList.add('cu-err'); } });
      return;
    }
    if ((b = e.target.closest('[data-cu-hts]'))) { b.disabled = true; post(C.base + '/' + S.view.id + '/hts', { line: b.getAttribute('data-cu-hts'), use: b.getAttribute('data-use') }).then(function (j) { S.view = j.view; S.changed = true; view(); }).catch(function (x) { b.disabled = false; alertMsg(x.message); }); return; }
    if ((b = e.target.closest('[data-cu-confirm]'))) { b.disabled = true; post(C.base + '/' + S.view.id + '/link', { line: b.getAttribute('data-line'), i: b.getAttribute('data-i') }).then(function (j) { S.view = j.view; S.changed = true; view(); }).catch(function (x) { alertMsg(x.message); }); return; }
    if ((b = e.target.closest('[data-cu-pick]'))) {
      var pb = b.closest('[data-cu-pbox]'), ln = b.getAttribute('data-line'), ix = b.getAttribute('data-i');
      pb.innerHTML = '<span class="cu-find"><input type="search" placeholder="SKU or product name…" data-cu-q aria-label="Find product"><span class="cu-res" data-cu-res></span></span>';
      var q = pb.querySelector('[data-cu-q]'), res = pb.querySelector('[data-cu-res]'), t = null; q.focus();
      q.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () {
        if (q.value.trim().length < 2) { res.innerHTML = ''; return; }
        fetch(C.base + '/products?q=' + encodeURIComponent(q.value.trim()), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
          res.innerHTML = (j.products || []).map(function (p) { return '<button type="button" data-cu-set="' + esc(p.id) + '" data-line="' + esc(ln) + '" data-i="' + esc(ix) + '"><b>' + esc(p.sku || '—') + '</b> ' + esc(p.name) + ' <span class="sub">' + esc(p.supplier) + '</span></button>'; }).join('') || '<span class="sub">No product found</span>';
        });
      }, 200); });
      return;
    }
    if ((b = e.target.closest('[data-cu-set]'))) { post(C.base + '/' + S.view.id + '/link', { line: b.getAttribute('data-line'), i: b.getAttribute('data-i'), product: b.getAttribute('data-cu-set') }).then(function (j) { S.view = j.view; S.changed = true; view(); }).catch(function (x) { alertMsg(x.message); }); return; }
    if (e.target.closest('[data-cu-mail]')) { mailView(); return; }
    if (e.target.closest('[data-cu-back]')) { mailVals(); view(); return; }
    if (e.target.closest('[data-cu-copy]')) { var mv = mailVals(); var txt = 'To: ' + mv.to + '\nSubject: ' + mv.subject + '\n\n' + mv.body; (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(function () { var b = e.target.closest('[data-cu-copy]'); b.textContent = 'Copied ✓'; setTimeout(function () { b.textContent = 'Copy text'; }, 1600); }, function () { window.prompt('Copy this email:', txt); }); return; }
    if (e.target.closest('[data-cu-mailto]')) { var mm = mailVals(); location.href = 'mailto:' + encodeURIComponent(mm.to).replace(/%40/g, '@').replace(/%2C/g, ',') + '?subject=' + encodeURIComponent(mm.subject) + '&body=' + encodeURIComponent(mm.body); return; }
    if (e.target.closest('[data-cu-save]')) { busy('Saving…'); post(C.base + '/' + S.view.id + '/save', {}).then(function () { location.href = C.base; }).catch(function (x) { view(); alertMsg(x.message); }); return; }
    if (e.target.closest('[data-cu-discard]')) { post(C.base + '/' + S.view.id + '/discard', {}).then(function () { location.href = C.base; }).catch(function (x) { alertMsg(x.message); }); }
  });
  function alertMsg(t) { var n = dl.querySelector('.lp-fd-acts .sub'); if (n) { n.textContent = t; n.classList.add('cu-err'); } }
  dl.addEventListener('change', function (e) { if (e.target.hasAttribute && e.target.hasAttribute('data-cu-file') && e.target.files.length) add(e.target.files); });
  dl.addEventListener('dragover', function (e) { var z = e.target.closest && e.target.closest('[data-cu-drop]'); if (z) { e.preventDefault(); z.classList.add('over'); } });
  dl.addEventListener('dragleave', function (e) { var z = e.target.closest && e.target.closest('[data-cu-drop]'); if (z) z.classList.remove('over'); });
  dl.addEventListener('drop', function (e) { var z = e.target.closest && e.target.closest('[data-cu-drop]'); if (!z) return; e.preventDefault(); if (e.dataTransfer.files.length) add(e.dataTransfer.files); });
  dl.addEventListener('paste', function (e) { if (!dl.querySelector('[data-cu-drop]')) return; var fl = e.clipboardData && e.clipboardData.files; if (fl && fl.length) { e.preventDefault(); add(fl); } });
  if (C.review) load(C.review);
})();

// Custom dropdowns (<details data-dd>): close on outside click / Escape, one open at a time
(function () {
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details[data-dd][open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('details[data-dd][open]').forEach(function (d) { d.removeAttribute('open'); var s = d.querySelector('summary'); if (s) s.focus(); });
  });
  document.addEventListener('toggle', function (e) {
    var d = e.target; if (!d.matches || !d.matches('details[data-dd]') || !d.open) return;
    document.querySelectorAll('details[data-dd][open]').forEach(function (x) { if (x !== d) x.removeAttribute('open'); });
    var b = d.querySelector('.dd-menu button:not([disabled])'); if (b) b.focus();
  }, true);
})();

// HTS hover card: any element with data-hts="code" — official USITC text + a short AI explanation (cached)
(function () {
  var card = null, timer = null, cur = null, cache = {};
  var esc = function (x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function el() { if (!card) { card = document.createElement('div'); card.className = 'hts-card'; card.setAttribute('role', 'tooltip'); card.hidden = true; document.body.appendChild(card); card.addEventListener('mouseenter', function () { clearTimeout(timer); }); card.addEventListener('mouseleave', hide); } return card; }
  function place(t) {
    var c = el(), r = t.getBoundingClientRect(), w = c.offsetWidth, h = c.offsetHeight;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
    var top = r.bottom + 6; if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    c.style.left = left + 'px'; c.style.top = top + 'px';
  }
  function render(t, v) {
    var c = el();
    c.innerHTML = v === 'load' ? '<div class="hts-c-h"><b class="cu-mono">' + esc(t.getAttribute('data-hts')) + '</b></div><div class="sub">Looking up…</div>'
      : v.error ? '<div class="hts-c-h"><b class="cu-mono">' + esc(t.getAttribute('data-hts')) + '</b></div><div class="sub">' + esc(v.error) + '</div>'
      : '<div class="hts-c-h"><b class="cu-mono">' + esc(v.code) + '</b>' + (v.general ? '<span class="hts-c-r">' + esc(v.general) + '</span>' : '') + '</div>' +
        '<div class="hts-c-t">' + esc(v.title) + '</div>' + (v.summary ? '<div class="hts-c-s">' + esc(v.summary) + '</div>' : '') +
        (v.chain && v.chain.length ? '<div class="hts-c-o">' + v.chain.map(function (x) { return '<div><span class="cu-mono">' + esc(x.code) + '</span> ' + esc(x.text) + '</div>'; }).join('') + '</div>' : '') +
        '<div class="hts-c-f">' + (v.ai ? '✦ AI summary · ' : '') + 'official text: USITC</div>';
    c.hidden = false; place(t);
  }
  function show(t) {
    var code = t.getAttribute('data-hts'); if (!code) return; cur = t;
    var host = (t.closest && t.closest('dialog[open]')) || document.body; if (el().parentNode !== host) host.appendChild(card); // a modal dialog sits in the top layer
    if (cache[code]) { render(t, cache[code]); return; }
    render(t, 'load');
    fetch('/admin/logistics/customs/hts?code=' + encodeURIComponent(code), { credentials: 'same-origin' }).then(function (r) { return r.json(); })
      .then(function (j) { cache[code] = j.ok ? j.hts : { error: j.error || 'Not found' }; if (cur === t) render(t, cache[code]); })
      .catch(function () { if (cur === t) render(t, { error: 'Could not look it up' }); });
  }
  function hide() { clearTimeout(timer); timer = setTimeout(function () { if (card) card.hidden = true; cur = null; }, 150); }
  document.addEventListener('mouseover', function (e) { var t = e.target.closest && e.target.closest('[data-hts]'); if (!t) return; clearTimeout(timer); if (cur === t) return; timer = setTimeout(function () { show(t); }, 300); });
  document.addEventListener('mouseout', function (e) { var t = e.target.closest && e.target.closest('[data-hts]'); if (t && !t.contains(e.relatedTarget)) hide(); });
  document.addEventListener('focusin', function (e) { var t = e.target.closest && e.target.closest('[data-hts]'); if (t) show(t); });
  document.addEventListener('focusout', function (e) { if (e.target.closest && e.target.closest('[data-hts]')) hide(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && card && !card.hidden) { card.hidden = true; cur = null; } });
  window.addEventListener('scroll', function () { if (card && !card.hidden) { card.hidden = true; cur = null; } }, true);
})();

// Hover cards for [data-popcard]: the card's content sits hidden inside the element; it is shown in a floating
// card on top of everything (never clipped by a scrolling table), and stays open while the pointer is on it.
(function () {
  var card = null, t = null, cur = null;
  function el() { if (!card) { card = document.createElement('div'); card.className = 'pop-card'; card.setAttribute('role', 'tooltip'); card.hidden = true; document.body.appendChild(card); card.addEventListener('mouseenter', function () { clearTimeout(t); }); card.addEventListener('mouseleave', hide); } return card; }
  function show(x) {
    var src = x.querySelector('.or-pc-card'); if (!src) return; cur = x;
    var c = el(); var host = x.closest('dialog[open]') || document.body; if (c.parentNode !== host) host.appendChild(c);
    c.className = 'pop-card' + (src.hasAttribute('data-wide') ? ' wide' : ''); c.innerHTML = src.innerHTML; c.hidden = false;
    var r = x.getBoundingClientRect(), w = c.offsetWidth, h = c.offsetHeight;
    c.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + 'px';
    var top = r.bottom + 6; if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6); c.style.top = top + 'px';
  }
  function hide() { clearTimeout(t); t = setTimeout(function () { if (card) card.hidden = true; cur = null; }, 160); }
  document.addEventListener('mouseover', function (e) { var x = e.target.closest && e.target.closest('[data-popcard]'); if (!x || x === cur) { if (x) clearTimeout(t); return; } clearTimeout(t); t = setTimeout(function () { show(x); }, 200); });
  document.addEventListener('mouseout', function (e) { var x = e.target.closest && e.target.closest('[data-popcard]'); if (x && !x.contains(e.relatedTarget) && !(card && card.contains(e.relatedTarget))) hide(); });
  document.addEventListener('focusin', function (e) { var x = e.target.closest && e.target.closest('[data-popcard]'); if (x) show(x); });
  document.addEventListener('focusout', function (e) { if (e.target.closest && e.target.closest('[data-popcard]') && !(card && card.contains(e.relatedTarget))) hide(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && card && !card.hidden) { card.hidden = true; cur = null; } });
  window.addEventListener('scroll', function () { if (card && !card.hidden) { card.hidden = true; cur = null; } }, true);
})();

// Payments: "Mark paid…" fills the shared dialog with this installment
(function () {
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-pm-id]'); if (!b) return;
    var d = document.getElementById('pm-paid'); if (!d) return; var f = d.querySelector('[data-pm-form]');
    f.action = '/admin/orders/payments/' + b.getAttribute('data-pm-id') + '/paid';
    f.querySelector('[data-pm-amount]').value = b.getAttribute('data-pm-amount') || '';
    f.querySelector('[data-pm-back]').value = b.getAttribute('data-pm-back') || location.pathname + location.search;
    d.querySelector('[data-pm-what]').textContent = b.getAttribute('data-pm-what') || '';
  }, true);
})();

// Bank details: the full account number is fetched (and logged) only when "show" is pressed.
(function () {
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-reveal]'); if (!b || !window.fetch) return;
    var out = document.getElementById(b.getAttribute('data-reveal-to')); if (!out) return;
    if (b.getAttribute('data-shown')) { out.textContent = b.getAttribute('data-masked'); b.removeAttribute('data-shown'); b.textContent = 'show'; return; }
    b.disabled = true;
    fetch(b.getAttribute('data-reveal'), { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (j) {
      b.disabled = false; if (!j || !j.account) return;
      b.setAttribute('data-masked', out.textContent); out.textContent = j.account; b.setAttribute('data-shown', '1'); b.textContent = 'hide';
    }).catch(function () { b.disabled = false; });
  });
})();

// Two-step delete: × arms the row ([data-armbox]) and shows the confirm button; a click elsewhere or Esc disarms.
(function () {
  var armed = null;
  var off = function () { if (armed) { armed.classList.remove('arm'); armed = null; } };
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-arm]');
    if (b) { e.preventDefault(); var box = b.closest('[data-armbox]'); if (armed && armed !== box) off(); if (box) { box.classList.add('arm'); armed = box; var y = box.querySelector('.bd-yes'); if (y) y.focus(); } return; }
    if (armed && !(e.target.closest && e.target.closest('.bd-yes'))) off();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') off(); });
})();

// Hover preview of a document ([data-hoverprev] = inline URL): a small floating window after a short pause.
(function () {
  if (window.matchMedia && !window.matchMedia('(hover: hover)').matches) return;
  var card = null, t = null, cur = null;
  var hide = function () { clearTimeout(t); cur = null; if (card) { card.hidden = true; card.innerHTML = ''; } };
  document.addEventListener('mouseover', function (e) {
    var a = e.target.closest && e.target.closest('[data-hoverprev]');
    if (!a || a === cur) return;
    hide(); cur = a;
    t = setTimeout(function () {
      if (!card) { card = document.createElement('div'); card.className = 'hp-card'; card.hidden = true; document.body.appendChild(card); }
      var host = a.closest('dialog[open]') || document.body; if (card.parentNode !== host) host.appendChild(card);
      var url = a.getAttribute('data-hoverprev');
      card.innerHTML = '';
      if (a.getAttribute('data-type') === 'image') { var im = document.createElement('img'); im.src = url; im.alt = ''; card.appendChild(im); }
      else { var fr = document.createElement('iframe'); fr.src = url + '#toolbar=0&navpanes=0&view=FitH'; fr.title = 'Preview'; fr.setAttribute('tabindex', '-1'); card.appendChild(fr); }
      var r = (a.closest('[data-hp-host]') || a).getBoundingClientRect(), ra = a.getBoundingClientRect(), w = 340, h = 440;
      var left = r.left - w - 12 >= 8 ? r.left - w - 12 : Math.min(window.innerWidth - w - 8, r.right + 12);
      var top = Math.max(8, Math.min(window.innerHeight - h - 8, ra.top + ra.height / 2 - h / 2));
      card.style.left = left + 'px'; card.style.top = top + 'px'; card.hidden = false;
    }, 350);
  });
  document.addEventListener('mouseout', function (e) {
    var a = e.target.closest && e.target.closest('[data-hoverprev]');
    if (a && (!e.relatedTarget || !a.contains(e.relatedTarget))) hide();
  });
  document.addEventListener('click', hide); window.addEventListener('scroll', hide, true);
})();

// A clickable chip whose file can't be previewed: [data-href] downloads it.
(function () {
  document.addEventListener('click', function (e) {
    var x = e.target.closest && e.target.closest('[data-href]'); if (!x || e.defaultPrevented) return;
    if (e.target.closest('a,button') && e.target.closest('a,button') !== x) return;
    location.href = x.getAttribute('data-href');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return; var x = e.target.closest && e.target.closest('.dx-chip[data-popcard]'); if (!x) return;
    e.preventDefault(); x.click();
  });
})();

// Live search: input[data-live-q="<row selector>"] hides rows that don't contain the text as you type; Enter still
// searches on the server (and across tabs). "PO900018" and "900018" both match.
(function () {
  var inputs = document.querySelectorAll('input[data-live-q]');
  Array.prototype.forEach.call(inputs, function (inp) {
    var norm = function (s) { return String(s || '').toLowerCase().replace(/\s+/g, ' '); };
    var run = function () {
      var q = norm(inp.value).trim().replace(/^po\s*#?\s*(?=\d)/, '');
      var rows = document.querySelectorAll(inp.getAttribute('data-live-q')), shown = 0;
      Array.prototype.forEach.call(rows, function (r) { var ok = !q || norm(r.textContent).indexOf(q) >= 0; r.hidden = !ok; if (ok) shown++; });
      var empty = document.getElementById(inp.getAttribute('data-live-empty') || ''); if (empty) empty.hidden = !(q && rows.length && !shown);
    };
    var t = null;
    inp.addEventListener('input', function () { clearTimeout(t); t = setTimeout(run, 120); });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && inp.form) { e.preventDefault(); if (inp.form.requestSubmit) inp.form.requestSubmit(); else inp.form.submit(); } });
    inp.addEventListener('search', function () { if (!inp.value && inp.form && /[?&]q=/.test(location.search)) inp.form.submit(); else run(); });   // the × clears
  });
})();

// Add a document (shipment page): PO tick-pills (one supplier per file), type pills, AI read of the file that
// suggests the POs and checks the quantities against the plan.
(function () {
  var form = document.querySelector('form[data-adddoc]'); if (!form) return;
  var boxes = Array.prototype.slice.call(form.querySelectorAll('input[name=pos]'));
  var input = form.querySelector('input[type=file]'), list = form.querySelector('[data-list]');
  var ai = form.querySelector('[data-ai]'), sum = form.querySelector('[data-sum]'), btn = form.querySelector('[data-addbtn]');
  var touched = false, seq = 0;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var fmt = function (n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); };
  var KN = { '': 'detected type', Invoice: 'commercial invoice', 'Packing list': 'packing list', CIPL: 'CI + PL', 'Bill of lading': 'bill of lading', 'Arrival notice': 'arrival notice', 'Warehouse receipt': 'warehouse receipt', 'Loading photos': 'photos', Other: 'document' };
  var kind = function () { var k = form.querySelector('input[name=kind]:checked'); return k ? k.value : ''; };
  // a bill of lading can cover the whole container (several suppliers); everything else is from one seller
  var WHOLE = { 'Bill of lading': 1, 'Arrival notice': 1 }, whole = function () { return !!WHOLE[kind()]; };
  var allBtn = form.querySelector('[data-allpos]'), suggest = [];
  var sync = function () {
    var on = boxes.filter(function (b) { return b.checked; });
    if (!whole()) {   // one seller: keep the first supplier's ticks
      var first = on.length ? on[0].getAttribute('data-sid') : null;
      on.forEach(function (b) { if (b.getAttribute('data-sid') !== first) b.checked = false; });
      on = boxes.filter(function (b) { return b.checked; });
    }
    var sid = on.length ? on[0].getAttribute('data-sid') : null;
    Array.prototype.forEach.call(form.querySelectorAll('.ad-sup'), function (g) { var other = !whole() && sid && g.getAttribute('data-sup') !== sid; g.classList.toggle('dim', !!other); Array.prototype.forEach.call(g.querySelectorAll('input[name=pos]'), function (b) { b.disabled = !!other; }); });
    if (allBtn) allBtn.hidden = !whole();
    var n = input.files ? input.files.length : 0, pos = on.map(function (b) { return b.getAttribute('data-po'); });
    var nSup = {}; on.forEach(function (b) { nSup[b.getAttribute('data-sid')] = 1; }); nSup = Object.keys(nSup).length;
    btn.disabled = !(on.length && n);
    btn.textContent = on.length > 1 ? 'Add to ' + on.length + ' POs' : 'Add';
    // the AI found other POs than the ones ticked → say so before saving
    var miss = suggest.filter(function (x) { return !on.some(function (b) { return b.getAttribute('data-sid') === x.sid && b.getAttribute('data-po') === x.po; }); }).map(function (x) { return x.po; });
    var warn = suggest.length && on.length && miss.length ? '<span class="ad-mis">⚠ AI found PO ' + esc(miss.join(', ')) + ' in this file, which is not ticked — check the POs before adding.</span>' : '';
    sum.innerHTML = !on.length ? 'Tick the PO(s) this file is for.' : !n ? 'Now drop the file.'
      : 'Will add <b>' + (n === 1 ? esc(input.files[0].name) : n + ' files') + '</b> as <b>' + esc(KN[kind()] || 'document') + '</b> to <b>PO ' + esc(pos.join(', ')) + '</b>' + (nSup > 1 ? ' of ' + nSup + ' suppliers' : '') + (on.length > 1 ? ' — one file, linked to all' : '') + '.' + warn;
  };
  if (allBtn) allBtn.addEventListener('click', function () { touched = true; boxes.forEach(function (b) { b.checked = true; }); sync(); });
  boxes.forEach(function (b) { b.addEventListener('change', function () { touched = true; sync(); }); });
  Array.prototype.forEach.call(form.querySelectorAll('[data-allsup]'), function (a) {
    a.addEventListener('click', function () { var sid = a.getAttribute('data-allsup'); touched = true; boxes.forEach(function (b) { b.checked = b.getAttribute('data-sid') === sid; }); sync(); });
  });
  Array.prototype.forEach.call(form.querySelectorAll('input[name=kind]'), function (r) { r.addEventListener('change', sync); });
  var scan = function () {
    var n = input.files ? input.files.length : 0; sync();
    if (!n) { ai.hidden = true; return; }
    suggest = [];
    var my = ++seq, fd = new FormData(); Array.prototype.forEach.call(input.files, function (f) { fd.append('file', f, f.name); });
    ai.hidden = false; ai.className = 'ad-ai busy'; ai.innerHTML = '<span class="ad-spin"></span> Reading the file…';
    fetch(form.getAttribute('data-adddoc'), { method: 'POST', body: fd, credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); }).then(function (j) {
        if (my !== seq) return;
        if (j.kind && !kind()) { var k = form.querySelector('input[name=kind][value="' + j.kind + '"]'); if (k) k.checked = true; }
        boxes.forEach(function (b) { var s = b.parentNode.querySelector('.ad-sug'); if (s) s.hidden = true; });
        (j.suggest || []).forEach(function (s) { boxes.forEach(function (b) { if (b.getAttribute('data-sid') === s.sid && b.getAttribute('data-po') === s.po) { var m = b.parentNode.querySelector('.ad-sug'); if (m) m.hidden = false; } }); });
        suggest = j.suggest || [];
        if (!touched && suggest.length) { var sid = suggest[0].sid; boxes.forEach(function (b) { b.checked = (whole() || b.getAttribute('data-sid') === sid) && suggest.some(function (s) { return s.sid === b.getAttribute('data-sid') && s.po === b.getAttribute('data-po'); }); }); }
        if (!j.ai) { ai.className = 'ad-ai'; ai.innerHTML = j.error ? esc(j.error) + ' — choose the PO(s) and type yourself.' : 'Type set from the file name' + (j.kind ? ': <b>' + esc(KN[j.kind] || j.kind) + '</b>' : '') + '.'; sync(); return; }
        var rows = (j.checks || []).map(function (c) {
          var ok = c.diff != null && Math.abs(c.diff) <= 2, cls = c.diff == null ? '' : ok ? 'ok' : 'bad';
          return '<tr><td><b>' + esc(c.po) + '</b> ' + esc(c.product) + '</td><td class="r">' + fmt(c.planned) + '</td><td class="r">' + fmt(c.actual) + '</td><td class="r ' + cls + '">' + (c.diff == null ? '—' : ok ? '✓' : (c.diff > 0 ? '+' : '') + c.diff + '%') + '</td></tr>';
        }).join('');
        var bad = (j.checks || []).filter(function (c) { return c.diff != null && Math.abs(c.diff) > 2; }).length;
        ai.className = 'ad-ai ' + (bad || (j.extra || []).length ? 'warn' : 'good');
        ai.innerHTML = '<div class="ad-ah"><b>AI check</b> ' + (j.suggest && j.suggest.length ? 'found PO ' + esc(j.suggest.map(function (s) { return s.po; }).join(', ')) : 'couldn\'t match a PO — tick it yourself') + (j.invoice_no ? ' · invoice ' + esc(j.invoice_no) : '') + '</div>'
          + (rows ? '<table class="ad-t"><thead><tr><th>Line</th><th class="r">Planned</th><th class="r">In file</th><th class="r"></th></tr></thead><tbody>' + rows + '</tbody></table>' : '')
          + (bad ? '<p class="ad-n">' + bad + ' line' + (bad > 1 ? 's differ' : ' differs') + ' from the plan — check before adding; the figures can be accepted later from the shipping-documents card.</p>' : rows ? '<p class="ad-n">Quantities match the plan.</p>' : '')
          + ((j.extra || []).length ? '<p class="ad-n">Not in this container: ' + esc(j.extra.map(function (x) { return (x.po ? 'PO ' + x.po + ' · ' : '') + (x.product || '') + (x.qty != null ? ' (' + fmt(x.qty) + ' pcs)' : ''); }).join('; ')) + '</p>' : '');
        sync();
      }).catch(function () { if (my === seq) { ai.className = 'ad-ai'; ai.innerHTML = 'Couldn\'t read the file — choose the PO(s) and type yourself.'; } });
  };
  var t = null; var later = function () { clearTimeout(t); t = setTimeout(scan, 250); };
  if (list && window.MutationObserver) new MutationObserver(later).observe(list, { childList: true });
  input.addEventListener('change', later);
  sync();
})();

// HTS classification (product → Customs records): open the popup after a run, label the save button with the
// chosen code (weak fits warn), and the broker email (opens the mail app; nothing is sent from the portal).
(function () {
  var dlg = document.getElementById('hts-dlg');
  if (dlg) {
    var go = dlg.querySelector('.hc-go');
    var label = function () {
      var r = dlg.querySelector('input[name="code"]:checked'); if (!go || !r) return;
      var t = r.closest('tr').querySelector('.cu-mono').textContent.trim();
      go.textContent = 'Save ' + t + ' as code to declare'; go.classList.toggle('warn', r.hasAttribute('data-weak'));
    };
    dlg.addEventListener('change', function (e) { if (e.target.name === 'code') label(); }); label();
    if (dlg.hasAttribute('data-autoopen') && dlg.showModal) { try { dlg.showModal(); } catch (e) { /* ignore */ } }
  }
  // email drafts (HTS broker email, freight "ask for missing charges"): open in the mail app or copy
  document.querySelectorAll('#hts-mail, dialog[data-mail]').forEach(function (m) {
    var val = function (k) { var x = m.querySelector('[data-hm="' + k + '"]'); return x ? x.value : ''; };
    m.addEventListener('click', function (e) {
      if (e.target.closest('[data-hm-open]')) location.href = 'mailto:' + encodeURIComponent(val('to')) + '?subject=' + encodeURIComponent(val('subject')) + '&body=' + encodeURIComponent(val('body'));
      var c = e.target.closest('[data-hm-copy]');
      if (c && navigator.clipboard) navigator.clipboard.writeText('Subject: ' + val('subject') + '\n\n' + val('body')).then(function () { c.textContent = 'Copied ✓'; setTimeout(function () { c.textContent = 'Copy'; }, 1500); });
    });
  });
})();

// Custom value dropdown (<details data-ddsel>): a menu button sets the hidden input and the label.
(function () {
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('details[data-ddsel] .dd-menu button[data-v]'); if (!b) return;
    var d = b.closest('details[data-ddsel]'), inp = d.querySelector('input[type="hidden"]'), lab = d.querySelector('[data-ddsel-label]');
    inp.value = b.getAttribute('data-v'); if (lab) lab.textContent = b.textContent;
    d.querySelectorAll('.dd-menu button').forEach(function (x) { x.classList.toggle('on', x === b); });
    d.removeAttribute('open'); inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
})();

// Freight charge names: explanation on hover / focus (a saved note; first time without one, AI writes it and it is saved).
(function () {
  var tips = document.querySelectorAll('[data-fc-tip]'); if (!tips.length) return;
  var pop = document.createElement('div'); pop.className = 'fc-pop'; pop.setAttribute('role', 'tooltip'); pop.hidden = true; document.body.appendChild(pop);
  var cur = null, hideT = null;
  var place = function (el) { var r = el.getBoundingClientRect(); pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) + 'px'; var below = r.bottom + 6; pop.style.top = (below + pop.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - pop.offsetHeight - 6) : below) + 'px'; };
  var show = function (el) {
    clearTimeout(hideT); cur = el;
    var box = el.querySelector('.fc-tip-box'); pop.innerHTML = box.innerHTML; pop.hidden = false; place(el);
    if (el.hasAttribute('data-fc-fetch') && !el.dataset.loading) {
      el.dataset.loading = '1';
      var t = pop.querySelector('.fc-tip-t'); if (t) t.textContent = 'Getting a short explanation…';
      fetch('/admin/logistics/freight/charges/' + encodeURIComponent(el.getAttribute('data-fc-tip')) + '/explain', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          document.querySelectorAll('[data-fc-tip="' + el.getAttribute('data-fc-tip') + '"]').forEach(function (x) { var bt = x.querySelector('.fc-tip-t'); if (bt) bt.textContent = d.note || ''; if (d.saved) x.removeAttribute('data-fc-fetch'); });
          if (cur === el) { var pt = pop.querySelector('.fc-tip-t'); if (pt) pt.textContent = d.note || ''; place(el); }
        })
        .catch(function () { var pt = pop.querySelector('.fc-tip-t'); if (pt) pt.textContent = 'Could not load the explanation.'; })
        .then(function () { delete el.dataset.loading; });
    }
  };
  var hide = function () { hideT = setTimeout(function () { pop.hidden = true; cur = null; }, 120); };
  tips.forEach(function (el) {
    el.addEventListener('mouseenter', function () { show(el); }); el.addEventListener('mouseleave', hide);
    el.addEventListener('focus', function () { show(el); }); el.addEventListener('blur', hide);
  });
  pop.addEventListener('mouseenter', function () { clearTimeout(hideT); }); pop.addEventListener('mouseleave', hide);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { pop.hidden = true; cur = null; } });
  window.addEventListener('scroll', function () { if (cur && !pop.hidden) place(cur); }, true);
})();

// Textareas that grow with their text (<textarea data-grow>), so short fields stay compact.
(function () {
  var fit = function (t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 420) + 'px'; };
  document.querySelectorAll('textarea[data-grow]').forEach(fit);
  document.addEventListener('input', function (e) { if (e.target.matches && e.target.matches('textarea[data-grow]')) fit(e.target); });
})();

// New development project: AI writes the supplier description from the reference files, name and notes; live "Supplier sees" preview.
(function () {
  var form = document.querySelector('form[data-np]'); if (!form) return;
  var btn = form.querySelector('[data-np-ai]'), sum = form.querySelector('textarea[name="summary"]'), meta = form.querySelector('[data-np-meta]'), out = form.querySelector('[data-np-out]');
  var nameI = form.querySelector('input[name="name"]'), catI = form.querySelector('input[name="category_id"]'), fileI = form.querySelector('input[name="files"]');
  var prev = document.querySelector('[data-np-prev]'), caterr = form.querySelector('[data-np-caterr]'), busy = false;
  var esc = function (x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var grow = function (t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 420) + 'px'; };
  var sugg = function (k, on) { var el = form.querySelector('[data-np-sugg="' + k + '"]'); if (el) el.hidden = !on; };
  function preview() {
    if (!prev) return; var d = sum.value.trim();
    prev.hidden = !d && !nameI.value.trim();
    prev.querySelector('[data-np-pname]').textContent = nameI.value.trim() || 'Product name';
    prev.querySelector('[data-np-pdesc]').textContent = d.length > 220 ? d.slice(0, 220) + '…' : d;
    var n = fileI && fileI.files ? fileI.files.length : 0, c = catI && catI.value;
    prev.querySelector('[data-np-pfiles]').textContent = [n ? '+ ' + n + ' reference file' + (n > 1 ? 's' : '') : '', c ? 'factory checklist Excel' : ''].filter(Boolean).join(' · ');
  }
  ['input', 'change'].forEach(function (ev) { form.addEventListener(ev, function (e) { if (e.target === nameI) sugg('name', false); preview(); }); });
  form.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('details[data-ddsel] .dd-menu button[data-v]');
    if (b && b.closest('form') === form) { sugg('category', false); if (caterr) caterr.hidden = true; setTimeout(preview, 0); }
  });
  form.addEventListener('submit', function (e) {
    if (catI && !catI.value) { e.preventDefault(); if (caterr) caterr.hidden = false; var s = form.querySelector('details[data-ddsel] summary'); if (s) s.focus(); return; }
    var c = form.querySelector('[data-np-create]'); if (c) { c.textContent = 'Creating…'; setTimeout(function () { c.disabled = true; }, 0); }
  });
  if (!btn) return;
  btn.addEventListener('click', function () {
    if (busy) return;
    if (!(fileI && fileI.files.length) && !nameI.value.trim() && !form.querySelector('textarea[name="notes"]').value.trim()) { meta.hidden = false; meta.innerHTML = '<span class="bad">Drop a file, or write a name or a few notes first.</span>'; return; }
    busy = true; btn.disabled = true; var label = btn.textContent; btn.textContent = 'Writing…'; out.classList.add('busy');
    meta.hidden = false; meta.innerHTML = '<span>Reading ' + (fileI.files.length ? fileI.files.length + ' file' + (fileI.files.length > 1 ? 's' : '') + ' and ' : '') + 'your notes…</span>';
    var fd = new FormData(); fd.append('name', nameI.value); fd.append('category_id', catI ? catI.value : ''); fd.append('notes', form.querySelector('textarea[name="notes"]').value);
    Array.prototype.forEach.call(fileI.files, function (f) { fd.append('files', f, f.name); });
    fetch('/admin/projects/describe', { method: 'POST', body: fd, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'AI could not write it');
      sum.value = j.description; grow(sum); out.classList.add('ai');
      if (j.name && !nameI.value.trim()) { nameI.value = j.name; sugg('name', true); }
      if (j.category_id && catI && !catI.value) { var cb = form.querySelector('details[data-ddsel] .dd-menu button[data-v="' + j.category_id + '"]'); if (cb) { cb.click(); var d = cb.closest('details'); if (d) d.open = false; sugg('category', true); } }
      var words = j.description.split(/\s+/).filter(Boolean).length, chips = [];
      if (j.read && j.read.length) chips.push('Read ' + j.read.length + ' file' + (j.read.length > 1 ? 's' : ''));
      chips.push(words + ' words'); chips.push('No prices');
      meta.innerHTML = chips.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') +
        (j.skipped && j.skipped.length ? '<span class="sub">Not read: ' + esc(j.skipped.join(', ')) + '</span>' : '') +
        (j.missing && j.missing.length ? '<div class="np-miss">Factories will likely ask: ' + esc(j.missing.join(' · ')) + '</div>' : '');
      btn.textContent = '↻ Rewrite'; label = btn.textContent; preview();
    }).catch(function (e) { meta.innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; }).then(function () { busy = false; btn.disabled = false; btn.textContent = label; out.classList.remove('busy'); });
  });
})();

// Notes tab (internal team chat): drop or paste files anywhere on the chat, chips with remove, ⌘↩ posts, search, edit own note.
(function () {
  var nc = document.querySelector('[data-nc]'); if (!nc) return;
  var form = nc.querySelector('[data-nc-form]'), input = nc.querySelector('[data-nc-file]'), chips = nc.querySelector('[data-nc-chips]'), note = nc.querySelector('[data-nc-note]');
  var ta = nc.querySelector('[data-nc-text-in]'), drop = nc.querySelector('[data-nc-drop]'), scroll = nc.querySelector('[data-nc-scroll]');
  var dt = window.DataTransfer ? new DataTransfer() : null, MAXB = 20 * 1024 * 1024;
  var esc = function (x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var size = function (n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
  var stamp = function () { var d = new Date(), q = function (n) { return ('0' + n).slice(-2); }; return d.getFullYear() + q(d.getMonth() + 1) + q(d.getDate()) + '-' + q(d.getHours()) + q(d.getMinutes()) + q(d.getSeconds()); };
  function render() {
    chips.innerHTML = Array.prototype.map.call(dt.files, function (f, i) { return '<li><span>' + (/^image\//.test(f.type) ? '🖼' : '📄') + ' ' + esc(f.name) + ' <small>' + size(f.size) + '</small></span><button type="button" data-i="' + i + '" aria-label="Remove">×</button></li>'; }).join('');
    input.files = dt.files;
  }
  function add(files) {
    if (!dt) return; var skipped = [];
    Array.prototype.forEach.call(files, function (f) {
      if (/^image\/(png|jpeg)$/.test(f.type) && /^image\.(png|jpe?g)$/i.test(f.name)) f = new File([f], 'pasted-image-' + stamp() + (f.type === 'image/png' ? '.png' : '.jpg'), { type: f.type });
      if (f.size > MAXB) { skipped.push(f.name + ' (over 20 MB)'); return; }
      if (dt.files.length >= 12) { skipped.push(f.name + ' (max 12 files)'); return; }
      dt.items.add(f);
    });
    note.textContent = skipped.length ? 'Skipped: ' + skipped.join(', ') : ''; render(); ta.focus();
  }
  chips.addEventListener('click', function (e) { var b = e.target.closest('button[data-i]'); if (!b) return; var n = new DataTransfer(), k = +b.getAttribute('data-i'); Array.prototype.forEach.call(dt.files, function (f, i) { if (i !== k) n.items.add(f); }); dt = n; render(); });
  nc.querySelector('[data-nc-attach]').addEventListener('click', function () { var pick = document.createElement('input'); pick.type = 'file'; pick.multiple = true; pick.accept = input.accept; pick.addEventListener('change', function () { add(pick.files); }); pick.click(); });
  var hasFiles = function (e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0; };
  var depth = 0;
  nc.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; drop.hidden = false; });
  nc.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  nc.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) drop.hidden = true; });
  nc.addEventListener('drop', function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); depth = 0; drop.hidden = true; add(e.dataTransfer.files); });
  document.addEventListener('paste', function (e) { var cd = e.clipboardData; if (!cd || !cd.files || !cd.files.length) return; if (e.target.closest && e.target.closest('[data-nc-editform]')) return; e.preventDefault(); add(cd.files); });
  ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (form.requestSubmit) form.requestSubmit(); else form.submit(); } });
  ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 260) + 'px'; });
  form.addEventListener('submit', function (e) {
    if (!ta.value.trim() && !(dt && dt.files.length)) { e.preventDefault(); note.textContent = 'Write a note or attach a file.'; return; }
    input.files = dt ? dt.files : input.files; var b = form.querySelector('[data-nc-post]'); b.textContent = 'Posting…'; setTimeout(function () { b.disabled = true; }, 0);
  });
  // search
  var q = nc.querySelector('[data-nc-q]');
  if (q) q.addEventListener('input', function () {
    var v = q.value.trim().toLowerCase(), shown = 0;
    nc.querySelectorAll('.nc-m').forEach(function (m) { var ok = !v || m.getAttribute('data-nc-text').indexOf(v) >= 0; m.hidden = !ok; if (ok) shown++; });
    nc.querySelectorAll('.nc-day').forEach(function (d) { d.hidden = !!v; });
    nc.querySelector('[data-nc-none]').hidden = !(v && !shown);
  });
  // edit own note
  nc.addEventListener('click', function (e) {
    var eb = e.target.closest('[data-nc-editbtn]'), cb = e.target.closest('[data-nc-cancel]');
    if (eb || cb) { var m = (eb || cb).closest('.nc-m'), f = m.querySelector('[data-nc-editform]'), body = m.querySelector('.nc-body'); f.hidden = !!cb; if (body) body.hidden = !cb; if (eb) f.querySelector('textarea').focus(); }
  });
  // open at the latest note, or the one in the address
  var target = location.hash && /^#n-/.test(location.hash) ? document.querySelector(location.hash) : null;
  if (target) { target.scrollIntoView({ block: 'center' }); target.classList.add('flash-hl'); } else if (scroll) scroll.scrollTop = scroll.scrollHeight;
})();

// Request inspection: "Send request…" opens the exact email in a dialog; To, Cc and the message are edited there (live preview); "Send now" submits the form.
(function () {
  var form = document.querySelector('form[data-in-form]'), dlg = document.querySelector('[data-in-dlg]'); if (!form || !dlg) return;
  var btn = form.querySelector('[data-in-review]'), q = function (k) { return dlg.querySelector('[data-d="' + k + '"]'); }, send = dlg.querySelector('[data-in-send]');
  var esc = function (x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var seq = 0, timer = null;
  function refresh(open) {
    var fd = new FormData(form), file = form.querySelector('input[name="req_file"]'), my = ++seq;
    fd.delete('req_file'); if (file && file.files) Array.prototype.forEach.call(file.files, function (x) { fd.append('req_name', x.name); });
    if (!open) q('state').textContent = 'Updating…';
    return fetch(form.getAttribute('action').replace(/\/new$/, '/draft'), { method: 'POST', body: fd, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      if (my !== seq) return; var err = q('err');
      if (!j.ok) { err.textContent = j.error; err.hidden = false; q('subject').textContent = ''; q('att').textContent = ''; q('frame').srcdoc = ''; send.disabled = true; }
      else {
        err.hidden = !j.warn; err.textContent = j.warn || ''; send.disabled = !j.to.length;
        var to = dlg.querySelector('input[name="to"]'); to.placeholder = j.to.join(', ') || "the company's booking email";
        q('subject').textContent = j.subject;
        q('att').innerHTML = j.attachments.map(function (a) { return '<span class="in-dlg-a">📎 ' + esc(a) + '</span>'; }).join('');
        q('frame').srcdoc = j.html;
      }
      q('state').textContent = 'Changes update the preview.';
    });
  }
  btn.addEventListener('click', function () {
    if (form.reportValidity && !form.reportValidity()) return;
    var label = btn.textContent; btn.disabled = true; btn.textContent = 'Preparing…';
    refresh(true).then(function () { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); })
      .catch(function () { alert('Could not prepare the email. Try again.'); }).then(function () { btn.disabled = false; btn.textContent = label; });
  });
  dlg.addEventListener('input', function (e) { if (!e.target.hasAttribute('data-in-live')) return; clearTimeout(timer); timer = setTimeout(function () { refresh(false).catch(function () {}); }, 600); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  send.addEventListener('click', function () { setTimeout(function () { send.disabled = true; send.textContent = 'Sending…'; }, 0); });
})();


// PO hover card on Request inspection: click a SKU to copy it (doesn't tick the PO).
(function () {
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.in-sku[data-copy]'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var v = b.getAttribute('data-copy'), label = b.textContent;
    var done = function () { b.classList.add('copied'); b.textContent = 'Copied ✓'; setTimeout(function () { b.classList.remove('copied'); b.textContent = label; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, function () { fallback(); });
    else fallback();
    function fallback() { var t = document.createElement('textarea'); t.value = v; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (x) { /* ignore */ } t.remove(); }
  }, true);
})();

// Requests · "Send to more": filter the supplier list
(function () {
  document.querySelectorAll('[data-rq-filter]').forEach(function (inp) {
    inp.addEventListener('input', function () {
      var q = inp.value.trim().toLowerCase();
      inp.closest('form').querySelectorAll('[data-rq-name]').forEach(function (l) { l.hidden = !!q && l.getAttribute('data-rq-name').indexOf(q) < 0; });
    });
  });
})();

// Print buttons (customs draft → Print / PDF)
(function () { document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-print]'); if (b) { e.preventDefault(); window.print(); } }); })();
