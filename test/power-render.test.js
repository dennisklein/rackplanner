'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../js/model.js');
const P = require('../js/power.js');
const PR = require('../js/power-render.js');
const { assertWellFormed } = require('./xml.js');

const wrap = (out) => `<svg xmlns="http://www.w3.org/2000/svg" width="${out.width}" height="${out.height}">${out.body}</svg>`;
const count = (s, needle) => s.split(needle).length - 1;
const byName = (p, name) => p.devices.find((d) => d.name === name);
/** The example plan and its Row B, which has the PDUs and the cords. */
function example() {
  const p = M.createExampleProject();
  return { p, rowA: M.allRows(p)[0].row, rowB: M.allRows(p)[1].row };
}
/** The x of the first rect of the group with `attr="value"`. */
const xOf = (body, attr, value) => Number(new RegExp(`${attr}="${value}"[^>]*>(?:<title>[^<]*</title>)?<rect x="(-?[\\d.]+)"`).exec(body)[1]);
/** The rect with `attr="value"` itself: { x, y }. */
const rectOf = (body, attr, value) => {
  const m = new RegExp(`${attr}="${value.replace(/[|]/g, '\\|')}" x="(-?[\\d.]+)" y="(-?[\\d.]+)"`).exec(body);
  return m && { x: Number(m[1]), y: Number(m[2]) };
};

test('the rear elevation draws the PDUs, every inlet and outlet, and a cord per power cord of the row', () => {
  const { p, rowB } = example();
  const out = PR.elevation(p, { rowId: rowB.id });
  assertWellFormed(wrap(out));
  assert.equal(out.side, 'rear');
  assert.equal(out.rowId, rowB.id);
  assert.equal(out.cords, 33);
  assert.equal(count(out.body, 'class="pw-cord"'), 33);
  assert.equal(count(out.body, 'class="pw-cord-hit"'), 33);
  assert.equal(count(out.body, 'class="pw-pdu"'), 6);
  // Six PDUs of 30 outlets; 33 of them hold a cord.
  assert.equal(count(out.body, 'data-outlet="'), 180);
  assert.equal(count(out.body, 'class="pw-outlet is-used"'), 33);
  const inlets = p.devices.filter((d) => rowB.racks.some((r) => r.id === d.loc.rack)).reduce((n, d) => n + M.expandInlets(M.typeOf(p, d.type)).length, 0);
  assert.equal(count(out.body, 'data-inlet="'), inlets);
  assert.equal(count(out.body, 'class="pw-inlet is-used"'), 33);
  // Every cord of the plan can be clicked, and is named for a tooltip.
  for (const c of p.powerCords) assert.ok(out.body.includes(`data-cord="${c.id}"`), c.label);
  assert.match(out.body, /<title>P-0001: core-sw-01 psu1 to pdu-b01-a outlet 1<\/title>/);
  // Devices and PDUs are buttons with a name that says where they are.
  assert.match(out.body, /aria-label="gpu-srv-01, GPU server, Rack B02 · U3–6, 4 inlets"/);
  assert.match(out.body, /aria-label="pdu-b01-a, PDU slot P1, Grid A"/);
  // Under the racks: the side, and the grids with their PDUs.
  assert.match(out.body, /Ground floor · Row B · power, from the rear/);
  assert.match(out.body, /Grid A · 3 PDUs/);
  assert.match(out.body, /Grid B · 3 PDUs/);
  // A row without PDUs draws its racks with the free slots, and says so.
  const a = PR.elevation(p, { rowId: example().rowA.id });
  assertWellFormed(wrap(a));
  assert.equal(a.cords, 0);
  assert.match(a.body, /No PDUs in this row yet/);
  assert.ok(count(a.body, 'class="pw-slot"') > 0);
  assert.match(a.body, /2 free PDU slots/);
});

