'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');
const C = require('../js/cabling.js');

const U = C.UNIT_M;
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 0.006, `${msg || ''} ${actual} ≈ ${expected}`);

/**
 * Floor 1: Row A with racks r1–r3, Row B with r4–r5; floor 2: r6. Devices
 * are named by their ids. Switches are mounted back to front, so their
 * front ports face the rack's rear like the servers' ports.
 */
function plan() {
  const p = M.createEmptyProject(3);
  M.addRow(p, 'f1', { racks: 2 });
  M.addFloor(p, { racks: 1 });
  const osfp = M.addDeviceType(p, { label: 'OSFP switch', face: 'qsfp', ports: [{ name: 'p', first: 1, count: 8, connector: 'osfp', speedGbps: 400, side: 'front' }] });
  const add = (type, rack, kind, at, id, extra) => p.devices.push(M.newDevice(Object.assign({ id, type, name: id, loc: { rack, kind, at } }, extra)));
  const sw = { reversed: true };
  add('switch-rj45', 'r1', 'u', 1, 'sw1', sw);
  add('switch-qsfp', 'r1', 'u', 2, 'leaf1', sw);
  add('switch-rj45', 'r1', 'side', 0, 'bmc1', sw);
  add('compute-node', 'r1', 'u', 10, 'n1');
  add('compute-node', 'r1', 'u', 20, 'n2');
  add('compute-node', 'r1', 'u', 22, 'n3');
  add('storage-node', 'r1', 'u', 30, 'sn1');
  add(osfp.id, 'r1', 'u', 3, 'osw', sw);
  add('switch-rj45', 'r3', 'u', 1, 'sw3', sw);
  add('switch-qsfp', 'r3', 'u', 2, 'leaf3', sw);
  add('switch-rj45', 'r4', 'u', 1, 'sw4', sw);
  add('switch-rj45', 'r6', 'u', 1, 'sw6', sw);
  assert.equal(M.layoutProblem(p), null);
  return p;
}
const end = (device, port, transceiver) => Object.assign({ device, port }, transceiver ? { transceiver } : {});
const link = (p, a, b, extra) => {
  const r = C.connect(p, Object.assign({ a, b }, extra));
  assert.ok(r.cable, r.error);
  return r.cable;
};
const codes = (p, cable) => C.describe(p, cable).issues.map((i) => i.code);
const texts = (p, cable) => C.describe(p, cable).issues.map((i) => i.text);

test('ports face the side of the rack their device turns to them', () => {
  const p = plan();
  assert.equal(C.portFace(p, end('sw1', 'swp1')), 'rear', 'front ports of a switch mounted back to front');
  assert.equal(C.portFace(p, end('n1', 'eth0')), 'rear');
  M.deviceById(p, 'sw1').reversed = false;
  assert.equal(C.portFace(p, end('sw1', 'swp1')), 'front');
  assert.equal(C.portFace(p, end('sw1', 'nope')), null);
  assert.deepEqual(C.portOf(p, end('sn1', 'ib1')), { name: 'ib1', group: 3, index: 1, connector: 'qsfp56', speedGbps: 200, side: 'rear' });
});

test('checkConnect refuses what the plan may never hold', () => {
  const p = plan();
  link(p, end('n1', 'eth0'), end('sw1', 'swp1'));
  const why = (props) => C.checkConnect(p, props);
  assert.equal(why({ a: end('n2', 'eth0'), b: end('sw1', 'swp2') }), null);
  assert.equal(why({ a: end('nope', 'eth0'), b: end('sw1', 'swp2') }), 'Unknown device “nope”');
  assert.equal(why({ a: end('n2', 'eth9'), b: end('sw1', 'swp2') }), 'n2 has no port eth9');
  assert.equal(why({ a: end('n2', 'eth0'), b: end('sw1', 'swp1') }), 'sw1 swp1 already has cable C-0001');
  assert.equal(why({ a: end('n1', 'eth0'), b: end('sw1', 'swp2') }), 'n1 eth0 already has cable C-0001');
  assert.equal(why({ a: end('n2', 'eth0'), b: end('n2', 'eth0') }), 'n2 eth0 is used twice in this cable');
  assert.equal(why({ a: end('n2', 'eth0'), b: end('n2', 'bmc') }), 'A cable cannot join n2 to itself');
  assert.equal(why({ a: end('n2', 'eth0'), b: null }), 'A cable needs two ends');
  assert.equal(why({ a: end('n2', 'eth0'), b: end('sw1', 'swp2'), type: 'nope' }), 'Unknown cable type “nope”');
  assert.equal(why({ a: end('n2', 'eth0'), b: end('sw1', 'swp2'), network: 'nope' }), 'Unknown network “nope”');
  assert.equal(why({ a: end('n2', 'ib0', 'nope'), b: end('leaf1', 'p1'), type: 'mpo-om4' }), 'Unknown transceiver “nope”');
  // Breakouts.
  const two = 'dac-osfp-2x';
  assert.equal(why({ a: end('osw', 'p1'), b: [end('n2', 'ib0'), end('n3', 'ib0')], type: two }), null);
  assert.equal(why({ a: end('osw', 'p1'), b: [end('n2', 'ib0'), null], type: two }), null, 'a leg may stay unused');
  assert.equal(why({ a: end('osw', 'p1'), b: [end('n2', 'ib0'), end('n2', 'ib0')], type: two }), 'n2 ib0 is used twice in this cable');
  assert.equal(why({ a: end('osw', 'p1'), b: [end('osw', 'p2'), end('n2', 'ib0')], type: two }), 'The legs of a breakout cable go to other devices than osw, its head');
  assert.equal(why({ a: end('osw', 'p1'), b: [end('n2', 'ib0'), end('n3', 'ib0')] }), 'A breakout cable needs a breakout cable type');
  assert.equal(why({ a: end('osw', 'p1'), b: [end('n2', 'ib0'), end('n3', 'ib0')], type: 'dac-qsfp56' }), 'A breakout cable needs a breakout cable type');
  assert.equal(why({ a: end('osw', 'p1'), b: [end('n2', 'ib0'), null, null], type: two }), 'OSFP to 2 × QSFP56 DAC has 2 legs, not 3');
  assert.equal(why({ a: end('osw', 'p1'), b: [null, null], type: two }), 'A breakout cable needs at least one leg');
  assert.equal(why({ a: end('osw', 'p1'), b: end('n2', 'ib0'), type: two }), 'OSFP to 2 × QSFP56 DAC is a breakout cable: give it its legs');
  // The plan's limit.
  const full = Object.assign({}, p, { cables: Array.from({ length: M.LIMITS.cables }, (_, i) => ({ id: `x${i}`, a: null, b: null })) });
  assert.equal(C.checkConnect(full, { a: end('n2', 'eth0'), b: end('sw1', 'swp2') }), 'A plan holds 20000 cables');
});

