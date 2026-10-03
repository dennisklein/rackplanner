/*
 * Rackplanner intro video: 27 seconds of motion graphics.
 *
 * Every frame is a pure function of the time t in seconds: render(t) poses
 * the whole stage, so frames can be drawn in any order. The racks, devices,
 * CSV and share link come from the app's own code and its example plan.
 * media/record.js steps through the frames and encodes them; opened in a
 * browser, the page plays in real time (?t=12.5 holds one moment).
 */
(function () {
  'use strict';

  const M = RP.model;
  const R = RP.render;
  const IO = RP.io;

  const DURATION = 27.5;
  const URL_SCHEME = 'https://';
  const URL_HOST = 'dennisklein.github.io/rackplanner/';
  const DATE = '2026-10-03';
  const THEME = 'dark';
  const T = R.THEMES[THEME];

  const PANEL = { x: 790, y: 84, w: 1050, h: 912 };
  const SHEET_W = 1048;
  const SHEET_H = 803;
  const ASPECT = SHEET_W / SHEET_H;
  const COPY_X = 110;
  const COPY_Y = 236;
  const BRAND_TB = 0.6;
  const CATALOG = 15.0; // the catalog dialog opens
  const SHARE = 18.85; // the export menu opens
  const WIPE = 23.9; // the stripes sweep in
  const OUTRO = 24.4; // ... and cover the screen: the closing page takes over

  // ------------------------------------------------------------- easing

  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const ease = {
    out: (k) => 1 - Math.pow(1 - k, 3),
    in: (k) => k * k * k,
    inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    sine: (k) => -(Math.cos(Math.PI * k) - 1) / 2,
    expo: (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k)),
    back: (k) => 1 + 2.4 * Math.pow(k - 1, 3) + 1.4 * Math.pow(k - 1, 2),
  };
  /** Progress of a tween that starts at `start` and lasts `dur` seconds, eased. */
  const prog = (t, start, dur, e) => (e || ease.out)(clamp((t - start) / dur));
  /** 0 → 1 → 0: in over `fade` from a, out over `fade` from b. */
  const span = (t, a, b, fade) => Math.min(prog(t, a, fade, ease.inOut), 1 - prog(t, b, fade, ease.inOut));

  // -------------------------------------------------------------- dom

  const $ = (sel, root) => (root || document).querySelector(sel);
  function make(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  const pose = (e, x, y, s, extra) => (e.style.transform = `translate(${x}px, ${y}px)${s != null && s !== 1 ? ` scale(${s})` : ''}${extra || ''}`);
  const fade = (e, o) => {
    e.style.opacity = o;
    e.style.visibility = o > 0.001 ? 'visible' : 'hidden';
  };

  // Text measured in the web fonts, as the app does.
  const measureCtx = document.createElement('canvas').getContext('2d');
  const measureCache = new Map();
  function measure(text, font) {
    const key = font + '|' + text;
    let w = measureCache.get(key);
    if (w === undefined) {
      measureCtx.font = font;
      w = measureCtx.measureText(text).width;
      measureCache.set(key, w);
    }
    return w;
  }

  // ------------------------------------------------------- the story

  // The example plan, plus two GPU servers too many for rack B03.
  const example = M.createExampleProject();
  const byName = new Map(example.devices.map((d) => [d.name, d]));
  const clusterOf = new Map(example.clusters.map((c) => [c.id, c]));
  const overflow = (name, at) => Object.assign({}, byName.get('gpu-srv-06'), { id: `vid-${name}`, name, loc: { rack: 'r6', kind: 'u', at } });
  const ALL = example.devices.concat([overflow('gpu-srv-07', 24), overflow('gpu-srv-08', 28)]);

  /** Device id → the second it lands in its rack; devices without one are there from the start. */
  const land = new Map();
  // Row A fills top to bottom, its three racks in parallel waves.
  const WAVES = { r1: [2.75, 0.19], r2: [2.83, 0.22], r3: [2.91, 0.31] };
  const rank = (d) => (d.loc.kind === 'side' ? 2.5 : d.loc.at);
  for (const [rack, [start, step]] of Object.entries(WAVES)) {
    ALL.filter((d) => d.loc.rack === rack)
      .sort((a, b) => rank(a) - rank(b))
      .forEach((d, i) => land.set(d.id, start + i * step));
  }
  // Rack B03 fills up until it runs over its power budget.
  const B03_LANDS = [['gpu-srv-04', 10.0], ['gpu-srv-05', 10.28], ['gpu-srv-06', 10.56], ['GPU batch 2', 10.95], ['gpu-srv-07', 11.4], ['gpu-srv-08', 11.85]];
  for (const [name, at] of B03_LANDS) land.set(ALL.find((d) => d.name === name).id, at);
  const OVER_AT = 11.85;
  const FALL = 0.34;

  const planAt = (t) => Object.assign({}, example, { devices: ALL.filter((d) => !land.has(d.id) || t >= land.get(d.id)) });
  const FINAL = planAt(Infinity);
  const colorOf = (d) => (d.cluster && clusterOf.has(d.cluster) ? clusterOf.get(d.cluster).color : null);
  const rowOf = (rackId) => M.locateRack(example, rackId).row.id;

  // Clusters light up one after another; the rest of the row dims.
  const SPOTLIGHT = [['c-kestrel', 6.75, 7.4], ['c-osprey', 7.4, 8.05], ['c-ceph', 8.05, 8.7], ['c-lustre', 8.7, 9.35]];
  const lit = (cid, t) => Math.max(0, ...SPOTLIGHT.filter(([c]) => c === cid).map(([, a, b]) => span(t, a, b, 0.2)));
  const spotOn = (t) => span(t, SPOTLIGHT[0][1], SPOTLIGHT[SPOTLIGHT.length - 1][2], 0.2);
  const brightness = (cid, t) => 1 - spotOn(t) * (1 - lit(cid, t));

  // ----------------------------------------------------------- cameras

  // A camera is the middle x, the top y and the width of what it sees.
  const camLerp = (a, b, k) => ({ cx: lerp(a.cx, b.cx, k), top: lerp(a.top, b.top, k), w: lerp(a.w, b.w, k) });
  function track(keys, t) {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        const [t0, a] = keys[i - 1];
        const [t1, b] = keys[i];
        return camLerp(a, b, ease.inOut((t - t0) / (t1 - t0)));
      }
    }
    return keys[keys.length - 1][1];
  }
  const ROW_A_ALL = { cx: 580, top: 20, w: 1190 };
  const KESTREL = { cx: 400, top: 62, w: 800 };
  const OSPREY = { cx: 580, top: 22, w: 800 };
  const CEPH = { cx: 580, top: 300, w: 800 };
  const LUSTRE = { cx: 760, top: 62, w: 800 };
  const CAM_A = [
    [2.0, { cx: 310, top: 18, w: 600 }],
    [3.7, { cx: 330, top: 18, w: 640 }],
    [5.9, ROW_A_ALL],
    [6.75, ROW_A_ALL],
    [7.15, KESTREL],
    [7.4, KESTREL],
    [7.8, OSPREY],
    [8.05, OSPREY],
    [8.45, CEPH],
    [8.7, CEPH],
    [9.1, LUSTRE],
  ];
  const CAM_B = [
    [9.4, { cx: 685, top: 14, w: 960 }],
    [12.4, { cx: 715, top: 22, w: 900 }],
  ];

  // ------------------------------------------------------------ sheets

  const faceCache = new Map();
  function faceOf(d) {
    let f = faceCache.get(d.id);
    if (!f) {
      f = R.renderPreview(M.typeOf(example, d.type), THEME, colorOf(d), d.name, measure, d.height).body.replace(/<defs>[\s\S]*?<\/defs>/, '');
      faceCache.set(d.id, f);
    }
    return f;
  }
  const r2 = (v) => Math.round(v * 100) / 100;

  const sheets = {};
  for (const id of ['A', 'B']) {
    const svg = $(`#sheet${id}`);
    svg.innerHTML = '<g class="base"></g><g class="over"></g>';
    sheets[id] = { svg, base: svg.firstChild, over: svg.lastChild, key: '' };
  }

  /** Draws `rowId` as it stands at time t, devices dropping into place, seen through `cam`. */
  function drawRow(s, t, rowId, cam) {
    const plan = planAt(t);
    const key = `${rowId}|${plan.devices.length}`;
    if (key !== s.key) {
      s.key = key;
      s.base.innerHTML = R.renderScene(plan, { rowId, theme: THEME, measure, date: DATE }).body;
      s.layout = R.rowLayout(plan, rowId);
      s.devs = [...s.base.querySelectorAll('.dev')].map((g) => [g, ALL.find((d) => d.id === g.getAttribute('data-id'))]);
    }
    let rings = '';
    let flying = '';
    for (const d of ALL) {
      const at = land.get(d.id);
      if (at === undefined || t < at - FALL || t > at + 0.45 || rowOf(d.loc.rack) !== rowId) continue;
      const r = R.locRect(plan, d.loc, d.type, d.height, s.layout);
      const place = r.rotated ? `translate(${r.x} ${r.y + r.h}) rotate(-90)` : `translate(${r.x} ${r.y})`;
      const k = clamp((t - (at - FALL)) / FALL);
      const box = `x="${r2(r.x - 1.5)}" y="${r2(r.y - 1.5)}" width="${r.w + 3}" height="${r.h + 3}" rx="2.5"`;
      const ring = t < at ? ease.out(clamp(k * 1.6)) : 1 - prog(t, at, 0.4);
      rings += `<rect ${box} fill="${T.ok}" fill-opacity="${r2(0.12 * ring)}" stroke="${T.ok}" stroke-width="2.5" opacity="${r2(ring)}"/>`;
      if (t < at) {
        // Dropped onto the sheet: it falls from above the page, its shadow closing in.
        const z = 1 - ease.out(k);
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const lift = `translate(${r2(cx)} ${r2(cy)}) scale(${r2(1 + 0.25 * z)}) translate(${r2(-cx)} ${r2(-cy)})`;
        rings += `<rect x="${r.x + 10 * z}" y="${r.y + 14 * z}" width="${r.w}" height="${r.h}" rx="3" fill="#000" opacity="${r2(0.45 * (1 - z) * clamp(k * 3))}" transform="${lift}"/>`;
        flying += `<g opacity="${r2(clamp(k * 2.5))}" transform="${lift} ${place}">${faceOf(d)}</g>`;
      } else {
        rings += `<rect ${box} fill="#ffffff" opacity="${r2(0.45 * (1 - prog(t, at, 0.3)))}"/>`;
      }
    }
    // Rack B03 flashes red as it goes over budget.
    if (rowId === 'row2' && t > OVER_AT && t < OVER_AT + 1.2) {
      const r = s.layout.byId.get('r6');
      for (const delay of [0, 0.35]) {
        const k = prog(t, OVER_AT + delay, 0.7);
        if (k <= 0 || k >= 1) continue;
        const g = 4 + 18 * k;
        rings += `<rect x="${r.x - g}" y="${r.headTop - g + 2}" width="${R.geometry.RACK_W + 2 * g}" height="${s.layout.rackBottom - r.headTop + 2 * g}" rx="${6 + g / 2}" fill="none" stroke="${T.bad}" stroke-width="3" opacity="${r2(1 - k)}"/>`;
      }
    }
    s.over.innerHTML = rings + flying;
    for (const [g, d] of s.devs) {
      const b = d ? brightness(d.cluster, t) : 1;
      g.setAttribute('opacity', b < 0.999 ? r2(0.16 + 0.84 * b) : 1);
    }
    s.svg.setAttribute('viewBox', `${r2(cam.cx - cam.w / 2)} ${r2(cam.top)} ${r2(cam.w)} ${r2(cam.w / ASPECT)}`);
  }

  // --------------------------------------------------------- floor map

  const kw = (w) => (Math.round(w / 100) / 10).toFixed(1);
  const pct = (a, b) => Math.round((100 * a) / b);
  const statsLine = (st) => `${pct(st.used + st.reserved, st.units)}% of ${st.units} U · ${kw(st.powerW)} kW of ${kw(st.powerBudgetW)} kW`;

  /** A small drawing of a rack with its devices as colored blocks, as on the app's floor map. */
  function miniRack(plan, rack, stats, unitPx, withLabels) {
    const st = stats.get(rack.id);
    const box = make('div', 'fm-rack' + (st.overPower ? ' over' : ''));
    const elev = make('span', 'fm-elev');
    elev.style.height = `${st.units * unitPx + 8}px`;
    const blocks = [];
    for (const d of plan.devices) {
      if (d.loc.rack !== rack.id || d.loc.kind !== 'u') continue;
      const h = M.deviceHeight(plan, d);
      const b = make('i', d.type === M.RESERVED.id ? 'res' : '');
      const color = colorOf(d) || T.unassigned;
      b.style.top = `${(((d.loc.at - 1) / st.units) * 100).toFixed(2)}%`;
      b.style.height = `${((h / st.units) * 100).toFixed(2)}%`;
      if (d.type === M.RESERVED.id) b.style.color = color;
      else b.style.background = color;
      elev.appendChild(b);
      blocks.push([b, d]);
    }
    box.appendChild(elev);
    if (withLabels) {
      box.insertAdjacentHTML(
        'beforeend',
        `<span class="fm-meter"><span style="width:${Math.min(100, (100 * st.powerW) / st.powerBudgetW).toFixed(1)}%"></span></span>` +
          `<span class="fm-name">${rack.name.replace(/^Rack /, '')}</span><span class="fm-val">${kw(st.powerW)} kW</span>`
      );
    }
    return { box, blocks };
  }

  const SEARCH = 'gpu';
  const SEARCH_AT = 13.45;
  const matches = M.deviceMatcher(FINAL, SEARCH);
  const floorMap = { el: $('#floormap'), rows: [], blocks: [], hits: [] };
  function buildFloorMap() {
    const stats = M.statsByRack(FINAL);
    const floor = FINAL.floors[0];
    const fs = M.statsWithin(FINAL, floor.id, stats);
    const racks = floor.rows.reduce((n, r) => n + r.racks.length, 0);
    const fm = floorMap.el;
    fm.innerHTML =
      `<div class="fm-head"><div><h3>${floor.name}</h3><p>${floor.rows.length} rows · ${racks} racks · ${statsLine(fs)}</p></div>` +
      `<div class="seg"><span>Space</span><span class="on">Power</span><span>Weight</span></div></div>`;
    const search = $('#tbSearch');
    floorMap.search = search;
    floorMap.ph = $('.ph', search);
    floorMap.typed = $('.typed', search);
    floorMap.caret = $('.caret', search);
    for (const row of floor.rows) {
      const rs = M.statsWithin(FINAL, row.id, stats);
      const card = make('section', 'fm-row' + (row.id === 'row2' ? ' current' : ''));
      card.innerHTML = `<div class="fm-row-head"><b>${row.name} ›</b><span>${row.racks.length} racks · ${statsLine(rs)}</span></div>`;
      const list = make('div', 'fm-racks');
      for (const rack of row.racks) {
        const mr = miniRack(FINAL, rack, stats, 3.9, true);
        const n = mr.blocks.filter(([, d]) => matches(d)).length + ALL.filter((d) => d.loc.rack === rack.id && d.loc.kind === 'side' && matches(d)).length;
        if (n) {
          const badge = make('span', 'fm-hits', String(n));
          mr.box.appendChild(badge);
          floorMap.hits.push(badge);
        }
        floorMap.blocks.push(...mr.blocks);
        list.appendChild(mr.box);
      }
      const add = make('span', 'fm-add', '+');
      add.style.height = `${Math.round(M.rackTypeOf(FINAL, row.racks[0]).units * 3.9) + 8}px`;
      add.style.marginBottom = '50px';
      list.appendChild(add);
      card.appendChild(list);
      fm.appendChild(card);
      floorMap.rows.push(card);
    }
  }

  function drawFloorMap(t) {
    const typed = SEARCH.slice(0, clamp(Math.floor((t - SEARCH_AT) / 0.13) + 1, 0, SEARCH.length));
    floorMap.typed.textContent = typed;
    floorMap.ph.style.display = typed ? 'none' : '';
    const searching = t > SEARCH_AT - 0.3 && t < CATALOG;
    floorMap.search.classList.toggle('on', searching);
    floorMap.caret.style.opacity = searching && Math.floor(t * 2.6) % 2 === 0 ? 1 : 0;
    const dim = prog(t, SEARCH_AT + 0.4, 0.3, ease.inOut);
    for (const [b, d] of floorMap.blocks) b.style.opacity = matches(d) ? 1 : 1 - 0.8 * dim;
    floorMap.hits.forEach((h, i) => {
      const k = prog(t, SEARCH_AT + 0.45 + i * 0.06, 0.4, ease.back);
      h.style.transform = `scale(${k})`;
      h.style.opacity = clamp(k * 3);
    });
    floorMap.rows.forEach((row, i) => {
      const k = prog(t, 12.65 + i * 0.1, 0.5, ease.expo);
      row.style.transform = `translateY(${(1 - k) * 40}px)`;
      row.style.opacity = k;
    });
  }

  // ------------------------------------------------------- copy blocks

  const CHIPS = [
    ['Undo and redo', '#2f6fdb'],
    ['CSV import', '#0f9d8a'],
    ['Duplicate anything', '#e56b1f'],
    ['Works offline', '#d94c8a'],
    ['Installable app', '#8a5cd6'],
    ['Light and dark', '#1f9fc9'],
    ['Keyboard and touch', '#d9a21b'],
    ['Public domain', '#7d8794'],
  ];
  const SPOT_CLUSTERS = SPOTLIGHT.map(([c]) => c);

  const COPY = [
    { tag: '01 · PLACE', lines: ['Drop devices', 'into <em>racks.</em>'], sub: 'Switches, servers and storage, named and numbered as you go.', in: 2.45, out: 6.25 },
    { tag: '02 · CLUSTERS', lines: ['See what works', '<em>together.</em>'], sub: 'Color-coded clusters stand out in every rack.', in: 6.55, out: 9.25, extra: 'clusters' },
    { tag: '03 · BUDGETS', lines: ['Stay within', '<em>budget.</em>'], sub: 'Space, power and weight, tracked per rack.', in: 9.55, out: 12.3, extra: 'card' },
    { tag: '04 · OVERVIEW', lines: ['From floors', 'to <em>devices.</em>'], sub: 'Floors, rows, a live floor map and search across the whole plan.', in: 12.6, out: 14.85 },
    { tag: '05 · CATALOG', lines: ['Your hardware,', 'your <em>catalog.</em>'], sub: 'Edit device and rack types: height, drawing, power, weight and budgets.', in: CATALOG + 0.15, out: SHARE - 0.35 },
    { tag: '06 · SHARE', lines: ['Print it.', '<em>Share it.</em>'], sub: 'Export PNG, SVG, PDF and CSV, or send a link that carries the whole plan.', in: SHARE + 0.05, out: SHARE + 3.15 },
    { tag: '07 · AND MORE', lines: ['Everything', '<em>built in.</em>'], in: SHARE + 3.45, out: Infinity, extra: 'chips' },
  ];

  function buildCopy() {
    const root = $('#copies');
    for (const c of COPY) {
      const el = make('div', 'copy abs');
      el.innerHTML =
        `<span class="tag">${c.tag}</span>` +
        `<h2>${c.lines.map((l) => `<span class="line"><span>${l}</span></span>`).join('')}</h2>` +
        (c.sub ? `<p class="sub">${c.sub}</p>` : '');
      c.el = el;
      c.tagEl = $('.tag', el);
      c.lineEls = [...el.querySelectorAll('.line > span')];
      c.subEl = $('.sub', el);
      c.items = [];
      if (c.extra === 'clusters') {
        const list = make('div', 'extra clist');
        for (const id of SPOT_CLUSTERS) {
          const cl = clusterOf.get(id);
          const n = FINAL.devices.filter((d) => d.cluster === id).length;
          const item = make('div', 'ci', `<span class="sw" style="background:${cl.color}"></span><span class="nm">${cl.name}</span><span class="n">${n}</span>`);
          item.dataset.id = id;
          list.appendChild(item);
          c.items.push(item);
        }
        el.appendChild(list);
      } else if (c.extra === 'card') {
        const card = make('div', 'extra card');
        card.innerHTML =
          `<div class="top"><span class="tag" style="font-size:20px">Rack B03</span><span class="badge">OVER BUDGET</span><span class="cap">POWER</span></div>` +
          `<div class="big"><span class="pw"></span> <small>/ ${kw(M.rackTypeOf(FINAL, M.rackById(FINAL, 'r6')).powerW)} kW</small></div>` +
          `<div class="bar"><span></span></div>` +
          `<div class="mini"><div><b>SPACE</b><span class="u"></span><div class="mbar"><span class="ub"></span></div></div>` +
          `<div><b>WEIGHT</b><span class="kg"></span><div class="mbar"><span class="kb"></span></div></div></div>`;
        el.appendChild(card);
        c.card = card;
        c.items.push(card);
      } else if (c.extra === 'chips') {
        const grid = make('div', 'extra chips');
        for (const [label, color] of CHIPS) {
          const chip = make('div', 'chip', `<i style="background:${color}"></i>${label}`);
          grid.appendChild(chip);
          c.items.push(chip);
        }
        el.appendChild(grid);
      }
      root.appendChild(el);
    }
  }

  // Rack B03's numbers as they count up with each device that lands.
  const B03 = M.rackById(FINAL, 'r6');
  const B03_TYPE = M.rackTypeOf(FINAL, B03);
  function b03At(t) {
    let p = 0;
    let w = 0;
    let u = 0;
    for (const d of ALL) {
      if (d.loc.rack !== 'r6') continue;
      const at = land.get(d.id);
      const k = at === undefined ? 1 : prog(t, at, 0.35);
      p += M.powerOf(FINAL, d) * k;
      w += M.weightOf(FINAL, d) * k;
      if (d.loc.kind === 'u') u += M.deviceHeight(FINAL, d) * k;
    }
    return { p, w, u };
  }

  function drawCopy(c, t) {
    const out = prog(t, c.out, 0.3, ease.in);
    const on = t >= c.in - 0.05 && out < 1 && t < OUTRO;
    fade(c.el, on ? 1 - out : 0);
    if (!on) return;
    pose(c.el, COPY_X, COPY_Y - 60 * out);
    const tk = prog(t, c.in, 0.4, ease.expo);
    c.tagEl.style.clipPath = `inset(-4px ${(1 - tk) * 100}% -4px -4px)`;
    c.lineEls.forEach((l, i) => {
      const k = prog(t, c.in + 0.08 + i * 0.08, 0.6, ease.expo);
      l.style.transform = `translateY(${(1 - k) * 140}%)`;
    });
    if (c.subEl) {
      const k = prog(t, c.in + 0.3, 0.5);
      c.subEl.style.opacity = k;
      c.subEl.style.transform = `translateY(${(1 - k) * 24}px)`;
    }
    c.items.forEach((item, i) => {
      const k = prog(t, c.in + 0.35 + i * 0.07, 0.5, c.extra === 'chips' ? ease.back : ease.expo);
      item.style.opacity = clamp(k * 1.5);
      item.style.transform = c.extra === 'chips' ? `translateY(${(1 - k) * 40}px) scale(${0.85 + 0.15 * k})` : `translateX(${(1 - k) * -40}px)`;
    });
    if (c.extra === 'clusters') {
      for (const item of c.items) {
        const b = brightness(item.dataset.id, t);
        const l = lit(item.dataset.id, t) * spotOn(t);
        item.style.background = `rgb(255 255 255 / ${r2(0.08 * l)})`;
        item.style.boxShadow = `inset 4px 0 0 rgb(242 194 48 / ${r2(l)})`;
        $('.nm', item).style.opacity = 0.4 + 0.6 * b;
        $('.sw', item).style.transform = `scale(${1 + 0.2 * l})`;
        $('.sw', item).style.opacity = 0.4 + 0.6 * b;
      }
    }
    if (c.extra === 'card') {
      const v = b03At(t);
      const over = v.p > B03_TYPE.powerW;
      const card = c.card;
      $('.pw', card).textContent = kw(v.p);
      $('.big', card).style.color = over ? 'var(--bad)' : '';
      const bar = $('.bar span', card);
      bar.style.width = `${Math.min(100, (100 * v.p) / B03_TYPE.powerW).toFixed(2)}%`;
      bar.style.background = over ? 'var(--bad)' : '';
      $('.u', card).textContent = `${Math.round(v.u)} / ${B03_TYPE.units} U`;
      $('.ub', card).style.width = `${((100 * v.u) / B03_TYPE.units).toFixed(2)}%`;
      $('.kg', card).textContent = `${Math.round(v.w)} / ${B03_TYPE.weightKg} kg`;
      $('.kb', card).style.width = `${((100 * v.w) / B03_TYPE.weightKg).toFixed(2)}%`;
      const badge = $('.badge', card);
      const bk = over ? prog(t, OVER_AT + 0.15, 0.4, ease.back) : 0;
      badge.style.opacity = clamp(bk * 2);
      badge.style.transform = `scale(${0.6 + 0.4 * bk})`;
      $('.cap', card).style.display = over ? 'none' : '';
      const shake = t > OVER_AT + 0.15 ? Math.sin((t - OVER_AT) * 70) * 10 * Math.exp(-(t - OVER_AT - 0.15) * 7) : 0;
      card.style.transform = `translateX(${r2(shake)}px)`;
    }
  }

  // ----------------------------------------------------------- catalog

  // The GPU server's drawing goes through a few styles, then a new rack type grows taller.
  const FACE_STEPS = [[0, 'gpu'], [0.75, 'storage'], [1.05, 'jbod'], [1.35, 'compute'], [1.65, 'gpu']];
  const RACK_TAB = 2.15;
  const GROW = [2.45, 0.6, 42, 52]; // start, seconds, from and to units
  const MORE_SLOTS = 3.15;
  const CLOSE = 3.45;
  const NEW_RACK = { id: 'rt-vid', name: 'Hall 3 rack', powerW: 15000, weightKg: 1200 };
  const GPU = M.typeOf(FINAL, 'gpu-server');
  const cat = {};
  const svgOf = (sc, w, h) => `<svg viewBox="0 0 ${sc.width} ${sc.height}" width="${r2(w)}" height="${r2(h || (w * sc.height) / sc.width)}">${sc.body}</svg>`;
  const chevron = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';
  const field = (label, value, cls, id) => `<div class="field ${cls || ''}"><label>${label}</label><div class="in"${id ? ` id="${id}"` : ''}>${value}</div></div>`;
  const catItem = (thumb, label, spec, n, sel) =>
    `<div class="cat-item${sel ? ' sel' : ''}"><span class="thumb">${thumb}</span><span><b>${label}</b><small>${spec}</small></span><span class="n">${n}</span></div>`;
  const rackIcon = `<svg viewBox="0 0 20 32" width="20" height="32"><rect x="1" y="1" width="18" height="30" rx="2" fill="${T.frame}"/><rect x="4" y="4" width="12" height="24" fill="${T.slotA}"/><path d="M4 9h12M4 14h12M4 19h12M4 24h12" stroke="${T.slotB}"/></svg>`;

  /** A plan with a single rack of the new type, `units` high, to draw it. */
  function rackPlan(units, sideSlots) {
    return Object.assign({}, example, {
      rackTypes: example.rackTypes.concat([Object.assign({}, NEW_RACK, { units, sideSlots })]),
      floors: [{ id: 'fv', name: 'Hall 3', rows: [{ id: 'rv', name: 'Row C', racks: [{ id: 'rv1', name: 'Rack C01', type: NEW_RACK.id }] }] }],
      devices: [],
    });
  }

  function buildCatalog() {
    const counts = new Map();
    for (const d of FINAL.devices) counts.set(d.type, (counts.get(d.type) || 0) + 1);
    $('#devList').innerHTML = FINAL.deviceTypes
      .map((t) => catItem(svgOf(R.renderPreview(t, THEME, null, t.defaultName, measure), 72), t.label, M.formatTypeSpec(t), counts.get(t.id) || 0, t.id === GPU.id))
      .join('');
    const racks = M.allRacks(FINAL).map((r) => r.rack);
    $('#rackList').innerHTML = FINAL.rackTypes
      .concat([Object.assign({ units: GROW[2] }, NEW_RACK)])
      .map((t) => catItem(rackIcon, t.name, `${t.units}U · ${kw(t.powerW)} kW`, racks.filter((r) => r.type === t.id).length, t.id === NEW_RACK.id))
      .join('');
    $('#devForm').innerHTML =
      `<div class="cat-preview" id="devPreview"></div><div class="fields">` +
      field('Name', GPU.label, 'span2') +
      field('Tag on the front', GPU.tag) +
      field('Height (U)', GPU.height) +
      field('Drawing', `<span id="faceName"></span>${chevron}`, 'span2', 'faceField') +
      field('Power (W)', GPU.powerW) +
      field('Weight (kg)', GPU.weightKg) +
      `</div>`;
    $('#rackForm').innerHTML =
      `<div class="rack-form"><div><div class="fields">` +
      field('Name', NEW_RACK.name, 'span2') +
      field('Height (U)', '<span id="rkUnits"></span>', '', 'unitsField') +
      field('Side slots', '<span id="rkSlots"></span>', '', 'slotsField') +
      field('Power budget (kW)', NEW_RACK.powerW / 1000) +
      field('Max. load (kg)', NEW_RACK.weightKg) +
      `</div><p class="note" id="rkNote"></p></div><div class="cat-preview" id="rackPreview"></div></div>`;
    cat.rkSpec = $('#rackList .cat-item:last-child small');
    for (const id of ['scrim', 'catalog', 'devList', 'rackList', 'devForm', 'rackForm', 'tabDev', 'tabRack', 'devPreview', 'faceName', 'faceField', 'rackPreview', 'rkUnits', 'rkSlots', 'rkNote', 'unitsField', 'slotsField', 'catDone']) cat[id] = $(`#${id}`);
  }

  function drawCatalog(t) {
    const s = t - CATALOG;
    const open = prog(s, 0, 0.45, ease.expo);
    const close = prog(s, CLOSE, 0.3, ease.in);
    const on = s > 0 && close < 1;
    fade(cat.scrim, on ? open * (1 - close) : 0);
    fade(cat.catalog, on ? clamp(open * 1.5) * (1 - close) : 0);
    if (!on) return;
    cat.catalog.style.transform = `translateY(${r2((1 - open) * 50 + close * 30)}px) scale(${r2(0.97 + 0.03 * open)})`;

    // Device types: the drawing style changes and the preview follows.
    const step = FACE_STEPS.filter(([at]) => s >= at).pop();
    if (cat.face !== step[1]) {
      cat.face = step[1];
      const pv = R.renderPreview(Object.assign({}, GPU, { face: step[1] }), THEME, '#2f6fdb', GPU.defaultName, measure);
      cat.devPreview.innerHTML = svgOf(pv, 384);
      cat.faceName.textContent = M.FACES.find((f) => f.id === step[1]).label;
    }
    const changed = step[0] > 0 ? prog(s, step[0], 0.3, ease.expo) : 1;
    cat.faceField.classList.toggle('focus', step[0] > 0 && s - step[0] < 0.3);
    cat.devPreview.firstChild.style.transform = `scale(${r2(0.94 + 0.06 * changed)})`;
    cat.devPreview.firstChild.style.opacity = r2(0.3 + 0.7 * changed);

    // Rack types: a new type grows from 42U to 52U and gains a side slot.
    const tab = prog(s, RACK_TAB, 0.3, ease.inOut);
    fade(cat.devList, 1 - tab);
    fade(cat.devForm, 1 - tab);
    fade(cat.rackList, tab);
    fade(cat.rackForm, tab);
    cat.rackForm.style.transform = `translateX(${r2((1 - tab) * 30)}px)`;
    cat.tabDev.classList.toggle('on', s < RACK_TAB);
    cat.tabRack.classList.toggle('on', s >= RACK_TAB);
    const units = Math.round(lerp(GROW[2], GROW[3], prog(s, GROW[0], GROW[1], ease.inOut)));
    const slots = s >= MORE_SLOTS ? 3 : 2;
    const key = `${units}/${slots}`;
    if (tab > 0 && cat.rackKey !== key) {
      cat.rackKey = key;
      const sc = R.renderScene(rackPlan(units, slots), { rowId: 'rv', theme: THEME, measure });
      // Fixed scale and top edge, so the rack visibly grows; cut below the rack's feet.
      const vb = { x: 18, y: 26, w: 364, h: 1150 };
      const feet = sc.layout.rackBottom + 14;
      cat.rackPreview.innerHTML =
        `<svg viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" width="${r2((500 * vb.w) / vb.h)}" height="500">` +
        `<defs><clipPath id="rk-clip"><rect x="0" y="0" width="${vb.x + vb.w}" height="${feet}"/></clipPath></defs><g clip-path="url(#rk-clip)">${sc.body}</g></svg>`;
      cat.rkSpec.textContent = `${units}U · ${kw(NEW_RACK.powerW)} kW`;
      cat.rkUnits.textContent = units;
      cat.rkSlots.textContent = slots;
      const max = M.maxSideSlots(units);
      cat.rkNote.textContent = `Up to ${max} side slot${max === 1 ? '' : 's'} fit a ${units}U rack. A budget of 0 means none; racks over their budget are flagged in red.`;
    }
    cat.unitsField.classList.toggle('focus', s >= GROW[0] - 0.1 && s < GROW[0] + GROW[1] + 0.15);
    cat.slotsField.classList.toggle('focus', s >= MORE_SLOTS - 0.1 && s < MORE_SLOTS + 0.25);
    const press = s >= CLOSE - 0.15;
    cat.catDone.style.transform = press ? 'scale(0.94)' : '';
  }

  // ------------------------------------------------------ share, export

  // The export menu opens; each pick drops its file on the desk, the last copies a link.
  const MENU = [
    ['PNG image', 'This row, for docs, tickets and chat'],
    ['SVG drawing', 'This row, opens in vector editors'],
    ['Print or PDF…', 'One sheet per row, with title blocks'],
    ['CSV inventory', 'Every device with location and fields'],
    null,
    ['Plan file (.json)', 'Re-open it later with Open'],
    ['Copy plan as JSON', 'Paste it into Open elsewhere'],
    ['Share link…', 'The plan travels inside the link'],
  ];
  const PICKS = [[0.3, 0], [0.65, 2], [1.0, 3], [1.35, 7]];
  const MENU_CLOSE = 1.6;
  const LINK_IN = 1.75;
  const COPIED = 2.6;
  const share = { outputs: [] };
  const base = M.slug(FINAL.name);

  function buildShare() {
    share.menu = $('#menu');
    share.menu.innerHTML = MENU.map((m) => (m ? `<div class="mi"><b>${m[0]}</b><small>${m[1]}</small></div>` : '<hr>')).join('');
    share.items = [...share.menu.children].filter((e) => e.classList.contains('mi'));
    const sheet = (rowId, index) => {
      const sc = R.renderScene(FINAL, { rowId, theme: 'light', measure, date: DATE, sheet: { index, count: 3 } });
      return { html: svgOf(sc, 470), w: 470, h: Math.round((470 * sc.height) / sc.width) };
    };
    const rows = IO.parseCSV(IO.toCSV(FINAL));
    const cols = ['Rack', 'Position', 'Name', 'Type', 'Cluster'].map((c) => rows[0].indexOf(c));
    const csv = {
      html: `<div class="csv"><table><tr>${cols.map((i) => `<th>${rows[0][i]}</th>`).join('')}</tr>${rows
        .slice(1, 11)
        .map((r) => `<tr>${cols.map((i) => `<td>${r[i]}</td>`).join('')}</tr>`)
        .join('')}</table></div>`,
      w: 560,
      h: 322,
    };
    const specs = [
      Object.assign(sheet('row2', 1), { label: `${base}-ground-floor-row-b.png`, cx: 1105, cy: 560, rot: -6, at: 0.5 }),
      Object.assign(sheet('row1', 0), { label: 'Print or PDF · sheet 1 / 3', right: true, cx: 1335, cy: 585, rot: 3, at: 0.85 }),
      Object.assign(csv, { label: `${base}.csv`, cx: 1560, cy: 700, rot: 5, at: 1.2 }),
    ];
    for (const p of specs) {
      const el = make('div', 'paper abs', `${p.html}<span class="file${p.right ? ' right' : ''}">${p.label}</span>`);
      el.style.width = `${p.w}px`;
      el.style.height = `${p.h}px`;
      $('#papers').appendChild(el);
      share.outputs.push(Object.assign({ el }, p));
    }
    share.link = $('#link');
    share.url = $('#link .typed');
    share.copy = $('#copyLink');
    $('#link .size').textContent = `${share.href.length.toLocaleString('en')} characters.`;
  }

  function drawShare(t, inMain) {
    const s = t - SHARE;
    els.btnExport.classList.toggle('on', s > 0 && s < MENU_CLOSE + 0.1);
    const open = prog(s, 0.05, 0.25, ease.expo);
    const close = prog(s, MENU_CLOSE, 0.2, ease.in);
    fade(share.menu, inMain && s > 0 ? open * (1 - close) : 0);
    pose(share.menu, share.menuX, share.menuY + r2((1 - open) * -10), r2(0.96 + 0.04 * open));
    const pick = PICKS.filter(([at]) => s >= at).pop();
    // Menu items skip the separator in MENU.
    share.items.forEach((it, i) => it.classList.toggle('hot', !!pick && pick[1] === (i < 4 ? i : i + 1)));
    for (const p of share.outputs) {
      const k = prog(s, p.at, 0.7, ease.out);
      const on = inMain && s >= p.at;
      fade(p.el, on ? 1 : 0);
      if (on) pose(p.el, r2(p.cx - p.w / 2), r2(p.cy - p.h / 2 + (1 - k) * 900), null, ` rotate(${r2(p.rot + (1 - k) * (p.rot > 0 ? 18 : -18))}deg)`);
    }
    const lk = prog(s, LINK_IN, 0.45, ease.expo);
    fade(share.link, inMain && s >= LINK_IN ? lk : 0);
    pose(share.link, 846, r2(792 + (1 - lk) * 50));
    share.url.textContent = share.href.slice(0, Math.round(lerp(0, 190, prog(s, LINK_IN + 0.1, 0.6, (k) => k))));
    share.copy.classList.toggle('on', s >= COPIED - 0.12);
    share.copy.style.transform = s >= COPIED - 0.12 && s < COPIED + 0.05 ? 'scale(0.94)' : '';
    const tk = prog(s, COPIED, 0.45, ease.back);
    fade(els.toast, inMain && s >= COPIED ? clamp(tk * 2) : 0);
    pose(els.toast, r2(PANEL.x + PANEL.w - els.toastW - 30), r2(PANEL.y + PANEL.h - 86 + (1 - tk) * 60));
  }

  // ------------------------------------------------------ closing page

  function buildOutro() {
    const strip = $('#strip');
    const stats = M.statsByRack(FINAL);
    const racks = M.allRacks(FINAL).map((r) => r.rack);
    for (const rack of racks) strip.appendChild(miniRack(FINAL, rack, stats, 3.4, false).box);
    $('#outro .scheme').textContent = URL_SCHEME;
    $('#outro .host').textContent = URL_HOST;
  }

  // -------------------------------------------------------- the brand

  const brand = $('#brand');
  const word = $('.word', brand);
  const letters = [];
  for (const ch of 'RACKPLANNER') letters.push(word.appendChild(make('span', null, ch)));
  const icon = { frame: $('#bFrame'), bars: [$('#bBar1'), $('#bBar2'), $('#bBar3')] };
  icon.frame.style.transformBox = 'fill-box';
  icon.frame.style.transformOrigin = '50% 100%';
  for (const b of icon.bars) {
    b.style.transformBox = 'fill-box';
    b.style.transformOrigin = '0% 50%';
  }
  let bw = 0;
  let bh = 0;

  function drawBrand(t, panelDx) {
    const start = t >= OUTRO ? OUTRO + 0.05 : 0.1;
    const center = (s, cy) => ({ x: 960 - (bw * s) / 2, y: cy - (bh * s) / 2, s });
    let p;
    if (t >= OUTRO) {
      const k = prog(t, OUTRO + 0.05, 0.6, ease.back);
      const c = center(1.5, 262);
      p = { x: c.x + (bw * 1.5 * (1 - (0.8 + 0.2 * k))) / 2, y: c.y, s: 1.5 * (0.8 + 0.2 * k) };
    } else {
      const a = center(2.2 + 0.12 * prog(t, 0, 1.95, ease.sine), 446);
      const b = { x: PANEL.x + 18 + panelDx, y: PANEL.y + 28 - (bh * BRAND_TB) / 2, s: BRAND_TB };
      const k = prog(t, 1.95, 0.75, ease.inOut);
      p = { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), s: lerp(a.s, b.s, k) };
    }
    pose(brand, r2(p.x), r2(p.y), r2(p.s));
    fade(brand, t < 0.1 ? 0 : 1);
    const f = prog(t, start, 0.45, ease.back);
    icon.frame.style.transform = `scaleY(${f})`;
    icon.bars.forEach((b, i) => (b.style.transform = `scaleX(${prog(t, start + 0.25 + i * 0.1, 0.35, ease.expo)})`));
    letters.forEach((l, i) => {
      const k = prog(t, start + 0.3 + i * 0.035, 0.5, ease.expo);
      l.style.transform = `translateY(${(1 - k) * 36}px)`;
      l.style.opacity = clamp(k * 1.4);
    });
  }

  // ------------------------------------------------------------ frame

  const els = {};
  function render(t) {
    // Backdrop: graph paper drifting slowly.
    pose(els.grid, r2(-t * 7), r2(-t * 4), 1 + 0.04 * (1 - prog(t, 0, 2.4, ease.inOut)));
    els.grid.style.opacity = prog(t, 0, 0.8);

    // Intro tagline.
    const tagIn = prog(t, 0.95, 0.55);
    const tagOut = prog(t, 1.8, 0.35, ease.in);
    fade(els.tagline, tagIn * (1 - tagOut));
    pose(els.tagline, 0, r2(560 + (1 - tagIn) * 24 - tagOut * 20));
    const ul = prog(t, 1.05, 0.55, ease.expo);
    fade(els.underline, ul > 0 ? 1 - tagOut : 0);
    els.underline.style.width = '240px';
    pose(els.underline, 840, r2(648 - tagOut * 20), null, ` scaleX(${r2(ul)})`);

    // The app window slides in and stays until the closing page.
    const pin = prog(t, 1.95, 0.8, ease.expo);
    const panelDx = (1 - pin) * 300;
    const inMain = t < OUTRO;
    fade(els.panel, inMain ? pin : 0);
    pose(els.panel, r2(PANEL.x + panelDx), PANEL.y, r2(0.94 + 0.06 * pin));
    drawBrand(t, panelDx);

    if (inMain && t > 1.9) {
      // Row A, then Row B slides in.
      const slide = prog(t, 9.4, 0.45, ease.inOut);
      if (slide < 1) {
        drawRow(sheets.A, Math.min(t, 9.4), 'row1', track(CAM_A, t));
        sheets.A.svg.style.transform = `translateX(${r2(-SHEET_W * slide)}px)`;
      }
      fade(sheets.A.svg, slide < 1 ? 1 : 0);
      const mapIn = prog(t, 12.4, 0.3, ease.inOut);
      if (slide > 0 && mapIn < 1) {
        drawRow(sheets.B, t, 'row2', track(CAM_B, t));
        sheets.B.svg.style.transform = `translateX(${r2(SHEET_W * (1 - slide))}px) scale(${r2(1 - 0.3 * mapIn)})`;
      }
      fade(sheets.B.svg, slide > 0 ? 1 - mapIn : 0);
      fade(floorMap.el, prog(t, 12.6, 0.3, ease.inOut));
      if (t > 12.5) {
        floorMap.el.style.transform = `scale(${r2(1.12 - 0.12 * prog(t, 12.6, 0.6, ease.expo))})`;
        drawFloorMap(t);
      }
      // Toolbar follows: Row A → Row B, Elevation → Floor map.
      const rk = prog(t, 9.45, 0.35, ease.inOut);
      els.rowA.style.transform = `translateY(${-rk * 36}px)`;
      els.rowB.style.transform = `translateY(${(1 - rk) * 36}px)`;
      const map = t >= 12.55;
      els.segElev.classList.toggle('on', !map);
      els.segMap.classList.toggle('on', map);
    }

    for (const c of COPY) drawCopy(c, t);

    // The catalog dialog, then the export menu and its files.
    drawCatalog(inMain ? t : -1);
    drawShare(t, inMain);

    // Stripes in the logo's colors sweep across; the closing page is behind them.
    const wk = prog(t, WIPE, 1.0, ease.sine);
    const x = lerp(-4400, 2700, wk);
    const bands = [[els.bandY, x], [els.bandB, x - 300], [els.bandT, x - 300 - 200]];
    for (const [band, bx] of bands) {
      fade(band, wk > 0 && wk < 1 ? 1 : 0);
      pose(band, r2(bx), 0, null, ' skewX(-15deg)');
    }

    // The closing page.
    const outro = t >= OUTRO;
    fade(els.outro, outro ? 1 : 0);
    if (outro) drawOutro(t);
  }

  function drawOutro(t) {
    const zoom = 1 + 0.025 * prog(t, OUTRO, DURATION - OUTRO, ease.sine);
    els.outro.style.transformOrigin = '960px 540px';
    els.outro.style.transform = `scale(${r2(zoom * 1000) / 1000})`;
    const tryK = prog(t, OUTRO + 0.2, 0.6, ease.expo);
    els.try.style.opacity = tryK;
    pose(els.try, 0, r2(368 + (1 - tryK) * 40));
    const tape = prog(t, OUTRO + 0.4, 0.4, ease.expo);
    pose(els.urlWrap, r2(960 - els.urlW / 2), 492);
    els.url.style.clipPath = `inset(-10px ${r2((1 - tape) * 100)}% -10px -10px)`;
    const full = URL_SCHEME + URL_HOST;
    const n = clamp(Math.floor((t - OUTRO - 0.55) / 0.019), 0, full.length);
    els.scheme.textContent = full.slice(0, Math.min(n, URL_SCHEME.length));
    els.host.textContent = n > URL_SCHEME.length ? full.slice(URL_SCHEME.length, n) : '';
    const typing = n < full.length;
    els.caret.style.opacity = typing || Math.floor((t - OUTRO - 0.55) * 2.2) % 2 === 0 ? 1 : 0;
    const nk = prog(t, OUTRO + 1.4, 0.6);
    els.note.style.opacity = nk;
    pose(els.note, 0, r2(668 + (1 - nk) * 20));
    pose(els.strip, r2(960 - els.stripW / 2), 845);
    [...els.strip.children].forEach((r, i) => {
      const k = prog(t, OUTRO + 0.15 + i * 0.06, 0.7, ease.expo);
      r.style.transform = `translateY(${r2((1 - k) * 260)}px)`;
      r.style.opacity = 0.55 * k;
    });
  }

  // ------------------------------------------------------------- setup

  async function init() {
    const faces = [];
    for (const f of ['Barlow', 'Barlow Condensed', 'IBM Plex Mono']) for (const w of [400, 500, 600]) faces.push(`${w} 20px "${f}"`);
    await Promise.all(faces.map((f) => document.fonts.load(f, 'Aa0·…›″').catch(() => null)));
    await document.fonts.ready;

    for (const id of ['grid', 'tagline', 'underline', 'panel', 'toast', 'outro', 'strip', 'urlWrap', 'bandY', 'bandB', 'bandT', 'rowA', 'rowB', 'segElev', 'segMap', 'btnExport']) els[id] = $(`#${id}`);
    share.href = `${URL_SCHEME}${URL_HOST}#plan=${await IO.encodeShare(FINAL)}`;
    els.try = $('#outro .try');
    els.note = $('#outro .note');
    els.url = $('#outro .url');
    els.scheme = $('#outro .scheme');
    els.host = $('#outro .host');
    els.caret = $('#outro .caret');

    buildFloorMap();
    buildCopy();
    buildCatalog();
    buildShare();
    buildOutro();

    // Sizes that need the fonts: the brand, the toolbar gap it sits in, the full URL tape, the toast.
    bw = brand.offsetWidth;
    bh = brand.offsetHeight;
    $('#tbBrandSpace').style.width = `${Math.round(bw * BRAND_TB) + 18}px`;
    els.scheme.textContent = URL_SCHEME;
    els.host.textContent = URL_HOST;
    els.urlW = els.url.offsetWidth;
    els.url.style.width = `${els.urlW}px`;
    els.toastW = els.toast.offsetWidth;
    // The export menu hangs below the Export button, right-aligned with it.
    const btn = els.btnExport.getBoundingClientRect();
    const panel = els.panel.getBoundingClientRect();
    share.menuX = PANEL.x + btn.right - panel.left - share.menu.offsetWidth;
    share.menuY = PANEL.y + btn.bottom - panel.top + 6;
    els.outro.style.visibility = 'visible';
    els.stripW = els.strip.offsetWidth;

    window.DURATION = DURATION;
    window.POSTER = 1.6; // the title card
    window.seek = render;
    window.introReady = true;

    const params = new URLSearchParams(location.search);
    if (params.has('render')) return;
    // Watching in a browser: fit the stage to the window and play (or hold ?t=).
    const stage = $('#stage');
    const fit = () => (stage.style.transform = `scale(${Math.min(innerWidth / 1920, innerHeight / 1080)})`);
    addEventListener('resize', fit);
    fit();
    if (params.has('t')) return render(Number(params.get('t')) || 0);
    const t0 = performance.now();
    const tick = (now) => {
      render(((now - t0) / 1000) % DURATION);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  init();
})();