test('from the rear the row is mirrored: the first rack on the right, P1 (left from the front) on its right', () => {
  const { p, rowB } = example();
  const rear = PR.layout(p, rowB.id, 'rear');
  const front = PR.layout(p, rowB.id, 'front');
  assert.deepEqual(rear.racks.map((l) => l.rack.id), rowB.racks.map((r) => r.id).reverse());
  assert.deepEqual(front.racks.map((l) => l.rack.id), rowB.racks.map((r) => r.id));
  assert.equal(rear.width, front.width);
  const a = byName(p, 'pdu-b01-a');
  const b = byName(p, 'pdu-b01-b');
  assert.deepEqual(M.rackPduSlots(p, a.loc.rack), ['left', 'right']);
  const body = PR.elevation(p, { rowId: rowB.id }).body;
  assert.ok(xOf(body, 'data-pdu', a.id) > xOf(body, 'data-pdu', b.id), 'P1 is on the right from the rear');
  const fbody = PR.elevation(p, { rowId: rowB.id, side: 'front' }).body;
  assert.ok(xOf(fbody, 'data-pdu', a.id) < xOf(fbody, 'data-pdu', b.id), 'P1 is on the left from the front');
  // An inlet sits at the edge of its device that faces its PDU.
  const sw = byName(p, 'core-sw-01');
  assert.ok(rectOf(body, 'data-inlet', `${sw.id}|psu1`).x > rectOf(body, 'data-inlet', `${sw.id}|psu2`).x);
  // Two slots on one side: the first listed is the outer one.
  const type = M.rackTypeOf(p, a.loc.rack);
  type.pduSlots = ['left', 'left', 'right'];
  const c = byName(p, 'pdu-b02-a');
  const moved = Object.assign({}, c, { id: 'x-pdu', name: 'pdu-b01-c', loc: { rack: a.loc.rack, kind: 'pdu', at: 1 } });
  b.loc.at = 2;
  p.devices.push(moved);
  const two = PR.elevation(p, { rowId: rowB.id, side: 'front' }).body;
  assert.ok(xOf(two, 'data-pdu', a.id) < xOf(two, 'data-pdu', 'x-pdu'), 'P1 is outside P2 on the left');
  assert.ok(xOf(two, 'data-pdu', 'x-pdu') < xOf(two, 'data-pdu', b.id));
});

test('a cord runs from its inlet into the channel of its PDU and along it to its outlet, in the color of the grid', () => {
  const { p, rowB } = example();
  const out = PR.elevation(p, { rowId: rowB.id });
  const cord = p.powerCords.find((c) => c.label === 'P-0001');
  const m = new RegExp(`<path class="pw-cord" d="M(-?[\\d.]+) (-?[\\d.]+) H(-?[\\d.]+) V(-?[\\d.]+) H(-?[\\d.]+)" fill="none" stroke="(#[0-9a-f]{6})"[^>]*/><path class="pw-cord-hit" data-cord="${cord.id}"`).exec(out.body);
  assert.ok(m, 'the cord is a path of three legs');
  const [x1, y1, lane, y2, x2, stroke] = [1, 2, 3, 4, 5].map((i) => Number(m[i])).concat([m[6]]);
  assert.equal(stroke, p.powerGrids[0].color);
  const inlet = rectOf(out.body, 'data-inlet', `${cord.inlet.device}|${cord.inlet.inlet}`);
  const outlet = rectOf(out.body, 'data-outlet', `${cord.outlet.device}|${cord.outlet.outlet}`);
  assert.ok(Math.abs(y1 - (inlet.y + 4)) < 0.1, 'it starts at the middle of the inlet');
  assert.ok(x1 >= inlet.x && x1 <= inlet.x + 10);
  assert.ok(Math.abs(y2 - (outlet.y + 4)) < 4.1, 'it ends at the height of the outlet');
  assert.ok(Math.abs(x2 - outlet.x) < 14, 'and at the strip');
  // The lane lies in the channel, between the bay and the strip.
  const l = PR.layout(p, rowB.id, 'rear').racks.find((r) => r.rack.id === byName(p, 'core-sw-01').loc.rack);
  assert.ok(lane > l.chR && lane < l.chR + PR.geometry.CH, `lane ${lane} in the right channel`);
  // A cord with a color of its own keeps it.
  cord.color = '#123456';
  assert.match(PR.elevation(p, { rowId: rowB.id }).body, new RegExp(`stroke="#123456"[^>]*/><path class="pw-cord-hit" data-cord="${cord.id}"`));
  // The outlets of a PDU are spread evenly along it, the first at the top.
  const pdu = byName(p, 'pdu-b01-a');
  const ys = M.expandOutlets(M.typeOf(p, pdu.type)).map((o) => rectOf(out.body, 'data-outlet', `${pdu.id}|${o.name}`).y);
  const steps = ys.slice(1).map((y, i) => y - ys[i]);
  assert.ok(steps.every((s) => s > 0 && Math.abs(s - steps[0]) < 0.05));
  const [top, len] = P.pduSpan(p, pdu);
  assert.ok(Math.abs(steps[0] - (len * PR.geometry.UH) / 30) < 0.05, 'over the length of the PDU');
  assert.ok(ys[0] > l.top + (top - 1) * PR.geometry.UH);
});