test('cables are connected, changed and disconnected', () => {
  const p = plan();
  const ib = C.addNetwork(p, { name: 'InfiniBand' });
  assert.equal(ib.firstLabel, 'INF-0001');
  const a = link(p, end('n1', 'ib0'), end('leaf1', 'p1'), { network: ib.id, lengthM: 2 });
  assert.deepEqual(a, { id: a.id, type: null, network: ib.id, label: 'INF-0001', lengthM: 2, notes: '', a: end('n1', 'ib0'), b: end('leaf1', 'p1') });
  assert.match(a.id, /^cb-/);
  assert.equal(link(p, end('n2', 'ib0'), end('leaf1', 'p2'), { network: ib.id }).label, 'INF-0002');
  assert.equal(link(p, end('n3', 'ib0'), end('leaf1', 'p3'), { network: ib.id, label: 'spine-7' }).label, 'spine-7', 'any label by hand');
  assert.deepEqual(C.connect(p, { a: end('n1', 'ib0'), b: end('leaf1', 'p4') }), { error: 'n1 ib0 already has cable INF-0001' });

  assert.equal(C.updateCable(p, a.id, { b: end('leaf1', 'p2') }), 'leaf1 p2 already has cable INF-0002');
  assert.equal(C.cableById(p, a.id).b.port, 'p1', 'a refused change changes nothing');
  assert.equal(C.updateCable(p, a.id, { b: end('leaf1', 'p9'), lengthM: null, notes: 'moved', type: 'aoc-qsfp56' }), null);
  assert.deepEqual(C.cableById(p, a.id), Object.assign({}, a, { b: end('leaf1', 'p9'), lengthM: null, notes: 'moved', type: 'aoc-qsfp56' }));
  assert.equal(C.updateCable(p, a.id, { a: end('n1', 'ib0') }), null, 'a cable does not block itself');
  assert.equal(C.updateCable(p, a.id, { label: '' }), null);
  assert.equal(C.cableById(p, a.id).label, 'INF-0003', 'a cleared label continues the series');
  assert.equal(C.updateCable(p, 'nope', {}), 'Unknown cable');

  const idx = C.cableIndex(p);
  assert.deepEqual(idx.get('leaf1|p9'), { cable: C.cableById(p, a.id), role: 'b', leg: null });
  assert.equal(C.cablesOfDevice(p, 'leaf1').length, 3);
  assert.equal(C.cablesWithin(p, 'r1').length, 3);
  assert.equal(C.cablesWithin(p, 'r3').length, 0);
  assert.equal(C.disconnect(p, [a.id, 'nope']), 1);
  assert.equal(C.disconnect(p, p.cables[0].id), 1);
  assert.equal(p.cables.length, 1);
});

