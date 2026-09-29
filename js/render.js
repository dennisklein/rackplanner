/*
 * Rackplanner: SVG rendering of the rack elevation sheet.
 *
 * Produces SVG markup strings with concrete colors (no CSS variables), so the
 * same output works on screen, as a downloaded .svg and as a PNG export.
 * Also owns the sheet geometry, including hit testing for drag and drop.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'));
  else (root.RP = root.RP || {}).render = factory(root.RP.model);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  // ------------------------------------------------------------- geometry
  // One height unit is drawn 20 px tall; the 19" mounting width is 240 px.

  const U = 20;
  const BAY_W = 240;
  const RAIL = 24;
  const FRAME = 10;
  const SIDE_W = 36;
  const GAP = 36;
  const MX = 28;
  const TOP = 30;
  const HEADER = 50;
  const PLINTH = 12;
  const EAR = 9;

  const UH = U * M.RACK_UNITS;
  const RACK_W = FRAME + RAIL + BAY_W + RAIL + SIDE_W + FRAME;
  const RACK_TOP = TOP + HEADER;
  const U_TOP = RACK_TOP + FRAME;
  const U_BOTTOM = U_TOP + UH;
  const RACK_BOTTOM = U_BOTTOM + FRAME;
  const SHEET_W = MX * 2 + M.RACK_COUNT * RACK_W + (M.RACK_COUNT - 1) * GAP;
  const FOOT_TOP = RACK_BOTTOM + PLINTH + 30;
  const SLOT_W = U;
  const SLOT_H = BAY_W;
  const SLOT_GAP = (UH - M.SIDE_SLOTS * SLOT_H) / (M.SIDE_SLOTS + 1);
  const TITLE_W = 330;
  const TITLE_H = 58;

  const rackX = (i) => MX + i * (RACK_W + GAP);
  const bayX = (i) => rackX(i) + FRAME + RAIL;
  const sideX = (i) => bayX(i) + BAY_W + RAIL;
  const slotX = (i) => sideX(i) + (SIDE_W - SLOT_W) / 2 - 2;
  const slotY = (k) => U_TOP + SLOT_GAP + k * (SLOT_H + SLOT_GAP);
  // Units are numbered from the top: U1 is the topmost row, U47 the bottom one.
  const unitY = (u) => U_TOP + (u - 1) * U;

  // ---------------------------------------------------------------- fonts

  const FONT_MONO = `'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace`;
  const FONT_UI = `Barlow, 'Segoe UI', system-ui, -apple-system, sans-serif`;
  const FONT_COND = `'Barlow Condensed', 'Arial Narrow', Barlow, sans-serif`;
  const FONTS = {
    name1: { css: `500 11px ${FONT_MONO}`, family: FONT_MONO, size: 11, weight: 500 },
    name: { css: `600 12.5px ${FONT_MONO}`, family: FONT_MONO, size: 12.5, weight: 600 },
    tag: { css: `600 8.5px ${FONT_UI}`, family: FONT_UI, size: 8.5, weight: 600 },
    tape: { css: `600 11.5px ${FONT_MONO}`, family: FONT_MONO, size: 11.5, weight: 600 },
    stat: { css: `500 10.5px ${FONT_MONO}`, family: FONT_MONO, size: 10.5, weight: 500 },
    legend: { css: `500 12px ${FONT_UI}`, family: FONT_UI, size: 12, weight: 500 },
    title: { css: `600 17px ${FONT_COND}`, family: FONT_COND, size: 17, weight: 600 },
    rail: { css: `500 8.5px ${FONT_MONO}`, family: FONT_MONO, size: 8.5, weight: 500 },
    cap: { css: `600 7px ${FONT_UI}`, family: FONT_UI, size: 7, weight: 600 },
    small: { css: `500 9.5px ${FONT_MONO}`, family: FONT_MONO, size: 9.5, weight: 500 },
  };

  // --------------------------------------------------------------- themes

  const THEMES = {
    light: {
      paper: '#f8f9fb', grid: '#e9edf1', gridMajor: '#dde3e9', border: '#bfc8d2',
      ink: '#18212b', ink2: '#4f5b68', ink3: '#8390a0',
      frame: '#2a3038', frameHi: '#3b424c', rail: '#343b44', railText: '#b3bdc8', railTick: '#4b535e', hole: '#1b1f25',
      slotA: '#f2f4f7', slotB: '#e8ecf0', slotLine: '#dce1e7',
      channel: '#30373f', channelSlot: '#e8ecf0', slotDash: '#8e99a6', finger: '#464e59',
      faceBase: '#ffffff', faceMix: 0.15, bayMix: 0.3, deep: '#10151b', edgeMix: 0.32,
      tape: '#f2c230', tapeShade: '#c99b12', tapeInk: '#1b1f24', bar: '#2a3038', barTrack: '#dfe4ea',
      select: '#18212b', handle: '#f2c230', ok: '#1f9d55', bad: '#d33c3c',
      unassigned: '#8c96a3', perf: 'rgba(16,21,27,0.3)', led: '#2fbf64',
    },
    dark: {
      paper: '#161b21', grid: '#1c2229', gridMajor: '#222931', border: '#36404b',
      ink: '#e6ebf0', ink2: '#a5b0bc', ink3: '#6f7b89',
      frame: '#39414b', frameHi: '#48515c', rail: '#434c57', railText: '#a3aeba', railTick: '#58626e', hole: '#1a1e24',
      slotA: '#1e242b', slotB: '#232a32', slotLine: '#2b333c',
      channel: '#3d4550', channelSlot: '#232a32', slotDash: '#687482', finger: '#525b67',
      faceBase: '#1b2128', faceMix: 0.3, bayMix: 0.44, deep: '#07090c', edgeMix: 0.42,
      tape: '#f2c230', tapeShade: '#a07a0c', tapeInk: '#1b1f24', bar: '#c9d2dc', barTrack: '#2b333c',
      select: '#f3f6f9', handle: '#f2c230', ok: '#43c47a', bad: '#f06464',
      unassigned: '#7d8794', perf: 'rgba(255,255,255,0.2)', led: '#43d17a',
    },
  };

  // --------------------------------------------------------------- colors

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  }
  /** Linear blend from color a to color b; t = share of b. */
  function mix(a, b, t) {
    const A = hexToRgb(a);
    const B = hexToRgb(b);
    return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
  }

  /** Derives the full device color scheme from a cluster's base color. */
  function schemeFor(color, theme) {
    const T = THEMES[theme] || THEMES.light;
    const base = M.normalizeHex(color) || T.unassigned;
    const dark = theme === 'dark';
    return {
      base,
      ear: dark ? mix(base, '#000000', 0.1) : base,
      screw: mix(base, '#ffffff', 0.55),
      face: mix(T.faceBase, base, T.faceMix),
      bay: mix(T.faceBase, base, T.bayMix),
      edge: mix(base, T.deep, T.edgeMix),
      detail: dark ? mix(base, '#ffffff', 0.25) : mix(base, T.deep, 0.5),
      port: mix(base, T.deep, dark ? 0.82 : 0.7),
      text: T.ink,
      sub: T.ink2,
      led: T.led,
    };
  }

  // -------------------------------------------------------------- helpers

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const r1 = (v) => Math.round(v * 100) / 100;

  function approxMeasure(text, css) {
    const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(css)[1]);
    const perChar = /Mono/.test(css) ? 0.6 : 0.52;
    return text.length * size * perChar;
  }

  /** Shortens text with an ellipsis until it fits `max` px. */
  function fitText(text, font, max, measure) {
    const m = measure || approxMeasure;
    if (m(text, font.css) <= max) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (m(text.slice(0, mid) + '…', font.css) <= max) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo) + '…' : '…';
  }

  function text(x, y, str, font, fill, extra) {
    return `<text x="${r1(x)}" y="${r1(y)}" font-family="${font.family}" font-size="${font.size}" font-weight="${font.weight}" fill="${fill}"${extra || ''}>${esc(str)}</text>`;
  }

  const rectPath = (x, y, w, h) => `M${r1(x)} ${r1(y)}h${r1(w)}v${r1(h)}h${r1(-w)}z`;

  // --------------------------------------------------------- device faces
  // Each face is drawn in local coordinates: (0,0) top-left, BAY_W wide.

  const LABEL_X = EAR + 7;
  const DETAIL_X = 108;
  const DETAIL_R = BAY_W - EAR - 6;
  const DETAIL_W = DETAIL_R - DETAIL_X;

  function rj45Ports(sc) {
    const cols = 24;
    const per = 6;
    const gIn = 1;
    const gOut = 3.5;
    const pw = (DETAIL_W - (cols - cols / per) * gIn - (cols / per - 1) * gOut) / cols;
    let d = '';
    let x = DETAIL_X;
    for (let c = 0; c < cols; c++) {
      d += rectPath(x, 4, pw, 5) + rectPath(x, 11, pw, 5);
      x += pw + ((c + 1) % per === 0 ? gOut : gIn);
    }
    return `<path d="${d}" fill="${sc.port}"/>`;
  }

  function qsfpCages(sc) {
    const cols = 12;
    const gIn = 1.6;
    const gOut = 5;
    const pw = (DETAIL_W - 10 * gIn - gOut) / cols;
    let outer = '';
    let inner = '';
    let x = DETAIL_X;
    for (let c = 0; c < cols; c++) {
      for (const y of [3, 10.5]) {
        outer += rectPath(x, y, pw, 6.5);
        inner += rectPath(x + 1.3, y + 1.4, pw - 2.6, 3.7);
      }
      x += pw + (c === 5 ? gOut : gIn);
    }
    return `<path d="${outer}" fill="${sc.bay}" stroke="${sc.detail}" stroke-width="0.6"/><path d="${inner}" fill="${sc.port}"/>`;
  }

  function computeBays(sc) {
    const n = 10;
    const pitch = DETAIL_W / n;
    const w = pitch - 1.6;
    let bays = '';
    let handles = '';
    let leds = '';
    for (let i = 0; i < n; i++) {
      const x = DETAIL_X + i * pitch;
      bays += rectPath(x, 5, w, 30);
      handles += `M${r1(x + 2)} 29.5h${r1(w - 4)}`;
      leds += rectPath(x + w - 3.2, 7.5, 1.6, 1.6);
    }
    return (
      `<path d="${bays}" fill="${sc.bay}" stroke="${sc.detail}" stroke-width="0.7"/>` +
      `<path d="${handles}" stroke="${sc.detail}" stroke-width="1.1" stroke-linecap="round"/>` +
      `<path d="${leds}" fill="${sc.detail}"/>`
    );
  }

  function storageBays(sc) {
    const cols = 6;
    const rows = 4;
    const px = DETAIL_W / cols;
    const py = 70 / rows;
    let bays = '';
    let handles = '';
    let leds = '';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = DETAIL_X + c * px;
        const y = 5 + r * py;
        bays += rectPath(x, y, px - 1.8, py - 2);
        handles += `M${r1(x + 2.5)} ${r1(y + py - 6)}h${r1((px - 1.8) * 0.5)}`;
        leds += rectPath(x + px - 6, y + 2.5, 1.8, 1.8);
      }
    }
    return (
      `<path d="${bays}" fill="${sc.bay}" stroke="${sc.detail}" stroke-width="0.7"/>` +
      `<path d="${handles}" stroke="${sc.detail}" stroke-width="1.1" stroke-linecap="round"/>` +
      `<path d="${leds}" fill="${sc.detail}"/>`
    );
  }

  function controlPanel(sc, h) {
    const y = h - 15;
    return (
      `<circle cx="${LABEL_X + 5}" cy="${y}" r="4.5" fill="${sc.bay}" stroke="${sc.detail}" stroke-width="0.9"/>` +
      `<path d="M${LABEL_X + 5} ${y - 2.4}v2.2M${LABEL_X + 3.1} ${y - 1.3}a2.4 2.4 0 1 0 3.8 0" fill="none" stroke="${sc.detail}" stroke-width="0.8" stroke-linecap="round"/>` +
      `<circle cx="${LABEL_X + 15}" cy="${y}" r="1.5" fill="${sc.led}"/>` +
      `<circle cx="${LABEL_X + 20}" cy="${y}" r="1.5" fill="${sc.detail}"/>` +
      `<path d="${rectPath(LABEL_X + 27, y - 2, 7, 4)}" fill="${sc.port}"/>`
    );
  }

  function enclosureDrawers(sc, theme) {
    let out = '';
    for (const y of [4, 42]) {
      out +=
        `<rect x="${DETAIL_X}" y="${y}" width="${DETAIL_W}" height="34" rx="1" fill="${sc.bay}" stroke="${sc.detail}" stroke-width="0.7"/>` +
        `<rect x="${DETAIL_X + 3}" y="${y + 3}" width="${DETAIL_W - 6}" height="21" fill="url(#rp-perf-${theme})"/>` +
        `<rect x="${r1(DETAIL_X + DETAIL_W / 2 - 18)}" y="${y + 27}" width="36" height="4" rx="2" fill="${sc.detail}"/>` +
        `<circle cx="${DETAIL_X + 7}" cy="${y + 29}" r="1.5" fill="${sc.led}"/>`;
    }
    return out;
  }

  function deviceFace(typeId, name, sc, theme, measure) {
    const type = M.typeById(typeId);
    const w = BAY_W;
    const h = type.height * U;
    let s = '';
    s += `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="2" fill="${sc.ear}"/>`;
    s += `<rect x="${EAR}" y="0.5" width="${w - 2 * EAR}" height="${h - 1}" fill="${sc.face}"/>`;
    const screws = type.height === 1 ? [h / 2] : [U / 2, h - U / 2];
    for (const y of screws) {
      s += `<circle cx="${EAR / 2 + 0.5}" cy="${y}" r="1.7" fill="${sc.screw}"/>`;
      s += `<circle cx="${w - EAR / 2 - 0.5}" cy="${y}" r="1.7" fill="${sc.screw}"/>`;
    }

    switch (typeId) {
      case 'switch-rj45':
        s += rj45Ports(sc);
        break;
      case 'switch-qsfp':
        s += qsfpCages(sc);
        break;
      case 'compute-node':
        s += computeBays(sc);
        break;
      case 'storage-node':
        s += storageBays(sc) + controlPanel(sc, h);
        break;
      case 'storage-enclosure':
        s += enclosureDrawers(sc, theme);
        s += `<circle cx="${LABEL_X + 2}" cy="${h - 15}" r="1.5" fill="${sc.led}"/>`;
        s += `<circle cx="${LABEL_X + 7}" cy="${h - 15}" r="1.5" fill="${sc.detail}"/>`;
        s += `<circle cx="${LABEL_X + 12}" cy="${h - 15}" r="1.5" fill="${sc.detail}"/>`;
        break;
    }

    const labelMax = DETAIL_X - LABEL_X - 6;
    if (type.height === 1) {
      s += `<circle cx="${DETAIL_X - 5}" cy="${h / 2}" r="1.4" fill="${sc.led}"/>`;
      s += text(LABEL_X, h / 2 + 3.9, fitText(name, FONTS.name1, labelMax - 5, measure), FONTS.name1, sc.text);
    } else {
      s += text(LABEL_X, 16, fitText(name, FONTS.name, labelMax, measure), FONTS.name, sc.text);
      s += text(LABEL_X, 29, `${type.tag} · ${type.height}U`, FONTS.tag, sc.sub, ' letter-spacing="0.8"');
    }
    s += `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="2" fill="none" stroke="${sc.edge}"/>`;
    return s;
  }

  /** Where a device of `typeId` at `loc` is drawn on the sheet. */
  function locRect(project, typeId, loc) {
    const i = M.rackIndex(project, loc.rack);
    const type = M.typeById(typeId);
    if (loc.kind === 'side') return { x: slotX(i), y: slotY(loc.at), w: SLOT_W, h: SLOT_H, rotated: true };
    return { x: bayX(i), y: unitY(loc.at), w: BAY_W, h: type.height * U, rotated: false };
  }

  // Side-mounted devices are drawn rotated so their label reads bottom to top.
  const placeTransform = (r) => (r.rotated ? `translate(${r1(r.x)} ${r1(r.y + r.h)}) rotate(-90)` : `translate(${r1(r.x)} ${r1(r.y)})`);

  // ------------------------------------------------------------ the sheet

  function defs(theme, T) {
    const gx = r1(bayX(0) % U);
    const gy = r1(U_TOP % U);
    return (
      `<defs>` +
      `<pattern id="rp-grid-${theme}" width="${U}" height="${U}" x="${gx}" y="${gy}" patternUnits="userSpaceOnUse">` +
      `<path d="M${U} 0H0V${U}" fill="none" stroke="${T.grid}" stroke-width="0.6"/></pattern>` +
      `<pattern id="rp-grid5-${theme}" width="${U * 5}" height="${U * 5}" x="${gx}" y="${gy}" patternUnits="userSpaceOnUse">` +
      `<path d="M${U * 5} 0H0V${U * 5}" fill="none" stroke="${T.gridMajor}" stroke-width="0.8"/></pattern>` +
      `<pattern id="rp-perf-${theme}" width="4" height="4" patternUnits="userSpaceOnUse">` +
      `<circle cx="2" cy="2" r="0.9" fill="${T.perf}"/></pattern>` +
      `</defs>`
    );
  }

  function rackHeader(project, rack, i, T, o, measure) {
    const x = rackX(i);
    const st = M.rackStats(project, rack.id);
    const name = fitText(rack.name, FONTS.tape, RACK_W - 130, measure);
    const tw = (measure || approxMeasure)(name, FONTS.tape.css) + 18;
    const pct = st.used / M.RACK_UNITS;
    let s = `<g class="rack-head" data-rack="${esc(rack.id)}">`;
    if (o.interactive) s += `<rect x="${x}" y="${TOP - 4}" width="${RACK_W}" height="${HEADER - 4}" fill="#000" fill-opacity="0"/>`;
    s += `<rect x="${x + 1}" y="${TOP + 5}" width="${r1(tw)}" height="21" rx="1.5" fill="${T.tapeShade}"/>`;
    s += `<rect x="${x}" y="${TOP + 4}" width="${r1(tw)}" height="21" rx="1.5" fill="${T.tape}"/>`;
    s += text(x + 9, TOP + 18.5, name, FONTS.tape, T.tapeInk);
    s += text(x + RACK_W, TOP + 18.5, `${st.used}/${M.RACK_UNITS} U · side ${st.sideUsed}/${M.SIDE_SLOTS}`, FONTS.stat, T.ink2, ' text-anchor="end"');
    s += `<rect x="${x}" y="${TOP + 33}" width="${RACK_W}" height="4" rx="2" fill="${T.barTrack}"/>`;
    if (st.used) s += `<rect x="${x}" y="${TOP + 33}" width="${r1(Math.max(4, RACK_W * pct))}" height="4" rx="2" fill="${T.bar}"/>`;
    if (o.interactive) s += `<title>${esc(`${rack.name}: ${st.used} of ${M.RACK_UNITS} U used, ${st.free} U free, side slots ${st.sideUsed}/${M.SIDE_SLOTS}`)}</title>`;
    return s + `</g>`;
  }

  function rackBody(i, T) {
    const x = rackX(i);
    const bx = bayX(i);
    const lx = x + FRAME;
    const rx = bx + BAY_W;
    const sx = sideX(i);
    let s = '';
    // Frame and feet.
    s += `<rect x="${x + 10}" y="${RACK_BOTTOM}" width="42" height="${PLINTH}" rx="1.5" fill="${T.frameHi}"/>`;
    s += `<rect x="${x + RACK_W - 52}" y="${RACK_BOTTOM}" width="42" height="${PLINTH}" rx="1.5" fill="${T.frameHi}"/>`;
    s += `<rect x="${x}" y="${RACK_TOP}" width="${RACK_W}" height="${RACK_BOTTOM - RACK_TOP}" rx="3" fill="${T.frame}"/>`;
    s += `<rect x="${x + 3}" y="${RACK_TOP + 3}" width="${RACK_W - 6}" height="2" rx="1" fill="${T.frameHi}"/>`;
    // Rails.
    s += `<rect x="${lx}" y="${U_TOP}" width="${RAIL}" height="${UH}" fill="${T.rail}"/>`;
    s += `<rect x="${rx}" y="${U_TOP}" width="${RAIL}" height="${UH}" fill="${T.rail}"/>`;
    // Unit slots, alternating shade; U1 sits at the top.
    let slotsA = '';
    let slotsB = '';
    let holes = '';
    let ticks = '';
    let nums = '';
    for (let u = 1; u <= M.RACK_UNITS; u++) {
      const y = unitY(u);
      if (u % 2) slotsA += rectPath(bx, y, BAY_W, U);
      else slotsB += rectPath(bx, y, BAY_W, U);
      for (const hy of [3, 8.5, 14]) {
        holes += rectPath(lx + RAIL - 7, y + hy, 4, 3) + rectPath(rx + 3, y + hy, 4, 3);
      }
      ticks += `M${lx} ${y + U - 0.5}h${u % 5 === 0 ? 9 : 5}`;
      nums += text(lx + 13, y + 13.5, String(u), FONTS.rail, T.railText, ' text-anchor="end"');
    }
    s += `<path d="${slotsA}" fill="${T.slotA}"/><path d="${slotsB}" fill="${T.slotB}"/>`;
    s += `<path d="${holes}" fill="${T.hole}"/><path d="${ticks}" stroke="${T.railTick}"/>`;
    s += nums;
    // Vertical side channel with cable fingers and the two 1U side slots.
    s += `<rect x="${sx}" y="${U_TOP}" width="${SIDE_W}" height="${UH}" fill="${T.channel}"/>`;
    let fingers = '';
    for (let y = U_TOP + 6; y < U_BOTTOM - 10; y += 2 * U) fingers += rectPath(sx + SIDE_W - 7, y, 5, 9);
    s += `<path d="${fingers}" fill="${T.finger}"/>`;
    return s;
  }

  function sideSlots(project, rack, i, T) {
    let s = '';
    for (let k = 0; k < M.SIDE_SLOTS; k++) {
      const x = slotX(i);
      const y = slotY(k);
      s += `<rect x="${x}" y="${y}" width="${SLOT_W}" height="${SLOT_H}" rx="1.5" fill="${T.channelSlot}"/>`;
      s += `<rect x="${x + 0.5}" y="${y + 0.5}" width="${SLOT_W - 1}" height="${SLOT_H - 1}" rx="1.5" fill="none" stroke="${T.slotDash}" stroke-dasharray="3 2.5"/>`;
      const cx = x + SLOT_W / 2 + 3.2;
      const cy = y + SLOT_H / 2;
      s += `<text x="${cx}" y="${cy}" transform="rotate(-90 ${cx} ${cy})" text-anchor="middle" font-family="${FONT_MONO}" font-size="8.5" font-weight="500" fill="${T.ink3}" letter-spacing="1">SIDE V${k + 1} · 1U</text>`;
    }
    return s;
  }

  function deviceNode(project, d, T, theme, o, measure) {
    const type = M.typeById(d.type);
    const cluster = M.clusterById(project, d.cluster);
    const sc = schemeFor(cluster ? cluster.color : null, theme);
    const r = locRect(project, d.type, d.loc);
    const focus = o.focusCluster;
    const dim = focus !== undefined && focus !== null && (focus === '__none' ? d.cluster !== null : d.cluster !== focus);
    const cls = ['dev'];
    if (o.draggingId === d.id) cls.push('is-dragging');
    if (o.selectedDevice === d.id) cls.push('is-selected');
    let s = `<g class="${cls.join(' ')}" data-id="${esc(d.id)}" transform="${placeTransform(r)}"${dim ? ' opacity="0.2"' : ''}`;
    if (o.interactive) {
      const where = M.formatLoc(project, d.loc, d.type);
      const label = `${d.name}, ${type.label}, ${where}${cluster ? `, cluster ${cluster.name}` : ''}`;
      s += ` tabindex="0" role="button" aria-label="${esc(label)}">`;
      s += `<title>${esc(`${d.name}\n${type.label} (${type.height}U)\n${where}${cluster ? `\nCluster: ${cluster.name}` : ''}`)}</title>`;
    } else s += '>';
    s += deviceFace(d.type, d.name, sc, theme, measure);
    if (o.interactive) {
      s += `<rect class="dev-hl" x="-1.5" y="-1.5" width="${BAY_W + 3}" height="${type.height * U + 3}" rx="3" fill="none" stroke="${T.ink}" stroke-width="1.5"/>`;
    }
    return s + '</g>';
  }

  /** CAD-style selection: dashed outline with yellow corner handles. */
  function selectionMarks(x, y, w, h, T) {
    const pad = 3.5;
    const X = x - pad;
    const Y = y - pad;
    const W = w + pad * 2;
    const H = h + pad * 2;
    let s = `<g class="sel-marks" pointer-events="none">`;
    s += `<rect x="${r1(X)}" y="${r1(Y)}" width="${r1(W)}" height="${r1(H)}" rx="2" fill="none" stroke="${T.select}" stroke-width="1.5" stroke-dasharray="5 3"/>`;
    for (const [hx, hy] of [[X, Y], [X + W, Y], [X, Y + H], [X + W, Y + H]]) {
      s += `<rect x="${r1(hx - 3.5)}" y="${r1(hy - 3.5)}" width="7" height="7" fill="${T.handle}" stroke="${T.select}" stroke-width="1.2"/>`;
    }
    return s + '</g>';
  }

  function legendLayout(project, measure) {
    const m = measure || approxMeasure;
    const items = project.clusters.map((c) => ({
      name: c.name,
      color: c.color,
      count: project.devices.filter((d) => d.cluster === c.id).length,
    }));
    const unassigned = project.devices.filter((d) => !d.cluster).length;
    if (unassigned) items.push({ name: 'Unassigned', color: null, count: unassigned });
    const maxW = SHEET_W - MX * 2 - TITLE_W - 40;
    let x = 0;
    let row = 0;
    for (const it of items) {
      it.label = fitText(it.name, FONTS.legend, 200, m);
      it.w = 20 + m(it.label, FONTS.legend.css) + 8 + m(String(it.count), FONTS.stat.css) + 26;
      if (x > 0 && x + it.w > maxW) {
        x = 0;
        row++;
      }
      it.x = x;
      it.row = row;
      x += it.w;
    }
    const rows = items.length ? row + 1 : 1;
    return { items, height: Math.max(TITLE_H, 20 + rows * 22) };
  }

  function footer(project, lay, T, theme, o, measure) {
    let s = '';
    const y0 = FOOT_TOP;
    s += text(MX, y0 + 9, 'CLUSTERS', FONTS.tag, T.ink3, ' letter-spacing="1.2"');
    if (!lay.items.length) s += text(MX, y0 + 31, 'No devices placed yet', FONTS.legend, T.ink3);
    for (const it of lay.items) {
      const x = MX + it.x;
      const y = y0 + 20 + it.row * 22;
      const sc = schemeFor(it.color, theme);
      s += `<rect x="${x}" y="${y + 2}" width="14" height="12" rx="2" fill="${sc.ear}" stroke="${sc.edge}"/>`;
      s += `<text x="${x + 20}" y="${y + 12}" font-family="${FONTS.legend.family}" font-size="${FONTS.legend.size}" font-weight="${FONTS.legend.weight}" fill="${T.ink}">${esc(it.label)}<tspan dx="7" font-family="${FONTS.stat.family}" font-size="${FONTS.stat.size}" fill="${T.ink3}">${it.count}</tspan></text>`;
    }

    // Title block in the lower right corner, like a drawing sheet.
    const x = SHEET_W - MX - TITLE_W;
    const y = y0;
    const c1 = 220;
    s += `<rect x="${x + 0.5}" y="${y + 0.5}" width="${TITLE_W - 1}" height="${TITLE_H - 1}" fill="${T.paper}" stroke="${T.ink2}"/>`;
    s += `<path d="M${x + c1 + 0.5} ${y}v${TITLE_H}M${x} ${y + 34.5}h${TITLE_W}" stroke="${T.ink2}" stroke-width="0.7"/>`;
    const cap = (cx, cy, str) => text(cx, cy, str, FONTS.cap, T.ink3, ' letter-spacing="1"');
    s += cap(x + 7, y + 10, 'RACK PLAN');
    s += text(x + 7, y + 27, fitText(project.name, FONTS.title, c1 - 14, measure), FONTS.title, T.ink);
    s += cap(x + c1 + 7, y + 10, 'DATE');
    s += text(x + c1 + 7, y + 26, o.date || '', FONTS.stat, T.ink);
    s += text(x + 7, y + 49.5, `${M.RACK_COUNT} racks · 19″ · ${M.RACK_UNITS}U + ${M.SIDE_SLOTS} side slots`, FONTS.small, T.ink2);
    s += text(x + c1 + 7, y + 49.5, '1U = 44.45 mm', FONTS.small, T.ink2);
    return s;
  }

  /**
   * Renders the whole sheet. Options:
   *   theme: 'light' | 'dark'      interactive: adds focus/hover hooks
   *   selectedDevice, selectedRack, focusCluster ('__none' = unassigned),
   *   draggingId, date, measure(text, cssFont) → px
   */
  function renderScene(project, opts) {
    const o = opts || {};
    const theme = o.theme === 'dark' ? 'dark' : 'light';
    const T = THEMES[theme];
    const measure = o.measure || approxMeasure;
    const lay = legendLayout(project, measure);
    const height = Math.round(FOOT_TOP + lay.height + 30);
    let s = defs(theme, T);
    s += `<rect class="sheet" width="${SHEET_W}" height="${height}" fill="${T.paper}"/>`;
    s += `<rect width="${SHEET_W}" height="${height}" fill="url(#rp-grid-${theme})" pointer-events="none"/>`;
    s += `<rect width="${SHEET_W}" height="${height}" fill="url(#rp-grid5-${theme})" pointer-events="none"/>`;
    s += `<rect x="10.5" y="10.5" width="${SHEET_W - 21}" height="${height - 21}" fill="none" stroke="${T.border}" pointer-events="none"/>`;

    project.racks.forEach((rack, i) => {
      s += `<g class="rack" data-rack="${esc(rack.id)}">`;
      s += rackHeader(project, rack, i, T, o, measure);
      s += rackBody(i, T);
      s += sideSlots(project, rack, i, T);
      for (const d of M.sortedDevices(project, rack.id)) s += deviceNode(project, d, T, theme, o, measure);
      s += '</g>';
    });
    s += footer(project, lay, T, theme, o, measure);

    if (o.selectedRack) {
      const i = M.rackIndex(project, o.selectedRack);
      if (i >= 0) s += selectionMarks(rackX(i), RACK_TOP, RACK_W, RACK_BOTTOM - RACK_TOP, T);
    }
    if (o.selectedDevice) {
      const d = M.deviceById(project, o.selectedDevice);
      if (d) {
        const r = locRect(project, d.type, d.loc);
        s += selectionMarks(r.x, r.y, r.w, r.h, T);
      }
    }
    return { width: SHEET_W, height, body: s };
  }

  /** Translucent preview of a device at `loc`, outlined green (fits) or red. */
  function renderGhost(project, typeId, loc, ok, opts) {
    const o = opts || {};
    const theme = o.theme === 'dark' ? 'dark' : 'light';
    const T = THEMES[theme];
    const r = locRect(project, typeId, loc);
    const type = M.typeById(typeId);
    const sc = schemeFor(o.color || null, theme);
    const color = ok ? T.ok : T.bad;
    let s = `<g pointer-events="none">`;
    s += `<g transform="${placeTransform(r)}" opacity="${ok ? 0.92 : 0.55}">${deviceFace(typeId, o.name || type.label, sc, theme, o.measure)}</g>`;
    if (!ok) s += `<rect x="${r1(r.x)}" y="${r1(r.y)}" width="${r.w}" height="${r.h}" fill="${T.bad}" fill-opacity="0.18"/>`;
    s += `<rect x="${r1(r.x - 1.5)}" y="${r1(r.y - 1.5)}" width="${r.w + 3}" height="${r.h + 3}" rx="2.5" fill="none" stroke="${color}" stroke-width="2"/>`;
    return s + '</g>';
  }

  /**
   * Maps a sheet coordinate to a drop location for a device of `typeId`.
   * `grab` is the distance in px from the device's top edge to the pointer.
   */
  function locateDrop(project, typeId, x, y, grab) {
    const type = M.typeById(typeId);
    if (!type) return null;
    if (y < RACK_TOP - HEADER - 40 || y > RACK_BOTTOM + 60) return null;
    for (let i = 0; i < project.racks.length; i++) {
      const left = rackX(i) - GAP / 2;
      const right = rackX(i) + RACK_W + GAP / 2;
      if (x < left || x >= right) continue;
      const rack = project.racks[i].id;
      if (x >= sideX(i) - 2) {
        return { rack, kind: 'side', at: y < U_TOP + UH / 2 ? 0 : 1 };
      }
      const top = Math.round((y - grab - U_TOP) / U);
      const t = Math.max(0, Math.min(M.RACK_UNITS - type.height, top));
      return { rack, kind: 'u', at: t + 1 };
    }
    return null;
  }

  /** Small standalone drawing of a device for the parts bin. */
  function renderPreview(typeId, theme, color, name, measure) {
    const th = theme === 'dark' ? 'dark' : 'light';
    const type = M.typeById(typeId);
    return {
      width: BAY_W,
      height: type.height * U,
      body: defs(th, THEMES[th]) + deviceFace(typeId, name || type.label, schemeFor(color || null, th), th, measure),
    };
  }

  /** Complete standalone SVG document (light theme) for download. */
  function exportSVG(project, opts) {
    const o = Object.assign({}, opts, { theme: 'light', interactive: false, selectedDevice: null, selectedRack: null, focusCluster: null, draggingId: null });
    const sc = renderScene(project, o);
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${sc.width}" height="${sc.height}" viewBox="0 0 ${sc.width} ${sc.height}">` +
      `<title>${esc(project.name)}</title>${sc.body}</svg>`
    );
  }

  return {
    geometry: { U, BAY_W, RACK_W, SHEET_W, U_TOP, RACK_TOP, SLOT_H },
    THEMES,
    FONTS,
    mix,
    schemeFor,
    fitText,
    renderScene,
    renderGhost,
    renderPreview,
    locateDrop,
    locRect,
    exportSVG,
  };
});