test('the front shows the devices with their inlets and the PDUs, but no cords', () => {
  const { p, rowB } = example();
  const out = PR.elevation(p, { rowId: rowB.id, side: 'front' });
  assertWellFormed(wrap(out));
  assert.equal(out.side, 'front');
  assert.equal(out.cords, 0);
  assert.equal(count(out.body, 'class="pw-cord'), 0);
  assert.equal(count(out.body, 'class="pw-pdu"'), 6);
  assert.equal(count(out.body, 'class="pw-inlet is-used"'), 33);
  assert.match(out.body, /from the front: the cords run at the rear/);
  // The strips are dashed: the PDUs hang at the rear.
  assert.match(out.body, /<g class="pw-pdu"[^>]*><rect [^>]*stroke-dasharray="4 3"\/>/);
});

test('a hidden grid, a selection, a connection being made and a search change what is drawn', () => {
  const { p, rowB } = example();
  const base = { rowId: rowB.id };
  // Hidden: the cords of the grid go, its PDUs fade, and the legend says so.
  const hidden = PR.elevation(p, Object.assign({ hiddenGrids: ['pg-b'] }, base));
  assert.equal(hidden.cords, 18);
  assert.equal(count(hidden.body, 'class="pw-pdu" data-pdu'), 6);
  assert.equal(count(hidden.body, 'opacity="0.45" role="button"'), 3);
  assert.match(hidden.body, /Grid B · 3 PDUs \(cords hidden\)/);
  // A device selected: a ring, its cords bold and drawn last, the far ends named.
  const gpu = byName(p, 'gpu-srv-01');
  const sel = PR.elevation(p, Object.assign({ selected: { devices: [gpu.id], cords: [] } }, base));
  assertWellFormed(wrap(sel));
  assert.equal(count(sel.body, 'class="pw-cord is-selected"'), 4);
  assert.equal(count(sel.body, 'class="pw-dev is-selected"'), 1);
  for (const tag of ['pdu-b02-a · 5', 'pdu-b02-b · 5', 'pdu-b02-a · 20', 'pdu-b02-b · 20']) assert.ok(sel.body.includes(`>${tag}</text>`), tag);
  assert.ok(sel.body.lastIndexOf('class="pw-cord is-selected"') > sel.body.lastIndexOf('class="pw-cord"'), 'bold cords are drawn over the others');
  // A cord selected: it alone is bold, with its far end named.
  const cord = p.powerCords.find((c) => c.label === 'P-0007');
  const one = PR.elevation(p, Object.assign({ selected: { devices: [], cords: [cord.id] } }, base));
  assert.equal(count(one.body, 'class="pw-cord is-selected"'), 1);
  assert.equal(count(one.body, 'class="pw-dev is-selected"'), 0);
  // A PDU selected: all its cords.
  const pdu = byName(p, 'pdu-b02-a');
  const all = PR.elevation(p, Object.assign({ selected: { devices: [pdu.id] } }, base));
  assert.equal(count(all.body, 'class="pw-cord is-selected"'), 7);
  assert.equal(count(all.body, 'class="pw-pdu is-selected"'), 1);
  // The end a connection starts from is ringed.
  const sw = byName(p, 'sw-mgmt-b01');
  const T = require('../js/render.js').THEMES.light;
  const pending = PR.elevation(p, Object.assign({ pending: { device: sw.id, inlet: 'psu2' } }, base));
  assert.match(pending.body, new RegExp(`data-inlet="${sw.id}\\|psu2"[^>]*stroke="${T.handle}" stroke-width="2"`));
  const pendingOut = PR.elevation(p, Object.assign({ pending: { device: pdu.id, outlet: '2' } }, base));
  assert.match(pendingOut.body, new RegExp(`data-outlet="${pdu.id}\\|2"[^>]*stroke="${T.handle}" stroke-width="2"`));
  // A search keeps its matches at full strength.
  const match = PR.elevation(p, Object.assign({ match: new Set([gpu.id]) }, base));
  assert.ok(count(match.body, 'opacity="0.3"') > 5);
  assert.doesNotMatch(match.body, new RegExp(`data-dev="${gpu.id}" opacity`));
  // The dark theme draws the same, on dark paper.
  const dark = PR.elevation(p, Object.assign({ theme: 'dark' }, base));
  assertWellFormed(wrap(dark));
  assert.equal(dark.cords, 33);
  assert.notEqual(dark.body.slice(0, 120), PR.elevation(p, base).body.slice(0, 120));
});