test('breakout cables keep their legs in place and lose only the legs of deleted devices', () => {
  const p = plan();
  const bo = link(p, end('osw', 'p1'), [end('n1', 'ib0'), end('n2', 'ib0')], { type: 'dac-osfp-2x' });
  const half = link(p, end('osw', 'p2'), [null, end('n3', 'ib0')], { type: 'dac-osfp-2x' });
  assert.deepEqual(M.legsOf(half), [null, end('n3', 'ib0')]);
  assert.deepEqual(M.cableEnds(half).map((x) => [x.role, x.leg]), [['a', null], ['b', 1]]);
  assert.deepEqual(C.cableIndex(p).get('n2|ib0'), { cable: bo, role: 'b', leg: 1 });
  const d = C.describe(p, bo);
  assert.equal(d.type.id, 'dac-osfp-2x');
  assert.deepEqual(d.legSpeedsGbps, [200, 200], 'a 400G port split in two');
  assert.deepEqual(d.ends.map((e) => [e.role, e.leg, e.device.name, e.port.name]), [['a', null, 'osw', 'p1'], ['b', 0, 'n1', 'ib0'], ['b', 1, 'n2', 'ib0']]);
  assert.deepEqual(d.issues, []);

  p.devices = p.devices.filter((x) => x.id !== 'n2');
  assert.equal(M.pruneCables(p), 1);
  assert.deepEqual(bo.b, [end('n1', 'ib0'), null]);
  p.devices = p.devices.filter((x) => x.id !== 'n3');
  assert.equal(M.pruneCables(p), 1);
  assert.deepEqual(p.cables, [bo], 'a breakout without legs goes');
  p.devices = p.devices.filter((x) => x.id !== 'osw');
  M.pruneCables(p);
  assert.deepEqual(p.cables, [], 'and so does one without its head');
});

test('needed lengths follow the cable’s way through racks, trays and rows', () => {
  const p = plan();
  const need = (a, b) => C.neededLength(p, { a, b });
  const nDrop = 10 * U; // middle of U10–11
  const swDrop = 0.5 * U;
  const slack = 0.25 + 0.3 + 0.25 + 0; // rack and device at both ends
  // Same rack, both ports at the rear.
  let r = need(end('n1', 'eth0'), end('sw1', 'swp1'));
  assert.equal(r.how, 'rack');
  near(r.m, nDrop - swDrop + slack);
  assert.equal(r.m, 1.22, 'to the centimetre');
  // Front to rear adds the rack's depth.
  M.deviceById(p, 'sw1').reversed = false;
  near(need(end('n1', 'eth0'), end('sw1', 'swp1')).m, nDrop - swDrop + 1.2 + slack);
  M.deviceById(p, 'sw1').reversed = true;
  // A side slot counts at its middle: slot 1 of 2 along 47U.
  near(need(end('n1', 'bmc'), end('bmc1', 'swp1')).m, 0.25 * 47 * U - nDrop + slack);
  // Across racks: up to the tray, along the row between the racks' middles, down again.
  r = need(end('n1', 'eth0'), end('sw3', 'swp1'));
  assert.equal(r.how, 'floor');
  near(r.m, nDrop + swDrop + 0.5 + 0.5 + 1.2 + slack);
  const wide = M.addRackType(p, { name: 'Wide', units: 47, widthMm: 800 });
  assert.equal(M.setRackType(p, 'r2', wide.id), null);
  near(need(end('n1', 'eth0'), end('sw3', 'swp1')).m, nDrop + swDrop + 1 + (0.3 + 0.8 + 0.3) + slack, 'rack widths add up along the row');
  // Tray and slack set on a rack and a device.
  Object.assign(M.rackById(p, 'r1'), { trayM: 1, slackM: 0 });
  M.deviceById(p, 'n1').slackM = 0;
  near(need(end('n1', 'eth0'), end('sw3', 'swp1')).m, nDrop + swDrop + 1.5 + 1.4 + 0.25);
  Object.assign(M.rackById(p, 'r1'), { trayM: null, slackM: null });
  M.deviceById(p, 'n1').slackM = null;
  // Across rows: the floor's row pitch for every row between them.
  near(need(end('n1', 'eth0'), end('sw4', 'swp1')).m, nDrop + swDrop + 1 + 3 + slack);
  p.floors[0].rowPitchM = 2;
  near(need(end('n1', 'eth0'), end('sw4', 'swp1')).m, nDrop + swDrop + 1 + 2 + slack);
  // Across floors there is no estimate.
  assert.equal(need(end('n1', 'eth0'), end('sw6', 'swp1')), null);
  // A breakout needs its longest leg.
  const bo = { a: end('osw', 'p1'), b: [end('n1', 'ib0'), null, end('leaf3', 'p1')] };
  near(C.neededLength(p, bo).m, Math.max(need(end('osw', 'p1'), end('n1', 'ib0')).m, need(end('osw', 'p1'), end('leaf3', 'p1')).m));
  assert.equal(C.neededLength(p, { a: end('osw', 'p1'), b: [end('n1', 'ib0'), end('sw6', 'swp1')] }), null);
});

