/*
 * Rackplanner: SVG drawings of the cabling views.
 *
 * The elevation (one row from the front or the rear, with every device's
 * ports on that side and the cables run through the cable managers and the
 * tray above the racks), the port map (large faceplates with what each port
 * connects to) and the fabric (one network as a graph of core switches,
 * leaves and nodes). Like js/render.js these are pure functions returning
 * SVG markup with concrete colors, so the same output works on screen and
 * in exported files.
 *
 * Interactive elements carry data attributes for event delegation:
 * data-dev="<device id>" on device groups, data-port="<device id>|<port>"
 * on ports (with a hit area of at least 10 × 10 px), data-cable="<cable
 * id>" on cables (a visible path and a wide transparent one to hit),
 * data-row="<row id>" (or data-floor) on exits to other rows and floors,
 * and data-leaf / data-core / data-group in the fabric.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'), require('./cabling.js'), require('./render.js'));
  else (root.RP = root.RP || {}).cablingRender = factory(root.RP.model, root.RP.cabling, root.RP.render);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M, C, R) {
  'use strict';

  const F = R.FONTS;
  const esc = R.esc;
  const r1 = R.r1;
  const text = R.text;

  // ------------------------------------------------------------- geometry
  // One unit is drawn 22 px tall and the 19" bay 300 px wide, so ports have
  // room; cable managers run down both sides of the bay.

  const U = 22;
  const BAY = 300;
  const RAIL = 12;
  const MGR = 46;
  const FRAME = 8;
  const GAP = 26;
  const MX = 34;
  const RW = 2 * (FRAME + MGR + RAIL) + BAY;
  const SLOT_LEN = 12 * U; // a side-mounted device along 12 units
  const TITLE_Y = 36;
  const TRAY_Y = 66;
  const HEAD = 74; // above each rack: its name tape and the far ends of selected cables
  const EXIT_W = 156; // the narrowest exit column; it grows to EXIT_MAX for the far ends' names
  const EXIT_MAX = 300;
  const LEGEND_H = 74;
  const LEGEND_LINE = 22;
  const HIT = 10; // smallest hit area of a port
  // An end on the other side of the rack: a dashed stub from the rail over
  // the device's ear, and a tag that ends before the name (LABEL_X) begins.
  const STUB_OUT = 6;
  const STUB_IN = R.geometry.LABEL_X - 5;
  const TAG_IN = R.geometry.LABEL_X - 3;

  const theme = (o) => (o && o.theme === 'dark' ? 'dark' : 'light');
  const plural = M.plural;
  const shortRack = (name) => String(name).replace(/^Rack\s+/i, '');

  function sheetDefs(T, t) {
    return (
      `<defs><pattern id="cr-grid-${t}" width="11" height="11" patternUnits="userSpaceOnUse"><path d="M11 0H0V11" fill="none" stroke="${T.grid}" stroke-width="0.6"/></pattern>` +
      `<pattern id="cr-grid5-${t}" width="55" height="55" patternUnits="userSpaceOnUse"><path d="M55 0H0V55" fill="none" stroke="${T.gridMajor}" stroke-width="0.8"/></pattern>` +
      `<marker id="cr-arrow-${t}" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" fill="${T.ink2}"/></marker>` +
      R.perfPattern(t) +
      `</defs>`
    );
  }
  function paper(w, h, T, t) {
    return (
      `<rect class="sheet" width="${w}" height="${h}" fill="${T.paper}"/>` +
      `<rect width="${w}" height="${h}" fill="url(#cr-grid-${t})" pointer-events="none"/><rect width="${w}" height="${h}" fill="url(#cr-grid5-${t})" pointer-events="none"/>` +
      `<rect x="10.5" y="10.5" width="${w - 21}" height="${h - 21}" fill="none" stroke="${T.border}" pointer-events="none"/>`
    );
  }

  /** A small dark label with light text, as far ends are named. */
  function pill(x, y, label, T, measure) {
    const w = measure(label, F.label.css) + 10;
    return { w, svg: `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="16" rx="3" fill="${T.select}"/>` + text(x + 5, y + 11.5, label, F.label, T.paper) };
  }

  /**
   * "device · port" fitted to `max` px: the device's name is shortened
   * before the port, which is what tells far ends apart.
   */
  function farLabel(name, port, max, measure) {
    const full = `${name} · ${port}`;
    if (measure(full, F.label.css) <= max) return full;
    const rest = ` · ${port}`;
    const room = max - measure(rest, F.label.css);
    return room >= 40 ? R.fitText(name, F.label, room, measure) + rest : R.fitText(full, F.label, max, measure);
  }

  /**
   * Hit rectangles of the ports of one face: HIT × HIT around each port
   * where there is room, but never past half the gap to a neighbouring
   * port, so a click on a drawn port always lands on that port.
   */
  function hitRects(ports) {
    const box = (q) => ({ x1: q.x, y1: q.y, x2: q.x + q.w, y2: q.y + q.h });
    const shapes = ports.map(box);
    return ports.map((p, i) => {
      const a = shapes[i];
      const cx = p.x + p.w / 2;
      const cy = p.y + p.h / 2;
      let x1 = Math.min(a.x1 - 1, cx - HIT / 2);
      let x2 = Math.max(a.x2 + 1, cx + HIT / 2);
      let y1 = Math.min(a.y1 - 1, cy - HIT / 2);
      let y2 = Math.max(a.y2 + 1, cy + HIT / 2);
      // Stop at the middle of the gap: beside a neighbour in the same row or
      // column, and on the far axis for one diagonally next to it.
      const clampX = (b) => (b.x1 >= a.x2 ? (x2 = Math.min(x2, (a.x2 + b.x1) / 2)) : (x1 = Math.max(x1, (b.x2 + a.x1) / 2)));
      const clampY = (b) => (b.y1 >= a.y2 ? (y2 = Math.min(y2, (a.y2 + b.y1) / 2)) : (y1 = Math.max(y1, (b.y2 + a.y1) / 2)));
      shapes.forEach((b, j) => {
        if (j === i) return;
        const rows = b.y1 < a.y2 && a.y1 < b.y2;
        const cols = b.x1 < a.x2 && a.x1 < b.x2;
        if (rows && !cols) clampX(b);
        else if (cols && !rows) clampY(b);
      });
      shapes.forEach((b, j) => {
        if (j === i || !(b.x1 < x2 && x1 < b.x2 && b.y1 < y2 && y1 < b.y2)) return;
        const gx = Math.max(b.x1 - a.x2, a.x1 - b.x2);
        const gy = Math.max(b.y1 - a.y2, a.y1 - b.y2);
        if (gx >= gy) clampX(b);
        else clampY(b);
      });
      return `<rect x="${r1(x1)}" y="${r1(y1)}" width="${r1(x2 - x1)}" height="${r1(y2 - y1)}" fill="#000" fill-opacity="0"/>`;
    });
  }

  // ------------------------------------------------------------- networks

  /**
   * Per network id ('' for cables without one): color, name and whether it
   * is copper (most of its cables start at an RJ45 port), which decides the
   * cable manager its cables run down.
   */
  function networkInfo(project, ctx, T) {
    const tally = new Map();
    for (const c of project.cables) {
      const k = c.network && ctx.networks.has(c.network) ? c.network : '';
      const t = tally.get(k) || { rj45: 0, all: 0 };
      const p = C.portOf(project, c.a, ctx);
      if (p && M.connectorById(p.connector).family === 'rj45') t.rj45++;
      t.all++;
      tally.set(k, t);
    }
    const info = new Map();
    const order = project.networks.map((n) => n.id).concat(['']);
    order.forEach((id, i) => {
      const n = id ? ctx.networks.get(id) : null;
      const t = tally.get(id) || { rj45: 0, all: 0 };
      info.set(id, { id, order: i, name: n ? n.name : 'No network', color: n ? n.color : T.unassigned, copper: t.all > 0 && t.rj45 * 2 > t.all });
    });
    return info;
  }
  const netKey = (ctx, c) => (c.network && ctx.networks.has(c.network) ? c.network : '');

  /** Ids of the cables a selection picks: { kind: 'device', id|deviceId } | { kind: 'port', deviceId, port } | { kind: 'cable', id } | { kind: 'cables', ids }. */
  function selectedCables(project, sel, idx) {
    const out = new Set();
    if (!sel) return out;
    if (sel.kind === 'device') {
      const id = sel.deviceId || sel.id;
      for (const c of project.cables) if (M.cableEnds(c).some((x) => x.end.device === id)) out.add(c.id);
    } else if (sel.kind === 'port') {
      const hit = idx.get(`${sel.deviceId}|${sel.port}`);
      if (hit) out.add(hit.cable.id);
    } else if (sel.kind === 'cable') {
      if (sel.id) out.add(sel.id);
    } else if (sel.kind === 'cables') {
      for (const id of sel.ids || []) out.add(id);
    }
    return out;
  }

  // ------------------------------------------------------------ elevation

  /**
   * One row seen from the front or the rear, with ports and cable runs.
   * Options: rowId (default: the first row), side: 'front' | 'rear'
   * (default rear), theme, measure(text, cssFont) → px, interactive (hit
   * areas), selected (see selectedCables), focusNetwork (a network id; ''
   * for the cables without one), pending: { device, port } (the first end
   * of a connection being made), highlight: Set of cable ids.
   * Returns { width, height, body, side, rowId, layout } where layout holds
   * where things are drawn: devices (id → rect), ports ("dev|port" →
   * center), cables (id → bounding box) and exits.
   */
  function elevation(project, opts) {
    const o = opts || {};
    const t = theme(o);
    const T = R.THEMES[t];
    const measure = o.measure || R.approxMeasure;
    const side = o.side === 'front' ? 'front' : 'rear';
    const pos = M.locateRow(project, o.rowId) || M.allRows(project)[0];
    const row = pos.row;
    const ctx = C.context(project);
    const idx = C.cableIndex(project);
    const nets = networkInfo(project, ctx, T);
    const racks = side === 'rear' ? row.racks.slice().reverse() : row.racks.slice();
    const flip = (s) => (s === 'front' ? 'rear' : 'front');

    // Cables with an end in this row, and the networks they carry.
    const rowRacks = new Set(row.racks.map((r) => r.id));
    const inRow = (end) => {
      const d = end && ctx.devices.get(end.device);
      return !!d && rowRacks.has(d.loc.rack);
    };
    const faceOf = (end) => C.portFace(project, end, ctx);
    const cables = project.cables.filter((c) => M.cableEnds(c).some((x) => inRow(x.end) && faceOf(x.end) === side));
    const trayNets = [...new Set(cables.map((c) => netKey(ctx, c)))].sort((a, b) => nets.get(a).order - nets.get(b).order);
    const trayH = Math.max(40, 18 + Math.max(0, trayNets.length - 1) * 6);
    const trayLane = (net) => TRAY_Y + 9 + Math.max(0, trayNets.indexOf(net)) * 6;

    // Racks side by side, bottoms aligned.
    const units = racks.map((r) => M.rackUnits(project, r));
    const maxU = Math.max(1, ...units);
    const top0 = TRAY_Y + trayH + HEAD + FRAME;
    const uBottom = top0 + maxU * U;
    const trayX = MX - 8;
    const trayEnd = MX + racks.length * RW + Math.max(0, racks.length - 1) * GAP + 8;
    // Lanes in the managers: copper on the left as seen, the rest on the right, nearest the bay first.
    const leftNets = [...nets.values()].filter((n) => n.copper).map((n) => n.id);
    const rightNets = [...nets.values()].filter((n) => !n.copper).map((n) => n.id);
    const laneStep = (n) => (n > 1 ? Math.min(7, 13 / (n - 1)) : 0);
    const lay = racks.map((rack, i) => {
      const x = MX + i * (RW + GAP);
      const uTop = uBottom - units[i] * U;
      const L = {
        rack,
        i,
        x,
        units: units[i],
        uTop,
        lmX: x + FRAME,
        bayX: x + FRAME + MGR + RAIL,
        rmX: x + FRAME + MGR + RAIL * 2 + BAY,
        slots: M.rackSideSlots(project, rack),
        band: [[], []],
        leaders: [],
      };
      L.laneX = (net) => {
        const left = nets.get(net).copper;
        const list = left ? leftNets : rightNets;
        const k = Math.max(0, list.indexOf(net));
        return left ? L.bayX - RAIL - 5 - k * laneStep(list.length) : L.rmX + 5 + k * laneStep(list.length);
      };
      // Side slots sit in the right manager seen from the front, the left one
      // from the rear. A side device's cables of a network whose lane is in
      // the other manager run down a lane outside the slot instead, and over
      // the tray to the other manager, rather than across the bay.
      const slotLeft = side === 'rear';
      L.sideLaneX = (net) => {
        if (nets.get(net).copper === slotLeft) return L.laneX(net);
        const list = slotLeft ? rightNets : leftNets;
        const k = Math.max(0, list.indexOf(net));
        const step = list.length > 1 ? Math.min(1.5, 3 / (list.length - 1)) : 0;
        return slotLeft ? L.lmX + 1.5 + k * step : L.rmX + MGR - 1.5 - k * step;
      };
      return L;
    });
    const byRack = new Map(lay.map((l) => [l.rack.id, l]));

    // The paper goes under all this once the size of the sheet is known.
    let s = '';
    const title = `${row.name} · ${side}`;
    s += text(MX, TITLE_Y, title, F.title, T.ink);
    const hint = `${pos.floor.name} · seen from the ${side}${side === 'rear' ? ', so the racks run right to left' : ''}`;
    s += text(MX + measure(title, F.title.css) + 12, TITLE_Y, hint, F.legend, T.ink3);

    // Cable tray above the row.
    s += `<rect x="${trayX}" y="${TRAY_Y}" width="${r1(trayEnd - trayX)}" height="${trayH}" rx="3" fill="${T.slotB}" stroke="${T.slotDash}" stroke-dasharray="4 3"/>`;
    let rungs = '';
    for (let x = trayX + 14; x < trayEnd - 4; x += 28) rungs += `M${x} ${TRAY_Y + 1}v${trayH - 2}`;
    s += `<path d="${rungs}" stroke="${T.slotLine}" stroke-width="1.5"/>`;
    s += text(trayX + 4, TRAY_Y - 6, 'CABLE TRAY', F.cap, T.ink3, ' letter-spacing="1.2"');

    // Racks, then devices; remember where every visible port is.
    const anchors = new Map();
    const devRects = new Map();
    const devices = [];
    const devById = new Map();
    const perRack = new Map();
    for (const c of project.cables) {
      const seen = new Set();
      for (const x of M.cableEnds(c)) {
        const d = ctx.devices.get(x.end.device);
        if (d && byRack.has(d.loc.rack) && !seen.has(d.loc.rack)) {
          seen.add(d.loc.rack);
          perRack.set(d.loc.rack, (perRack.get(d.loc.rack) || 0) + 1);
        }
      }
    }
    for (const l of lay) {
      const h = l.units * U;
      s += `<g class="rack" data-rack="${esc(l.rack.id)}">`;
      s += `<rect x="${l.x}" y="${l.uTop - FRAME}" width="${RW}" height="${h + 2 * FRAME}" rx="3" fill="${T.frame}"/>`;
      s += `<rect x="${l.x + 3}" y="${l.uTop - FRAME + 3}" width="${RW - 6}" height="2" rx="1" fill="${T.frameHi}"/>`;
      let fingers = '';
      for (const mx of [l.lmX, l.rmX]) {
        s += `<rect x="${mx}" y="${l.uTop}" width="${MGR}" height="${h}" fill="${T.channel}"/>`;
        for (let u = 0; u <= l.units; u += 2) fingers += `M${mx + 4} ${l.uTop + u * U}h${MGR - 8}`;
      }
      s += `<path d="${fingers}" stroke="${T.finger}" stroke-width="3" stroke-linecap="round"/>`;
      let slotsA = '';
      let slotsB = '';
      let nums = '';
      for (let u = 0; u < l.units; u++) {
        const y = l.uTop + u * U;
        if (u % 2) slotsB += `M${l.bayX} ${y}h${BAY}v${U}h${-BAY}z`;
        else slotsA += `M${l.bayX} ${y}h${BAY}v${U}h${-BAY}z`;
        for (const rx of [l.bayX - RAIL / 2, l.bayX + BAY + RAIL / 2]) nums += text(rx, y + U / 2 + 2.7, String(u + 1), F.unit, T.railText, ' text-anchor="middle"');
      }
      s += `<rect x="${l.bayX - RAIL}" y="${l.uTop}" width="${RAIL}" height="${h}" fill="${T.rail}"/><rect x="${l.bayX + BAY}" y="${l.uTop}" width="${RAIL}" height="${h}" fill="${T.rail}"/>`;
      s += `<path d="${slotsA}" fill="${T.slotA}"/><path d="${slotsB}" fill="${T.slotB}"/>` + nums;
      // Name tape and cable count above the rack.
      const hy = l.uTop - FRAME - HEAD + 6;
      const name = R.fitText(l.rack.name, F.tape, BAY - 90, measure);
      const tw = measure(name, F.tape.css) + 16;
      s += `<rect x="${l.bayX + 1}" y="${hy + 1}" width="${r1(tw)}" height="20" rx="1.5" fill="${T.tapeShade}"/><rect x="${l.bayX}" y="${hy}" width="${r1(tw)}" height="20" rx="1.5" fill="${T.tape}"/>`;
      s += text(l.bayX + 8, hy + 14, name, F.tape, T.tapeInk);
      s += text(l.bayX + tw + 10, hy + 14, plural(perRack.get(l.rack.id) || 0, 'cable'), F.stat, T.ink2);
      s += `</g>`;

      const devs = M.sortedDevices(project, l.rack.id);
      for (const d of devs) {
        const type = M.typeOf(project, d.type);
        if (!type) continue;
        const cluster = M.clusterById(project, d.cluster);
        const sc = R.schemeFor(cluster ? cluster.color : null, t);
        const hU = M.deviceHeight(project, d);
        const own = d.reversed ? flip(side) : side;
        const onSide = d.loc.kind === 'side';
        const len = onSide ? SLOT_LEN : BAY;
        const ports = type.variable ? [] : R.portLayout(type, own, hU, len, { u: U });
        const extra = { u: U, width: len, color: cluster ? cluster.color : null, powerW: type.variable ? M.powerOf(project, d) : 0 };
        let face;
        if (ports.length) face = R.sideFace(type, d.name, sc, t, measure, hU, own, Object.assign({ ports: false, layout: ports }, extra));
        else if (own === 'front') face = R.deviceFace(type, d.name, sc, t, measure, hU, extra);
        else face = R.sideFace(type, d.name, sc, t, measure, hU, 'rear', extra);
        let rect;
        let tf;
        let toAbs;
        if (onSide) {
          // Rotated in the side slot: local x runs bottom to top, local y left to right.
          const gap = (l.units * U - l.slots * SLOT_LEN) / (l.slots + 1);
          const y0 = l.uTop + gap + d.loc.at * (SLOT_LEN + gap);
          const x0 = side === 'rear' ? l.lmX + 4 : l.rmX + MGR - 4 - U;
          rect = { x: x0, y: y0, w: U, h: SLOT_LEN };
          tf = `translate(${r1(x0)} ${r1(y0 + SLOT_LEN)}) rotate(-90)`;
          toAbs = (p) => ({ x: x0 + p.y, y: y0 + SLOT_LEN - p.x - p.w, w: p.h, h: p.w });
        } else {
          const y0 = l.uTop + (d.loc.at - 1) * U;
          rect = { x: l.bayX, y: y0, w: BAY, h: hU * U };
          tf = `translate(${l.bayX} ${y0})`;
          toAbs = (p) => ({ x: l.bayX + p.x, y: y0 + p.y, w: p.w, h: p.h });
        }
        devRects.set(d.id, rect);
        // Ports in two rows (a switch, or many ports); a device in the bay
        // with them runs its cables along its edges.
        const rows2 = R.isSwitchType(type) || ports.length > 12;
        const dense = !onSide && rows2;
        const dev = { d, type, rect, tf, toAbs, ports, onSide, rack: l, rows2, dense, top: rect.y, bottom: rect.y + rect.h };
        devices.push(dev);
        devById.set(d.id, dev);
        s += `<g class="dev" data-dev="${esc(d.id)}" transform="${tf}"${ports.length ? '' : ' opacity="0.55"'}>${face}</g>`;
        for (const p of ports) {
          const a = toAbs(p);
          anchors.set(`${d.id}|${p.name}`, { dev, pt: p, abs: a, cx: a.x + a.w / 2, cy: a.y + a.h / 2 });
        }
      }
    }

    // Cable ends: a visible port, the edge of a device whose port faces the
    // other side, or a place outside the row.
    const endInfo = (c, end) => {
      const d = ctx.devices.get(end.device);
      if (!d) return null;
      const dev = devById.get(d.id);
      if (dev) {
        const A = anchors.get(`${d.id}|${end.port}`);
        if (A) return { kind: 'port', A, dev, end };
        return { kind: 'hidden', dev, end, face: faceOf(end) || flip(side) };
      }
      const rp = ctx.racks.get(d.loc.rack);
      if (!rp) return null;
      const same = rp.floor === pos.floor;
      return { kind: 'out', end, exit: same ? `row:${rp.row.id}` : `floor:${rp.floor.id}`, row: rp.row, floor: rp.floor, same };
    };

    // Server ports lift their cable a little before turning into the
    // manager, outer ports least, so the runs do not cross.
    const lifts = new Map();
    {
      const groups = new Map();
      for (const c of cables) {
        const lr = nets.get(netKey(ctx, c)).copper ? 'L' : 'R';
        for (const x of M.cableEnds(c)) {
          const A = anchors.get(`${x.end.device}|${x.end.port}`);
          if (!A || A.dev.dense || A.dev.onSide) continue;
          const k = `${A.dev.d.id}|${lr}`;
          if (!groups.has(k)) groups.set(k, { lr, list: [] });
          groups.get(k).list.push(A);
        }
      }
      // The highest run stays 2 px inside the device's top edge: on a 1U
      // device the runs bunch up rather than cross the device above.
      for (const g of groups.values()) {
        g.list.sort((m, n) => (g.lr === 'L' ? m.cx - n.cx : n.cx - m.cx));
        const room = Math.min(...g.list.map((A) => A.abs.y)) - g.list[0].dev.top - 2;
        const step = g.list.length > 1 ? Math.max(0, Math.min(4, (room - 3) / (g.list.length - 1))) : 0;
        g.list.forEach((A, k) => lifts.set(A, Math.min(3, room) + k * step));
      }
    }

    /** The lane of a device's cables of network `net`. */
    const laneOf = (dev, net) => (dev.onSide ? dev.rack.sideLaneX(net) : dev.rack.laneX(net));
    /**
     * Where the cable of an end on the other side of the rack meets the
     * device: at its edge facing the lane, along the first unit (a side
     * device: along its top end), on the ear, clear of the name.
     */
    const stubAt = (dev, net) => {
      const r = dev.rect;
      const left = laneOf(dev, net) < r.x + r.w / 2;
      return { left, x: left ? r.x : r.x + r.w, y: dev.onSide ? r.y + 6 : r.y + Math.min(r.h / 2, U / 2) };
    };

    /** From an end into its lane: { start (path from the end), finish (path back to the end), y (height in the lane), lx, stub }. */
    const leg = (E, net) => {
      const lx = laneOf(E.dev, net);
      if (E.kind === 'hidden') {
        // The cable runs dashed from the rail over the ear, and its tag sits
        // above that, ending before the device's name begins: on a device in
        // the bay across its top edge, between the rail's unit numbers.
        const at = stubAt(E.dev, net);
        const out = at.x + (at.left ? -STUB_OUT : STUB_OUT);
        const inner = at.x + (at.left ? STUB_IN : -STUB_IN);
        const tagY = E.dev.onSide ? at.y - 13 : E.dev.top - 5.5;
        return { start: `M${r1(out)} ${r1(at.y)}H${r1(lx)}`, finish: `H${r1(out)}`, y: at.y, lx, stub: { x1: out, x2: inner, edge: at.x, y: at.y, tagY, face: E.face, left: at.left } };
      }
      const A = E.A;
      if (A.dev.onSide) return { start: `M${r1(A.cx)} ${r1(A.cy)}H${r1(lx)}`, finish: `H${r1(A.cx)}`, y: A.cy, lx };
      // Dense ports run along the edges of the unit that holds them (on a
      // device of several units, its lowest), not across the units above.
      const unitTop = A.dev.top + Math.floor((A.abs.y - A.dev.top) / U) * U;
      const y = A.dev.dense ? (A.pt.exit === 'up' ? unitTop + 1.6 : A.dev.bottom - 1.6) : A.abs.y - (lifts.get(A) || 3);
      return { start: `M${r1(A.cx)} ${r1(A.cy)}V${r1(y)}H${r1(lx)}`, finish: `H${r1(A.cx)}V${r1(A.cy)}`, y, lx };
    };

    const exits = new Map();
    const paths = [];
    let farW = 0;
    for (const c of cables) {
      const net = netKey(ctx, c);
      const head = endInfo(c, c.a);
      const legs = M.legsOf(c).map((e) => (e ? endInfo(c, e) : null));
      const ds = [];
      const stubs = [];
      const ends = [head].concat(legs).filter(Boolean);
      const exitKeys = new Set();
      for (const B of legs) {
        if (!B || !head) continue;
        const pair = [head, B];
        const here = pair.filter((E) => E.kind !== 'out');
        if (!here.length) continue;
        let d;
        if (here.length === 2) {
          const a = leg(pair[0], net);
          const b = leg(pair[1], net);
          // In one rack down a shared lane; else (other racks, or a side
          // device's lane in the other manager) over the tray.
          if (pair[0].dev.rack === pair[1].dev.rack && Math.abs(a.lx - b.lx) < 0.05) d = `${a.start}V${r1(b.y)}${b.finish}`;
          else d = `${a.start}V${r1(trayLane(net))}H${r1(b.lx)}V${r1(b.y)}${b.finish}`;
          for (const x of [a, b]) if (x.stub) stubs.push(x.stub);
        } else {
          const E = here[0];
          const F2 = pair.find((x) => x.kind === 'out');
          const a = leg(E, net);
          if (a.stub) stubs.push(a.stub);
          d = `${a.start}V${r1(trayLane(net))}H${r1(trayEnd)}`;
          exitKeys.add(F2.exit);
          // Exits are as wide as their longest far-end label, selected or not.
          farW = Math.max(farW, measure(`${ctx.devices.get(F2.end.device).name} · ${F2.end.port}`, F.label.css));
          if (!exits.has(F2.exit)) {
            const label = F2.same ? `To ${F2.row.name}` : `To ${F2.floor.name}`;
            exits.set(F2.exit, { key: F2.exit, label, row: F2.row, floor: F2.floor, same: F2.same, nets: new Map(), far: [] });
          }
        }
        if (!ds.includes(d)) ds.push(d);
      }
      for (const k of exitKeys) {
        const e = exits.get(k);
        e.nets.set(net, (e.nets.get(net) || 0) + 1);
      }
      if (ds.length) paths.push({ c, net, d: ds.join(''), stubs, ends, exitKeys });
    }

    // Emphasis: selection, network focus, search matches.
    const hot = selectedCables(project, o.selected, idx);
    const lit = o.highlight instanceof Set ? o.highlight : new Set(o.highlight || []);
    const focus = o.focusNetwork === undefined || o.focusNetwork === null ? null : o.focusNetwork;
    const anyHot = paths.some((q) => hot.has(q.c.id));
    const anyLit = paths.some((q) => lit.has(q.c.id));
    /** The transparent wide path a cable is hit by. */
    const hitPath = (q) => `<path d="${q.d}" fill="none" stroke="#000" stroke-opacity="0" stroke-width="9" stroke-linejoin="round"/>`;
    /**
     * A cable's drawing; selected (`strong`) ones are drawn bold over the
     * other cables, take no clicks themselves (their hit paths come first)
     * and leave the ports above them in sight.
     */
    const cableSvg = (q, strong) => {
      const n = nets.get(q.net);
      const isHot = hot.has(q.c.id);
      const isLit = lit.has(q.c.id);
      let op = 1;
      if (focus !== null && q.net !== focus && !isHot) op = 0.12;
      else if ((anyHot && !isHot) || (!anyHot && anyLit && !isLit)) op = 0.35;
      const w = strong ? 2.8 : isLit ? 2.2 : 1.5;
      let g = `<g class="cable${isHot ? ' is-selected' : ''}" data-cable="${esc(q.c.id)}"${op < 1 ? ` opacity="${op}"` : ''}${strong ? ' pointer-events="none"' : ''}>`;
      if (strong || isLit) g += `<path d="${q.d}" fill="none" stroke="${T.paper}" stroke-width="${strong ? 6 : 4.5}" stroke-linejoin="round" opacity="0.9"/>`;
      g += `<path d="${q.d}" fill="none" stroke="${n.color}" stroke-width="${w}" stroke-linejoin="round"/>`;
      for (const st of q.stubs) {
        g += `<path d="M${r1(st.x1)} ${r1(st.y)}H${r1(st.x2)}" stroke="${n.color}" stroke-width="${w}" stroke-dasharray="2.5 2"/>`;
        const tag = st.face;
        const tw = measure(tag, F.tag.css) + 6;
        const tx = st.left ? st.edge + TAG_IN - tw : st.edge - TAG_IN;
        g += `<rect class="side-tag" x="${r1(tx)}" y="${r1(st.tagY)}" width="${r1(tw)}" height="11" rx="2" fill="${T.paper}" stroke="${n.color}" stroke-width="0.8"/>`;
        g += text(tx + 3, st.tagY + 8.5, tag, F.tag, T.ink2);
      }
      if (o.interactive && !strong) g += hitPath(q);
      return g + `</g>`;
    };
    // The selected device's outline goes under the cables and their tags.
    const sel = o.selected || null;
    if (sel && sel.kind === 'device' && devRects.has(sel.deviceId || sel.id)) {
      const r = devRects.get(sel.deviceId || sel.id);
      s += `<rect x="${r1(r.x - 2)}" y="${r1(r.y - 2)}" width="${r1(r.w + 4)}" height="${r1(r.h + 4)}" rx="3" fill="none" stroke="${T.select}" stroke-width="2" pointer-events="none"/>`;
    }
    for (const q of paths) if (!hot.has(q.c.id)) s += cableSvg(q, false);
    if (o.interactive) for (const q of paths) if (hot.has(q.c.id)) s += `<g class="cable-hit" data-cable="${esc(q.c.id)}">${hitPath(q)}</g>`;
    // Selected cables over the others but under the ports, so a switch's
    // runs along its edges hide none of its ports.
    for (const q of paths) if (hot.has(q.c.id)) s += cableSvg(q, true);

    // Ports over the cables, cabled ones in their network's color.
    for (const dev of devices) {
      if (!dev.ports.length) continue;
      const hits = o.interactive ? hitRects(dev.ports) : [];
      let ps = '';
      dev.ports.forEach((p, i) => {
        const hit = idx.get(`${dev.d.id}|${p.name}`);
        const color = hit ? nets.get(netKey(ctx, hit.cable)).color : null;
        ps += `<g class="port" data-port="${esc(`${dev.d.id}|${p.name}`)}">${R.portShape(p, color, t)}${hits[i] || ''}</g>`;
      });
      s += `<g transform="${dev.tf}">${ps}</g>`;
    }

    // The selected cables' ports ringed and their far ends named.
    const ring = (A, color, dash) =>
      `<rect x="${r1(A.abs.x - 3)}" y="${r1(A.abs.y - 3)}" width="${r1(A.abs.w + 6)}" height="${r1(A.abs.h + 6)}" rx="2.5" fill="none" stroke="${color}" stroke-width="2"${dash ? ' stroke-dasharray="3 2"' : ''} pointer-events="none"/>`;
    const labels = [];
    const hotPaths = paths.filter((q) => hot.has(q.c.id));
    const ringed = new Map();
    for (const q of hotPaths) {
      for (const E of q.ends) {
        if (E.kind !== 'port') continue;
        if (!ringed.has(E.A.dev)) ringed.set(E.A.dev, new Set());
        ringed.get(E.A.dev).add(E.A);
      }
      let far = q.ends;
      if (sel && sel.kind === 'device') far = q.ends.filter((E) => E.end.device !== (sel.deviceId || sel.id));
      else if (sel && sel.kind === 'port') far = q.ends.filter((E) => !(E.end.device === sel.deviceId && E.end.port === sel.port));
      else if (hotPaths.length > 24) far = [];
      for (const E of far) labels.push({ E, net: q.net });
    }
    // Ports in two rows sit too close for a ring each: a thin ring hugs each
    // run of ringed ports side by side in a row, clear of the other row.
    for (const [dev, set] of ringed) {
      if (!dev.rows2) {
        for (const A of set) s += ring(A, T.handle);
        continue;
      }
      const runs = [];
      const list = [...set].map((A) => A.pt).sort((a, b) => a.y - b.y || a.x - b.x);
      for (const p of list) {
        const last = runs[runs.length - 1];
        if (last && last.y === p.y && last.h === p.h && p.x - (last.x + last.w) < 5.5) last.w = p.x + p.w - last.x;
        else runs.push({ x: p.x, y: p.y, w: p.w, h: p.h });
      }
      // Half the gap between the rows is each ring's to take.
      let gap = U;
      for (const a of dev.ports) for (const b of dev.ports) if (b.y > a.y + a.h && b.x < a.x + a.w && a.x < b.x + b.w) gap = Math.min(gap, b.y - a.y - a.h);
      const off = Math.max(0.3, Math.min(0.8, gap / 2 - 0.55));
      for (const run of runs) {
        const a = dev.toAbs(run);
        s += `<rect x="${r1(a.x - off)}" y="${r1(a.y - off)}" width="${r1(a.w + 2 * off)}" height="${r1(a.h + 2 * off)}" rx="1.2" fill="none" stroke="${T.handle}" stroke-width="1" pointer-events="none"/>`;
      }
    }
    if (o.pending) {
      const A = anchors.get(`${o.pending.device}|${o.pending.port}`);
      if (A) s += ring(A, T.select, true) + `<rect x="${r1(A.abs.x - 5.5)}" y="${r1(A.abs.y - 5.5)}" width="${r1(A.abs.w + 11)}" height="${r1(A.abs.h + 11)}" rx="4" fill="none" stroke="${T.handle}" stroke-width="1.5" pointer-events="none"/>`;
    }
    if (sel && sel.kind === 'port') {
      const A = anchors.get(`${sel.deviceId}|${sel.port}`);
      if (A && !hot.size) s += ring(A, T.handle);
    }

    // Far-end labels, one per device naming its ports: top-of-rack switches
    // in the band above the rack; others above their ports, else beside or
    // below them in their device; side devices beside the slot, as near the
    // ports as there is room; ends on the other side at their stub; ends
    // elsewhere are listed at the exits. Labels cover no other label and no
    // port, and side devices' labels no device's name where they can; a
    // label moved away from its ports gets a leader to them.
    const placed = [];
    const taken = [];
    const portBoxes = [...anchors.values()].map((A) => ({ x: A.abs.x - 3, y: A.abs.y - 3, w: A.abs.w + 6, h: A.abs.h + 6 }));
    const nameBoxes = devices.filter((v) => !v.onSide).map((v) => ({ x: v.rect.x + R.geometry.LABEL_X, y: v.rect.y + 4, w: measure(v.d.name, F.name.css), h: 14 }));
    const covers = (x, y, w, b) => x < b.x + b.w && b.x < x + w && y < b.y + b.h && b.y < y + 16;
    const free = (x, y, w, avoid) => !taken.some((r) => x < r.x + r.w + 4 && r.x < x + w + 4 && y < r.y + 18 && r.y < y + 18) && !(avoid || []).some((b) => covers(x, y, w, b));
    /** The first of `tries` ([spots ([x, y]), obstacles]) free of labels and its obstacles, or null. */
    const firstFree = (lw, tries) => {
      for (const [spots, avoid] of tries) for (const [x, y] of spots) if (free(x, y, lw, avoid)) return [x, y];
      return null;
    };
    const put = (x, y, label) => {
      const p = pill(x, y, label, T, measure);
      taken.push({ x, y, w: p.w });
      placed.push(p.svg);
    };
    /**
     * Labels of top-of-rack switches go in two rows of the band above the
     * rack. Each row has its own leader bar, and a second-row leader rises
     * between the first row's labels; leaders from ports one above the
     * other step aside. False when both rows are full.
     */
    const band = (g, l, label, lw) => {
      const xs = g.ends.map((x) => x.A.cx);
      const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
      const row0 = l.band[0];
      const blocked = (x) => row0.some((b) => x > b.x1 - 3 && x < b.x2 + 3);
      for (let k = 0; k < 2; k++) {
        const lane = l.band[k];
        const prev = lane.length ? lane[lane.length - 1].x2 : -Infinity;
        let lx = Math.max(mid - lw / 2, prev + 6, l.x + 4);
        if (k === 0 && lx + lw > l.x + RW + GAP / 2 - 4) continue;
        let rise = Math.max(lx + 4, Math.min(mid, lx + lw - 4));
        if (k === 1 && blocked(rise)) {
          // The nearest gap between first-row labels under this one, else the
          // first one to its right, moving the label along to it.
          const gaps = row0.flatMap((b) => [b.x1 - 3.5, b.x2 + 3.5]).filter((x) => !blocked(x));
          const under = gaps.filter((x) => x >= lx + 4 && x <= lx + lw - 4).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
          if (under.length) rise = under[0];
          else {
            rise = Math.min(...gaps.filter((x) => x > lx + lw - 4));
            lx = rise - lw + 4;
          }
        }
        lane.push({ x1: lx, x2: lx + lw });
        const ly = l.uTop - FRAME - 24 - k * 20;
        const bar = l.uTop - FRAME - 2 - k * 3;
        let leaders = '';
        const ups = g.ends.map((x) => {
          let cx = x.A.cx;
          while (l.leaders.some((u) => Math.abs(u - cx) < 1.5)) cx += 2.5;
          l.leaders.push(cx);
          leaders += `M${r1(cx)} ${r1(x.A.cy)}V${r1(bar)}`;
          return cx;
        });
        leaders += `M${r1(Math.min(...ups, rise))} ${r1(bar)}H${r1(Math.max(...ups, rise))}M${r1(rise)} ${r1(bar)}V${r1(ly + 16)}`;
        placed.push(`<path d="${leaders}" fill="none" stroke="${T.select}" stroke-width="1.2"/>`);
        put(lx, ly, label);
        return true;
      }
      return false;
    };
    const farGroups = new Map();
    for (const { E, net } of labels) {
      const key = E.kind === 'out' ? `out|${E.end.device}|${E.end.port}` : `${E.kind}|${E.end.device}`;
      let g = farGroups.get(key);
      if (!g) farGroups.set(key, (g = { E, net, ends: [] }));
      if (!g.ends.some((x) => x.end.port === E.end.port)) g.ends.push(E);
    }
    const list = [...farGroups.values()];
    const cxOf = (g) => (g.E.kind === 'port' ? Math.min(...g.ends.map((x) => x.A.cx)) : g.E.kind === 'hidden' ? g.E.dev.rect.x : Infinity);
    // Labels with one place first (by their ports, left to right, as the
    // band needs them), side devices', which can move along the slot, last.
    const rank = (g) => (g.E.kind === 'out' ? 3 : g.E.dev.onSide ? 2 : g.E.kind === 'hidden' ? 1 : 0);
    list.sort((a, b) => rank(a) - rank(b) || cxOf(a) - cxOf(b));
    for (const g of list) {
      const E = g.E;
      const d = ctx.devices.get(E.end.device);
      if (E.kind === 'out') {
        if (exits.has(E.exit)) exits.get(E.exit).far.push({ name: d.name, port: E.end.port });
        continue;
      }
      const ports = g.ends.map((x) => x.end.port).join(', ');
      const label = R.fitText(`${d.name} · ${ports}${E.kind === 'hidden' ? ` (${E.face})` : ''}`, F.label, 280, measure);
      const lw = measure(label, F.label.css) + 10;
      const l = E.dev.rack;
      if (E.kind === 'port' && E.dev.dense && E.dev.top < l.uTop + 6 * U) {
        if (band(g, l, label, lw)) continue;
      }
      const r = E.dev.rect;
      const onSheet = (x) => x >= trayX && x + lw <= trayEnd;
      let tries;
      let leader;
      if (E.dev.onSide) {
        // Beside the slot towards the bay, at the ports' (or the stub's)
        // height or the nearest free one along the slot; else outside the
        // rack. A leader runs from the slot's edge to a label moved along.
        const ys = E.kind === 'hidden' ? [stubAt(E.dev, g.net).y] : g.ends.map((x) => x.A.cy);
        const y0 = Math.min(...ys) - 8;
        const ladder = [y0];
        for (let k = 6; k <= r.h; k += 6) ladder.push(y0 - k, y0 + k);
        const along = ladder.filter((y) => y >= r.y - 8 && y <= r.y + r.h - 8);
        const toBay = side === 'rear';
        const inX = toBay ? r.x + r.w + 14 : r.x - 14 - lw;
        const outX = toBay ? r.x - 14 - lw : r.x + r.w + 14;
        const inner = along.map((y) => [inX, y]);
        const outer = onSheet(outX) ? along.map((y) => [outX, y]) : [];
        tries = [[inner, portBoxes.concat(nameBoxes)], [inner, portBoxes], [outer, portBoxes]];
        leader = (x, y) => {
          if (ys.every((cy) => Math.abs(cy - (y + 8)) < 5)) return '';
          const right = x > r.x;
          const edge = right ? r.x + r.w : r.x;
          const mx = right ? edge + 7 : edge - 7;
          const top = Math.min(y + 8, ...ys);
          const bottom = Math.max(y + 8, ...ys);
          return ys.map((cy) => `M${r1(edge)} ${r1(cy)}H${r1(mx)}`).join('') + `M${r1(mx)} ${r1(top)}V${r1(bottom)}M${r1(mx)} ${r1(y + 8)}H${r1(right ? x : x + lw)}`;
        };
      } else if (E.kind === 'hidden') {
        // Inside the device, beside the name, at the stub's height or lower.
        const at = stubAt(E.dev, g.net);
        const x = at.left ? r.x + 40 : r.x + r.w - 40 - lw;
        const spots = [];
        for (let y = at.y - 8; y <= Math.max(at.y - 8, r.y + r.h - 16); y += 6) spots.push([x, y]);
        tries = [[spots, portBoxes]];
        leader = () => '';
      } else {
        // Above the ports, higher up their device, beside them or below them.
        const As = g.ends.map((x) => x.A);
        const top = Math.min(...As.map((A) => A.abs.y));
        const bottom = Math.max(...As.map((A) => A.abs.y + A.abs.h));
        const left = Math.min(...As.map((A) => A.abs.x));
        const right = Math.max(...As.map((A) => A.abs.x + A.abs.w));
        const x0 = Math.max(l.bayX + 4, Math.min(cxOf(g) - 6, l.bayX + BAY - lw - 4));
        const spots = [[x0, top - 22]];
        for (let y = top - 40; y >= r.y - 3; y -= 18) spots.push([x0, y]);
        const mid = (top + bottom) / 2 - 8;
        if (right + 6 + lw <= l.bayX + BAY - 4) spots.push([right + 6, mid]);
        if (left - 6 - lw >= l.bayX + 4) spots.push([left - 6 - lw, mid]);
        if (bottom + 22 <= r.y + r.h + 3) spots.push([x0, bottom + 6]);
        tries = [[spots, portBoxes]];
        leader = (x, y) => {
          const cx = cxOf(g);
          if (y + 16 >= r.y - 1 && y <= r.y + r.h + 1) return '';
          const up = y < top;
          const px = Math.max(x + 4, Math.min(cx, x + lw - 4));
          return `M${r1(cx)} ${r1(up ? top : bottom)}V${r1(up ? y + 20 : y - 4)}H${r1(px)}V${r1(up ? y + 16 : y)}`;
        };
      }
      let at = firstFree(lw, tries);
      if (!at) {
        // Nowhere free of ports: the first place, moved up clear of labels.
        const [x, y0] = tries.find((t) => t[0].length)[0][0];
        let y = y0;
        for (let k = 0; k < 8 && !free(x, y, lw); k++) y -= 18;
        at = [x, y];
      }
      const [lx, ly] = [Math.max(trayX, Math.min(at[0], trayEnd - lw)), at[1]];
      const lead = leader(lx, ly);
      if (lead) placed.push(`<path d="${lead}" fill="none" stroke="${T.select}" stroke-width="1.2"/>`);
      put(lx, ly, label);
    }
    s += `<g class="far-ends" pointer-events="none">${placed.join('')}</g>`;

    // Exits to other rows and floors at the end of the tray.
    const exitW = Math.max(EXIT_W, Math.min(EXIT_MAX, Math.ceil(farW) + 22 + 24));
    const width = MX * 2 + racks.length * RW + Math.max(0, racks.length - 1) * GAP + GAP + exitW;
    const exitX = trayEnd + 10;
    let ey = TRAY_Y - 8;
    const exitList = [];
    if (exits.size) s += `<path d="M${r1(trayEnd - 6)} ${TRAY_Y + trayH / 2}H${r1(exitX + 2)}" stroke="${T.ink2}" stroke-width="1.5" marker-end="url(#cr-arrow-${t})"/>`;
    for (const e of exits.values()) {
      const lines = [...e.nets.entries()].sort((a, b) => nets.get(a[0]).order - nets.get(b[0]).order);
      const far = e.far.slice(0, 6);
      const more = e.far.length - far.length;
      const bh = 26 + lines.length * 15 + (far.length ? 6 + far.length * 18 + (more ? 14 : 0) : 0);
      const bx = exitX + 10;
      const bw = exitW - 24;
      const attr = e.same ? `data-row="${esc(e.row.id)}"` : `data-floor="${esc(e.floor.id)}" data-row="${esc(e.row.id)}"`;
      s += `<g class="exit" ${attr}${o.interactive ? ' tabindex="0" role="button"' : ''}>`;
      if (o.interactive) s += `<title>${esc(`${e.label}: ${plural([...e.nets.values()].reduce((a, b) => a + b, 0), 'cable')}`)}</title>`;
      s += `<rect x="${r1(bx)}" y="${r1(ey)}" width="${bw}" height="${bh}" rx="4" fill="${T.paper}" stroke="${T.border}"/>`;
      s += text(bx + 9, ey + 17, R.fitText(e.label, F.head, bw - 18, measure), F.head, T.ink);
      lines.forEach(([net, n], k) => {
        const info = nets.get(net);
        s += `<rect x="${r1(bx + 9)}" y="${r1(ey + 27 + k * 15)}" width="11" height="3.5" rx="1" fill="${info.color}"/>`;
        s += text(bx + 26, ey + 32 + k * 15, R.fitText(`${n} ${info.name}`, F.note, bw - 34, measure), F.note, T.ink2);
      });
      let fy = ey + 26 + lines.length * 15 + 6;
      for (const f of far) {
        const p = pill(bx + 6, fy, farLabel(f.name, f.port, bw - 22, measure), T, measure);
        s += p.svg;
        fy += 18;
      }
      if (more) s += text(bx + 9, fy + 9, `and ${more} more`, F.note, T.ink3);
      s += `</g>`;
      exitList.push({ key: e.key, rowId: e.row.id, floorId: e.floor.id, x: bx, y: ey, w: bw, h: bh });
      ey += bh + 8;
    }

    const exitBottom = ey - 8;

    // Floor line and the networks legend, on as many lines as it takes,
    // left of the exits when they reach down to it.
    s += `<path d="M${trayX} ${uBottom + FRAME + 0.5}H${r1(trayEnd)}" stroke="${T.ink2}" stroke-width="1.5"/>`;
    const ly = uBottom + FRAME + 44;
    const legendEnd = exitBottom > ly - 30 ? exitX : width - MX;
    s += text(MX, ly - 18, 'NETWORKS', F.cap, T.ink3, ' letter-spacing="1.2"');
    let lx = MX;
    let line = 0;
    const counts = new Map();
    for (const q of paths) counts.set(q.net, (counts.get(q.net) || 0) + 1);
    const legendNets = [...counts.keys()].sort((a, b) => nets.get(a).order - nets.get(b).order);
    if (!legendNets.length) s += text(lx, ly + 1, `No cables on the ${side} of this row`, F.legend, T.ink3);
    for (const id of legendNets) {
      const n = nets.get(id);
      const cw = measure(String(counts.get(id)), F.stat.css);
      const label = R.fitText(n.name, F.legend, legendEnd - MX - 22 - 7 - cw, measure);
      const lw = measure(label, F.legend.css);
      if (lx > MX && lx + 22 + lw + 7 + cw > legendEnd) {
        lx = MX;
        line++;
      }
      const y = ly + line * LEGEND_LINE;
      s += `<rect x="${r1(lx)}" y="${y - 5}" width="16" height="4" rx="1" fill="${n.color}"${focus !== null && focus !== id ? ' opacity="0.35"' : ''}/>`;
      s += `<text x="${r1(lx + 22)}" y="${y + 1}" font-family="${F.legend.family}" font-size="${F.legend.size}" font-weight="${F.legend.weight}" fill="${T.ink}">${esc(label)}<tspan dx="7" font-family="${F.stat.family}" font-size="${F.stat.size}" fill="${T.ink3}">${counts.get(id)}</tspan></text>`;
      lx += 22 + lw + 7 + cw + 22;
    }
    const note = 'Copper runs down the left cable managers, fiber and direct cables down the right.';
    if (legendNets.length) s += text(MX, ly + line * LEGEND_LINE + 24, R.fitText(note, F.note, legendEnd - MX, measure), F.note, T.ink3);
    const height = Math.ceil(Math.max(uBottom + FRAME + 12 + LEGEND_H + line * LEGEND_LINE, exitBottom + 24));

    // Where things are, for the UI.
    const portsAt = new Map();
    for (const [k, A] of anchors) portsAt.set(k, { x: r1(A.cx), y: r1(A.cy), w: A.abs.w, h: A.abs.h });
    const boxes = new Map();
    for (const q of paths) {
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      // Paths use absolute M/H/V only: track x and y through them.
      let cx = 0;
      let cy = 0;
      const re = /([MHV])(-?[\d.]+)(?:\s(-?[\d.]+))?/g;
      let m;
      while ((m = re.exec(q.d))) {
        if (m[1] === 'M') (cx = +m[2]), (cy = +m[3]);
        else if (m[1] === 'H') cx = +m[2];
        else cy = +m[2];
        x1 = Math.min(x1, cx);
        x2 = Math.max(x2, cx);
        y1 = Math.min(y1, cy);
        y2 = Math.max(y2, cy);
      }
      boxes.set(q.c.id, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    }
    return { width, height, body: sheetDefs(T, t) + paper(width, height, T, t) + s, side, rowId: row.id, layout: { devices: devRects, ports: portsAt, cables: boxes, exits: exitList } };
  }

  // ------------------------------------------------------------- port map

  /**
   * Labels of the port tiles of one face: the numbers of numbered ports
   * when that leaves every label on the face different (a switch's
   * swp1 … swp52 read 1 … 52), else full names, a number only where the
   * full name does not fit its tile (`fits(label, i)`).
   */
  function tileLabels(type, layout, fits) {
    const short = layout.map((p) => {
      const g = type.ports[p.group];
      const numbered = g && (g.first !== undefined || g.count !== undefined);
      return numbered && p.name.length > g.name.length ? p.name.slice(g.name.length) : p.name;
    });
    if (new Set(short).size === short.length) return short;
    return layout.map((p, i) => (fits(p.name, i) ? p.name : short[i]));
  }

  /** "core-sw-01/02" for names that differ only in their last number, else "a, b". */
  function joinNames(names) {
    if (names.length < 2) return names.join('');
    const parts = names.map((n) => /^(.*?)(\d+)$/.exec(n));
    if (parts.every((m) => m && m[1] === parts[0][1])) return `${names[0]}/${parts.slice(1).map((m) => m[2]).join('/')}`;
    return names.join(', ');
  }

  /** Devices at the other ends of the cable on a port: the legs of a head, the head of a leg. */
  function farDevices(ctx, hit) {
    const out = [];
    for (const x of M.cableEnds(hit.cable)) {
      const d = x.role !== hit.role && ctx.devices.get(x.end.device);
      if (d && !out.includes(d)) out.push(d);
    }
    return out;
  }

  /**
   * Faceplates of devices, drawn large: every port numbered and colored by
   * its cable's network, the device at the other end written above (top
   * row) or below each cabled port, with a dot when it is in another rack.
   * Devices with ports on both sides show both, captioned Front and Rear
   * (the device's own sides). Options: theme, measure, width (default
   * 760; a card is wider when a faceplate needs it), minPitch (px from a
   * port to the next in its row, default 16, which keeps every number:
   * a faceplate drawn smaller widens its card), selected: { deviceId,
   * port } or a list of them (each ringed, its far end in bold), pending:
   * { device, port }, focusNetwork (a network id; '' for
   * the cables without one: ports cabled in others fade), highlight: Set
   * of cable ids (their ports ringed, the other cabled ports fade).
   * Returns [{ deviceId, width, height, body }] (devices without ports
   * get a short note).
   */
  function portMap(project, deviceIds, opts) {
    const o = opts || {};
    const t = theme(o);
    const T = R.THEMES[t];
    const measure = o.measure || R.approxMeasure;
    const minWidth = Math.max(240, o.width || 760);
    const ctx = C.context(project);
    const idx = C.cableIndex(project);
    const nets = networkInfo(project, ctx, T);
    const minPitch = Math.max(1, o.minPitch || 16);
    const focus = o.focusNetwork === undefined || o.focusNetwork === null ? null : o.focusNetwork;
    const lit = o.highlight instanceof Set ? o.highlight : new Set(o.highlight || []);
    const ids = [].concat(deviceIds || []);
    const selected = [].concat(o.selected || []).filter(Boolean);
    // Matches fade the other cabled ports only where some port shown is one.
    const anyLit =
      lit.size > 0 &&
      ids.some((id) => {
        const d = ctx.devices.get(id);
        const type = d && M.typeOf(project, d.type);
        return !!type && M.expandPorts(type).some((p) => {
          const hit = idx.get(`${id}|${p.name}`);
          return hit && lit.has(hit.cable.id);
        });
      });
    const out = [];
    for (const id of ids) {
      const d = ctx.devices.get(id);
      const type = d && M.typeOf(project, d.type);
      if (!type) continue;
      const all = M.expandPorts(type);
      const sides = ['front', 'rear'].filter((sd) => all.some((p) => p.side === sd));
      if (!sides.length) {
        out.push({ deviceId: id, width: minWidth, height: 40, body: text(16, 24, `${d.name} has no ports`, F.legend, T.ink3) });
        continue;
      }
      // A faceplate whose ports would be closer than minPitch at the card's width widens it.
      const width = Math.max(minWidth, ...sides.map((sd) => Math.ceil(plateExtent(type, sd) * plateScale(type, sd, minPitch) + PLATE_PAD)));
      let body = '';
      let y = 0;
      for (const sd of sides) {
        const fp = faceplate(project, ctx, idx, nets, d, type, sd, { T, t, measure, width, caption: sides.length > 1, selected, pending: o.pending, focus, lit, anyLit });
        body += `<g transform="translate(0 ${r1(y)})">${fp.body}</g>`;
        y += fp.height;
      }
      out.push({ deviceId: id, width, height: Math.ceil(y), body });
    }
    return out;
  }

  // A faceplate is drawn from a 1U layout this long, scaled up to 3.1 times
  // to fill the card, never below 1; the card keeps PLATE_PAD beside it.
  const PLATE_LEN = 4000;
  const PLATE_PAD = 120;
  const plateLayout = (type, sd) => R.portLayout(type, sd, 1, PLATE_LEN, { u: U });
  const DOT_GAP = 7;
  const DOT_ROOM = DOT_GAP + 2.2 + 2;
  const LBL_TEXT = 80;
  function plateExtent(type, sd) {
    const layout = plateLayout(type, sd);
    return Math.max(...layout.map((p) => p.x + p.w)) - Math.min(...layout.map((p) => p.x));
  }
  /** The smallest scale (1 to 3.1) at which ports in a row are `pitch` px apart or more. */
  function plateScale(type, sd, pitch) {
    const layout = plateLayout(type, sd);
    let least = Infinity;
    for (const a of layout) {
      for (const b of layout) if (b.x > a.x && b.y < a.y + a.h && a.y < b.y + b.h) least = Math.min(least, b.x - a.x);
    }
    return Number.isFinite(least) ? Math.max(1, Math.min(3.1, pitch / least)) : 1;
  }

  function faceplate(project, ctx, idx, nets, d, type, sd, o) {
    const { T, t, measure, width } = o;
    const layout = plateLayout(type, sd);
    const minX = Math.min(...layout.map((p) => p.x));
    const maxX = Math.max(...layout.map((p) => p.x + p.w));
    const extent = maxX - minX;
    const S = Math.max(1, Math.min(3.1, (width - PLATE_PAD) / extent));
    const hasUp = layout.some((p) => p.exit === 'up');
    // The band of far names: a name, then room for the dot of a far end in another rack.
    const LBL = LBL_TEXT + 10 + DOT_ROOM;
    const capH = o.caption ? 20 : 0;
    const plateY = capH + (hasUp ? LBL + 6 : 14);
    const plateH = U * S;
    const ox = (width - extent * S) / 2 - minX * S;
    let s = '';
    if (o.caption) s += text(16, 14, sd === 'front' ? 'FRONT' : 'REAR', F.cap, T.ink3, ' letter-spacing="1.2"');
    s += `<rect x="${r1(ox + minX * S - 18)}" y="${r1(plateY)}" width="${r1(extent * S + 36)}" height="${r1(plateH)}" rx="4" fill="${R.mix(T.faceBase, T.unassigned, 0.08)}" stroke="${T.ink3}" data-dev="${esc(d.id)}"/>`;
    const sel = new Set(o.selected.filter((x) => x.deviceId === d.id).map((x) => x.port));
    const pend = o.pending && o.pending.device === d.id ? o.pending.port : null;
    const lbl = F.small;
    let ports = '';
    let marks = '';
    const nf = F.port;
    const Ps = layout.map((p) => ({ x: ox + p.x * S, y: plateY + p.y * S, w: p.w * S, h: p.h * S, exit: p.exit, connector: p.connector }));
    const hits = hitRects(Ps);
    const labels = tileLabels(type, layout, (label, i) => measure(label, nf.css) <= Ps[i].w - 2);
    layout.forEach((p, i) => {
      const hit = idx.get(`${d.id}|${p.name}`);
      const net = hit ? netKey(ctx, hit.cable) : null;
      const color = hit ? nets.get(net).color : null;
      const P = Ps[i];
      const shown = R.fitText(labels[i], nf, P.w - 2, measure);
      // Emphasis as in the elevation: other networks than the one in focus fade, as do cables the search does not match.
      const isLit = !!hit && o.lit.has(hit.cable.id);
      let op = 1;
      if (hit && !sel.has(p.name) && o.focus !== null && net !== o.focus) op = 0.2;
      else if (hit && !sel.has(p.name) && o.anyLit && !isLit) op = 0.35;
      const fade = op < 1 ? ` opacity="${op}"` : '';
      ports +=
        `<g class="port" data-port="${esc(`${d.id}|${p.name}`)}"${fade}>` +
        R.portShape(P, color ? R.mix(color, T.faceBase, 0.1) : null, t) +
        text(P.x + P.w / 2, P.y + P.h / 2 + 3, shown, nf, color ? '#ffffff' : T.ink3, ' text-anchor="middle"') +
        hits[i] +
        `</g>`;
      if (sel.has(p.name)) marks += `<rect x="${r1(P.x - 3)}" y="${r1(P.y - 3)}" width="${r1(P.w + 6)}" height="${r1(P.h + 6)}" rx="3" fill="none" stroke="${T.handle}" stroke-width="2.5" pointer-events="none"/>`;
      else if (isLit && o.anyLit) marks += `<rect class="lit-ring" x="${r1(P.x - 2.5)}" y="${r1(P.y - 2.5)}" width="${r1(P.w + 5)}" height="${r1(P.h + 5)}" rx="3" fill="none" stroke="${T.ink}" stroke-width="1.5" pointer-events="none"/>`;
      if (p.name === pend) {
        marks += `<rect x="${r1(P.x - 3)}" y="${r1(P.y - 3)}" width="${r1(P.w + 6)}" height="${r1(P.h + 6)}" rx="3" fill="none" stroke="${T.select}" stroke-width="2" stroke-dasharray="3 2" pointer-events="none"/>`;
        marks += `<rect x="${r1(P.x - 6)}" y="${r1(P.y - 6)}" width="${r1(P.w + 12)}" height="${r1(P.h + 12)}" rx="4" fill="none" stroke="${T.handle}" stroke-width="1.5" pointer-events="none"/>`;
      }
      if (!hit) return;
      const far = farDevices(ctx, hit);
      const other = far.some((x) => x.loc.rack !== d.loc.rack);
      const label = R.fitText(joinNames(far.map((x) => x.name)), lbl, LBL_TEXT, measure);
      const cx = P.x + P.w / 2;
      const up = p.exit === 'up';
      const y1 = up ? P.y - 3 : P.y + P.h + 3;
      const y2 = up ? plateY - 6 - 4 : plateY + plateH + 10;
      let farMarks = `<path d="M${r1(cx)} ${r1(y1)}V${r1(y2)}" stroke="${color}" stroke-width="1.4"/>`;
      const tx = up ? y2 - 3 : y2 + 3;
      const strong = sel.has(p.name) || (isLit && o.anyLit);
      farMarks += `<text transform="translate(${r1(cx + 3.4)} ${r1(tx)}) rotate(-90)" font-family="${lbl.family}" font-size="${lbl.size}" font-weight="${strong ? 700 : lbl.weight}" fill="${strong ? T.ink : T.ink2}"${up ? '' : ' text-anchor="end"'}>${esc(label)}</text>`;
      if (other) {
        const dy = up ? tx - measure(label, lbl.css) - DOT_GAP : tx + measure(label, lbl.css) + DOT_GAP;
        farMarks += `<circle cx="${r1(cx)}" cy="${r1(dy)}" r="2.2" fill="${T.ink3}"/>`;
      }
      marks += fade ? `<g${fade}>${farMarks}</g>` : farMarks;
    });
    s += ports + marks;
    return { body: s, height: plateY + plateH + LBL + 10 };
  }

  // --------------------------------------------------------------- fabric

  /** Selected device ids from a Set, a list, an id or { id | deviceId | ids }. */
  function selectedIds(sel) {
    if (!sel) return new Set();
    if (sel instanceof Set) return sel;
    if (Array.isArray(sel)) return new Set(sel);
    if (typeof sel === 'string') return new Set([sel]);
    return new Set([].concat(sel.ids || [], sel.deviceId || [], sel.id || []));
  }

  /** "cn-001 … 012" for a run of names sharing a prefix, else "cn-001 … gpu-008". */
  function rangeName(names) {
    if (names.length === 1) return names[0];
    const first = names[0];
    const last = names[names.length - 1];
    const m1 = /^(.*?)(\d+)$/.exec(first);
    const m2 = /^(.*?)(\d+)$/.exec(last);
    return m1 && m2 && m1[1] === m2[1] ? `${first} … ${m2[2]}` : `${first} … ${last}`;
  }

  /**
   * One network as a graph (cabling.fabric): tiers Core, Leaf and Nodes;
   * boxes with the cluster's stripe, the name, the position and a meter of
   * the ports in use; on leaves the oversubscription, red above 3 : 1;
   * links as curves that grow wider with the count, one uplink label per
   * leaf and one per link of a node group. Nodes with the same leaves,
   * cluster and type are one box unless `grouped` is false. Options: theme,
   * measure, width (default 1000; grows to fit), grouped, selected (device
   * ids: a Set, a list or { ids }), highlight (device ids, as selected:
   * outlined unless selected), fabric (cabling.fabric of this network,
   * when the caller has it already). Returns { width, height, body, groups:
   * [[device ids]] (data-group indexes them), cores, leaves, switchBox:
   * { x, y, w, h } around the switches, or null }.
   */
  function fabric(project, networkId, opts) {
    const o = opts || {};
    const t = theme(o);
    const T = R.THEMES[t];
    const measure = o.measure || R.approxMeasure;
    const grouped = o.grouped !== false;
    const fab = o.fabric || C.fabric(project, networkId || null);
    const ctx = C.context(project);
    const idx = C.cableIndex(project);
    const net = networkId ? M.networkById(project, networkId) : null;
    const color = net ? net.color : T.unassigned;
    const sel = selectedIds(o.selected);
    const lit = selectedIds(o.highlight);
    /** A box's emphasis: true when selected, 'lit' when highlighted. */
    const mark = (ids) => (ids.some((id) => sel.has(id)) ? true : ids.some((id) => lit.has(id)) ? 'lit' : false);
    const BW = 128;
    const BH = 58;
    const PITCH = BW + 16;
    const groups = grouped
      ? fab.groups
      : fab.nodes.map((n) => {
          const g = fab.groups.find((x) => x.devices.includes(n));
          return { devices: [n], leaves: g ? g.leaves : [], cluster: n.cluster || null, type: n.type };
        });
    const tiers = [];
    if (fab.cores.length) tiers.push({ key: 'core', label: 'CORE', list: fab.cores });
    if (fab.leaves.length) tiers.push({ key: 'leaf', label: 'LEAF', list: fab.leaves });
    if (groups.length) tiers.push({ key: 'node', label: 'NODES', list: groups });
    const most = Math.max(1, ...tiers.map((x) => x.list.length));
    const W = Math.max(o.width || 1000, 96 + most * PITCH);
    const TIER = 210;
    const y0 = 52;
    const height = Math.max(240, y0 + Math.max(1, tiers.length) * TIER - TIER + BH + 60);
    let s = sheetDefs(T, t) + paper(W, height, T, t);
    if (!tiers.length) {
      s += text(W / 2, height / 2, `No cables in ${net ? net.name : 'this network'}`, F.legend, T.ink3, ' text-anchor="middle"');
      return { width: W, height, body: s, groups: [], cores: [], leaves: [], switchBox: null };
    }
    // Places: each tier spread over the width, at most `max` apart.
    const pos = new Map();
    const gpos = [];
    tiers.forEach((tier, ti) => {
      const y = y0 + ti * TIER;
      const n = tier.list.length;
      const pitch = Math.min(tier.key === 'core' ? 340 : 260, (W - 96) / n);
      const x0 = 66 + (W - 76 - pitch * n) / 2;
      tier.y = y;
      tier.list.forEach((item, i) => {
        const p = { x: x0 + pitch * (i + 0.5) - BW / 2, y };
        if (tier.key === 'node') gpos.push(p);
        else pos.set(item.id, p);
      });
      s += text(26, y + 33, tier.label, F.cap, T.ink3, ' letter-spacing="1.4"');
    });
    const tierOf = new Map();
    for (const c of fab.cores) tierOf.set(c.id, 'core');
    for (const l of fab.leaves) tierOf.set(l.id, 'leaf');
    const groupOf = new Map();
    groups.forEach((g, i) => g.devices.forEach((d) => groupOf.set(d.id, i)));
    const linkW = (n) => r1(Math.min(9, 1 + n * 0.8));
    const anySel = sel.size > 0;
    const touches = (ids) => ids.some((id) => sel.has(id));
    const curve = (x1, ya, x2, yb, n, on) =>
      `<path d="M${r1(x1)} ${r1(ya)}C${r1(x1)} ${r1(ya + 80)},${r1(x2)} ${r1(yb - 80)},${r1(x2)} ${r1(yb)}" fill="none" stroke="${color}" stroke-width="${linkW(n)}" stroke-linecap="round" opacity="${anySel && !on ? 0.4 : 0.75}"/>`;
    const labelPill = (x, y, label, strong) => {
      const w = measure(label, F.label.css) + 12;
      return `<rect x="${r1(x - w / 2)}" y="${r1(y - 8)}" width="${r1(w)}" height="15" rx="7.5" fill="${T.paper}" stroke="${strong ? color : T.border}"/>` + text(x - w / 2 + 6, y + 3.4, label, F.label, strong ? T.ink : T.ink2);
    };
    const speedLabel = (links) => {
      const n = links.reduce((a, l) => a + l.count, 0);
      const speeds = new Set(links.map((l) => l.speedGbps));
      const total = links.reduce((a, l) => a + l.totalGbps, 0);
      return speeds.size === 1 && [...speeds][0] ? `${n}×${C.shortSpeed([...speeds][0])}` : total ? `${n} · ${C.shortSpeed(total)}` : `${n}`;
    };

    let links = '';
    let pills = '';
    // Switch to switch: core to leaf as curves, within a tier as arcs.
    const coreIndex = new Map(fab.cores.map((c, i) => [c.id, i]));
    for (const l of fab.links) {
      const ta = tierOf.get(l.a);
      const tb = tierOf.get(l.b);
      if (!ta || !tb) continue;
      const on = sel.has(l.a) || sel.has(l.b);
      if (ta !== tb) {
        const [up, down] = ta === 'core' ? [l.a, l.b] : [l.b, l.a];
        const a = pos.get(up);
        const b = pos.get(down);
        const ci = coreIndex.get(up);
        const x1 = a.x + BW / 2 + (b.x - a.x) * 0.12;
        const x2 = b.x + BW / 2 + (ci - (fab.cores.length - 1) / 2) * Math.min(20, 60 / fab.cores.length);
        links += curve(x1, a.y + BH, x2, b.y, l.count, on);
      } else {
        const a = pos.get(l.a);
        const b = pos.get(l.b);
        const [p, q] = a.x < b.x ? [a, b] : [b, a];
        links += `<path d="M${r1(p.x + BW / 2)} ${r1(p.y)}C${r1(p.x + BW / 2)} ${r1(p.y - 40)},${r1(q.x + BW / 2)} ${r1(q.y - 40)},${r1(q.x + BW / 2)} ${r1(q.y)}" fill="none" stroke="${color}" stroke-width="${linkW(l.count)}" opacity="${anySel && !on ? 0.4 : 0.75}"/>`;
      }
    }
    // One label per leaf: all of its uplinks.
    for (const lf of fab.leaves) {
      const ups = fab.links.filter((l) => (l.a === lf.id || l.b === lf.id) && tierOf.has(l.a === lf.id ? l.b : l.a));
      if (!ups.length) continue;
      const b = pos.get(lf.id);
      pills += labelPill(b.x + BW / 2, b.y - 16, `${speedLabel(ups)} up`, sel.has(lf.id));
    }
    // Node groups to their leaves, one label per link.
    const nodeY = tiers.find((x) => x.key === 'node');
    groups.forEach((g, gi) => {
      if (!nodeY) return;
      const p = gpos[gi];
      const ids = g.devices.map((d) => d.id);
      const leafIds = [...new Set(g.leaves.map((x) => x.id))];
      leafIds.forEach((lid, k) => {
        const ls = fab.links.filter((l) => (ids.includes(l.a) && l.b === lid) || (ids.includes(l.b) && l.a === lid));
        if (!ls.length) return;
        const b = pos.get(lid);
        const n = ls.reduce((a, l) => a + l.count, 0);
        const off = leafIds.length > 1 ? (k - (leafIds.length - 1) / 2) * Math.min(64, (BW - 20) / (leafIds.length - 1)) : 0;
        const x1 = p.x + BW / 2 + off;
        const on = touches(ids) || sel.has(lid);
        links += curve(b.x + BW / 2, b.y + BH, x1, p.y, Math.min(n, 12), on);
        pills += labelPill(x1, p.y - 16, speedLabel(ls), on);
      });
    });
    // Links between nodes (no switch in between): arcs below the node tier.
    if (nodeY) {
      const pairs = new Map();
      for (const l of fab.links) {
        if (tierOf.has(l.a) || tierOf.has(l.b)) continue;
        const ga = groupOf.get(l.a);
        const gb = groupOf.get(l.b);
        if (ga === undefined || gb === undefined) continue;
        const key = ga < gb ? `${ga}|${gb}` : `${gb}|${ga}`;
        pairs.set(key, (pairs.get(key) || 0) + l.count);
      }
      for (const [key, n] of pairs) {
        const [ga, gb] = key.split('|').map(Number);
        const a = gpos[ga];
        const b = gpos[gb];
        const yb = a.y + BH;
        if (ga === gb) continue;
        links += `<path d="M${r1(a.x + BW / 2)} ${r1(yb)}C${r1(a.x + BW / 2)} ${r1(yb + 40)},${r1(b.x + BW / 2)} ${r1(yb + 40)},${r1(b.x + BW / 2)} ${r1(yb)}" fill="none" stroke="${color}" stroke-width="${linkW(n)}" opacity="0.75"/>`;
        pills += labelPill((a.x + b.x) / 2 + BW / 2, yb + 30, `${n}`, false);
      }
    }
    s += links;

    const used = (d) => M.expandPorts(M.typeOf(project, d.type)).filter((p) => idx.has(`${d.id}|${p.name}`)).length;
    const total = (d) => M.expandPorts(M.typeOf(project, d.type)).length;
    const where = (d) => {
      const r = ctx.racks.get(d.loc.rack);
      const [a, b] = M.deviceSpan(project, d);
      const at = d.loc.kind === 'side' ? `V${d.loc.at + 1}` : a === b ? `U${a}` : `U${a}–${b}`;
      return r ? `${shortRack(r.rack.name)} · ${at}` : at;
    };
    const box = (x, y, cluster, title, sub, extra, strong, attrs, titleMax) => {
      const cl = cluster ? M.clusterById(project, cluster) : null;
      return (
        `<g class="fb-box" ${attrs}>` +
        `<rect x="${r1(x)}" y="${r1(y)}" width="${BW}" height="${BH}" rx="5" fill="${T.faceBase}" stroke="${strong === 'lit' ? T.handle : strong ? T.select : T.border}" stroke-width="${strong ? 2 : 1}"/>` +
        `<rect x="${r1(x)}" y="${r1(y)}" width="5" height="${BH}" rx="2" fill="${cl ? cl.color : T.unassigned}"/>` +
        text(x + 13, y + 18, R.fitText(title, F.box, titleMax || BW - 20, measure), F.box, T.ink) +
        text(x + 13, y + 33, R.fitText(sub, F.note, BW - 20, measure), F.note, T.ink3) +
        (extra || '') +
        `</g>`
      );
    };
    const meter = (x, y, a, b, over) => {
      const mw = BW - 66;
      return (
        `<rect x="${r1(x + 13)}" y="${r1(y + 43)}" width="${mw}" height="4" rx="2" fill="${T.barTrack}"/>` +
        (a ? `<rect x="${r1(x + 13)}" y="${r1(y + 43)}" width="${r1(Math.max(3, (mw * Math.min(a, b)) / Math.max(1, b)))}" height="4" rx="2" fill="${T.bar}"/>` : '') +
        text(x + BW - 8, y + 48, `${a}/${b}`, F.small, over ? T.bad : T.ink2, ' text-anchor="end"')
      );
    };
    for (const c of fab.cores) {
      const q = pos.get(c.id);
      s += box(q.x, q.y, c.cluster, c.name, where(c), meter(q.x, q.y, used(c), total(c)), mark([c.id]), `data-dev="${esc(c.id)}" data-core="${esc(c.id)}"`);
    }
    for (const l of fab.leaves) {
      const q = pos.get(l.id);
      const r = fab.ratios.get(l.id);
      const warn = fab.checks.some((k) => k.device === l.id && k.level === 'warn');
      const ratio = r && r.ratio !== null ? C.fmtRatio(r.ratio) : 'no up';
      const bw = Math.max(40, measure(ratio, F.label.css) + 10);
      const badge =
        `<rect x="${r1(q.x + BW - 7 - bw)}" y="${r1(q.y + 22)}" width="${r1(bw)}" height="16" rx="3" fill="${warn ? T.bad : T.barTrack}"/>` +
        text(q.x + BW - 7 - bw / 2, q.y + 33.5, ratio, F.label, warn ? '#ffffff' : T.ink, ' text-anchor="middle"');
      s += box(q.x, q.y, l.cluster, l.name, where(l), meter(q.x, q.y, used(l), total(l)) + badge, mark([l.id]), `data-dev="${esc(l.id)}" data-leaf="${esc(l.id)}"`);
    }
    groups.forEach((g, gi) => {
      const p = gpos[gi];
      const names = g.devices.map((d) => d.name);
      const type = M.typeOf(project, g.type);
      const cl = g.cluster ? M.clusterById(project, g.cluster) : null;
      const ids = g.devices.map((d) => d.id);
      const sub = g.devices.length > 1 ? `${g.devices.length} × ${type ? type.label : g.type}` : where(g.devices[0]);
      const third = cl ? text(p.x + 13, p.y + 49, R.fitText(cl.name, F.head, BW - 20, measure), F.head, R.mix(cl.color, T.ink, 0.25)) : '';
      const attrs = `data-group="${gi}"${ids.length === 1 ? ` data-dev="${esc(ids[0])}"` : ''}`;
      s += box(p.x, p.y, g.cluster, rangeName(names), sub, third, mark(ids), attrs);
    });
    s += pills;
    const sw = [...pos.values()];
    const switchBox = sw.length
      ? (() => {
          const x = Math.min(...sw.map((q) => q.x));
          const y = Math.min(...sw.map((q) => q.y));
          return { x, y, w: Math.max(...sw.map((q) => q.x)) + BW - x, h: Math.max(...sw.map((q) => q.y)) + BH - y };
        })()
      : null;
    return { width: W, height, body: s, groups: groups.map((g) => g.devices.map((d) => d.id)), cores: fab.cores.map((d) => d.id), leaves: fab.leaves.map((d) => d.id), switchBox };
  }

  // --------------------------------------------------------------- export

  /**
   * A standalone SVG document (light theme) of the 'elevation' (opts:
   * rowId, side) or the 'fabric' (opts: networkId, grouped, width). As in
   * render.exportSVG, text is set and measured in fallback fonts, which
   * exported files can load.
   */
  function exportSVG(kind, project, opts) {
    const measure = opts && opts.measure;
    const o = Object.assign({}, opts, {
      theme: 'light',
      interactive: false,
      selected: null,
      pending: null,
      highlight: null,
      focusNetwork: null,
      measure: measure ? (tx, css) => measure(tx, R.withoutWebFonts(css)) : undefined,
    });
    let sc;
    let title;
    if (kind === 'fabric') {
      sc = fabric(project, o.networkId || null, o);
      const net = o.networkId ? M.networkById(project, o.networkId) : null;
      title = `${project.name} · ${net ? net.name : 'No network'} fabric`;
    } else {
      sc = elevation(project, o);
      const pos = M.locateRow(project, sc.rowId);
      title = `${project.name} · ${pos.floor.name} · ${pos.row.name} · ${sc.side}`;
    }
    const body = sc.body.replace(/font-family="([^"]*)"/g, (m, stack) => `font-family="${R.withoutWebFonts(stack)}"`);
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${sc.width}" height="${sc.height}" viewBox="0 0 ${sc.width} ${sc.height}">` +
      `<title>${esc(title)}</title>${body}</svg>`
    );
  }

  return {
    geometry: { U, BAY, RAIL, MGR, FRAME, GAP, MX, RW, SLOT_LEN, HEAD, EXIT_W },
    elevation,
    portMap,
    fabric,
    exportSVG,
  };
});
