'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');

function project(devices) {
  const p = M.createEmptyProject();
  p.clusters.push({ id: 'c1', name: 'Alpha', color: '#2f6fdb' });
  let n = 0;
  for (const [type, rack, kind, at, name, extra] of devices || []) {
    p.devices.push(M.newDevice(Object.assign({ id: `d${++n}`, type, name: name || `dev-${n}`, loc: { rack, kind, at } }, extra)));
  }
  return p;
}

test('a new plan has one floor with one row of three 47U racks and the standard catalog', () => {
  const p = M.createEmptyProject();
  assert.equal(p.version, 3);
  assert.deepEqual(p.floors, [
    {
      id: 'f1',
      name: 'Floor 1',
      rows: [
        {
          id: 'row1',
          name: 'Row A',
          racks: [
            { id: 'r1', name: 'Rack A01', type: 'rack-47' },
            { id: 'r2', name: 'Rack A02', type: 'rack-47' },
            { id: 'r3', name: 'Rack A03', type: 'rack-47' },
          ],
        },
      ],
    },
  ]);
  assert.equal(M.rackUnits(p, 'r1'), 47);
  assert.equal(M.rackSideSlots(p, 'r1'), 2);
  assert.deepEqual(
    p.deviceTypes.map((t) => [t.id, t.height]),
    [
      ['switch-rj45', 1],
      ['switch-qsfp', 1],
      ['compute-node', 2],
      ['storage-node', 4],
      ['storage-enclosure', 4],
    ]
  );
  assert.deepEqual(M.placeableTypes(p).map((t) => t.id).slice(-1), ['reserved']);
  assert.equal(M.createEmptyProject(1).floors[0].rows[0].racks.length, 1);
  assert.equal(M.createEmptyProject(40).floors[0].rows[0].racks.length, 16, 'clamped to 16');
});

test('floors, rows and racks respect their limits', () => {
  const p = M.createEmptyProject(1);
  for (let i = 0; i < 10; i++) M.addFloor(p, { racks: 1 });
  assert.equal(p.floors.length, 6, 'at most six floors');
  assert.deepEqual(p.floors.map((f) => f.name).slice(0, 3), ['Floor 1', 'Floor 2', 'Floor 3']);
  assert.equal(M.addFloor(p), null);

  const f = p.floors[0];
  for (let i = 0; i < 10; i++) M.addRow(p, f.id, { racks: 1 });
  assert.equal(f.rows.length, 8, 'at most eight rows per floor');
  assert.deepEqual(f.rows.map((r) => r.name).slice(0, 3), ['Row A', 'Row B', 'Row C']);

  const row = f.rows[0];
  for (let i = 0; i < 20; i++) M.addRack(p, row.id);
  assert.equal(row.racks.length, 16, 'at most sixteen racks per row');
  assert.equal(row.racks[15].name, 'Rack A16');
  assert.equal(M.allRacks(p).length, 16 + 7 + 5, 'rack ids stay unique across the plan');
  assert.equal(new Set(M.allRacks(p).map((r) => r.rack.id)).size, 28);
  assert.equal(p.floors[1].rows[0].racks[0].name, 'Rack 2A01', 'racks on upper floors carry the floor number');
});