test('lengths round up to stock lengths, or to 0.1 m when made to length', () => {
  const p = plan();
  const t = (id) => M.cableTypeById(p, id);
  assert.equal(C.stockLength(t('dac-qsfp56'), 1.22), 1.5);
  assert.equal(C.stockLength(t('dac-qsfp56'), 3), 3);
  assert.equal(C.stockLength(t('dac-qsfp56'), 3.01), null);
  assert.equal(C.stockLength(t('mpo-om4'), 4.9), 4.9);
  assert.equal(C.stockLength(t('mpo-om4'), 4.91), 5);
  assert.equal(C.stockLength(t('mpo-om4'), 0.02), 0.1);
  const cable = link(p, end('n1', 'eth0'), end('sw1', 'swp1'));
  const d = C.describe(p, cable);
  assert.deepEqual([d.type.id, d.auto, d.needM, d.how, d.lengthM, d.lengthAuto], ['cat6a', true, 1.22, 'rack', 1.5, true]);
  C.updateCable(p, cable.id, { lengthM: 4 });
  const set = C.describe(p, C.cableById(p, cable.id));
  assert.deepEqual([set.needM, set.lengthM, set.lengthAuto], [1.22, 4, false], 'a length set is kept as it is');
  const fiber = link(p, end('n1', 'ib0'), end('leaf3', 'p1'), { type: 'mpo-om4' });
  const f = C.describe(p, fiber);
  assert.equal(f.lengthM, Math.ceil(f.needM * 10) / 10);
});

test('auto types: the closest plugs that reach, DAC before AOC, fiber with transceivers when nothing else reaches', () => {
  const p = plan();
  const ib = link(p, end('n1', 'ib0'), end('leaf1', 'p1'));
  const type = () => C.describe(p, C.cableById(p, ib.id)).type.id;
  assert.equal(type(), 'dac-qsfp56');
  C.updateCable(p, ib.id, { lengthM: 8 });
  assert.equal(type(), 'aoc-qsfp56', 'too long for a DAC');
  // Exact plugs win over the same family, whatever the catalog order.
  const q28 = C.addCableType(p, { name: 'QSFP28 DAC', media: 'dac', connector: 'qsfp28', speedGbps: 100, maxM: 5, lengthsM: [1, 2, 3, 5] });
  C.moveCableType(p, q28.id, 0);
  C.updateCable(p, ib.id, { lengthM: null });
  assert.equal(type(), 'dac-qsfp56');
  C.deleteCableType(p, 'dac-qsfp56');
  assert.equal(type(), 'aoc-qsfp56', 'exact plugs that reach before the same family');
  C.deleteCableType(p, 'aoc-qsfp56');
  assert.equal(type(), q28.id, 'the same family when nothing matches exactly, before fiber');
  // SFP28 to SFP+ beyond a DAC's reach: LC fiber with a transceiver at each cage.
  const eth = link(p, end('sn1', 'eth1'), end('sw3', 'swp49'));
  let d = C.describe(p, eth);
  assert.equal(d.type.id, 'dac-sfp28');
  assert.deepEqual(d.ends.map((e) => e.transceiver), [null, null]);
  C.updateCable(p, eth.id, { lengthM: 12 });
  d = C.describe(p, C.cableById(p, eth.id));
  assert.equal(d.type.id, 'lc-om4');
  assert.deepEqual(d.ends.map((e) => e.transceiver.id), ['sfp28-25g-sr', 'sfp-10g-sr'], 'an exact cage match at each end');
  assert.equal(d.speedGbps, 10);
  // Nothing in the catalog joins OSFP and RJ45.
  const none = link(p, end('osw', 'p1'), end('sw1', 'swp1'));
  d = C.describe(p, none);
  assert.equal(d.type, null);
  assert.equal(d.lengthM, null);
  assert.deepEqual(d.issues.map((i) => [i.code, i.text, i.short]), [['type', 'No cable type in the catalog joins OSFP and RJ45', 'No cable type']]);
});

test('named fiber types get their transceivers picked within reach, or use the ones chosen', () => {
  const p = plan();
  const cable = link(p, end('n1', 'ib0'), end('leaf3', 'p1'), { type: 'mpo-om4' });
  const get = () => C.describe(p, C.cableById(p, cable.id));
  assert.deepEqual(get().ends.map((e) => e.transceiver.id), ['qsfp56-200g-sr4', 'qsfp56-200g-sr4']);
  assert.deepEqual(get().issues, []);
  // Past the transceivers' reach.
  C.updateCable(p, cable.id, { lengthM: 150 });
  assert.deepEqual(get().issues.map((i) => [i.code, i.text]), [['reach', 'Set to 150 m: the QSFP56 200G SR4 reaches 100 m']]);
  const long = C.addTransceiver(p, { name: 'QSFP56 200G SR4 long', connector: 'qsfp56', fiber: 'mpo', mode: 'mmf', speedGbps: 200, reachM: 300 });
  assert.deepEqual(get().ends.map((e) => e.transceiver.id), [long.id, long.id], 'the first one that reaches');
  assert.deepEqual(get().issues, []);
  // A chosen transceiver is kept, and checked.
  C.updateCable(p, cable.id, { lengthM: null, a: end('n1', 'ib0', 'qsfp28-100g-sr4') });
  assert.equal(get().ends[0].transceiver.id, 'qsfp28-100g-sr4');
  assert.deepEqual(get().issues.map((i) => i.text), ['Runs at 100 Gb/s, not 200 Gb/s: the QSFP28 100G SR4 runs at 100 Gb/s']);
  C.updateCable(p, cable.id, { a: end('n1', 'ib0', 'sfp-10g-sr') });
  assert.deepEqual(get().issues.map((i) => [i.code, i.text, i.short]), [['optics', 'SFP+ 10G SR does not fit n1 ib0 (QSFP56)', 'Wrong optics']]);
  C.updateCable(p, cable.id, { a: end('n1', 'ib0', 'qsfp28-100g-lr4') });
  assert.deepEqual(get().issues.map((i) => i.text).slice(0, 1), ['QSFP28 100G LR4 does not take MPO multimode fiber']);
  // Without a fitting transceiver in the catalog.
  C.updateCable(p, cable.id, { a: end('n1', 'ib0') });
  p.transceivers = p.transceivers.filter((t) => !t.connector.startsWith('qsfp'));
  assert.deepEqual(get().issues.map((i) => [i.code, i.text, i.short]), [
    ['optics', 'No transceiver in the catalog fits n1 ib0 (QSFP56) and takes MPO multimode fiber', 'Optics missing'],
    ['optics', 'No transceiver in the catalog fits leaf3 p1 (QSFP56) and takes MPO multimode fiber', 'Optics missing'],
  ]);
  assert.equal(C.resolve(p, C.cableById(p, cable.id), null).type.id, 'mpo-om4');
});

