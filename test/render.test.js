'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');
const R = require('../js/render.js');
const { assertWellFormed } = require('./xml.js');

const G = R.geometry;

test('a sheet shows one row and renders each of its devices once', () => {
  const p = M.createExampleProject();
  const out = R.renderScene(p, { rowId: 'row1', theme: 'light', interactive: true, date: '2026-01-01' });
  assert.equal(out.width, R.sheetWidth(3, true), 'room for the add-rack slot');
  for (const d of p.devices) {
    const inRow = M.locateRack(p, d.loc.rack).row.id === 'row1';
    assert.equal(out.body.split(`data-id="${d.id}"`).length - 1, inRow ? 1 : 0, d.name);
  }
  assert.ok(out.body.includes('tabindex="0"'));
  assert.ok(out.body.includes('class="add-rack"'));
  const row2 = R.renderScene(p, { rowId: 'row2', interactive: true });
  assert.ok(row2.body.includes('GPU batch 2'), 'reserved space is drawn with its name');
  assert.ok(row2.body.includes('RESERVED · 8U · 6.0 kW'));
});

test('the sheet grows with the rack count and fits one rack', () => {
  const widths = [1, 2, 5, 16].map((n) => R.renderScene(M.createEmptyProject(n), {}).width);
  assert.deepEqual(widths, widths.slice().sort((a, b) => a - b));
  const one = M.createExampleProject();
  M.setRowRackCount(one, 'row1', 1);
  const out = R.renderScene(one, { date: '2026-01-01' });
  assert.equal(out.width, R.sheetWidth(1));
  assert.ok(!/(x|width)="-/.test(out.body), 'nothing is pushed off the sheet');
  assert.ok(out.body.includes('1 rack ·'), 'title block counts racks');
  const three = R.renderScene(M.createExampleProject(), {});
  assert.ok(out.height > three.height, 'legend moves above the title block on a narrow sheet');
  assert.equal(R.renderScene(M.createEmptyProject(16), { interactive: true }).body.includes('add-rack'), false, 'a full row has no add-rack slot');
});

test('racks of different heights stand on one floor line', () => {
  const p = M.createEmptyProject(2);
  M.setRackType(p, 'r2', 'rack-42');
  const lay = R.rowLayout(p, 'row1');
  assert.equal(lay.racks[0].uTop + 47 * G.U, lay.uBottom);
  assert.equal(lay.racks[1].uTop + 42 * G.U, lay.uBottom);
  assert.equal(R.locRect(p, { rack: 'r2', kind: 'u', at: 1 }, 'switch-rj45').y, lay.racks[1].uTop, 'U1 is the top of the shorter rack');
  const svg = R.renderScene(p, {}).body;
  assert.ok(svg.includes('47/42U'), 'the title block lists both heights');
});

test('export SVG is standalone and escapes user text', () => {
  const p = M.createEmptyProject();
  p.name = 'Plan <A&B>';
  p.info.author = '<me>';
  p.devices.push(M.newDevice({ id: 'x', type: 'compute-node', name: '<script>', loc: { rack: 'r1', kind: 'u', at: 1 } }));
  const svg = R.exportSVG(p, { date: '2026-01-01', sheet: { index: 1, count: 4 } });
  assert.ok(svg.startsWith('<?xml'));
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(!svg.includes('<me>'));
  assert.ok(svg.includes('<title>Plan &lt;A&amp;B&gt; · Floor 1 · Row A</title>'));
  assert.ok(svg.includes('>2 / 4<'), 'sheet number');
  assert.ok(!svg.includes('tabindex'), 'no interactive hooks in exports');
  assert.ok(!svg.includes('add-rack'));
  assert.ok(!/var\(--/.test(svg), 'concrete colors only');
  assertWellFormed(svg, 'export');
  assertWellFormed(R.exportSVG(M.createExampleProject(), { date: '2026-01-01' }), 'example export');
});

test('locateDrop snaps to units and finds side slots', () => {
  const p = M.createEmptyProject();
  const lay = R.rowLayout(p, 'row1');
  const bayCenter = (i) => lay.racks[i].bayX + G.BAY_W / 2;
  const unitTop = (u) => lay.racks[0].uTop + (u - 1) * G.U; // U1 is the top row
  // Grab a 2U device at its centre and hover the boundary between U10 and U11.
  assert.deepEqual(R.locateDrop(p, 'row1', 'compute-node', bayCenter(1), unitTop(11), G.U), { rack: 'r2', kind: 'u', at: 10 });
  // Clamps inside the rack, at either end.
  assert.deepEqual(R.locateDrop(p, 'row1', 'storage-node', bayCenter(0), unitTop(1) - 30, 40), { rack: 'r1', kind: 'u', at: 1 });
  assert.deepEqual(R.locateDrop(p, 'row1', 'storage-node', bayCenter(0), unitTop(47) + 30, 40), { rack: 'r1', kind: 'u', at: 44 });
  assert.equal(R.locRect(p, { rack: 'r1', kind: 'u', at: 10 }, 'compute-node').y, unitTop(10));
  // Side channel, upper and lower halves.
  const sideX = lay.racks[2].sideX + 10;
  assert.deepEqual(R.locateDrop(p, 'row1', 'switch-rj45', sideX, unitTop(5), 10), { rack: 'r3', kind: 'side', at: 0 });
  assert.deepEqual(R.locateDrop(p, 'row1', 'switch-rj45', sideX, unitTop(40), 10), { rack: 'r3', kind: 'side', at: 1 });
  assert.equal(R.locateDrop(p, 'row1', 'switch-rj45', bayCenter(0), 5000, 10), null);
  // Reserved space uses its own height.
  assert.deepEqual(R.locateDrop(p, 'row1', 'reserved', bayCenter(0), unitTop(47), 0, 10), { rack: 'r1', kind: 'u', at: 38 });
  // Racks without side slots take drops in their units instead.
  const t = M.addRackType(p, { units: 20, sideSlots: 0 });
  M.setRackType(p, 'r3', t.id);
  const lay2 = R.rowLayout(p, 'row1');
  assert.equal(R.locateDrop(p, 'row1', 'switch-rj45', lay2.racks[2].sideX + 10, lay2.racks[2].uTop + 5, 0).kind, 'u');
});

test('exports use fallback fonts for both measuring and drawing text', () => {
  assert.equal(R.withoutWebFonts(R.FONTS.title.family), "'Arial Narrow', sans-serif");
  assert.equal(R.withoutWebFonts(R.FONTS.legend.css), "500 12px 'Segoe UI', system-ui, -apple-system, sans-serif");
  assert.ok(!/Plex|Barlow/.test(R.withoutWebFonts(R.FONTS.name.css)));
  const seen = [];
  const measure = (t, css) => (seen.push(css), t.length * 6);
  const svg = R.exportSVG(M.createExampleProject(), { measure, date: '2026-01-01' });
  assert.ok(seen.length > 0 && seen.every((css) => !/Plex|Barlow/.test(css)), 'measured without web fonts');
  assert.ok(!/Plex|Barlow/.test(svg), 'drawn without web fonts');
});

test('a multi-U ghost over a side slot stays inside the slot', () => {
  const p = M.createEmptyProject();
  const side = { rack: 'r1', kind: 'side', at: 0 };
  const big = R.renderGhost(p, 'storage-node', side, false, {});
  assert.ok(!big.includes('rotate(-90)'), 'no rotated 4U face');
  const slot = R.locRect(p, side, 'storage-node');
  const widths = [...big.matchAll(/width="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(widths.every((w) => w <= slot.w + 3), `all shapes fit the ${slot.w}px slot`);
  assert.ok(R.renderGhost(p, 'switch-rj45', side, true, {}).includes('rotate(-90)'), '1U devices still preview rotated');
});

test('every drawing style renders at any height', () => {
  for (const face of M.FACES) {
    for (const h of [1, 2, 3, 4, 7]) {
      const type = M.cleanDeviceType({ label: face.label, face: face.id, height: h });
      const pv = R.renderPreview(type, 'light', '#2f6fdb', 'x-01');
      assert.equal(pv.height, h * G.U);
      assert.ok(!/NaN|undefined|Infinity/.test(pv.body), `${face.id} at ${h}U`);
    }
  }
  const res = R.renderPreview(M.RESERVED, 'dark', null, 'later', null, 5);
  assert.equal(res.height, 100);
  assert.ok(res.body.includes('RESERVED · 5U'));
});

test('rack headers flag racks over their power budget', () => {
  const p = M.createEmptyProject(1);
  M.updateRackType(p, 'rack-47', { powerW: 1000 });
  p.devices.push(M.newDevice({ type: 'storage-node', name: 'hot', loc: { rack: 'r1', kind: 'u', at: 1 } }));
  assert.ok(R.renderScene(p, {}).body.includes('0.9/1.0 kW<'));
  p.devices.push(M.newDevice({ type: 'storage-node', name: 'hotter', loc: { rack: 'r1', kind: 'u', at: 5 } }));
  const svg = R.renderScene(p, {}).body;
  assert.ok(svg.includes('1.8/1.0 kW !'));
  assert.ok(svg.includes(R.THEMES.light.bad));
  assert.equal(R.formatPower(850), '850 W');
  assert.equal(R.formatPower(12345), '12.3 kW');
});

test('color schemes derive from the cluster color', () => {
  const light = R.schemeFor('#2f6fdb', 'light');
  const dark = R.schemeFor('#2f6fdb', 'dark');
  assert.equal(light.ear, '#2f6fdb');
  assert.notEqual(light.face, dark.face);
  assert.equal(R.schemeFor(null, 'light').ear, R.THEMES.light.unassigned);
  assert.equal(R.mix('#000000', '#ffffff', 0.5), '#808080');
});

test('fitText shortens long labels with an ellipsis', () => {
  const measure = (t) => t.length * 6;
  assert.equal(R.fitText('short', R.FONTS.name, 60, measure), 'short');
  assert.equal(R.fitText('a-very-long-hostname', R.FONTS.name, 60, measure), 'a-very-lo…');
});

const measure6 = (t) => t.length * 6;

test('devices mounted back to front are drawn with their rear side', () => {
  const p = M.createExampleProject();
  const sw = p.devices.find((d) => d.name === 'sw-mgmt-a01');
  assert.equal(sw.reversed, true);
  const type = M.typeOf(p, sw.type);
  const sc = R.schemeFor('#d9a21b', 'light');
  const rear = R.sideFace(type, sw.name, sc, 'light', measure6, 1, 'rear');
  const front = R.deviceFace(type, sw.name, sc, 'light', measure6, 1);
  const before = R.renderScene(p, { rowId: 'row1', measure: measure6 }).body;
  assert.ok(before.includes(rear), 'the rear side, in its cluster colors');
  assert.ok(!before.includes(front));
  sw.reversed = false;
  const after = R.renderScene(p, { rowId: 'row1', measure: measure6 }).body;
  assert.ok(after.includes(front) && !after.includes(rear), 'mounted the usual way, its front');
  // Side slots too: a reversed 0U switch is drawn rotated with its rear.
  const bmc = p.devices.find((d) => d.name === 'sw-bmc-a01');
  assert.equal(bmc.loc.kind, 'side');
  assert.ok(after.includes(R.sideFace(type, bmc.name, sc, 'light', measure6, 1, 'rear')));
  // Ghosts of a moved reversed device keep its side.
  const ghost = R.renderGhosts(p, [{ typeId: type.id, loc: { rack: 'r1', kind: 'u', at: 40 }, name: 'g', color: '#d9a21b', reversed: true }], true, { measure: measure6 });
  assert.ok(ghost.includes(R.sideFace(type, 'g', sc, 'light', measure6, 1, 'rear')));
  const plain = R.renderGhosts(p, [{ typeId: type.id, loc: { rack: 'r1', kind: 'u', at: 40 }, name: 'g', color: '#d9a21b' }], true, { measure: measure6 });
  assert.ok(plain.includes(R.deviceFace(type, 'g', sc, 'light', measure6, 1)));
  // The ghost of one device too.
  const one = R.renderGhost(p, type.id, { rack: 'r1', kind: 'u', at: 40 }, true, { measure: measure6, name: 'g', color: '#d9a21b', reversed: true });
  assert.equal(one, ghost);
});

test('the side of a device shows its ports, power supplies and fans', () => {
  const p = M.createExampleProject();
  const sc = R.schemeFor('#2f6fdb', 'light');
  const T = R.THEMES.light;
  const leds = (svg) => (svg.match(/r="1\.3" fill="/g) || []).length;
  const fans = (svg) => svg.includes('stroke-width="0.7"><circle');
  const cn = M.typeOf(p, 'compute-node');
  const rear = R.sideFace(cn, 'cn-001', sc, 'light', measure6, 2, 'rear');
  assert.equal(leds(rear), 2, 'two power supplies');
  assert.ok(!fans(rear));
  assert.equal((rear.match(new RegExp(`fill="${T.portHole}"`, 'g')) || []).length, 3, 'three free ports');
  assert.ok(rear.includes('>COMPUTE · 2U<'), 'name and tag above 1U');
  const colored = R.sideFace(cn, 'cn-001', sc, 'light', measure6, 2, 'rear', { portColor: (n) => (n === 'ib0' ? '#ff0000' : null) });
  assert.equal((colored.match(/fill="#ff0000"/g) || []).length, 1, 'a cabled port in its network color');
  assert.ok(!R.sideFace(cn, 'cn-001', sc, 'light', measure6, 2, 'rear', { ports: false }).includes(T.portHole), 'ports left out');
  const sw = M.typeOf(p, 'switch-rj45');
  const swRear = R.sideFace(sw, 'sw', sc, 'light', measure6, 1, 'rear');
  assert.ok(fans(swRear) && leds(swRear) === 2, 'a switch without rear ports shows fans and power');
  const swFront = R.sideFace(sw, 'sw', sc, 'light', measure6, 1, 'front');
  assert.equal(leds(swFront), 0, 'no power supplies at the front');
  assert.ok(!swFront.includes('COMPUTE') && !swFront.includes('SWITCH ·'), '1U: name only');
  for (const face of ['pdu', 'patch', 'blank']) {
    const t = M.cleanDeviceType({ label: face, face, height: 1, ports: [{ name: 'mgmt', connector: 'rj45', speedGbps: 1, side: 'rear' }] });
    assert.equal(leds(R.sideFace(t, 'x', sc, 'light', measure6, 1, 'rear')), 0, `${face}: no power supplies`);
  }
  // Any height and scale, both themes.
  for (const f of M.FACES) {
    for (const h of [1, 2, 4]) {
      const t = M.cleanDeviceType({ label: f.label, face: f.id, height: h, ports: [{ name: 'p', first: 1, count: 20, connector: 'qsfp28', speedGbps: 100, side: 'rear' }] });
      for (const th of ['light', 'dark']) {
        const svg = R.sideFace(t, 'x', R.schemeFor(null, th), th, measure6, h, 'rear', { u: 22, width: 300 });
        assert.ok(!/NaN|undefined|Infinity/.test(svg), `${f.id} ${h}U`);
        assert.ok(svg.includes(`width="299" height="${h * 22 - 1}"`), 'drawn at the given scale');
      }
    }
  }
  assert.ok(R.deviceFace(cn, 'cn', sc, 'light', measure6, 2, { u: 22, width: 300 }).includes('width="299" height="43"'));
});

test('port layouts: switches in two rows, servers in one along their lowest unit', () => {
  const p = M.createExampleProject();
  const sw = R.portLayout(M.typeOf(p, 'switch-rj45'), 'front', 1, 240);
  assert.equal(sw.length, 52);
  assert.deepEqual(sw.slice(0, 2).map((x) => [x.name, x.exit]), [['swp1', 'up'], ['swp2', 'down']], 'odd ports on top');
  assert.ok(sw[0].y < sw[1].y && sw[0].x === sw[1].x);
  assert.ok(sw.every((x) => x.x >= R.geometry.DETAIL_X && x.x + x.w <= 240 - R.geometry.EAR && x.y >= 0 && x.y + x.h <= 20), 'inside the face, right of the name');
  const rj = sw.find((x) => x.name === 'swp1');
  const sfp = sw.find((x) => x.name === 'swp49');
  assert.ok(sfp.w > rj.w, 'cages are wider than jacks');
  assert.equal(R.portLayout(M.typeOf(p, 'switch-rj45'), 'rear', 1, 240).length, 0, 'no rear ports');
  const cn = R.portLayout(M.typeOf(p, 'compute-node'), 'rear', 2, 300, { u: 22 });
  assert.deepEqual(cn.map((x) => x.name), ['bmc', 'eth0', 'ib0'], 'RJ45 first');
  assert.ok(cn.every((x) => x.y > 22 && x.y + x.h < 44 && x.exit === 'down'), 'in the lowest unit');
  assert.ok(cn[0].x + cn[0].w < cn[1].x && cn[1].x + cn[1].w < cn[2].x, 'side by side');
  // Squeezed to fit, never past the face.
  const many = M.cleanDeviceType({ label: 'many', face: 'generic', height: 1, ports: [{ name: 'p', first: 1, count: 8, connector: 'osfp', speedGbps: 400, side: 'rear' }] });
  const lay = R.portLayout(many, 'rear', 1, 240);
  assert.ok(lay.every((x) => x.exit === 'down' && x.x + x.w <= 240 - R.geometry.EAR - 50), 'clear of the power supplies');
  assert.ok(lay.every((x, i) => i === 0 || x.x >= lay[i - 1].x + lay[i - 1].w), 'no overlaps');
  const twelve = R.portLayout(M.cleanDeviceType(Object.assign({}, many, { ports: [Object.assign({}, many.ports[0], { count: 12 })] })), 'rear', 1, 240);
  assert.equal(twelve.filter((x) => x.exit === 'up').length, 6, '12 ports make two rows');
});

test('previews draw either side of a device type', () => {
  const p = M.createExampleProject();
  const cn = M.typeOf(p, 'compute-node');
  const front = R.renderPreview(cn, 'light', '#2f6fdb', 'cn-001', measure6);
  const rear = R.renderPreview(cn, 'light', '#2f6fdb', 'cn-001', measure6, null, 'rear');
  assert.equal(front.height, rear.height);
  assert.notEqual(front.body, rear.body);
  assert.ok(rear.body.includes(R.sideFace(cn, 'cn-001', R.schemeFor('#2f6fdb', 'light'), 'light', measure6, 2, 'rear', { color: '#2f6fdb' })));
  assert.equal(R.renderPreview(cn, 'light', '#2f6fdb', 'cn-001', measure6, null, 'front').body, front.body, 'a side without ports is the plain front');
  const sw = M.typeOf(p, 'switch-rj45');
  assert.ok(R.renderPreview(sw, 'dark', null, 'sw', measure6, null, 'front').body.includes(R.THEMES.dark.portHole), 'the front with its ports');
  assert.ok(R.renderPreview(M.RESERVED, 'light', null, 'later', measure6, 3, 'rear').body.includes('RESERVED · 3U'));
});
