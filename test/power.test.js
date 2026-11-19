'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');
const P = require('../js/power.js');

const PDU_3P = M.TYPE_TEMPLATES.find((t) => t.label === '0U PDU 3P 30');
const GPU = M.TYPE_TEMPLATES.find((t) => t.label === 'GPU server');

/**
 * Rack A01 of the design: two three-phase PDUs on Grid A and Grid B, two
 * switches and twelve compute nodes, each with psu1 on PDU a and psu2 on
 * PDU b at the same outlet. Rack A02 has PDUs and nothing on them.
 */
function example() {
  const p = M.createEmptyProject(2);
  P.addGrid(p, { name: 'Grid A' }).id = 'pg-a';
  P.addGrid(p, { name: 'Grid B' }).id = 'pg-b';
  M.addDeviceType(p, PDU_3P).id = 't-pdu';
  M.addDeviceType(p, GPU).id = 'gpu';
  M.updateRackType(p, 'rack-47', { defaultPdu: 't-pdu' });
  M.fillPduSlots(p, ['r1', 'r2']);
  const add = (type, name, at, rack) => p.devices.push(M.newDevice({ id: name, type, name, loc: { rack: rack || 'r1', kind: 'u', at } }));
  add('switch-rj45', 'sw-mgmt-a01', 1);
  add('switch-qsfp', 'ib-leaf-a01', 2);
  for (let i = 0; i < 12; i++) add('compute-node', `cn-${String(i + 1).padStart(3, '0')}`, 4 + 2 * i);
  const outlets = [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17];
  p.devices.filter((d) => d.loc.kind === 'u').forEach((d, i) => {
    for (const [inlet, pdu] of [['psu1', 'pdu-a01-a'], ['psu2', 'pdu-a01-b']]) {
      const r = P.connect(p, { inlet: { device: d.id, inlet }, outlet: { device: pduId(p, pdu), outlet: String(outlets[i]) } });
      assert.ok(r.cord, r.error);
    }
  });
  return p;
}
const pduId = (p, name) => p.devices.find((d) => d.name === name).id;
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 0.005, `${msg || ''} ${actual} is not ${expected}`);

test('grids are added, renamed, recolored and deleted; their PDUs stay without a grid', () => {
  const p = M.createEmptyProject(1);
  const a = P.addGrid(p);
  const b = P.addGrid(p, { note: 'UPS 2, room 0.14' });
  assert.deepEqual([a.name, a.color, b.name, b.color, b.note], ['Grid A', '#d1453b', 'Grid B', '#2b6cd4', 'UPS 2, room 0.14']);
  assert.equal(P.updateGrid(p, b.id, { name: 'grid a' }), 'Another power grid is named grid a');
  assert.equal(P.updateGrid(p, b.id, { name: 'Utility', color: '#123', note: 'no UPS' }), null);
  assert.deepEqual(p.powerGrids[1], { id: b.id, name: 'Utility', color: '#112233', note: 'no UPS' });
  assert.equal(P.updateGrid(p, b.id, { name: '', color: 'red' }), null);
  assert.deepEqual([p.powerGrids[1].name, p.powerGrids[1].color], ['Utility', '#112233'], 'a name or color that is none keeps the old one');
  for (let i = 0; i < 10; i++) assert.ok(P.addGrid(p));
  assert.equal(P.addGrid(p), null, 'a plan has twelve grids');
  assert.equal(new Set(p.powerGrids.map((g) => g.color)).size, 12);
  M.addDeviceType(p, PDU_3P).id = 't-pdu';
  p.devices.push(M.newDevice({ id: 'pdu', type: 't-pdu', name: 'pdu', grid: a.id, loc: { rack: 'r1', kind: 'pdu', at: 0 } }), M.newDevice({ id: 'cn', type: 'compute-node', name: 'cn', loc: { rack: 'r1', kind: 'u', at: 1 } }));
  assert.equal(P.setGrid(p, 'pdu', b.id), null);
  assert.equal(P.setGrid(p, 'pdu', 'nope'), 'Unknown power grid');
  assert.equal(P.setGrid(p, 'cn', a.id), 'Only a PDU is fed by a power grid');
  assert.deepEqual([...P.gridUse(p)], [[b.id, 1]]);
  assert.equal(P.deleteGrid(p, b.id), 1);
  assert.equal(M.deviceById(p, 'pdu').grid, null);
  assert.equal(P.moveGrid(p, a.id, 3), true);
  assert.equal(p.powerGrids[3].id, a.id);
  assert.deepEqual(P.setPowerSettings(p, { limitPct: 150, powerFactor: 0.9 }), { powerFactor: 0.9, limitPct: 100 });
});

test('cord types are a catalog; one that a cord names cannot be deleted', () => {
  const p = example();
  const t = P.addCordType(p, { name: 'C14–C13 cord', outlet: 'C19', inlet: 'c14', lengthsM: [2, 1, 1, 'x'] });
  assert.deepEqual([t.name, t.outlet, t.inlet, t.maxA, t.lengthsM], ['C14–C13 cord 2', 'c19', 'c14', 10, [1, 2]]);
  assert.equal(P.updateCordType(p, t.id, { name: 'C20–C19 cord', maxA: 16 }), null);
  assert.equal(M.cordTypeById(p, t.id).name, 'C20–C19 cord 2');
  assert.equal(P.updateCord(p, p.powerCords[0].id, { type: 'c14-c13' }), null);
  assert.equal(P.cordTypeUse(p, 'c14-c13'), 1);
  assert.equal(P.deleteCordType(p, 'c14-c13'), '1 cord uses this type');
  assert.equal(P.deleteCordType(p, t.id), null);
  assert.equal(P.moveCordType(p, 'c20-c19', 0), true);
  assert.deepEqual(p.cordTypes.map((x) => x.id), ['c20-c19', 'c14-c13']);
});

