'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');
const IO = require('../js/io.js');

const rowRacks = (p) => p.floors[0].rows[0].racks;

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
  const { project: p, warnings } = IO.normalizeProject(raw);
  assert.equal(p.name, 'Hall 3');
  assert.deepEqual(rowRacks(p).map((r) => r.name), ['West', 'Rack A02', 'East']);
  assert.deepEqual(p.clusters.map((c) => [c.id, c.color]), [
    ['c1', '#aabbcc'],
    ['c2', M.nextClusterColor({ clusters: [{ color: '#aabbcc' }] })],
  ]);
  assert.deepEqual(p.devices.map((d) => d.name), ['cn-1', 'sw']);
  assert.equal(p.devices[1].cluster, null);
  assert.notEqual(p.devices[1].id, 'a', 'duplicate ids are replaced');
  assert.deepEqual(p.devices[1].loc, { rack: 'r3', kind: 'side', at: 1 });
  assert.deepEqual(warnings, [
    'Skipped cluster dupe: its id “c1” is used twice.',
    'Skipped cn-2: Overlaps cn-1 at U10–11.',
    'Skipped t: unknown device type “toaster”.',
    'Skipped sn: Side slots take 1U devices only.',
    'sw refers to unknown cluster “nope” and is left unassigned.',
  ]);
  assert.throws(() => IO.normalizeProject([]), /not a rack plan/);
  assert.throws(() => IO.normalizeProject({ foo: 1 }), /not a rack plan/);
});

test('version 2 plans become one row and keep up to 16 racks', () => {
  const racks = (n) => Array.from({ length: n }, (_, i) => ({ id: `rack-${i}`, name: `R${i}` }));
  const dev = (rack) => ({ type: 'compute-node', name: `n-${rack}`, loc: { rack, kind: 'u', at: 1 } });
  const one = IO.normalizeProject({ version: 2, racks: racks(1), devices: [dev('rack-0')] });
  assert.deepEqual(one.project.floors, [{ id: 'f1', name: 'Floor 1', rows: [{ id: 'row1', name: 'Row A', racks: [{ id: 'r1', name: 'R0', type: 'rack-47' }] }] }]);
  assert.equal(one.project.devices.length, 1);
  assert.deepEqual(one.project.deviceTypes, M.DEFAULT_DEVICE_TYPES, 'the standard catalog');
  const many = IO.normalizeProject({ racks: racks(20), devices: [dev('rack-15'), dev('rack-17')] });
  assert.equal(rowRacks(many.project).length, 16);
  assert.deepEqual(many.project.devices.map((d) => d.loc.rack), ['r16'], 'device in the 18th rack is dropped');
  assert.equal(many.warnings.length, 2);
  assert.equal(rowRacks(IO.normalizeProject({ devices: [] }).project).length, 3, 'default when racks are missing');
});

test('normalizeProject skips devices in racks the file does not have', () => {
  const { project: p, warnings } = IO.normalizeProject({
    racks: [{ id: 'r2' }, { id: 'r3' }],
    devices: [
      { type: 'compute-node', name: 'orphan', loc: { rack: 'r1', kind: 'u', at: 1 } },
      { type: 'compute-node', name: 'first', loc: { rack: 'r2', kind: 'u', at: 1 } },
    ],
  });
  assert.deepEqual(p.devices.map((d) => [d.name, d.loc.rack]), [['first', 'r1']]);
  assert.deepEqual(warnings, ['Skipped orphan: rack “r1” is not in the plan.']);
  const bare = IO.normalizeProject({ devices: [{ type: 'switch-rj45', name: 'sw', loc: { rack: 'r3', kind: 'u', at: 5 } }] });
  assert.equal(bare.project.devices[0].loc.rack, 'r3', 'without racks in the file, devices may use the default ids');
});

test('normalizeProject accepts numeric ids', () => {
  const { project: p, warnings } = IO.normalizeProject({
    racks: [{ id: 1 }, { id: 2 }],
    clusters: [{ id: 7, name: 'HPC', color: '#2f6fdb' }, { name: 'no id' }],
    devices: [{ id: 3, type: 'compute-node', name: 'cn-1', cluster: 7, loc: { rack: 2, kind: 'u', at: 1 } }],
  });
  assert.deepEqual(p.clusters.map((c) => c.id), ['7']);
  assert.deepEqual(p.devices.map((d) => [d.id, d.cluster, d.loc.rack]), [['3', '7', 'r2']]);
  assert.deepEqual(warnings, ['Skipped cluster no id: it has no id.']);
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
  const { project: p, warnings } = IO.normalizeProject(raw);
  assert.deepEqual(warnings, []);
  assert.deepEqual(p.devices.map((d) => d.loc.at), [1, 44, 26, 0]);
  assert.equal(p.version, 3);
  assert.equal(IO.normalizeProject(JSON.parse(IO.serialize(p))).project.devices[1].loc.at, 44, 'version 3 is kept');
});

