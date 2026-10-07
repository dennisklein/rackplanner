/*
 * Rackplanner cabling: mockups of the proposed views, drawn into the running
 * app for screenshots (see shoot.js). Not part of the app: nothing here is
 * wired to undo, saving or input; it only shows what each approach looks like
 * with the example plan's real ports and cables (prototype.js).
 */
(function () {
  'use strict';
  const M = RP.model;
  const R = RP.render;
  const C = RP.cabling;
  const esc = R.esc;
  const $ = (s, r) => (r || document).querySelector(s);
  const icon = (n, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const r1 = (v) => Math.round(v * 100) / 100;
  const theme = () => (RP.app.ui.theme === 'dark' ? 'dark' : 'light');
  const ctx = document.createElement('canvas').getContext('2d');
  const measure = (t, css) => ((ctx.font = css), ctx.measureText(t).width);
  const F = R.FONTS;
  const text = (x, y, s, font, fill, extra) =>
    `<text x="${r1(x)}" y="${r1(y)}" font-family="${font.family}" font-size="${font.size}" font-weight="${font.weight}" fill="${fill}"${extra || ''}>${esc(s)}</text>`;
  const font = (size, weight, family) => ({ size, weight, family: family || F.name.family, css: `${weight} ${size}px ${family || F.name.family}` });
  const MONO = (size, weight) => font(size, weight || 500);
  const UI = (size, weight) => font(size, weight || 500, F.legend.family);

  // Icons the cabling views add to the app's sprite.
  const SYMBOLS = {
    cable: '<path d="M5 3v3M9 3v3"/><path d="M3 6h8v3a4 4 0 0 1-8 0z"/><path d="M7 13v2.5a4.5 4.5 0 0 0 9 0V9a3 3 0 0 1 6 0"/>',
    ports: '<rect x="2.5" y="6.5" width="19" height="11" rx="1.5"/><path d="M6 10h2.5v4H6zM10.75 10h2.5v4h-2.5zM15.5 10H18v4h-2.5z"/>',
    table: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
    fabric: '<rect x="9" y="3" width="6" height="4" rx="1"/><rect x="3" y="17" width="5" height="4" rx="1"/><rect x="9.5" y="17" width="5" height="4" rx="1"/><rect x="16" y="17" width="5" height="4" rx="1"/><path d="M12 7v10M10.5 7 5.5 17M13.5 7l5 10"/>',
    trace: '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h6a3 3 0 0 1 0 6h-2a3 3 0 0 0 0 6h6"/>',
    warn: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 16.8v.2"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
    unplug: '<path d="M8 8 4 4M20 20l-4-4"/><path d="m6.5 13.5 4 4-2 2a2.8 2.8 0 0 1-4-4z"/><path d="m17.5 10.5-4-4 2-2a2.8 2.8 0 0 1 4 4z"/><path d="m10 10-1.5 1.5M14 14l-1.5 1.5"/>',
    swap: '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>',
    filter: '<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>',
    front: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M8 9h8M8 13h8"/>',
  };
  function addSymbols() {
    const sprite = $('.sprite');
    for (const [id, body] of Object.entries(SYMBOLS)) {
      if (!document.getElementById('i-' + id)) sprite.insertAdjacentHTML('beforeend', `<symbol id="i-${id}" viewBox="0 0 24 24">${body}</symbol>`);
    }
  }

  // ----------------------------------------------------------------- data

  function plan(mutate) {
    const p = M.clone(RP.app.project());
    C.addExampleCabling(p);
    if (mutate) mutate(p);
    return p;
  }
  const dev = (p, name) => p.devices.find((d) => d.name === name);
  const netOf = (p, id) => p.networks.find((n) => n.id === id) || null;
  const netColor = (p, id) => (netOf(p, id) || { color: '#8c96a3' }).color;
  const fam = (connector) => C.conn(connector).family;
  const shortRack = (name) => name.replace(/^Rack\s+/i, '');
  function where(p, d) {
    const pos = M.locateRack(p, d.loc.rack);
    const at = d.loc.kind === 'side' ? `V${d.loc.at + 1}` : (() => {
      const [a, b] = M.deviceSpan(p, d);
      return a === b ? `U${a}` : `U${a}–${b}`;
    })();
    return { rack: pos.rack, row: pos.row, floor: pos.floor, text: `${shortRack(pos.rack.name)} · ${at}` };
  }
  const endName = (p, e) => `${M.deviceById(p, e.device).name} · ${e.port}${e.side ? ` (${e.side})` : ''}`;
  const SHORT = { cat6a: 'Cat6a', dac: 'DAC', aoc: 'AOC', sas: 'SAS', om4: 'OM4', os2: 'OS2' };
  const shortType = (ct) => (ct ? SHORT[ct.media] || ct.name : '?');
  const isSwitch = (p, d) => C.portsOf(p, d).length > 12 && !C.portsOf(p, d)[0].passThrough;

  /** Cables with an end in one of `rackIds`. */
  const cablesIn = (p, rackIds) =>
    p.cables.filter((c) => rackIds.has(M.deviceById(p, c.a.device).loc.rack) || rackIds.has(M.deviceById(p, c.b.device).loc.rack));

  // ---------------------------------------------------------------- shell

  const VIEWS = [
    { id: 'elevation', label: 'Elevation', icon: 'rack', title: 'Racks from the rear with ports and cable runs' },
    { id: 'ports', label: 'Port map', icon: 'ports', title: 'Faceplates of the selected devices with what each port connects to' },
    { id: 'schedule', label: 'Schedule', icon: 'table', title: 'Every cable as a table, with lengths and what to order' },
    { id: 'fabric', label: 'Fabric', icon: 'fabric', title: 'How switches and nodes connect, per network' },
  ];

  /** Switches the app into the cabling workspace and returns an empty host for the view. */
  function shell(view, p) {
    addSymbols();
    document.documentElement.classList.add('cab-mode');
    if (!$('.mode-switch')) {
      $('.plan-name-wrap').insertAdjacentHTML(
        'afterend',
        `<div class="seg mode-switch" role="group" aria-label="Workspace">` +
          `<button type="button" aria-pressed="false" title="Racks and devices">${icon('rack', 'ic-sm')}Racks</button>` +
          `<button type="button" aria-pressed="true" title="Ports and cables">${icon('cable', 'ic-sm')}Cabling</button></div>`
      );
    }
    $('#search').placeholder = 'Search devices, ports, cables';
    $('.view-toggle').innerHTML = VIEWS.map((v) => `<button type="button" aria-pressed="${v.id === view}" title="${esc(v.title)}">${icon(v.icon, 'ic-sm')}${v.label}</button>`).join('');
    $('#example-notice').hidden = true;
    $('#scene').setAttribute('hidden', '');
    $('#floormap').hidden = true;
    $('#armed-hint').hidden = true;
    for (const n of document.querySelectorAll('.cab-float')) n.remove();
    let host = $('#cab-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'cab-host';
      $('#canvas').appendChild(host);
    }
    host.innerHTML = '';
    $('#canvas').className = `canvas cab-canvas cab-${view}`;
    $('#zoom').hidden = view !== 'elevation';
    renderBin(p);
    return host;
  }

  // ------------------------------------------------------------ left panel

  const JACKET = { cat6a: '#5f86b3', dac: '#2d3339', aoc: '#e2a23b', sas: '#3c4249', om4: '#3fb7c9', os2: '#e3c43c' };

  /** Small drawing of a cable: two plugs and a loop of cord. */
  function cableArt(ct) {
    const t = theme();
    const cord = ct ? JACKET[ct.media] : t === 'dark' ? '#8e99a6' : '#9aa5b1';
    const metal = t === 'dark' ? '#77818c' : '#c3cad2';
    const ink = t === 'dark' ? '#0d1115' : '#2a3038';
    const f = ct ? fam(ct.connector) : 'auto';
    const plug = (x, dir) => {
      const g = dir < 0 ? `translate(${x} 0) scale(-1 1)` : `translate(${x} 0)`;
      let s;
      if (f === 'rj45') s = `<path d="M0 16h12l4 2v8l-4 2H0z" fill="${cord}"/><rect x="16" y="17" width="12" height="10" rx="1" fill="${metal}" stroke="${ink}" stroke-width=".8"/><path d="M19 17v-3h6v3" fill="none" stroke="${ink}" stroke-width=".8"/>`;
      else if (f === 'auto') s = `<rect x="0" y="16" width="26" height="12" rx="2" fill="none" stroke="${cord}" stroke-width="1.2" stroke-dasharray="3 2"/>`;
      else s = `<rect x="0" y="16.5" width="10" height="11" rx="2" fill="${cord}"/><rect x="9" y="15" width="22" height="14" rx="1.5" fill="${metal}" stroke="${ink}" stroke-width=".8"/><path d="M13 20h14M13 24h14" stroke="${ink}" stroke-width=".7" opacity=".5"/><path d="M0 22h-6" stroke="${f === 'sas' ? '#8a5cd6' : '#2f6fdb'}" stroke-width="2.5" stroke-linecap="round"/>`;
      return `<g transform="${g}">${s}</g>`;
    };
    const loop = `<path d="M40 22 C 62 4, 82 4, 94 22 S 128 40, 148 22" fill="none" stroke="${cord}" stroke-width="${f === 'rj45' ? 3 : 4}" stroke-linecap="round"${f === 'auto' ? ' stroke-dasharray="5 4"' : ''}/>`;
    return `<svg viewBox="0 0 188 44" width="188" height="44">${loop}${plug(40, -1)}${plug(148, 1)}</svg>`;
  }

  function renderBin(p) {
    const counts = new Map();
    for (const c of p.cables) {
      const d = C.describe(p, c);
      if (d.type) counts.set(d.type.id, (counts.get(d.type.id) || 0) + 1);
    }
    const lengths = (ct) => `${C.fmtM(ct.lengthsM[0]).replace(' m', '')}–${C.fmtM(ct.lengthsM[ct.lengthsM.length - 1])}`;
    const parts =
      `<div class="part is-armed cab-part" title="Pick a cable type by the ports' connectors and the length">` +
      `<div class="part-art">${cableArt(null)}</div><div class="part-meta"><span class="part-name">Auto</span><span class="part-spec">by connectors and length</span></div></div>` +
      p.cableTypes
        .map(
          (ct) =>
            `<div class="part cab-part"><div class="part-art">${cableArt(ct)}</div><div class="part-meta"><span class="part-name">${esc(ct.name)}</span>` +
            `<span class="part-spec">${esc(`${C.conn(ct.connector).label} · ${lengths(ct)}`)}</span></div>` +
            `<span class="part-count${counts.get(ct.id) ? '' : ' is-zero'}">${counts.get(ct.id) || 0}</span></div>`
        )
        .join('');
    const nets = p.networks
      .map((n) => {
        const k = p.cables.filter((c) => c.network === n.id).length;
        return `<li class="cl-row"><button type="button" class="cl-main" aria-pressed="false"><span class="sw sw-net" style="--c:${n.color}"></span><span class="cl-name">${esc(n.name)}</span><span class="cl-count">${k}</span></button></li>`;
      })
      .join('');
    const free = p.devices.reduce((a, d) => a + C.portsOf(p, d).length, 0) - 2 * p.cables.length;
    $('.bin').innerHTML =
      `<section class="panel-sec bin-parts"><div class="sec-head"><h2>Cables</h2>` +
      `<button class="btn sm subtle" type="button">${icon('book')}<span>Catalog</span></button></div>` +
      `<p class="sec-hint">Pick a cable, then click two ports. Or drag from one port to another.</p>` +
      `<div class="parts">${parts}</div></section>` +
      `<section class="panel-sec bin-clusters"><div class="sec-head"><h2>Networks</h2>` +
      `<button class="btn icon sm" type="button" aria-label="New network">${icon('plus')}</button></div>` +
      `<ul class="clusters">${nets}</ul>` +
      `<p class="sec-hint">Click a network to show only its cables. ${free} ports are still free.</p></section>`;
  }

  // ------------------------------------------------- device ports (drawing)

  const G = { U: 22, BAY: 300, RAIL: 12, MGR: 46, FRAME: 8, GAP: 26, MX: 34, EAR: 9 };
  G.RW = 2 * (G.FRAME + G.MGR + G.RAIL) + G.BAY;
  G.SLOT = 12 * G.U;
  G.SLOT_W = 20;

  const DENSE = { rj45: [6.6, 6.4], sfp: [9, 5.6], qsfp: [12.6, 6.6], osfp: [13.6, 7], sas: [11, 6], lc: [7, 5], mpo: [10, 5] };
  const SPARSE = { rj45: [9, 8], sfp: [11.5, 6.5], qsfp: [17, 8], osfp: [18, 8.5], sas: [14, 7.5], lc: [9, 6], mpo: [12, 6] };

  /**
   * Where the ports of `type` on `side` sit on its face, `len` px wide and
   * `hU` units tall: switches and patch panels in two rows (odd ports on
   * top), servers in one row along their lowest unit.
   */
  function layoutPorts(type, side, hU, len) {
    const all = C.expandPorts(type).filter((pt) => pt.side === side || pt.passThrough);
    if (!all.length) return { ports: [], dense: false };
    const dense = all.length > 12;
    const out = [];
    if (dense) {
      const groups = [];
      for (const pt of all) (groups[pt.group] = groups[pt.group] || []).push(pt);
      const list = groups.filter(Boolean);
      const gap = 1.4;
      const block = 3.6;
      const widthOf = (g) => {
        const [w] = DENSE[fam(g[0].connector)];
        const cols = Math.ceil(g.length / 2);
        return cols * w + (cols - 1) * gap + Math.floor((cols - 1) / 6) * block;
      };
      const x0 = 76;
      const total = list.reduce((a, g) => a + widthOf(g), 0) + (list.length - 1) * 8;
      const k = Math.min(1, (len - 10 - x0) / total);
      let x = x0;
      for (const g of list) {
        const [w, h] = DENSE[fam(g[0].connector)];
        g.forEach((pt, i) => {
          const c = Math.floor(i / 2);
          const top = i % 2 === 0;
          const px = x + (c * (w + gap) + Math.floor(c / 6) * block) * k;
          out.push(Object.assign({}, pt, { x: px, y: top ? 3.2 : G.U - 3.2 - h, w: w * k, h, exit: top ? 'up' : 'down' }));
        });
        x += (widthOf(g) + 8) * k;
      }
    } else {
      const sorted = all.filter((pt) => fam(pt.connector) === 'rj45').concat(all.filter((pt) => fam(pt.connector) !== 'rj45'));
      let x = hU >= 2 ? 72 : 104;
      let last = null;
      for (const pt of sorted) {
        const [w, h] = SPARSE[fam(pt.connector)];
        if (last !== null) x += last === pt.group ? 4 : 9;
        out.push(Object.assign({}, pt, { x, y: hU * G.U - G.U / 2 - h / 2, w, h, exit: 'down' }));
        x += w;
        last = pt.group;
      }
    }
    return { ports: out, dense };
  }

  function portColors(t) {
    return t === 'dark'
      ? { hole: '#0b0e12', metal: '#6b7480', metalEdge: '#2a3038', free: '#3a434d' }
      : { hole: '#262c33', metal: '#bcc4cd', metalEdge: '#7d8894', free: '#c9d0d7' };
  }

  /** One port: an RJ45 jack or a cage, filled with the network's color when cabled. */
  function portShape(pt, color, t) {
    const pc = portColors(t);
    const f = fam(pt.connector);
    if (f === 'rj45') {
      const notch = pt.exit === 'up' ? `M${r1(pt.x + pt.w * 0.3)} ${r1(pt.y + pt.h)}h${r1(pt.w * 0.4)}v-1.4h${r1(-pt.w * 0.4)}z` : `M${r1(pt.x + pt.w * 0.3)} ${r1(pt.y)}h${r1(pt.w * 0.4)}v1.4h${r1(-pt.w * 0.4)}z`;
      return (
        `<rect x="${r1(pt.x)}" y="${r1(pt.y)}" width="${r1(pt.w)}" height="${r1(pt.h)}" rx=".6" fill="${color || pc.hole}"${color ? ` stroke="${R.mix(color, '#000000', 0.35)}" stroke-width=".6"` : ''}/>` +
        `<path d="${notch}" fill="${color ? R.mix(color, '#000000', 0.45) : pc.free}"/>`
      );
    }
    const inset = Math.min(1.5, pt.w * 0.14);
    return (
      `<rect x="${r1(pt.x)}" y="${r1(pt.y)}" width="${r1(pt.w)}" height="${r1(pt.h)}" rx=".8" fill="${pc.metal}" stroke="${pc.metalEdge}" stroke-width=".6"/>` +
      `<rect x="${r1(pt.x + inset)}" y="${r1(pt.y + inset)}" width="${r1(pt.w - 2 * inset)}" height="${r1(pt.h - 2 * inset)}" rx=".4" fill="${color || pc.hole}"/>`
    );
  }

  /** Rear (or front) of a device in local coordinates, `len` wide; returns body and port layout. */
  function deviceRear(p, type, name, cluster, hU, len, side, t) {
    const T = R.THEMES[t];
    const base = cluster ? cluster.color : T.unassigned;
    const sc = R.schemeFor(base, t);
    const face = R.mix(T.faceBase, base, t === 'dark' ? 0.14 : 0.07);
    const h = hU * G.U;
    const lay = layoutPorts(type, side, hU, len);
    let s = `<rect x=".5" y=".5" width="${len - 1}" height="${h - 1}" rx="2" fill="${face}"/>`;
    s += `<rect x=".5" y=".5" width="4" height="${h - 1}" fill="${base}"/>`;
    // Power supplies in the top right corner of servers, out of the way of the cables.
    if (!lay.dense && type.face !== 'patch' && type.face !== 'pdu') {
      const pw = 26;
      const ph = Math.min(15, h - 6);
      for (let k = 0; k < 2; k++) {
        const x = len - 8 - (2 - k) * (pw + 3);
        const y = hU === 1 ? (h - ph) / 2 : 4;
        s += `<rect x="${x}" y="${y}" width="${pw}" height="${ph}" rx="1" fill="${R.mix(face, T.deep, 0.12)}" stroke="${sc.edge}" stroke-width=".5"/>`;
        s += `<path d="${[5, 9, 13, 17].map((dx) => `M${x + dx} ${y + 3}v${ph - 6}`).join('')}" stroke="${sc.edge}" stroke-width=".7" opacity=".55"/>`;
        s += `<circle cx="${x + pw - 4}" cy="${y + ph / 2}" r="1.3" fill="${T.led}"/>`;
      }
    }
    const nameFont = hU === 1 ? MONO(lay.dense ? 9.5 : 10.5) : MONO(11.5, 600);
    const labelMax = (lay.dense ? 76 : hU >= 2 ? len - 80 : 100) - 12;
    if (hU === 1) s += text(10, h / 2 + 3.6, R.fitText(name, nameFont, labelMax, measure), nameFont, sc.text);
    else {
      const shown = R.fitText(name, nameFont, labelMax, measure);
      s += text(10, 15, shown, nameFont, sc.text);
      s += text(18 + measure(shown, nameFont.css), 14.5, `${type.tag} · ${hU}U`, F.tag, sc.sub, ' letter-spacing="0.8"');
    }
    s += `<rect x=".5" y=".5" width="${len - 1}" height="${h - 1}" rx="2" fill="none" stroke="${sc.edge}"/>`;
    return { body: s, ports: lay.ports, dense: lay.dense };
  }

  // ---------------------------------------- approach A: cabling elevation

  function sheetDefs(T, t) {
    return (
      `<defs><pattern id="cg-${t}" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="${T.grid}" stroke-width=".6"/></pattern>` +
      `<pattern id="cg5-${t}" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="${T.gridMajor}" stroke-width=".8"/></pattern>` +
      `<marker id="arrow-${t}" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" fill="${T.ink2}"/></marker></defs>`
    );
  }
  function paper(w, h, T, t) {
    return (
      `<rect width="${w}" height="${h}" fill="${T.paper}"/><rect width="${w}" height="${h}" fill="url(#cg-${t})"/><rect width="${w}" height="${h}" fill="url(#cg5-${t})"/>` +
      `<rect x="10.5" y="10.5" width="${w - 21}" height="${h - 21}" fill="none" stroke="${T.border}"/>`
    );
  }

  /**
   * A row seen from the rear: racks right to left, their side slots on the
   * left, every device's rear ports, and cables routed down the cable
   * managers, along the tray above the racks, and out to other rows.
   */
  function cablingElevation(p, rowId, o) {
    const t = theme();
    const T = R.THEMES[t];
    const pos = M.locateRow(p, rowId);
    const racks = pos.row.racks.slice().reverse();
    const units = racks.map((r) => M.rackUnits(p, r));
    const maxU = Math.max(...units);
    const TITLE_Y = 40;
    const TRAY_Y = 64;
    const TRAY_H = 44;
    const HEAD = 56;
    const uBottom = TRAY_Y + TRAY_H + HEAD + G.FRAME + maxU * G.U;
    const EXIT_W = 132;
    const width = G.MX * 2 + racks.length * G.RW + (racks.length - 1) * G.GAP + EXIT_W;
    const height = uBottom + G.FRAME + 96;
    const nets = p.networks.map((n) => n.id);
    const copper = new Set(['n-mgmt', 'n-bmc']);
    const lay = racks.map((rack, i) => {
      const x = G.MX + i * (G.RW + G.GAP);
      const uTop = uBottom - units[i] * G.U;
      return {
        rack,
        i,
        x,
        units: units[i],
        uTop,
        lmX: x + G.FRAME,
        bayX: x + G.FRAME + G.MGR + G.RAIL,
        rmX: x + G.FRAME + G.MGR + G.RAIL * 2 + G.BAY,
        slots: M.rackSideSlots(p, rack),
      };
    });
    const byRack = new Map(lay.map((l) => [l.rack.id, l]));
    const laneX = (l, net) => {
      const left = copper.has(net);
      const k = (left ? ['n-bmc', 'n-mgmt'] : ['n-ib', 'n-eth', 'n-sas']).indexOf(net);
      return left ? l.lmX + 30 + k * 8 : l.rmX + 8 + k * 8;
    };
    const trayLane = (net) => TRAY_Y + 9 + nets.indexOf(net) * 6.5;

    let s = sheetDefs(T, t) + paper(width, height, T, t);
    s += text(G.MX, TITLE_Y - 8, `${pos.row.name} · rear elevation`, F.title, T.ink);
    s += text(G.MX + measure(`${pos.row.name} · rear elevation`, F.title.css) + 12, TITLE_Y - 8, `seen from the hot aisle, so ${racks[0].name} is on the left`, F.legend, T.ink3);

    // Cable tray above the row.
    const trayX = G.MX - 8;
    const trayW = width - G.MX - trayX - EXIT_W + 30;
    s += `<rect x="${trayX}" y="${TRAY_Y}" width="${trayW}" height="${TRAY_H}" rx="3" fill="${T.slotB}" stroke="${T.slotDash}" stroke-dasharray="4 3"/>`;
    for (let x = trayX + 14; x < trayX + trayW - 4; x += 28) s += `<path d="M${x} ${TRAY_Y + 1}v${TRAY_H - 2}" stroke="${T.slotLine}" stroke-width="1.5"/>`;
    s += text(trayX + 6, TRAY_Y - 6, 'CABLE TRAY', F.cap, T.ink3, ' letter-spacing="1.2"');

    // Racks and devices; remember where every port is.
    const anchors = new Map();
    const devLayer = [];
    const stats = new Map();
    for (const l of lay) {
      const top = l.uTop - G.FRAME;
      const hgt = l.units * G.U + 2 * G.FRAME;
      s += `<rect x="${l.x}" y="${top}" width="${G.RW}" height="${hgt}" rx="3" fill="${T.frame}"/>`;
      for (const mx of [l.lmX, l.rmX]) {
        s += `<rect x="${mx}" y="${l.uTop}" width="${G.MGR}" height="${l.units * G.U}" fill="${T.channel}"/>`;
        let fingers = '';
        for (let u = 0; u <= l.units; u += 2) fingers += `M${mx + 4} ${l.uTop + u * G.U}h${G.MGR - 8}`;
        s += `<path d="${fingers}" stroke="${T.finger}" stroke-width="3" stroke-linecap="round"/>`;
      }
      for (const rx of [l.bayX - G.RAIL, l.bayX + G.BAY]) s += `<rect x="${rx}" y="${l.uTop}" width="${G.RAIL}" height="${l.units * G.U}" fill="${T.rail}"/>`;
      let slots = '';
      for (let u = 0; u < l.units; u++) {
        slots += `<rect x="${l.bayX}" y="${l.uTop + u * G.U}" width="${G.BAY}" height="${G.U}" fill="${u % 2 ? T.slotB : T.slotA}"/>`;
        slots += text(l.bayX - G.RAIL / 2, l.uTop + u * G.U + G.U / 2 + 3, String(u + 1), MONO(7.5), T.railText, ' text-anchor="middle"');
      }
      s += slots;
      const devs = p.devices.filter((d) => d.loc.rack === l.rack.id && d.type !== M.RESERVED.id);
      for (const d of devs) {
        const type = M.typeOf(p, d.type);
        const cl = M.clusterById(p, d.cluster);
        if (d.loc.kind === 'side') {
          const gap = (l.units * G.U - l.slots * G.SLOT) / (l.slots + 1);
          const y0 = l.uTop + gap + d.loc.at * (G.SLOT + gap);
          const x0 = l.lmX + 4;
          const f = deviceRear(p, type, d.name, cl, 1, G.SLOT, 'rear', t);
          // Rotated: local x runs bottom to top, local y left to right.
          devLayer.push({ d, svg: `<g transform="translate(${x0} ${r1(y0 + G.SLOT)}) rotate(-90)">${f.body}`, ports: f.ports, tf: (px, py) => [x0 + py, y0 + G.SLOT - px], close: '</g>' });
          for (const pt of f.ports) {
            const [cx, cy] = [x0 + pt.y + pt.h / 2, y0 + G.SLOT - (pt.x + pt.w / 2)];
            anchors.set(`${d.id}|${pt.name}|`, { d, pt, cx, cy, side: true, edgeX: x0 + G.SLOT_W, rack: l });
          }
        } else {
          const hU = M.deviceHeight(p, d);
          const y0 = l.uTop + (d.loc.at - 1) * G.U;
          const f = deviceRear(p, type, d.name, cl, hU, G.BAY, 'rear', t);
          devLayer.push({ d, svg: `<g transform="translate(${l.bayX} ${y0})">${f.body}`, ports: f.ports, close: '</g>' });
          for (const pt of f.ports) {
            const key = `${d.id}|${pt.name}|${pt.passThrough ? 'rear' : ''}`;
            anchors.set(key, { d, pt, cx: l.bayX + pt.x + pt.w / 2, cy: y0 + pt.y + pt.h / 2, top: y0, bottom: y0 + hU * G.U, rack: l, dense: f.dense });
          }
        }
      }
      // Rack label.
      const hy = l.uTop - G.FRAME - HEAD + 14;
      const name = l.rack.name;
      const tw = measure(name, F.tape.css) + 16;
      s += `<rect x="${l.bayX + 1}" y="${hy + 1}" width="${tw}" height="20" fill="${T.tapeShade}"/><rect x="${l.bayX}" y="${hy}" width="${tw}" height="20" fill="${T.tape}"/>`;
      s += text(l.bayX + 8, hy + 14, name, F.tape, T.tapeInk);
      stats.set(l.rack.id, { x: l.bayX + tw + 10, y: hy + 14 });
    }
    for (const dl of devLayer) s += dl.svg + dl.close;

    // Cables. Server ports send their cable up a little and then sideways
    // into the cable manager (copper left, the rest right); switch ports run
    // along the switch's edge; inside the manager every network has a lane.
    const sideOf = (net) => (copper.has(net) ? 'L' : 'R');
    const ends = [];
    for (const c of p.cables) {
      for (const e of [c.a, c.b]) {
        const E = anchors.get(`${e.device}|${e.port}|${e.side === 'rear' ? 'rear' : ''}`);
        if (E && !E.side && !E.dense) ends.push({ E, lr: sideOf(c.network) });
      }
    }
    const lift = new Map();
    const byDev = new Map();
    for (const x of ends) {
      const k = `${x.E.d.id}|${x.lr}`;
      if (!byDev.has(k)) byDev.set(k, []);
      byDev.get(k).push(x);
    }
    for (const list of byDev.values()) {
      list.sort((m, n) => (m.lr === 'L' ? m.E.cx - n.E.cx : n.E.cx - m.E.cx));
      list.forEach((x, k) => lift.set(x.E, 4 + k * 4));
    }
    const exits = new Map();
    const paths = [];
    const perRack = new Map();
    for (const c of p.cables) {
      const A = anchors.get(`${c.a.device}|${c.a.port}|${c.a.side === 'rear' ? 'rear' : ''}`);
      const B = anchors.get(`${c.b.device}|${c.b.port}|${c.b.side === 'rear' ? 'rear' : ''}`);
      if (!A && !B) continue;
      const net = c.network;
      const color = netColor(p, net);
      const hot = o.selected && (c.a.device === o.selected || c.b.device === o.selected);
      const leg = (E) => {
        const lx = laneX(E.rack, net);
        if (E.side) return { start: `M${r1(E.cx)} ${r1(E.cy)}H${r1(lx)}`, end: `H${r1(E.cx)}`, y: E.cy, lx };
        const y = E.dense ? (E.pt.exit === 'up' ? E.top + 1.6 : E.bottom - 1.6) : E.cy - E.pt.h / 2 - lift.get(E);
        return { start: `M${r1(E.cx)} ${r1(E.cy)}V${r1(y)}H${r1(lx)}`, end: `H${r1(E.cx)}V${r1(E.cy)}`, y, lx };
      };
      for (const id of new Set([A, B].filter(Boolean).map((E) => E.rack.rack.id))) perRack.set(id, (perRack.get(id) || 0) + 1);
      let d;
      if (A && B && A.rack === B.rack) {
        const a = leg(A);
        const b = leg(B);
        d = `${a.start}V${r1(b.y)}${b.end}`;
      } else if (A && B) {
        const a = leg(A);
        const b = leg(B);
        d = `${a.start}V${r1(trayLane(net))}H${r1(b.lx)}V${r1(b.y)}${b.end}`;
      } else {
        const E = A || B;
        const farRow = M.locateRack(p, M.deviceById(p, (A ? c.b : c.a).device).loc.rack).row;
        d = `${leg(E).start}V${r1(trayLane(net))}H${r1(width - G.MX - EXIT_W + 30)}`;
        if (!exits.has(farRow.id)) exits.set(farRow.id, { row: farRow, nets: new Map() });
        const e = exits.get(farRow.id);
        e.nets.set(net, (e.nets.get(net) || 0) + 1);
      }
      paths.push({ d, color, hot, c, A, B });
    }
    const dim = o.selected ? 0.45 : 1;
    for (const q of paths.filter((q) => !q.hot)) s += `<path d="${q.d}" fill="none" stroke="${q.color}" stroke-width="1.5" stroke-linejoin="round" opacity="${dim}"/>`;
    // Ports on top of the cables, cabled ones in their network's color.
    const idx = C.cableIndex(p);
    for (const dl of devLayer) {
      let ps = '';
      for (const pt of dl.ports) {
        const cab = idx.get(`${dl.d.id}|${pt.name}|${pt.passThrough ? 'rear' : ''}`);
        ps += portShape(pt, cab ? netColor(p, cab.network) : null, t);
      }
      s += dl.tf ? `<g transform="translate(${dl.tf(0, 0)[0]} ${dl.tf(0, 0)[1]}) rotate(-90)">${ps}</g>` : `<g transform="${/translate\([^)]*\)/.exec(dl.svg)[0]}">${ps}</g>`;
    }
    const hotPaths = paths.filter((q) => q.hot);
    for (const q of hotPaths) s += `<path d="${q.d}" fill="none" stroke="${T.paper}" stroke-width="5.5" stroke-linejoin="round" opacity=".9"/>`;
    for (const q of hotPaths) s += `<path d="${q.d}" fill="none" stroke="${q.color}" stroke-width="2.8" stroke-linejoin="round"/>`;
    // Name the far ends: switches at the top of a rack in the band above it, others next to the port.
    const band = new Map();
    for (const q of hotPaths) {
      for (const E of [q.A, q.B]) if (E) s += `<rect x="${r1(E.cx - 7)}" y="${r1(E.cy - 6.5)}" width="14" height="13" rx="2.5" fill="none" stroke="${T.handle}" stroke-width="2"/>`;
      const far = q.A && q.A.d.id === o.selected ? q.B : q.A;
      if (!far) continue;
      const label = `${far.d.name} · ${far.pt.name}`;
      const lw = measure(label, MONO(10, 600).css) + 10;
      let lx;
      let ly;
      if (!far.side && far.top < far.rack.uTop + 3 * G.U) {
        const prev = band.get(far.rack) || -Infinity;
        lx = Math.max(far.cx - lw / 2, prev + 6, far.rack.bayX);
        ly = far.rack.uTop - G.FRAME - 21;
        band.set(far.rack, lx + lw);
        s += `<path d="M${r1(far.cx)} ${r1(far.cy)}V${r1(far.rack.uTop - G.FRAME - 1)}H${r1(lx + lw / 2)}V${r1(ly + 16)}" fill="none" stroke="${T.select}" stroke-width="1.2"/>`;
      } else if (far.side) {
        lx = far.edgeX + 14;
        ly = far.cy - 8;
      } else {
        lx = Math.min(far.cx + 10, far.rack.rmX - lw - 4);
        ly = far.cy - far.pt.h / 2 - 24;
      }
      s += `<rect x="${r1(lx)}" y="${r1(ly)}" width="${r1(lw)}" height="16" rx="3" fill="${T.select}"/>`;
      s += text(lx + 5, ly + 11.5, label, MONO(10, 600), T.paper);
    }
    if (o.selected) {
      const d = M.deviceById(p, o.selected);
      const l = byRack.get(d.loc.rack);
      const y0 = l.uTop + (d.loc.at - 1) * G.U;
      const h = M.deviceHeight(p, d) * G.U;
      s += `<rect x="${l.bayX - 2}" y="${y0 - 2}" width="${G.BAY + 4}" height="${h + 4}" rx="3" fill="none" stroke="${T.select}" stroke-width="2"/>`;
    }
    for (const [rid, at] of stats) s += text(at.x, at.y, `${Math.round(perRack.get(rid) || 0)} cables`, F.stat, T.ink2);

    // Exits to other rows, at the end of the tray.
    let ey = TRAY_Y - 6;
    for (const e of exits.values()) {
      const ex = width - G.MX - EXIT_W + 34;
      const lines = [...e.nets.entries()];
      const bh = 24 + lines.length * 15;
      s += `<path d="M${ex - 4} ${TRAY_Y + TRAY_H / 2}h14" stroke="${T.ink2}" stroke-width="1.5" marker-end="url(#arrow-${t})"/>`;
      s += `<rect x="${ex + 16}" y="${ey}" width="${EXIT_W - 34}" height="${bh}" rx="4" fill="${T.paper}" stroke="${T.border}"/>`;
      s += text(ex + 24, ey + 16, `To ${e.row.name}`, UI(12, 600), T.ink);
      lines.forEach(([net, n], k) => {
        s += `<rect x="${ex + 24}" y="${ey + 25 + k * 15}" width="10" height="3" rx="1" fill="${netColor(p, net)}"/>`;
        s += text(ex + 40, ey + 30 + k * 15, `${n} ${netOf(p, net).name}`, UI(11), T.ink2);
      });
      ey += bh + 8;
    }

    // Floor line and legend.
    s += `<path d="M${G.MX - 8} ${uBottom + G.FRAME + 0.5}H${width - G.MX - EXIT_W + 30}" stroke="${T.ink2}" stroke-width="1.5"/>`;
    let lx = G.MX;
    const ly = uBottom + G.FRAME + 40;
    s += text(lx, ly - 16, 'NETWORKS', F.cap, T.ink3, ' letter-spacing="1.2"');
    for (const n of p.networks) {
      const k = paths.filter((q) => q.c.network === n.id).length;
      if (!k) continue;
      s += `<rect x="${lx}" y="${ly - 4}" width="16" height="4" rx="1" fill="${n.color}"/>`;
      const label = `${n.name}  ${k}`;
      s += text(lx + 22, ly + 1, label, UI(12), T.ink2);
      lx += 22 + measure(label, UI(12).css) + 22;
    }
    s += text(lx + 6, ly + 1, 'Copper runs down the left managers, fiber and DAC down the right.', UI(12), T.ink3);
    return { width, height, body: s, lay };
  }

  function showElevation(opts) {
    const o = Object.assign({ selected: 'cn-004', zoom: null, scrollX: null, scrollY: 0 }, opts);
    const p = plan();
    const host = shell('elevation', p);
    const sel = o.selected ? dev(p, o.selected) : null;
    const sc = cablingElevation(p, 'row1', { selected: sel && sel.id });
    const canvas = $('#canvas');
    const fit = (canvas.clientWidth - 44) / sc.width;
    const z = o.zoom || fit;
    host.innerHTML = `<svg class="cab-sheet" viewBox="0 0 ${sc.width} ${sc.height}" width="${Math.round(sc.width * z)}" height="${Math.round(sc.height * z)}">${sc.body}</svg>`;
    $('#btn-zoom-reset').textContent = `${Math.round(z * 100)}%`;
    $('.viewport').insertAdjacentHTML(
      'beforeend',
      `<div class="cab-float cab-sides seg" role="group" aria-label="Side"><button type="button" aria-pressed="false">Front</button><button type="button" aria-pressed="true">Rear</button></div>`
    );
    canvas.scrollLeft = o.scrollX == null ? 0 : o.scrollX * z;
    canvas.scrollTop = o.scrollY * z;
    if (sel) inspectDevice(p, sel);
    else inspectRow(p, 'row1');
  }

  /** Inspector with nothing selected: the row's cabling at a glance. */
  function inspectRow(p, rowId) {
    const pos = M.locateRow(p, rowId);
    const ids = new Set(pos.row.racks.map((r) => r.id));
    const cables = cablesIn(p, ids);
    const idx = C.cableIndex(p);
    const bars = pos.row.racks
      .map((r) => {
        const devs = p.devices.filter((d) => d.loc.rack === r.id);
        const ports = devs.reduce((a, d) => a + C.portsOf(p, d).length, 0);
        const used = devs.reduce((a, d) => a + C.portsOf(p, d).filter((pt) => idx.has(`${d.id}|${pt.name}|${pt.passThrough ? 'rear' : ''}`)).length, 0);
        return (
          `<button type="button" class="rack-bar"><span class="rb-name">${esc(r.name)}</span><span class="rb-val">${used}/${ports} ports</span>` +
          `<span class="rb-track"><span class="rb-fill" style="width:${((used / ports) * 100).toFixed(1)}%"></span></span></button>`
        );
      })
      .join('');
    const bad = cables.map((c) => C.describe(p, c)).filter((d) => d.issues.length);
    const issues = bad
      .slice(0, 4)
      .map((d) => `<li>${issueIcon(d.issues[0].level)}<span><b class="mono">${esc(d.cable.label)}</b> ${esc(d.issues[0].text)}</span></li>`)
      .join('');
    const inter = cables.filter((c) => {
      const ra = M.deviceById(p, c.a.device).loc.rack;
      const rb = M.deviceById(p, c.b.device).loc.rack;
      return !(ids.has(ra) && ids.has(rb));
    }).length;
    insp(
      `<div class="insp-head"><div class="kicker">Cabling · ${esc(pos.row.name)}</div>` +
        `<p class="insp-note">Click a device or a port to see its cables. Drag from a port to another port to connect them.</p></div>` +
        `<section class="insp-sec"><dl class="stats"><div><dt>Cables</dt><dd>${cables.length}</dd></div><div><dt>To other rows</dt><dd>${inter}</dd></div>` +
        `<div><dt>Networks</dt><dd>${new Set(cables.map((c) => c.network)).size}</dd></div><div><dt>To check</dt><dd>${bad.length}</dd></div></dl></section>` +
        `<section class="insp-sec"><h3>Ports in use</h3><div class="rack-bars">${bars}</div></section>` +
        `<section class="insp-sec"><h3>To check</h3><ul class="check-list">${issues}</ul></section>`
    );
  }

  // ------------------------------------------------------------ inspectors

  const insp = (html) => ($('#inspector').innerHTML = html);
  const swatch = (color) => `<span class="sw" style="--c:${color}"></span>`;
  const issueIcon = (lvl) => (lvl === 'warn' ? icon('warn', 'ic-sm is-warn') : icon('info', 'ic-sm is-info'));

  function portRows(p, d) {
    const idx = C.cableIndex(p);
    return C.portsOf(p, d)
      .map((pt) => {
        const peer = C.peerOf(p, d.id, pt.name, pt.passThrough ? 'rear' : '', idx);
        const spec = `${C.conn(pt.connector).label} ${C.shortSpeed(pt.speedGbps)}`;
        if (!peer) {
          return `<li class="pl-row is-free"><span class="pl-jack"></span><span class="pl-port"><b>${esc(pt.name)}</b><small>${esc(spec)}</small></span>` + `<span class="pl-peer"><span class="pl-free">Free</span><button type="button" class="btn sm subtle">Connect…</button></span></li>`;
        }
        const far = M.deviceById(p, peer.far.device);
        const info = C.describe(p, peer.cable);
        const meta = `${where(p, far).text} · ${shortType(info.type)} ${C.fmtM(info.lengthM)}`;
        return (
          `<li class="pl-row"><span class="pl-jack" style="--c:${netColor(p, peer.cable.network)}"></span>` +
          `<span class="pl-port"><b>${esc(pt.name)}</b><small>${esc(spec)}</small></span>` +
          `<span class="pl-peer"><b>${esc(`${far.name} · ${peer.far.port}`)}</b><small>${esc(meta)}</small></span>` +
          (info.issues.length ? issueIcon(info.issues[0].level) : '') +
          `</li>`
        );
      })
      .join('');
  }

  function inspectDevice(p, d) {
    if (!d) return insp('');
    const type = M.typeOf(p, d.type);
    const cl = M.clusterById(p, d.cluster);
    const w = where(p, d);
    const ports = C.portsOf(p, d);
    const idx = C.cableIndex(p);
    const used = ports.filter((pt) => idx.has(`${d.id}|${pt.name}|${pt.passThrough ? 'rear' : ''}`)).length;
    insp(
      `<div class="insp-head"><div class="kicker">${swatch(cl ? cl.color : 'var(--unassigned)')}${esc(type.label)} · ${M.deviceHeight(p, d)}U</div>` +
        `<div class="name-input name-static">${esc(d.name)}</div>` +
        `<div class="insp-where">${esc(w.text)} · rear</div><div class="insp-sub">${esc(`${w.floor.name} · ${w.row.name} · ${used} of ${ports.length} ports cabled`)}</div></div>` +
        `<section class="insp-sec"><h3>Ports</h3><ul class="port-list">${portRows(p, d)}</ul></section>` +
        `<section class="insp-sec"><h3>Checks</h3><ul class="check-list">` +
        `<li>${icon('check', 'ic-sm is-ok')}Every port is cabled</li>` +
        `<li>${icon('check', 'ic-sm is-ok')}Lengths are within each cable’s reach</li>` +
        `<li>${icon('check', 'ic-sm is-ok')}Both ends of each cable match in speed</li></ul></section>` +
        `<section class="insp-sec"><h3>Ports come from the type</h3><p class="insp-note small">${esc(type.label)} has ${esc(type.ports.map((g) => C.groupSpec(g)).join(', '))}. Edit them in the catalog.</p></section>` +
        `<div class="insp-actions is-pinned"><button type="button" class="btn">${icon('swap')}Connect series…</button><button type="button" class="btn danger-text">${icon('unplug')}Unplug all</button></div>`
    );
  }

  function inspectPort(p, d, portName) {
    const type = M.typeOf(p, d.type);
    const pt = C.portsOf(p, d).find((x) => x.name === portName);
    const idx = C.cableIndex(p);
    const peer = C.peerOf(p, d.id, portName, '', idx);
    const info = C.describe(p, peer.cable);
    const far = M.deviceById(p, peer.far.device);
    const net = netOf(p, peer.cable.network);
    const used = C.portsOf(p, d).filter((x) => idx.has(`${d.id}|${x.name}|`)).length;
    const chip = (n, on) => `<label class="chip"><input type="radio" name="net"${on ? ' checked' : ''}><span><i class="sw" style="--c:${n.color}"></i>${esc(n.name)}</span></label>`;
    insp(
      `<div class="insp-head"><div class="kicker">${swatch(net.color)}Port · ${esc(C.conn(pt.connector).label)} · ${esc(C.shortSpeed(pt.speedGbps))}</div>` +
        `<div class="name-input name-static">${esc(d.name)} · ${esc(pt.name)}</div>` +
        `<div class="insp-where">${esc(where(p, d).text)} · rear</div><div class="insp-sub">${esc(`${type.label} · ${used} of ${C.portsOf(p, d).length} ports cabled`)}</div></div>` +
        `<section class="insp-sec"><h3>Cable</h3>` +
        `<div class="mini-path"><span class="mp-end"><b>${esc(pt.name)}</b><small>${esc(d.name)}</small></span>` +
        `<span class="mp-wire" style="--c:${net.color}"><small>${esc(`${info.type.name} · ${C.fmtM(info.lengthM)}`)}</small></span>` +
        `<span class="mp-end"><b>${esc(peer.far.port)}</b><small>${esc(far.name)}</small></span></div>` +
        `<div class="field-grid">` +
        `<div class="field"><label>Label</label><input class="mono" type="text" value="${esc(peer.cable.label)}"></div>` +
        `<div class="field"><label>Length (m)</label><input type="number" placeholder="${esc(`${C.fmtM(info.lengthM)} (est. ${info.raw.toFixed(2)})`)}"></div>` +
        `<div class="field span2"><label>Cable type</label><select><option>Auto: ${esc(info.type.name)}</option></select></div>` +
        `</div></section>` +
        `<section class="insp-sec"><h3>Network</h3><div class="chips">${p.networks.map((n) => chip(n, n === net)).join('')}</div></section>` +
        `<section class="insp-sec"><h3>Other end</h3><dl class="kv"><dt>Device</dt><dd>${esc(far.name)}</dd><dt>Port</dt><dd>${esc(peer.far.port)} · ${esc(C.conn(info.pb.connector).label)} ${esc(C.shortSpeed(info.pb.speedGbps))}</dd><dt>Position</dt><dd>${esc(where(p, far).text)}</dd></dl></section>` +
        `<div class="insp-actions is-pinned"><button type="button" class="btn">${icon('trace')}Show in elevation</button><button type="button" class="btn danger-text">${icon('unplug')}Unplug</button></div>`
    );
  }

  // ------------------------------------------------- approach B: port map

  /** One device's faceplate, `scale` times larger, with what each port connects to above and below it. */
  function faceplate(p, d, o) {
    const t = theme();
    const T = R.THEMES[t];
    const type = M.typeOf(p, d.type);
    const S = o.scale;
    const lay = layoutPorts(type, 'rear', 1, G.BAY);
    const idx = C.cableIndex(p);
    const x0 = lay.ports[0].x;
    const xs = lay.ports.map((pt) => pt.x + pt.w);
    const innerW = (Math.max(...xs) - x0) * S;
    const W = o.width;
    const ox = (W - innerW) / 2 - x0 * S;
    const LBL = 72;
    const plateY = LBL + 6;
    const plateH = G.U * S;
    let s = `<rect x="${r1(ox + x0 * S - 18)}" y="${plateY}" width="${r1(innerW + 36)}" height="${r1(plateH)}" rx="4" fill="${R.mix(T.faceBase, '#8c96a3', 0.08)}" stroke="${T.ink3}"/>`;
    const lbl = MONO(9.5);
    for (const pt of lay.ports) {
      const peer = C.peerOf(p, d.id, pt.name, '', idx);
      const color = peer ? netColor(p, peer.cable.network) : null;
      const P = { x: ox + pt.x * S, y: plateY + pt.y * S, w: pt.w * S, h: pt.h * S, exit: pt.exit, connector: pt.connector };
      const selected = o.selectedPort === pt.name;
      s += portShape(P, color ? R.mix(color, T.faceBase, 0.1) : null, t);
      const num = pt.name.replace(/^[a-z]+/i, '');
      s += text(P.x + P.w / 2, P.y + P.h / 2 + 3, num, MONO(fam(pt.connector) === 'rj45' ? 7.5 : 8.5, 600), color ? '#ffffff' : T.ink3, ' text-anchor="middle"');
      if (selected) s += `<rect x="${r1(P.x - 3)}" y="${r1(P.y - 3)}" width="${r1(P.w + 6)}" height="${r1(P.h + 6)}" rx="3" fill="none" stroke="${T.handle}" stroke-width="2.5"/>`;
      if (peer) {
        const far = M.deviceById(p, peer.far.device);
        const other = far.loc.rack !== d.loc.rack;
        const label = R.fitText(far.name, lbl, LBL - 8, measure) + (other ? '' : '');
        const cx = P.x + P.w / 2;
        const up = pt.exit === 'up';
        const y1 = up ? P.y - 3 : P.y + P.h + 3;
        const y2 = up ? LBL : plateY + plateH + 6;
        s += `<path d="M${r1(cx)} ${r1(y1)}V${r1(y2)}" stroke="${color}" stroke-width="1.4"/>`;
        const tx = up ? LBL - 2 : plateY + plateH + 10;
        s += `<text transform="translate(${r1(cx + 3.4)} ${r1(tx)}) rotate(-90)" font-family="${lbl.family}" font-size="${lbl.size}" font-weight="${selected ? 700 : 500}" fill="${selected ? T.ink : T.ink2}"${up ? '' : ' text-anchor="end"'}>${esc(label)}</text>`;
        if (other) s += `<circle cx="${r1(cx)}" cy="${up ? 6 : plateY + plateH + LBL + 4}" r="2.2" fill="${T.ink3}"/>`;
      }
    }
    return { svg: s, height: plateY + plateH + LBL + 10 };
  }

  function portCard(p, d, o) {
    const type = M.typeOf(p, d.type);
    const idx = C.cableIndex(p);
    const ports = C.portsOf(p, d);
    const used = ports.filter((pt) => idx.has(`${d.id}|${pt.name}|`)).length;
    const cl = M.clusterById(p, d.cluster);
    const width = o.width;
    const fp = faceplate(p, d, { scale: o.scale, width, selectedPort: o.selectedPort });
    return (
      `<section class="pm-card${o.selectedPort ? ' is-current' : ''}"><header class="pm-head">` +
      `${swatch(cl ? cl.color : 'var(--unassigned)')}<span class="pm-name">${esc(d.name)}</span>` +
      `<span class="pm-meta">${esc(`${type.label} · ${where(p, d).text}${d.loc.kind === 'side' ? ' (side slot)' : ''} · ${type.ports.map((g) => C.groupSpec(g)).join(', ')}`)}</span>` +
      `<span class="pm-use"><span class="fm-meter"><span style="width:${((used / ports.length) * 100).toFixed(1)}%"></span></span>${used} of ${ports.length}</span>` +
      `<button type="button" class="btn sm">${icon('swap', 'ic-sm')}Connect series…</button></header>` +
      `<svg class="pm-plate" viewBox="0 0 ${width} ${fp.height}" width="${width}" height="${fp.height}">${fp.svg}</svg></section>`
    );
  }

  function showPortMap() {
    const p = plan();
    const host = shell('ports', p);
    const width = $('#canvas').clientWidth - 40;
    const sel = dev(p, 'ib-leaf-a01');
    const legend = p.networks
      .filter((n) => n.id !== 'n-sas' && n.id !== 'n-eth')
      .map((n) => `<span class="pm-key">${swatch(n.color)}${esc(n.name)}</span>`)
      .join('');
    host.innerHTML =
      `<div class="pm"><div class="pm-top"><div class="fm-title"><h2>Rack A01 · switches</h2><p>Ports as seen from the rear. Above and below each port: the device at the other end; a dot marks one in another rack.</p></div>` +
      `<div class="pm-tools"><div class="seg"><button type="button" aria-pressed="true">Switches</button><button type="button" aria-pressed="false">Patch panels</button><button type="button" aria-pressed="false">All devices</button></div>` +
      `<div class="row-nav"><button class="btn icon sm" type="button">${icon('left')}</button><button class="btn sm row-btn" type="button">${icon('rack')}<span>Rack A01</span>${icon('chevron', 'ic-sm')}</button><button class="btn icon sm" type="button">${icon('right')}</button></div></div></div>` +
      `<div class="pm-legend">${legend}<span class="pm-key"><span class="sw sw-free"></span>Free</span><span class="pm-key"><i class="pm-dot"></i>Other rack</span>` +
      `<span class="pm-hint">Click a port, then a port of another device; drag across ports to connect a series.</span></div>` +
      portCard(p, dev(p, 'ib-leaf-a01'), { scale: 3.1, width, selectedPort: 'p4' }) +
      portCard(p, dev(p, 'sw-mgmt-a01'), { scale: 3.1, width }) +
      portCard(p, dev(p, 'sw-bmc-a01'), { scale: 3.1, width }) +
      `</div>`;
    inspectPort(p, sel, 'p4');
  }

  // ------------------------------------------------- approach C: schedule

  function routeOf(p, c) {
    const ra = M.locateRack(p, M.deviceById(p, c.a.device).loc.rack);
    const rb = M.locateRack(p, M.deviceById(p, c.b.device).loc.rack);
    if (ra.rack === rb.rack) return { key: `0|${ra.rack.name}`, label: `Within ${ra.rack.name}` };
    const [x, y] = [ra, rb].sort((m, n) => (m.floorIndex - n.floorIndex) * 1000 + (m.rowIndex - n.rowIndex) * 100 + (m.index - n.index));
    if (x.row === y.row) return { key: `1|${x.rack.name}|${y.rack.name}`, label: `${x.rack.name} ⇄ ${shortRack(y.rack.name)}` };
    return { key: `2|${x.row.name}|${y.row.name}`, label: `${x.floor.name} · ${x.row.name} ⇄ ${y.row.name}` };
  }

  function scheduleRow(p, c, o) {
    const info = C.describe(p, c);
    const da = M.deviceById(p, c.a.device);
    const db = M.deviceById(p, c.b.device);
    const n = netOf(p, c.network);
    const issue = info.issues[0];
    const len = info.lengthM == null ? '–' : C.fmtM(info.lengthM);
    return (
      `<tr class="${o.selected ? 'is-selected' : ''}${issue && issue.level === 'warn' ? ' is-warn' : ''}">` +
      `<td class="sc-check"><input type="checkbox"${o.selected ? ' checked' : ''}></td>` +
      `<td class="mono sc-label"><span class="sc-net" style="--c:${n.color}"></span>${esc(c.label)}</td>` +
      `<td class="mono"><b>${esc(da.name)}</b> ${esc(c.a.port)}${c.a.side ? `<small> ${c.a.side}</small>` : ''}</td><td class="mono sc-pos">${esc(where(p, da).text)}</td>` +
      `<td class="sc-arrow">→</td>` +
      `<td class="mono"><b>${esc(db.name)}</b> ${esc(c.b.port)}${c.b.side ? `<small> ${c.b.side}</small>` : ''}</td><td class="mono sc-pos">${esc(where(p, db).text)}</td>` +
      `<td>${esc(info.type ? shortType(info.type) : '–')}</td>` +
      `<td class="mono sc-num">${esc(C.shortSpeed(info.speed))}</td>` +
      `<td class="mono sc-num${info.auto ? ' is-auto' : ''}" title="${info.raw ? `estimated ${info.raw.toFixed(2)} m` : ''}">${esc(len)}</td>` +
      `<td class="sc-issue">${issue ? `<span class="sc-flag ${issue.level === 'warn' ? 'is-warn' : 'is-info'}" title="${esc(issue.text)}">${issueIcon(issue.level)}${esc(issue.short)}</span>` : ''}</td>` +
      `</tr>`
    );
  }

  function bomStrip(p, cables) {
    const sub = Object.assign({}, p, { cables });
    const bom = C.billOfMaterials(sub);
    const byType = new Map();
    for (const b of bom) {
      if (!byType.has(b.type.id)) byType.set(b.type.id, { type: b.type, items: [] });
      byType.get(b.type.id).items.push(b);
    }
    const total = (g) => g.items.reduce((a, b) => a + b.count, 0);
    return (
      `<div class="bom"><div class="bom-head"><b>To order</b><span>${cables.length} cables, ${Math.round(bom.reduce((a, b) => a + b.count * b.lengthM, 0))} m in stock lengths</span>` +
      `<button type="button" class="btn sm subtle">${icon('download', 'ic-sm')}Order list (CSV)</button><button type="button" class="btn sm subtle">${icon('print', 'ic-sm')}Cable labels</button></div><div class="bom-types">` +
      [...byType.values()]
        .map(
          (g) =>
            `<div class="bom-type"><span class="bom-name">${esc(g.type.name)} <small>${total(g)}</small></span><span class="bom-items">` +
            g.items.map((b) => `<span class="bom-item"><b>${esc(C.fmtM(b.lengthM))}</b> × ${b.count}</span>`).join('<i>·</i>') +
            `</span></div>`
        )
        .join('') +
      `</div></div>`
    );
  }

  function scheduleTable(p, cables, o) {
    const groups = new Map();
    for (const c of cables) {
      const r = routeOf(p, c);
      if (!groups.has(r.key)) groups.set(r.key, { label: r.label, list: [] });
      groups.get(r.key).list.push(c);
    }
    const keys = [...groups.keys()].sort();
    let rows = '';
    for (const k of keys) {
      const g = groups.get(k);
      const open = !o.collapsed.some((x) => g.label.includes(x));
      const warn = g.list.filter((c) => C.describe(p, c).issues.some((i) => i.level === 'warn')).length;
      rows +=
        `<tr class="sc-group"><td colspan="11">${icon(open ? 'chevron' : 'right', 'ic-sm')}<b>${esc(g.label)}</b><span>${g.list.length} cables</span>` +
        (warn ? `<span class="sc-flag is-warn">${icon('warn', 'ic-sm is-warn')}${warn} to check</span>` : '') +
        `</td></tr>`;
      if (open) for (const c of g.list) rows += scheduleRow(p, c, { selected: c.id === o.selected });
    }
    return (
      `<table class="sched"><thead><tr><th class="sc-check"><input type="checkbox"></th><th>Label</th><th>From</th><th>Position</th><th></th><th>To</th><th>Position</th>` +
      `<th>Cable</th><th class="sc-num">Speed</th><th class="sc-num">Length</th><th>Check</th></tr></thead><tbody>${rows}</tbody></table>`
    );
  }

  function showSchedule(opts) {
    const o = Object.assign({ dialog: false }, opts);
    const p = plan(o.dialog ? (q) => (q.cables = q.cables.filter((c) => !(c.network === 'n-ib' && /^cn-/.test(M.deviceById(q, c.a.device).name)))) : null);
    const host = shell('schedule', p);
    const row = M.locateRow(p, 'row1').row;
    const cables = cablesIn(p, new Set(row.racks.map((r) => r.id)));
    const selected = p.cables.find((c) => c.label === 'MGT-0030');
    const chips = p.networks.map((n) => `<label class="chip chip-net"><input type="checkbox" checked><span><i class="sw" style="--c:${n.color}"></i>${esc(n.name)}</span></label>`).join('');
    host.innerHTML =
      `<div class="sc"><div class="sc-tools">` +
      `<div class="fm-title"><h2>Row A · cable schedule</h2><p>${cables.length} cables with an end in this row · lengths in italics are estimates</p></div>` +
      `<span class="spacer"></span><div class="seg"><button type="button" aria-pressed="true">Row A</button><button type="button" aria-pressed="false">Floor</button><button type="button" aria-pressed="false">Plan</button></div>` +
      `<button type="button" class="btn sm">${icon('swap', 'ic-sm')}Connect series…</button><button type="button" class="btn sm">${icon('plus', 'ic-sm')}Cable</button></div>` +
      `<div class="sc-filters"><div class="sc-search">${icon('filter', 'ic-sm')}<input type="text" placeholder="Filter by device, port, label"></div>${chips}` +
      `<span class="spacer"></span><label class="sc-group-by"><select><option>By route</option><option>By network</option><option>By device</option><option>By cable type</option></select></label></div>` +
      `<div class="sc-scroll">${scheduleTable(p, cables, { selected: selected.id, collapsed: ['Within Rack A01', 'Within Rack A02', 'Within Rack A03', 'Rack A01 ⇄'] })}</div>` +
      bomStrip(p, cables) +
      `</div>`;
    if (o.dialog) {
      insp('');
      inspectOverview(p);
      connectDialog(p);
    } else inspectCable(p, selected);
  }

  function inspectCable(p, cable) {
    const segs = C.trace(p, cable);
    const first = segs[0];
    const last = segs[segs.length - 1];
    const step = (e, sub, cls) => {
      const d = M.deviceById(p, e.device);
      const pt = C.portOf(p, e);
      return (
        `<li class="tr-node ${cls || ''}"><span class="tr-dot"></span><div><b>${esc(d.name)} · ${esc(e.port)}${e.side ? ` ${e.side}` : ''}</b>` +
        `<small>${esc(`${where(p, d).text} · ${sub || `${C.conn(pt.connector).label} ${C.shortSpeed(pt.speedGbps)}`}`)}</small></div></li>`
      );
    };
    let html = step(first.from);
    segs.forEach((sg, i) => {
      const info = C.describe(p, sg.cable);
      const n = netOf(p, sg.cable.network);
      html +=
        `<li class="tr-wire${sg.cable === cable ? ' is-current' : ''}" style="--c:${n.color}"><span class="tr-line"></span><div><span class="mono">${esc(sg.cable.label)}</span>` +
        `<small>${esc(`${info.type.name} · ${C.fmtM(info.lengthM)}${info.auto && info.raw ? ` (est. ${info.raw.toFixed(1)} m)` : ''}`)}</small></div></li>`;
      if (i < segs.length - 1) {
        const pp = M.deviceById(p, sg.to.device);
        html += `<li class="tr-node is-pass"><span class="tr-dot"></span><div><b>${esc(pp.name)} · ${esc(sg.to.port)}</b><small>${esc(`${where(p, pp).text} · patch panel, rear to front`)}</small></div></li>`;
      }
    });
    html += step(last.to);
    const info = C.describe(p, cable);
    const n = netOf(p, cable.network);
    insp(
      `<div class="insp-head"><div class="kicker">${swatch(n.color)}Cable · ${esc(n.name)}</div>` +
        `<div class="name-input name-static">${esc(cable.label)}</div>` +
        `<div class="insp-where">${esc(`${M.deviceById(p, first.from.device).name} → ${M.deviceById(p, last.to.device).name}`)}</div>` +
        `<div class="insp-sub">${esc(`Row A → Row B · ${segs.length} cables through ${M.deviceById(p, first.to.device).name}`)}</div></div>` +
        `<section class="insp-sec"><h3>Path</h3><ol class="trace">${html}</ol></section>` +
        `<section class="insp-sec"><h3>This cable</h3><div class="field-grid">` +
        `<div class="field"><label>Label</label><input class="mono" type="text" value="${esc(cable.label)}"></div>` +
        `<div class="field"><label>Length (m)</label><input type="number" placeholder="${esc(`${C.fmtM(info.lengthM)} (est.)`)}"></div>` +
        `<div class="field span2"><label>Cable type</label><select><option>Auto: ${esc(info.type.name)}</option></select></div></div></section>` +
        `<section class="insp-sec"><h3>Checks</h3><ul class="check-list"><li>${icon('check', 'ic-sm is-ok')}1 Gb/s at both ends of the path</li><li>${icon('check', 'ic-sm is-ok')}Total length 6 m, Cat6a reaches 100 m</li></ul></section>` +
        `<div class="insp-actions is-pinned"><button type="button" class="btn">${icon('trace')}Show in elevation</button><button type="button" class="btn danger-text">${icon('trash')}Delete</button></div>`
    );
  }

  function inspectOverview(p) {
    const bad = p.cables.map((c) => C.describe(p, c)).filter((d) => d.issues.length);
    insp(
      `<div class="insp-head"><div class="kicker">Cabling overview</div><p class="insp-note">Select a cable, a port or a device. Shift-click to select several cables.</p></div>` +
        `<section class="insp-sec"><dl class="stats"><div><dt>Cables</dt><dd>${p.cables.length}</dd></div><div><dt>Networks</dt><dd>${p.networks.length}</dd></div>` +
        `<div><dt>Ports cabled</dt><dd>${p.cables.length * 2} <small>of ${p.devices.reduce((a, d) => a + C.portsOf(p, d).length, 0)}</small></dd></div><div><dt>To check</dt><dd>${bad.length}</dd></div></dl></section>` +
        `<section class="insp-sec"><h3>Estimates</h3><dl class="kv"><dt>Rack width</dt><dd>0.6 m</dd><dt>Row pitch</dt><dd>3.0 m</dd><dt>Slack</dt><dd>10 %</dd></dl></section>`
    );
  }

  function connectDialog(p) {
    const old = $('#dlg-connect');
    if (old) old.remove();
    const leaf = dev(p, 'ib-leaf-a01');
    const nodes = Array.from({ length: 12 }, (_, i) => dev(p, `cn-${String(i + 1).padStart(3, '0')}`));
    const rows = nodes
      .map((d, i) => {
        const c = { a: { device: d.id, port: 'ib0' }, b: { device: leaf.id, port: `p${i + 1}` }, type: null, lengthM: null };
        const info = C.describe(p, c);
        return `<tr><td class="mono">IB-${String(46 + i).padStart(4, '0')}</td><td class="mono"><b>${esc(d.name)}</b> ib0</td><td class="sc-arrow">→</td><td class="mono"><b>ib-leaf-a01</b> p${i + 1}</td><td>${esc(info.type.name)}</td><td class="mono sc-num is-auto">${esc(C.fmtM(info.lengthM))}</td><td>${icon('check', 'ic-sm is-ok')}</td></tr>`;
      })
      .join('');
    const sum = new Map();
    nodes.forEach((d, i) => {
      const info = C.describe(p, { a: { device: d.id, port: 'ib0' }, b: { device: leaf.id, port: `p${i + 1}` }, type: null, lengthM: null });
      const k = `${info.type.name} ${C.fmtM(info.lengthM)}`;
      sum.set(k, (sum.get(k) || 0) + 1);
    });
    const chips = p.networks.map((n) => `<label class="chip"><input type="radio" name="cs-net"${n.id === 'n-ib' ? ' checked' : ''}><span><i class="sw" style="--c:${n.color}"></i>${esc(n.name)}</span></label>`).join('');
    document.body.insertAdjacentHTML(
      'beforeend',
      `<dialog class="dlg dlg-wide" id="dlg-connect"><div class="dlg-shell"><header class="dlg-head"><span class="tape">Connect series</span><h2>12 cables from Rack A01</h2>` +
        `<p class="dlg-sub">Pairs each device with the next free port, top to bottom. Nothing is connected until you confirm.</p></header>` +
        `<div class="dlg-body"><div class="cs-grid">` +
        `<div class="cs-side"><span class="cs-cap">From</span><div class="field"><label>Devices</label><div class="cs-token">${icon('select', 'ic-sm')}<span><b>cn-001 … cn-012</b> · 12 compute nodes</span></div></div>` +
        `<div class="field"><label>Port on each</label><select><option>ib0 · QSFP56 200G</option></select></div></div>` +
        `<div class="cs-mid">${icon('right')}</div>` +
        `<div class="cs-side"><span class="cs-cap">To</span><div class="field"><label>Device</label><select><option>ib-leaf-a01 · Rack A01 · U2</option></select></div>` +
        `<div class="field-grid"><div class="field"><label>From port</label><select><option>p1</option></select></div><div class="field"><label>Step</label><input type="number" value="1"></div></div></div></div>` +
        `<div class="field"><span class="label">Network</span><div class="chips">${chips}</div></div>` +
        `<div class="field-grid"><div class="field"><label>Cable type</label><select><option>Auto: by connectors and length</option></select></div>` +
        `<div class="field"><label>Labels</label><input class="mono" type="text" value="IB-{0046}"></div></div>` +
        `<div class="cs-preview"><table class="sched sched-mini"><tbody>${rows}</tbody></table></div>` +
        `<p class="preview-line">12 cables · ${esc([...sum.entries()].map(([k, n]) => `${k} × ${n}`).join(' · '))}</p>` +
        `</div><footer class="dlg-foot"><button type="button" class="btn">Cancel</button><button type="button" class="btn primary">Connect 12 cables</button></footer></div></dialog>`
    );
    $('#dlg-connect').showModal();
    document.activeElement.blur();
  }

  // ---------------------------------------------------- approach D: fabric

  function showFabric() {
    const p = plan();
    const host = shell('fabric', p);
    const t = theme();
    const T = R.THEMES[t];
    const net = 'n-ib';
    const color = netColor(p, net);
    const cables = p.cables.filter((c) => c.network === net);
    const devs = new Map();
    const touch = (id) => devs.set(id, M.deviceById(p, id));
    for (const c of cables) touch(c.a.device), touch(c.b.device);
    const sw = [...devs.values()].filter((d) => isSwitch(p, d));
    const nodes = [...devs.values()].filter((d) => !isSwitch(p, d));
    const nbrs = (d) => cables.filter((c) => c.a.device === d.id || c.b.device === d.id).map((c) => M.deviceById(p, c.a.device === d.id ? c.b.device : c.a.device));
    const leaves = sw.filter((d) => nbrs(d).some((n) => !isSwitch(p, n)));
    const cores = sw.filter((d) => !leaves.includes(d));
    const rackPos = (d) => {
      const r = M.locateRack(p, d.loc.rack);
      return r.floorIndex * 10000 + r.rowIndex * 100 + r.index;
    };
    leaves.sort((a, b) => rackPos(a) - rackPos(b));
    // Nodes in groups: same leaves, same cluster, same type.
    const groups = new Map();
    for (const n of nodes) {
      const ls = [...new Set(nbrs(n).map((x) => x.id))].sort();
      const k = `${ls.join(',')}|${n.cluster}|${n.type}`;
      if (!groups.has(k)) groups.set(k, { leaves: ls, devs: [], cluster: n.cluster, type: n.type });
      groups.get(k).devs.push(n);
    }
    const gl = [...groups.values()].sort((a, b) => leaves.findIndex((l) => l.id === a.leaves[0]) - leaves.findIndex((l) => l.id === b.leaves[0]) || a.leaves.length - b.leaves.length);
    const W = $('#canvas').clientWidth - 42;
    const BW = 118;
    const yCore = 70;
    const yLeaf = 250;
    const yNode = 470;
    const BH = 58;
    const spread = (n, w) => Array.from({ length: n }, (_, i) => 66 + ((W - 76) * (i + 0.5)) / n - w / 2);
    const xsCore = [W / 2 - 170, W / 2 + 170 - BW];
    const xsLeaf = spread(leaves.length, BW);
    const xsNode = spread(gl.length, BW);
    const pos = new Map();
    cores.forEach((d, i) => pos.set(d.id, { x: xsCore[i], y: yCore }));
    leaves.forEach((d, i) => pos.set(d.id, { x: xsLeaf[i], y: yLeaf }));
    gl.forEach((g, i) => (g.x = xsNode[i]));
    const linkCount = (a, b) => cables.filter((c) => (c.a.device === a && c.b.device === b) || (c.a.device === b && c.b.device === a)).length;
    let s = sheetDefs(T, t) + paper(W, 600, T, t);
    for (const [label, y] of [['CORE', yCore], ['LEAF', yLeaf], ['NODES', yNode]]) s += text(26, y + 33, label, F.cap, T.ink3, ' letter-spacing="1.4"');
    const pill = (x, y, label, strong) => {
      const w = measure(label, MONO(9.5, 600).css) + 10;
      return `<rect x="${r1(x - w / 2)}" y="${r1(y - 8)}" width="${r1(w)}" height="15" rx="7.5" fill="${T.paper}" stroke="${strong ? color : T.border}"/>` + text(x - w / 2 + 5, y + 3.2, label, MONO(9.5, 600), strong ? T.ink : T.ink2);
    };
    let links = '';
    let pills = '';
    for (const c of cores) {
      for (const l of leaves) {
        const n = linkCount(c.id, l.id);
        if (!n) continue;
        const a = pos.get(c.id);
        const b = pos.get(l.id);
        const x1 = a.x + BW / 2 + (b.x - a.x) * 0.12;
        const x2 = b.x + BW / 2 + (cores.indexOf(c) === 0 ? -10 : 10);
        links += `<path d="M${r1(x1)} ${a.y + BH}C${r1(x1)} ${a.y + BH + 80},${r1(x2)} ${b.y - 80},${r1(x2)} ${b.y}" fill="none" stroke="${color}" stroke-width="${1 + n * 1.2}" opacity=".75"/>`;
      }
      // One label per leaf: all of its uplinks.
    }
    for (const l of leaves) {
      const up = cores.reduce((a, c) => a + linkCount(c.id, l.id), 0);
      const b = pos.get(l.id);
      pills += pill(b.x + BW / 2, b.y - 16, `${up}×200G up`);
    }
    for (const g of gl) {
      for (const lid of g.leaves) {
        const n = g.devs.reduce((a, d) => a + linkCount(d.id, lid), 0);
        const b = pos.get(lid);
        const x1 = g.x + BW / 2 + (g.leaves.length > 1 ? (lid === g.leaves[0] ? -20 : 20) : 0);
        links += `<path d="M${r1(b.x + BW / 2)} ${b.y + BH}C${r1(b.x + BW / 2)} ${b.y + BH + 80},${r1(x1)} ${yNode - 80},${r1(x1)} ${yNode}" fill="none" stroke="${color}" stroke-width="${1 + Math.min(n, 12) * 0.55}" opacity=".75"/>`;
        pills += pill(x1, yNode - 16, `${n}×200G`);
      }
    }
    s += links;
    const box = (x, y, d, title, sub, extra, strong, titleW) => {
      const cl = M.clusterById(p, d.cluster);
      return (
        `<g><rect x="${r1(x)}" y="${y}" width="${BW}" height="${BH}" rx="5" fill="${T.faceBase}" stroke="${strong ? T.select : T.border}" stroke-width="${strong ? 2 : 1}"/>` +
        `<rect x="${r1(x)}" y="${y}" width="5" height="${BH}" rx="2" fill="${cl ? cl.color : T.unassigned}"/>` +
        text(x + 13, y + 18, R.fitText(title, MONO(11.5, 600), titleW || BW - 20, measure), MONO(11.5, 600), T.ink) +
        text(x + 13, y + 33, R.fitText(sub, UI(11), BW - 20, measure), UI(11), T.ink3) +
        (extra || '') +
        `</g>`
      );
    };
    const used = (d) => {
      const idx = C.cableIndex(p);
      return C.portsOf(p, d).filter((pt) => idx.has(`${d.id}|${pt.name}|`)).length;
    };
    const meter = (x, y, a, b, label, over) =>
      `<rect x="${x + 13}" y="${y + 42}" width="${BW - 60}" height="4" rx="2" fill="${T.barTrack}"/><rect x="${x + 13}" y="${y + 42}" width="${r1(((BW - 60) * a) / b)}" height="4" rx="2" fill="${over ? T.bad : T.bar}"/>` +
      text(x + BW - 42, y + 47, label, MONO(9.5, 600), over ? T.bad : T.ink2);
    for (const c of cores) {
      const q = pos.get(c.id);
      s += box(q.x, q.y, c, c.name, where(p, c).text, meter(q.x, q.y, used(c), 24, `${used(c)}/24`));
    }
    for (const l of leaves) {
      const q = pos.get(l.id);
      const down = nbrs(l).filter((n) => !isSwitch(p, n)).length;
      const up = nbrs(l).filter((n) => isSwitch(p, n)).length;
      const ratio = `${Math.round((down / up) * 100) / 100}:1`;
      const over = down / up > 3;
      const badge =
        meter(q.x, q.y, used(l), 24, `${used(l)}/24`) +
        `<rect x="${r1(q.x + BW - 50)}" y="${q.y + 22}" width="44" height="16" rx="3" fill="${over ? T.bad : T.barTrack}"/>` +
        text(q.x + BW - 28, q.y + 33.5, ratio, MONO(10, 600), over ? '#ffffff' : T.ink, ' text-anchor="middle"');
      s += box(q.x, q.y, l, l.name, where(p, l).text, badge, l.name === 'ib-leaf-a02');
    }
    for (const g of gl) {
      const first = g.devs[0].name;
      const lastN = g.devs[g.devs.length - 1].name;
      const title = g.devs.length > 1 ? `${first} … ${lastN.replace(/^.*?(\d+)$/, '$1')}` : first;
      const type = M.typeOf(p, g.type);
      const cl = M.clusterById(p, g.cluster);
      s += box(g.x, yNode, g.devs[0], title, `${g.devs.length} × ${type.label}`, text(g.x + 13, yNode + 48, R.fitText(cl ? cl.name : '', UI(11), BW - 20, measure), UI(11, 600), cl ? R.mix(cl.color, T.ink, 0.25) : T.ink3));
    }
    s += pills;
    host.innerHTML =
      `<div class="fb"><div class="pm-top"><div class="fm-title"><h2>InfiniBand fabric · whole plan</h2><p>${cables.length} links between ${cores.length} core switches, ${leaves.length} leaves and ${nodes.length} nodes. Nodes with the same links and cluster are drawn as one box.</p></div>` +
      `<div class="pm-tools"><label class="sc-group-by">Network <select><option>InfiniBand</option><option>Management</option><option>BMC</option></select></label>` +
      `<div class="seg"><button type="button" aria-pressed="true">Grouped</button><button type="button" aria-pressed="false">Every device</button></div></div></div>` +
      `<svg class="fb-svg" viewBox="0 0 ${W} 600" width="${W}" height="600">${s}</svg>` +
      `<p class="fb-note">Line width grows with the number of links. The badge on each leaf is down links to up links, red above 3 : 1; the bar is its ports in use.</p></div>`;
    inspectLeaf(p, dev(p, 'ib-leaf-a02'), cables);
  }

  function inspectLeaf(p, d, cables) {
    const mine = cables.filter((c) => c.a.device === d.id || c.b.device === d.id);
    const peers = new Map();
    for (const c of mine) {
      const far = M.deviceById(p, c.a.device === d.id ? c.b.device : c.a.device);
      const k = isSwitch(p, far) ? far.name : far.name.replace(/\d+$/, '');
      if (!peers.has(k)) peers.set(k, { list: [], sw: isSwitch(p, far) });
      peers.get(k).list.push(far);
    }
    const rows = [...peers.values()]
      .map((g) => {
        const names = [...new Set(g.list.map((x) => x.name))];
        const name = names.length > 1 ? `${names[0]} … ${names[names.length - 1].replace(/^.*?(\d+)$/, '$1')}` : names[0];
        return `<tr><td class="mono">${esc(name)}</td><td>${g.sw ? 'up' : 'down'}</td><td>${g.list.length} × 200G</td></tr>`;
      })
      .join('');
    const up = [...peers.values()].filter((g) => g.sw).reduce((a, g) => a + g.list.length, 0);
    const down = mine.length - up;
    insp(
      `<div class="insp-head"><div class="kicker">${swatch('#d9a21b')}Leaf switch · InfiniBand</div><div class="name-input name-static">${esc(d.name)}</div>` +
        `<div class="insp-where">${esc(where(p, d).text)}</div><div class="insp-sub">Ground floor · Row A · ${mine.length} of 24 ports in this network</div></div>` +
        `<section class="insp-sec"><dl class="stats"><div><dt>Down</dt><dd>${down} <small>× 200G</small></dd></div><div><dt>Up</dt><dd>${up} <small>× 200G</small></dd></div>` +
        `<div><dt>Bandwidth down</dt><dd>${(down * 0.2).toFixed(1)} <small>Tb/s</small></dd></div><div><dt>Oversubscription</dt><dd>${(down / up).toFixed(2)} <small>: 1</small></dd></div></dl></section>` +
        `<section class="insp-sec"><h3>Links</h3><table class="type-table"><thead><tr><th>To</th><th>Dir.</th><th>Links</th></tr></thead><tbody>${rows}</tbody></table></section>` +
        `<section class="insp-sec"><h3>Fabric checks</h3><ul class="check-list">` +
        `<li>${icon('warn', 'ic-sm is-warn')}ib-leaf-b02 and ib-leaf-b03 run at 6 : 1</li>` +
        `<li>${icon('check', 'ic-sm is-ok')}Every leaf reaches both core switches</li>` +
        `<li>${icon('check', 'ic-sm is-ok')}ceph-01 … 03 hang off two leaves</li>` +
        `<li>${icon('info', 'ic-sm is-info')}9 free ports on ib-leaf-a02 for growth</li></ul></section>`
    );
  }

  // ------------------------------------------------------------ catalog

  /** The device type editor with a Ports tab, for the 48-port switch (catalog already open on it). */
  function showCatalogPorts() {
    addSymbols();
    const p = plan();
    const t = theme();
    const type = M.typeOf(p, 'switch-rj45');
    const tabs = $('#dlg-catalog .tabs');
    if (!tabs.querySelector('[data-tab="cables"]')) tabs.insertAdjacentHTML('beforeend', `<button type="button" role="tab" data-tab="cables" aria-selected="false">Cable types</button>`);
    const front = R.renderPreview(type, t, null, 'sw-rj45-01', measure);
    const rear = deviceRear(p, type, 'sw-rj45-01', null, 1, G.BAY, 'rear', t);
    const rearPorts = rear.ports.map((pt) => portShape(pt, null, t)).join('');
    const opt = (list, v) => list.map(([k, l]) => `<option${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
    const conns = Object.entries(C.CONNECTORS).map(([k, c]) => [k, c.label]);
    const speeds = [0.1, 1, 10, 25, 40, 100, 200, 400, 800].map((g) => [g, C.shortSpeed(g)]);
    const sides = [['front', 'Front'], ['rear', 'Rear']];
    const idx = C.cableIndex(p);
    const switches = p.devices.filter((d) => d.type === type.id);
    const cabled = switches.reduce((a, d) => a + C.portsOf(p, d).filter((pt) => idx.has(`${d.id}|${pt.name}|`)).length, 0);
    const pattern = (g) => (g.count == null && g.first == null ? g.name : `${g.name}[${g.first}-${g.first + g.count - 1}]`);
    const rows = type.ports
      .map(
        (g) =>
          `<tr><td><input class="mono" type="text" value="${esc(pattern(g))}"></td>` +
          `<td><select>${opt(conns, g.connector)}</select></td><td><select>${opt(speeds, g.speedGbps)}</select></td><td><select>${opt(sides, g.side)}</select></td>` +
          `<td class="pt-count mono">${C.groupNames(g).length}</td><td><button type="button" class="btn icon sm subtle" aria-label="Remove">${icon('trash')}</button></td></tr>`
      )
      .join('');
    $('#cat-form').innerHTML =
      `<div class="seg tabs cat-subtabs" role="tablist"><button type="button" role="tab" aria-selected="false">General</button><button type="button" role="tab" aria-selected="true">Ports · 52</button></div>` +
      `<div class="cat-preview cat-preview-2"><span class="cat-side">Front</span><svg viewBox="0 0 ${front.width} ${front.height}">${front.body}</svg>` +
      `<span class="cat-side">Rear<br>ports</span><svg viewBox="0 0 ${G.BAY} ${G.U}">${rear.body}${rearPorts}</svg></div>` +
      `<table class="pt-table"><thead><tr><th>Names</th><th>Connector</th><th>Speed</th><th>Side</th><th class="pt-count">Ports</th><th></th></tr></thead><tbody>${rows}</tbody></table>` +
      `<div class="cat-actions"><button type="button" class="btn sm">${icon('plus', 'ic-sm')}Add ports</button><button type="button" class="btn sm subtle">Copy from type…${icon('chevron', 'ic-sm')}</button></div>` +
      `<p class="sec-hint">A range in brackets names a series: swp[1-48] is swp1 … swp48, Ethernet1/[1-32] works too; a plain name such as bmc is one port. Side is where the ports face once mounted: switches that face the hot aisle have them on the rear.</p>` +
      `<p class="cat-note">${icon('info', 'ic-sm')}${switches.length} switches of this type use ${cabled} of these ports. A change that removes cabled ports lists the cables it would unplug before it applies.</p>`;
  }

  window.cablingMockups = { showElevation, showPortMap, showSchedule, showFabric, showCatalogPorts, plan };
})();