test('racks can be inserted, reordered, moved to another row and removed', () => {
  const p = project([
    ['compute-node', 'r2', 'u', 5, 'cn-a'],
    ['compute-node', 'r3', 'u', 5, 'cn-b'],
  ]);
  const row = p.floors[0].rows[0];
  const inserted = M.addRack(p, 'row1', { index: 1 });
  assert.deepEqual(row.racks.map((r) => r.id), ['r1', inserted.id, 'r2', 'r3']);
  assert.equal(inserted.name, 'Rack A04', 'gets a free name');
  M.renumberRacks(p, 'row1');
  assert.deepEqual(row.racks.map((r) => r.name), ['Rack A01', 'Rack A02', 'Rack A03', 'Rack A04']);

  assert.ok(M.moveRack(p, 'r3', 'row1', 0));
  assert.deepEqual(row.racks.map((r) => r.id), ['r3', 'r1', inserted.id, 'r2']);
  assert.equal(M.deviceById(p, 'd2').loc.rack, 'r3', 'devices travel with their rack');

  const row2 = M.addRow(p, 'f1', { racks: 1 });
  assert.ok(M.moveRack(p, 'r2', row2.id, 0));
  assert.deepEqual(row2.racks.map((r) => r.id), ['r2', row2.racks[1].id]);
  assert.equal(M.locateRack(p, 'r2').row.id, row2.id);

  assert.deepEqual(M.devicesWithin(p, row2.id).map((d) => d.name), ['cn-a']);
  assert.ok(M.removeRack(p, 'r2'));
  assert.equal(p.devices.length, 1, 'its devices are removed with it');
  assert.ok(!M.removeRack(p, row2.racks[0].id), 'a row keeps one rack');
  assert.ok(M.removeRow(p, row2.id));
  assert.ok(!M.removeRow(p, 'row1'), 'a floor keeps one row');
  assert.ok(!M.removeFloor(p, 'f1'), 'a plan keeps one floor');
});

test('rows and floors move within their limits', () => {
  const p = M.createEmptyProject(1);
  const f2 = M.addFloor(p, { racks: 1 });
  const rowB = M.addRow(p, 'f1', { racks: 1 });
  assert.ok(M.moveRow(p, rowB.id, 'f1', 0));
  assert.deepEqual(p.floors[0].rows.map((r) => r.name), ['Row B', 'Row A']);
  assert.ok(M.moveRow(p, rowB.id, f2.id));
  assert.deepEqual(f2.rows.map((r) => r.name), ['Row A', 'Row B'], 'to the end of another floor');
  assert.ok(!M.moveRow(p, 'row1', f2.id), 'a floor keeps one row');
  while (f2.rows.length < 8) M.addRow(p, f2.id, { racks: 1 });
  assert.equal(M.insertRow(p, f2), null, 'a floor holds eight rows');
  M.addRow(p, 'f1', { racks: 1 });
  assert.ok(!M.moveRow(p, p.floors[0].rows[1].id, f2.id), 'a full floor takes no row');

  assert.ok(M.moveFloor(p, f2.id, 0));
  assert.deepEqual(p.floors.map((f) => f.id), [f2.id, 'f1']);
  while (p.floors.length < 6) M.addFloor(p);
  assert.equal(M.insertFloor(p), null, 'a plan holds six floors');
});

test('row rack count can be set between 1 and 16', () => {
  const p = M.createExampleProject();
  M.setRowRackCount(p, 'row1', 5);
  assert.deepEqual(p.floors[0].rows[0].racks.map((r) => r.name).slice(3), ['Rack A04', 'Rack A05']);
  const inA2andA3 = p.devices.filter((d) => d.loc.rack === 'r2' || d.loc.rack === 'r3').length;
  assert.equal(M.devicesBeyond(p, 'row1', 1).length, inA2andA3);
  assert.equal(M.devicesBeyond(p, 'row1', 3).length, 0);
  const before = p.devices.length;
  M.setRowRackCount(p, 'row1', 0);
  assert.equal(p.floors[0].rows[0].racks.length, 1, 'never fewer than one rack');
  assert.equal(p.devices.length, before - inA2andA3);
});

