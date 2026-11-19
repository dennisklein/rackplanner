/*
 * Rackplanner: the drawing of the Power workspace.
 *
 * elevation() draws a row from the rear or the front as an SVG string:
 * the devices with their inlets, the PDUs in the side channels with
 * their outlets, and each power cord from its inlet into the channel
 * and along it to its outlet, in the color of its grid. The front shows
 * the devices with their inlets and the PDUs behind them, dashed, but no
 * cords: they run at the rear. No DOM access:
 * js/power-ui.js puts the drawing on the page and takes the clicks by
 * the data attributes (data-dev, data-inlet, data-pdu, data-outlet,
 * data-cord).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'), require('./power.js'), require('./render.js'));
  else (root.RP = root.RP || {}).powerRender = factory(root.RP.model, root.RP.power, root.RP.render);
})(typeof self !== 'undefined' ? self : this, function (M, P, R) {
  'use strict';

  const esc = R.esc;
  const r1 = R.r1;
  const MONO = R.FONTS.name.family;
  const font = (size, weight) => ({ family: MONO, size, weight: weight || 500, css: `${weight || 500} ${size}px ${MONO}` });
  const F = { name: font(10.5, 600), small: font(8.5), pdu: font(8.5, 600), sub: font(8), unit: font(7.5), label: font(11, 600), stat: font(10), tag: font(10, 600), caption: font(10) };

  // One rack: a frame, unit numbers, a channel on each side of the bay.
  const G = { UH: 17, PAD: 6, NUM: 16, CH: 62, DEV: 268, STRIP: 14, STRIP_GAP: 4, GAP: 128, MARGIN: 36, HEAD: 44, FOOT: 46, SIDE_H: 22, LABEL: 12 };
  G.RACK_W = G.PAD * 2 + G.NUM * 2 + G.CH * 2 + G.DEV;

  /**
   * How wide the strips of `n` PDUs on one side of a rack are, and the gap
   * between them: three or four are narrower, so that they stay in the
   * channel and leave room for the cords beside them.
   */
  const stripSize = (n) => (n <= 2 ? { w: G.STRIP, gap: G.STRIP_GAP } : n === 3 ? { w: 10, gap: 3 } : { w: 8, gap: 2 });
  /** The most PDU slots a rack of `racks` has on one side. */
  const slotsOnASide = (project, racks) =>
    Math.max(0, ...racks.map((r) => Math.max(...['left', 'right'].map((s) => M.rackPduSlots(project, r.id).filter((x) => x === s).length))));

  const flip = (side) => (side === 'front' ? 'rear' : 'front');

  /**
   * Where the racks of row `rowId` stand in the drawing seen from `side`
   * ('rear' mirrors the row: its first rack is on the right), on one
   * floor line: [{ rack, x, top, units, chL, chR, dev, bottom }] and the
   * size of the sheet. The margin at the sides (`left`) is wider when a
   * rack has four PDUs on one side, for their names beside the frame.
   */
  function layout(project, rowId, side) {
    const pos = M.locateRow(project, rowId) || M.allRows(project)[0];
    const list = side === 'rear' ? pos.row.racks.slice().reverse() : pos.row.racks.slice();
    const units = list.map((r) => M.rackUnits(project, r.id));
    const max = Math.max(...units);
    const left = G.MARGIN + Math.max(0, slotsOnASide(project, list) - 3) * G.LABEL;
    const racks = list.map((rack, i) => {
      const x = left + i * (G.RACK_W + G.GAP);
      const top = G.MARGIN + G.HEAD + (max - units[i]) * G.UH;
      const chL = x + G.PAD + G.NUM;
      const dev = chL + G.CH;
      return { rack, x, top, units: units[i], chL, dev, chR: dev + G.DEV, bottom: top + units[i] * G.UH };
    });
    const sideRow = racks.some((l) => project.devices.some((d) => d.loc.rack === l.rack.id && d.loc.kind === 'side'));
    return {
      pos,
      racks,
      sideRow,
      left,
      width: left * 2 + list.length * G.RACK_W + (list.length - 1) * G.GAP,
      height: G.MARGIN + G.HEAD + max * G.UH + (sideRow ? G.SIDE_H + 14 : 0) + G.FOOT + G.MARGIN,
    };
  }

  /**
   * The Power elevation of a row. opts: {
   *   rowId, side ('rear' by default), theme, measure,
   *   hiddenGrids: grid ids whose cords are not drawn ('' for PDUs without a grid),
   *   selected: { devices: [ids], cords: [ids] }, pending: { device, inlet } | { device, outlet },
   *   match: a Set of device ids to keep at full strength (a search), or null }.
   * Returns { width, height, body }.
   */
  function elevation(project, opts) {
    const o = opts || {};
    const side = o.side === 'front' ? 'front' : 'rear';
    const rear = side === 'rear';
    const theme = o.theme === 'dark' ? 'dark' : 'light';
    const T = R.THEMES[theme];
    const measure = o.measure;
    const lay = layout(project, o.rowId, side);
    const ctx = P.context(project);
    const hidden = new Set(o.hiddenGrids || []);
    const sel = o.selected || {};
    const selDevs = new Set(sel.devices || []);
    const selCords = new Set(sel.cords || []);
    const pending = o.pending || null;
    const text = R.text;
    const gridColor = (pdu) => (M.gridOf(project, pdu) || { color: P.NO_GRID_COLOR }).color;
    const gridKey = (pdu) => (M.gridOf(project, pdu) ? pdu.grid : '');

    let s = `<rect x="0" y="0" width="${lay.width}" height="${lay.height}" fill="${T.paper}"/>`;
    let cords = '';
    let cordsTop = '';
    let over = '';
    const tags = [];
    let nCords = 0;

    for (const l of lay.racks) {
      const rackId = l.rack.id;
      const devs = M.sortedDevices(project, rackId);
      const pdus = devs.filter((d) => d.loc.kind === 'pdu' && M.isPdu(project, d));
      const slots = M.rackPduSlots(project, rackId);
      const frameBottom = l.bottom + (lay.sideRow ? G.SIDE_H + 14 : 0);
      // Frame, channels, bay, unit numbers.
      s += `<g class="pw-rack" data-rack="${esc(rackId)}">`;
      s += `<rect x="${l.x}" y="${l.top - 4}" width="${G.RACK_W}" height="${frameBottom - l.top + 8}" rx="3" fill="${T.frame}"/>`;
      s += `<rect x="${l.chL}" y="${l.top}" width="${G.CH}" height="${l.units * G.UH}" fill="${T.channel}"/><rect x="${l.chR}" y="${l.top}" width="${G.CH}" height="${l.units * G.UH}" fill="${T.channel}"/>`;
      s += `<rect x="${l.dev}" y="${l.top}" width="${G.DEV}" height="${l.units * G.UH}" fill="${T.slotA}"/>`;
      for (let u = 1; u <= l.units; u++) {
        const y = l.top + (u - 1) * G.UH;
        s += text(l.x + G.PAD + G.NUM / 2, y + 11.5, String(u), F.unit, T.railText, ' text-anchor="middle"') + text(l.x + G.RACK_W - G.PAD - G.NUM / 2, y + 11.5, String(u), F.unit, T.railText, ' text-anchor="middle"');
        if (u > 1) s += `<line x1="${l.dev}" y1="${y}" x2="${l.dev + G.DEV}" y2="${y}" stroke="${T.slotLine}" stroke-width="0.6"/>`;
      }

      // PDUs: a strip per slot, the first slot of a side outermost; from the rear the sides swap.
      const strips = new Map();
      const perSide = { left: 0, right: 0 };
      const leftOf = (slotSide) => (slotSide === 'left') === (side === 'front');
      const strip = { left: stripSize(slots.filter(leftOf).length), right: stripSize(slots.filter((x) => !leftOf(x)).length) };
      slots.forEach((slotSide, at) => {
        const onLeft = leftOf(slotSide);
        const k = perSide[onLeft ? 'left' : 'right']++;
        const { w, gap } = strip[onLeft ? 'left' : 'right'];
        const x = onLeft ? l.chL + 4 + k * (w + gap) : l.chR + G.CH - 4 - w - k * (w + gap);
        strips.set(at, { x, w, onLeft, k });
      });
      const lanes = { left: 0, right: 0 };
      const outletAt = new Map();
      let label = '';
      for (const pdu of pdus) {
        const st = strips.get(pdu.loc.at);
        if (!st) continue;
        const info = ctx.info(pdu.type);
        const span = Math.max(1, Math.min(l.units, info.type.pdu.spanU));
        const y0 = l.top + ((l.units - span) / 2) * G.UH;
        const h = span * G.UH;
        const color = gridColor(pdu);
        const faded = hidden.has(gridKey(pdu));
        const n = info.outlets.length;
        const pitch = h / Math.max(1, n);
        const size = Math.max(3, Math.min(8, pitch - 1.5, st.w - 3));
        const grid = M.gridOf(project, pdu);
        let g = `<g class="pw-pdu${selDevs.has(pdu.id) ? ' is-selected' : ''}" data-pdu="${esc(pdu.id)}"${faded ? ' opacity="0.45"' : ''} role="button" tabindex="0" aria-label="${esc(`${pdu.name}, PDU slot P${pdu.loc.at + 1}, ${grid ? grid.name : 'no grid'}`)}">`;
        g += `<rect x="${r1(st.x)}" y="${r1(y0)}" width="${st.w}" height="${r1(h)}" rx="2" fill="${R.mix(T.channel, color, 0.28)}" stroke="${color}" stroke-width="${selDevs.has(pdu.id) ? 2.2 : 1}"${rear ? '' : ' stroke-dasharray="4 3"'}/>`;
        info.outlets.forEach((out, i) => {
          const cy = y0 + (i + 0.5) * pitch;
          const cord = ctx.byOutlet.get(`${pdu.id}|${out.name}`);
          const isPending = pending && pending.device === pdu.id && pending.outlet === out.name;
          outletAt.set(`${pdu.id}|${out.name}`, { x: st.onLeft ? st.x + st.w - 3 : st.x + 3, y: cy, onLeft: st.onLeft, pdu, name: out.name, st });
          g +=
            `<rect class="pw-outlet${cord ? ' is-used' : ''}" data-outlet="${esc(`${pdu.id}|${out.name}`)}" x="${r1(st.x + (st.w - size) / 2)}" y="${r1(cy - size / 2)}" width="${r1(size)}" height="${r1(size)}" rx="1.5" ` +
            `fill="${cord ? color : T.portHole}" stroke="${isPending ? T.handle : cord ? R.mix(color, T.deep, 0.35) : T.portEdge}" stroke-width="${isPending ? 2 : 0.7}">` +
            `<title>${esc(`${pdu.name} outlet ${out.name} · ${M.powerConnectorLabel(out.connector)}${cord ? ` · ${cord.label || 'cord'}` : ' · free'}`)}</title></rect>`;
        });
        s += g + `</g>`;
        // Its name outside the frame, along the strip.
        const tx = st.onLeft ? l.x - 7 - st.k * G.LABEL : l.x + G.RACK_W + 7 + st.k * G.LABEL;
        const ty = y0 + h / 2;
        label += text(tx, ty, `P${pdu.loc.at + 1} · ${pdu.name} · ${grid ? grid.name : 'No grid'}`, F.pdu, color, ` text-anchor="middle" transform="rotate(${st.onLeft ? -90 : 90} ${r1(tx)} ${r1(ty)})"`);
      }
      // Free slots, dashed.
      slots.forEach((slotSide, at) => {
        if (pdus.some((d) => d.loc.at === at)) return;
        const st = strips.get(at);
        s += `<rect class="pw-slot" x="${r1(st.x)}" y="${l.top + 6}" width="${st.w}" height="${l.units * G.UH - 12}" rx="2" fill="none" stroke="${T.slotDash}" stroke-width="1" stroke-dasharray="4 3"/>`;
      });

      // Devices with their inlets; a cord's inlet sits on the side of its PDU.
      const sideDevs = devs.filter((d) => d.loc.kind === 'side');
      const sideW = sideDevs.length ? Math.min(132, (G.DEV - 4) / Math.max(1, M.rackSideSlots(project, rackId))) : 0;
      for (const d of devs) {
        if (d.loc.kind === 'pdu') continue;
        const type = M.typeOf(project, d.type);
        const info = ctx.info(d.type);
        let box;
        if (d.loc.kind === 'side') box = { x: l.dev + 2 + d.loc.at * sideW, y: l.bottom + 12, w: sideW - 4, h: G.SIDE_H - 2 };
        else {
          const [lo, hi] = M.deviceSpan(project, d);
          box = { x: l.dev + 2, y: l.top + (lo - 1) * G.UH + 1, w: G.DEV - 4, h: (hi - lo + 1) * G.UH - 2 };
        }
        const reserved = type.variable;
        const cluster = M.clusterOf(project, d, o.view);
        const sc = R.schemeFor(cluster ? cluster.color : null, theme);
        const dim = o.match && !o.match.has(d.id);
        const selected = selDevs.has(d.id);
        const inlets = info.inlets;
        const tall = box.h > G.UH * 1.5;
        const cy = box.y + box.h / 2 + (tall ? 5 : 0);
        const perEdge = { left: 0, right: 0 };
        let g =
          `<g class="pw-dev${selected ? ' is-selected' : ''}${reserved ? ' is-reserved' : ''}" data-dev="${esc(d.id)}"${dim ? ' opacity="0.3"' : ''}` +
          (reserved ? '' : ` role="button" tabindex="0" aria-label="${esc(`${d.name}, ${type.label}, ${M.formatDeviceLoc(project, d)}, ${M.plural(inlets.length, 'inlet')}`)}"`) +
          `>`;
        g += `<rect x="${r1(box.x)}" y="${r1(box.y)}" width="${r1(box.w)}" height="${r1(box.h)}" rx="1.5" fill="${reserved ? T.reserved : sc.face}" stroke="${reserved ? T.slotDash : sc.edge}" stroke-width="0.8"${reserved ? ' stroke-dasharray="4 3"' : ''}/>`;
        if (!reserved) g += `<rect x="${r1(box.x)}" y="${r1(box.y)}" width="3" height="${r1(box.h)}" fill="${sc.base}"/>`;
        const half = Math.ceil(inlets.length / 2);
        const room = box.w - 16 - (d.loc.kind === 'side' ? inlets.length : half) * 26;
        g += text(box.x + (d.loc.kind === 'side' ? 8 : 8 + half * 13), box.y + (tall ? 12 : box.h / 2 + 3.5), R.fitText(d.name, F.name, Math.max(20, room), measure), F.name, reserved ? T.ink2 : sc.text);
        if (tall && !reserved) g += text(box.x + 8 + half * 13, box.y + 23, R.fitText(`${type.label} · ${P.fmtW(M.powerOf(project, d))}`, F.sub, Math.max(20, room), measure), F.sub, sc.sub);
        inlets.forEach((inl, i) => {
          const key = `${d.id}|${inl.name}`;
          const cord = ctx.byInlet.get(key);
          const out = cord ? outletAt.get(`${cord.outlet.device}|${cord.outlet.outlet}`) : null;
          const onLeft = out ? out.onLeft : i % 2 === (side === 'front' ? 0 : 1);
          const k = perEdge[onLeft ? 'left' : 'right']++;
          const ix = onLeft ? box.x + 6 + k * 13 : box.x + box.w - 16 - k * 13;
          const color = out ? gridColor(out.pdu) : null;
          const isPending = pending && pending.device === d.id && pending.inlet === inl.name;
          g +=
            `<rect class="pw-inlet${cord ? ' is-used' : ''}" data-inlet="${esc(key)}" x="${r1(ix)}" y="${r1(cy - 4)}" width="10" height="8" rx="1.5" fill="${color || T.portHole}" ` +
            `stroke="${isPending ? T.handle : color ? R.mix(color, T.deep, 0.35) : T.portEdge}" stroke-width="${isPending ? 2 : 0.8}">` +
            `<title>${esc(`${d.name} ${inl.name} · ${M.powerConnectorLabel(inl.connector)}${cord && out ? ` · ${cord.label || 'cord'} to ${out.pdu.name} outlet ${out.name}` : ' · no cord'}`)}</title></rect>`;
          if (!rear || !cord || !out || hidden.has(gridKey(out.pdu))) return;
          // From the inlet's edge into a lane of the channel, along it, and to the outlet.
          const { w, gap } = strip[out.onLeft ? 'left' : 'right'];
          const taken = (perSideCount(strips, out.onLeft) || 0) * (w + gap) + 8;
          const nLanes = Math.max(1, Math.floor((G.CH - taken - 4) / 4.2));
          const lane = lanes[out.onLeft ? 'left' : 'right']++ % nLanes;
          const laneX = out.onLeft ? l.dev - 5 - lane * 4.2 : l.chR + 5 + lane * 4.2;
          const sx = out.onLeft ? ix : ix + 10;
          const path = `M${r1(sx)} ${r1(cy)} H${r1(laneX)} V${r1(out.y)} H${r1(out.x)}`;
          const cordColor = M.normalizeHex(cord.color) || color;
          const bold = selCords.has(cord.id) || selected || selDevs.has(out.pdu.id);
          const line =
            `<path class="pw-cord${bold ? ' is-selected' : ''}" d="${path}" fill="none" stroke="${cordColor}" stroke-width="${bold ? 2.8 : 1.4}" stroke-linejoin="round"${!bold && (selDevs.size || selCords.size) ? ' opacity="0.45"' : ''}/>` +
            `<path class="pw-cord-hit" data-cord="${esc(cord.id)}" d="${path}" fill="none" stroke="transparent" stroke-width="7"><title>${esc(`${cord.label || 'Cord'}: ${d.name} ${inl.name} to ${out.pdu.name} outlet ${out.name}`)}</title></path>`;
          if (bold) cordsTop += line;
          else cords += line;
          nCords++;
          if (selected || selCords.has(cord.id)) tags.push({ onLeft: out.onLeft, y: out.y, text: `${out.pdu.name} · ${out.name}`, edge: out.onLeft ? l.x : l.x + G.RACK_W, off: 14 + perSideCount(strips, out.onLeft) * G.LABEL, color: cordColor });
        });
        if (selected) over += `<rect x="${r1(box.x - 2)}" y="${r1(box.y - 2)}" width="${r1(box.w + 4)}" height="${r1(box.h + 4)}" rx="2.5" fill="none" stroke="${T.select}" stroke-width="2" pointer-events="none"/>`;
        s += g + `</g>`;
      }
      if (lay.sideRow && sideDevs.length) s += text(l.dev + 2, l.bottom + 9, 'SIDE SLOTS', F.unit, T.railText);
      s += `</g>` + label;

      // The rack's name on tape, and what it holds.
      const rackCords = P.cordsWithin(project, new Set([rackId]), ctx).length;
      const name = l.rack.name;
      const tw = Math.max(52, (measure ? measure(name, F.label.css) : name.length * 6.8) + 14);
      s += `<rect x="${l.x}" y="${l.top - 30}" width="${r1(tw)}" height="18" rx="2" fill="${T.tape}"/>` + text(l.x + tw / 2, l.top - 17, name, F.label, T.tapeInk, ' text-anchor="middle"');
      s += text(l.x + tw + 10, l.top - 17, `${M.plural(rackCords, 'cord')} · ${M.plural(pdus.length, 'PDU')}${pdus.length ? '' : ` · ${M.plural(slots.length, 'free PDU slot')}`}`, F.stat, T.ink2);
    }

    // The far ends of the selection's cords, named beside their outlets.
    tags.sort((a, b) => a.y - b.y);
    const last = new Map();
    for (const t of tags) {
      const w = (measure ? measure(t.text, F.tag.css) : t.text.length * 6.2) + 12;
      const key = `${t.edge}|${t.onLeft}`;
      const y = Math.max(t.y - 9, (last.get(key) || -Infinity) + 20);
      last.set(key, y);
      const x = t.onLeft ? t.edge - w - t.off : t.edge + t.off;
      over += `<g pointer-events="none"><rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="18" rx="3" fill="${T.select}"/>${text(x + 6, y + 12.5, t.text, F.tag, T.paper)}</g>`;
    }

    // Under the racks: which side this is, and the grids of the row.
    const fy = lay.height - G.MARGIN - 14;
    let fx = lay.left;
    const caption = `${lay.pos.floor.name} · ${lay.pos.row.name} · power, ${rear ? 'from the rear: the first rack is on the right' : 'from the front: the cords run at the rear'}`;
    let foot = text(fx, fy - 16, caption, F.caption, T.ink2);
    const used = new Map();
    for (const l of lay.racks) for (const d of project.devices) if (d.loc.rack === l.rack.id && d.loc.kind === 'pdu') used.set(gridKey(d), (used.get(gridKey(d)) || 0) + 1);
    for (const [id, n] of used) {
      const g = ctx.grids.get(id);
      const nameText = `${g ? g.name : 'No grid'} · ${M.plural(n, 'PDU')}${hidden.has(id) ? ' (cords hidden)' : ''}`;
      foot += `<rect x="${r1(fx)}" y="${fy - 8}" width="10" height="10" rx="2" fill="${g ? g.color : P.NO_GRID_COLOR}"/>` + text(fx + 15, fy + 1, nameText, F.caption, T.ink);
      fx += 15 + (measure ? measure(nameText, F.caption.css) : nameText.length * 6.2) + 22;
    }
    if (!used.size) foot += text(fx, fy + 1, 'No PDUs in this row yet.', F.caption, T.ink3);
    return { width: lay.width, height: lay.height, body: s + cords + cordsTop + over + foot, cords: nCords, rowId: lay.pos.row.id, side };
  }

  /** How many PDU slots of a rack are drawn on the left (or the right) of the drawing. */
  function perSideCount(strips, onLeft) {
    let n = 0;
    for (const st of strips.values()) if (st.onLeft === onLeft) n++;
    return n;
  }

  /** A standalone SVG file of the Power elevation (`opts` as for elevation), in the light theme. */
  function exportSVG(project, opts) {
    const measure = opts && opts.measure;
    const out = elevation(
      project,
      Object.assign({}, opts, { theme: 'light', selected: null, pending: null, match: null, measure: measure ? (tx, css) => measure(tx, R.withoutWebFonts(css)) : undefined })
    );
    const pos = M.locateRow(project, out.rowId);
    const body = out.body.replace(/font-family="([^"]*)"/g, (m, stack) => `font-family="${R.withoutWebFonts(stack)}"`);
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${out.width}" height="${out.height}" viewBox="0 0 ${out.width} ${out.height}">` +
      `<title>${esc(`${project.name} · ${pos.floor.name} · ${pos.row.name} · power ${out.side}`)}</title>${body}</svg>`
    );
  }

  return { geometry: G, layout, elevation, exportSVG, flip };
});
