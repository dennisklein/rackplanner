'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');

function project(devices) {
  const p = M.createEmptyProject();
  p.clusters.push({ id: 'c1', name: 'Alpha', color: '#2f6fdb' });
  let n = 0;
  for (const [type, rack, kind, at, name] of devices || []) {
    p.devices.push({ id: `d${++n}`, type, name: name || `dev-${n}`, cluster: null, notes: '', loc: { rack, kind, at } });
  }
  return p;
}

test('racks have 47 units and two 1U side slots', () => {
  const p = M.createEmptyProject();
  assert.equal(p.racks.length, 3, 'three racks by default');
  assert.equal(M.RACK_UNITS, 47);
  assert.equal(M.SIDE_SLOTS, 2);
  assert.deepEqual(
    M.DEVICE_TYPES.map((t) => [t.id, t.height]),
    [
      ['switch-rj45', 1],
      ['switch-qsfp', 1],
      ['compute-node', 2],
      ['storage-node', 4],
      ['storage-enclosure', 4],
    ]
  );
});

test('rack count can be set between 1 and 5', () => {
  assert.deepEqual(M.createEmptyProject(1).racks, [{ id: 'r1', name: 'Rack A01' }]);
  assert.equal(M.createEmptyProject(9).racks.length, 5, 'clamped to 5');
  assert.equal(M.createEmptyProject(0).racks.length, 3, 'falls back to the default');

  const p = M.createExampleProject();
  M.setRackCount(p, 5);
  assert.deepEqual(p.racks.map((r) => r.id), ['r1', 'r2', 'r3', 'r4', 'r5']);
  assert.deepEqual(p.racks.slice(3).map((r) => r.name), ['Rack A04', 'Rack A05']);
  assert.equal(p.devices.length, 37, 'adding racks keeps every device');

  const inR2andR3 = p.devices.filter((d) => d.loc.rack !== 'r1').length;
  assert.equal(M.devicesBeyond(p, 1).length, inR2andR3);
  assert.equal(M.devicesBeyond(p, 3).length, 0, 'r4 and r5 are empty');
  M.setRackCount(p, 1);
  assert.deepEqual(p.racks.map((r) => r.id), ['r1']);
  assert.ok(p.devices.every((d) => d.loc.rack === 'r1'), 'devices in removed racks are gone');
  assert.equal(p.devices.length, 37 - inR2andR3);
  M.setRackCount(p, 0);
  assert.equal(p.racks.length, 1, 'never fewer than one rack');
});

test('canPlace keeps devices inside U1–U47', () => {
  const p = project();
  assert.ok(M.canPlace(p, 'storage-node', { rack: 'r1', kind: 'u', at: 44 }).ok);
  assert.ok(!M.canPlace(p, 'storage-node', { rack: 'r1', kind: 'u', at: 45 }).ok);
  assert.ok(M.canPlace(p, 'switch-rj45', { rack: 'r1', kind: 'u', at: 47 }).ok);
  assert.ok(!M.canPlace(p, 'switch-rj45', { rack: 'r1', kind: 'u', at: 0 }).ok);
  assert.ok(!M.canPlace(p, 'switch-rj45', { rack: 'r1', kind: 'u', at: 1.5 }).ok);
  assert.ok(!M.canPlace(p, 'switch-rj45', { rack: 'nope', kind: 'u', at: 3 }).ok);
});

test('canPlace rejects overlaps but not neighbours or other racks', () => {
  const p = project([['storage-node', 'r1', 'u', 10, 'sn-01']]); // U10–13
  const at = (u, rack) => M.canPlace(p, 'compute-node', { rack: rack || 'r1', kind: 'u', at: u });
  assert.ok(at(8).ok, 'U8–9 sits directly above');
  assert.ok(at(14).ok, 'U14–15 sits directly below');
  assert.ok(!at(9).ok, 'U9–10 overlaps the first unit');
  assert.ok(!at(13).ok, 'U13–14 overlaps the last unit');
  assert.match(at(12).reason, /sn-01/);
  assert.ok(at(12, 'r2').ok, 'other racks are independent');
  assert.ok(M.canPlace(p, 'storage-node', { rack: 'r1', kind: 'u', at: 10 }, 'd1').ok, 'ignored device');
});

test('side slots take one 1U device each', () => {
  const p = project([['switch-rj45', 'r1', 'side', 0]]);
  assert.ok(!M.canPlace(p, 'switch-qsfp', { rack: 'r1', kind: 'side', at: 0 }).ok);
  assert.ok(M.canPlace(p, 'switch-qsfp', { rack: 'r1', kind: 'side', at: 1 }).ok);
  assert.ok(!M.canPlace(p, 'switch-qsfp', { rack: 'r1', kind: 'side', at: 2 }).ok);
  assert.match(M.canPlace(p, 'compute-node', { rack: 'r2', kind: 'side', at: 0 }).reason, /1U/);
  // Side slots don't block rack units.
  assert.ok(M.canPlace(p, 'switch-qsfp', { rack: 'r1', kind: 'u', at: 47 }).ok);
});

