'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');
const R = require('../js/render.js');

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