test('a PDU without a grid, side-slot devices and reserved space are drawn; names are escaped', () => {
  const { p, rowB } = example();
  byName(p, 'pdu-b01-b').grid = null;
  byName(p, 'core-sw-01').name = 'core <sw> & "01"';
  // A 1U device in a side slot of Rack B01, with an inlet.
  const type = M.rackTypeOf(p, rowB.racks[0].id);
  assert.ok(type.sideSlots > 0);
  p.devices.push({ id: 'x-side', type: 'switch-rj45', name: 'side-sw', loc: { rack: rowB.racks[0].id, kind: 'side', at: 0 }, cluster: null, notes: '' });
  const out = PR.elevation(p, { rowId: rowB.id });
  assertWellFormed(wrap(out));
  assert.match(out.body, /No grid · 1 PDU/);
  assert.match(out.body, /aria-label="pdu-b01-b, PDU slot P2, no grid"/);
  assert.ok(out.body.includes(P.NO_GRID_COLOR));
  assert.match(out.body, /core &lt;sw&gt; &amp; &quot;01&quot;/);
  assert.match(out.body, /SIDE SLOTS/);
  assert.match(out.body, /data-dev="x-side"/);
  assert.ok(out.body.includes('data-inlet="x-side|psu1"'));
  // Reserved space is no button and has no inlets.
  assert.match(out.body, /<g class="pw-dev is-reserved" data-dev="[^"]+">/);
});

test('exportSVG gives a standalone file of the rear elevation in the light theme, without web fonts', () => {
  const { p, rowB } = example();
  const svg = PR.exportSVG(p, { rowId: rowB.id, side: 'rear', hiddenGrids: [] });
  assert.match(svg, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="\d+" height="\d+" viewBox="0 0 \d+ \d+"><title>Hall 2 expansion · Ground floor · Row B · power rear<\/title>/);
  assertWellFormed(svg.replace(/^<\?xml[^>]*\?>\n/, ''));
  assert.doesNotMatch(svg, /IBM Plex Mono|Barlow/);
  assert.equal(count(svg, 'class="pw-cord"'), 33);
  assert.match(svg, /Grid A · 3 PDUs/);
  // What the screen hides stays out of the file; a selection does not go into it.
  const part = PR.exportSVG(p, { rowId: rowB.id, hiddenGrids: ['pg-a'], selected: { devices: [byName(p, 'gpu-srv-01').id] } });
  assert.equal(count(part, 'class="pw-cord"'), 15);
  assert.equal(count(part, 'is-selected'), 0);
});

test('the drawing module is registered with the page and the service worker, and has no DOM access', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  for (const f of ['js/power.js', 'js/power-render.js', 'css/power.css']) {
    assert.ok(html.includes(`"${f}"`), `index.html loads ${f}`);
    assert.ok(sw.includes(`'${f}'`), `sw.js caches ${f}`);
  }
  for (const f of ['js/power.js', 'js/power-render.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\b(document|window|localStorage|navigator)\b/, `${f} has no DOM access`);
  }
});