test('connect adds a labeled cord and refuses what the plan never holds', () => {
  const p = example();
  assert.equal(p.powerCords.length, 28);
  assert.deepEqual([p.powerCords[0].label, p.powerCords[27].label], ['P-0001', 'P-0028']);
  const a = pduId(p, 'pdu-a01-a');
  p.devices.push(M.newDevice({ id: 'far', type: 'compute-node', name: 'far', loc: { rack: 'r2', kind: 'u', at: 1 } }));
  assert.deepEqual(P.connect(p, { inlet: { device: 'far', inlet: 'psu1' }, outlet: { device: a, outlet: '20' } }), { error: 'far and pdu-a01-a are in different racks: a power cord stays in its rack' });
  assert.equal(P.checkConnect(p, { inlet: { device: 'cn-001', inlet: 'psu1' }, outlet: { device: a, outlet: '20' } }), 'cn-001 psu1 already has cord P-0005');
  assert.equal(P.checkConnect(p, { inlet: { device: 'cn-001', inlet: 'psu1' }, outlet: { device: a, outlet: '20' } }, p.powerCords[4].id), null, 'a cord may move to another outlet');
  assert.equal(P.updateCord(p, p.powerCords[4].id, { outlet: { device: a, outlet: '1' } }), 'Outlet 1 of pdu-a01-a already has cord P-0001');
  assert.equal(P.updateCord(p, p.powerCords[4].id, { label: ' Mine ', lengthM: 2, color: '#0F0', notes: 'n', outlet: { device: a, outlet: '20' } }), null);
  assert.deepEqual(p.powerCords[4], { id: p.powerCords[4].id, label: 'Mine', type: null, lengthM: 2, color: '#00ff00', notes: 'n', inlet: { device: 'cn-001', inlet: 'psu1' }, outlet: { device: a, outlet: '20' } });
  const r = P.connect(p, { inlet: { device: 'far', inlet: 'psu1' }, outlet: { device: pduId(p, 'pdu-a02-a'), outlet: '1' }, label: 'P-0003' });
  assert.equal(r.cord.label, 'P-0003', 'a label given is kept');
  assert.equal(P.updateCord(p, r.cord.id, { label: '  ' }), null);
  assert.match(P.cordById(p, r.cord.id).label, /^P-\d{4}$/, 'a label emptied continues the series');
  assert.notEqual(P.cordById(p, r.cord.id).label, 'P-0003');
  assert.equal(P.unplug(p, ['cn-001']), 2);
  assert.equal(P.disconnect(p, [r.cord.id, 'nope']), 1);
  assert.equal(p.powerCords.length, 26);
});

test('a cord needs the height between inlet and outlet, 0.3 m across and 0.15 m of slack at each end, and takes the next stock length', () => {
  const p = example();
  const ctx = P.context(p);
  // The 42U PDU is centered in the 47U rack: it starts 2.5 U down, and its 30 outlets are 1.4 U apart.
  assert.deepEqual(P.pduSpan(p, p.devices[0]), [2.5, 42]);
  const c = p.powerCords.find((x) => x.inlet.device === 'cn-012' && x.inlet.inlet === 'psu1');
  assert.equal(c.outlet.outlet, '17');
  const inlet = (26 - 1 + 1) * P.UNIT_M;
  const outlet = (2.5 + 16.5 * 1.4) * P.UNIT_M;
  near(P.neededLength(p, c, ctx), Math.abs(inlet - outlet) + 0.3 + 0.3);
  const r = P.describe(p, c, ctx);
  assert.deepEqual([r.type.id, r.typeAuto, r.neededM, r.lengthM, r.lengthAuto, r.issues], ['c14-c13', true, 0.62, 1, true, []]);
  assert.deepEqual([r.device.name, r.pdu.name, r.inlet.connector, r.outlet.connector, r.fuse.name, r.fuse.phase, r.meter.name, r.grid.name, r.color, r.colorName], ['cn-012', 'pdu-a01-a', 'c14', 'c13', 'CB4', 'L2', 'M2', 'Grid A', '#d1453b', 'Grid A']);
  assert.equal(P.stockLength(r.type, 0.6), 0.6);
  assert.equal(P.stockLength(r.type, 3.01), null);
  assert.equal(P.stockLength({ lengthsM: [] }, 0.62), 0.7, 'a type without stock lengths: the next 0.1 m');
  // A length given by hand that is too short, and a cord past the longest stock length.
  const now = () => P.cordById(p, c.id);
  P.updateCord(p, c.id, { lengthM: 0.5, color: '#00ff00' });
  const short = P.describe(p, now());
  assert.deepEqual(short.issues, [{ kind: 'length', title: 'Cord too short', text: 'Needs 0.62 m, the cord is 0.5 m' }]);
  assert.deepEqual([short.lengthAuto, short.color, short.colorName], [false, '#00ff00', '#00ff00']);
  P.updateCord(p, c.id, { lengthM: null });
  P.updateCordType(p, 'c14-c13', { lengthsM: [0.5] });
  assert.deepEqual(P.describe(p, now()).issues, [{ kind: 'length', title: 'No stock length', text: 'Needs 0.62 m, the longest C14–C13 cord is 0.5 m' }]);
  // Auto takes a type with a stock length that reaches first.
  const long = P.addCordType(p, { name: 'Long C14–C13', outlet: 'c13', inlet: 'c14', lengthsM: [2] });
  assert.deepEqual([P.describe(p, now()).type.id, P.describe(p, now()).lengthM], [long.id, 2]);
});