test('every check says what is wrong', () => {
  const p = plan();
  const plug = link(p, end('n1', 'eth0'), end('sw1', 'swp1'), { type: 'dac-qsfp56' });
  assert.deepEqual(C.describe(p, plug).issues.map((i) => [i.code, i.level, i.text, i.short]), [
    ['plug', 'warn', 'QSFP56 DAC does not plug into n1 eth0 (RJ45)', 'Plug does not fit'],
    ['plug', 'warn', 'QSFP56 DAC does not plug into sw1 swp1 (RJ45)', 'Plug does not fit'],
  ]);
  const speed = link(p, end('sn1', 'eth1'), end('sw1', 'swp49'));
  assert.deepEqual(C.describe(p, speed).issues.map((i) => [i.code, i.level, i.text, i.short]), [
    ['speed', 'note', 'Runs at 10 Gb/s, not 25 Gb/s: sw1 swp49 is the slower end', 'Runs at 10G'],
  ]);
  const reach = link(p, end('n1', 'ib0'), end('leaf3', 'p1'), { type: 'dac-qsfp56' });
  assert.deepEqual(C.describe(p, reach).issues.map((i) => [i.code, i.text, i.short]), [['reach', 'Needs 3.5 m: a QSFP56 DAC reaches 3 m', 'Too long']]);
  assert.equal(C.describe(p, reach).lengthM, null, 'no stock length either, but one warning is enough');
  p.floors[0].rowPitchM = 20;
  const stock = link(p, end('sn1', 'eth0'), end('sw4', 'swp1'));
  const needs = C.fmtM(C.neededLength(p, stock).m, 1);
  assert.deepEqual(C.describe(p, stock).issues.map((i) => [i.code, i.text, i.short]), [['stock', `Needs ${needs}: the longest Cat6a patch cord is 20 m`, 'No stock length']]);
  const type = link(p, end('osw', 'p1'), end('sw1', 'swp2'));
  assert.deepEqual(codes(p, type), ['type']);
  const floors = link(p, end('n2', 'eth0'), end('sw6', 'swp1'));
  assert.deepEqual(C.describe(p, floors).issues.map((i) => [i.code, i.text, i.short]), [['length', 'The ends are on different floors: enter the length', 'No length']]);
  C.updateCable(p, floors.id, { lengthM: 30 });
  assert.deepEqual(codes(p, C.cableById(p, floors.id)), []);
  const short = link(p, end('n2', 'bmc'), end('sw1', 'swp3'), { lengthM: 0.5 });
  assert.deepEqual(texts(p, short), [`Set to 0.5 m but needs ${Math.round(C.neededLength(p, short).m * 10) / 10} m`]);
  const twice = link(p, end('n3', 'eth0'), end('sw1', 'swp4'), { label: 'C-0001' });
  assert.deepEqual(C.describe(p, twice).issues.map((i) => [i.code, i.text, i.short]), [['label', 'The label C-0001 is used twice', 'Label used twice']]);
  assert.deepEqual(codes(p, p.cables[0]), ['plug', 'plug', 'label'], 'both cables with the label are flagged');
});

test('the order list counts stock lengths, lengths made to measure and transceivers', () => {
  const p = M.createExampleProject();
  const bom = C.billOfMaterials(p);
  const counted = bom.cables.reduce((a, x) => a + x.count, 0) + bom.madeToLength.reduce((a, x) => a + x.lengths.reduce((b, l) => b + l.count, 0), 0);
  assert.equal(counted + bom.unresolved, p.cables.length);
  assert.equal(bom.unresolved, 1, 'the DAC that is too long');
  assert.deepEqual(bom.cables.filter((x) => x.type.id === 'lc-om4').map((x) => [x.lengthM, x.count]), [[5, 1], [7, 2], [45, 1]]);
  assert.deepEqual(bom.cables.filter((x) => x.type.id === 'dac-osfp-2x').map((x) => [x.lengthM, x.count]), [[1, 4], [1.5, 8], [3, 2]]);
  assert.deepEqual(
    bom.madeToLength.map((x) => [x.type.id, x.lengths.map((l) => [l.lengthM, l.count]), x.totalM]),
    [['mpo-om4', [[4.9, 4], [5.3, 4], [5.9, 4]], 64.4]]
  );
  assert.deepEqual(bom.transceivers.map((x) => [x.transceiver.id, x.count]), [['sfp-10g-sr', 8], ['qsfp56-200g-sr4', 24]]);
  const order = bom.cables.map((x) => p.cableTypes.indexOf(x.type));
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), 'catalog order');
  const some = C.billOfMaterials(p, p.cables.filter((c) => c.network === 'n-sas'));
  assert.deepEqual(some.cables.map((x) => [x.type.id, x.lengthM, x.count]), [['sas-hd', 2, 12]]);
  assert.deepEqual(some.transceivers, []);
});