test('version 3 plans keep floors, rows, catalogs, fields and reserved space', () => {
  const ex = M.createExampleProject();
  M.deviceById(ex, 'ex-9').serial = 'SN-1';
  M.deviceById(ex, 'ex-9').powerW = 820;
  const json = IO.serialize(ex);
  const { project: p, warnings } = IO.normalizeProject(JSON.parse(json));
  assert.deepEqual(warnings, []);
  assert.deepEqual(p, ex, 'a round trip changes nothing');
  assert.ok(!/"asset"/.test(json), 'empty fields are left out of the file');
  assert.ok(IO.serialize(ex, { compact: true }).length < json.length);
});

test('version 3 plans are checked against their limits and catalogs', () => {
  const rows = (n, racks) => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, name: `Row ${i}`, racks: Array.from({ length: racks }, (_, k) => ({ id: `k${i}-${k}`, type: 'huge' })) }));
  const raw = {
    version: 3,
    deviceTypes: [
      { id: 'blade', label: 'Blade chassis', height: 10, face: 'nope', powerW: 'lots' },
      { id: 'blade', label: 'Copy' },
      { label: 'No id' },
      { id: 'reserved', label: 'Sneaky' },
    ],
    rackTypes: [{ id: 'huge', name: 'Huge', units: 99, sideSlots: 9 }],
    floors: [
      { id: 'a', name: 'One', rows: rows(9, 17) },
      { id: 'a', name: 'Two', rows: [] },
      ...Array.from({ length: 6 }, (_, i) => ({ name: `F${i}`, rows: rows(1, 1) })),
    ],
    devices: [
      { type: 'blade', name: 'bl-1', loc: { rack: 'k0-0', kind: 'u', at: 51 } },
      { type: 'compute-node', name: 'cn-1', loc: { rack: 'k0-1', kind: 'u', at: 1 } },
      { type: 'reserved', name: 'later', height: 7, loc: { rack: 'k0-2', kind: 'u', at: 1 } },
    ],
  };
  const { project: p, warnings } = IO.normalizeProject(raw);
  assert.equal(p.floors.length, 6);
  assert.equal(p.floors[0].rows.length, 8);
  assert.equal(p.floors[0].rows[0].racks.length, 16);
  assert.notEqual(p.floors[1].id, 'a', 'duplicate floor ids are replaced');
  assert.equal(p.floors[1].name, 'F0', 'the empty floor is skipped');
  assert.deepEqual(M.rackTypeById(p, 'huge'), { id: 'huge', name: 'Huge', units: 60, sideSlots: 4, powerW: 0, weightKg: 0 });
  assert.deepEqual(p.deviceTypes.map((t) => [t.id, t.height, t.face, t.powerW]), [['blade', 10, 'generic', 0], ['compute-node', 2, 'compute', 700]]);
  assert.deepEqual(p.devices.map((d) => [d.name, d.loc.at, d.height]), [['bl-1', 51, undefined], ['cn-1', 1, undefined], ['later', 1, 7]]);
  for (const w of [
    'Only the first 6 floors were kept.',
    'One: only the first 8 rows were kept.',
    'One · Row 0: only the first 16 racks were kept.',
    'Skipped device type Copy: its id “blade” is used twice.',
    'Skipped device type No id: it has no id.',
    'Skipped device type Sneaky: its id “reserved” is used twice.',
    'Skipped Two: it has no rows.',
    'Added the standard device type Compute node, which the plan uses.',
  ]) assert.ok(warnings.includes(w), w);
});

test('toCSV lists devices by floor, row and rack, top to bottom, and neutralises formulas', () => {
  const p = M.createEmptyProject();
  p.clusters.push({ id: 'c1', name: 'Alpha', color: '#2f6fdb' });
  const add = (type, kind, at, name, extra) => p.devices.push(M.newDevice(Object.assign({ type, name, loc: { rack: 'r1', kind, at } }, extra)));
  add('compute-node', 'u', 5, '=cmd()', { cluster: 'c1', serial: 'S1', powerW: 999 });
  add('switch-rj45', 'u', 47, 'sw, "core"');
  add('switch-qsfp', 'side', 0, 'leaf');
  add('reserved', 'u', 10, 'later', { height: 3 });
  const lines = IO.toCSV(p).trim().split('\r\n');
  assert.equal(lines[0], 'Floor,Row,Rack,Position,Height (U),Type,Name,Cluster,Serial number,Asset tag,IP address,Owner,Power (W),Weight (kg),Notes');
  assert.equal(lines[1], "Floor 1,Row A,Rack A01,U5-6,2,Compute node,'=cmd(),Alpha,S1,,,,999,25,");
  assert.equal(lines[2], 'Floor 1,Row A,Rack A01,U10-12,3,Reserved space,later,,,,,,0,0,');
  assert.equal(lines[3], 'Floor 1,Row A,Rack A01,U47,1,48-port switch,"sw, ""core""",,,,,,150,6,');
  assert.equal(lines[4], 'Floor 1,Row A,Rack A01,Side V1,1,24-port switch,leaf,,,,,,350,9,');
});