test('a plug fits when a cord type joins the outlet and the inlet', () => {
  const p = example();
  const a = pduId(p, 'pdu-a01-a');
  const c = P.connect(p, { inlet: { device: 'cn-001', inlet: 'psu1' }, outlet: { device: a, outlet: '5' } });
  assert.equal(c.error, 'cn-001 psu1 already has cord P-0005');
  P.unplug(p, ['cn-001']);
  const { id } = P.connect(p, { inlet: { device: 'cn-001', inlet: 'psu1' }, outlet: { device: a, outlet: '5' } }).cord;
  const read = () => P.describe(p, P.cordById(p, id));
  assert.deepEqual(read().issues, [{ kind: 'fit', title: 'Plug does not fit', text: 'C14 inlet on a C19 outlet: no cord type joins them' }]);
  assert.equal(read().type, null);
  P.updateCord(p, id, { type: 'c14-c13' });
  assert.deepEqual(read().issues, [{ kind: 'fit', title: 'Plug does not fit', text: 'C14–C13 cord on a C14 inlet on a C19 outlet' }]);
  P.updateCord(p, id, { type: null });
  P.addCordType(p, { name: 'C20–C13 cord', outlet: 'c19', inlet: 'c14', maxA: 10 });
  assert.deepEqual([read().type.name, read().issues], ['C20–C13 cord', []]);
  assert.deepEqual(P.fittingTypes(p, 'c19', 'c20').map((t) => t.id), ['c20-c19']);
});

test('a device’s power divides equally over its live inlets with a cord, in every scenario', () => {
  const p = example();
  const load = P.loads(p);
  assert.deepEqual(load.scenarios.map((s) => [s.id, s.name]), [[P.UP, 'All grids up'], ['pg-a', 'Grid A down'], ['pg-b', 'Grid B down']]);
  assert.equal(load.limit, 0.8);
  const cn = load.devices.get('cn-004');
  assert.deepEqual([cn.powerW, cn.corded, cn.grids, cn.off, cn.inlets.map((x) => [x.name, x.pdu.name, x.grid])], [700, 2, ['pg-a', 'pg-b'], [], [['psu1', 'pdu-a01-a', 'pg-a'], ['psu2', 'pdu-a01-b', 'pg-b']]]);
  const [c1, c2] = cn.inlets.map((x) => x.cord.id);
  assert.deepEqual(load.cords.get(c1).w, { [P.UP]: 350, 'pg-b': 700 }, 'on Grid A: nothing when it is down, all of it when Grid B is');
  assert.deepEqual(load.cords.get(c2).w, { [P.UP]: 350, 'pg-a': 700 });
  assert.deepEqual([P.cordW(load, c1), P.cordW(load, c1, 'pg-a'), P.cordDownW(load, c1), P.cordDownW(load, 'nope')], [350, 0, 700, 0]);

  const a = load.pdus[0];
  assert.deepEqual([a.pdu.name, a.grid.name, a.capacityW], ['pdu-a01-a', 'Grid A', 3 * 230 * 32]);
  assert.deepEqual(a.total.w, { [P.UP]: 4450, 'pg-a': 0, 'pg-b': 8900 });
  assert.deepEqual([a.total.upW, a.total.downW, a.total.worstW, a.total.worst, a.total.ratingW, a.total.over], [4450, 8900, 8900, 'pg-b', 22080, false]);
  near(a.total.use, 8900 / 22080);
  // Amperes are watts / (volts per phase × power factor).
  const fuses = a.phases.flatMap((ph) => ph.fuses.map((f) => [f.fuse.name, ph.phase, f.value.upW, f.value.downW]));
  assert.deepEqual(fuses, [['CB1', 'L1', 950, 1900], ['CB2', 'L1', 1400, 2800], ['CB3', 'L2', 1400, 2800], ['CB4', 'L2', 700, 1400], ['CB5', 'L3', 0, 0], ['CB6', 'L3', 0, 0]]);
  const l1 = a.phases[0].value;
  near(l1.upA, 2350 / 230);
  near(l1.downA, 4700 / 230);
  assert.deepEqual([l1.ratingA, l1.worst, l1.over], [32, 'pg-b', false]);
  near(a.phases[0].fuses[1].value.use, 2800 / 230 / 16);
  // PDU b mirrors it, with Grid A down as its worst.
  assert.deepEqual(load.pdus[1].total.w, { [P.UP]: 4450, 'pg-a': 8900, 'pg-b': 0 });
  assert.equal(load.pdus[1].total.worst, 'pg-a');
  assert.deepEqual(load.pdus[2].total.w, { [P.UP]: 0, 'pg-a': 0, 'pg-b': 0 }, 'a PDU without cords carries nothing');

  // A power factor of 0.9 raises the amperes, and lowers what a PDU can carry.
  P.setPowerSettings(p, { powerFactor: 0.9, limitPct: 50 });
  const pf = P.loads(p).pdus[0];
  near(pf.phases[0].value.downA, 4700 / (230 * 0.9));
  near(pf.capacityW, 22080 * 0.9);
  assert.equal(pf.phases[0].value.over, true, '22.7 A is past half of 32 A');
});