test('series of cables pair devices in rack order with ports in port order', () => {
  const p = plan();
  link(p, end('n3', 'eth0'), end('sw1', 'swp9'));
  link(p, end('sn1', 'bmc'), end('sw1', 'swp7'));
  const mgmt = C.addNetwork(p, { name: 'Management', firstLabel: 'MGT-0001' });
  const items = C.planSeries(p, { from: ['n2', 'sn1', 'n1', 'n3'], fromPort: 'eth0', to: 'sw1', toPort: 'swp5', step: 2, network: mgmt.id });
  assert.deepEqual(items.map((x) => [x.info, x.ok, x.label, x.reason]), [
    ['n1 eth0 → sw1 swp5', true, 'MGT-0001', ''],
    ['n2 eth0 → sw1 swp11', true, 'MGT-0002', ''],
    ['n3 eth0', false, '', 'n3 eth0 already has cable C-0001'],
    ['sn1 eth0 → sw1 swp13', true, 'MGT-0003', ''],
  ], 'in rack order; swp7 and swp9 are taken, and n3 takes no port');
  assert.equal(p.cables.length, 2, 'planning changes nothing');
  const added = C.connectSeries(p, items);
  assert.deepEqual(added.map((c) => [c.label, c.network, c.b.port]), [['MGT-0001', mgmt.id, 'swp5'], ['MGT-0002', mgmt.id, 'swp11'], ['MGT-0003', mgmt.id, 'swp13']]);

  const strict = C.planSeries(p, { from: ['n1', 'n2'], fromPort: 'bmc', to: 'sw1', toPort: 'swp7', skipUsed: false, firstLabel: 'BMC-0100' });
  assert.deepEqual(strict.map((x) => [x.ok, x.label, x.reason]), [[false, '', 'sw1 swp7 already has cable C-0002'], [true, 'BMC-0100', '']]);
  const tail = C.planSeries(p, { from: ['n1', 'n2'], fromPort: 'ib0', to: 'leaf1', toPort: 'p24' });
  assert.deepEqual(tail.map((x) => [x.ok, x.reason]), [[true, ''], [false, 'No free port left on leaf1']]);
  assert.equal(C.planSeries(p, { from: ['n1'], fromPort: 'ib0', to: 'leaf1', toPort: 'p99' })[0].reason, 'leaf1 has no port p99');
  assert.equal(C.planSeries(p, { from: ['n1'], fromPort: 'ib9', to: 'leaf1' })[0].reason, 'n1 has no port ib9');

  const bo = C.planSeries(p, { from: ['n1', 'n2', 'n3'], fromPort: 'ib0', to: 'osw', toPort: 'p3', type: 'dac-osfp-2x' });
  assert.deepEqual(bo.map((x) => [x.info, x.ok]), [
    ['osw p3 → n1 ib0, n2 ib0', true],
    ['osw p4 → n3 ib0, –', true],
  ], 'each port of the target is the head of two legs');
  C.connectSeries(p, bo);
  assert.deepEqual(p.cables.slice(-1)[0].b, [end('n3', 'ib0'), null]);
  assert.equal(M.pruneCables(M.clone(p)), 0);
});