test('parseCSV handles quotes, other separators and the formula guard', () => {
  assert.deepEqual(IO.parseCSV('a,b\r\n"x, ""y""",\'=1\n\n'), [['a', 'b'], ['x, "y"', '=1']]);
  assert.deepEqual(IO.parseCSV('﻿a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(IO.parseCSV('a\tb\n"multi\nline"\t2'), [['a', 'b'], ['multi\nline', '2']]);
  assert.deepEqual(IO.parsePosition('U5-6'), { kind: 'u', at: 5 });
  assert.deepEqual(IO.parsePosition('12'), { kind: 'u', at: 12 });
  assert.deepEqual(IO.parsePosition('Side V2'), { kind: 'side', at: 1 });
  assert.equal(IO.parsePosition('top'), null);
});

test('a CSV export imports back into an equal plan', () => {
  const ex = M.createExampleProject();
  M.deviceById(ex, 'ex-9').owner = 'HPC team';
  const { project: p, warnings, added } = IO.importCSV(IO.toCSV(ex));
  assert.deepEqual(warnings, [
    'Added the device type Patch panel (1U) to the catalog.',
    'Added the device type PDU (1U) to the catalog.',
    'Added the device type GPU server (4U) to the catalog.',
  ], 'a CSV has no catalog, so custom types come back as generic ones');
  assert.equal(added, ex.devices.length);
  const pick = (proj) =>
    M.sortedDevices(proj).map((d) => {
      const pos = M.locateRack(proj, d.loc.rack);
      return [pos.floor.name, pos.row.name, pos.rack.name, d.loc.kind, d.loc.at, d.name, M.typeOf(proj, d.type).label, (M.clusterById(proj, d.cluster) || {}).name, d.owner, M.powerOf(proj, d), M.deviceHeight(proj, d)];
    });
  assert.deepEqual(pick(p), pick(ex));
});

test('a CSV adds devices to a plan and creates what is missing', () => {
  const base = M.createEmptyProject();
  const csv = [
    'Name;Rack;Position;Type;Height;Cluster;Row;Floor',
    'web-01;Rack A01;U3;1U server;1;Web;;',
    'web-02;Rack A01;U3;1U server;1;Web;;',
    'db-01;Rack B07;U10-13;Database box;4;;Row B;Floor 1',
    ';Rack A02;V1;48-port switch;;;;',
    'x;Rack A02;top;48-port switch;;;;',
    'y;;U1;48-port switch;;;;',
    'z;Rack A02;U5;Mystery;;;;',
  ].join('\n');
  const { project: p, warnings, added } = IO.importCSV(csv, base);
  assert.equal(added, 3);
  assert.deepEqual(p.devices.map((d) => [d.name, M.formatDeviceLoc(p, d)]), [
    ['web-01', 'Rack A01 · U3'],
    ['db-01', 'Rack B07 · U10–13'],
    ['sw-rj45-01', 'Rack A02 · side slot V1'],
  ]);
  assert.equal(M.locateRack(p, p.devices[1].loc.rack).row.name, 'Row B', 'rows are created by name');
  assert.deepEqual(p.clusters.map((c) => c.name), ['Web']);
  assert.deepEqual(p.deviceTypes.slice(5).map((t) => [t.label, t.height, t.face]), [['1U server', 1, 'generic'], ['Database box', 4, 'generic']]);
  for (const w of [
    'Skipped x: position “top” is not like U12 or Side V1.',
    'Skipped y: it has no rack.',
    'Skipped z: unknown device type “Mystery” and no height to create it.',
    'Skipped web-02: Overlaps web-01 at U3.',
  ]) assert.ok(warnings.includes(w), w);
  assert.throws(() => IO.importCSV('Name,Rack\nx,y'), /Position/);
  assert.throws(() => IO.importCSV('just one line'), /no devices/);
});

test('share links pack and unpack a plan', async () => {
  const ex = M.createExampleProject();
  const code = await IO.encodeShare(ex);
  assert.match(code, /^z[A-Za-z0-9_-]+$/);
  assert.ok(code.length < IO.serialize(ex, { compact: true }).length / 3, 'compressed');
  const back = IO.normalizeProject(await IO.decodeShare(code)).project;
  assert.deepEqual(back, ex);
  await assert.rejects(IO.decodeShare('zzzz'), /cut off/);
  await assert.rejects(IO.decodeShare(''), /readable/);
  const plain = 'j' + Buffer.from(IO.serialize(ex, { compact: true })).toString('base64url');
  assert.equal((await IO.decodeShare(plain)).name, ex.name);
});
