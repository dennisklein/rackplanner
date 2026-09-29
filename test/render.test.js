'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');
const R = require('../js/render.js');

const G = R.geometry;

test('scene renders every device once', () => {
  const p = M.createExampleProject();
  const out = R.renderScene(p, { theme: 'light', interactive: true, date: '2026-01-01' });
  assert.equal(out.width, G.SHEET_W);
  for (const d of p.devices) {
    assert.equal(out.body.split(`data-id="${d.id}"`).length - 1, 1, d.name);
  }
  assert.ok(out.body.includes('tabindex="0"'));
});

test('export SVG is standalone and escapes user text', () => {
  const p = M.createEmptyProject();
  p.name = 'Plan <A&B>';
  p.devices.push({ id: 'x', type: 'compute-node', name: '<script>', cluster: null, notes: '', loc: { rack: 'r1', kind: 'u', at: 1 } });
  const svg = R.exportSVG(p, { date: '2026-01-01' });
  assert.ok(svg.startsWith('<?xml'));
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('Plan &lt;A&amp;B&gt;'));
  assert.ok(!svg.includes('tabindex'), 'no interactive hooks in exports');
  assert.ok(!/var\(--/.test(svg), 'concrete colors only');
});

test('locateDrop snaps to units and finds side slots', () => {
  const p = M.createEmptyProject();
  const bayCenter = (i) => 28 + i * (G.RACK_W + 36) + 10 + 24 + G.BAY_W / 2;
  const unitTop = (u) => G.U_TOP + (u - 1) * G.U; // U1 is the top row
  // Grab a 2U device at its centre and hover the boundary between U10 and U11.
  const loc = R.locateDrop(p, 'compute-node', bayCenter(1), unitTop(11), G.U);
  assert.deepEqual(loc, { rack: 'r2', kind: 'u', at: 10 });
  // Clamps inside the rack, at either end.
  assert.deepEqual(R.locateDrop(p, 'storage-node', bayCenter(0), G.U_TOP - 30, 40), { rack: 'r1', kind: 'u', at: 1 });
  assert.deepEqual(R.locateDrop(p, 'storage-node', bayCenter(0), unitTop(47) + 30, 40), { rack: 'r1', kind: 'u', at: 44 });
  // A device drawn at U10 sits ten rows below U1's top edge.
  assert.equal(R.locRect(p, 'compute-node', { rack: 'r1', kind: 'u', at: 10 }).y, unitTop(10));
  // Side channel, upper and lower halves.
  const sideX = 28 + 2 * (G.RACK_W + 36) + G.RACK_W - 20;
  assert.deepEqual(R.locateDrop(p, 'switch-rj45', sideX, G.U_TOP + 100, 10), { rack: 'r3', kind: 'side', at: 0 });
  assert.deepEqual(R.locateDrop(p, 'switch-rj45', sideX, G.U_TOP + 800, 10), { rack: 'r3', kind: 'side', at: 1 });
  assert.equal(R.locateDrop(p, 'switch-rj45', bayCenter(0), 5000, 10), null);
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