test('canPlace keeps devices inside the rack type’s units', () => {
  const p = project();
  assert.ok(M.canPlace(p, 'storage-node', { rack: 'r1', kind: 'u', at: 44 }).ok);
  assert.ok(!M.canPlace(p, 'storage-node', { rack: 'r1', kind: 'u', at: 45 }).ok);
  assert.ok(M.canPlace(p, 'switch-rj45', { rack: 'r1', kind: 'u', at: 47 }).ok);
  assert.ok(!M.canPlace(p, 'switch-rj45', { rack: 'r1', kind: 'u', at: 0 }).ok);
  assert.ok(!M.canPlace(p, 'switch-rj45', { rack: 'r1', kind: 'u', at: 1.5 }).ok);
  assert.ok(!M.canPlace(p, 'switch-rj45', { rack: 'nope', kind: 'u', at: 3 }).ok);
  assert.equal(M.setRackType(p, 'r2', 'rack-42'), null);
  assert.match(M.canPlace(p, 'switch-rj45', { rack: 'r2', kind: 'u', at: 43 }).reason, /U1–42/);
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

test('side slots take one 1U device each and follow the rack type', () => {
  const p = project([['switch-rj45', 'r1', 'side', 0]]);
  assert.ok(!M.canPlace(p, 'switch-qsfp', { rack: 'r1', kind: 'side', at: 0 }).ok);
  assert.ok(M.canPlace(p, 'switch-qsfp', { rack: 'r1', kind: 'side', at: 1 }).ok);
  assert.ok(!M.canPlace(p, 'switch-qsfp', { rack: 'r1', kind: 'side', at: 2 }).ok);
  assert.match(M.canPlace(p, 'compute-node', { rack: 'r2', kind: 'side', at: 0 }).reason, /1U/);
  assert.ok(M.canPlace(p, 'switch-qsfp', { rack: 'r1', kind: 'u', at: 47 }).ok, 'side slots don’t block rack units');
  const t = M.addRackType(p, { name: 'Open frame', units: 24, sideSlots: 0 });
  assert.equal(M.setRackType(p, 'r2', t.id), null);
  assert.match(M.canPlace(p, 'switch-qsfp', { rack: 'r2', kind: 'side', at: 0 }).reason, /no side slots/);
  assert.equal(M.maxSideSlots(47), 3);
  assert.equal(M.maxSideSlots(12), 0);
  assert.equal(M.cleanRackType({ units: 24, sideSlots: 4 }).sideSlots, 1, 'side slots are limited by the height');
});

test('planPositions stacks toward higher or lower unit numbers and skips occupied units', () => {
  const p = project([['switch-rj45', 'r1', 'u', 14]]);
  assert.deepEqual(M.planPositions(p, 'compute-node', 'r1', 10, 3, 1), [10, 12, 15]);
  assert.deepEqual(M.planPositions(p, 'compute-node', 'r1', 10, 3, -1), [10, 8, 6]);
  assert.deepEqual(M.planPositions(p, 'storage-node', 'r1', 40, 5, 1), [40, 44], 'stops at U47');
  assert.equal(M.planPositions(p, 'compute-node', 'r2', 1, Infinity, 1).length, 23);
  assert.deepEqual(M.planPositions(p, 'reserved', 'r1', 1, 2, 1, null, 8), [1, 15], 'reserved space uses its own height');
});

test('planSpread spreads devices evenly and overflows into racks with room', () => {
  const p = project([['storage-node', 'r2', 'u', 14]]);
  const plan = M.planSpread(p, 'compute-node', ['r1', 'r2', 'r3'], 10, 7, 1);
  assert.deepEqual(plan, [
    { rack: 'r1', at: 10 },
    { rack: 'r1', at: 12 },
    { rack: 'r1', at: 14 },
    { rack: 'r2', at: 10 },
    { rack: 'r2', at: 12 },
    { rack: 'r3', at: 10 },
    { rack: 'r3', at: 12 },
  ]);
  const full = M.planSpread(p, 'storage-node', ['r1', 'r2'], 40, 5, 1);
  assert.deepEqual(full, [
    { rack: 'r1', at: 40 },
    { rack: 'r1', at: 44 },
    { rack: 'r2', at: 40 },
    { rack: 'r2', at: 44 },
  ], 'fewer when the racks run out of space');
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

test('groups of devices move together', () => {
  const p = project([
    ['compute-node', 'r1', 'u', 10, 'a'],
    ['compute-node', 'r1', 'u', 12, 'b'],
    ['compute-node', 'r1', 'u', 16, 'c'],
    ['switch-rj45', 'r1', 'side', 0, 'side'],
    ['storage-node', 'r2', 'u', 12, 'blocker'],
  ]);
  assert.deepEqual(M.groupNudge(p, ['d1', 'd2'], 1), [
    { id: 'd1', loc: { rack: 'r1', kind: 'u', at: 11 } },
    { id: 'd2', loc: { rack: 'r1', kind: 'u', at: 13 } },
  ], 'a and b move down together');
  assert.equal(M.groupNudge(p, ['d2', 'd3'], -1)[0].loc.at, 8, 'b and c jump over a together');
  assert.deepEqual(M.groupNudge(p, ['d1', 'd2'], -1).map((m) => m.loc.at), [9, 11]);
  assert.equal(M.groupNudge(p, ['d4'], 1), null, 'side-slot devices don’t nudge');

  const right = M.shiftMoves(p, ['d1', 'd2', 'd4'], 1, 0);
  assert.deepEqual(right.map((m) => m.loc.rack), ['r2', 'r2', 'r2']);
  assert.match(M.canMoveAll(p, right).reason, /blocker/);
  assert.ok(M.canMoveAll(p, M.shiftMoves(p, ['d1', 'd4'], 1, 0)).ok);
  assert.equal(M.shiftMoves(p, ['d1'], -1, 0), null, 'no rack left of the first one');
  assert.ok(!M.canMoveAll(p, [
    { id: 'd1', loc: { rack: 'r3', kind: 'u', at: 1 } },
    { id: 'd2', loc: { rack: 'r3', kind: 'u', at: 2 } },
  ]).ok, 'moved devices are checked against each other');
});

test('copies of a group go below it, else above, else into the next rack', () => {
  const p = project([
    ['compute-node', 'r1', 'u', 10, 'cn-001'],
    ['compute-node', 'r1', 'u', 12, 'cn-002'],
    ['switch-rj45', 'r1', 'side', 0, 'sw-side'],
  ]);
  assert.deepEqual(M.copyTargets(p, ['d1', 'd2']), [
    { id: 'd1', loc: { rack: 'r1', kind: 'u', at: 14 } },
    { id: 'd2', loc: { rack: 'r1', kind: 'u', at: 16 } },
  ], 'right below, keeping the spacing');
  const withSide = M.copyTargets(p, ['d1', 'd3']);
  assert.deepEqual(withSide.find((m) => m.id === 'd3').loc, { rack: 'r1', kind: 'side', at: 1 }, 'the other side slot');

  // A full rack sends the copies to its neighbour, at the same height.
  const full = project([['storage-node', 'r1', 'u', 1, 'top'], ['storage-node', 'r1', 'u', 5, 'next']]);
  for (let u = 9; u + 3 <= 47; u += 4) full.devices.push(M.newDevice({ type: 'storage-node', name: `f${u}`, loc: { rack: 'r1', kind: 'u', at: u } }));
  assert.deepEqual(M.copyTargets(full, [full.devices[0].id, full.devices[1].id]).map((m) => m.loc), [
    { rack: 'r2', kind: 'u', at: 1 },
    { rack: 'r2', kind: 'u', at: 5 },
  ]);
  M.setRowRackCount(full, 'row1', 1);
  assert.equal(M.copyTargets(full, [full.devices[0].id]), null, 'no room anywhere');
});

test('racks, rows and floors can be duplicated with their devices', () => {
  const p = M.createExampleProject();
  const before = p.devices.length;
  const rack = M.duplicateRack(p, 'r1');
  const row = p.floors[0].rows[0];
  assert.deepEqual(row.racks.map((r) => r.id).slice(0, 3), ['r1', rack.id, 'r2'], 'right after the original');
  assert.equal(rack.name, 'Rack A04');
  assert.equal(rack.type, 'rack-47');
  const copies = M.devicesWithin(p, rack.id);
  assert.equal(copies.length, M.devicesWithin(p, 'r1').length);
  assert.deepEqual(copies.slice(0, 3).map((d) => [d.name, d.loc.kind, d.loc.at]), [['sw-mgmt-a04', 'u', 1], ['ib-leaf-a04', 'u', 2], ['cn-013', 'u', 4]]);
  assert.equal(M.layoutProblem(p), null);

  const row2 = M.duplicateRow(p, 'row2');
  assert.equal(p.floors[0].rows[2], row2, 'after Row B');
  assert.equal(row2.name, 'Row C');
  assert.deepEqual(row2.racks.map((r) => [r.name, r.type]), [['Rack C01', 'rack-48'], ['Rack C02', 'rack-48'], ['Rack C03', 'rack-48']]);
  assert.equal(M.devicesWithin(p, row2.id).length, M.devicesWithin(p, 'row2').length);
  assert.ok(M.devicesWithin(p, row2.id).some((d) => d.type === 'reserved' && d.height === 8));

  const floor = M.duplicateFloor(p, 'f2');
  assert.equal(floor.name, 'First floor (copy)');
  assert.deepEqual(floor.rows.map((r) => r.racks.map((k) => k.name)), [['Rack 3A01', 'Rack 3A02']]);
  assert.equal(M.devicesWithin(p, floor.id).length, M.devicesWithin(p, 'f2').length);
  assert.equal(new Set(p.devices.map((d) => d.id)).size, p.devices.length, 'new ids');
  assert.equal(new Set(p.devices.map((d) => d.name)).size, p.devices.length, 'new names');
  assert.equal(new Set(M.structureIds(p)).size, M.structureIds(p).size);
  assert.equal(M.layoutProblem(p), null);
  assert.ok(p.devices.length > before);

  const small = M.createEmptyProject(16);
  assert.equal(M.duplicateRack(small, 'r1'), null, 'a full row takes no copy');
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

  const copies = M.copiesAt(p, [
    { id: 'd1', loc: { rack: 'r2', kind: 'u', at: 1 } },
    { id: 'd2', loc: { rack: 'r2', kind: 'u', at: 3 } },
  ]);
  assert.deepEqual(copies.map((c) => [c.name, c.type, c.loc.rack, c.loc.at]), [['cn-003', 'compute-node', 'r2', 1], ['cn-004', 'compute-node', 'r2', 3]]);
  assert.ok(copies.every((c) => !M.deviceById(p, c.id)), 'new ids');
  assert.equal(p.devices.length, 2, 'the plan is left as it is');
});

test('slugs are plain ASCII words joined by dashes', () => {
  assert.equal(M.slug('Hall 2 expansion'), 'hall-2-expansion');
  assert.equal(M.slug('  Halle Süd (Rév. 3)! '), 'halle-sud-rev-3');
  assert.equal(M.slug('Compute node, series 2', 20), 'compute-node-series', 'no dash left at the cut');
  assert.equal(M.slug('机房'), '');
  assert.equal(M.cleanDeviceType({ label: 'Résumé server' }).defaultName, 'resume-server-01');
  assert.equal(M.cleanDeviceType({ label: '机房' }).defaultName, 'dev-01');
});

test('suggestPlacement continues the nearest series and reuses its cluster', () => {
  const p = M.createExampleProject();
  assert.deepEqual(M.suggestPlacement(p, 'compute-node', { rack: 'r1', kind: 'u', at: 30 }), { name: 'cn-013', cluster: 'c-kestrel' });
  assert.deepEqual(M.suggestPlacement(p, 'compute-node', { rack: 'r2', kind: 'u', at: 20 }, 4), { name: 'gpu-009', cluster: 'c-osprey' });
  const empty = M.createEmptyProject();
  assert.deepEqual(M.suggestPlacement(empty, 'storage-enclosure', null), { name: 'jbod-01', cluster: undefined });
  assert.equal(M.suggestName(empty, 'compute-node', 3), 'cn-001');
  assert.equal(M.suggestName(empty, 'reserved'), 'reserved-01');
});

test('the example plan is valid and spans floors, rows and custom types', () => {
  const p = M.createExampleProject();
  assert.equal(M.layoutProblem(p), null);
  for (const d of p.devices) assert.ok(M.canPlace(p, d.type, d.loc, d.id, d.height).ok, d.name);
  assert.equal(p.floors.length, 2);
  assert.equal(M.allRows(p).length, 3);
  assert.equal(M.devicesWithin(p, 'row1').length, 37, 'row A keeps the original layout');
  assert.ok(p.devices.some((d) => d.type === 'reserved'));
  assert.ok(p.devices.some((d) => d.type === 'gpu-server'));
  assert.equal(M.rackUnits(p, 'r7'), 42);
  assert.ok(M.isPristineExample(p));
  assert.ok(M.isPristineExample(Object.assign(M.clone(p), { meta: {} })), 'the notice flag does not count');
  p.devices[5].name = 'renamed';
  assert.ok(!M.isPristineExample(p));
  assert.ok(!M.isPristineExample(M.createEmptyProject()));
});

test('rack stats report space, reserved units, power and weight against budgets', () => {
  const p = project([
    ['storage-node', 'r1', 'u', 1],
    ['compute-node', 'r1', 'u', 40, 'cn', { powerW: 1000 }],
    ['switch-rj45', 'r1', 'side', 1],
    ['reserved', 'r1', 'u', 10, 'future', { height: 5, powerW: 3000 }],
  ]);
  assert.deepEqual(M.rackStats(p, 'r1'), {
    units: 47,
    used: 6,
    reserved: 5,
    free: 36,
    largestFree: 25,
    sideUsed: 1,
    sideSlots: 2,
    count: 3,
    powerW: 900 + 1000 + 150 + 3000,
    powerBudgetW: 12000,
    weightKg: 40 + 25 + 6,
    weightBudgetKg: 1200,
    overPower: false,
    overWeight: false,
  });
  M.updateRackType(p, 'rack-47', { powerW: 5000 });
  assert.ok(M.rackStats(p, 'r1').overPower);
  const all = M.statsByRack(p);
  assert.equal(all.size, 3);
  const row = M.statsWithin(p, 'row1', all);
  assert.equal(row.racks, 3);
  assert.equal(row.units, 141);
  assert.equal(row.overPower, 1);
  assert.equal(M.powerOf(p, M.deviceById(p, 'd1')), 900, 'type default');
  assert.equal(M.powerOf(p, M.deviceById(p, 'd2')), 1000, 'per-device override');
});

test('device types can be added, changed and deleted', () => {
  const p = project([['compute-node', 'r1', 'u', 1, 'cn-1'], ['compute-node', 'r1', 'u', 3, 'cn-2']]);
  const gpu = M.addDeviceType(p, M.TYPE_TEMPLATES[1]);
  assert.equal(gpu.id, 't1');
  assert.equal(gpu.label, 'GPU server');
  assert.equal(M.addDeviceType(p, M.TYPE_TEMPLATES[1]).label, 'GPU server 2', 'labels stay unique');
  assert.equal(M.updateDeviceType(p, gpu.id, { height: 8, face: 'bogus', powerW: -5 }), null);
  assert.deepEqual([gpu.id, M.typeOf(p, gpu.id).height, M.typeOf(p, gpu.id).face, M.typeOf(p, gpu.id).powerW], ['t1', 8, 'generic', 0]);
  assert.match(M.updateDeviceType(p, 'compute-node', { height: 3 }), /overlap/);
  assert.equal(M.typeOf(p, 'compute-node').height, 2, 'refused changes leave the type alone');
  M.deleteDeviceType(p, 'compute-node');
  assert.equal(p.devices.length, 0, 'its devices go with it');
  assert.equal(M.cleanDeviceType({ height: 99 }).height, 20);
  assert.equal(M.formatTypeSpec(M.typeOf(p, 'switch-rj45')), '1U · 48 × RJ45');
  assert.equal(M.formatTypeSpec(M.RESERVED, 3), '3U · placeholder');
  assert.equal(M.formatTypeSpec(M.RESERVED), 'any height · placeholder');
});

test('catalogs can be reordered; new rows use the first rack type', () => {
  const p = M.createEmptyProject();
  assert.ok(M.moveDeviceType(p, 'storage-enclosure', 0));
  assert.deepEqual(p.deviceTypes.map((t) => t.id), ['storage-enclosure', 'switch-rj45', 'switch-qsfp', 'compute-node', 'storage-node']);
  assert.ok(M.moveDeviceType(p, 'switch-rj45', 99), 'clamped to the end');
  assert.equal(p.deviceTypes[4].id, 'switch-rj45');
  assert.ok(!M.moveDeviceType(p, 'switch-rj45', 4), 'no change');
  assert.ok(!M.moveDeviceType(p, 'nope', 0));
  assert.deepEqual(M.placeableTypes(p).map((t) => t.id).slice(-2), ['switch-rj45', 'reserved'], 'reserved space stays last');

  assert.ok(M.moveRackType(p, 'rack-42', 0));
  assert.deepEqual(p.rackTypes.map((t) => t.id), ['rack-42', 'rack-47', 'rack-48']);
  const row = M.addRow(p, 'f1', { racks: 2 });
  assert.deepEqual(row.racks.map((r) => r.type), ['rack-42', 'rack-42']);
  M.setRackType(p, row.racks[1].id, 'rack-48');
  assert.equal(M.addRack(p, row.id).type, 'rack-48', 'a new rack still takes its neighbour’s type');
  assert.equal(M.addRack(p, 'row1').type, 'rack-47');
});

test('rack types refuse changes that would push devices out', () => {
  const p = project([['compute-node', 'r1', 'u', 44, 'low'], ['switch-rj45', 'r2', 'side', 1, 'side']]);
  assert.match(M.updateRackType(p, 'rack-47', { units: 42 }), /low would stick out/);
  assert.equal(M.rackUnits(p, 'r1'), 47);
  assert.match(M.updateRackType(p, 'rack-47', { sideSlots: 1 }), /side slot/);
  assert.equal(M.updateRackType(p, 'rack-47', { units: 45, name: 'Tall' }), null);
  assert.equal(M.rackTypeById(p, 'rack-47').name, 'Tall');
  assert.match(M.deleteRackType(p, 'rack-47'), /3 racks use/);
  assert.equal(M.deleteRackType(p, 'rack-42'), null);
  assert.equal(M.setRackType(p, 'r1', 'rack-48'), null);
});

test('search finds floors, rows, racks and devices by any field', () => {
  const p = M.createExampleProject();
  M.deviceById(p, 'ex-9').serial = 'SN-4711';
  const r = M.search(p, 'row a');
  assert.deepEqual(r.rows.map((x) => x.detail), ['Ground floor · 3 racks', 'First floor · 2 racks']);
  assert.deepEqual(M.search(p, 'first').floors.map((x) => x.name), ['First floor']);
  assert.deepEqual(M.search(p, 'b02').racks.map((x) => x.name), ['Rack B02']);
  const sn = M.search(p, 'sn-4711');
  assert.deepEqual(sn.devices.map((x) => x.name), ['cn-001']);
  assert.equal(sn.devices[0].detail, 'Ground floor · Row A · Rack A01 · U4–5');
  assert.equal(M.search(p, 'heron gpu').counts.devices, 7, 'every word must match: GPU servers of Heron AI and the reserved batch');
  assert.equal(M.search(p, '').counts.devices, 0);
  const match = M.deviceMatcher(p, 'kestrel');
  assert.equal(p.devices.filter(match).length, 12, 'cluster names count');
});

test('layoutProblem finds devices that don’t fit', () => {
  const p = project([['compute-node', 'r1', 'u', 1, 'a'], ['compute-node', 'r1', 'u', 2, 'b']]);
  assert.match(M.layoutProblem(p), /b would overlap a in Rack A01/);
  assert.equal(M.layoutProblem(p, new Set(['r2'])), null);
});