test('routes and groups follow the plan', () => {
  const p = M.createExampleProject();
  const route = (label) => C.routeOf(p, p.cables.find((c) => c.label === label));
  assert.deepEqual(route('MGT-0001'), { key: 'rack:r1', label: 'Within Rack A01', kind: 'rack' });
  assert.deepEqual(route('BMC-0013'), { key: 'racks:r1|r2', label: 'Rack A01 ⇄ A02', kind: 'row' });
  assert.deepEqual(route('MGT-0030'), { key: 'rows:row1|row2', label: 'Ground floor · Row A ⇄ Row B', kind: 'floor' });
  assert.deepEqual(route('MGT-0041'), { key: 'floors:f1|f2', label: 'Ground floor ⇄ First floor', kind: 'plan' });
  assert.equal(route('IB-0055').label, 'Rack B01 ⇄ B02', 'a breakout to two switches in one rack');

  const byRoute = C.groupCables(p, p.cables, 'route');
  assert.equal(byRoute.reduce((a, g) => a + g.cables.length, 0), p.cables.length);
  assert.deepEqual(byRoute.map((g) => [g.label, g.cables.length]), [
    ['Within Rack A01', 37],
    ['Rack A01 ⇄ A02', 8],
    ['Ground floor · Row A ⇄ Row B', 15],
    ['Within Rack A02', 25],
    ['Rack A02 ⇄ A03', 6],
    ['Within Rack A03', 21],
    ['Rack B01 ⇄ B02', 8],
    ['Rack B01 ⇄ B03', 8],
    ['Ground floor ⇄ First floor', 1],
    ['Within Rack B02', 6],
    ['Within Rack B03', 6],
    ['Within Rack 2A01', 3],
    ['Rack 2A01 ⇄ 2A02', 1],
    ['Within Rack 2A02', 2],
  ], 'by the first rack in plan order, within a rack first');
  assert.deepEqual(C.groupCables(p, p.cables, 'network').map((g) => [g.label, g.cables.length]), [['Management', 41], ['BMC', 33], ['InfiniBand', 58], ['Storage 25G', 3], ['SAS', 12]]);
  const noNet = M.clone(p);
  noNet.cables[0].network = null;
  assert.equal(C.groupCables(noNet, noNet.cables, 'network').slice(-1)[0].label, 'No network');
  const byType = C.groupCables(p, p.cables, 'type');
  assert.deepEqual(byType.map((g) => g.key), p.cableTypes.map((t) => t.id), 'in catalog order');
  const byDevice = C.groupCables(p, p.cables, 'device');
  const leaf = byDevice.find((g) => g.label === 'ib-leaf-a01');
  assert.equal(leaf.cables.length, 16, 'twelve nodes and four uplinks');
  assert.equal(byDevice[0].label, 'sw-mgmt-a01', 'in rack order');
});

test('cables are found by label, devices, ports, network, type and notes', () => {
  const p = M.createExampleProject();
  const find = (q) => p.cables.filter(C.cableMatcher(p, q)).map((c) => c.label);
  assert.deepEqual(find('ib-leaf-a01 p21'), ['IB-0031']);
  assert.deepEqual(find('riser'), ['MGT-0041']);
  assert.equal(find('mpo').length, 12, 'the type name');
  assert.equal(find('storage').length, 3, 'the network name');
  assert.deepEqual(find('ST-0002'), ['ST-0002']);
  assert.equal(C.cableMatcher(p, '  '), null);
});

test('the fabric finds leaves, cores, groups of nodes and oversubscription', () => {
  const p = M.createExampleProject();
  const names = (list) => list.map((d) => d.name);
  const f = C.fabric(p, 'n-ib');
  assert.deepEqual(names(f.leaves), ['ib-leaf-a01', 'ib-leaf-a02', 'ib-leaf-a03', 'ib-leaf-b02', 'ib-leaf-b03']);
  assert.deepEqual(names(f.cores), ['core-sw-01', 'core-sw-02']);
  assert.equal(f.switches.length, 7);
  assert.equal(f.nodes.length, 12 + 8 + 3 + 2 + 6);
  assert.deepEqual(
    f.groups.map((g) => [g.devices.length, names(g.leaves).join(' '), g.cluster, g.type, g.links]),
    [
      [12, 'ib-leaf-a01', 'c-kestrel', 'compute-node', 12],
      [8, 'ib-leaf-a02', 'c-osprey', 'compute-node', 8],
      [3, 'ib-leaf-a02 ib-leaf-a03', 'c-ceph', 'storage-node', 6],
      [2, 'ib-leaf-a03', 'c-lustre', 'storage-node', 4],
      [3, 'ib-leaf-b02', 'c-heron', 'gpu-server', 12],
      [3, 'ib-leaf-b03', 'c-heron', 'gpu-server', 12],
    ]
  );
  const ratio = (fab, name) => fab.ratios.get(p.devices.find((d) => d.name === name).id);
  assert.deepEqual(ratio(f, 'ib-leaf-a01'), { down: 2400, up: 800, ratio: 3 });
  assert.deepEqual(ratio(f, 'ib-leaf-a02'), { down: 2200, up: 800, ratio: 2.75 });
  assert.deepEqual(ratio(f, 'ib-leaf-b02'), { down: 2400, up: 800, ratio: 3 }, 'breakout legs count at their own speed');
  assert.deepEqual(f.checks, [], 'nothing above 3:1');
  const id = (name) => p.devices.find((d) => d.name === name).id;
  const pair = f.links.find((l) => l.a === id('ib-leaf-a01') && l.b === id('core-sw-01'));
  assert.deepEqual(pair, { a: id('ib-leaf-a01'), b: id('core-sw-01'), count: 2, speedGbps: 200, totalGbps: 400 });

  // Half the uplinks of a leaf gone: 6:1.
  C.disconnect(p, p.cables.filter((c) => ['IB-0033', 'IB-0034'].includes(c.label)).map((c) => c.id));
  const g = C.fabric(p, 'n-ib');
  assert.deepEqual(ratio(g, 'ib-leaf-a01'), { down: 2400, up: 400, ratio: 6 });
  assert.equal(C.fmtRatio(6), '6:1');
  assert.deepEqual(g.checks, [{ level: 'warn', device: 'ex-2', text: 'ib-leaf-a01 is oversubscribed 6:1: 2400 Gb/s down, 400 Gb/s up' }]);
  C.disconnect(p, p.cables.filter((c) => ['IB-0031', 'IB-0032'].includes(c.label)).map((c) => c.id));
  assert.deepEqual(C.fabric(p, 'n-ib').checks.map((x) => x.text), ['ib-leaf-a01 has no uplinks']);
  assert.ok(C.isSwitch(p, M.deviceById(p, 'ex-1')));
  assert.ok(!C.isSwitch(p, M.deviceById(p, 'ex-9')));
  assert.equal(C.fabric(p, null).links.length, 0, 'every example cable has a network');
});