test('an inlet without a cord takes no share; a device with one feed is off when its grid is; a PDU without a grid always has power', () => {
  const p = example();
  const cn = (name) => P.loads(p).devices.get(name);
  // One of two cords: the other inlet carries all of it.
  const [c1, c2] = cn('cn-001').inlets.map((x) => x.cord.id);
  P.disconnect(p, [c2]);
  assert.deepEqual(P.loads(p).cords.get(c1).w, { [P.UP]: 700, 'pg-b': 700 });
  assert.deepEqual([cn('cn-001').corded, cn('cn-001').grids, cn('cn-001').off], [1, ['pg-a'], ['pg-a']]);
  // Both inlets on Grid A: half each, and nothing when Grid A is down.
  const a = pduId(p, 'pdu-a01-a');
  const { cord } = P.connect(p, { inlet: { device: 'cn-001', inlet: 'psu2' }, outlet: { device: a, outlet: '21' } });
  assert.deepEqual(P.loads(p).cords.get(cord.id).w, { [P.UP]: 350, 'pg-b': 350 });
  // The PDU without a grid: its cords are live in every scenario.
  P.setGrid(p, a, null);
  const load = P.loads(p);
  assert.deepEqual(load.cords.get(c1).w, { [P.UP]: 350, 'pg-a': 350, 'pg-b': 350 });
  assert.deepEqual(cn('cn-002').grids, ['', 'pg-b']);
  assert.deepEqual(load.cords.get(cn('cn-002').inlets[0].cord.id).w, { [P.UP]: 350, 'pg-a': 350, 'pg-b': 700 });
  // Four inlets on two grids: a quarter each, a half each with one grid down.
  p.devices.push(M.newDevice({ id: 'gpu-1', type: 'gpu', name: 'gpu-1', loc: { rack: 'r2', kind: 'u', at: 4 } }));
  const plan = P.planSeries(p, ['gpu-1']);
  assert.deepEqual(plan.items.map((x) => [x.inlet.inlet, M.deviceById(p, x.outlet.device).name, x.outlet.outlet]), [['psu1', 'pdu-a02-a', '5'], ['psu2', 'pdu-a02-b', '5'], ['psu3', 'pdu-a02-a', '10'], ['psu4', 'pdu-a02-b', '10']]);
  const made = P.connectSeries(p, plan.items);
  assert.equal(made.cords.length, 4);
  assert.deepEqual(P.loads(p).cords.get(made.cords[0].id).w, { [P.UP]: 750, 'pg-b': 1500 });
  // A plan without grids has one scenario, and "one down" is all up.
  p.powerGrids = [];
  M.pruneCords(p);
  const none = P.loads(p);
  assert.deepEqual(none.scenarios.map((s) => s.id), [P.UP]);
  assert.deepEqual([none.pdus[2].total.upW, none.pdus[2].total.downW, none.pdus[2].total.down, none.pdus[2].total.worst], [1500, 1500, P.UP, P.UP]);
});

test('planSeries takes inlet 1 to the first PDU and inlet 2 to the second, on the fuse group with the least load', () => {
  const p = example();
  P.unplug(p, ['cn-011', 'cn-012']);
  const plan = P.planSeries(p, ['cn-012', 'cn-011', 'sw-mgmt-a01']);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.items.map((x) => [x.inlet.device, x.inlet.inlet, M.deviceById(p, x.outlet.device).name, x.outlet.outlet]), [
    ['cn-011', 'psu1', 'pdu-a01-a', '16'],
    ['cn-011', 'psu2', 'pdu-a01-b', '16'],
    ['cn-012', 'psu1', 'pdu-a01-a', '21'],
    ['cn-012', 'psu2', 'pdu-a01-b', '21'],
  ]);
  const before = JSON.stringify(p);
  assert.equal(P.connectSeries(p, plan.items.concat([plan.items[0]])).error, 'cn-011 psu1 already has cord P-0025');
  assert.equal(JSON.stringify(p), before, 'all or none');
  // No PDU in the rack, or no cord type that joins the inlet to an outlet.
  p.devices = p.devices.filter((d) => d.loc.rack !== 'r2');
  p.devices.push(M.newDevice({ id: 'lone', type: 'compute-node', name: 'lone', loc: { rack: 'r2', kind: 'u', at: 1 } }), M.newDevice({ id: 'gpu-1', type: 'gpu', name: 'gpu-1', loc: { rack: 'r1', kind: 'u', at: 40 } }));
  P.updateCordType(p, 'c20-c19', { outlet: 'c5' });
  const odd = P.planSeries(p, ['lone', 'gpu-1']);
  assert.deepEqual(odd.items, []);
  assert.deepEqual(odd.skipped.map((s) => `${s.inlet} of ${s.device.name}: ${s.why}`).slice(0, 3), ['psu1', 'psu2', 'psu3'].map((n) => `${n} of gpu-1: no cord type joins a C20 inlet to an outlet of its rack’s PDUs`));
  assert.equal(odd.skipped[4].why, 'its rack has no PDU');
});