test('planPositions stacks toward higher or lower unit numbers and skips occupied units', () => {
  const p = project([['switch-rj45', 'r1', 'u', 14]]);
  assert.deepEqual(M.planPositions(p, 'compute-node', 'r1', 10, 3, 1), [10, 12, 15]);
  assert.deepEqual(M.planPositions(p, 'compute-node', 'r1', 10, 3, -1), [10, 8, 6]);
  assert.deepEqual(M.planPositions(p, 'storage-node', 'r1', 40, 5, 1), [40, 44], 'stops at U47');
  assert.equal(M.planPositions(p, 'compute-node', 'r2', 1, Infinity, 1).length, 23);
});

test('validLocs, nudgeTarget and nearestLoc find free space', () => {
  const p = project([
    ['compute-node', 'r1', 'u', 20],
    ['compute-node', 'r1', 'u', 22],
  ]);
  const d = M.deviceById(p, 'd1');
  assert.deepEqual(M.nudgeTarget(p, d, 1), { rack: 'r1', kind: 'u', at: 24 }, 'jumps over d2');
  assert.deepEqual(M.nudgeTarget(p, d, -1), { rack: 'r1', kind: 'u', at: 19 });
  const sw = M.validLocs(p, 'switch-rj45', 'r1');
  assert.deepEqual(sw.slice(0, 2), [
    { rack: 'r1', kind: 'side', at: 0 },
    { rack: 'r1', kind: 'side', at: 1 },
  ]);
  assert.equal(sw.length, 2 + 47 - 4);
  assert.deepEqual(M.nearestLoc(p, 'compute-node', 'r1', 21, null), { rack: 'r1', kind: 'u', at: 18 });
});

test('names count up in series', () => {
  assert.deepEqual(M.nameSequence('cn-008', 3), ['cn-008', 'cn-009', 'cn-010']);
  assert.deepEqual(M.nameSequence('node', 2), ['node-01', 'node-02']);
  assert.deepEqual(M.nameSequence(' db-1 ', 1), ['db-1']);
  assert.deepEqual(M.nameSequence('rack7-n9a', 2), ['rack7-n9a', 'rack7-n10a']);
  const p = project([
    ['compute-node', 'r1', 'u', 1, 'cn-001'],
    ['compute-node', 'r1', 'u', 3, 'cn-002'],
  ]);
  assert.equal(M.nextFreeName(p, 'cn-001'), 'cn-003');
  assert.equal(M.nextFreeName(p, 'db'), 'db-2');
});

test('suggestPlacement continues the nearest series and reuses its cluster', () => {
  const p = M.createExampleProject();
  assert.deepEqual(M.suggestPlacement(p, 'compute-node', { rack: 'r1', kind: 'u', at: 30 }), {
    name: 'cn-013',
    cluster: 'c-kestrel',
  });
  assert.deepEqual(M.suggestPlacement(p, 'compute-node', { rack: 'r2', kind: 'u', at: 20 }, 4), {
    name: 'gpu-009',
    cluster: 'c-osprey',
  });
  const empty = M.createEmptyProject();
  assert.deepEqual(M.suggestPlacement(empty, 'storage-enclosure', null), { name: 'jbod-01', cluster: undefined });
  assert.equal(M.suggestName(empty, 'compute-node', 3), 'cn-001');
});

test('example project is valid', () => {
  const p = M.createExampleProject();
  for (const d of p.devices) {
    const r = M.canPlace(p, d.type, d.loc, d.id);
    assert.ok(r.ok, `${d.name}: ${r.reason}`);
    assert.ok(M.clusterById(p, d.cluster), `${d.name} has a cluster`);
  }
  const { project: again, warnings } = M.normalizeProject(JSON.parse(M.serialize(p)));
  assert.deepEqual(warnings, []);
  assert.equal(again.devices.length, p.devices.length);
});

test('rackStats reports usage and the largest free block', () => {
  const p = project([
    ['storage-node', 'r1', 'u', 1],
    ['compute-node', 'r1', 'u', 40],
    ['switch-rj45', 'r1', 'side', 1],
  ]);
  assert.deepEqual(M.rackStats(p, 'r1'), { used: 6, free: 41, largestFree: 35, sideUsed: 1, count: 3 });
});

