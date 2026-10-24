'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');

function project(devices) {
  const p = M.createEmptyProject();
  p.views[0].clusters.push({ id: 'c1', name: 'Alpha', color: '#2f6fdb' });
  let n = 0;
  for (const [type, rack, kind, at, name, extra] of devices || []) {
    p.devices.push(M.newDevice(Object.assign({ id: `d${++n}`, type, name: name || `dev-${n}`, loc: { rack, kind, at } }, extra)));
  }
  return p;
}

test('a new plan has one floor with one row of three 47U racks and the standard catalog', () => {
  const p = M.createEmptyProject();
  assert.equal(p.version, 5);
  assert.deepEqual(p.floors, [
    {
      id: 'f1',
      name: 'Floor 1',
      rowPitchM: 3,
      rows: [
        {
          id: 'row1',
          name: 'Row A',
          racks: [
            { id: 'r1', name: 'Rack A01', type: 'rack-47', trayM: null, slackM: null },
            { id: 'r2', name: 'Rack A02', type: 'rack-47', trayM: null, slackM: null },
            { id: 'r3', name: 'Rack A03', type: 'rack-47', trayM: null, slackM: null },
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

test('names of types are put in the plural inside a sentence', () => {
  const cases = {
    '48-port switch': '48-port switches',
    'Compute node': 'compute nodes',
    'Storage enclosure': 'storage enclosures',
    PDU: 'PDUs',
    'GPU server': 'GPU servers',
    '1U server': '1U servers',
    '32-port 400G switch': '32-port 400G switches',
    'Patch box': 'patch boxes',
    'Battery': 'batteries',
    'Relay': 'relays',
  };
  for (const [name, many] of Object.entries(cases)) assert.equal(M.pluralName(name), many, name);
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

test('new floors, rows, racks, views and types get ids that a delete never gives out again', () => {
  const p = project([['compute-node', 'r1', 'u', 1, 'cn-1']]);
  const C = require('../js/cabling.js');
  const seen = new Set(['f1', 'row1', 'r1', 'r2', 'r3', 'v1']);
  const kinds = [
    ['f', () => M.addFloor(p, { racks: 1 }), (x) => M.removeFloor(p, x.id)],
    ['row', () => M.addRow(p, 'f1', { racks: 1 }), (x) => M.removeRow(p, x.id)],
    ['r', () => M.addRack(p, 'row1'), (x) => M.removeRack(p, x.id)],
    ['v', () => M.addView(p, ''), (x) => M.removeView(p, x.id)],
    ['t', () => M.addDeviceType(p, M.TYPE_TEMPLATES[0]), (x) => M.deleteDeviceType(p, x.id)],
    ['rt', () => M.addRackType(p, { name: 'Custom rack', units: 42 }), (x) => M.deleteRackType(p, x.id)],
    ['ct', () => C.addCableType(p, {}), (x) => C.deleteCableType(p, x.id)],
    ['tr', () => C.addTransceiver(p, {}), (x) => C.deleteTransceiver(p, x.id)],
  ];
  for (const [prefix, add, remove] of kinds) {
    for (let i = 0; i < 3; i++) {
      const x = add();
      assert.match(x.id, new RegExp(`^${prefix}-[0-9a-z]+$`));
      assert.ok(x.id.length - prefix.length <= 17, 'as long as the ids of devices and cables');
      assert.ok(!seen.has(x.id), `${x.id} is new`);
      seen.add(x.id);
      assert.ok(remove(x) !== false);
    }
  }
  // Floors, rows and racks added in one go, and copies.
  const floor = M.addFloor(p, { racks: 3 });
  const ids = [floor.id, floor.rows[0].id].concat(floor.rows[0].racks.map((r) => r.id));
  const copy = M.duplicateRow(p, floor.rows[0].id);
  ids.push(copy.id, ...copy.racks.map((r) => r.id));
  assert.equal(new Set(ids.concat([...seen])).size, ids.length + seen.size);
  // The first floor of a new plan, and the example, keep their fixed ids.
  assert.deepEqual(M.allRacks(M.createEmptyProject(2)).map((r) => [r.floor.id, r.row.id, r.rack.id]), [['f1', 'row1', 'r1'], ['f1', 'row1', 'r2']]);
  assert.deepEqual(M.createExampleProject(), M.createExampleProject());
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

test('planSideSlots fills free side slots from the one picked, then over the racks given', () => {
  // Rack A02 (r2) has two free side slots, A01 and A03 one each (V2), B01 (r4) none.
  const p = M.createExampleProject();
  assert.deepEqual(M.planSideSlots(p, 'pdu', ['r2'], 1, 2), [
    { rack: 'r2', at: 1 },
    { rack: 'r2', at: 0 },
  ]);
  assert.deepEqual(M.planSideSlots(p, 'pdu', ['r1', 'r2', 'r3'], 0, 3), [
    { rack: 'r1', at: 1 },
    { rack: 'r2', at: 0 },
    { rack: 'r3', at: 1 },
  ]);
  assert.deepEqual(M.planSideSlots(p, 'pdu', ['r4', 'r1', 'r2'], 0, 3), [
    { rack: 'r1', at: 1 },
    { rack: 'r2', at: 0 },
    { rack: 'r2', at: 1 },
  ], 'the others take the share of a full rack');
  assert.equal(M.planSideSlots(p, 'pdu', ['r4', 'r1', 'r3'], 0, Infinity).length, 2, 'fewer when the side slots are full');
});

test('namesAt gives each new device the code of its rack', () => {
  const p = M.createExampleProject();
  assert.deepEqual(M.namesAt(p, 'pdu-a01-a', 'r1', ['r1', 'r1', 'r2', 'r3']), ['pdu-a01-a', 'pdu-a01-b', 'pdu-a02-a', 'pdu-a03-a']);
  assert.deepEqual(M.namesAt(p, 'pdu-a02-a', 'r2', ['r1', 'r2', 'r2']), ['pdu-a01-a', 'pdu-a02-a', 'pdu-a02-b'], 'the name given is for its own rack');
  assert.deepEqual(M.namesAt(p, 'pdu-b03-c', 'r6', ['r6', 'r6']), ['pdu-b03-c', 'pdu-b03-d']);
  assert.deepEqual(M.namesAt(p, 'cn-a01-01', 'r1', ['r1', 'r1', 'r2']), ['cn-a01-01', 'cn-a01-02', 'cn-a02-01']);
  assert.deepEqual(M.namesAt(p, 'cn-013', 'r1', ['r1', 'r2', 'r2']), ['cn-013', 'cn-014', 'cn-015'], 'names without a code count on');
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

test('firstFreeLoc finds the topmost free units, rack by rack, and side slots last', () => {
  const p = project([
    ['compute-node', 'r1', 'u', 1],
    ['compute-node', 'r1', 'u', 4],
  ]);
  assert.deepEqual(M.firstFreeLoc(p, 'compute-node', ['r1', 'r2']), { rack: 'r1', kind: 'u', at: 6 }, 'U3 has room for 1U only');
  assert.deepEqual(M.firstFreeLoc(p, 'switch-rj45', ['r1']), { rack: 'r1', kind: 'u', at: 3 }, 'units before side slots');
  assert.deepEqual(M.firstFreeLoc(p, 'reserved', ['r1'], 6), { rack: 'r1', kind: 'u', at: 6 }, 'with the height of reserved space');
  const full = project([['reserved', 'r1', 'u', 1, 'all', { height: 47 }]]);
  assert.deepEqual(M.firstFreeLoc(full, 'compute-node', ['r1', 'r2']), { rack: 'r2', kind: 'u', at: 1 }, 'the next rack');
  assert.deepEqual(M.firstFreeLoc(full, 'switch-rj45', ['r1']), { rack: 'r1', kind: 'side', at: 0 }, 'a side slot when the units are full');
  assert.equal(M.firstFreeLoc(full, 'compute-node', ['r1']), null);
  assert.deepEqual(M.firstFreeLoc(p, 'switch-rj45', ['r1'], undefined, true), { rack: 'r1', kind: 'side', at: 0 }, 'side slots first when preferred');
  const sides = project([
    ['switch-rj45', 'r1', 'side', 0],
    ['switch-rj45', 'r1', 'side', 1],
  ]);
  assert.deepEqual(M.firstFreeLoc(sides, 'switch-rj45', ['r1', 'r2'], undefined, true), { rack: 'r2', kind: 'side', at: 0 }, 'the next rack’s side slot');
  assert.deepEqual(M.firstFreeLoc(sides, 'switch-rj45', ['r1'], undefined, true), { rack: 'r1', kind: 'u', at: 1 }, 'units when no side slot is free');
});

test('prefersSideSlot: PDUs and the 1U types the plan puts in side slots', () => {
  const p = project([
    ['switch-rj45', 'r1', 'side', 0],
    ['switch-qsfp', 'r1', 'u', 1],
  ]);
  p.deviceTypes.push(Object.assign({}, M.typeOf(p, 'switch-rj45'), { id: 'pdu', label: 'PDU', face: 'pdu' }));
  assert.equal(M.prefersSideSlot(p, 'pdu'), true, 'a PDU');
  assert.equal(M.prefersSideSlot(p, 'switch-rj45'), true, 'its devices are in side slots');
  assert.equal(M.prefersSideSlot(p, 'switch-qsfp'), false, 'its devices are in units');
  assert.equal(M.prefersSideSlot(p, 'compute-node'), false, '2U');
  p.devices.push(M.newDevice({ id: 'd3', type: 'pdu', name: 'pdu-h', loc: { rack: 'r2', kind: 'u', at: 1 } }));
  assert.equal(M.prefersSideSlot(p, 'pdu'), false, 'a PDU the plan puts in units');
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

test('copies leave out the serial number, asset tag and IP address of the original', () => {
  const fields = { serial: 'SN-123', asset: 'AT-9', ip: '10.0.0.5', owner: 'HPC team', notes: 'spare PSU' };
  const p = project([['compute-node', 'r1', 'u', 1, 'cn-001', fields]]);
  const [c] = M.copiesAt(p, [{ id: 'd1', loc: { rack: 'r1', kind: 'u', at: 3 } }]);
  assert.deepEqual([c.serial, c.asset, c.ip], ['', '', '']);
  assert.deepEqual([c.owner, c.notes], ['HPC team', 'spare PSU'], 'what the model shares is kept');
  assert.equal(p.devices[0].serial, 'SN-123', 'the original keeps its own');
  p.devices.push(c);
  // Every duplicate goes through copiesAt: a rack, a row and a floor too.
  M.duplicateRack(p, 'r1');
  M.duplicateRow(p, 'row1');
  M.duplicateFloor(p, 'f1');
  assert.equal(p.devices.length, 16);
  assert.deepEqual(p.devices.filter((d) => d.serial || d.asset || d.ip).map((d) => d.id), ['d1']);
  assert.deepEqual(M.repeatedFields(p), []);
});

test('repeatedFields finds serial numbers, asset tags and IP addresses on more than one device', () => {
  const p = project([
    ['compute-node', 'r1', 'u', 1, 'cn-001', { serial: 'SN-1', ip: '10.0.0.5', owner: 'HPC' }],
    ['compute-node', 'r1', 'u', 3, 'cn-002', { serial: ' sn-1 ', asset: 'AT-1', ip: '10.0.0.6', owner: 'HPC' }],
    ['compute-node', 'r1', 'u', 5, 'cn-003', { asset: 'AT-2', ip: '10.0.0.5' }],
    ['compute-node', 'r1', 'u', 7, 'cn-004', { ip: '10.0.0.5' }],
  ]);
  const [a, b, c, d] = p.devices;
  const shown = (list) => list.map((r) => [r.key, r.label, r.value, r.devices.map((x) => x.name)]);
  assert.deepEqual(shown(M.repeatedFields(p)), [
    ['serial', 'Serial number', 'SN-1', ['cn-001', 'cn-002']],
    ['ip', 'IP address', '10.0.0.5', ['cn-001', 'cn-003', 'cn-004']],
  ], 'case and spaces around a value aside; an owner is shared on purpose');
  assert.deepEqual(shown(M.repeatedFields(p, b)), [['serial', 'Serial number', 'SN-1', ['cn-001', 'cn-002']]]);
  assert.deepEqual(M.repeatedFields(p, d).map((r) => r.key), ['ip']);
  c.ip = '';
  d.ip = '10.0.0.7';
  a.serial = 'SN-0';
  assert.deepEqual(M.repeatedFields(p), []);
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

test('takenNames finds names other devices have; nextInSeries passes over them', () => {
  const p = project([
    ['compute-node', 'r1', 'u', 1, 'cn-001'],
    ['compute-node', 'r1', 'u', 3, 'cn-002'],
    ['compute-node', 'r1', 'u', 5, 'cn-009'],
  ]);
  assert.deepEqual(M.takenNames(p, ['cn-001', 'cn-002', 'cn-003', 'cn-001']), ['cn-001', 'cn-002']);
  assert.deepEqual(M.takenNames(p, ['cn-001', 'cn-002'], ['d1', 'd2']), [], 'the devices renamed keep no name');
  assert.equal(M.nextInSeries(p, 'cn-001', 3, false), 'cn-010');
  assert.equal(M.nextInSeries(p, 'cn-001', 3, false, ['d3']), 'cn-003');
});

test('a new switch is mounted back to front so that its ports face the rear', () => {
  const p = M.createEmptyProject();
  const type = (id) => M.typeOf(p, id);
  assert.equal(M.portsSide(type('switch-rj45')), 'front');
  assert.equal(M.portsSide(type('compute-node')), 'rear');
  assert.equal(M.portsSide(M.cleanDeviceType({ label: 'Box', ports: [] })), null);
  assert.equal(M.mountsReversed(type('switch-rj45')), true);
  assert.equal(M.mountsReversed(type('compute-node')), false);
  assert.equal(M.mountsReversed(type('reserved')), false);
});

test('overBudgetWith finds the racks that new devices put over a budget', () => {
  const p = M.createExampleProject();
  const gpu = M.newDevice({ type: 'gpu-server', loc: { rack: 'r1', kind: 'u', at: 30 } });
  const [over] = M.overBudgetWith(p, [gpu]);
  assert.equal(over.rack.name, 'Rack A01');
  assert.equal(over.stats.overPower, true);
  assert.equal(over.stats.powerW, M.rackStats(p, 'r1').powerW + 3000);
  assert.deepEqual(M.overBudgetWith(p, [Object.assign({}, gpu, { powerW: 100 })]), [], 'its own power counts');
  const cn = p.devices.find((d) => d.name === 'cn-001');
  assert.deepEqual(M.overBudgetWith(p, [gpu], [cn.id]), [], 'a device moved out is not counted');
  assert.equal(p.devices.includes(gpu), false, 'the plan is left as it is');
});

test('suggestPlacement continues the nearest series and reuses its cluster', () => {
  const p = M.createExampleProject();
  const v = p.views[0].id;
  assert.deepEqual(M.suggestPlacement(p, 'compute-node', { rack: 'r1', kind: 'u', at: 30 }), { name: 'cn-013', cluster: 'c-kestrel', groups: { [v]: 'c-kestrel' }, from: 'cn-012' });
  assert.deepEqual(M.suggestPlacement(p, 'compute-node', { rack: 'r2', kind: 'u', at: 20 }, 4), { name: 'gpu-009', cluster: 'c-osprey', groups: { [v]: 'c-osprey' }, from: 'gpu-008' });
  const empty = M.createEmptyProject();
  assert.deepEqual(M.suggestPlacement(empty, 'storage-enclosure', null), { name: 'jbod-01', cluster: undefined, groups: {}, from: null });
  assert.equal(M.suggestName(empty, 'compute-node', 3), 'cn-001');
  assert.equal(M.suggestName(empty, 'reserved'), 'reserved-01');
});

test('suggestPlacement takes a device of the same row first and the rack code of the target', () => {
  const p = M.createExampleProject();
  // PDUs are in Row B only: one in Rack A01 takes the code A01, not B04, and starts at a.
  assert.equal(M.suggestPlacement(p, 'pdu', { rack: 'r1', kind: 'side', at: 1 }).name, 'pdu-a01-a');
  // In Rack B02, its neighbours in B02 come first; the letter counts up after the code.
  assert.equal(M.suggestPlacement(p, 'pdu', { rack: 'r5', kind: 'side', at: 1 }).name, 'pdu-b02-c');
  // In a row of its own, the code of the rack counts no further.
  assert.equal(M.nameInRack(p, 'sw-mgmt-a01', 'r1', 'r1', 1), 'sw-mgmt-a01-2');
  assert.equal(M.nameInRack(p, 'sw-mgmt-a01', 'r1', 'r3', 1), 'sw-mgmt-a03-2', 'sw-mgmt-a03 is taken');
  // A number after the code counts on; names without a code are as before.
  assert.equal(M.nameInRack(p, 'cn-a01-07', 'r1', 'r2', 1), 'cn-a02-07');
  assert.equal(M.nameInRack(p, 'cn-012', 'r1', 'r2', 1), 'cn-013');

  const q = project([
    ['compute-node', 'r1', 'u', 1, 'cn-a01-01'],
    ['compute-node', 'r3', 'u', 1, 'cn-a03-01'],
  ]);
  q.floors[0].rows.push({ id: 'row2', name: 'Row B', racks: [{ id: 'r9', name: 'Rack B01', type: 'rack-47', trayM: null, slackM: null }] });
  q.devices.push(M.newDevice({ id: 'd9', type: 'compute-node', name: 'cn-b01-01', loc: { rack: 'r9', kind: 'u', at: 1 } }));
  // The nearest rack of the row, not the device added last in another row.
  assert.equal(M.suggestPlacement(q, 'compute-node', { rack: 'r2', kind: 'u', at: 5 }).name, 'cn-a02-01');
  // Rack codes of digits or letters only are not taken for codes.
  q.floors[0].rows[0].racks[0].name = '01';
  assert.equal(M.nameInRack(q, 'cn-01', 'r1', 'r2', 1), 'cn-02');
});

test('a copy takes the code of its rack into the name', () => {
  const p = M.createExampleProject();
  const pdu = p.devices.find((d) => d.name === 'pdu-b01-b');
  const [c] = M.copiesAt(p, [{ id: pdu.id, loc: { rack: 'r1', kind: 'side', at: 1 } }]);
  assert.equal(c.name, 'pdu-a01-b');
  const [same] = M.copiesAt(p, [{ id: pdu.id, loc: { rack: pdu.loc.rack, kind: 'u', at: 40 } }]);
  assert.equal(same.name, 'pdu-b01-c', 'in its own rack, the code stays');
  const cn = p.devices.find((d) => d.name === 'cn-012');
  assert.equal(M.copiesAt(p, [{ id: cn.id, loc: { rack: 'r2', kind: 'u', at: 40 } }])[0].name, 'cn-013');
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
  assert.match(gpu.id, /^t-[0-9a-z]+$/, 'a random id');
  assert.equal(gpu.label, 'GPU server');
  assert.equal(M.addDeviceType(p, M.TYPE_TEMPLATES[1]).label, 'GPU server 2', 'labels stay unique');
  assert.equal(M.updateDeviceType(p, gpu.id, { height: 8, face: 'bogus', powerW: -5 }), null);
  assert.deepEqual([gpu.id, M.typeOf(p, gpu.id).height, M.typeOf(p, gpu.id).face, M.typeOf(p, gpu.id).powerW], [gpu.id, 8, 'generic', 0]);
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

// ------------------------------------------------------------------ cabling

const C = require('../js/cabling.js');
const ends = (p, c) => M.cableEnds(c).map((x) => `${M.deviceById(p, x.end.device).name} ${x.end.port}`);
const labelsOf = (p) => p.cables.map((c) => c.label);

test('port groups are written as patterns and read back', () => {
  const groups = [
    { name: 'swp', first: 1, count: 48, connector: 'rj45' },
    { name: 'Ethernet1/', first: 1, count: 32, connector: 'qsfp28' },
    { name: '', first: 1, count: 24, connector: 'rj45' },
    { name: 'bmc', connector: 'rj45' },
    { name: 'eth', first: 7, connector: 'sfp+' },
  ].map(M.cleanPortGroup);
  assert.deepEqual(groups.map(M.portPattern), ['swp[1-48]', 'Ethernet1/[1-32]', '[1-24]', 'bmc', 'eth[7]']);
  for (const g of groups) assert.deepEqual(M.parsePortPattern(M.portPattern(g)), g.count ? { name: g.name, first: g.first, count: g.count } : { name: g.name });
  assert.deepEqual(M.parsePortPattern(' ib[0 – 3] '), { name: 'ib', first: 0, count: 4 });
  for (const bad of ['', 'swp[4-1]', '[x]', 'a[1-2]b', 'a|b', '[1-2000]', 'x[1-2]]']) assert.equal(M.parsePortPattern(bad), null, bad);
  // Each refused pattern says why: a well-formed range over the limit is no syntax error.
  assert.equal(M.portPatternProblem('eth[1-2000]'), `A device type has at most ${M.LIMITS.ports} ports`);
  assert.equal(M.portPatternProblem('eth[1-1024]'), null);
  assert.match(M.portPatternProblem('swp[4-1]'), /counts down/);
  assert.match(M.portPatternProblem('p[10000]'), /up to 9999/);
  assert.match(M.portPatternProblem('a|b'), /“a\|b” isn’t a port name or a range/);
  assert.match(M.portPatternProblem('  '), /needs a name/);
  for (const ok of ['bmc', '[1-24]', ' ib[0 – 3] ']) assert.equal(M.portPatternProblem(ok), null, ok);

  assert.deepEqual(groups[3], { name: 'bmc', connector: 'rj45', speedGbps: 1, side: 'rear' }, 'a single port has no first or count');
  assert.deepEqual(groups[4], { name: 'eth', first: 7, count: 1, connector: 'sfp+', speedGbps: 10, side: 'rear' }, 'speed defaults to the connector’s');
  assert.deepEqual(M.groupNames({ name: 'p', count: 3 }), ['p1', 'p2', 'p3'], 'count without first counts from 1');
  assert.equal(M.cleanPortGroup({ name: 'x', connector: 'toslink' }), null, 'unknown connector');
  assert.equal(M.cleanPortGroup({ name: '', connector: 'rj45' }), null, 'a single port needs a name');
  assert.equal(M.cleanPortGroup({ name: 'a|b[1]', connector: 'rj45', side: 'front' }).name, 'ab1', 'characters used by keys and patterns are dropped');
});

test('portsProblem names what cleanPorts would drop', () => {
  const sw = (name, first, count) => ({ name, first, count, connector: 'rj45' });
  assert.equal(M.portsProblem([sw('swp', 1, 48), { name: 'bmc', connector: 'rj45' }]), null);
  assert.equal(M.portsProblem([]), null);
  assert.equal(M.portsProblem([sw('swp', 1, 4), sw('swp', 4, 2)]), 'Port swp4 is named twice');
  assert.equal(M.portsProblem([sw('swp', 1, 4), { name: 'swp2', connector: 'sfp+' }]), 'Port swp2 is named twice');
  assert.match(M.portsProblem([{ name: 'x', connector: 'toslink' }]), /needs a name/);
  assert.equal(M.portsProblem([sw('a', 1, 1000), sw('b', 1, 25)]), 'A device type has at most 1024 ports');
  assert.equal(M.portsProblem(Array.from({ length: 33 }, (_, i) => ({ name: `p${i}`, connector: 'rj45' }))), 'A device type has at most 32 port groups');
});

test('device types expand their ports and drop groups that clash or overflow', () => {
  const t = M.cleanDeviceType({
    label: 'Switch',
    ports: [
      { name: 'swp', first: 1, count: 4, connector: 'rj45', side: 'front' },
      { name: 'swp', first: 4, count: 2, connector: 'sfp+' }, // swp4 again
      { name: 'swp5', connector: 'sfp+' },
      { name: 'big', first: 1, count: 1024, connector: 'rj45' }, // past 1024 ports
      { name: 'mgmt0', connector: 'rj45', speedGbps: 0.1 },
    ],
    slackM: 99,
  });
  assert.deepEqual(t.ports.map(M.portPattern), ['swp[1-4]', 'swp5', 'mgmt0']);
  assert.equal(t.slackM, 10);
  assert.deepEqual(M.expandPorts(t).map((p) => [p.name, p.group, p.index, p.connector, p.side]), [
    ['swp1', 0, 0, 'rj45', 'front'],
    ['swp2', 0, 1, 'rj45', 'front'],
    ['swp3', 0, 2, 'rj45', 'front'],
    ['swp4', 0, 3, 'rj45', 'front'],
    ['swp5', 1, 0, 'sfp+', 'rear'],
    ['mgmt0', 2, 0, 'rj45', 'rear'],
  ]);
  const many = M.cleanDeviceType({ ports: Array.from({ length: 40 }, (_, i) => ({ name: `p${i}x`, connector: 'rj45' })) });
  assert.equal(many.ports.length, 32, 'at most 32 groups');
  assert.deepEqual(M.expandPorts(M.RESERVED), []);
  assert.equal(M.expandPorts(M.typeOf(M.createEmptyProject(), 'switch-rj45')).length, 52);
  assert.deepEqual(M.TYPE_TEMPLATES.map((x) => M.expandPorts(x).length), [3, 8, 0, 1, 1, 0, 0]);
});

test('connectors decide which plugs fit which ports', () => {
  assert.ok(M.plugFits('qsfp56', 'qsfp56'));
  assert.ok(M.plugFits('qsfp28', 'qsfp56'), 'same family');
  assert.ok(M.plugFits('sfp28', 'sfp+'));
  assert.ok(M.plugFits('qsfp56', 'qsfp-dd'), 'QSFP-DD cages take QSFP plugs');
  assert.ok(!M.plugFits('qsfp-dd', 'qsfp56'), 'but not the other way round');
  assert.ok(!M.plugFits('sfp28', 'qsfp56'));
  assert.ok(!M.plugFits('rj45', 'nope'));
  assert.deepEqual(M.CONNECTORS.filter((c) => c.cage).map((c) => c.id), ['sfp', 'sfp+', 'sfp28', 'sfp56', 'qsfp+', 'qsfp28', 'qsfp56', 'qsfp112', 'qsfp-dd', 'osfp']);
});

test('racks, floors and devices carry their length settings', () => {
  const p = M.createEmptyProject();
  assert.deepEqual(M.rackTypeById(p, 'rack-48'), { id: 'rack-48', name: '48U high-density rack', units: 48, sideSlots: 2, powerW: 20000, weightKg: 1500, widthMm: 800, depthMm: 1200, trayM: 0.5, slackM: 0.25 });
  assert.deepEqual([M.rackTrayM(p, 'r1'), M.rackSlackM(p, 'r1')], [0.5, 0.25], 'the rack type’s');
  Object.assign(M.rackById(p, 'r1'), { trayM: 1.2, slackM: 0 });
  assert.deepEqual([M.rackTrayM(p, 'r1'), M.rackSlackM(p, 'r1')], [1.2, 0], 'the rack’s own');
  assert.deepEqual(M.cleanRackType({ widthMm: 50, depthMm: 5000, trayM: -1, slackM: 'x' }), Object.assign(M.cleanRackType({}), { widthMm: 300, depthMm: 1600, trayM: 0 }));
  assert.equal(M.insertFloor(p).rowPitchM, 3);
  const d = M.newDevice({ type: 'compute-node' });
  assert.deepEqual([d.reversed, d.slackM, M.deviceSlackM(p, d)], [false, null, 0.3]);
  d.slackM = 1;
  assert.equal(M.deviceSlackM(p, d), 1);
  assert.equal(M.deviceSlackM(p, M.newDevice({ type: 'reserved' })), 0);
  const copy = M.duplicateRack(p, 'r1');
  assert.deepEqual([copy.trayM, copy.slackM], [1.2, 0], 'a copied rack keeps its settings');
  const row = M.duplicateRow(p, 'row1');
  assert.deepEqual([row.racks[0].trayM, row.racks[0].slackM], [1.2, 0], 'so do the racks of a copied row');
  p.floors[0].rowPitchM = 2.5;
  const floor = M.duplicateFloor(p, 'f1');
  assert.equal(floor.rowPitchM, 2.5, 'so does a copied floor');
  assert.deepEqual([floor.rows[0].racks[0].trayM, floor.rows[0].racks[0].slackM], [1.2, 0], 'and its racks');
});

test('the example is cabled without a refused state and with exactly the intended checks', () => {
  const p = M.createExampleProject();
  assert.equal(p.cables.length, 147);
  assert.deepEqual(p.networks.map((n) => n.name), ['Management', 'BMC', 'InfiniBand', 'Storage 25G', 'SAS']);
  assert.equal(new Set(p.cables.map((c) => c.id)).size, 147);
  assert.equal(new Set(labelsOf(p)).size, 147);
  const ctx = M.cableContext(Object.assign({}, p, { cables: [] }));
  for (const c of p.cables) {
    assert.equal(M.cableProblem(p, c, ctx), null, c.label);
    M.claimPorts(ctx, c);
  }
  assert.equal(M.pruneCables(M.clone(p)), 0, 'nothing to prune');
  const flagged = C.describeAll(p)
    .filter((d) => d.issues.length)
    .map((d) => [d.cable.label, ends(p, d.cable).join(' → '), d.issues.map((i) => `${i.code}: ${i.text}`)]);
  assert.deepEqual(flagged, [
    ['ST-0001', 'ceph-01 eth1 → sw-mgmt-a02 swp49', ['speed: Runs at 10 Gb/s, not 25 Gb/s: sw-mgmt-a02 swp49 is the slower end']],
    ['ST-0002', 'ceph-02 eth1 → sw-mgmt-a02 swp50', ['speed: Runs at 10 Gb/s, not 25 Gb/s: sw-mgmt-a02 swp50 is the slower end']],
    ['ST-0003', 'ceph-03 eth1 → sw-mgmt-a02 swp51', ['speed: Runs at 10 Gb/s, not 25 Gb/s: sw-mgmt-a02 swp51 is the slower end']],
    ['IB-0026', 'ceph-03 ib1 → ib-leaf-a03 p11', ['reach: Needs 4 m: a QSFP56 DAC reaches 3 m']],
  ]);
  const ex = (label) => p.cables.find((c) => c.label === label);
  assert.deepEqual(ends(p, ex('IB-0043')), ['ib-leaf-b02 p1', 'gpu-srv-01 ib0', 'gpu-srv-01 ib1'], 'breakouts from the leaf');
  assert.equal(C.describe(p, ex('MGT-0041')).lengthM, 30, 'the riser has its length set');
  assert.ok(M.deviceById(p, 'ex-1').reversed, 'switches are mounted back to front');
  assert.equal(M.typeOf(p, M.deviceById(p, 'ex-50').type).id, 'switch-osfp');
  assert.deepEqual(p.deviceTypes.map((t) => t.id).slice(0, 3), ['switch-rj45', 'switch-qsfp', 'switch-osfp']);
  assert.deepEqual(p.floors.map((f) => f.rowPitchM), [3, 2.4]);
});

test('deleting devices, racks, rows, floors and types removes their cables', () => {
  const p = M.createExampleProject();
  const total = p.cables.length;
  const byLabel = (label) => p.cables.find((c) => c.label === label);
  const drop = (name) => (p.devices = p.devices.filter((d) => d.name !== name));

  // A device: cn-001 has three cables.
  drop('cn-001');
  assert.equal(M.pruneCables(p), 3);
  assert.equal(p.cables.length, total - 3);

  // A breakout loses only its leg on a deleted device…
  const up = byLabel('IB-0055');
  assert.deepEqual(ends(p, up), ['ib-leaf-b02 p31', 'core-sw-01 p7', 'core-sw-02 p7']);
  drop('core-sw-02');
  assert.equal(M.pruneCables(p), 6 + 4, 'six cables from Row A go, four breakouts from Row B lose a leg');
  assert.equal(p.cables.length, total - 3 - 6, 'the six single cables to core-sw-02 go');
  assert.deepEqual(up.b.map((e) => e && e.port), ['p7', null]);
  // …and goes when it has none left, or loses its head.
  drop('core-sw-01');
  M.pruneCables(p);
  assert.ok(!p.cables.includes(up));
  const servers = byLabel('IB-0043');
  drop('ib-leaf-b02');
  M.pruneCables(p);
  assert.ok(!p.cables.includes(servers));

  // A rack, a floor, a row.
  const inR3 = C.cablesWithin(p, 'r3').length;
  assert.ok(inR3 > 0);
  const beforeRack = p.cables.length;
  M.removeRack(p, 'r3');
  assert.equal(p.cables.length, beforeRack - inR3);
  assert.ok(p.cables.every((c) => M.cableEnds(c).every((x) => M.deviceById(p, x.end.device))));
  const n = p.cables.length;
  M.removeFloor(p, 'f2');
  assert.equal(p.cables.length, n - 7, 'the archive and its riser');
  const inRow = C.cablesWithin(p, 'row1').length;
  const beforeRow = p.cables.length;
  assert.ok(inRow > 0 && inRow < beforeRow);
  M.removeRow(p, 'row1');
  assert.equal(p.cables.length, beforeRow - inRow, 'only the row’s cables go');
  assert.ok(p.cables.every((c) => M.cableEnds(c).every((x) => M.deviceById(p, x.end.device))));
  assert.equal(M.pruneCables(p), 0);

  // A device type.
  const q = M.createExampleProject();
  M.deleteDeviceType(q, 'storage-enclosure');
  assert.equal(q.cables.filter((c) => c.network === 'n-sas').length, 0, 'every SAS cable ends on an enclosure');
  assert.equal(q.cables.length, total - 12 - 4, 'and four enclosures were on the management network');

  // setRowRackCount removes the racks at the end, with their cables.
  const r = M.createExampleProject();
  const gone = new Set(C.cablesWithin(r, 'r5').concat(C.cablesWithin(r, 'r6')));
  assert.equal(gone.size, 28, 'six GPU servers × 4 cables and the four leaf uplink breakouts');
  M.setRowRackCount(r, 'row2', 1);
  assert.equal(r.cables.length, 147 - 28);
  assert.ok(r.cables.every((c) => M.cableEnds(c).every((x) => M.deviceById(r, x.end.device))));
  assert.ok(r.cables.some((c) => c.label === 'MGT-0030'), 'Row A uplinks stay');
});

test('pruning keeps the first cable on a port and clears lost networks', () => {
  const p = M.createExampleProject();
  const dupe = M.clone(p.cables[0]);
  dupe.id = 'dupe';
  p.cables.push(dupe);
  p.cables[1].network = 'gone';
  assert.equal(M.pruneCables(p), 2);
  assert.ok(!p.cables.some((c) => c.id === 'dupe'));
  assert.equal(p.cables[1].network, null);
  assert.equal(M.pruneCables({ devices: [], cables: [] }), 0);
});

test('duplicating devices, racks, rows and floors copies the cables between the copies', () => {
  const p = M.createExampleProject();
  const total = p.cables.length;
  const rack = M.duplicateRack(p, 'r1');
  const inside = (id) => p.cables.filter((c) => M.cableEnds(c).every((x) => M.deviceById(p, x.end.device).loc.rack === id));
  assert.equal(inside(rack.id).length, inside('r1').length, 'every cable within Rack A01 is copied');
  assert.equal(p.cables.length, total + inside('r1').length, 'cables to other racks are not');
  const copy = inside(rack.id).find((c) => ends(p, c)[0] === 'cn-013 eth0');
  assert.deepEqual(ends(p, copy), ['cn-013 eth0', 'sw-mgmt-a04 swp1']);
  assert.equal(copy.label, 'MGT-0042', 'labels continue their series');
  assert.notEqual(copy.id, p.cables[0].id);
  assert.equal(new Set(labelsOf(p)).size, p.cables.length);

  const n = p.cables.length;
  const row = M.duplicateRow(p, 'row2');
  const breakouts = p.cables.slice(n).filter((c) => Array.isArray(c.b));
  assert.equal(breakouts.length, 12 + 4, 'leaf breakouts to the servers and to the core switches');
  assert.ok(breakouts.every((c) => M.locateRack(p, M.deviceById(p, c.a.device).loc.rack).row.id === row.id));

  const m = p.cables.length;
  const floor = M.duplicateFloor(p, 'f2');
  assert.equal(p.cables.length - m, 6, 'the riser stays with the original floor');
  assert.ok(p.cables.slice(m).every((c) => M.cableEnds(c).every((x) => M.locateRack(p, M.deviceById(p, x.end.device).loc.rack).floor.id === floor.id)));
  assert.equal(M.pruneCables(M.clone(p)), 0, 'the copies are valid');
  assert.equal(new Set(labelsOf(p)).size, p.cables.length, 'labels stay unique');

  // copyCables on its own, with custom labels.
  const q = M.createExampleProject();
  const c0 = q.cables[0];
  c0.label = 'uplink';
  const moves = [{ id: c0.a.device, loc: { rack: 'r1', kind: 'u', at: 40 } }, { id: c0.b.device, loc: { rack: 'r1', kind: 'u', at: 47 } }];
  const copies = M.copiesAt(q, moves);
  q.devices.push(...copies);
  const made = M.copyCables(q, new Map(moves.map((mv, i) => [mv.id, copies[i].id])));
  assert.deepEqual(made.map((c) => c.label), ['uplink-2']);
  assert.equal(made[0].a.device, copies[0].id);
});

test('changing a device type’s ports keeps cables by group and place', () => {
  const p = M.createExampleProject();
  const sw = M.typeOf(p, 'switch-rj45');
  const old = M.clone(sw.ports);
  const renamed = [
    { name: 'ge-0/0/', first: 0, count: 48, connector: 'rj45', speedGbps: 1, side: 'front' },
    { name: 'xe-0/1/', first: 0, count: 2, connector: 'sfp+', speedGbps: 10, side: 'front' },
  ];
  const lost = C.portChangeImpact(p, 'switch-rj45', renamed);
  // swp51 and swp52 are places 3 and 4 of the second group, which now has two ports.
  assert.deepEqual(lost.map((c) => c.label), ['ST-0003', 'MGT-0030', 'MGT-0031', 'MGT-0032', 'MGT-0041']);
  const before = p.cables.length;
  assert.equal(M.updateDeviceType(p, 'switch-rj45', { ports: renamed }), null);
  assert.equal(p.cables.length, before - lost.length);
  const first = p.cables.find((c) => c.label === 'MGT-0001');
  assert.deepEqual(ends(p, first), ['cn-001 eth0', 'sw-mgmt-a01 ge-0/0/0'], 'swp1 was the first port of the first group');
  assert.ok(p.cables.some((c) => ends(p, c).includes('sw-mgmt-a02 xe-0/1/0')), 'swp49 became xe-0/1/0');
  assert.equal(M.pruneCables(M.clone(p)), 0);
  assert.equal(M.remapPorts(p, 'nope', old), 0);
  assert.deepEqual(C.portChangeImpact(p, 'switch-rj45', M.typeOf(p, 'switch-rj45').ports), [], 'no change, nothing lost');
  assert.deepEqual(C.portChangeMoves(p, 'switch-rj45', M.typeOf(p, 'switch-rj45').ports), [], 'nothing moves either');
  const q = M.createExampleProject();
  const moved = C.portChangeMoves(q, 'switch-rj45', renamed);
  assert.equal(moved.length, q.cables.filter((c) => M.cableEnds(c).some((x) => M.deviceById(q, x.end.device).type === 'switch-rj45')).length - lost.length, 'every other cable on these switches is on a renamed port');
  const mgt = moved.find((x) => x.cable.label === 'MGT-0001');
  assert.deepEqual(mgt.moves, [{ device: mgt.cable.b.device, from: 'swp1', to: 'ge-0/0/0' }]);
});

test('a port change that takes away a breakout’s leg names the cable and keeps its other leg', () => {
  const p = M.createExampleProject();
  const fewer = M.clone(M.typeOf(p, 'gpu-server').ports);
  const ib = fewer.findIndex((g) => g.name === 'ib');
  fewer[ib] = Object.assign({}, fewer[ib], { count: 3 });
  assert.deepEqual(C.portChangeImpact(p, 'gpu-server', fewer).map((c) => c.label), ['IB-0044', 'IB-0046', 'IB-0048', 'IB-0050', 'IB-0052', 'IB-0054']);
  assert.equal(M.updateDeviceType(p, 'gpu-server', { ports: fewer }), null);
  assert.equal(p.cables.length, 147, 'no cable goes');
  assert.deepEqual(p.cables.find((c) => c.label === 'IB-0044').b.map((e) => e && e.port), ['ib2', null]);
  assert.deepEqual(p.cables.find((c) => c.label === 'IB-0043').b.map((e) => e && e.port), ['ib0', 'ib1']);
});

test('adding or removing a port group leaves the other groups’ cables on their ports', () => {
  const at = (q, label, name) => {
    const d = q.devices.find((x) => x.name === name);
    const x = M.cableEnds(q.cables.find((c) => c.label === label)).find((e) => e.end.device === d.id);
    return x ? x.end.port : null;
  };
  const p = M.createExampleProject();
  const ports = M.clone(M.typeOf(p, 'compute-node').ports);
  const withEth1 = [{ name: 'eth1', connector: 'rj45', speedGbps: 1, side: 'rear' }].concat(ports);
  assert.deepEqual(C.portChangeImpact(p, 'compute-node', withEth1), []);
  assert.deepEqual(C.portChangeMoves(p, 'compute-node', withEth1), []);
  assert.equal(M.updateDeviceType(p, 'compute-node', { ports: withEth1 }), null);
  assert.deepEqual(['MGT-0001', 'BMC-0001', 'IB-0001'].map((l) => at(p, l, 'cn-001')), ['eth0', 'bmc', 'ib0']);
  const between = ports.slice(0, 2).concat([{ name: 'eth1', connector: 'sfp28', speedGbps: 25, side: 'rear' }], ports.slice(2));
  const r = M.createExampleProject();
  assert.equal(M.updateDeviceType(r, 'compute-node', { ports: between }), null);
  assert.deepEqual(['MGT-0001', 'BMC-0001', 'IB-0001'].map((l) => at(r, l, 'cn-001')), ['eth0', 'bmc', 'ib0'], 'a group inserted in between');

  const q = M.createExampleProject();
  const lost = C.portChangeImpact(q, 'compute-node', ports.slice(1));
  assert.equal(lost.length, 20);
  assert.ok(lost.every((c) => c.network === 'n-bmc'), 'exactly the BMC cables of the 20 compute nodes');
  assert.deepEqual(C.portChangeMoves(q, 'compute-node', ports.slice(1)), []);
  M.updateDeviceType(q, 'compute-node', { ports: ports.slice(1) });
  assert.deepEqual(['MGT-0001', 'IB-0001'].map((l) => at(q, l, 'cn-001')), ['eth0', 'ib0']);
  assert.ok(!q.cables.some((c) => c.label === 'BMC-0001'));

  // Groups reordered and one renamed in place; groups merged into one.
  assert.deepEqual([...M.portMoves(ports, [ports[2], { name: 'mgmt', connector: 'rj45' }, ports[0]])], [['bmc', 'bmc'], ['eth0', 'mgmt'], ['ib0', 'ib0']]);
  const two = [{ name: 'eth', first: 0, count: 2, connector: 'rj45' }, { name: 'eth2', connector: 'rj45' }];
  assert.deepEqual([...M.portMoves(two, [{ name: 'eth', first: 0, count: 3, connector: 'rj45' }])], [['eth0', 'eth0'], ['eth1', 'eth1'], ['eth2', 'eth2']]);
  // A group left over takes the place of another only when the plug fits.
  const ib = [ports[0], ports[1], { name: 'mgmt', connector: 'rj45', speedGbps: 1, side: 'rear' }];
  assert.deepEqual([...M.portMoves(ports, ib)], [['bmc', 'bmc'], ['eth0', 'eth0']], 'no InfiniBand cable in an RJ45 port');
  const dd = [ports[0], ports[1], { name: 'hdr0', connector: 'qsfp-dd', speedGbps: 400, side: 'rear' }];
  assert.deepEqual([...M.portMoves(ports, dd)].pop(), ['ib0', 'hdr0'], 'a QSFP plug fits a QSFP-DD cage');
  const s = M.createExampleProject();
  assert.equal(C.portChangeImpact(s, 'compute-node', ib).length, 20, 'the IB cables are named as unplugged');
  assert.deepEqual(C.portChangeMoves(s, 'compute-node', ib), [], 'not as moved');
  // Two groups of one name are told apart by their pattern.
  const sw = M.typeOf(q, 'switch-rj45').ports;
  assert.deepEqual([...M.portMoves(sw, [sw[0], Object.assign({}, sw[1], { count: 2 })])].slice(-3), [['swp48', 'swp48'], ['swp49', 'swp49'], ['swp50', 'swp50']]);
});

test('forEachPortRef visits each cable end and breakout leg once, as the object in the plan', () => {
  const p = M.createExampleProject();
  const seen = [];
  M.forEachPortRef(p, (ref, cable) => seen.push([ref, cable]));
  assert.equal(seen.length, p.cables.reduce((n, c) => n + M.cableEnds(c).length, 0));
  const breakout = p.cables.find((c) => Array.isArray(c.b));
  const visits = seen.filter(([, c]) => c === breakout).map(([ref]) => ref);
  assert.deepEqual(visits, [breakout.a].concat(breakout.b.filter(Boolean)), 'the head, then each leg');
  assert.ok(visits.every((ref) => typeof ref.device === 'string' && typeof ref.port === 'string'));
  // A rename through it changes the plan.
  M.forEachPortRef(p, (ref) => {
    if (ref === breakout.a) ref.port = 'renamed';
  });
  assert.equal(breakout.a.port, 'renamed');
  M.forEachPortRef({ cables: undefined }, () => assert.fail('a plan without cables has no port to visit'));
});

test('setDeviceType changes the type of one device and keeps its cables on the ports at the same place', () => {
  const p = M.createExampleProject();
  const cn = p.devices.find((d) => d.name === 'cn-001');
  cn.serial = 'SN-1';
  const ports = (q, d) => q.cables.flatMap((c) => M.cableEnds(c).filter((x) => x.end.device === d.id).map((x) => x.end.port)).sort();
  const node = M.addDeviceType(p, {
    label: 'GPU node',
    height: 2,
    face: 'gpu',
    ports: [
      { name: 'bmc', connector: 'rj45', side: 'rear' },
      { name: 'eth0', connector: 'rj45', side: 'rear' },
      { name: 'ib', first: 0, count: 2, connector: 'qsfp56', speedGbps: 200, side: 'rear' },
    ],
  });
  const cables = p.cables.length;
  assert.deepEqual(C.typeChangeImpact(p, cn.id, node.id), []);
  assert.equal(M.setDeviceType(p, cn.id, node.id), null);
  assert.deepEqual([cn.type, cn.name, cn.serial, cn.groups.v1], [node.id, 'cn-001', 'SN-1', 'c-kestrel'], 'the device keeps its fields');
  assert.equal(p.cables.length, cables);
  assert.deepEqual(ports(p, cn), ['bmc', 'eth0', 'ib0'], 'ib0 is the first port of the ib series');
  assert.equal(p.devices.filter((d) => d.type === 'compute-node').length, 19, 'the other compute nodes keep theirs');
  assert.equal(M.setDeviceType(p, cn.id, node.id), null, 'the same type changes nothing');

  // A type without those ports unplugs their cables.
  const blank = M.addDeviceType(p, { label: 'Blank 2U', height: 2, ports: [] });
  assert.deepEqual(C.typeChangeImpact(p, cn.id, blank.id).map((c) => c.label), ['MGT-0001', 'BMC-0001', 'IB-0001']);
  assert.equal(M.setDeviceType(p, cn.id, blank.id), null);
  assert.equal(p.cables.length, cables - 3);
  assert.equal(M.pruneCables(M.clone(p)), 0);

  // A type that does not fit where the device is is refused, and the plan stays as it was.
  const json = JSON.stringify(p);
  assert.equal(M.setDeviceType(p, cn.id, 'storage-node'), 'Overlaps cn-002 at U6–7');
  assert.equal(M.setDeviceType(p, 'nope', 'storage-node'), 'Unknown device or device type');
  assert.equal(M.setDeviceType(p, cn.id, 'nope'), 'Unknown device or device type');
  assert.deepEqual(C.typeChangeImpact(p, cn.id, 'storage-node'), []);
  assert.equal(JSON.stringify(p), json);

  // Reserved space takes the height of the device; a device takes its type's.
  assert.equal(M.setDeviceType(p, cn.id, 'reserved'), null);
  assert.equal(cn.height, 2);
  assert.equal(M.setDeviceType(p, cn.id, 'compute-node'), null);
  assert.ok(!('height' in cn));

  // A switch mounted back to front, as switches are, becomes a PDU mounted as PDUs are.
  const sw = p.devices.find((d) => d.name === 'sw-bmc-a01');
  assert.equal(sw.reversed, true);
  assert.equal(M.setDeviceType(p, sw.id, 'pdu'), null);
  assert.equal(sw.reversed, false);
  assert.ok(!p.cables.some((c) => M.cableEnds(c).some((x) => x.end.device === sw.id)), 'no switch port is in the place of mgmt');
  const turned = p.devices.find((d) => d.name === 'cn-002');
  turned.reversed = true;
  assert.equal(M.setDeviceType(p, turned.id, node.id), null);
  assert.equal(turned.reversed, true, 'a device turned by hand stays turned');
  assert.equal(M.layoutProblem(p), null);
});

test('cable labels continue their series', () => {
  const p = M.createEmptyProject();
  p.networks.push({ id: 'n1', name: 'InfiniBand', color: '#2f6fdb', firstLabel: 'IB-0001' });
  assert.equal(M.nextCableLabel(p, 'n1'), 'IB-0001');
  assert.equal(M.nextCableLabel(p, null), 'C-0001');
  p.cables.push({ label: 'IB-0001' }, { label: 'IB-0009' }, { label: 'C-12' }, { label: 'IB-0003-x' });
  assert.equal(M.nextCableLabel(p, 'n1'), 'IB-0010', 'past the highest of the series, keeping the width');
  assert.equal(M.nextCableLabel(p, 'n1', new Set(['IB-0010', 'IB-0011'])), 'IB-0012', 'taken labels count');
  assert.equal(M.nextCableLabel(p, null), 'C-0013');
  p.cables.push({ label: 'IB-9999' });
  assert.equal(M.nextCableLabel(p, 'n1'), 'IB-10000');
  p.networks[0].firstLabel = 'X7';
  assert.equal(M.nextCableLabel(p, 'n1'), 'X7', 'a custom first label');
  p.networks[0].firstLabel = 'core';
  assert.equal(M.nextCableLabel(p, 'n1'), 'core-0001', 'a label without a number starts a series');
  assert.equal(M.nextLabelAfter(p, 'IB-0001'), 'IB-10000');
  assert.equal(M.nextLabelAfter(p, 'riser'), 'riser-2');
  assert.equal(M.defaultFirstLabel('InfiniBand'), 'INF-0001');
  assert.equal(M.defaultFirstLabel('Storage 25G'), 'STO-0001');
  assert.equal(M.defaultFirstLabel('25G'), '25G-0001');
  assert.equal(M.defaultFirstLabel('机房'), 'C-0001');
});

test('a layout copy keeps the catalogs but no cables or networks', () => {
  const ex = M.createExampleProject();
  const p = M.copyLayout(ex);
  assert.deepEqual([p.cables, p.networks, p.devices], [[], [], []]);
  assert.deepEqual(p.cableTypes, ex.cableTypes);
  assert.deepEqual(p.transceivers, ex.transceivers);
  const q = M.createExampleProject();
  q.cables[0].notes = 'changed';
  assert.ok(!M.isPristineExample(q), 'cables count for an edited example');
  const r = M.createExampleProject();
  r.networks[0].color = '#000000';
  assert.ok(!M.isPristineExample(r));
});

// -------------------------------------------------------------------- views

test('a new plan has one view, and every view groups the same devices in clusters of its own', () => {
  const p = project([['compute-node', 'r1', 'u', 1, 'cn-1', { groups: { v1: 'c1' } }], ['compute-node', 'r1', 'u', 3, 'cn-2']]);
  assert.deepEqual(p.views.map((v) => [v.id, v.name]), [['v1', 'Default']]);
  const [a, b] = p.devices;
  assert.equal(M.clusterOf(p, a).name, 'Alpha', 'without a view id, the first view');
  assert.equal(M.clusterIdOf(p, b), null);

  const ib = M.addView(p, 'InfiniBand');
  assert.deepEqual([ib.name, ib.clusters], ['InfiniBand', []]);
  assert.match(ib.id, /^v-[0-9a-z]+$/, 'a random id');
  assert.equal(M.clusterIdOf(p, a, ib.id), null, 'a new view starts unassigned');
  ib.clusters.push({ id: 'c2', name: 'HDR', color: '#d64545' });
  assert.equal(M.setClusterOf(p, b, ib.id, 'c2'), true);
  assert.deepEqual([M.clusterIdOf(p, a, 'v1'), M.clusterIdOf(p, b, 'v1'), M.clusterIdOf(p, b, ib.id)], ['c1', null, 'c2']);
  assert.equal(M.clusterById(p, 'c2').name, 'HDR', 'cluster ids are unique across views');
  assert.equal(M.viewOfCluster(p, 'c2'), ib);
  assert.equal(M.clusterIdOf(p, a, 'nope'), 'c1', 'an unknown view id falls back to the first view');
  assert.equal(M.setClusterOf(p, a, ib.id, 'c1'), false, 'a cluster of another view is refused');
  assert.equal(M.clusterIdOf(p, a, ib.id), null, 'a cluster of another view does not count');
  assert.deepEqual(a.groups, { v1: 'c1' }, 'and not stored');
  // Writes have no fallback to the first view: its cluster stays.
  assert.equal(M.setClusterOf(p, a, 'v-gone', 'c2'), false);
  assert.equal(M.setClusterOf(p, a, 'v-gone', null), false);
  assert.equal(M.setClusterOf(p, a, undefined, null), false);
  assert.deepEqual(a.groups, { v1: 'c1' });
  assert.equal(M.setClusterOf(p, b, ib.id, null), true);
  assert.deepEqual(b.groups, {});

  assert.equal(M.nextClusterName(p, ib.id), 'Cluster 2');
  assert.notEqual(M.nextClusterColor(p, ib.id), '#d64545');
  assert.equal(M.nextViewName(p), 'View 3');
});

test('a copied view has its own clusters with the same devices in them', () => {
  const p = project([['compute-node', 'r1', 'u', 1, 'cn-1', { groups: { v1: 'c1' } }], ['compute-node', 'r1', 'u', 3, 'cn-2']]);
  const copy = M.addView(p, 'Copy', 'v1');
  assert.equal(copy.clusters.length, 1);
  assert.notEqual(copy.clusters[0].id, 'c1');
  assert.deepEqual([copy.clusters[0].name, copy.clusters[0].color], ['Alpha', '#2f6fdb']);
  assert.equal(M.clusterIdOf(p, p.devices[0], copy.id), copy.clusters[0].id);
  assert.equal(M.clusterIdOf(p, p.devices[1], copy.id), null);
  copy.clusters[0].name = 'Beta';
  assert.equal(M.clusterOf(p, p.devices[0], 'v1').name, 'Alpha', 'the views do not share clusters');
});

test('a copy of a view gets a name no other view has', () => {
  const p = project();
  M.renameView(p, 'v1', 'Lustre');
  assert.equal(M.copyViewName(p, 'v1'), 'Lustre (copy)');
  const first = M.addView(p, M.copyViewName(p, 'v1'), 'v1');
  assert.equal(M.copyViewName(p, 'v1'), 'Lustre (copy 2)');
  M.addView(p, M.copyViewName(p, 'v1'), 'v1');
  // A copy of a copy counts on, and names differing in case only are taken too.
  assert.equal(M.copyViewName(p, first.id), 'Lustre (copy 3)');
  M.addView(p, 'LUSTRE (COPY 3)');
  assert.equal(M.copyViewName(p, 'v1'), 'Lustre (copy 4)');
  // A long name is cut to keep the suffix within 60 characters.
  M.renameView(p, 'v1', 'x'.repeat(60));
  assert.equal(M.copyViewName(p, 'v1'), `${'x'.repeat(53)} (copy)`);
});

test('views can be renamed, moved and removed; a plan keeps one, and devices drop what goes', () => {
  const p = project([['compute-node', 'r1', 'u', 1, 'cn-1', { groups: { v1: 'c1' } }]]);
  for (let i = 2; i <= M.LIMITS.views; i++) assert.ok(M.addView(p, '', i === 2 ? 'v1' : null));
  const v2 = p.views[1].id;
  assert.equal(M.addView(p), null, `a plan holds ${M.LIMITS.views} views`);
  assert.ok(M.renameView(p, v2, '  Lustre '));
  assert.equal(M.viewById(p, v2).name, 'Lustre');
  assert.ok(!M.renameView(p, v2, '   '), 'an empty name keeps the old one');
  assert.ok(M.moveView(p, v2, 0));
  assert.equal(p.views[0].id, v2);
  assert.equal(M.clusterOf(p, p.devices[0]).name, 'Alpha', 'the first view is now the copy');
  const copied = p.views[0].clusters[0].id;
  assert.ok(M.removeView(p, v2));
  assert.ok(!(v2 in p.devices[0].groups));
  assert.equal(M.clusterById(p, copied), null);
  while (p.views.length > 1) M.removeView(p, p.views[p.views.length - 1].id);
  assert.ok(!M.removeView(p, p.views[0].id), 'the last view stays');
});

test('removeCluster unassigns its devices in its own view only', () => {
  const p = project([['compute-node', 'r1', 'u', 1, 'cn-1', { groups: { v1: 'c1' } }]]);
  const copy = M.addView(p, 'Copy', 'v1');
  assert.ok(M.removeCluster(p, 'c1'));
  assert.deepEqual(p.views[0].clusters, []);
  assert.deepEqual(p.devices[0].groups, { [copy.id]: copy.clusters[0].id });
  assert.ok(!M.removeCluster(p, 'c1'));
});

test('copies of devices keep their clusters in every view', () => {
  const p = project([['compute-node', 'r1', 'u', 1, 'cn-1', { groups: { v1: 'c1' } }]]);
  const copy = M.addView(p, 'Copy', 'v1');
  const [c] = M.copiesAt(p, [{ id: 'd1', loc: { rack: 'r2', kind: 'u', at: 1 } }]);
  assert.deepEqual(c.groups, { v1: 'c1', [copy.id]: copy.clusters[0].id });
  c.groups.v1 = null;
  assert.equal(p.devices[0].groups.v1, 'c1', 'the copy has its own groups');
});

test('suggestPlacement and search use the clusters of the view asked for', () => {
  const p = project([['compute-node', 'r1', 'u', 1, 'cn-001', { groups: { v1: 'c1' } }]]);
  const ib = M.addView(p, 'InfiniBand');
  ib.clusters.push({ id: 'c2', name: 'HDR', color: '#d64545' });
  M.setClusterOf(p, p.devices[0], ib.id, 'c2');
  assert.equal(M.suggestPlacement(p, 'compute-node', { rack: 'r1', kind: 'u', at: 5 }).cluster, 'c1');
  assert.equal(M.suggestPlacement(p, 'compute-node', { rack: 'r1', kind: 'u', at: 5 }, 1, ib.id).cluster, 'c2');
  const hint = M.suggestPlacement(p, 'compute-node', { rack: 'r1', kind: 'u', at: 5 });
  assert.deepEqual(hint.groups, { v1: 'c1', [ib.id]: 'c2' }, 'the clusters of every view');
  hint.groups.v1 = null;
  assert.equal(p.devices[0].groups.v1, 'c1', 'a copy of them');
  assert.equal(M.search(p, 'hdr').counts.devices, 0);
  assert.equal(M.search(p, 'hdr', 8, ib.id).counts.devices, 1);
  // A cluster of another view is found as such, with the view it is in.
  assert.deepEqual(M.search(p, 'hdr').clusters, [{ kind: 'cluster', id: 'c2', view: ib.id, name: 'HDR', detail: 'Cluster in view InfiniBand · 1 device' }]);
  assert.deepEqual(M.search(p, 'hdr', 8, ib.id).clusters, [], 'not those of the view shown');
  assert.equal(M.search(p, 'alpha', 8, ib.id).clusters[0].detail, 'Cluster in view Default · 1 device');
  assert.equal(M.deviceMatcher(p, 'alpha', ib.id)(p.devices[0]), false);
});

test('copyLayout keeps the views without their clusters', () => {
  const p = project([['compute-node', 'r1', 'u', 1, 'cn-1', { groups: { v1: 'c1' } }]]);
  const ib = M.addView(p, 'InfiniBand', 'v1');
  const l = M.copyLayout(p);
  assert.deepEqual(l.views.map((v) => [v.id, v.name, v.clusters]), [['v1', 'Default', []], [ib.id, 'InfiniBand', []]]);
});

test('the first eight cluster colors stay apart for color-blind eyes too', () => {
  const first = M.CLUSTER_COLORS.slice(0, 8);
  for (let i = 0; i < first.length; i++) {
    for (let j = 0; j < i; j++) assert.ok(M.colorDistance(first[i], first[j]) >= M.COLOR_NEAR, `${first[i]} and ${first[j]}`);
  }
  // Cobalt and violet differ in hue only, and look the same without red cones.
  assert.ok(M.colorDistance('#2f6fdb', '#8a5cd6') < M.COLOR_NEAR);
  assert.equal(M.colorDistance('#2f6fdb', '#2F6FDB'), 0);
  assert.equal(M.colorDistance('#2f6fdb', 'blue'), Infinity);
  // The example's clusters keep to them.
  const example = M.createExampleProject().views[0].clusters.map((c) => c.color);
  assert.ok(example.every((c) => first.includes(c)));
});

test('names the CSVs find things by stay apart in their list, in any case', () => {
  const p = M.createExampleProject();
  // Catalog types: a new one takes a number, a change to a taken name is refused.
  assert.equal(M.updateDeviceType(p, 'storage-node', { label: 'Compute node' }), 'Another device type is named Compute node');
  assert.equal(M.typeOf(p, 'storage-node').label, 'Storage node');
  assert.equal(M.updateDeviceType(p, 'storage-node', { label: 'STORAGE NODE' }), null, 'its own name in another case');
  const rt = M.addRackType(p, { name: p.rackTypes[0].name.toUpperCase() });
  assert.equal(rt.name, `${p.rackTypes[0].name.toUpperCase()} 2`);
  assert.equal(M.updateRackType(p, rt.id, { name: p.rackTypes[0].name }), `Another rack type is named ${p.rackTypes[0].name}`);
  const long = 'x'.repeat(M.LIMITS.name);
  M.addDeviceType(p, { label: long });
  assert.equal(M.addDeviceType(p, { label: long }).label, `${'x'.repeat(M.LIMITS.name - 4)} 2`, 'the number keeps within the length a name keeps');

  // Floors, rows and racks: within their parent.
  const [ground, first] = p.floors;
  const extra = M.insertFloor(p, ground.name.toUpperCase());
  assert.equal(extra.name, `${ground.name.toUpperCase()} 2`);
  M.removeFloor(p, extra.id);
  assert.equal(M.renameFloor(p, first.id, ground.name), false);
  assert.equal(M.renameFloor(p, first.id, ''), false);
  assert.equal(first.name, 'First floor');
  assert.equal(M.renameFloor(p, first.id, 'Mezzanine'), true);
  const [a, b] = ground.rows;
  assert.equal(M.renameRow(p, b.id, a.name.toLowerCase()), false);
  assert.equal(M.renameRow(p, b.id, 'Row Q'), true);
  assert.equal(M.renameRow(p, first.rows[0].id, 'Row Q'), true, 'a row on another floor may have the name');
  const [r1, r2] = a.racks;
  assert.equal(M.renameRack(p, r2.id, r1.name), false);
  assert.equal(M.renameRack(p, r2.id, `${r2.name} `), true);
  assert.equal(M.addRack(p, b.id, { name: b.racks[0].name.toLowerCase() }).name, `${b.racks[0].name.toLowerCase()} 2`);
  assert.equal(M.insertRow(p, ground, a.name).name, `${a.name} 2`);
  // Moved to another floor or row, a row or rack whose name is taken there gets a number.
  const upper = M.addRow(p, first.id, { name: a.name.toUpperCase(), racks: 1 });
  assert.equal(upper.name, a.name.toUpperCase(), 'a row on another floor may have the name');
  assert.ok(M.moveRow(p, upper.id, ground.id));
  assert.equal(upper.name, `${a.name.toUpperCase()} 3`);
  assert.ok(M.moveRow(p, upper.id, ground.id, 0));
  assert.equal(upper.name, `${a.name.toUpperCase()} 3`, 'on its own floor it keeps its name');
  const spare = M.addRack(p, a.id, { name: 'Rack Z9' });
  M.addRack(p, b.id, { name: 'rack z9' });
  assert.ok(M.moveRack(p, spare.id, b.id));
  assert.equal(spare.name, 'Rack Z9 2');
  assert.ok(M.moveRack(p, spare.id, b.id, 0));
  assert.equal(spare.name, 'Rack Z9 2', 'in its own row it keeps its name');
  // Copies of a floor take free names.
  const copies = [M.duplicateFloor(p, ground.id), M.duplicateFloor(p, ground.id)];
  assert.deepEqual(copies.map((f) => f.name), [`${ground.name} (copy)`, `${ground.name} (copy 2)`]);

  // Clusters: within their view.
  const view = p.views[0];
  const [c, other] = view.clusters;
  assert.equal(M.updateCluster(p, other.id, { name: c.name.toUpperCase() }), `Another cluster in ${view.name} is named ${c.name.toUpperCase()}`);
  assert.equal(M.updateCluster(p, other.id, { name: ' ' }), 'A cluster needs a name');
  assert.equal(M.updateCluster(p, other.id, { name: 'Spare', color: '#123456' }), null);
  assert.deepEqual([other.name, other.color], ['Spare', '#123456']);
  const added = M.addCluster(p, view.id, { name: 'spare' });
  assert.deepEqual([added.name, view.clusters[view.clusters.length - 1]], ['spare 2', added]);
  const ib = M.addView(p, 'InfiniBand');
  assert.equal(M.addCluster(p, ib.id, { name: 'Spare' }).name, 'Spare', 'another view may have the name');

  // Views: a new one, or a renamed one, never takes a name another view has.
  assert.equal(M.addView(p, 'infiniband').name, 'infiniband 2');
  assert.equal(M.renameView(p, ib.id, view.name.toUpperCase()), false);
  assert.equal(ib.name, 'InfiniBand');
  assert.equal(M.renameView(p, ib.id, 'INFINIBAND'), true);
  const copy1 = M.addView(p, M.copyViewName(p, ib.id), ib.id);
  const copy2 = M.addView(p, M.copyViewName(p, ib.id), ib.id);
  assert.deepEqual([copy1.name, copy2.name], ['INFINIBAND (copy)', 'INFINIBAND (copy 2)']);

  // A plan that has a name twice still lets those things change, as long as the name stays.
  p.deviceTypes.find((t) => t.id === 'compute-node').label = 'Storage node';
  assert.equal(M.updateDeviceType(p, 'compute-node', { powerW: 800 }), null);
  other.name = c.name;
  assert.equal(M.updateCluster(p, other.id, { name: c.name, color: '#654321' }), null);
  assert.equal(other.color, '#654321');
  assert.equal(M.renameRack(p, r2.id, r1.name), false);
  r2.name = r1.name;
  assert.equal(M.renameRack(p, r2.id, r1.name), true);
});