test('checks name what is over the limit, not redundant, not connected or does not fit', () => {
  const p = example();
  const texts = (rackIds) => P.checks(p, rackIds).map((c) => `${c.title}: ${c.text}`);
  assert.deepEqual(texts(), ['Phases not balanced: pdu-a01-a: L3 has no load, L1 has 20.4 A', 'Phases not balanced: pdu-a01-b: L3 has no load, L1 has 20.4 A']);
  assert.deepEqual(P.checks(p)[0], { kind: 'balance', level: 'note', title: 'Phases not balanced', text: 'pdu-a01-a: L3 has no load, L1 has 20.4 A', pdu: pduId(p, 'pdu-a01-a') });
  assert.deepEqual(texts(new Set(['r2'])), []);

  // A fuse group past 80 % of its rating with Grid B down: 3 500 W on CB2 is 15.2 A of 16 A.
  const a = pduId(p, 'pdu-a01-a');
  const b = pduId(p, 'pdu-a01-b');
  M.deviceById(p, 'cn-003').powerW = 1400;
  assert.deepEqual(texts().slice(0, 2), ['Fuse over 80 %: CB2 of pdu-a01-a: 15.2 A of 16 A when Grid B is down', 'Fuse over 80 %: CB2 of pdu-a01-b: 15.2 A of 16 A when Grid A is down']);
  assert.deepEqual(P.checks(p)[0].fuse, 'CB2');
  // An outlet over its rating: a C13 carries 10 A.
  M.deviceById(p, 'cn-003').powerW = 2400;
  assert.ok(texts().includes('Outlet over its rating: C13 outlet, 10 A: P-0009 carries 10.4 A when Grid B is down'));
  M.deviceById(p, 'cn-003').powerW = null;
  // The phase and the PDU over the limit.
  P.setPowerSettings(p, { limitPct: 40 });
  assert.deepEqual(texts().filter((t) => /^(Phase|PDU) over/.test(t)), [
    'Phase over 40 %: L1 of pdu-a01-a: 20.4 A of 32 A when Grid B is down',
    'Phase over 40 %: L2 of pdu-a01-a: 18.3 A of 32 A when Grid B is down',
    'Phase over 40 %: L1 of pdu-a01-b: 20.4 A of 32 A when Grid A is down',
    'Phase over 40 %: L2 of pdu-a01-b: 18.3 A of 32 A when Grid A is down',
    'PDU over 40 %: pdu-a01-a: 8.9 kW of 22.1 kW when Grid B is down',
    'PDU over 40 %: pdu-a01-b: 8.9 kW of 22.1 kW when Grid A is down',
  ]);
  P.setPowerSettings(p, { limitPct: 80 });

  // No redundancy, an inlet without a cord, a PDU without a grid.
  P.unplug(p, ['cn-012']);
  P.connect(p, { inlet: { device: 'cn-012', inlet: 'psu1' }, outlet: { device: a, outlet: '21' } });
  P.connect(p, { inlet: { device: 'cn-012', inlet: 'psu2' }, outlet: { device: a, outlet: '22' } });
  P.unplug(p, ['cn-011']);
  P.connect(p, { inlet: { device: 'cn-011', inlet: 'psu1' }, outlet: { device: a, outlet: '16' } });
  P.setGrid(p, pduId(p, 'pdu-a02-b'), null);
  assert.deepEqual(texts().filter((t) => !/balanced/.test(t)), [
    'No redundancy: All live inlets of cn-012 are on Grid A',
    'PDU without a grid: pdu-a02-b: its load counts under “No grid”',
    'Inlet without a cord: psu2 of cn-011 has no cord',
  ]);
  assert.deepEqual(P.checks(p).find((c) => c.kind === 'inlet').device, 'cn-011');
  // A type that draws power but has no inlets, a plug that does not fit, a cord that is too short.
  M.addDeviceType(p, { label: 'BMC switch', height: 1, powerW: 60 }).id = 'bmc';
  p.devices.push(M.newDevice({ id: 'bmc-1', type: 'bmc', name: 'bmc-1', loc: { rack: 'r1', kind: 'u', at: 40 } }), M.newDevice({ id: 'bmc-2', type: 'bmc', name: 'bmc-2', loc: { rack: 'r1', kind: 'u', at: 41 } }));
  P.connect(p, { inlet: { device: 'cn-011', inlet: 'psu2' }, outlet: { device: b, outlet: '5' } });
  P.updateCord(p, p.powerCords[0].id, { lengthM: 0.2 });
  assert.deepEqual(texts().filter((t) => /^(No inlets|Plug|Cord)/.test(t)), [
    'Plug does not fit: P-0030: C14 inlet on a C19 outlet: no cord type joins them',
    'Cord too short: P-0001: Needs 0.72 m, the cord is 0.2 m',
    'No inlets: Type “BMC switch” draws 60 W, but has no inlets (2 devices)',
  ]);
  assert.deepEqual(P.typesWithoutInlets(p).map((x) => [x.type.id, x.count]), [['bmc', 2]]);
  assert.deepEqual(P.checks(p, new Set(['r2'])).map((c) => c.kind), ['grid'], 'checks keep to the racks asked for');
});

