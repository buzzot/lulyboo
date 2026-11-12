/* Container planning · port map. Data from <script data-pm-data>, coast outlines from china-coast.js.
   Ports show how full their next shipment is; suppliers are dots joined to the port they ship from.
   Drag a supplier onto another port (or use the panel / an idea) to move its order lines there. */
(function () {
  'use strict';
  var root = document.querySelector('[data-pm]'); if (!root || !window.LB_CHINA) return;
  var D = JSON.parse(root.querySelector('[data-pm-data]').textContent);
  var G = window.LB_CHINA, NS = 'http://www.w3.org/2000/svg';
  var PORTS = D.ports, LOTS = D.lots, CAP = D.caps, RATE = D.rates;
  var codes = Object.keys(PORTS);
  var sel = codes.filter(function (k) { return LOTS.some(function (l) { return l.port === k; }); })[0] || codes[0];
  var hoverIdea = null, lastIdeas = [], drag = null;

  // ── helpers ──
  function pj(ll) { var r = Math.PI / 180; return [G.TX + G.S * ll[0] * r, G.TY - G.S * Math.log(Math.tan(Math.PI / 4 + ll[1] * r / 2))]; }
  function el(t, a, p) { var e = document.createElementNS(NS, t); for (var k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function m3(n) { return (Math.round(n * 10) / 10).toLocaleString('en-US') + ' m³'; }
  function km(a, b) { var R = 6371, r = Math.PI / 180, dl = (b[1] - a[1]) * r, dn = (b[0] - a[0]) * r, x = Math.sin(dl / 2) * Math.sin(dl / 2) + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dn / 2) * Math.sin(dn / 2); return 2 * R * Math.asin(Math.sqrt(x)) * 1.3; }
  LOTS.forEach(function (l) { if (l.ll) l.xy = pj(l.ll); });
  codes.forEach(function (k) { PORTS[k].xy = pj(PORTS[k].ll); });
  function vol(port) { return LOTS.reduce(function (a, l) { return a + (l.port === port ? l.cbm : 0); }, 0); }
  function lclCost(r) { return Math.max(RATE.lcl.min || 0, r * RATE.lcl.perCbm) + (RATE.lcl.fees || 0); }
  /** Cheapest mix of containers (+ LCL for a small rest) for a volume. */
  function pack(v) {
    if (v <= 0.01) return { cost: 0, mix: [], cap: 0, lcl: 0 };
    var best = null;
    for (var k = 0; k <= Math.ceil(v / CAP['40HQ']); k++) {
      var r = v - k * CAP['40HQ'], opts = [];
      if (r <= 0.001) opts.push({ c: 0, m: [], cap: 0, lcl: 0 });
      else {
        ['20GP', '40GP', '40HQ'].forEach(function (b) { if (r <= CAP[b]) opts.push({ c: RATE[b], m: [b], cap: CAP[b], lcl: 0 }); });
        if (r <= D.lclMax) opts.push({ c: lclCost(r), m: ['LCL ' + (Math.round(r * 10) / 10) + ' m³'], cap: 0, lcl: r });
      }
      opts.forEach(function (o) { var c = k * RATE['40HQ'] + o.c; if (!best || c < best.cost - 0.5) best = { cost: c, mix: Array(k).fill('40HQ').concat(o.m), cap: k * CAP['40HQ'] + o.cap, lcl: o.lcl }; });
    }
    return best;
  }
  function fill(port) { var v = vol(port), p = pack(v); return { v: v, p: p, pct: p.cap ? Math.min(1, (v - p.lcl) / p.cap) : 0, onlyLcl: p.lcl > 0 && !p.cap }; }
  function ringColor(f) { return !f.v ? '#bbb' : f.onlyLcl ? '#b23b2e' : f.pct >= 0.85 ? '#2f8a4c' : f.pct >= 0.6 ? '#c27a00' : '#b23b2e'; }
  /** Extra trucking (estimate) when a supplier delivers to a port farther away than its original one. */
  function truck(l, port) { if (!l.ll || port === l.home) return 0; var d = km(l.ll, PORTS[port].ll) - km(l.ll, PORTS[l.home].ll); return d <= 0 ? 0 : Math.round((90 + d * 1.15) * Math.max(1, l.cbm / 20)); }
  function total() { return codes.reduce(function (a, k) { return a + pack(vol(k)).cost; }, 0) + LOTS.reduce(function (a, l) { return a + truck(l, l.port); }, 0); }
  function movable(l, port) { return l.ll && !l.locked && l.cbm > 0 && port !== l.port && km(l.ll, PORTS[port].ll) <= 420; }
  function bestMove() {
    var base = total(), best = null;
    function tryIt(group, k) { var old = group.map(function (x) { return x.port; }); group.forEach(function (x) { x.port = k; }); var c = total(); group.forEach(function (x, i) { x.port = old[i]; }); var sv = base - c; if (sv > 150 && (!best || sv > best.save)) best = { moves: group.map(function (x) { return [x, k]; }), save: sv }; }
    LOTS.forEach(function (a, i) { codes.forEach(function (k) { if (!movable(a, k)) return; tryIt([a], k);
      LOTS.forEach(function (b, j) { if (j <= i || b.port !== a.port || !movable(b, k)) return; tryIt([a, b], k); }); }); });
    return best;
  }
  /** Greedy: take the best move, apply it, look again — so the ideas add up and can all be taken. */
  function ideas() {
    var out = [], saved = LOTS.map(function (l) { return l.port; });
    for (var n = 0; n < 3; n++) {
      var m = bestMove(); if (!m) break;
      var pf = m.moves[0][0].port, pt = m.moves[0][1]; m.from = pf; m.to = pt;
      m.before = {}; m.after = {}; m.before[pf] = pack(vol(pf)).mix.join(' + ') || 'none'; m.before[pt] = pack(vol(pt)).mix.join(' + ') || 'none';
      m.truck = m.moves.reduce(function (a, x) { var o = x[0].port; x[0].port = x[1]; var t = truck(x[0], x[1]); x[0].port = o; return a + t; }, 0);
      m.moves.forEach(function (x) { x[0].port = x[1]; });
      m.after[pf] = pack(vol(pf)).mix.join(' + ') || 'none'; m.after[pt] = pack(vol(pt)).mix.join(' + ') || 'none';
      out.push(m);
    }
    LOTS.forEach(function (l, i) { l.port = saved[i]; });
    return out;
  }

  // ── map panels ──
  var regions = D.regions.map(function (r) {
    var a = pj([r.bb[0][0], r.bb[1][1]]), b = pj([r.bb[1][0], r.bb[0][1]]);
    r.vb = [a[0], a[1], b[0] - a[0], b[1] - a[1]];
    var box = document.createElement('div'); box.className = 'pm-region'; box.innerHTML = '<h4>' + esc(r.title) + '</h4>';
    root.querySelector('[data-pm-regions]').appendChild(box);
    r.svg = el('svg', { viewBox: r.vb.join(' '), preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': r.title + ' map' }, box);
    var lg = el('g', {}, r.svg); Object.keys(G.paths).forEach(function (n) { el('path', { d: G.paths[n], class: 'pm-land' + (n === 'China' ? '' : ' other') }, lg); });
    r.legs = el('g', {}, r.svg); r.sug = el('g', {}, r.svg); r.sups = el('g', {}, r.svg); r.ports = el('g', {}, r.svg);
    r.u = function () { var b = r.svg.getBoundingClientRect(); return 1 / Math.min((b.width || 420) / r.vb[2], (b.height || 380) / r.vb[3]); };
    r.svg.addEventListener('pointermove', function (e) { if (!drag || drag.r !== r) return; var p = svgPt(r, e); drag.line.setAttribute('x2', p[0]); drag.line.setAttribute('y2', p[1]); var k = nearPort(r, p); Array.prototype.forEach.call(r.ports.children, function (g) { g.classList.toggle('drop', g.getAttribute('data-port') === k && k !== drag.l.port); }); });
    r.svg.addEventListener('pointerup', function (e) { if (!drag || drag.r !== r) return; var k = nearPort(r, svgPt(r, e)), l = drag.l; drag = null; if (k && k !== l.port) move([l], k); else drawMap(); });
    return r;
  });
  function inReg(r, ll) { return ll && ll[0] >= r.bb[0][0] && ll[0] <= r.bb[1][0] && ll[1] >= r.bb[0][1] && ll[1] <= r.bb[1][1]; }
  function svgPt(r, e) { var b = r.svg.getBoundingClientRect(), sc = Math.min(b.width / r.vb[2], b.height / r.vb[3]), ox = (b.width - r.vb[2] * sc) / 2, oy = (b.height - r.vb[3] * sc) / 2; return [r.vb[0] + (e.clientX - b.left - ox) / sc, r.vb[1] + (e.clientY - b.top - oy) / sc]; }
  function nearPort(r, p) { var u = r.u(), best = null; codes.forEach(function (k) { var d = Math.hypot(PORTS[k].xy[0] - p[0], PORTS[k].xy[1] - p[1]); if (d < 32 * u && (!best || d < best.d)) best = { k: k, d: d }; }); return best && best.k; }
  function short(n) { return n.replace(/\b(Co\.?,?\s*Ltd\.?|Co\.|Ltd\.?|Limited|Import\s*&\s*Export|Trading|Industrial|Industry|Technology|Products?|Manufactur\w*|Factory|Plastic\s*&\s*Rubber|E-Commerce|Childcare|Houseware|Silicone)\b/gi, '').replace(/\(.*?\)/g, '').replace(/^(Guangdong|Zhejiang|Jiangsu|Fujian)\s+/i, '').replace(/[,.\s]+$/g, '').replace(/\s{2,}/g, ' ').trim(); }

  function drawMap() {
    var hi = hoverIdea != null && lastIdeas[hoverIdea];
    regions.forEach(function (r) {
      var u = r.u(); r.legs.innerHTML = ''; r.sug.innerHTML = ''; r.sups.innerHTML = ''; r.ports.innerHTML = '';
      LOTS.forEach(function (l) { if (!inReg(r, l.ll)) return; var p = PORTS[l.port]; el('line', { x1: l.xy[0], y1: l.xy[1], x2: p.xy[0], y2: p.xy[1], class: 'pm-leg', stroke: p.color, style: 'stroke-width:' + 1.4 * u + 'px' }, r.legs); });
      if (hi) hi.moves.forEach(function (m) { if (!inReg(r, m[0].ll)) return; var p = PORTS[m[1]]; el('line', { x1: m[0].xy[0], y1: m[0].xy[1], x2: p.xy[0], y2: p.xy[1], class: 'pm-leg sug', style: 'stroke-width:' + 2.2 * u + 'px;stroke-dasharray:' + 5 * u + ' ' + 5 * u }, r.sug); });
      var labelled = {};
      LOTS.slice().sort(function (a, b) { return b.cbm - a.cbm; }).forEach(function (l) {
        if (!inReg(r, l.ll)) return;
        var inIdea = hi && hi.moves.some(function (m) { return m[0] === l; });
        var g = el('g', { class: 'pm-sup' + (hi && !inIdea ? ' dim' : '') + (l.locked ? ' locked' : ''), transform: 'translate(' + l.xy[0] + ',' + l.xy[1] + ')', tabindex: '0', role: 'button', 'aria-label': l.name + ', ' + m3(l.cbm) + ', ships from ' + PORTS[l.port].name }, r.sups);
        el('title', {}, g).textContent = l.name + ' · ' + m3(l.cbm) + (l.noCbm ? ' (+' + l.noCbm + ' line(s) without CBM)' : '') + ' · ' + (l.city || '') + ' → ' + PORTS[l.port].name + (l.locked ? ' · already in a container plan' : '');
        var rad = (5 + Math.sqrt(Math.max(l.cbm, 0.5)) * 1.5) * u;
        el('circle', { r: rad, fill: PORTS[l.port].color, style: 'stroke-width:' + 2 * u + 'px' }, g);
        var show = l.port === sel || inIdea;
        if (show) {
          var key = Math.round(l.xy[0] / (14 * u)) + ':' + Math.round(l.xy[1] / (14 * u)), nth = labelled[key] = (labelled[key] || 0) + 1;
          // label away from the port when there is room for it, otherwise on the side that fits
          var label = short(l.name) + ' · ' + m3(l.cbm) + (l.port !== l.home ? ' ↪' : ''), w = (label.length * 6.1 + 8) * u + rad;
          var roomL = l.xy[0] - r.vb[0], roomR = r.vb[0] + r.vb[2] - l.xy[0], awayRight = l.xy[0] > PORTS[l.port].xy[0];
          var left = awayRight ? (roomR >= w || roomR >= roomL) : !(roomL >= w || roomL > roomR);
          var t = el('text', { x: (left ? 1 : -1) * (rad + 4 * u), y: 4 * u + (nth - 1) * 13 * u, 'text-anchor': left ? 'start' : 'end', style: 'font-size:' + 11 * u + 'px;stroke-width:' + 3 * u + 'px' }, g);
          t.textContent = label;
        }
        if (!l.locked) g.addEventListener('pointerdown', function (e) { e.preventDefault(); drag = { r: r, l: l, line: el('line', { class: 'pm-leg sug', x1: l.xy[0], y1: l.xy[1], x2: l.xy[0], y2: l.xy[1], style: 'stroke-width:' + 2.2 * u + 'px;stroke-dasharray:' + 5 * u + ' ' + 5 * u }, r.sug) }; r.svg.setPointerCapture(e.pointerId); });
        g.addEventListener('keydown', function (e) { if (e.key === 'Enter') { sel = l.port; draw(); } });
      });
      codes.forEach(function (k) {
        var p = PORTS[k]; if (!inReg(r, p.ll)) return;
        var f = fill(k), col = ringColor(f), R = 20 * u, C = 2 * Math.PI * R;
        var g = el('g', { class: 'pm-port' + (k === sel ? ' sel' : ''), 'data-port': k, transform: 'translate(' + p.xy[0] + ',' + p.xy[1] + ')', tabindex: '0', role: 'button', 'aria-label': p.name + ': ' + m3(f.v) + ', ' + (f.p.mix.join(' + ') || 'nothing ready') }, r.ports);
        el('circle', { r: R, class: 'bg', style: 'stroke-width:' + 7 * u + 'px' }, g);
        el('circle', { r: R, class: 'ring', stroke: col, transform: 'rotate(-90)', 'stroke-dasharray': C * f.pct + ' ' + C, style: 'stroke-width:' + 7 * u + 'px' }, g);
        el('text', { class: 'pct', fill: col, style: 'font-size:' + 11 * u + 'px' }, g).textContent = f.v ? (f.onlyLcl ? 'LCL' : Math.round(f.pct * 100) + '%') : '—';
        var west = codes.some(function (o) { return o !== k && inReg(r, PORTS[o].ll) && PORTS[o].ll[0] > p.ll[0] && Math.abs(PORTS[o].ll[0] - p.ll[0]) < 1.5; });
        var dx = (west ? -1 : 1) * (R + 7 * u), an = west ? 'end' : 'start', dy = (p.ll[1] < (r.bb[0][1] + r.bb[1][1]) / 2 ? 1 : -1) * 4 * u;
        el('text', { x: dx, y: dy - 2 * u, class: 'name', 'text-anchor': an, style: 'font-size:' + 13 * u + 'px;stroke-width:' + 4 * u + 'px' }, g).textContent = p.name;
        el('text', { x: dx, y: dy + 12 * u, class: 'vol', 'text-anchor': an, style: 'font-size:' + 11 * u + 'px;stroke-width:' + 4 * u + 'px' }, g).textContent = m3(f.v) + ' · ' + (f.p.mix.join(' + ') || 'nothing ready');
        g.addEventListener('click', function () { sel = k; draw(); });
        g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel = k; draw(); } });
      });
    });
  }

  // ── side panel, strip ──
  var ideasEl = root.querySelector('[data-pm-ideas]'), portEl = root.querySelector('[data-pm-port]'), stripEl = root.querySelector('[data-pm-strip]');
  function drawIdeas() {
    var tot = lastIdeas.reduce(function (a, s) { return a + s.save; }, 0);
    ideasEl.innerHTML = '<h3>✦ Consolidation ideas</h3>' + (lastIdeas.length ? '<div class="pm-save"><b>~' + money(tot) + '</b><span>could be saved in this window · ideas build on each other</span></div>' : '<p class="sub">' + (LOTS.length ? 'No move between nearby ports would save money in this window.' : 'No open orders with a port and ready date in this window.') + '</p>');
    lastIdeas.forEach(function (sg, i) {
      var v = sg.moves.reduce(function (a, m) { return a + m[0].cbm; }, 0), names = sg.moves.map(function (m) { return short(m[0].name); }).join(' + ');
      var lines = sg.moves.reduce(function (a, m) { return a + m[0].orders.length; }, 0);
      var d = Math.round(Math.max.apply(null, sg.moves.map(function (m) { return km(m[0].ll, PORTS[m[1]].ll); })));
      var div = document.createElement('div'); div.className = 'pm-idea';
      div.innerHTML = '<p>' + (i ? '<span class="sub">Then: </span>' : '') + '<b>Ship ' + esc(names) + '</b> (' + m3(v) + ') from <b>' + esc(PORTS[sg.to].name) + '</b> instead of ' + esc(PORTS[sg.from].name) + '.</p>' +
        '<div class="meta"><span>' + esc(PORTS[sg.from].name) + ': ' + esc(sg.before[sg.from]) + ' → ' + esc(sg.after[sg.from]) + '</span><span>' + esc(PORTS[sg.to].name) + ': ' + esc(sg.before[sg.to]) + ' → ' + esc(sg.after[sg.to]) + '</span><span>🚚 ~' + d + ' km' + (sg.truck ? ' · +' + money(sg.truck) + ' trucking (est.)' : ' · no extra trucking') + '</span></div>' +
        '<div class="act"><button type="button" class="btn small pm-go">Move — save ~' + money(sg.save) + '</button><span class="sub">changes the port on ' + lines + ' line' + (lines === 1 ? '' : 's') + '</span></div>';
      div.addEventListener('mouseenter', function () { hoverIdea = i; div.classList.add('hover'); drawMap(); });
      div.addEventListener('mouseleave', function () { hoverIdea = null; div.classList.remove('hover'); drawMap(); });
      div.querySelector('.pm-go').addEventListener('click', function () { hoverIdea = null; move(sg.moves.map(function (m) { return m[0]; }), sg.to); });
      ideasEl.appendChild(div);
    });
  }
  function drawPort() {
    var p = PORTS[sel], f = fill(sel), col = ringColor(f), lots = LOTS.filter(function (l) { return l.port === sel; }).sort(function (a, b) { return b.cbm - a.cbm; });
    var rest = f.p.lcl && !f.onlyLcl ? Math.round(f.p.lcl * 10) / 10 : 0;
    var h = '<div class="pm-ph"><h3><i style="background:' + p.color + '"></i>' + esc(p.name) + ' <small>' + esc(p.zh) + '</small></h3><span class="sub">' + lots.length + ' supplier' + (lots.length === 1 ? '' : 's') + '</span></div>' +
      '<div class="pm-fill"><span style="width:' + Math.round(f.pct * 100) + '%;background:' + col + '"></span></div>' +
      '<div class="pm-fillcap"><span>' + m3(f.v) + ' ready</span><span>' + (!f.v ? 'nothing ready' : f.onlyLcl ? 'LCL — no full container' : Math.round(f.pct * 100) + '% of ' + f.p.mix.filter(function (m) { return !/LCL/.test(m); }).join(' + ')) + '</span></div>' +
      '<p class="pm-plan">Plan: <b>' + esc(f.p.mix.join(' + ') || 'nothing ready') + '</b>' + (f.v ? ' · est. ' + money(f.p.cost) + ' ocean' : '') + '</p>' +
      (rest && rest <= 6 ? '<p class="pm-tip">💡 ' + rest + ' m³ over a full container. Roll the latest-ready PO to the next sailing instead of booking LCL, or check the cartons fit at 100%.</p>' : '');
    portEl.innerHTML = h;
    var ul = document.createElement('ul'); ul.className = 'pm-orders';
    lots.forEach(function (l) {
      var li = document.createElement('li');
      var opts = codes.map(function (k) { return '<option value="' + k + '"' + (k === l.port ? ' selected' : '') + '>' + esc(PORTS[k].name) + (k !== l.port && l.ll ? ' · ' + Math.round(km(l.ll, PORTS[k].ll)) + ' km' : '') + '</option>'; }).join('');
      li.innerHTML = '<div class="pm-lot"><span><i style="background:' + p.color + '"></i><b>' + esc(l.name) + '</b><small>' + (l.city ? esc(l.city) + (l.cityHow === 'guessed' ? ' (from name/address)' : '') + ' · ' : '') + m3(l.cbm) + (l.noCbm ? ' · ' + l.noCbm + ' line' + (l.noCbm === 1 ? '' : 's') + ' without CBM' : '') + (l.port !== l.home ? ' · <em>moved from ' + esc(PORTS[l.home].name) + '</em>' : '') + '</small></span>' +
        (l.locked ? '<span class="sub" title="Some lines are already in a container plan">in a container</span>' : '<select aria-label="Loading port for ' + esc(l.name) + '">' + opts + '</select>') + '</div>' +
        '<ul>' + l.orders.map(function (o) { return '<li><a href="' + esc(o.url) + '">' + esc(o.po) + '</a> ' + esc(o.product) + (o.qty ? ' · ' + o.qty.toLocaleString('en-US') + ' pcs' : '') + ' · ' + (o.cbm ? m3(o.cbm) : '<span class="warn">no CBM</span>') + ' · ready ' + esc(o.ready) + (o.late ? ' <span class="warn">late</span>' : '') + '</li>'; }).join('') + '</ul>';
      var s = li.querySelector('select'); if (s) s.addEventListener('change', function () { move([l], s.value); });
      ul.appendChild(li);
    });
    if (!lots.length) portEl.insertAdjacentHTML('beforeend', '<p class="sub">No open orders ready for this port in the window.</p>');
    portEl.appendChild(ul);
  }
  function drawStrip() {
    stripEl.innerHTML = '';
    codes.forEach(function (k) { var f = fill(k), b = document.createElement('button'); b.type = 'button'; b.className = 'pm-chip' + (k === sel ? ' sel' : ''); b.innerHTML = '<b><i style="background:' + PORTS[k].color + '"></i>' + esc(PORTS[k].name) + '</b><small>' + m3(f.v) + ' · ' + esc(f.p.mix.join(' + ') || '—') + '</small>'; b.addEventListener('click', function () { sel = k; draw(); }); stripEl.appendChild(b); });
    var t = document.createElement('div'); t.className = 'pm-chip tot'; t.innerHTML = '<b>' + money(total()) + '</b><small>est. ocean + extra trucking in this window</small>'; stripEl.appendChild(t);
  }
  function drawInset() {
    var s = root.querySelector('[data-pm-inset]'); if (!s) return;
    el('path', { d: G.inset.china, class: 'pm-inset-land' }, s); el('path', { d: G.inset.tw, class: 'pm-inset-land' }, s);
    var ip = function (ll) { var r = Math.PI / 180; return [G.inset.t[0] + G.inset.s * ll[0] * r, G.inset.t[1] - G.inset.s * Math.log(Math.tan(Math.PI / 4 + ll[1] * r / 2))]; };
    D.regions.forEach(function (r) { var a = ip([r.bb[0][0], r.bb[1][1]]), b = ip([r.bb[1][0], r.bb[0][1]]); el('rect', { x: a[0], y: a[1], width: b[0] - a[0], height: b[1] - a[1], class: 'pm-inset-box' }, s); });
  }
  function draw() { lastIdeas = ideas(); drawMap(); drawIdeas(); drawPort(); drawStrip(); }

  // ── moving lines between ports (saved right away; Undo in the toast) ──
  function post(ids, port) {
    var b = new URLSearchParams(); ids.forEach(function (id) { b.append('ids', id); }); b.append('port', port);
    return fetch(D.moveUrl, { method: 'POST', body: b, credentials: 'same-origin' }).then(function (r) { return r.json(); });
  }
  function move(lots, port, undo) {
    var ids = []; lots.forEach(function (l) { l.orders.forEach(function (o) { if (!o.locked) ids.push(o.id); }); });
    var prev = lots.map(function (l) { return l.port; });
    if (!ids.length) { toast('These lines are already in a container plan — change them in Load containers.'); return; }
    post(ids, port).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'Could not move');
      lots.forEach(function (l) { l.port = port; });
      if (!undo) sel = port;
      draw();
      var names = lots.map(function (l) { return short(l.name); }).join(' + ');
      if (undo) toast('Moved back.'); else toast(names + ' now ship' + (lots.length === 1 ? 's' : '') + ' from ' + PORTS[port].name + '. Tell the supplier and forwarder.' + (j.skipped && j.skipped.length ? ' Skipped (in a container): ' + j.skipped.join(', ') : ''), function () { lots.forEach(function (l, i) { move([l], prev[i], true); }); });
    }).catch(function (e) { toast(e.message || 'Could not move'); draw(); });
  }
  var toastEl = document.createElement('div'); toastEl.className = 'pm-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); var tt;
  function toast(msg, undo) {
    toastEl.innerHTML = '<span></span>' + (undo ? '<button type="button">Undo</button>' : ''); toastEl.querySelector('span').textContent = msg;
    if (undo) toastEl.querySelector('button').addEventListener('click', function () { toastEl.classList.remove('show'); undo(); });
    toastEl.classList.add('show'); clearTimeout(tt); tt = setTimeout(function () { toastEl.classList.remove('show'); }, undo ? 9000 : 4000);
  }

  drawInset(); draw();
  var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(drawMap, 150); });
})();