test('cable types, transceivers and networks are kept in catalogs', () => {
  const p = M.createExampleProject();
  const t = C.addCableType(p, { name: 'QSFP56 DAC', media: 'dac', connector: 'qsfp56', maxM: 2, lengthsM: [2, 1, 1, 'x', -3] });
  assert.equal(t.id, 'ct1');
  assert.equal(t.name, 'QSFP56 DAC 2', 'names stay unique');
  assert.deepEqual(t.lengthsM, [0.1, 1, 2], 'sorted, unique, positive');
  assert.deepEqual(M.cleanCableType({ media: 'cat6a', connector: 'qsfp56' }).connector, 'rj45', 'a plug that suits the media');
  assert.equal(M.cleanCableType({ connector: 'mpo', legs: 4, connectorB: 'lc' }).name, 'MPO to 4 × LC duplex OM4');
  assert.equal(C.updateCableType(p, 'dac-osfp-2x', { legs: 4 }), '14 cables use this type, so it keeps 2 legs');
  assert.equal(C.updateCableType(p, 'lc-om4', { legs: 2 }), '4 cables use this type, so it keeps one end at each side');
  assert.equal(C.updateCableType(p, 'lc-om4', { name: 'LC OM4', maxM: 400 }), null);
  assert.equal(M.cableTypeById(p, 'lc-om4').name, 'LC OM4');
  assert.equal(C.deleteCableType(p, 'mpo-om4'), '12 cables use this type');
  assert.equal(C.cableTypeUse(p, 'cat6a'), 0, 'cables picking a type do not count');
  assert.equal(C.deleteCableType(p, 'cat6a'), null);
  assert.ok(C.moveCableType(p, t.id, 0));
  assert.equal(p.cableTypes[0].id, t.id);
  assert.ok(!C.moveCableType(p, t.id, -5));
  while (p.cableTypes.length < M.LIMITS.cableTypes) C.addCableType(p, {});
  assert.equal(C.addCableType(p, {}), null, 'at most 50');

  const tr = C.addTransceiver(p, { connector: 'qsfp112', mode: 'smf', fiber: 'lc' });
  assert.deepEqual(tr, { id: 'tr1', name: 'QSFP112 400G LR', connector: 'qsfp112', fiber: 'lc', mode: 'smf', speedGbps: 400, reachM: 100 });
  assert.equal(M.cleanTransceiver({ connector: 'rj45' }).connector, 'qsfp56', 'transceivers fit cages');
  assert.equal(C.transceiverUse(p, 'sfp-10g-sr'), 0, 'picked, not named');
  p.cables.find((c) => c.label === 'MGT-0041').a.transceiver = 'sfp-10g-sr';
  assert.equal(C.deleteTransceiver(p, 'sfp-10g-sr'), '1 cable end uses this transceiver');
  assert.equal(C.updateTransceiver(p, tr.id, { reachM: 10000 }), null);
  assert.equal(M.transceiverById(p, tr.id).reachM, 10000);
  assert.ok(C.moveTransceiver(p, tr.id, 0));
  assert.equal(C.deleteTransceiver(p, tr.id), null);

  const n = C.addNetwork(p, { name: 'Storage fabric' });
  assert.match(n.id, /^n-/);
  assert.equal(n.firstLabel, 'STO-0001');
  assert.ok(!p.networks.slice(0, -1).some((x) => x.color === n.color), 'a color no other network has');
  assert.equal(C.addNetwork(p).name, 'Network 7');
  assert.equal(C.updateNetwork(p, n.id, { name: 'Ceph', color: 'nope' }), null);
  assert.deepEqual([M.networkById(p, n.id).name, M.networkById(p, n.id).color, M.networkById(p, n.id).firstLabel], ['Ceph', n.color, 'STO-0001']);
  assert.equal(C.deleteNetwork(p, 'n-sas'), 12);
  assert.ok(p.cables.every((c) => c.network !== 'n-sas'));
  assert.equal(M.pruneCables(p), 0);
  while (p.networks.length < M.LIMITS.networks) C.addNetwork(p);
  assert.equal(C.addNetwork(p), null, 'at most 30');
});

test('formats', () => {
  assert.equal(C.fmtM(2.5), '2.5 m');
  assert.equal(C.fmtM(3.456, 1), '3.5 m');
  assert.equal(C.fmtM(null), '–');
  assert.equal(C.fmtSpeed(0.1), '100 Mb/s');
  assert.equal(C.fmtSpeed(25), '25 Gb/s');
  assert.equal(C.shortSpeed(400), '400G');
  assert.equal(C.fmtRatio(2.75), '2.8:1');
  assert.equal(C.fmtRatio(null), '–');
});