test('normalizeProject drops what does not fit and keeps the rest', () => {
  const raw = {
    name: '  Hall 3  ',
    racks: [{ id: 'x', name: 'West' }, { id: 'y' }, { id: 'z', name: 'East' }],
    clusters: [
      { id: 'c1', name: 'HPC', color: '#ABC' },
      { id: 'c1', name: 'dupe', color: '#fff' },
      { id: 'c2', name: '', color: 'red' },
    ],
    devices: [
      { id: 'a', type: 'compute-node', name: 'cn-1', cluster: 'c1', loc: { rack: 'x', kind: 'u', at: 10 } },
      { id: 'b', type: 'compute-node', name: 'cn-2', cluster: 'c1', loc: { rack: 'x', kind: 'u', at: 11 } },
      { id: 'c', type: 'toaster', name: 't', loc: { rack: 'x', kind: 'u', at: 1 } },
      { id: 'd', type: 'storage-node', name: 'sn', loc: { rack: 'x', kind: 'side', at: 0 } },
      { id: 'a', type: 'switch-qsfp', name: 'sw', cluster: 'nope', loc: { rack: 'z', kind: 'side', at: 1 } },
      null,
    ],
  };
  const { project: p, warnings } = M.normalizeProject(raw);
  assert.equal(p.name, 'Hall 3');
  assert.deepEqual(p.racks.map((r) => r.name), ['West', 'Rack A02', 'East']);
  assert.deepEqual(p.clusters.map((c) => [c.id, c.color]), [
    ['c1', '#aabbcc'],
    ['c2', M.nextClusterColor({ clusters: [{ color: '#aabbcc' }] })],
  ]);
  assert.deepEqual(p.devices.map((d) => d.name), ['cn-1', 'sw']);
  assert.equal(p.devices[1].cluster, null);
  assert.notEqual(p.devices[1].id, 'a', 'duplicate ids are replaced');
  assert.deepEqual(p.devices[1].loc, { rack: 'r3', kind: 'side', at: 1 });
  assert.equal(warnings.length, 3);
  assert.throws(() => M.normalizeProject([]), /not a rack plan/);
  assert.throws(() => M.normalizeProject({ foo: 1 }), /not a rack plan/);
});

test('normalizeProject keeps between 1 and 5 racks', () => {
  const racks = (n) => Array.from({ length: n }, (_, i) => ({ id: `rack-${i}`, name: `R${i}` }));
  const dev = (rack) => ({ type: 'compute-node', name: `n-${rack}`, loc: { rack, kind: 'u', at: 1 } });
  const one = M.normalizeProject({ racks: racks(1), devices: [dev('rack-0')] });
  assert.deepEqual(one.project.racks, [{ id: 'r1', name: 'R0' }]);
  assert.equal(one.project.devices.length, 1);
  const seven = M.normalizeProject({ racks: racks(7), devices: [dev('rack-4'), dev('rack-6')] });
  assert.equal(seven.project.racks.length, 5);
  assert.deepEqual(seven.project.devices.map((d) => d.loc.rack), ['r5'], 'device in the 7th rack is dropped');
  assert.equal(seven.warnings.length, 2);
  assert.equal(M.normalizeProject({ devices: [] }).project.racks.length, 3, 'default when racks are missing');
});

test('version 1 plans, counted from the bottom, keep their layout', () => {
  const raw = {
    version: 1,
    devices: [
      { id: 'a', type: 'switch-rj45', name: 'top', loc: { rack: 'r1', kind: 'u', at: 47 } },
      { id: 'b', type: 'storage-node', name: 'bottom', loc: { rack: 'r1', kind: 'u', at: 1 } },
      { id: 'c', type: 'compute-node', name: 'mid', loc: { rack: 'r2', kind: 'u', at: 21 } },
      { id: 'd', type: 'switch-qsfp', name: 'side', loc: { rack: 'r3', kind: 'side', at: 0 } },
    ],
  };
  const { project: p, warnings } = M.normalizeProject(raw);
  assert.deepEqual(warnings, []);
  assert.deepEqual(p.devices.map((d) => d.loc.at), [1, 44, 26, 0]);
  assert.equal(p.version, 2);
  assert.equal(M.normalizeProject(JSON.parse(M.serialize(p))).project.devices[1].loc.at, 44, 'version 2 is kept');
});

test('toCSV lists devices top to bottom and neutralises formulas', () => {
  const p = project([
    ['compute-node', 'r1', 'u', 5, '=cmd()'],
    ['switch-rj45', 'r1', 'u', 47, 'sw, "core"'],
    ['switch-qsfp', 'r1', 'side', 0, 'leaf'],
  ]);
  p.devices[0].cluster = 'c1';
  const lines = M.toCSV(p).trim().split('\r\n');
  assert.equal(lines[0], 'Rack,Position,Height (U),Type,Name,Cluster,Notes');
  assert.equal(lines[1], "Rack A01,U5-6,2,Compute node,'=cmd(),Alpha,");
  assert.equal(lines[2], 'Rack A01,U47,1,48-port switch,"sw, ""core""",,');
  assert.equal(lines[3], 'Rack A01,Side V1,1,24-port switch,leaf,,');
});
