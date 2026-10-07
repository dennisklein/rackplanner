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
  assert.deepEqual(one.project.floors, [{ id: 'f1', name: 'Floor 1', rowPitchM: 3, rows: [{ id: 'row1', name: 'Row A', racks: [{ id: 'r1', name: 'R0', type: 'rack-47', trayM: null, slackM: null }] }] }]);
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
  assert.equal(p.version, 4);
  assert.equal(IO.normalizeProject(JSON.parse(IO.serialize(p))).project.devices[1].loc.at, 44, 'version 4 is kept');
});

test('plans keep floors, rows, catalogs, fields, reserved space and cabling', () => {
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
  assert.deepEqual(M.rackTypeById(p, 'huge'), { id: 'huge', name: 'Huge', units: 60, sideSlots: 4, powerW: 0, weightKg: 0, widthMm: 600, depthMm: 1200, trayM: 0.5, slackM: 0.25 });
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

test('floors, rows and racks never share an id, and reserved cluster ids are replaced', () => {
  const { project: p, warnings } = IO.normalizeProject({
    version: 3,
    floors: [{ id: 1, rows: [{ id: 1, name: 'Row A', racks: [{ id: 1 }, { id: 2 }] }, { id: 2, name: 'Row B', racks: [{ id: 3 }, { id: 'row9' }] }] }],
    clusters: [{ id: '__new', name: 'Sneaky', color: '#d64545' }, { id: '__none', name: 'Other' }],
    devices: [
      { id: 'a', type: 'compute-node', cluster: '__new', loc: { rack: 1, kind: 'u', at: 1 } },
      { id: 'b', type: 'compute-node', cluster: '__none', loc: { rack: 2, kind: 'u', at: 1 } },
      { id: 'c', type: 'compute-node', loc: { rack: 3, kind: 'u', at: 1 } },
    ],
  });
  assert.deepEqual(warnings, []);
  const ids = [...M.structureIds(p)];
  assert.equal(new Set(ids).size, 7, 'one floor, two rows, four racks, all distinct');
  assert.deepEqual(M.devicesWithin(p, p.floors[0].rows[1].id).map((d) => d.id), ['c'], 'a row holds only its own devices');
  assert.deepEqual(M.devicesWithin(p, M.locateRack(p, M.deviceById(p, 'a').loc.rack).rack.id).map((d) => d.id), ['a']);
  assert.ok(p.clusters.every((c) => !c.id.startsWith('__')));
  assert.equal(M.clusterById(p, M.deviceById(p, 'a').cluster).name, 'Sneaky', 'devices follow their cluster to its new id');
  assert.equal(M.clusterById(p, M.deviceById(p, 'b').cluster).name, 'Other');
  const row = M.addRow(p, p.floors[0].id);
  assert.equal(new Set(M.structureIds(p)).size, 7 + 1 + 3, 'new rows and racks get ids nobody uses, not even a rack called row9');
  assert.ok(row);
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
    'Added the device type 32-port 400G switch (1U) to the catalog.',
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

test('CSV lines with long floor and row names end up on one floor and row', () => {
  const hall = `Hall ${'x'.repeat(70)}`;
  const row = `Row ${'y'.repeat(70)}`;
  const csv = ['Floor,Row,Rack,Position,Type,Name', `${hall},${row},R1,U1,48-port switch,a`, `${hall},${row},R2,U1,48-port switch,b`].join('\n');
  const { project: p, warnings, added } = IO.importCSV(csv);
  assert.equal(added, 2);
  assert.deepEqual(warnings, []);
  assert.equal(p.floors.length, 1);
  assert.equal(p.floors[0].name, hall.slice(0, 60));
  assert.deepEqual(p.floors[0].rows.map((r) => [r.name, r.racks.map((k) => k.name)]), [[row.slice(0, 60), ['R1', 'R2']]]);
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

// ------------------------------------------------------------------ cabling

const C = require('../js/cabling.js');

test('version 4 files keep ports, lengths, networks, catalogs and cables, a device and a cable to a line', () => {
  const ex = M.createExampleProject();
  M.deviceById(ex, 'ex-9').slackM = 0.5;
  ex.floors[0].rows[0].racks[0].trayM = 0.8;
  ex.cables[0].a.transceiver = 'sfp-10g-sr'; // not used by a copper cable, but kept
  const json = IO.serialize(ex);
  const raw = JSON.parse(json);
  assert.equal(raw.version, 4);
  assert.deepEqual(Object.keys(raw), ['app', 'version', 'name', 'info', 'deviceTypes', 'rackTypes', 'cableTypes', 'transceivers', 'floors', 'clusters', 'networks', 'devices', 'cables', 'meta']);
  assert.deepEqual(raw.devices.find((d) => d.id === 'ex-1').reversed, true);
  assert.ok(!('reversed' in raw.devices.find((d) => d.id === 'ex-9')), 'only devices mounted back to front say so');
  const lines = json.split('\n');
  assert.equal(lines.filter((l) => l.startsWith('    {"id":"cb-')).length, 147);
  assert.equal(lines.filter((l) => l.startsWith('    {"id":"ex-')).length, 65);
  assert.ok(lines.length < 1000, `${lines.length} lines`);
  const { project: p, warnings } = IO.normalizeProject(raw);
  assert.deepEqual(warnings, []);
  assert.deepEqual(p, ex);
  assert.ok(M.isPristineExample(IO.normalizeProject(JSON.parse(IO.serialize(M.createExampleProject(), { compact: true }))).project), 'key order survives too');
});

test('files before version 4 get the standard ports and lengths, and the standard catalogs', () => {
  const raw = {
    version: 3,
    deviceTypes: [
      { id: 'compute-node', label: 'My node', height: 2, face: 'compute', powerW: 500 },
      { id: 'switch-rj45', label: 'Switch', height: 1, face: 'rj45', ports: [] },
      { id: 'blade', label: 'Blade', height: 10 },
    ],
    rackTypes: [{ id: 'rack-48', name: '48U', units: 48 }, { id: 'odd', name: 'Odd', units: 42 }],
    floors: [{ id: 'f1', name: 'Hall', rows: [{ id: 'row1', name: 'Row A', racks: [{ id: 'r1', type: 'rack-48' }] }] }],
    clusters: [],
    devices: [{ id: 'a', type: 'compute-node', name: 'cn-1', loc: { rack: 'r1', kind: 'u', at: 1 } }],
  };
  const { project: p, warnings } = IO.normalizeProject(raw);
  assert.deepEqual(warnings, []);
  const std = (id) => M.DEFAULT_DEVICE_TYPES.find((t) => t.id === id);
  assert.deepEqual(M.typeOf(p, 'compute-node').ports, std('compute-node').ports);
  assert.equal(M.typeOf(p, 'compute-node').slackM, 0.3);
  assert.equal(M.typeOf(p, 'compute-node').label, 'My node', 'the rest is the file’s');
  assert.deepEqual(M.typeOf(p, 'switch-rj45').ports, [], 'ports the file has are kept, even none');
  assert.deepEqual(M.typeOf(p, 'blade').ports, []);
  assert.deepEqual([M.rackTypeById(p, 'rack-48').widthMm, M.rackTypeById(p, 'odd').widthMm], [800, 600]);
  assert.deepEqual(p.cableTypes, M.DEFAULT_CABLE_TYPES);
  assert.deepEqual(p.transceivers, M.DEFAULT_TRANSCEIVERS);
  assert.deepEqual([p.networks, p.cables, p.floors[0].rowPitchM, p.floors[0].rows[0].racks[0].trayM, p.devices[0].reversed], [[], [], 3, null, false]);

  // Out-of-range length settings are clamped or dropped.
  const odd = JSON.parse(IO.serialize(M.createExampleProject()));
  odd.floors[0].rowPitchM = -1;
  odd.floors[0].rows[0].racks[0].trayM = 99;
  odd.devices[0].reversed = 'yes';
  odd.devices[1].slackM = 'x';
  const read = IO.normalizeProject(odd).project;
  assert.deepEqual([read.floors[0].rowPitchM, read.floors[0].rows[0].racks[0].trayM, read.devices[0].reversed, read.devices[1].slackM], [0.5, 10, false, null]);

  // From version 4 on, a missing list of ports means none.
  const v4 = IO.normalizeProject(Object.assign({}, raw, { version: 4 })).project;
  assert.deepEqual(M.typeOf(v4, 'compute-node').ports, []);
  assert.deepEqual(IO.normalizeProject(Object.assign({}, raw, { version: 4, cableTypes: [] })).project.cableTypes, [], 'an empty catalog stays empty');
});

test('cables that would break the plan’s rules are skipped with a warning', () => {
  const ex = M.createExampleProject();
  const raw = JSON.parse(IO.serialize(ex));
  raw.networks.push({ id: '__new', name: 'Sneaky', color: 'nope' }, { name: 'No id' });
  raw.devices.push({ id: 'ex-9', type: 'switch-rj45', name: 'twin', loc: { rack: 'r8', kind: 'u', at: 40 } }, { id: 77, type: 'switch-rj45', name: 'numbered', loc: { rack: 'r8', kind: 'u', at: 41 } });
  const extra = [
    { id: 'k1', label: 'K-1', network: '__new', a: { device: 77, port: 'swp1' }, b: { device: 'ex-59', port: 'swp3' } },
    { id: 'k2', label: 'K-2', network: 'gone', a: { device: 77, port: 'swp2' }, b: { device: 'ex-59', port: 'swp4' } },
    { id: 'k3', label: 'K-3', a: { device: 'ex-9', port: 'eth0' }, b: { device: 'ex-59', port: 'swp5' } },
    { id: 'k4', label: 'K-4', type: 'nope', a: { device: 77, port: 'swp3' }, b: { device: 'ex-59', port: 'swp6' } },
    { id: 'k5', label: 'K-5', a: { device: 77, port: 'swp4', transceiver: 'nope' }, b: { device: 'ex-59', port: 'swp7' } },
    { id: 'k6', label: 'K-6', a: { device: 'ghost', port: 'swp5' }, b: { device: 'ex-59', port: 'swp8' } },
    { id: 'k7', label: 'K-7', a: { device: 77, port: 'swp99' }, b: { device: 'ex-59', port: 'swp9' } },
    { id: 'k8', label: 'K-8', type: 'dac-osfp-2x', a: { device: 'ex-50', port: 'p20' }, b: [{ device: 'ex-39', port: 'p20' }] },
    { id: 'k9', label: 'K-9', type: 'dac-osfp-2x', a: { device: 'ex-50', port: 'p21' }, b: { device: 'ex-39', port: 'p21' } },
    { id: 'k1', a: { device: 77, port: 'swp6' }, b: { device: 'ex-59', port: 'swp10' } },
    'junk',
  ];
  raw.cables = raw.cables.concat(extra);
  const { project: p, warnings } = IO.normalizeProject(raw);
  assert.deepEqual(warnings, [
    'Skipped network No id: it has no id.',
    'Cable K-2 refers to unknown network “gone” and has none.',
    'Skipped cable K-3: cn-001 eth0 already has cable MGT-0001.',
    'Skipped cable K-4: unknown cable type “nope”.',
    'Skipped cable K-5: unknown transceiver “nope”.',
    'Skipped cable K-6: device “ghost” is not in the plan.',
    'Skipped cable K-7: numbered has no port swp99.',
    'Skipped cable K-8: OSFP to 2 × QSFP56 DAC has 2 legs, not 1.',
    'Skipped cable K-9: OSFP to 2 × QSFP56 DAC is a breakout cable: give it its legs.',
  ]);
  assert.equal(p.cables.length, 147 + 3);
  const k1 = p.cables.find((c) => c.id === 'k1');
  assert.ok(!k1.network.startsWith('__'), 'reserved ids are replaced');
  assert.equal(M.networkById(p, k1.network).name, 'Sneaky');
  assert.equal(M.deviceById(p, k1.a.device).name, 'numbered', 'numeric ids are strings');
  assert.equal(p.cables.find((c) => c.id === 'k2').network, null);
  const last = p.cables[p.cables.length - 1];
  assert.notEqual(last.id, 'k1', 'cable ids used twice are replaced');
  assert.equal(last.label, '', 'labels are not invented on reading');
  const twin = p.devices.find((d) => d.name === 'twin');
  assert.notEqual(twin.id, 'ex-9');
  assert.ok(!p.cables.some((c) => M.cableEnds(c).some((x) => x.end.device === twin.id)), 'cables find the first device with an id');
  assert.equal(M.pruneCables(p), 0);
});

test('a cable schedule exports one line per cable and leg and reads back into a plan', () => {
  const ex = M.createExampleProject();
  const csv = IO.exportCablesCSV(ex);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], IO.CABLE_CSV_COLUMNS.join(','));
  assert.equal(lines[0], 'Label,Network,Cable type,Length (m),Length,Leg,A floor,A row,A rack,A position,A device,A port,A transceiver,B floor,B row,B rack,B position,B device,B port,B transceiver,Speed,Checks,Notes');
  assert.equal(lines.length, 1 + 147 + 16, 'a line for every leg of the sixteen breakouts');
  assert.equal(lines[1], 'MGT-0001,Management,Cat6a patch cord (auto),1,estimated,,Ground floor,Row A,Rack A01,U4-5,cn-001,eth0,,Ground floor,Row A,Rack A01,U1,sw-mgmt-a01,swp1,,1 Gb/s,,');
  const leg = lines.filter((l) => l.startsWith('IB-0043,'));
  assert.deepEqual(leg.map((l) => l.split(',').slice(5, 6).concat(l.split(',').slice(17, 19))), [['1/2', 'gpu-srv-01', 'ib0'], ['2/2', 'gpu-srv-01', 'ib1']]);
  assert.ok(lines.some((l) => l.startsWith('IB-0026,InfiniBand,QSFP56 DAC,,estimated,') && l.includes(',Too long,')));
  assert.ok(lines.some((l) => l.startsWith('MGT-0041,Management,LC duplex OM4,30,set,') && l.includes('SFP+ 10G SR (auto)') && l.endsWith(',Riser to the ground floor')));
  assert.ok(IO.isCablesCSV(csv));
  assert.ok(!IO.isCablesCSV(IO.toCSV(ex)));

  // Into the same layout and devices without cables or networks.
  const p = M.copyLayout(ex);
  p.devices = M.clone(ex.devices);
  const { added, warnings } = IO.importCablesCSV(p, csv);
  assert.deepEqual(warnings, []);
  assert.equal(added, 147);
  const strip = (q) =>
    q.cables.map((c) => {
      const net = M.networkById(q, c.network);
      return Object.assign(M.clone(c), { id: '', network: net && net.name });
    });
  assert.deepEqual(strip(p), strip(ex), 'picked types and transceivers stay picked, set lengths stay set');
  assert.deepEqual(p.networks.map((n) => n.name), ['Management', 'BMC', 'InfiniBand', 'Storage 25G', 'SAS'], 'networks are created by name, in the order they come');

  // Again: every port is taken now.
  const again = IO.importCablesCSV(p, csv);
  assert.equal(again.added, 0);
  assert.equal(again.warnings[0], 'Skipped cable MGT-0001: cn-001 eth0 already has cable MGT-0001.');
});

test('a hand-made cable schedule adds what it can', () => {
  const p = M.createExampleProject();
  p.cables = [];
  const csv = [
    'From;From port;To;To port;Type;Label;Length (m);Leg',
    'cn-001;eth0;sw-mgmt-a01;swp1;;;;',
    'cn-002;eth0;sw-mgmt-a01;swp2;Cat6a patch cord;;3;',
    'cn-003;eth0;nobody;swp3;;;;',
    'cn-004;eth0;sw-mgmt-a01;swp4;Mystery cable;;;',
    'ib-leaf-b02;p1;gpu-srv-01;ib1;OSFP to 2 × QSFP56 DAC;X-1;;2/2',
    'cn-005;ib0;ib-leaf-a01;p5;mpo-om4;;;',
  ].join('\n');
  assert.ok(IO.isCablesCSV(csv));
  const { added, warnings } = IO.importCablesCSV(p, csv);
  assert.equal(added, 4);
  assert.deepEqual(warnings, ['Skipped line 4: there is no device nobody.', 'Skipped line 5: unknown cable type “Mystery cable”.']);
  assert.deepEqual(p.cables.map((c) => [c.label, c.type, c.lengthM]), [['C-0001', null, null], ['C-0002', 'cat6a', 3], ['X-1', 'dac-osfp-2x', null], ['C-0003', 'mpo-om4', null]]);
  assert.deepEqual(p.cables[2].b.map((e) => e && e.port), [null, 'ib1'], 'a leg keeps its place');
  assert.throws(() => IO.importCablesCSV(p, 'A device,B device\nx,y'), /A port/);
  assert.throws(() => IO.importCablesCSV(p, 'A device,A port,B device,B port'), /no cables/);
});

test('lines with the same label and A end form a breakout, with or without a Leg', () => {
  const run = (header, lines) => {
    const p = M.createExampleProject();
    p.cables = [];
    return { p, r: IO.importCablesCSV(p, [header].concat(lines).join('\n')) };
  };
  const two = 'OSFP to 2 × QSFP56 DAC';
  let { p, r } = run('Label,Cable type,A device,A port,B device,B port', [`X-1,${two},ib-leaf-b02,p1,gpu-srv-01,ib0`, `X-1,${two},ib-leaf-b02,p1,gpu-srv-01,ib1`]);
  assert.deepEqual(r, { added: 1, warnings: [] });
  assert.deepEqual(p.cables[0].b.map((e) => e.port), ['ib0', 'ib1'], 'legs in line order');
  ({ p, r } = run('Label,Cable type,Leg,A device,A port,B device,B port', [`X-1,${two},,ib-leaf-b02,p1,gpu-srv-01,ib0`, `X-1,${two},1/2,ib-leaf-b02,p1,gpu-srv-01,ib1`]));
  assert.deepEqual(r, { added: 1, warnings: [] });
  assert.deepEqual(p.cables[0].b.map((e) => e.port), ['ib1', 'ib0'], 'a Leg keeps its place, the others take the free ones');
  ({ p, r } = run('Label,Cable type,A device,A port,B device,B port', [`X-1,${two},ib-leaf-b02,p1,gpu-srv-01,ib0`]));
  assert.deepEqual(p.cables[0].b.map((e) => e && e.port), ['ib0', null], 'one line of a breakout type is its first leg');
  // A single cable type with the same A end twice is still two cables, and the second is refused.
  ({ p, r } = run('Label,A device,A port,B device,B port', ['X-1,ib-leaf-b02,p1,gpu-srv-01,ib0', 'X-1,ib-leaf-b02,p1,gpu-srv-01,ib1']));
  assert.deepEqual(r, { added: 1, warnings: ['Skipped cable X-1: ib-leaf-b02 p1 already has cable X-1.'] });
});

test('leg lines that cannot be placed are reported', () => {
  const run = (lines) => {
    const p = M.createExampleProject();
    p.cables = [];
    const r = IO.importCablesCSV(p, ['Label,Cable type,Leg,A device,A port,B device,B port'].concat(lines).join('\n'));
    return { r, b: p.cables.length ? p.cables[0].b.map((e) => e && e.port) : null };
  };
  const row = (leg, port) => `B-1,dac-osfp-2x,${leg},ib-leaf-b02,p1,gpu-srv-01,${port}`;
  assert.deepEqual(run([row('1/2', 'ib0'), row('1/2', 'ib1')]), { r: { added: 1, warnings: ['Skipped line 3 of cable B-1: leg 1 is given twice.'] }, b: ['ib0', null] });
  assert.deepEqual(run([row('1/2', 'ib0'), row('3/2', 'ib1'), row('0/2', 'ib2')]), {
    r: { added: 1, warnings: ['Skipped line 3 of cable B-1: leg 3 is not one of its 2 legs.', 'Skipped line 4 of cable B-1: leg 0 is not one of its 2 legs.'] },
    b: ['ib0', null],
  });
  assert.deepEqual(run([row('1/2', 'ib0'), row('2/4', 'ib1')]), { r: { added: 1, warnings: ['Line 3 of cable B-1 says 4 legs, not 2.'] }, b: ['ib0', 'ib1'] });
  assert.deepEqual(run([row('1/99', 'ib0')]), { r: { added: 0, warnings: ['Skipped cable B-1: OSFP to 2 × QSFP56 DAC has 2 legs, not 99.'] }, b: null }, 'the count the CSV gives');
  assert.deepEqual(run([row('', 'ib0'), row('', 'ib1'), row('', 'ib2')]), { r: { added: 1, warnings: ['Skipped line 4 of cable B-1: its 2 legs are taken.'] }, b: ['ib0', 'ib1'] });
});

test('a cable schedule names its columns in other words', () => {
  const p = M.createExampleProject();
  p.cables = [];
  const lines = ['X-1,Cat6a patch cord,cn-001,eth0,sw-mgmt-a01,swp1', 'X-2,,cn-002,eth0,sw-mgmt-a01,swp2'];
  assert.deepEqual(IO.importCablesCSV(p, ['Cable,Cable type,From,From port,To,To port'].concat(lines).join('\n')), { added: 2, warnings: [] });
  assert.deepEqual(p.cables.map((c) => [c.label, c.type]), [['X-1', 'cat6a'], ['X-2', null]], '“Cable” is the label next to “Cable type”');
  p.cables = [];
  assert.deepEqual(IO.importCablesCSV(p, 'Cable,From,From port,To,To port\nX-1,cn-001,eth0,sw-mgmt-a01,swp1'), { added: 1, warnings: [] });
  assert.deepEqual(p.cables.map((c) => [c.label, c.type]), [['X-1', null]], 'and the label when there is no type column');
  p.cables = [];
  assert.deepEqual(IO.importCablesCSV(p, 'Label,Cable,From,From port,To,To port\nX-1,Cat6a patch cord,cn-001,eth0,sw-mgmt-a01,swp1'), { added: 1, warnings: [] });
  assert.deepEqual(p.cables.map((c) => [c.label, c.type]), [['X-1', 'cat6a']], '“Cable” next to “Label” is the type');
});

test('networks are created only for the cables that are added, by the name the plan keeps', () => {
  const p = M.createExampleProject();
  const names = () => p.networks.map((n) => n.name);
  const before = names();
  const r = IO.importCablesCSV(p, ['Label,Network,A device,A port,B device,B port', 'Z-1,Foo,cn-001,eth0,sw-mgmt-a01,swp40', 'Z-2,Bar,cn-001,nope,sw-mgmt-a01,swp41', 'Z-3,Baz,cn-001,ib0,cn-001,ib0'].join('\n'));
  assert.deepEqual(r, {
    added: 0,
    warnings: ['Skipped cable Z-1: cn-001 eth0 already has cable MGT-0001.', 'Skipped cable Z-2: cn-001 has no port nope.', 'Skipped cable Z-3: cn-001 ib0 already has cable IB-0001.'],
  });
  assert.deepEqual(names(), before, 'refused lines leave no networks behind');
  const long = 'A network whose name is far longer than the sixty characters a plan keeps for it';
  assert.ok(long.length > 60);
  const csv = ['Network,A device,A port,B device,B port'].concat([1, 2, 3].map((i) => `${long},sw-mgmt-a01,swp${40 + i},sw-mgmt-a02,swp${40 + i}`)).join('\n');
  assert.deepEqual(IO.importCablesCSV(p, csv), { added: 3, warnings: [] });
  assert.deepEqual(names(), before.concat([long.slice(0, 60).trim()]), 'one network for every line');
});

test('cable types and transceivers are found by name before id, and “(auto)” only marks a pick', () => {
  const ex = M.createExampleProject();
  const byLabel = (q, l) => q.cables.find((c) => c.label === l);
  const cat = C.addCableType(ex, { name: 'Cat6a', media: 'cat6a', connector: 'rj45', lengthsM: [1, 2] });
  const auto = C.addCableType(ex, { name: 'Patch (auto)', media: 'cat6a', connector: 'rj45', lengthsM: [1, 2] });
  const sr = C.addTransceiver(ex, { name: 'qsfp56-200g-sr4', connector: 'qsfp56', fiber: 'mpo', mode: 'mmf', reachM: 70 });
  C.updateCable(ex, byLabel(ex, 'MGT-0001').id, { type: cat.id });
  C.updateCable(ex, byLabel(ex, 'MGT-0002').id, { type: auto.id });
  const ib = byLabel(ex, 'IB-0026');
  C.updateCable(ex, ib.id, { type: 'mpo-om4', a: Object.assign({}, ib.a, { transceiver: sr.id }), b: Object.assign({}, ib.b, { transceiver: sr.id }) });
  const p = M.copyLayout(ex);
  p.devices = M.clone(ex.devices);
  p.cableTypes = M.clone(ex.cableTypes);
  p.transceivers = M.clone(ex.transceivers);
  assert.deepEqual(IO.importCablesCSV(p, IO.exportCablesCSV(ex)), { added: 147, warnings: [] });
  assert.deepEqual(['MGT-0001', 'MGT-0002', 'MGT-0003'].map((l) => byLabel(p, l).type), [cat.id, auto.id, null]);
  assert.deepEqual([byLabel(p, 'IB-0026').a.transceiver, byLabel(p, 'IB-0026').b.transceiver], [sr.id, sr.id]);
  // A file whose catalog uses a name twice gets a number on the second.
  const raw = JSON.parse(IO.serialize(ex));
  raw.cableTypes.find((t) => t.id === cat.id).name = 'QSFP56 DAC';
  const { project, warnings } = IO.normalizeProject(raw);
  assert.equal(M.cableTypeById(project, cat.id).name, 'QSFP56 DAC 2');
  assert.deepEqual(warnings, ['Renamed the cable type QSFP56 DAC to QSFP56 DAC 2: the name is used twice.']);
});

test('a cable schedule keeps unused legs and tells same-named devices apart by rack', () => {
  const ex = M.createExampleProject();
  const byLabel = (q, l) => q.cables.find((c) => c.label === l);
  byLabel(ex, 'IB-0043').b[0] = null;
  byLabel(ex, 'IB-0044').b[1] = null;
  ex.devices.find((d) => d.name === 'gpu-001').name = 'cn-001';
  const csv = IO.exportCablesCSV(ex);
  const p = M.copyLayout(ex);
  p.devices = M.clone(ex.devices);
  assert.deepEqual(IO.importCablesCSV(p, csv), { added: 147, warnings: [] });
  for (const l of ['IB-0043', 'IB-0044']) assert.deepEqual(byLabel(p, l).b, byLabel(ex, l).b, l);
  for (const l of ['MGT-0001', 'MGT-0013']) assert.deepEqual(byLabel(p, l).a, byLabel(ex, l).a, l);
});

test('a cable schedule at the plan’s limit reads in one pass', () => {
  const p = M.createEmptyProject(1);
  const t = M.addDeviceType(p, { label: 'Big', ports: [{ name: 'p', first: 1, count: 1024, connector: 'rj45' }] });
  for (let i = 0; i < 40; i++) p.devices.push(M.newDevice({ id: `d${i}`, type: t.id, name: `d${i}`, loc: { rack: 'r1', kind: 'u', at: i + 1 } }));
  const lines = ['A device,A port,B device,B port'];
  for (let k = 0; k <= M.LIMITS.cables; k++) {
    const i = Math.floor(k / 1024) * 2;
    lines.push(`d${i},p${(k % 1024) + 1},d${i + 1},p${(k % 1024) + 1}`);
  }
  const start = Date.now();
  const r = IO.importCablesCSV(p, lines.join('\n'));
  assert.ok(Date.now() - start < 10000, `${Date.now() - start} ms: each line is checked without reading the whole plan again`);
  assert.equal(r.added, M.LIMITS.cables);
  assert.deepEqual(r.warnings, [`Skipped line ${M.LIMITS.cables + 2}: A plan holds ${M.LIMITS.cables} cables.`]);
  assert.deepEqual([p.cables[0].label, p.cables[p.cables.length - 1].label], ['C-0001', `C-${M.LIMITS.cables}`]);

  // The same cables in a file: the first 20 000 are kept.
  const raw = JSON.parse(IO.serialize(p));
  raw.cables.push({ id: 'one-more', label: 'X', a: { device: 'd38', port: 'p1000' }, b: { device: 'd39', port: 'p1000' } });
  const read = IO.normalizeProject(raw);
  assert.equal(read.project.cables.length, M.LIMITS.cables);
  assert.deepEqual(read.warnings, [`Only the first ${M.LIMITS.cables} cables were kept.`]);
});

test('the order list exports as CSV', () => {
  const ex = M.createExampleProject();
  const lines = IO.exportOrderCSV(ex).trim().split('\r\n');
  assert.equal(lines[0], 'Item,Kind,Length (m),Count,Total (m)');
  assert.equal(lines[1], 'Cat6a patch cord,Cable,1,12,12');
  assert.ok(lines.includes('MPO-12 OM4,"Cable, made to length",4.9,4,19.6'));
  assert.deepEqual(lines.slice(-2), ['SFP+ 10G SR,Transceiver,,8,', 'QSFP56 200G SR4,Transceiver,,24,']);
  const sas = IO.exportOrderCSV(ex, ex.cables.filter((c) => c.network === 'n-sas')).trim().split('\r\n');
  assert.deepEqual(sas, ['Item,Kind,Length (m),Count,Total (m)', 'Mini-SAS HD cable,Cable,2,12,24']);
  assert.equal(C.billOfMaterials(ex).unresolved, 1);
});

test('a device CSV import into a plan keeps its cables', () => {
  const ex = M.createExampleProject();
  const csv = 'Rack,Position,Type,Name\nRack A01,U40,Compute node,cn-099\n';
  const { project: p, added } = IO.importCSV(csv, ex);
  assert.equal(added, 1);
  assert.equal(p.cables.length, 147);
  assert.deepEqual(p.networks, ex.networks);
});