test('the schedule lists cords by rack, PDU and outlet, in groups, and the order list counts them by type, length and color', () => {
  const p = example();
  const rows = P.scheduleRows(p, P.sortCords(p, p.powerCords));
  assert.equal(rows.length, 28);
  assert.deepEqual(rows.slice(0, 3).map((r) => [r.cord.label, r.device.name, r.cord.inlet.inlet, r.pdu.name, r.slot, r.cord.outlet.outlet, r.fuse.name, r.fuse.phase, r.meter.name, r.type.name, r.lengthM, r.drawW, r.downW, r.pos.rack.name]), [
    ['P-0001', 'sw-mgmt-a01', 'psu1', 'pdu-a01-a', 'P1', '1', 'CB1', 'L1', 'M1', 'C14–C13 cord', 1, 75, 150, 'Rack A01'],
    ['P-0003', 'ib-leaf-a01', 'psu1', 'pdu-a01-a', 'P1', '2', 'CB1', 'L1', 'M1', 'C14–C13 cord', 1, 175, 350, 'Rack A01'],
    ['P-0005', 'cn-001', 'psu1', 'pdu-a01-a', 'P1', '3', 'CB1', 'L1', 'M1', 'C14–C13 cord', 1, 350, 700, 'Rack A01'],
  ]);
  assert.deepEqual(P.groupCords(p, p.powerCords, 'pdu').map((g) => [g.label, g.cords.length]), [['pdu-a01-a · Rack A01 · P1', 14], ['pdu-a01-b · Rack A01 · P2', 14]]);
  assert.deepEqual(P.groupCords(p, p.powerCords, 'grid').map((g) => [g.label, g.cords.length]), [['Grid A', 14], ['Grid B', 14]]);
  assert.deepEqual(P.groupCords(p, p.powerCords, 'device').slice(0, 2).map((g) => [g.label, g.cords.map((c) => c.label)]), [['sw-mgmt-a01', ['P-0001', 'P-0002']], ['ib-leaf-a01', ['P-0003', 'P-0004']]]);
  assert.deepEqual(P.groupCords(p, p.powerCords, 'type').map((g) => [g.label, g.cords.length]), [['C14–C13 cord', 28]]);
  assert.deepEqual(P.groupCords(p, p.powerCords, 'none').map((g) => g.cords.length), [28]);
  assert.deepEqual(P.groupCords(p, [], 'none'), []);
  assert.deepEqual(P.cordsWithin(p, new Set(['r2'])), []);
  assert.equal(P.cordsWithin(p, new Set(['r1'])).length, 28);
  P.updateCord(p, p.powerCords[0].id, { lengthM: 2 });
  P.updateCord(p, p.powerCords[1].id, { color: '#00ff00' });
  assert.deepEqual(P.orderList(p, p.powerCords).map((l) => [l.name, l.lengthM, l.colorName, l.count, l.estimated]), [
    ['C14–C13 cord', 0.6, 'Grid A', 1, 1],
    ['C14–C13 cord', 0.6, 'Grid B', 1, 1],
    ['C14–C13 cord', 1, '#00ff00', 1, 1],
    ['C14–C13 cord', 1, 'Grid A', 12, 12],
    ['C14–C13 cord', 1, 'Grid B', 12, 12],
    ['C14–C13 cord', 2, 'Grid A', 1, 0],
  ]);
  const match = P.cordMatcher(p, 'cn-004 grid b');
  assert.deepEqual(p.powerCords.filter(match).map((c) => c.label), ['P-0012']);
  assert.equal(P.cordMatcher(p, '  '), null);
  assert.deepEqual(P.outletsOf(p, p.devices[0]).slice(0, 5).map((o) => [o.name, o.connector, o.fuse.name, o.meter.name, o.device && o.device.name, o.inlet]), [
    ['1', 'c13', 'CB1', 'M1', 'sw-mgmt-a01', 'psu1'],
    ['2', 'c13', 'CB1', 'M1', 'ib-leaf-a01', 'psu1'],
    ['3', 'c13', 'CB1', 'M1', 'cn-001', 'psu1'],
    ['4', 'c13', 'CB1', 'M1', 'cn-002', 'psu1'],
    ['5', 'c19', 'CB1', 'M1', null, null],
  ]);
  assert.deepEqual([P.fmtW(350), P.fmtW(1250), P.fmtA(14.26), P.fmtKw(22080), P.fmtM(1.5), P.fmtM(null)], ['350 W', '1.25 kW', '14.3 A', '22.1 kW', '1.5 m', '–']);
});