test('three or four PDUs on one side of a rack stay in the channel, with lanes for their cords beside them', () => {
  const G = PR.geometry;
  for (const n of [3, 4]) {
    const p = M.createEmptyProject(2);
    P.addGrid(p, { name: 'Grid A' });
    P.addGrid(p, { name: 'Grid B' });
    const type = M.addDeviceType(p, M.TYPE_TEMPLATES.find((t) => t.label === '0U PDU 3P 30'));
    assert.equal(M.updateRackType(p, 'rack-47', { pduSlots: Array(n).fill('left') }), null);
    const pdus = M.fillPduSlots(p, ['r1'], type.id);
    assert.equal(pdus.length, n);
    // Six servers, each on the outermost and the innermost PDU.
    for (let i = 0; i < 6; i++) {
      const d = M.newDevice({ id: `cn-${i}`, type: 'compute-node', name: `cn-${i}`, loc: { rack: 'r1', kind: 'u', at: 4 + 2 * i } });
      p.devices.push(d);
      for (const [inlet, pdu] of [['psu1', pdus[0]], ['psu2', pdus[n - 1]]]) assert.ok(P.connect(p, { inlet: { device: d.id, inlet }, outlet: { device: pdu.id, outlet: String(i + 1) } }).cord);
    }
    for (const side of ['rear', 'front']) {
      const out = PR.elevation(p, { rowId: 'row1', side });
      assertWellFormed(wrap(out));
      const l = PR.layout(p, 'row1', side).racks.find((x) => x.rack.id === 'r1');
      // Slots on the left are on the left from the front, and on the right from the rear.
      const ch = side === 'front' ? l.chL : l.chR;
      const strips = pdus.map((d) => {
        const m = new RegExp(`data-pdu="${d.id}"[^>]*><rect x="([\\d.]+)" y="[\\d.]+" width="([\\d.]+)"`).exec(out.body);
        return { x: Number(m[1]), w: Number(m[2]), id: d.id };
      });
      for (const st of strips) assert.ok(st.x >= ch + 2 && st.x + st.w <= ch + G.CH - 2, `${n} strips, ${side}: a strip from ${st.x} to ${st.x + st.w} is in the channel from ${ch} to ${ch + G.CH}`);
      const byX = strips.slice().sort((a, b) => a.x - b.x);
      byX.forEach((st, i) => i && assert.ok(st.x >= byX[i - 1].x + byX[i - 1].w + 2, 'the strips keep a gap'));
      // The first slot is the outermost.
      assert.equal(side === 'front' ? byX[0].id : byX[n - 1].id, pdus[0].id);
      // Every outlet is inside its strip.
      for (const st of strips) {
        const o = new RegExp(`data-outlet="${st.id}\\|1" x="([\\d.]+)" y="[\\d.]+" width="([\\d.]+)"`).exec(out.body);
        assert.ok(Number(o[1]) >= st.x + 1 && Number(o[1]) + Number(o[2]) <= st.x + st.w - 1, 'an outlet is inside its strip');
      }
      // The names of the PDUs are beside the frame, on the sheet.
      const names = [...out.body.matchAll(/<text x="(-?[\d.]+)"[^>]*>P\d · pdu-/g)].map((m) => Number(m[1]));
      assert.equal(names.length, n);
      for (const x of names) assert.ok(x >= 5 && x <= out.width - 5, `a name at ${x} is on the sheet of ${out.width}`);
      assert.equal(new Set(names).size, n);
      if (side === 'front') continue;
      // The cords run between the strips and the bay, in more than one lane.
      const lanes = [...out.body.matchAll(/class="pw-cord" d="M[\d.]+ [\d.]+ H([\d.]+) V/g)].map((m) => Number(m[1]));
      assert.equal(lanes.length, 12);
      const inner = Math.min(...strips.map((st) => st.x));
      for (const x of lanes) assert.ok(x > l.chR && x < inner - 1, `a lane at ${x} is between the bay at ${l.chR} and the strips from ${inner}`);
      assert.ok(new Set(lanes).size >= 2, `${n} strips leave ${new Set(lanes).size} lane`);
    }
  }
  // One or two PDUs on a side are as wide as before.
  const { p, rowB } = example();
  const pdu = byName(p, 'pdu-b02-a');
  assert.ok(new RegExp(`data-pdu="${pdu.id}"[^>]*><rect x="[\\d.]+" y="[\\d.]+" width="${G.STRIP}"`).test(PR.elevation(p, { rowId: rowB.id }).body));
  assert.equal(PR.layout(p, rowB.id, 'rear').left, G.MARGIN);
});
