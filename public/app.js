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
})();