test('typeChangeImpact names the cords a change of a device’s type would unplug, and leaves the plan as it is', () => {
  const p = example();
  const gpu = M.newDevice({ id: 'gpu-1', type: 'gpu', name: 'gpu-1', loc: { rack: 'r2', kind: 'u', at: 10 } });
  p.devices.push(gpu);
  const inlets = M.expandInlets(M.typeOf(p, 'gpu')).map((i) => i.name);
  assert.deepEqual(inlets, ['psu1', 'psu2', 'psu3', 'psu4']);
  // The GPU server's four C20 inlets on the C19 outlets of the PDUs of Rack A02.
  const made = inlets.map((inlet, i) => P.connect(p, { inlet: { device: 'gpu-1', inlet }, outlet: { device: pduId(p, i % 2 ? 'pdu-a02-b' : 'pdu-a02-a'), outlet: String(i < 2 ? 5 : 10) } }));
  assert.ok(made.every((r) => r.cord), made.map((r) => r.error).join());
  const labels = made.map((r) => r.cord.label);
  const two = M.addDeviceType(p, Object.assign({}, GPU, { label: 'GPU server, two supplies', inlets: [{ name: 'psu', first: 1, count: 2, connector: 'c20' }] }));
  const shelf = M.addDeviceType(p, { label: 'Shelf', height: 4, ports: [], inlets: [] });
  const before = JSON.stringify(p);
  assert.deepEqual(P.typeChangeImpact(p, 'gpu-1', two.id).map((c) => c.label), labels.slice(2), 'psu3 and psu4 have no place');
  assert.deepEqual(P.typeChangeImpact(p, 'gpu-1', shelf.id).map((c) => c.label), labels);
  assert.deepEqual(P.typeChangeImpact(p, 'gpu-1', 'gpu'), [], 'its own type');
  assert.deepEqual(P.typeChangeImpact(p, 'cn-001', 'switch-rj45'), [], 'the same inlets');
  assert.deepEqual(P.typeChangeImpact(p, 'cn-001', shelf.id), [], 'a shelf of 4 units does not fit there: nothing changes');
  assert.equal(JSON.stringify(p), before);
  // What it names is what the change unplugs.
  assert.equal(M.setDeviceType(p, 'gpu-1', two.id), null);
  assert.deepEqual(M.cordsOf(p, ['gpu-1']).map((c) => c.label), labels.slice(0, 2));
});

test('planSeries puts a free inlet on a grid that does not feed the device yet, and says when no cord type fits', () => {
  const p = example();
  const [a, b] = [pduId(p, 'pdu-a01-a'), pduId(p, 'pdu-a01-b')];
  const ends = (plan) => plan.items.map((x) => `${x.inlet.device} ${x.inlet.inlet} ${M.deviceById(p, x.outlet.device).name}`);
  const why = (plan) => plan.skipped.map((s) => `${s.device.name} ${s.inlet}: ${s.why}`);
  // psu1 crossed over to the second PDU: psu2 goes to the first, not to the PDU of its number.
  P.unplug(p, ['cn-012']);
  assert.ok(P.connect(p, { inlet: { device: 'cn-012', inlet: 'psu1' }, outlet: { device: b, outlet: '21' } }).cord);
  assert.deepEqual(ends(P.planSeries(p, ['cn-012'])), ['cn-012 psu2 pdu-a01-a']);
  // The same with psu2 on the first PDU and psu1 free.
  P.unplug(p, ['cn-012']);
  assert.ok(P.connect(p, { inlet: { device: 'cn-012', inlet: 'psu2' }, outlet: { device: a, outlet: '21' } }).cord);
  assert.deepEqual(ends(P.planSeries(p, ['cn-012'])), ['cn-012 psu1 pdu-a01-b']);
  // PDUs without a grid count each for itself.
  P.setGrid(p, a, null);
  P.setGrid(p, b, null);
  assert.deepEqual(ends(P.planSeries(p, ['cn-012'])), ['cn-012 psu1 pdu-a01-b']);
  // Both PDUs on one grid: no other grid to go to, so it is the PDU without a cord of the device.
  P.setGrid(p, a, 'pg-a');
  P.setGrid(p, b, 'pg-a');
  assert.deepEqual(ends(P.planSeries(p, ['cn-012'])), ['cn-012 psu1 pdu-a01-b']);
  P.setGrid(p, b, 'pg-b');
  // Four inlets on two grids still take turns: both grids feed the device after the first two.
  p.devices.push(M.newDevice({ id: 'gpu-1', type: 'gpu', name: 'gpu-1', loc: { rack: 'r1', kind: 'u', at: 40 } }));
  assert.deepEqual(ends(P.planSeries(p, ['gpu-1'])), ['gpu-1 psu1 pdu-a01-a', 'gpu-1 psu2 pdu-a01-b', 'gpu-1 psu3 pdu-a01-a', 'gpu-1 psu4 pdu-a01-b']);

  // Every C13 outlet of the first PDU taken: an inlet that belongs on its grid is left out with the
  // reason, rather than put on the grid that feeds its device already.
  M.addDeviceType(p, Object.assign(M.clone(M.typeOf(p, 'compute-node')), { label: 'Filler', height: 1, inlets: [{ name: 'in', first: 1, count: 8, connector: 'c14' }] })).id = 'filler';
  [30, 31].forEach((at, i) => p.devices.push(M.newDevice({ id: `fill-${i}`, type: 'filler', name: `fill-${i}`, loc: { rack: 'r1', kind: 'u', at } })));
  P.unplug(p, ['cn-011', 'cn-012']);
  assert.ok(P.connect(p, { inlet: { device: 'cn-012', inlet: 'psu1' }, outlet: { device: b, outlet: '21' } }).cord);
  const taken = P.context(p).byOutlet;
  const spare = M.expandOutlets(M.typeOf(p, 't-pdu')).filter((o) => o.connector === 'c13' && !taken.has(`${a}|${o.name}`));
  assert.equal(spare.length, 12);
  spare.forEach((o, k) => assert.ok(P.connect(p, { inlet: { device: `fill-${k >> 3}`, inlet: `in${(k & 7) + 1}` }, outlet: { device: a, outlet: o.name } }).cord));
  const full = P.planSeries(p, ['cn-011', 'cn-012']);
  assert.deepEqual(ends(full), ['cn-011 psu2 pdu-a01-b']);
  assert.deepEqual(why(full), ['cn-011 psu1: pdu-a01-a has no free outlet that fits a C14 inlet', 'cn-012 psu2: pdu-a01-a has no free outlet that fits a C14 inlet']);

  // Without cord types nothing fits: the reason says so, rather than that the outlets are taken.
  const q = example();
  P.unplug(q, ['cn-011']);
  q.cordTypes = [];
  const none = P.planSeries(q, ['cn-011']);
  assert.deepEqual(none.items, []);
  assert.deepEqual(why(none), ['psu1', 'psu2'].map((n) => `cn-011 ${n}: no cord type joins a C14 inlet to an outlet of its rack’s PDUs`));

  // Four PDUs, the two of each grid side by side: a device takes an outlet on each, two on either grid.
  const r = example();
  assert.equal(M.updateRackType(r, 'rack-47', { pduSlots: ['left', 'left', 'right', 'right'] }), null);
  M.fillPduSlots(r, ['r2']);
  const four = r.devices.filter((d) => d.loc.rack === 'r2' && d.loc.kind === 'pdu').sort((x, y) => x.loc.at - y.loc.at);
  ['pg-a', 'pg-a', 'pg-b', 'pg-b'].forEach((g, i) => assert.equal(P.setGrid(r, four[i].id, g), null));
  r.devices.push(M.newDevice({ id: 'gpu-2', type: 'gpu', name: 'gpu-2', loc: { rack: 'r2', kind: 'u', at: 4 } }));
  const slots = () => P.planSeries(r, ['gpu-2']).items.map((x) => `${x.inlet.inlet} P${M.deviceById(r, x.outlet.device).loc.at + 1}`);
  assert.deepEqual(slots(), ['psu1 P1', 'psu2 P3', 'psu3 P4', 'psu4 P2']);
  // A PDU without an outlet for the inlet is passed over: a strip of C13 outlets takes no C20 inlet.
  const strip = M.cleanPdu(Object.assign(M.clone(PDU_3P.pdu), { outlets: [{ name: '', first: 1, count: 24, connector: 'c13' }], fuses: [], meters: [] }));
  M.addDeviceType(r, Object.assign(M.clone(PDU_3P), { label: 'C13 strip', pdu: strip })).id = 't-c13';
  four[0].type = 't-c13';
  four[2].type = 't-c13';
  assert.deepEqual(slots(), ['psu1 P2', 'psu2 P4', 'psu3 P4', 'psu4 P2']);
});

test('a grid whose id is "up" is a grid like any other: the scenario with all grids up has a key no id can be', () => {
  const p = example();
  // A file may give a grid any id that does not start with "__".
  p.powerGrids[0].id = 'up';
  for (const d of p.devices) if (d.grid === 'pg-a') d.grid = 'up';
  const IO = require('../js/io.js');
  const read = IO.normalizeProject(JSON.parse(IO.serialize(p)));
  assert.deepEqual(read.warnings, []);
  assert.deepEqual(read.project.powerGrids.map((g) => g.id), ['up', 'pg-b']);
  const load = P.loads(read.project);
  assert.deepEqual(load.scenarios.map((s) => [s.id, s.name]), [[P.UP, 'All grids up'], ['up', 'Grid A down'], ['pg-b', 'Grid B down']]);
  const [a, b] = load.pdus;
  assert.deepEqual(a.total.w, { [P.UP]: 4450, up: 0, 'pg-b': 8900 });
  assert.deepEqual(b.total.w, { [P.UP]: 4450, up: 8900, 'pg-b': 0 });
  assert.deepEqual([a.total.upW, a.total.downW, a.total.down, a.total.worst], [4450, 8900, 'pg-b', 'pg-b']);
  assert.deepEqual([b.total.upW, b.total.downW, b.total.down, b.total.worst], [4450, 8900, 'up', 'up']);
  assert.equal(P.scenarioPhrase(read.project, 'up'), 'when Grid A is down');
  assert.equal(P.scenarioPhrase(read.project, P.UP), 'with all grids up');
  // The key itself cannot come in with a file: such an id is replaced.
  assert.ok(P.UP.startsWith('__'));
  p.powerGrids[0].id = P.UP;
  for (const d of p.devices) if (d.grid === 'up') d.grid = P.UP;
  const other = IO.normalizeProject(JSON.parse(IO.serialize(p))).project;
  assert.ok(!other.powerGrids.some((g) => g.id === P.UP));
  assert.equal(other.devices.find((d) => d.name === 'pdu-a01-a').grid, other.powerGrids[0].id, 'its PDUs follow');
  assert.equal(P.loads(other).scenarios.length, 3);
});

test('the load with one grid down names its scenario, also when all grids up is as high or higher', () => {
  const p = example();
  const load = P.loads(p);
  // Nothing on the PDUs of Rack A02: every scenario is 0 W, and the highest of all is the first, all up.
  const idle = load.pdus[2].total;
  assert.deepEqual([idle.upW, idle.downW, idle.down, idle.worst], [0, 0, 'pg-a', P.UP]);
  // One grid in the plan: with it down its PDUs carry nothing, which is what "one down" is.
  const q = example();
  P.deleteGrid(q, 'pg-b');
  const one = P.loads(q).pdus[0].total;
  assert.deepEqual([one.upW, one.downW, one.down, one.worstW, one.worst], [4450, 0, 'pg-a', 4450, P.UP]);
});
