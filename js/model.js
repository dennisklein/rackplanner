/*
 * Rackplanner: data model and placement rules.
 *
 * Pure functions without DOM access, shared by the browser app and the Node
 * tests. A project looks like this:
 *
 *   {
 *     version: 6,
 *     name: 'Untitled rack plan',
 *     info: { site, author, revision },                 // title block
 *     deviceTypes: [{ id, label, tag, spec, height, face, defaultName, powerW, weightKg,
 *                     ports: [{ name, first?, count?, connector, speedGbps, side }],
 *                     inlets: [{ name, first?, count?, connector }], slackM,
 *                     pdu?: { spanU, phases: 1|3, voltageV, maxA, outlets: [{ name, first?, count?, connector }],
 *                             fuses: [{ name, outlets: [name], ratingA, phase: 'L1'|'L2'|'L3' }],
 *                             metering: 'outlet'|'group'|'inlet', meters: [{ name, outlets: [name] }] } }],
 *     rackTypes:   [{ id, name, units, sideSlots, pduSlots: ['left'|'right'], defaultPdu: id|null,
 *                     powerW, weightKg,                                 // budgets, 0 = none
 *                     widthMm, depthMm, trayM, slackM }],
 *     cableTypes:  [{ id, name, media, connector, connectorB, legs, speedGbps, maxM, lengthsM: [m] }],
 *     transceivers: [{ id, name, connector, fiber: 'lc'|'mpo', mode: 'mmf'|'smf', speedGbps, reachM }],
 *     cordTypes:   [{ id, name, outlet, inlet, maxA, lengthsM: [m] }],
 *     floors: [{ id, name, rowPitchM, rows: [{ id, name, racks: [{ id, name, type, trayM, slackM }] }] }],
 *     views:    [{ id, name, clusters: [{ id, name, color: '#rrggbb' }] }],
 *     networks: [{ id, name, color: '#rrggbb', firstLabel }],
 *     powerGrids: [{ id, name, color: '#rrggbb', note }],
 *     powerSettings: { powerFactor, limitPct },
 *     devices:  [{ id, type, name, groups: { viewId: clusterId }, notes, serial, asset, ip, owner,
 *                  powerW: null|W, weightKg: null|kg, reversed, slackM: null|m,
 *                  height (reserved space only), grid: id|null (PDUs only),
 *                  loc: { rack, kind: 'u'|'side'|'pdu', at } }],
 *     cables:   [{ id, type: id|null, network: id|null, label, lengthM: null|m, notes,
 *                  a: { device, port, transceiver? }, b: end | [end|null, …] }],
 *     powerCords: [{ id, label, type: id|null, lengthM: null|m, color: null|'#rrggbb', notes,
 *                    inlet: { device, inlet }, outlet: { device, outlet } }],
 *     meta: { example?: true, … },                    // kept as is, up to 64 KB
 *     extra?: { … }        // top-level fields of the file this version does not read, kept as is
 *   }
 *
 * A plan has 1 to 6 floors, a floor 1 to 8 rows and a row 1 to 16 racks. Rack
 * ids are unique across the plan. A device either sits in its rack's height
 * units (kind 'u', `at` is the lowest-numbered unit it occupies; units are
 * numbered from the top, so U1 is the topmost unit) or in one of the rack's
 * vertical side slots (kind 'side', `at` counts from 0 at the top). Side
 * slots take 1U devices only. A vertical PDU (a device type with a `pdu`
 * block, 0U) sits in one of the PDU slots its rack type lists (kind 'pdu',
 * `at` is the index in `pduSlots`), and nothing else does; PDU slots are
 * independent of the units and the side slots.
 *
 * A view is one way to group the devices: it has its own clusters (the
 * color groups), and a device's `groups` names its cluster in each view
 * (a view it is missing from leaves it unassigned there). Every device
 * shows in every view. Cluster ids are unique across the plan. A plan has
 * 1 to 8 views; functions that read by a `viewId` fall back to the first
 * view when it is missing or unknown, while setClusterOf, which writes,
 * refuses an unknown view and a cluster of another view.
 *
 * Device and rack types belong to the plan, so a plan file carries its own
 * catalog. The built-in type 'reserved' marks space for future equipment; it
 * has no fixed height (each reservation stores its own) and is not stored in
 * the catalog.
 *
 * Cables join a port of one device to a port of another (`b` is a list of
 * legs for breakout cables). Every port takes one cable end. A `null` type,
 * transceiver, length, rack tray or slack means "work it out": js/cabling.js
 * picks and estimates. This file keeps cables consistent when devices,
 * racks, rows, floors and types change; js/cabling.js holds the rest.
 *
 * Power cords join an inlet of a device to an outlet of a PDU in the same
 * rack; every inlet and outlet takes one cord. A PDU is fed by a power
 * grid (`grid`). This file keeps cords consistent like cables;
 * js/power.js holds the rest: connecting, lengths, loads and checks.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.RP = root.RP || {}).model = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 6;
  const LIMITS = {
    floors: 6,
    rows: 8, // per floor
    racks: 16, // per row
    unitsMin: 10,
    unitsMax: 60,
    sideSlots: 4,
    pduSlots: 4, // per rack type
    deviceHeight: 20,
    deviceTypes: 60,
    rackTypes: 20,
    portGroups: 32, // per device type
    ports: 1024, // per device type
    cableTypes: 50,
    transceivers: 50,
    networks: 30,
    views: 8,
    clusters: 1000, // per view
    cables: 20000,
    legs: 8, // of a breakout cable
    inletGroups: 4, // per device type
    inlets: 8, // per device type
    outletGroups: 32, // per PDU type
    outlets: 96, // per PDU type
    fuseGroups: 48, // per PDU type
    meterGroups: 48, // per PDU type
    powerGrids: 12,
    cordTypes: 30,
    powerCords: 20000,
    name: 60, // characters of a floor, row, rack, view, cluster, network or catalog name
  };
  const DEFAULT_VIEW_NAME = 'Default';
  const RACK_UNITS = 47; // height of the default rack type
  const SIDE_SLOTS = 2;
  const DEFAULT_RACKS = 3;
  // A side slot runs along 12U of the rack (a 19" device on its side) plus a 1U gap.
  const SIDE_SLOT_SPAN = 13;
  // The kinds of `loc`: in the rack's units, in a side slot, or (a vertical PDU) in a PDU slot.
  const MOUNT_KINDS = ['u', 'side', 'pdu'];
  // The sides of a rack a PDU slot is on, seen from the front; a rack type lists its slots, outer first on each side.
  const PDU_SIDES = ['left', 'right'];
  const DEFAULT_PDU_SLOTS = ['left', 'right'];
  // A rack lower than this gets no PDU slots unless its type gives some.
  const PDU_SLOT_UNITS = 20;
  const PHASES = ['L1', 'L2', 'L3'];
  const METERING = [
    { id: 'outlet', label: 'Per outlet' },
    { id: 'group', label: 'Per group' },
    { id: 'inlet', label: 'Inlet only' },
  ];

  const FACES = [
    { id: 'rj45', label: 'Switch, RJ45 ports' },
    { id: 'qsfp', label: 'Switch, QSFP cages' },
    { id: 'compute', label: 'Server, drive bays' },
    { id: 'storage', label: 'Storage server, bay grid' },
    { id: 'jbod', label: 'Disk enclosure, drawers' },
    { id: 'gpu', label: 'GPU server, fans' },
    { id: 'patch', label: 'Patch panel' },
    { id: 'pdu', label: 'PDU, outlets' },
    { id: 'ups', label: 'UPS, display' },
    { id: 'blank', label: 'Blanking panel' },
    { id: 'generic', label: 'Generic, vents' },
  ];
  const FACE_IDS = new Set(FACES.map((f) => f.id));

  // Port groups as cleanPortGroup leaves them: a single port has no first/count.
  const onePort = (name, connector, speedGbps, side) => ({ name, connector, speedGbps, side });
  const portSeries = (name, first, count, connector, speedGbps, side) => ({ name, first, count, connector, speedGbps, side });
  // Inlet and outlet groups as cleanPowerGroup leaves them.
  const powerSeries = (name, first, count, connector) => ({ name, first, count, connector });
  const psus = (count, connector) => [powerSeries('psu', 1, count, connector || 'c14')];
  const numbered = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

  const DEFAULT_DEVICE_TYPES = [
    {
      id: 'switch-rj45', label: '48-port switch', tag: 'SWITCH', spec: '48 × RJ45', height: 1, face: 'rj45', defaultName: 'sw-rj45-01', powerW: 150, weightKg: 6,
      ports: [portSeries('swp', 1, 48, 'rj45', 1, 'front'), portSeries('swp', 49, 4, 'sfp+', 10, 'front')],
      inlets: psus(2),
      slackM: 0,
    },
    {
      id: 'switch-qsfp', label: '24-port switch', tag: 'SWITCH', spec: '24 × QSFP', height: 1, face: 'qsfp', defaultName: 'sw-qsfp-01', powerW: 350, weightKg: 9,
      ports: [portSeries('p', 1, 24, 'qsfp56', 200, 'front')],
      inlets: psus(2),
      slackM: 0,
    },
    {
      id: 'compute-node', label: 'Compute node', tag: 'COMPUTE', spec: 'server', height: 2, face: 'compute', defaultName: 'cn-001', powerW: 700, weightKg: 25,
      ports: [onePort('bmc', 'rj45', 1, 'rear'), onePort('eth0', 'rj45', 1, 'rear'), onePort('ib0', 'qsfp56', 200, 'rear')],
      inlets: psus(2),
      slackM: 0.3,
    },
    {
      id: 'storage-node', label: 'Storage node', tag: 'STORAGE', spec: 'server, 24 bays', height: 4, face: 'storage', defaultName: 'sn-01', powerW: 900, weightKg: 40,
      ports: [
        onePort('bmc', 'rj45', 1, 'rear'),
        onePort('eth0', 'rj45', 1, 'rear'),
        onePort('eth1', 'sfp28', 25, 'rear'),
        portSeries('ib', 0, 2, 'qsfp56', 200, 'rear'),
        portSeries('sas', 0, 4, 'sas-hd', 12, 'rear'),
      ],
      inlets: psus(2),
      slackM: 0.3,
    },
    {
      id: 'storage-enclosure', label: 'Storage enclosure', tag: 'JBOD', spec: 'JBOD, 2 drawers', height: 4, face: 'jbod', defaultName: 'jbod-01', powerW: 800, weightKg: 60,
      ports: [onePort('mgmt', 'rj45', 1, 'rear'), onePort('sas-a', 'sas-hd', 12, 'rear'), onePort('sas-b', 'sas-hd', 12, 'rear')],
      inlets: psus(2),
      slackM: 0.3,
    },
  ];

  const GPU_SERVER_PORTS = [
    onePort('bmc', 'rj45', 1, 'rear'),
    onePort('eth0', 'rj45', 1, 'rear'),
    portSeries('eth', 1, 2, 'sfp28', 25, 'rear'),
    portSeries('ib', 0, 4, 'qsfp56', 200, 'rear'),
  ];

  /**
   * The `pdu` blocks of the vertical PDU templates. The three-phase ones
   * have six 16 A fuse groups, two on each phase.
   */
  const fuseGroups = (count, size, ratingA, phases) =>
    Array.from({ length: count }, (_, k) => ({ name: `CB${k + 1}`, outlets: numbered(k * size + 1, (k + 1) * size), ratingA, phase: PHASES[phases === 3 ? Math.floor((k * 3) / count) : 0] }));
  const meterGroups = (count, size) => Array.from({ length: count }, (_, k) => ({ name: `M${k + 1}`, outlets: numbered(k * size + 1, (k + 1) * size) }));
  const PDU_1P_20 = { spanU: 42, phases: 1, voltageV: 230, maxA: 32, outlets: [powerSeries('', 1, 20, 'c13')], fuses: fuseGroups(2, 10, 16, 1), metering: 'group', meters: meterGroups(2, 10) };
  // 24 C13 and 6 C19: every fifth outlet is a C19.
  const PDU_3P_30 = {
    spanU: 42, phases: 3, voltageV: 230, maxA: 32,
    outlets: [].concat(...Array.from({ length: 6 }, (_, k) => [powerSeries('', 5 * k + 1, 4, 'c13'), powerSeries('', 5 * k + 5, 1, 'c19')])),
    fuses: fuseGroups(6, 5, 16, 3), metering: 'group', meters: meterGroups(3, 10),
  };
  const PDU_3P_24 = { spanU: 42, phases: 3, voltageV: 230, maxA: 32, outlets: [powerSeries('', 1, 24, 'c13')], fuses: fuseGroups(6, 4, 16, 3), metering: 'outlet', meters: [] };
  const pduTemplate = (label, spec, weightKg, pdu) => ({ label, tag: 'PDU', spec, height: 0, face: 'pdu', defaultName: 'pdu-01', powerW: 0, weightKg, ports: [onePort('mgmt', 'rj45', 1, 'rear')], inlets: [], slackM: 0, pdu });

  /** Starting points for new device types in the catalog editor. */
  const TYPE_TEMPLATES = [
    { label: '1U server', tag: 'SERVER', spec: '10 bays', height: 1, face: 'compute', defaultName: 'srv-01', powerW: 450, weightKg: 16, ports: [onePort('bmc', 'rj45', 1, 'rear'), portSeries('eth', 0, 2, 'rj45', 1, 'rear')], inlets: psus(2), slackM: 0.3 },
    { label: 'GPU server', tag: 'GPU', spec: '8 × GPU', height: 4, face: 'gpu', defaultName: 'gpu-01', powerW: 3000, weightKg: 65, ports: GPU_SERVER_PORTS, inlets: psus(4, 'c20'), slackM: 0.3 },
    { label: 'Patch panel', tag: 'PATCH', spec: '24 × RJ45', height: 1, face: 'patch', defaultName: 'pp-01', powerW: 0, weightKg: 2, ports: [], inlets: [], slackM: 0 },
    { label: 'PDU', tag: 'PDU', spec: '12 × C13', height: 1, face: 'pdu', defaultName: 'pdu-01', powerW: 0, weightKg: 5, ports: [onePort('mgmt', 'rj45', 1, 'rear')], inlets: [], slackM: 0 },
    { label: 'UPS', tag: 'UPS', spec: '3 kVA', height: 2, face: 'ups', defaultName: 'ups-01', powerW: 150, weightKg: 32, ports: [onePort('mgmt', 'rj45', 1, 'rear')], inlets: [{ name: 'in', connector: 'c20' }], slackM: 0 },
    { label: 'Blanking panel', tag: 'BLANK', spec: 'airflow', height: 1, face: 'blank', defaultName: 'blank-01', powerW: 0, weightKg: 0.5, ports: [], inlets: [], slackM: 0 },
    { label: 'Generic device', tag: 'DEVICE', spec: '', height: 2, face: 'generic', defaultName: 'dev-01', powerW: 300, weightKg: 15, ports: [], inlets: psus(2), slackM: 0 },
    pduTemplate('0U PDU 1P 20 × C13', '20 × C13 · 1 × 32 A', 6, PDU_1P_20),
    pduTemplate('0U PDU 3P 30', '24 × C13, 6 × C19 · 3 × 32 A', 9, PDU_3P_30),
    pduTemplate('0U PDU 3P 24 × C13 metered', '24 × C13 · 3 × 32 A · per outlet', 9, PDU_3P_24),
  ];
  // The inlets a device type gets from the button "Add psu[1-2] C14".
  const DEFAULT_INLETS = psus(2);

  const RESERVED = Object.freeze({
    id: 'reserved',
    label: 'Reserved space',
    tag: 'RESERVED',
    spec: 'placeholder',
    height: 1,
    face: 'reserved',
    defaultName: 'reserved-01',
    powerW: 0,
    weightKg: 0,
    ports: Object.freeze([]),
    inlets: Object.freeze([]),
    slackM: 0,
    variable: true,
    builtin: true,
  });

  const DEFAULT_RACK_TYPES = [
    { id: 'rack-47', name: '47U rack', units: 47, sideSlots: 2, pduSlots: ['left', 'right'], defaultPdu: null, powerW: 12000, weightKg: 1200, widthMm: 600, depthMm: 1200, trayM: 0.5, slackM: 0.25 },
    { id: 'rack-42', name: '42U rack', units: 42, sideSlots: 2, pduSlots: ['left', 'right'], defaultPdu: null, powerW: 8000, weightKg: 1000, widthMm: 600, depthMm: 1200, trayM: 0.5, slackM: 0.25 },
    { id: 'rack-48', name: '48U high-density rack', units: 48, sideSlots: 2, pduSlots: ['left', 'right'], defaultPdu: null, powerW: 20000, weightKg: 1500, widthMm: 800, depthMm: 1200, trayM: 0.5, slackM: 0.25 },
  ];
  const FALLBACK_RACK_TYPE = DEFAULT_RACK_TYPES[0];

  /**
   * Structured device fields, besides name, cluster and notes. Those of
   * one device only (`instance`) are left empty on copies, and a value
   * that more devices have is flagged (see repeatedFields).
   */
  const FIELDS = [
    { key: 'serial', label: 'Serial number', csv: 'Serial number', instance: true },
    { key: 'asset', label: 'Asset tag', csv: 'Asset tag', instance: true },
    { key: 'ip', label: 'IP address', csv: 'IP address', instance: true },
    { key: 'owner', label: 'Owner', csv: 'Owner' },
  ];
  // The longest text a plan keeps in a device's name, in a field of FIELDS and in the notes of a device or cable.
  const NAME_MAX = 80;
  const FIELD_MAX = 120;
  const NOTES_MAX = 2000;

  // Ordered so that the first eight clusters stay apart for the common kinds
  // of color blindness too: distinct hues of distinct lightness.
  const CLUSTER_COLORS = [
    '#2f6fdb', // cobalt
    '#e69f00', // amber
    '#7fc6f0', // sky
    '#008568', // teal, dark enough for a white number
    '#d55e00', // vermilion
    '#9e2a6e', // plum
    '#ecd94a', // yellow
    '#6e4a2e', // brown
    '#8a5cd6', // violet
    '#3aa655', // green
    '#d94c8a', // rose
    '#8aa82c', // olive
  ];
  // Colors nearer than this (colorDistance) are hard to tell apart.
  const COLOR_NEAR = 12;

  /**
   * Port and plug connectors. A plug fits a port whose `accepts` lists the
   * plug's family; cages take direct cables and transceivers of their family.
   */
  const CONNECTORS = [
    { id: 'rj45', label: 'RJ45', family: 'rj45', speedGbps: 1, cage: false },
    { id: 'sfp', label: 'SFP', family: 'sfp', speedGbps: 1, cage: true },
    { id: 'sfp+', label: 'SFP+', family: 'sfp', speedGbps: 10, cage: true },
    { id: 'sfp28', label: 'SFP28', family: 'sfp', speedGbps: 25, cage: true },
    { id: 'sfp56', label: 'SFP56', family: 'sfp', speedGbps: 50, cage: true },
    { id: 'qsfp+', label: 'QSFP+', family: 'qsfp', speedGbps: 40, cage: true },
    { id: 'qsfp28', label: 'QSFP28', family: 'qsfp', speedGbps: 100, cage: true },
    { id: 'qsfp56', label: 'QSFP56', family: 'qsfp', speedGbps: 200, cage: true },
    { id: 'qsfp112', label: 'QSFP112', family: 'qsfp', speedGbps: 400, cage: true },
    { id: 'qsfp-dd', label: 'QSFP-DD', family: 'qsfpdd', speedGbps: 400, cage: true, accepts: ['qsfp', 'qsfpdd'] },
    { id: 'osfp', label: 'OSFP', family: 'osfp', speedGbps: 800, cage: true },
    { id: 'lc', label: 'LC duplex', family: 'lc', speedGbps: 0, cage: false },
    { id: 'mpo', label: 'MPO', family: 'mpo', speedGbps: 0, cage: false },
    { id: 'sas-hd', label: 'Mini-SAS HD', family: 'sas', speedGbps: 12, cage: false },
  ].map((c) => Object.assign(c, { accepts: c.accepts || [c.family] }));
  const CONNECTOR_MAP = new Map(CONNECTORS.map((c) => [c.id, c]));

  /** Cable media: copper patch cords, direct cables (plugs on the cable) and fiber (needs optics at cages). */
  // Without a prototype, so that a name like "constructor" from a file is no media.
  const MEDIA = Object.assign(Object.create(null), {
    cat6: { label: 'Cat6 copper', short: 'Cat6', kind: 'copper', plug: 'rj45' },
    cat6a: { label: 'Cat6a copper', short: 'Cat6a', kind: 'copper', plug: 'rj45' },
    cat8: { label: 'Cat8 copper', short: 'Cat8', kind: 'copper', plug: 'rj45' },
    dac: { label: 'Direct attach copper', short: 'DAC', kind: 'direct', plug: 'qsfp56' },
    aoc: { label: 'Active optical cable', short: 'AOC', kind: 'direct', plug: 'qsfp56' },
    sas: { label: 'SAS cable', short: 'SAS', kind: 'direct', plug: 'sas-hd' },
    om3: { label: 'Multimode fiber OM3', short: 'OM3', kind: 'fiber', mode: 'mmf', plug: 'lc' },
    om4: { label: 'Multimode fiber OM4', short: 'OM4', kind: 'fiber', mode: 'mmf', plug: 'lc' },
    om5: { label: 'Multimode fiber OM5', short: 'OM5', kind: 'fiber', mode: 'mmf', plug: 'lc' },
    os2: { label: 'Single-mode fiber OS2', short: 'OS2', kind: 'fiber', mode: 'smf', plug: 'lc' },
  });

  const cableType = (id, name, media, connector, connectorB, legs, speedGbps, maxM, lengthsM) => ({ id, name, media, connector, connectorB, legs, speedGbps, maxM, lengthsM });
  const DEFAULT_CABLE_TYPES = [
    cableType('cat6a', 'Cat6a patch cord', 'cat6a', 'rj45', 'rj45', 1, 10, 100, [0.5, 1, 1.5, 2, 3, 5, 7, 10, 15, 20]),
    cableType('dac-sfp28', 'SFP28 DAC', 'dac', 'sfp28', 'sfp28', 1, 25, 5, [0.5, 1, 1.5, 2, 3, 5]),
    cableType('dac-qsfp56', 'QSFP56 DAC', 'dac', 'qsfp56', 'qsfp56', 1, 200, 3, [0.5, 1, 1.5, 2, 2.5, 3]),
    cableType('aoc-qsfp56', 'QSFP56 AOC', 'aoc', 'qsfp56', 'qsfp56', 1, 200, 100, [3, 5, 7, 10, 15, 20, 30]),
    cableType('dac-osfp-2x', 'OSFP to 2 × QSFP56 DAC', 'dac', 'osfp', 'qsfp56', 2, 400, 3, [1, 1.5, 2, 2.5, 3]),
    cableType('aoc-osfp-2x', 'OSFP to 2 × QSFP56 AOC', 'aoc', 'osfp', 'qsfp56', 2, 400, 50, [3, 5, 7, 10, 15, 20]),
    cableType('lc-om4', 'LC duplex OM4', 'om4', 'lc', 'lc', 1, 0, 0, [1, 2, 3, 5, 7, 10, 15, 20, 30]),
    cableType('mpo-om4', 'MPO-12 OM4', 'om4', 'mpo', 'mpo', 1, 0, 0, []),
    cableType('sas-hd', 'Mini-SAS HD cable', 'sas', 'sas-hd', 'sas-hd', 1, 12, 6, [0.5, 1, 2, 3, 4]),
  ];

  const transceiver = (id, name, connector, fiber, mode, speedGbps, reachM) => ({ id, name, connector, fiber, mode, speedGbps, reachM });
  const DEFAULT_TRANSCEIVERS = [
    transceiver('sfp-10g-sr', 'SFP+ 10G SR', 'sfp+', 'lc', 'mmf', 10, 300),
    transceiver('sfp28-25g-sr', 'SFP28 25G SR', 'sfp28', 'lc', 'mmf', 25, 100),
    transceiver('qsfp28-100g-sr4', 'QSFP28 100G SR4', 'qsfp28', 'mpo', 'mmf', 100, 100),
    transceiver('qsfp28-100g-lr4', 'QSFP28 100G LR4', 'qsfp28', 'lc', 'smf', 100, 10000),
    transceiver('qsfp56-200g-sr4', 'QSFP56 200G SR4', 'qsfp56', 'mpo', 'mmf', 200, 100),
    transceiver('osfp-400g-sr4', 'OSFP 400G SR4', 'osfp', 'mpo', 'mmf', 400, 50),
  ];

  const DEFAULT_ROW_PITCH_M = 3;

  /**
   * Power connectors of inlets (on devices) and outlets (on PDUs). A cord
   * joins an outlet to an inlet when its type names both connectors.
   * `maxA` is what the connector carries.
   */
  const POWER_CONNECTORS = [
    { id: 'c13', label: 'C13', role: 'outlet', maxA: 10 },
    { id: 'c14', label: 'C14', role: 'inlet', maxA: 10 },
    { id: 'c19', label: 'C19', role: 'outlet', maxA: 16 },
    { id: 'c20', label: 'C20', role: 'inlet', maxA: 16 },
    { id: 'c5', label: 'C5', role: 'outlet', maxA: 2.5 },
    { id: 'c6', label: 'C6', role: 'inlet', maxA: 2.5 },
    { id: 'c15', label: 'C15', role: 'outlet', maxA: 10 },
    { id: 'c16', label: 'C16', role: 'inlet', maxA: 10 },
    { id: 'nema-5-15', label: 'NEMA 5-15', role: 'both', maxA: 15 },
    { id: 'nema-l6-30', label: 'NEMA L6-30', role: 'both', maxA: 30 },
    { id: 'schuko', label: 'Schuko', role: 'both', maxA: 16 },
  ];
  const POWER_CONNECTOR_MAP = new Map(POWER_CONNECTORS.map((c) => [c.id, c]));

  const cordType = (id, name, outlet, inlet, maxA, lengthsM) => ({ id, name, outlet, inlet, maxA, lengthsM });
  const DEFAULT_CORD_TYPES = [
    cordType('c14-c13', 'C14–C13 cord', 'c13', 'c14', 10, [0.6, 1, 1.5, 2, 3]),
    cordType('c20-c19', 'C20–C19 cord', 'c19', 'c20', 16, [0.6, 1, 1.5, 2, 3]),
  ];
  const DEFAULT_POWER_SETTINGS = { powerFactor: 1, limitPct: 80 };
  // Grid A is red and Grid B blue, as feeds are usually marked; the rest stay apart from both.
  const GRID_COLORS = ['#d1453b', '#2b6cd4', '#e69f00', '#3aa655', '#8a5cd6', '#008568', '#d94c8a', '#6e4a2e', '#7fc6f0', '#8aa82c', '#9e2a6e', '#ecd94a'];
  // The series of a power cord's label.
  const CORD_LABEL = 'P-0001';

  // ---------------------------------------------------------------- helpers

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const pad2 = (n) => String(n).padStart(2, '0');
  /** A trimmed string of at most `max` characters; '' for anything else. */
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  /** "1 rack", "3 racks"; `many` for irregular plurals. */
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + 's'}`;
  /**
   * The plural of a name such as a device type's label, to use inside a
   * sentence: "48-port switch" → "48-port switches", "Compute node" →
   * "compute nodes", "PDU" → "PDUs", "GPU server" → "GPU servers".
   */
  function pluralName(name) {
    const s = String(name).trim();
    // A capital that only starts the sentence goes; acronyms (PDU, GPU) and units (1U) keep theirs.
    const text = /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
    if (/(s|x|z|ch|sh)$/i.test(text)) return text + (/[A-Z]$/.test(text) ? 's' : 'es');
    if (/[^aeiou]y$/i.test(text)) return text.slice(0, -1) + 'ies';
    return text + 's';
  }
  const namesOf = (list) => new Set(list.map((x) => x.name));
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const orNull = (v) => (v === undefined ? null : v);

  /** Lowercase ASCII words joined by dashes, for file names and ids: "Halle Süd 2" → halle-sud-2. */
  function slug(s, max) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, max || 60)
      .replace(/-+$/, '');
  }

  function clampInt(v, lo, hi, dflt) {
    const n = Math.round(Number(v));
    return v === null || v === '' || !Number.isFinite(n) ? dflt : Math.max(lo, Math.min(hi, n));
  }
  function clampNum(v, lo, hi, dflt) {
    const n = Number(v);
    return v === null || v === '' || v === undefined || !Number.isFinite(n) ? dflt : Math.max(lo, Math.min(hi, Math.round(n * 100) / 100));
  }

  let uidCounter = 0;
  /**
   * A random id such as r-mvltsu84qbghj: what devices, cables, clusters,
   * networks, floors, rows, racks, views and catalog types get when they
   * are made, so that an id is never given to something else after a delete.
   */
  function uid(prefix) {
    uidCounter = (uidCounter + 1) % 1679616;
    return `${prefix}-${Date.now().toString(36)}${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /** The first of make(start), make(start + 1), … that is not in `used`. */
  function firstFree(used, start, make) {
    let i = start;
    while (used.has(make(i))) i++;
    return make(i);
  }

  /** Smallest `${prefix}${k}` not in `used`: the id the loader gives a floor, row, rack or view whose id in the file cannot be kept. */
  function nextId(prefix, used) {
    return firstFree(used, 1, (k) => prefix + k);
  }

  // The CSVs find floors, rows, racks, views, clusters, networks and catalog
  // types by name in any case, so within its list each keeps a name of its own.
  const nameKey = (name) => String(name == null ? '' : name).trim().toLowerCase();
  /** True when an item of `list` other than the one with id `ignoreId` has `name` in any case; `key` is the name's property (default name). */
  function nameTaken(list, name, ignoreId, key) {
    const k = nameKey(name);
    return list.some((x) => (ignoreId === undefined || x.id !== ignoreId) && nameKey(x[key || 'name']) === k);
  }
  /** The first of make(start), make(start + 1), … that no item of `list` has as its name, in any case. */
  function firstFreeName(list, start, make, key) {
    const used = new Set(list.map((x) => nameKey(x[key || 'name'])));
    return firstFree({ has: (n) => used.has(nameKey(n)) }, start, make);
  }
  /** `base`, or with a number when an item of `list` has it in any case: "Compute node 2". The base is cut so that the name keeps within LIMITS.name. */
  function uniqueLabel(list, key, base) {
    if (!nameTaken(list, base, undefined, key)) return base;
    const head = base.slice(0, LIMITS.name - 4).trim();
    return firstFreeName(list, 2, (i) => `${head} ${i}`, key);
  }
  /** Name for a copy of `name` in `list`: "Lustre (copy)", then "Lustre (copy 2)"; no item of `list` has it, in any case. */
  function copyName(list, name) {
    const base = name.replace(/ \(copy(?: \d+)?\)$/, '');
    return firstFreeName(list, 1, (i) => {
      const tail = ` (copy${i > 1 ? ' ' + i : ''})`;
      return base.slice(0, LIMITS.name - tail.length).trim() + tail;
    });
  }

  // Color vision deficiencies (Machado et al. 2009, full severity), on linear RGB.
  const CVD = [
    [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998], // protanopia
    [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881], // deuteranopia
    [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039], // tritanopia
  ];

  /** CIE L*a*b* of a #rrggbb color, as seen through `cvd` (a CVD matrix) when given. */
  function labOf(hex, cvd) {
    let rgb = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    if (cvd) rgb = [0, 3, 6].map((k) => Math.min(1, Math.max(0, cvd[k] * rgb[0] + cvd[k + 1] * rgb[1] + cvd[k + 2] * rgb[2])));
    const [r, g, b] = rgb;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  /**
   * How far apart two colors look (CIE76 ΔE): the least for normal color
   * vision, protanopia, deuteranopia and tritanopia.
   */
  function colorDistance(a, b) {
    const ha = normalizeHex(a);
    const hb = normalizeHex(b);
    if (!ha || !hb) return Infinity;
    return Math.min(
      ...[null, ...CVD].map((cvd) => {
        const [p, q] = [labOf(ha, cvd), labOf(hb, cvd)];
        return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      })
    );
  }

  function normalizeHex(value) {
    if (typeof value !== 'string') return null;
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    if (!m) return null;
    let hex = m[1].toLowerCase();
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return '#' + hex;
  }

  /** Letters for the n-th row: 0 → A, 25 → Z, 26 → AA. */
  function letters(n) {
    let s = '';
    let k = n + 1;
    while (k > 0) {
      k--;
      s = String.fromCharCode(65 + (k % 26)) + s;
      k = Math.floor(k / 26);
    }
    return s;
  }

  // ---------------------------------------------------------------- lookups

  function typeOf(project, id) {
    if (id === RESERVED.id) return RESERVED;
    return (project && project.deviceTypes ? project.deviceTypes.find((t) => t.id === id) : null) || null;
  }
  /** Device types offered for placement: the plan's catalog, then reserved space. */
  function placeableTypes(project) {
    return project.deviceTypes.concat([RESERVED]);
  }
  function rackTypeById(project, id) {
    return project.rackTypes.find((t) => t.id === id) || null;
  }
  function viewById(project, id) {
    return (id && project.views.find((v) => v.id === id)) || null;
  }
  /** The view `id`, or the first view when there is no such view. */
  function viewOf(project, id) {
    return viewById(project, id) || project.views[0];
  }
  /** The clusters of view `viewId`. */
  function clustersOf(project, viewId) {
    return viewOf(project, viewId).clusters;
  }
  /** A cluster of any view: cluster ids are unique across the plan. */
  function clusterById(project, id) {
    if (!id) return null;
    for (const v of project.views) {
      const c = v.clusters.find((x) => x.id === id);
      if (c) return c;
    }
    return null;
  }
  /** The view a cluster belongs to, or null. */
  function viewOfCluster(project, id) {
    return (id && project.views.find((v) => v.clusters.some((c) => c.id === id))) || null;
  }
  /** Id of the cluster device `d` has in view `viewId`, or null. */
  function clusterIdOf(project, d, viewId) {
    const v = viewOf(project, viewId);
    const id = d.groups ? d.groups[v.id] : null;
    return id && v.clusters.some((c) => c.id === id) ? id : null;
  }
  /** The cluster device `d` has in view `viewId`, or null. */
  function clusterOf(project, d, viewId) {
    return clusterById(project, clusterIdOf(project, d, viewId));
  }
  /**
   * Puts device `d` into cluster `clusterId` of view `viewId`; null leaves
   * it unassigned there. Unlike the reads, it has no fallback: false, and
   * nothing changed, for an unknown view or a cluster of another view.
   */
  function setClusterOf(project, d, viewId, clusterId) {
    const v = viewById(project, viewId);
    if (!v || (clusterId && !v.clusters.some((c) => c.id === clusterId))) return false;
    if (!d.groups) d.groups = {};
    if (clusterId) d.groups[v.id] = clusterId;
    else delete d.groups[v.id];
    return true;
  }
  function deviceById(project, id) {
    return project.devices.find((d) => d.id === id) || null;
  }
  function floorById(project, id) {
    return project.floors.find((f) => f.id === id) || null;
  }

  /** Every row in order, with its floor and positions. */
  function allRows(project) {
    const out = [];
    project.floors.forEach((floor, floorIndex) =>
      floor.rows.forEach((row, rowIndex) => out.push({ row, floor, rowIndex, floorIndex, sheet: out.length }))
    );
    return out;
  }
  /** Every rack in order, with its row, floor and position in the row. */
  function allRacks(project) {
    const out = [];
    project.floors.forEach((floor, floorIndex) =>
      floor.rows.forEach((row, rowIndex) => row.racks.forEach((rack, index) => out.push({ rack, row, floor, index, rowIndex, floorIndex })))
    );
    return out;
  }
  function locateRow(project, rowId) {
    for (let fi = 0; fi < project.floors.length; fi++) {
      const floor = project.floors[fi];
      const ri = floor.rows.findIndex((r) => r.id === rowId);
      if (ri >= 0) return { row: floor.rows[ri], floor, rowIndex: ri, floorIndex: fi };
    }
    return null;
  }
  function rowById(project, id) {
    const pos = locateRow(project, id);
    return pos ? pos.row : null;
  }
  function locateRack(project, rackId) {
    for (let fi = 0; fi < project.floors.length; fi++) {
      const floor = project.floors[fi];
      for (let ri = 0; ri < floor.rows.length; ri++) {
        const row = floor.rows[ri];
        const index = row.racks.findIndex((r) => r.id === rackId);
        if (index >= 0) return { rack: row.racks[index], row, floor, index, rowIndex: ri, floorIndex: fi };
      }
    }
    return null;
  }
  function rackById(project, id) {
    const pos = locateRack(project, id);
    return pos ? pos.rack : null;
  }
  /** Ids of all floors, rows and racks; they share one id space. */
  function structureIds(project) {
    const ids = new Set();
    for (const f of project.floors) {
      ids.add(f.id);
      for (const r of f.rows) {
        ids.add(r.id);
        for (const k of r.racks) ids.add(k.id);
      }
    }
    return ids;
  }

  const asRack = (project, rack) => (typeof rack === 'string' ? rackById(project, rack) : rack);
  function rackTypeOf(project, rack) {
    const r = asRack(project, rack);
    return (r && rackTypeById(project, r.type)) || project.rackTypes[0] || FALLBACK_RACK_TYPE;
  }
  function rackUnits(project, rack) {
    return rackTypeOf(project, rack).units;
  }
  function rackSideSlots(project, rack) {
    return rackTypeOf(project, rack).sideSlots;
  }
  /** The PDU slots of a rack, as its type lists them: 'left' | 'right' each, seen from the front. */
  function rackPduSlots(project, rack) {
    return rackTypeOf(project, rack).pduSlots || [];
  }
  /** True for a device type that is a vertical PDU. */
  function isPduType(type) {
    return !!type && !!type.pdu;
  }
  /** True for a device that is a vertical PDU. */
  function isPdu(project, d) {
    return !!d && isPduType(typeOf(project, d.type));
  }
  /** How many side slots fit along a rack of `units`. */
  function maxSideSlots(units) {
    return Math.max(0, Math.min(LIMITS.sideSlots, Math.floor((units - 1) / SIDE_SLOT_SPAN)));
  }

  function heightOf(project, typeId, height) {
    const t = typeOf(project, typeId);
    if (!t) return 1;
    return t.variable ? clampInt(height, 1, LIMITS.unitsMax, 1) : t.height;
  }
  function deviceHeight(project, d) {
    return heightOf(project, d.type, d.height);
  }
  function deviceSpan(project, d) {
    return [d.loc.at, d.loc.at + deviceHeight(project, d) - 1];
  }
  function powerOf(project, d) {
    if (d.powerW !== null && d.powerW !== undefined) return d.powerW;
    const t = typeOf(project, d.type);
    return t ? t.powerW : 0;
  }
  function weightOf(project, d) {
    if (d.weightKg !== null && d.weightKg !== undefined) return d.weightKg;
    const t = typeOf(project, d.type);
    return t ? t.weightKg : 0;
  }
  /** Height from a rack's top unit up to the cable tray, in metres (the rack's own, else its type's). */
  function rackTrayM(project, rack) {
    const r = asRack(project, rack);
    return r && r.trayM !== null && r.trayM !== undefined ? r.trayM : rackTypeOf(project, r).trayM;
  }
  /** Slack a cable gets in a rack, at each end that is in it. */
  function rackSlackM(project, rack) {
    const r = asRack(project, rack);
    return r && r.slackM !== null && r.slackM !== undefined ? r.slackM : rackTypeOf(project, r).slackM;
  }
  /** Slack a cable gets at a device: the device's own, else its type's. */
  function deviceSlackM(project, d) {
    if (d.slackM !== null && d.slackM !== undefined) return d.slackM;
    const t = typeOf(project, d.type);
    return (t && t.slackM) || 0;
  }
  function cableTypeById(project, id) {
    return (id && (project.cableTypes || []).find((t) => t.id === id)) || null;
  }
  function transceiverById(project, id) {
    return (id && (project.transceivers || []).find((t) => t.id === id)) || null;
  }
  function networkById(project, id) {
    return (id && (project.networks || []).find((n) => n.id === id)) || null;
  }
  function powerGridById(project, id) {
    return (id && (project.powerGrids || []).find((g) => g.id === id)) || null;
  }
  function cordTypeById(project, id) {
    return (id && (project.cordTypes || []).find((t) => t.id === id)) || null;
  }
  /** The power grid that feeds PDU `d`, or null. */
  function gridOf(project, d) {
    return d ? powerGridById(project, d.grid) : null;
  }
  /** Power factor and limit of the plan, with the defaults for what it lacks. */
  function powerSettings(project) {
    return cleanPowerSettings(project && project.powerSettings);
  }

  // ------------------------------------------------------------------ ports

  function connectorById(id) {
    return CONNECTOR_MAP.get(id) || null;
  }
  // What an id of a connector this version does not know may look like: one from a newer version, say.
  const OTHER_CONNECTOR = /^[a-z0-9][a-z0-9+._-]{0,31}$/i;
  /**
   * The connector id `v` names, in any case: the id in CONNECTORS, or an id
   * this version does not know as it is (nothing fits it); '' for no id.
   */
  function connectorId(v) {
    if (typeof v !== 'string') return '';
    const c = CONNECTOR_MAP.get(v.toLowerCase());
    return c ? c.id : OTHER_CONNECTOR.test(v) ? v : '';
  }
  const connectorLabel = (id) => (connectorById(id) || { label: id }).label;
  /** True when a plug of connector `plugId` fits a port of connector `portId` (same family, or a QSFP plug in a QSFP-DD cage). */
  function plugFits(plugId, portId) {
    const plug = connectorById(plugId);
    const port = connectorById(portId);
    return !!plug && !!port && port.accepts.includes(plug.family);
  }

  // Port names end up in keys like "device|port" and in patterns like swp[1-48].
  const portName = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[|[\]\u0000-\u001f]/g, '').trim().slice(0, 32) : '');
  const given = (v) => v !== undefined && v !== null && v !== '';

  /**
   * A valid port group from untrusted input, or null. A group with `first`
   * or `count` is a numbered series (swp1 … swp48); without both it is one
   * port named `name`.
   */
  function cleanPortGroup(raw) {
    if (!isObj(raw)) return null;
    const conn = connectorId(raw.connector);
    const name = portName(raw.name);
    const series = given(raw.first) || given(raw.count);
    if (!conn || (!series && !name)) return null;
    const g = { name };
    if (series) {
      g.first = clampInt(raw.first, 0, 9999, 1);
      g.count = clampInt(raw.count, 1, LIMITS.ports, 1);
    }
    g.connector = conn;
    g.speedGbps = clampNum(raw.speedGbps, 0, 1600, (connectorById(conn) || { speedGbps: 0 }).speedGbps);
    g.side = raw.side === 'front' ? 'front' : 'rear';
    return g;
  }

  /** Names of the ports of a group: bmc; swp1 … swp48; 1 … 24. */
  function groupNames(g) {
    if (!given(g.first) && !given(g.count)) return [g.name];
    const first = given(g.first) ? g.first : 1;
    return Array.from({ length: given(g.count) ? g.count : 1 }, (_, i) => `${g.name}${first + i}`);
  }

  /** Valid port groups: groups that repeat a name or go past 32 groups or 1024 ports are dropped. */
  function cleanPorts(list) {
    const out = [];
    const names = new Set();
    let total = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      if (out.length >= LIMITS.portGroups) break;
      const g = cleanPortGroup(raw);
      if (!g) continue;
      const own = groupNames(g);
      if (total + own.length > LIMITS.ports || own.some((n) => names.has(n))) continue;
      own.forEach((n) => names.add(n));
      total += own.length;
      out.push(g);
    }
    return out;
  }

  /**
   * Why the port groups `list` cannot be a device type's ports as given, or
   * null: a group without a connector or name, a port named twice, or more
   * than 32 groups or 1024 ports (cleanPorts would drop those silently).
   */
  function portsProblem(list) {
    const groups = Array.isArray(list) ? list : [];
    if (groups.length > LIMITS.portGroups) return `A device type has at most ${LIMITS.portGroups} port groups`;
    const names = new Set();
    let total = 0;
    for (const raw of groups) {
      const g = cleanPortGroup(raw);
      if (!g) return 'A port group needs a name, like bmc, or a range, like swp[1-48], and a connector';
      const own = groupNames(g);
      total += own.length;
      if (total > LIMITS.ports) return `A device type has at most ${LIMITS.ports} ports`;
      for (const n of own) {
        if (names.has(n)) return `Port ${n} is named twice`;
        names.add(n);
      }
    }
    return null;
  }

  /** The side of a device type that all its ports are on, 'front' or 'rear'; null when it has none or ports on both. */
  function portsSide(type) {
    const sides = new Set((type.ports || []).map((g) => g.side));
    return sides.size === 1 ? [...sides][0] : null;
  }

  /**
   * Whether a new device of `type` is mounted back to front: when its
   * ports are all on its front (a switch), so that they face the rear of
   * the rack like the ports of servers.
   */
  function mountsReversed(type) {
    return type.face !== 'reserved' && !type.pdu && portsSide(type) === 'front';
  }

  /** Every port of a device type in catalog order: [{ name, group, index, connector, speedGbps, side }]. */
  function expandPorts(type) {
    const out = [];
    ((type && type.ports) || []).forEach((g, group) =>
      groupNames(g).forEach((name, index) => out.push({ name, group, index, connector: g.connector, speedGbps: g.speedGbps, side: g.side }))
    );
    return out;
  }

  // ------------------------------------------------------- inlets, outlets

  function powerConnectorById(id) {
    return POWER_CONNECTOR_MAP.get(id) || null;
  }
  /** The power connector id `v` names, in any case; an id this version does not know as it is; '' for no id. */
  function powerConnectorId(v) {
    if (typeof v !== 'string') return '';
    const c = POWER_CONNECTOR_MAP.get(v.toLowerCase());
    return c ? c.id : OTHER_CONNECTOR.test(v) ? v : '';
  }
  const powerConnectorLabel = (id) => (powerConnectorById(id) || { label: String(id).toUpperCase() }).label;

  /**
   * A valid inlet or outlet group from untrusted input, or null: like a
   * port group (psu[1-2], [1-24], in), with a power connector.
   */
  function cleanPowerGroup(raw) {
    if (!isObj(raw)) return null;
    const conn = powerConnectorId(raw.connector);
    const name = portName(raw.name);
    const series = given(raw.first) || given(raw.count);
    if (!conn || (!series && !name)) return null;
    const g = { name };
    if (series) {
      g.first = clampInt(raw.first, 0, 9999, 1);
      g.count = clampInt(raw.count, 1, LIMITS.outlets, 1);
    }
    g.connector = conn;
    return g;
  }

  /** Valid inlet or outlet groups: at most `maxGroups` of them and `maxTotal` names; a group that repeats a name is dropped. */
  function cleanPowerGroups(list, maxGroups, maxTotal) {
    const out = [];
    const names = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
      if (out.length >= maxGroups) break;
      const g = cleanPowerGroup(raw);
      if (!g) continue;
      const own = groupNames(g);
      if (names.size + own.length > maxTotal || own.some((n) => names.has(n))) continue;
      own.forEach((n) => names.add(n));
      out.push(g);
    }
    return out;
  }
  /** The power inlets of a device type from untrusted input: up to 4 groups and 8 inlets. */
  const cleanInlets = (list) => cleanPowerGroups(list, LIMITS.inletGroups, LIMITS.inlets);
  /** The outlets of a PDU type from untrusted input: up to 32 groups and 96 outlets. */
  const cleanOutlets = (list) => cleanPowerGroups(list, LIMITS.outletGroups, LIMITS.outlets);

  /** Why `list` cannot be a type's inlets ('inlet') or outlets ('outlet') as given, or null (see portsProblem). */
  function powerGroupsProblem(list, what) {
    const groups = Array.isArray(list) ? list : [];
    const outlet = what === 'outlet';
    const maxGroups = outlet ? LIMITS.outletGroups : LIMITS.inletGroups;
    const maxTotal = outlet ? LIMITS.outlets : LIMITS.inlets;
    const holder = outlet ? 'A PDU type' : 'A device type';
    if (groups.length > maxGroups) return `${holder} has at most ${maxGroups} ${what} groups`;
    const names = new Set();
    for (const raw of groups) {
      const g = cleanPowerGroup(raw);
      if (g && Number(raw.count) > maxTotal) return `${holder} has at most ${maxTotal} ${what}s`;
      if (!g) return outlet ? 'An outlet group needs a range, like [1-24], and a connector' : 'An inlet group needs a name, like in, or a range, like psu[1-2], and a connector';
      for (const n of groupNames(g)) {
        if (names.has(n)) return `${outlet ? 'Outlet' : 'Inlet'} ${n} is named twice`;
        names.add(n);
      }
      if (names.size > maxTotal) return `${holder} has at most ${maxTotal} ${what}s`;
    }
    return null;
  }

  const expandGroups = (groups) => {
    const out = [];
    (groups || []).forEach((g, group) => groupNames(g).forEach((name, index) => out.push({ name, group, index, connector: g.connector })));
    return out;
  };
  /** Every power inlet of a device type in catalog order: [{ name, group, index, connector }]. */
  function expandInlets(type) {
    return expandGroups(type && type.inlets);
  }
  /** Every outlet of a PDU type from the top of the strip down: [{ name, group, index, connector }]; none for other types. */
  function expandOutlets(type) {
    return expandGroups(type && type.pdu && type.pdu.outlets);
  }

  /**
   * The two ends of a range of outlets such as "3-8" or "L1-1-L1-3": the
   * text before and after the first dash that has an outlet name (a key
   * of `at`) on both sides, as outlet names may hold dashes; or null.
   */
  function rangeEnds(token, at) {
    for (let i = 1; i < token.length - 1; i++) {
      if (token[i] !== '-' && token[i] !== '–') continue;
      const ends = [token.slice(0, i), token.slice(i + 1)];
      if (at.has(ends[0]) && at.has(ends[1])) return ends;
    }
    return null;
  }

  /**
   * Outlet names as the text of a fuse or meter group: runs of outlets
   * that follow each other on the PDU (`all`: every outlet name in order)
   * are written as a range: "1-5, 21, 26-28". A run whose range would
   * read as another outlet or range (names with dashes can do that) is
   * written name by name, so that parseOutletList reads back what was
   * written.
   */
  function formatOutletList(names, all) {
    const at = new Map(all.map((n, i) => [n, i]));
    const list = [...new Set(names)].filter((n) => at.has(n)).sort((a, b) => at.get(a) - at.get(b));
    const out = [];
    for (let i = 0; i < list.length; ) {
      let j = i;
      while (j + 1 < list.length && at.get(list[j + 1]) === at.get(list[j]) + 1) j++;
      const range = `${list[i]}-${list[j]}`;
      const ends = j > i && !at.has(range) ? rangeEnds(range, at) : null;
      if (ends && ends[0] === list[i] && ends[1] === list[j]) out.push(range);
      else out.push(...list.slice(i, j + 1));
      i = j + 1;
    }
    return out.join(', ');
  }

  /**
   * Reads outlets as formatOutletList writes them, and with spaces for
   * commas: { names } in the order of `all`, or { error } (a sentence) for
   * a name that is no outlet or a range that runs backwards.
   */
  function parseOutletList(text, all) {
    const at = new Map(all.map((n, i) => [n, i]));
    const picked = new Set();
    for (const token of String(text == null ? '' : text).split(/[,;\s]+/).filter(Boolean)) {
      if (at.has(token)) {
        picked.add(token);
        continue;
      }
      const ends = rangeEnds(token, at);
      if (!ends) return { error: `“${token.slice(0, 40)}” is no outlet of this PDU` };
      if (at.get(ends[1]) < at.get(ends[0])) return { error: `“${token}” runs backwards: put the first outlet first` };
      for (let i = at.get(ends[0]); i <= at.get(ends[1]); i++) picked.add(all[i]);
    }
    return { names: all.filter((n) => picked.has(n)) };
  }

  const groupName = (v, max) => str(typeof v === 'number' ? String(v) : v, max || 20).replace(/[|,;]/g, '');

  /**
   * The `pdu` block of a vertical PDU type from untrusted input. Each
   * outlet is in one fuse group, and with metering per group in one meter
   * group: an outlet named twice counts where it is named first, a name
   * that is no outlet is dropped, and the outlets left over get a group
   * of their own, the fuse at the PDU's rating.
   */
  function cleanPdu(raw) {
    const r = isObj(raw) ? raw : {};
    const phases = Number(r.phases) === 3 ? 3 : 1;
    const maxA = clampNum(r.maxA, 1, 1000, 32);
    const outlets = cleanOutlets(r.outlets);
    const all = [].concat(...outlets.map(groupNames));
    const known = new Set(all);
    const groups = (list, max, prefix, make) => {
      const out = [];
      const names = new Set();
      const seen = new Set();
      const add = (name, own, from) => {
        let n = name;
        for (let i = 2; names.has(n.toLowerCase()); i++) n = `${name.slice(0, 17)} ${i}`;
        names.add(n.toLowerCase());
        out.push(make(n, own, from));
      };
      for (const g of Array.isArray(list) ? list : []) {
        if (out.length >= max) break;
        if (!isObj(g)) continue;
        const own = [];
        for (const o of Array.isArray(g.outlets) ? g.outlets : []) {
          const n = portName(o);
          if (!known.has(n) || seen.has(n)) continue;
          seen.add(n);
          own.push(n);
        }
        if (own.length) add(groupName(g.name) || `${prefix}${out.length + 1}`, all.filter((n) => own.includes(n)), g);
      }
      const rest = all.filter((n) => !seen.has(n));
      if (rest.length && out.length < max) add(`${prefix}${out.length + 1}`, rest, {});
      else if (rest.length) out[max - 1].outlets = all.filter((n) => rest.includes(n) || out[max - 1].outlets.includes(n));
      return out;
    };
    const metering = METERING.some((m) => m.id === r.metering) ? r.metering : 'inlet';
    return {
      spanU: clampInt(r.spanU, 1, LIMITS.unitsMax, 42),
      phases,
      voltageV: clampNum(r.voltageV, 1, 1000, 230),
      maxA,
      outlets,
      fuses: groups(r.fuses, LIMITS.fuseGroups, 'CB', (name, own, g) => ({
        name,
        outlets: own,
        ratingA: clampNum(g.ratingA, 0.5, 1000, maxA),
        phase: phases === 3 && PHASES.includes(g.phase) ? g.phase : 'L1',
      })),
      metering,
      meters: metering === 'group' ? groups(r.meters, LIMITS.meterGroups, 'M', (name, own) => ({ name, outlets: own })) : [],
    };
  }

  /**
   * Why `raw` cannot be a PDU type's `pdu` block as given, or null: what
   * cleanPdu would drop or add silently. Each outlet is in exactly one
   * fuse group, and with metering per group in exactly one meter group.
   */
  function pduProblem(raw) {
    const r = isObj(raw) ? raw : {};
    const bad = powerGroupsProblem(r.outlets, 'outlet');
    if (bad) return bad;
    const all = [].concat(...cleanOutlets(r.outlets).map(groupNames));
    if (!all.length) return 'A PDU needs outlets, like [1-24]';
    const known = new Set(all);
    const check = (list, max, what) => {
      const groups = Array.isArray(list) ? list : [];
      if (groups.length > max) return `A PDU type has at most ${max} ${what} groups`;
      const names = new Set();
      const seen = new Map();
      for (const g of groups) {
        const name = isObj(g) ? groupName(g.name) : '';
        if (!name) return `A ${what} group needs a name`;
        if (names.has(name.toLowerCase())) return `Two ${what} groups are named ${name}`;
        names.add(name.toLowerCase());
        const own = Array.isArray(g.outlets) ? g.outlets.map(portName) : [];
        if (!own.length) return `${name} has no outlets`;
        for (const o of own) {
          if (!known.has(o)) return `${name} names outlet ${o}, which the PDU does not have`;
          if (seen.has(o)) return seen.get(o) === name ? `${name} names outlet ${o} twice` : `Outlet ${o} is in ${seen.get(o)} and in ${name}`;
          seen.set(o, name);
        }
      }
      const rest = all.filter((n) => !seen.has(n));
      if (rest.length) return `${rest.length === 1 ? 'Outlet' : 'Outlets'} ${formatOutletList(rest, all)} ${rest.length === 1 ? 'is' : 'are'} in no ${what} group`;
      return null;
    };
    return check(r.fuses, LIMITS.fuseGroups, 'fuse') || (r.metering === 'group' ? check(r.meters, LIMITS.meterGroups, 'meter') : null);
  }

  /** The fuse group and meter group (null without one) of each outlet of a PDU type: Map from outlet name to { fuse, meter }. */
  function outletGroups(type) {
    const out = new Map();
    if (!isPduType(type)) return out;
    for (const o of expandOutlets(type)) out.set(o.name, { fuse: null, meter: null });
    for (const f of type.pdu.fuses) for (const n of f.outlets) if (out.has(n)) out.get(n).fuse = f;
    for (const m of type.pdu.meters) for (const n of m.outlets) if (out.has(n)) out.get(n).meter = m;
    return out;
  }

  /**
   * The `pdu` block with the outlets `names` in one group of `key` ('fuses'
   * or 'meters'): the group at index `to`, or without `to` a new one, which
   * takes the rating and phase of the group its first outlet was in. The
   * outlets leave the groups they were in, and a group left without one is
   * gone. Returns a message when there is nothing to do, or no room for
   * another group.
   */
  function groupOutlets(pdu, key, names, to) {
    const fuses = key === 'fuses';
    const what = fuses ? 'fuse' : 'meter';
    const next = clone(pdu);
    if (!fuses && next.metering !== 'group') return 'Only a PDU that measures per group has meter groups';
    const list = next[key];
    const wanted = new Set(names);
    const picked = [].concat(...next.outlets.map(groupNames)).filter((n) => wanted.has(n));
    if (!picked.length) return 'Pick outlets in the strip first';
    const these = picked.length === 1 ? 'this outlet' : 'these outlets';
    let target = to == null ? null : list[to];
    if (to != null && !target) return `Unknown ${what} group`;
    if (target && picked.every((n) => target.outlets.includes(n))) return `${target.name} holds ${these} already`;
    const whole = !target && list.find((g) => g.outlets.length === picked.length && picked.every((n) => g.outlets.includes(n)));
    if (whole) return `${whole.name} is ${these} already`;
    const from = list.find((g) => g.outlets.includes(picked[0])) || {};
    for (const g of list) g.outlets = g.outlets.filter((n) => !wanted.has(n));
    if (!target) {
      const max = fuses ? LIMITS.fuseGroups : LIMITS.meterGroups;
      if (list.filter((g) => g.outlets.length).length >= max) return `A PDU type has at most ${max} ${what} groups`;
      const prefix = fuses ? 'CB' : 'M';
      const taken = new Set(list.map((g) => g.name.toLowerCase()));
      let n = list.length + 1;
      while (taken.has(`${prefix}${n}`.toLowerCase())) n++;
      target = Object.assign({}, from, { name: `${prefix}${n}`, outlets: [] });
      list.push(target);
    }
    target.outlets = target.outlets.concat(picked);
    return cleanPdu(next);
  }

  /** A group written as a pattern: swp[1-48], Ethernet1/[1-32], [1-24] or bmc. */
  function portPattern(g) {
    if (!given(g.first) && !given(g.count)) return g.name;
    const first = given(g.first) ? g.first : 1;
    const count = given(g.count) ? g.count : 1;
    return count === 1 ? `${g.name}[${first}]` : `${g.name}[${first}-${first + count - 1}]`;
  }

  /** Reads a pattern like portPattern writes: { name, first, count }, { name } for one port, or null. */
  function parsePortPattern(text) {
    return portPatternProblem(text) ? null : readPortPattern(text);
  }
  const PORT_RANGE = /^(.*?)\[\s*(\d+)\s*(?:[-–]\s*(\d+)\s*)?\]$/;
  function readPortPattern(text) {
    const t = String(text == null ? '' : text).trim();
    const m = PORT_RANGE.exec(t);
    if (!m) return { name: t };
    const first = parseInt(m[2], 10);
    const last = m[3] === undefined ? first : parseInt(m[3], 10);
    return { name: m[1].trim(), first, count: last - first + 1 };
  }
  /** Why `text` is no pattern parsePortPattern reads (a sentence), or null when it is one. */
  function portPatternProblem(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return 'A port group needs a name, like bmc, or a range, like swp[1-48]';
    const g = readPortPattern(t);
    if (portName(g.name) !== g.name) return `“${t}” isn’t a port name or a range like swp[1-48]`;
    if (g.count === undefined) return null;
    if (g.count < 1) return `“${t}” counts down: put the lower number first, like swp[1-48]`;
    if (g.first > 9999) return 'Port numbers go up to 9999';
    if (g.count > LIMITS.ports) return `A device type has at most ${LIMITS.ports} ports`;
    return null;
  }

  // --------------------------------------------------------------- catalogs

  /** A valid device type from untrusted input (the id is left to the caller). */
  function cleanDeviceType(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const label = str(r.label, 60) || 'Device';
    // A vertical PDU takes no rack units, and is fed by its grid, not through inlets.
    const pdu = isObj(r.pdu);
    const t = {
      id: str(String(r.id == null ? '' : r.id), 40),
      label,
      tag: (str(r.tag, 12) || label.split(/\s+/)[0].slice(0, 12)).toUpperCase(),
      spec: str(r.spec, 60),
      height: pdu ? 0 : clampInt(r.height, 1, LIMITS.deviceHeight, 1),
      face: pdu ? 'pdu' : FACE_IDS.has(r.face) ? r.face : 'generic',
      defaultName: str(r.defaultName, NAME_MAX) || `${slug(label, 20) || 'dev'}-01`,
      powerW: clampNum(r.powerW, 0, 100000, 0),
      weightKg: clampNum(r.weightKg, 0, 5000, 0),
      ports: cleanPorts(r.ports),
      inlets: pdu ? [] : cleanInlets(r.inlets),
      slackM: clampNum(r.slackM, 0, 10, 0),
    };
    if (pdu) t.pdu = cleanPdu(r.pdu);
    return t;
  }

  /** The PDU slots of a rack type from untrusted input: up to 4 sides; `dflt` for anything that is no list. */
  function cleanPduSlots(list, dflt) {
    if (!Array.isArray(list)) return dflt.slice();
    return list.filter((s) => PDU_SIDES.includes(s)).slice(0, LIMITS.pduSlots);
  }

  /** A valid rack type from untrusted input (the id is left to the caller). */
  function cleanRackType(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const units = clampInt(r.units, LIMITS.unitsMin, LIMITS.unitsMax, RACK_UNITS);
    return {
      id: str(String(r.id == null ? '' : r.id), 40),
      name: str(r.name, 60) || `${units}U rack`,
      units,
      sideSlots: clampInt(r.sideSlots, 0, maxSideSlots(units), Math.min(SIDE_SLOTS, maxSideSlots(units))),
      pduSlots: cleanPduSlots(r.pduSlots, units < PDU_SLOT_UNITS ? [] : DEFAULT_PDU_SLOTS),
      // The PDU type new racks of this type get in each slot; the caller checks that it is one of the plan.
      defaultPdu: str(typeof r.defaultPdu === 'number' ? String(r.defaultPdu) : r.defaultPdu, 40) || null,
      powerW: clampNum(r.powerW, 0, 1000000, 0),
      weightKg: clampNum(r.weightKg, 0, 100000, 0),
      widthMm: clampInt(r.widthMm, 300, 1200, 600),
      depthMm: clampInt(r.depthMm, 600, 1600, 1200),
      trayM: clampNum(r.trayM, 0, 10, 0.5),
      slackM: clampNum(r.slackM, 0, 10, 0.25),
    };
  }

  /** Connectors a cable of `media` can have as plugs. */
  function mediaConnectors(media) {
    const m = MEDIA[media];
    if (!m) return [];
    if (m.kind === 'copper') return CONNECTORS.filter((c) => c.family === 'rj45').map((c) => c.id);
    if (m.kind === 'fiber') return ['lc', 'mpo'];
    if (media === 'sas') return ['sas-hd'];
    return CONNECTORS.filter((c) => c.cage).map((c) => c.id);
  }

  function guessMedia(connector) {
    const c = connectorById(connector);
    if (!c) return 'cat6a';
    if (c.cage) return 'dac';
    return { lc: 'om4', mpo: 'om4', sas: 'sas' }[c.family] || 'cat6a';
  }

  /**
   * A catalog name from untrusted input: cable schedules mark picked types
   * and transceivers with "(auto)", so a name doesn't end in it.
   */
  const catalogName = (v) => str(v, 60).replace(/(\s*\(auto\))+$/i, '').trim();

  /**
   * A valid cable type from untrusted input (the id is left to the caller).
   * Plugs that don't suit the media fall back to its usual one; a plug this
   * version does not know is kept, and fits no port.
   */
  function cleanCableType(raw) {
    const r = isObj(raw) ? raw : {};
    const media = MEDIA[r.media] ? r.media : guessMedia(connectorId(r.connector));
    const allowed = mediaConnectors(media);
    const plug = (v, dflt) => {
      const id = connectorId(v);
      return allowed.includes(id) || (id && !connectorById(id)) ? id : dflt;
    };
    const connector = plug(r.connector, MEDIA[media].plug);
    const connectorB = plug(r.connectorB, connector);
    const legs = clampInt(r.legs, 1, LIMITS.legs, 1);
    const plugs = legs > 1 ? `${connectorLabel(connector)} to ${legs} × ${connectorLabel(connectorB)}` : connectorLabel(connector);
    const lengths = (Array.isArray(r.lengthsM) ? r.lengthsM : []).map((v) => clampNum(v, 0.1, 10000, null)).filter((v) => v !== null);
    return {
      id: str(String(r.id == null ? '' : r.id), 40),
      name: catalogName(r.name) || `${plugs} ${MEDIA[media].short}`,
      media,
      connector,
      connectorB,
      legs,
      speedGbps: clampNum(r.speedGbps, 0, 1600, 0),
      maxM: clampNum(r.maxM, 0, 100000, 0),
      lengthsM: [...new Set(lengths)].sort((a, b) => a - b).slice(0, 40),
    };
  }

  /** A valid transceiver from untrusted input (the id is left to the caller). A connector this version does not know is kept, and fits no port. */
  function cleanTransceiver(raw) {
    const r = isObj(raw) ? raw : {};
    const id = connectorId(r.connector);
    const conn = connectorById(id);
    const connector = conn ? (conn.cage ? conn.id : 'qsfp56') : id || 'qsfp56';
    const fiber = r.fiber === 'mpo' ? 'mpo' : 'lc';
    const mode = r.mode === 'smf' ? 'smf' : 'mmf';
    const speedGbps = clampNum(r.speedGbps, 0, 1600, (connectorById(connector) || { speedGbps: 0 }).speedGbps);
    return {
      id: str(String(r.id == null ? '' : r.id), 40),
      name: catalogName(r.name) || `${connectorLabel(connector)} ${speedGbps}G ${mode === 'smf' ? 'LR' : 'SR'}`,
      connector,
      fiber,
      mode,
      speedGbps,
      reachM: clampNum(r.reachM, 0, 100000, 100),
    };
  }

  /** First label of a network's series: up to three letters of its name, INF-0001 for InfiniBand. */
  function defaultFirstLabel(name) {
    const code = slug(name, 60).replace(/-/g, '').slice(0, 3).toUpperCase();
    return `${code || 'C'}-0001`;
  }

  function nextNetworkColor(project) {
    const used = new Set((project.networks || []).map((n) => n.color));
    return CLUSTER_COLORS.find((c) => !used.has(c)) || CLUSTER_COLORS[(project.networks || []).length % CLUSTER_COLORS.length];
  }

  /** A valid network from untrusted input (the id is left to the caller); `project` picks a free color when it has none. */
  function cleanNetwork(raw, project) {
    const r = isObj(raw) ? raw : {};
    const name = str(r.name, 60) || 'Network';
    return {
      id: str(String(r.id == null ? '' : r.id), 80),
      name,
      color: normalizeHex(r.color) || (project ? nextNetworkColor(project) : CLUSTER_COLORS[0]),
      firstLabel: str(r.firstLabel, 40) || defaultFirstLabel(name),
    };
  }

  /** A valid cord type from untrusted input (the id is left to the caller): the outlet and the inlet its plugs fit. */
  function cleanCordType(raw) {
    const r = isObj(raw) ? raw : {};
    const outlet = powerConnectorId(r.outlet) || 'c13';
    const inlet = powerConnectorId(r.inlet) || 'c14';
    const lengths = (Array.isArray(r.lengthsM) ? r.lengthsM : []).map((v) => clampNum(v, 0.1, 100, null)).filter((v) => v !== null);
    return {
      id: str(String(r.id == null ? '' : r.id), 40),
      name: catalogName(r.name) || `${powerConnectorLabel(inlet)} to ${powerConnectorLabel(outlet)} cord`,
      outlet,
      inlet,
      maxA: clampNum(r.maxA, 0.5, 1000, Math.min((powerConnectorById(outlet) || { maxA: 10 }).maxA, (powerConnectorById(inlet) || { maxA: 10 }).maxA)),
      lengthsM: [...new Set(lengths)].sort((a, b) => a - b).slice(0, 40),
    };
  }

  function nextGridColor(project) {
    const used = new Set((project.powerGrids || []).map((g) => g.color));
    return GRID_COLORS.find((c) => !used.has(c)) || GRID_COLORS[(project.powerGrids || []).length % GRID_COLORS.length];
  }
  function nextGridName(project) {
    const grids = project.powerGrids || [];
    return firstFreeName(grids, grids.length, (i) => `Grid ${letters(i)}`);
  }

  /** A valid power grid from untrusted input (the id is left to the caller); `project` gives a free name and color when it has none. */
  function cleanPowerGrid(raw, project) {
    const r = isObj(raw) ? raw : {};
    return {
      id: str(String(r.id == null ? '' : r.id), 80),
      name: str(r.name, 60) || (project ? nextGridName(project) : 'Grid'),
      color: normalizeHex(r.color) || (project ? nextGridColor(project) : GRID_COLORS[0]),
      note: str(r.note, 120),
    };
  }

  /** The plan's power settings from untrusted input: the power factor (0.5–1) and the share of a rating to plan up to (10–100 %). */
  function cleanPowerSettings(raw) {
    const r = isObj(raw) ? raw : {};
    return { powerFactor: clampNum(r.powerFactor, 0.5, 1, DEFAULT_POWER_SETTINGS.powerFactor), limitPct: clampNum(r.limitPct, 10, 100, DEFAULT_POWER_SETTINGS.limitPct) };
  }

  function formatTypeSpec(type, height) {
    if (type.variable) return height ? `${height}U · ${type.spec}` : `any height · ${type.spec}`;
    return type.spec ? `${type.height}U · ${type.spec}` : `${type.height}U`;
  }

  /** Adds a device type from `template`; null when the catalog is full. */
  function addDeviceType(project, template) {
    if (project.deviceTypes.length >= LIMITS.deviceTypes) return null;
    const t = cleanDeviceType(template);
    t.id = uid('t');
    t.label = uniqueLabel(project.deviceTypes, 'label', t.label);
    project.deviceTypes.push(t);
    return t;
  }

  /**
   * Changes a device type. Returns an error message and leaves the plan
   * unchanged when placed devices would no longer fit, or when another
   * type has its label. When its ports
   * change, cables keep their place in each port group (see remapPorts).
   */
  function updateDeviceType(project, id, changes) {
    const i = project.deviceTypes.findIndex((t) => t.id === id);
    if (i < 0) return 'Unknown device type';
    const before = project.deviceTypes[i];
    const merged = Object.assign({}, before, changes);
    // `pdu: null` makes a rack device of a PDU type.
    if (!isObj(merged.pdu)) delete merged.pdu;
    const next = cleanDeviceType(merged);
    next.id = id;
    if (next.label !== before.label && nameTaken(project.deviceTypes, next.label, id, 'label')) return `Another device type is named ${next.label}`;
    if (isPduType(next) !== isPduType(before)) {
      const n = project.devices.filter((d) => d.type === id).length;
      if (n) return isPduType(next) ? `${plural(n, 'device')} of this type ${n === 1 ? 'is' : 'are'} placed: a vertical PDU goes in a PDU slot` : `${plural(n, 'PDU')} of this type ${n === 1 ? 'is' : 'are'} placed in PDU slots`;
    }
    project.deviceTypes[i] = next;
    if (next.height !== before.height && !isPduType(next)) {
      const racks = new Set(project.devices.filter((d) => d.type === id).map((d) => d.loc.rack));
      const problem = layoutProblem(project, racks);
      if (problem) {
        project.deviceTypes[i] = before;
        return `${next.height}U does not fit: ${problem}`;
      }
    }
    // A type that is no vertical PDU any more is no rack type's default PDU.
    if (isPduType(before) && !isPduType(next)) for (const rt of project.rackTypes) if (rt.defaultPdu === id) rt.defaultPdu = null;
    const moves = typeMoves(before, next);
    if (moves) movePortRefs(project, new Set(project.devices.filter((d) => d.type === id).map((d) => d.id)), moves);
    return null;
  }

  /** Removes a device type together with its devices, their cables and their power cords. A rack type that named it as its default PDU has none. */
  function deleteDeviceType(project, id) {
    project.deviceTypes = project.deviceTypes.filter((t) => t.id !== id);
    project.devices = project.devices.filter((d) => d.type !== id);
    for (const t of project.rackTypes) if (t.defaultPdu === id) t.defaultPdu = null;
    pruneCables(project);
  }

  /**
   * Moves item `i` of list `from` to position `toIndex` of list `to` (the
   * end when null; `to` may be `from`). Between two lists, `from` keeps at
   * least one item and `to` takes at most `max`.
   */
  function moveItem(from, i, to, toIndex, max) {
    if (i < 0 || (to !== from && (to.length >= max || from.length <= 1))) return false;
    const [item] = from.splice(i, 1);
    to.splice(Math.max(0, Math.min(to.length, toIndex == null ? to.length : toIndex)), 0, item);
    return true;
  }

  function moveType(list, id, toIndex) {
    const i = list.findIndex((t) => t.id === id);
    return i !== Math.max(0, Math.min(list.length - 1, toIndex)) && moveItem(list, i, list, toIndex);
  }
  /** Moves a device type to position `toIndex` of the catalog; the parts panel follows this order. */
  function moveDeviceType(project, id, toIndex) {
    return moveType(project.deviceTypes, id, toIndex);
  }
  /** Moves a rack type to position `toIndex`; the first one is used for racks in new rows. */
  function moveRackType(project, id, toIndex) {
    return moveType(project.rackTypes, id, toIndex);
  }

  /** A rack type's default PDU, as it can be in the plan: a vertical PDU type of the catalog, and only with PDU slots to fill. */
  function checkDefaultPdu(project, t) {
    if (t.defaultPdu && (!t.pduSlots.length || !isPduType(typeOf(project, t.defaultPdu)))) t.defaultPdu = null;
    return t;
  }

  function addRackType(project, template) {
    if (project.rackTypes.length >= LIMITS.rackTypes) return null;
    const t = checkDefaultPdu(project, cleanRackType(template));
    t.id = uid('rt');
    t.name = uniqueLabel(project.rackTypes, 'name', t.name);
    project.rackTypes.push(t);
    return t;
  }

  /** Changes a rack type; refuses (with a message) when devices would not fit, or when another type has its name. */
  function updateRackType(project, id, changes) {
    const i = project.rackTypes.findIndex((t) => t.id === id);
    if (i < 0) return 'Unknown rack type';
    const before = project.rackTypes[i];
    const next = checkDefaultPdu(project, cleanRackType(Object.assign({}, before, changes)));
    next.id = id;
    if (next.name !== before.name && nameTaken(project.rackTypes, next.name, id)) return `Another rack type is named ${next.name}`;
    project.rackTypes[i] = next;
    const racks = new Set(allRacks(project).filter((r) => r.rack.type === id).map((r) => r.rack.id));
    const problem = layoutProblem(project, racks);
    if (problem) {
      project.rackTypes[i] = before;
      return problem;
    }
    return null;
  }

  function rackTypeUse(project, id) {
    return allRacks(project).filter((r) => r.rack.type === id).length;
  }

  /** Removes an unused rack type; returns an error message otherwise. */
  function deleteRackType(project, id) {
    const n = rackTypeUse(project, id);
    if (n) return `${n} rack${n === 1 ? ' uses' : 's use'} this type`;
    if (project.rackTypes.length <= 1) return 'A plan needs at least one rack type';
    project.rackTypes = project.rackTypes.filter((t) => t.id !== id);
    return null;
  }

  /** Gives a rack another type; refuses when its devices would not fit. */
  function setRackType(project, rackId, typeId) {
    const rack = rackById(project, rackId);
    if (!rack || !rackTypeById(project, typeId)) return 'Unknown rack or rack type';
    const before = rack.type;
    rack.type = typeId;
    const problem = layoutProblem(project, new Set([rackId]));
    if (problem) {
      rack.type = before;
      return problem;
    }
    return null;
  }

  // ------------------------------------------------------------- structure

  function nextFloorName(project) {
    return firstFreeName(project.floors, project.floors.length + 1, (i) => `Floor ${i}`);
  }
  function nextRowName(floor) {
    return firstFreeName(floor.rows, floor.rows.length, (i) => `Row ${letters(i)}`);
  }

  /** Short code of a row for rack names: "Row C" → C; on floor 2 → 2C. */
  function rowCode(project, rowId) {
    const pos = locateRow(project, rowId);
    if (!pos) return 'A';
    const m = /^row\s+([a-z0-9]{1,3})$/i.exec(pos.row.name.trim());
    const code = m ? m[1].toUpperCase() : letters(pos.rowIndex);
    return (pos.floorIndex > 0 ? String(pos.floorIndex + 1) : '') + code;
  }
  /** Name for the rack at `index` of a row (Rack A01, Rack A02, …). */
  function defaultRackName(project, rowId, index) {
    return `Rack ${rowCode(project, rowId)}${pad2(index + 1)}`;
  }
  function nextRackName(project, rowId) {
    const racks = (rowById(project, rowId) || { racks: [] }).racks;
    return firstFreeName(racks, racks.length, (i) => defaultRackName(project, rowId, i));
  }

  /** A plan with the standard catalog and nothing on it, not even a floor; `props` overrides. */
  function newProjectShell(props) {
    return Object.assign(
      {
        version: SCHEMA_VERSION,
        name: 'Untitled rack plan',
        info: { site: '', author: '', revision: '' },
        deviceTypes: clone(DEFAULT_DEVICE_TYPES),
        rackTypes: clone(DEFAULT_RACK_TYPES),
        cableTypes: clone(DEFAULT_CABLE_TYPES),
        transceivers: clone(DEFAULT_TRANSCEIVERS),
        cordTypes: clone(DEFAULT_CORD_TYPES),
        floors: [],
        views: [{ id: 'v1', name: DEFAULT_VIEW_NAME, clusters: [] }],
        networks: [],
        powerGrids: [],
        powerSettings: clone(DEFAULT_POWER_SETTINGS),
        devices: [],
        cables: [],
        powerCords: [],
        meta: {},
      },
      props
    );
  }

  function clampRackCount(n) {
    return clampInt(n, 1, LIMITS.racks, DEFAULT_RACKS);
  }

  /**
   * Adds the first floor of a plan that has none (see addFloor), with the
   * ids a new plan starts with: f1, row1 and r1, r2, … by position. Floors,
   * rows and racks added later get random ids, so these are never given
   * out again. The racks get their default PDUs once they have these ids,
   * unless `opts.empty`.
   */
  function addFirstFloor(project, opts) {
    const o = opts || {};
    const floor = addFloor(project, Object.assign({}, o, { empty: true }));
    floor.id = 'f1';
    floor.rows[0].id = 'row1';
    floor.rows[0].racks.forEach((r, i) => (r.id = `r${i + 1}`));
    if (!o.empty) fillPduSlots(project, floor.rows[0].racks.map((r) => r.id));
    return floor;
  }

  /** A plan with one floor and one row of `rackCount` empty 47U racks. */
  function createEmptyProject(rackCount) {
    const p = newProjectShell();
    addFirstFloor(p, { racks: rackCount ? clampRackCount(rackCount) : DEFAULT_RACKS });
    return p;
  }

  /** Same floors, rows, racks, catalogs, views and power settings as `project`, without devices, clusters, cables, networks, power cords or power grids. */
  function copyLayout(project) {
    const p = clone(project);
    p.devices = [];
    for (const v of p.views) v.clusters = [];
    p.cables = [];
    p.networks = [];
    p.powerCords = [];
    p.powerGrids = [];
    p.meta = {};
    p.name = `${project.name} (layout)`;
    return p;
  }

  /**
   * Inserts a floor without rows at `index` (default: the end), named `name`
   * or Floor N, with a number when another floor has that name. Null when
   * the plan has six floors.
   */
  function insertFloor(project, name, index) {
    if (project.floors.length >= LIMITS.floors) return null;
    const floor = { id: uid('f'), name: uniqueLabel(project.floors, 'name', str(name, LIMITS.name) || nextFloorName(project)), rowPitchM: DEFAULT_ROW_PITCH_M, rows: [] };
    project.floors.splice(index == null ? project.floors.length : index, 0, floor);
    return floor;
  }

  /** Inserts a row without racks into `floor`, like insertFloor. Null when the floor has eight rows. */
  function insertRow(project, floor, name, index) {
    if (floor.rows.length >= LIMITS.rows) return null;
    const row = { id: uid('row'), name: uniqueLabel(floor.rows, 'name', str(name, LIMITS.name) || nextRowName(floor)), racks: [] };
    floor.rows.splice(index == null ? floor.rows.length : index, 0, row);
    return row;
  }

  /** Adds a floor with one row of racks (see addRow); null when the plan has six floors. */
  function addFloor(project, opts) {
    const o = opts || {};
    const floor = insertFloor(project, o.name, o.index);
    if (floor) addRow(project, floor.id, { racks: o.racks == null ? DEFAULT_RACKS : o.racks, type: o.type, empty: o.empty });
    return floor;
  }

  /** Adds a row of racks to a floor, with their default PDUs unless `opts.empty` (see addRack); null when the floor has eight rows. */
  function addRow(project, floorId, opts) {
    const o = opts || {};
    const floor = floorById(project, floorId);
    const row = floor && insertRow(project, floor, o.name, o.index);
    if (!row) return null;
    const n = clampInt(o.racks, 1, LIMITS.racks, DEFAULT_RACKS);
    for (let i = 0; i < n; i++) addRack(project, row.id, { type: o.type, empty: o.empty });
    return row;
  }

  /**
   * Adds an empty rack to a row at `opts.index` (default: the end), named
   * `opts.name` like insertFloor or by its place. It gets `opts.type`, else
   * the type of its neighbour, else the first rack type of the catalog.
   * A rack of a type with a default PDU gets one in each PDU slot (see
   * fillPduSlots), unless `opts.empty`. Null when the row already has
   * sixteen racks.
   */
  function addRack(project, rowId, opts) {
    const o = opts || {};
    const row = rowById(project, rowId);
    if (!row || row.racks.length >= LIMITS.racks) return null;
    const index = o.index == null ? row.racks.length : Math.max(0, Math.min(row.racks.length, o.index));
    const neighbour = row.racks[index - 1] || row.racks[index];
    const type =
      (o.type && rackTypeById(project, o.type) && o.type) ||
      (neighbour && rackTypeById(project, neighbour.type) && neighbour.type) ||
      project.rackTypes[0].id;
    const rack = { id: uid('r'), name: uniqueLabel(row.racks, 'name', str(o.name, LIMITS.name) || nextRackName(project, rowId)), type, trayM: null, slackM: null };
    row.racks.splice(index, 0, rack);
    if (!o.empty) fillPduSlots(project, [rack.id]);
    return rack;
  }

  /** Removes the devices standing in the racks of `rackIds` (a Set), and their cables. */
  function removeDevicesIn(project, rackIds) {
    project.devices = project.devices.filter((d) => !rackIds.has(d.loc.rack));
    pruneCables(project);
  }

  /** Removes a rack and its devices. A row keeps at least one rack. */
  function removeRack(project, rackId) {
    const pos = locateRack(project, rackId);
    if (!pos || pos.row.racks.length <= 1) return false;
    pos.row.racks.splice(pos.index, 1);
    removeDevicesIn(project, new Set([rackId]));
    return true;
  }

  /**
   * Moves a rack, with its devices, to position `toIndex` of row `toRowId`
   * (the same row reorders it). A row keeps between 1 and 16 racks. In
   * another row, a rack whose name a rack there has, in any case, gets a
   * number.
   */
  function moveRack(project, rackId, toRowId, toIndex) {
    const pos = locateRack(project, rackId);
    const target = rowById(project, toRowId);
    if (!pos || !target) return false;
    const name = target === pos.row ? pos.rack.name : uniqueLabel(target.racks, 'name', pos.rack.name);
    if (!moveItem(pos.row.racks, pos.index, target.racks, toIndex, LIMITS.racks)) return false;
    pos.rack.name = name;
    return true;
  }

  /** Renames the racks of a row by position: Rack A01, Rack A02, … */
  function renumberRacks(project, rowId) {
    const row = rowById(project, rowId);
    if (row) row.racks.forEach((r, i) => (r.name = defaultRackName(project, rowId, i)));
  }

  /** Adds or removes racks at the end of a row until it has `n` (1–16). */
  function setRowRackCount(project, rowId, n) {
    const row = rowById(project, rowId);
    if (!row) return;
    const count = clampRackCount(n);
    while (row.racks.length < count) addRack(project, rowId);
    while (row.racks.length > count) removeRack(project, row.racks[row.racks.length - 1].id);
  }

  /** Devices that setRowRackCount(project, rowId, n) would remove. */
  function devicesBeyond(project, rowId, n) {
    const row = rowById(project, rowId);
    if (!row) return [];
    const gone = new Set(row.racks.slice(clampRackCount(n)).map((r) => r.id));
    return project.devices.filter((d) => gone.has(d.loc.rack));
  }

  /** Removes a row with its racks and devices. A floor keeps at least one row. */
  function removeRow(project, rowId) {
    const pos = locateRow(project, rowId);
    if (!pos || pos.floor.rows.length <= 1) return false;
    const gone = rackIdsWithin(project, rowId);
    pos.floor.rows.splice(pos.rowIndex, 1);
    removeDevicesIn(project, gone);
    return true;
  }

  /**
   * Moves a row to position `toIndex` on floor `toFloorId`. A floor keeps
   * between 1 and 8 rows. On another floor, a row whose name a row there
   * has, in any case, gets a number.
   */
  function moveRow(project, rowId, toFloorId, toIndex) {
    const pos = locateRow(project, rowId);
    const target = floorById(project, toFloorId);
    if (!pos || !target) return false;
    const name = target === pos.floor ? pos.row.name : uniqueLabel(target.rows, 'name', pos.row.name);
    if (!moveItem(pos.floor.rows, pos.rowIndex, target.rows, toIndex, LIMITS.rows)) return false;
    pos.row.name = name;
    return true;
  }

  /** Removes a floor with everything on it. A plan keeps at least one floor. */
  function removeFloor(project, floorId) {
    const i = project.floors.findIndex((f) => f.id === floorId);
    if (i < 0 || project.floors.length <= 1) return false;
    const gone = rackIdsWithin(project, floorId);
    project.floors.splice(i, 1);
    removeDevicesIn(project, gone);
    return true;
  }

  function moveFloor(project, floorId, toIndex) {
    return moveItem(project.floors, project.floors.findIndex((f) => f.id === floorId), project.floors, toIndex);
  }

  /** Gives `item` of `list` the name `name`; false (and no change) for an empty name or one another item has. */
  function renameIn(list, item, name) {
    const n = str(name, LIMITS.name);
    if (!item || !n || (n !== item.name && nameTaken(list, n, item.id))) return false;
    item.name = n;
    return true;
  }
  /** Renames a floor; false for an empty name or one another floor has, in any case. */
  function renameFloor(project, id, name) {
    return renameIn(project.floors, floorById(project, id), name);
  }
  /** Renames a row; false for an empty name or one another row of its floor has. */
  function renameRow(project, id, name) {
    const pos = locateRow(project, id);
    return !!pos && renameIn(pos.floor.rows, pos.row, name);
  }
  /** Renames a rack; false for an empty name or one another rack of its row has. */
  function renameRack(project, id, name) {
    const pos = locateRack(project, id);
    return !!pos && renameIn(pos.row.racks, pos.rack, name);
  }

  /** Rack ids in a rack, row or floor (whichever id matches). */
  function rackIdsWithin(project, id) {
    const out = new Set();
    for (const r of allRacks(project)) {
      if (r.rack.id === id || r.row.id === id || r.floor.id === id) out.add(r.rack.id);
    }
    return out;
  }
  function devicesWithin(project, id) {
    const racks = rackIdsWithin(project, id);
    return project.devices.filter((d) => racks.has(d.loc.rack));
  }

  // --------------------------------------------------------------- example

  function createExampleProject() {
    const p = newProjectShell();
    p.name = 'Hall 2 expansion';
    p.info = { site: 'Hall 2', author: 'Rackplanner', revision: 'A' };
    p.meta.example = true;
    p.deviceTypes.splice(2, 0, {
      id: 'switch-osfp', label: '32-port 400G switch', tag: 'SWITCH', spec: '32 × OSFP', height: 1, face: 'qsfp', defaultName: 'sw-osfp-01', powerW: 900, weightKg: 13,
      ports: [portSeries('p', 1, 32, 'osfp', 400, 'front')],
      inlets: psus(2),
      slackM: 0,
    });
    p.deviceTypes.push(
      { id: 'gpu-server', label: 'GPU server', tag: 'GPU', spec: '8 × GPU', height: 4, face: 'gpu', defaultName: 'gpu-srv-01', powerW: 3000, weightKg: 65, ports: clone(GPU_SERVER_PORTS), inlets: psus(4, 'c20'), slackM: 0.3 },
      { id: 'patch-panel', label: 'Patch panel', tag: 'PATCH', spec: '24 × RJ45', height: 1, face: 'patch', defaultName: 'pp-01', powerW: 0, weightKg: 2, ports: [], inlets: [], slackM: 0 },
      { id: 'pdu', label: 'PDU', tag: 'PDU', spec: '12 × C13', height: 1, face: 'pdu', defaultName: 'pdu-01', powerW: 0, weightKg: 5, ports: [onePort('mgmt', 'rj45', 1, 'rear')], inlets: [], slackM: 0 },
      Object.assign({ id: 'pdu-3p-30' }, clone(TYPE_TEMPLATES.find((t) => t.label === '0U PDU 3P 30')))
    );
    p.powerGrids = [
      { id: 'pg-a', name: 'Grid A', color: GRID_COLORS[0], note: 'UPS 1, room 0.12' },
      { id: 'pg-b', name: 'Grid B', color: GRID_COLORS[1], note: 'UPS 2, room 0.14' },
    ];
    const rack = (id, name, type) => ({ id, name, type: type || 'rack-47', trayM: null, slackM: null });
    p.floors = [
      {
        id: 'f1',
        name: 'Ground floor',
        rowPitchM: 3,
        rows: [
          { id: 'row1', name: 'Row A', racks: [rack('r1', 'Rack A01'), rack('r2', 'Rack A02'), rack('r3', 'Rack A03')] },
          { id: 'row2', name: 'Row B', racks: [rack('r4', 'Rack B01', 'rack-48'), rack('r5', 'Rack B02', 'rack-48'), rack('r6', 'Rack B03', 'rack-48')] },
        ],
      },
      {
        id: 'f2',
        name: 'First floor',
        rowPitchM: 2.4,
        rows: [{ id: 'row3', name: 'Row A', racks: [rack('r7', 'Rack 2A01', 'rack-42'), rack('r8', 'Rack 2A02', 'rack-42')] }],
      },
    ];
    p.views[0].clusters = [
      { id: 'c-net', name: 'Core network', color: '#e69f00' },
      { id: 'c-kestrel', name: 'Kestrel HPC', color: '#2f6fdb' },
      { id: 'c-osprey', name: 'Osprey GPU', color: '#d55e00' },
      { id: 'c-ceph', name: 'Ceph object store', color: '#008568' },
      { id: 'c-lustre', name: 'Lustre scratch', color: '#9e2a6e' },
      { id: 'c-heron', name: 'Heron AI', color: '#ecd94a' },
      { id: 'c-archive', name: 'Archive', color: '#7fc6f0' },
    ];
    let n = 0;
    const add = (type, name, cluster, rackId, kind, at, extra) =>
      p.devices.push(newDevice(Object.assign({ id: `ex-${++n}`, type, name, groups: cluster ? { v1: cluster } : {}, loc: { rack: rackId, kind, at } }, extra)));
    // Switches are mounted back to front, so their ports face the servers' rear.
    const sw = { reversed: true };

    // Row A: every rack gets a management switch and a high-speed leaf on top.
    ['r1', 'r2', 'r3'].forEach((r, i) => {
      add('switch-rj45', `sw-mgmt-a0${i + 1}`, 'c-net', r, 'u', 1, sw);
      add('switch-qsfp', `ib-leaf-a0${i + 1}`, 'c-net', r, 'u', 2, sw);
    });
    add('switch-rj45', 'sw-bmc-a01', 'c-net', 'r1', 'side', 0, sw);
    add('switch-rj45', 'sw-bmc-a03', 'c-net', 'r3', 'side', 0, sw);
    for (let i = 0; i < 12; i++) add('compute-node', `cn-${String(i + 1).padStart(3, '0')}`, 'c-kestrel', 'r1', 'u', 4 + i * 2);
    for (let i = 0; i < 8; i++) add('compute-node', `gpu-${String(i + 1).padStart(3, '0')}`, 'c-osprey', 'r2', 'u', 4 + i * 2);
    for (let i = 0; i < 3; i++) add('storage-node', `ceph-0${i + 1}`, 'c-ceph', 'r2', 'u', 24 + i * 4);
    add('storage-node', 'oss-01', 'c-lustre', 'r3', 'u', 4);
    add('storage-node', 'oss-02', 'c-lustre', 'r3', 'u', 8);
    for (let i = 0; i < 4; i++) add('storage-enclosure', `jbod-0${i + 1}`, 'c-lustre', 'r3', 'u', 12 + i * 4);

    // Row B: core network, then GPU servers with room kept for the next batch.
    add('patch-panel', 'pp-b01-1', null, 'r4', 'u', 1);
    add('patch-panel', 'pp-b01-2', null, 'r4', 'u', 2);
    add('switch-qsfp', 'core-sw-01', 'c-net', 'r4', 'u', 4, sw);
    add('switch-qsfp', 'core-sw-02', 'c-net', 'r4', 'u', 5, sw);
    add('switch-rj45', 'sw-mgmt-b01', 'c-net', 'r4', 'u', 6, sw);
    add('reserved', 'Core expansion', null, 'r4', 'u', 8, { height: 6, notes: 'Second spine pair, next budget year' });
    for (const r of ['r4', 'r5', 'r6']) {
      const k = r.slice(1) - 3;
      // A vertical PDU on each grid, at the rear of every rack.
      add('pdu-3p-30', `pdu-b0${k}-a`, null, r, 'pdu', 0, { grid: 'pg-a' });
      add('pdu-3p-30', `pdu-b0${k}-b`, null, r, 'pdu', 1, { grid: 'pg-b' });
    }
    add('switch-osfp', 'ib-leaf-b02', 'c-heron', 'r5', 'u', 1, sw);
    add('switch-osfp', 'ib-leaf-b03', 'c-heron', 'r6', 'u', 1, sw);
    for (let i = 0; i < 3; i++) add('gpu-server', `gpu-srv-0${i + 1}`, 'c-heron', 'r5', 'u', 3 + i * 4);
    for (let i = 0; i < 3; i++) add('gpu-server', `gpu-srv-0${i + 4}`, 'c-heron', 'r6', 'u', 3 + i * 4);
    add('reserved', 'GPU batch 2', 'c-heron', 'r6', 'u', 16, { height: 8, powerW: 6000, notes: 'Two more GPU servers, power already booked' });

    // First floor: an archive on smaller racks.
    add('switch-rj45', 'sw-arc-01', 'c-archive', 'r7', 'u', 1, sw);
    add('storage-node', 'arc-01', 'c-archive', 'r7', 'u', 3);
    add('storage-node', 'arc-02', 'c-archive', 'r8', 'u', 3);
    for (let i = 0; i < 4; i++) add('storage-enclosure', `arc-jbod-0${i + 1}`, 'c-archive', i < 2 ? 'r7' : 'r8', 'u', 7 + (i % 2) * 4);

    addExampleCabling(p);
    addExamplePower(p);
    return p;
  }

  /**
   * The example's power cords, in Row B: every power supply of a device
   * goes to the PDU of one grid, half of them to each. Two devices are
   * left the way a first pass often leaves them, for the checks to show:
   * core-sw-02 has both supplies on Grid A, and sw-mgmt-b01 has one cord.
   */
  function addExamplePower(p) {
    const byName = new Map(p.devices.map((d) => [d.name, d.id]));
    const cord = (name, inlet, pdu, outlet) =>
      p.powerCords.push({
        id: `pc-${p.powerCords.length + 1}`,
        label: formatSerial(parseSerial(CORD_LABEL), p.powerCords.length + 1),
        type: null,
        lengthM: null,
        color: null,
        notes: '',
        inlet: { device: byName.get(name), inlet },
        outlet: { device: byName.get(pdu), outlet: String(outlet) },
      });
    const both = (name, rack, outlet) => {
      cord(name, 'psu1', `pdu-${rack}-a`, outlet);
      cord(name, 'psu2', `pdu-${rack}-b`, outlet);
    };
    // Rack B01: the core switches.
    both('core-sw-01', 'b01', 1);
    cord('core-sw-02', 'psu1', 'pdu-b01-a', 2);
    cord('core-sw-02', 'psu2', 'pdu-b01-a', 6);
    cord('sw-mgmt-b01', 'psu1', 'pdu-b01-a', 11);
    // Racks B02 and B03: a leaf switch, and GPU servers with four supplies on the C19 outlets, one fuse group each.
    [
      ['b02', 'ib-leaf-b02', 1],
      ['b03', 'ib-leaf-b03', 4],
    ].forEach(([rack, leaf, first]) => {
      both(leaf, rack, 1);
      for (let i = 0; i < 3; i++) {
        const srv = `gpu-srv-0${first + i}`;
        both(srv, rack, 5 + 5 * i);
        cord(srv, 'psu3', `pdu-${rack}-a`, 20 + 5 * i);
        cord(srv, 'psu4', `pdu-${rack}-b`, 20 + 5 * i);
      }
    });
  }

  /** The example's networks and cables, numbered per network in the order they are made. */
  function addExampleCabling(p) {
    p.networks = [
      { id: 'n-mgmt', name: 'Management', color: '#3aa655', firstLabel: 'MGT-0001' },
      { id: 'n-bmc', name: 'BMC', color: '#d9a21b', firstLabel: 'BMC-0001' },
      { id: 'n-ib', name: 'InfiniBand', color: '#2f6fdb', firstLabel: 'IB-0001' },
      { id: 'n-stor', name: 'Storage 25G', color: '#1f9fc9', firstLabel: 'ST-0001' },
      { id: 'n-sas', name: 'SAS', color: '#8a5cd6', firstLabel: 'SAS-0001' },
    ];
    const byName = new Map(p.devices.map((d) => [d.name, d.id]));
    const counts = new Map();
    const end = ([name, port]) => ({ device: byName.get(name), port });
    const link = (network, a, b, extra) => {
      const net = p.networks.find((x) => x.id === network);
      const k = (counts.get(network) || 0) + 1;
      counts.set(network, k);
      p.cables.push(
        Object.assign(
          { id: `cb-${p.cables.length + 1}`, type: null, network, label: formatSerial(parseSerial(net.firstLabel), k), lengthM: null, notes: '', a: end(a), b: Array.isArray(b[0]) ? b.map(end) : end(b) },
          extra
        )
      );
    };
    const n3 = (i) => String(i).padStart(3, '0');

    // Rack A01: Kestrel compute nodes.
    for (let i = 1; i <= 12; i++) {
      link('n-mgmt', [`cn-${n3(i)}`, 'eth0'], ['sw-mgmt-a01', `swp${i}`]);
      link('n-bmc', [`cn-${n3(i)}`, 'bmc'], ['sw-bmc-a01', `swp${i}`]);
      link('n-ib', [`cn-${n3(i)}`, 'ib0'], ['ib-leaf-a01', `p${i}`]);
    }
    // Rack A02: Osprey GPU nodes and Ceph.
    for (let i = 1; i <= 8; i++) {
      link('n-mgmt', [`gpu-${n3(i)}`, 'eth0'], ['sw-mgmt-a02', `swp${i}`]);
      link('n-bmc', [`gpu-${n3(i)}`, 'bmc'], ['sw-bmc-a01', `swp${12 + i}`]);
      link('n-ib', [`gpu-${n3(i)}`, 'ib0'], ['ib-leaf-a02', `p${i}`]);
    }
    for (let i = 1; i <= 3; i++) {
      const ceph = `ceph-0${i}`;
      link('n-mgmt', [ceph, 'eth0'], ['sw-mgmt-a02', `swp${8 + i}`]);
      link('n-stor', [ceph, 'eth1'], ['sw-mgmt-a02', `swp${48 + i}`]);
      link('n-bmc', [ceph, 'bmc'], ['sw-bmc-a03', `swp${i}`]);
      link('n-ib', [ceph, 'ib0'], ['ib-leaf-a02', `p${8 + i}`]);
      // The last one was ordered as a DAC, which does not reach the next rack.
      link('n-ib', [ceph, 'ib1'], ['ib-leaf-a03', `p${8 + i}`], i === 3 ? { type: 'dac-qsfp56' } : null);
    }
    // Rack A03: Lustre servers, each attached to every enclosure.
    for (let i = 1; i <= 2; i++) {
      const oss = `oss-0${i}`;
      link('n-mgmt', [oss, 'eth0'], ['sw-mgmt-a03', `swp${i}`]);
      link('n-bmc', [oss, 'bmc'], ['sw-bmc-a03', `swp${3 + i}`]);
      link('n-ib', [oss, 'ib0'], ['ib-leaf-a03', `p${2 * i - 1}`]);
      link('n-ib', [oss, 'ib1'], ['ib-leaf-a03', `p${2 * i}`]);
      for (let j = 1; j <= 4; j++) link('n-sas', [oss, `sas${j - 1}`], [`jbod-0${j}`, i === 1 ? 'sas-a' : 'sas-b']);
    }
    for (let j = 1; j <= 4; j++) link('n-mgmt', [`jbod-0${j}`, 'mgmt'], ['sw-mgmt-a03', `swp${2 + j}`]);
    // Row A uplinks: BMC switches into management, management over fiber to Row B, leaves to the core.
    link('n-bmc', ['sw-bmc-a01', 'swp48'], ['sw-mgmt-a01', 'swp48']);
    link('n-bmc', ['sw-bmc-a03', 'swp48'], ['sw-mgmt-a03', 'swp48']);
    for (let k = 1; k <= 3; k++) {
      link('n-mgmt', [`sw-mgmt-a0${k}`, 'swp52'], ['sw-mgmt-b01', `swp${48 + k}`], { type: 'lc-om4' });
      const leaf = `ib-leaf-a0${k}`;
      link('n-ib', [leaf, 'p21'], ['core-sw-01', `p${2 * k - 1}`], { type: 'mpo-om4' });
      link('n-ib', [leaf, 'p22'], ['core-sw-01', `p${2 * k}`], { type: 'mpo-om4' });
      link('n-ib', [leaf, 'p23'], ['core-sw-02', `p${2 * k - 1}`], { type: 'mpo-om4' });
      link('n-ib', [leaf, 'p24'], ['core-sw-02', `p${2 * k}`], { type: 'mpo-om4' });
    }
    // Row B: Heron GPU servers on breakout cables, two GPU ports per leaf port.
    for (let i = 1; i <= 6; i++) {
      const gpu = `gpu-srv-0${i}`;
      const leaf = i <= 3 ? 'ib-leaf-b02' : 'ib-leaf-b03';
      const j = (i - 1) % 3;
      link('n-ib', [leaf, `p${2 * j + 1}`], [[gpu, 'ib0'], [gpu, 'ib1']], { type: 'dac-osfp-2x' });
      link('n-ib', [leaf, `p${2 * j + 2}`], [[gpu, 'ib2'], [gpu, 'ib3']], { type: 'dac-osfp-2x' });
      link('n-mgmt', [gpu, 'eth0'], ['sw-mgmt-b01', `swp${i}`]);
      link('n-bmc', [gpu, 'bmc'], ['sw-mgmt-b01', `swp${12 + i}`]);
    }
    // Leaf uplinks split over both core switches; Rack B03 is too far for a DAC.
    for (const [leaf, type, first] of [['ib-leaf-b02', 'dac-osfp-2x', 7], ['ib-leaf-b03', 'aoc-osfp-2x', 9]]) {
      link('n-ib', [leaf, 'p31'], [['core-sw-01', `p${first}`], ['core-sw-02', `p${first}`]], { type });
      link('n-ib', [leaf, 'p32'], [['core-sw-01', `p${first + 1}`], ['core-sw-02', `p${first + 1}`]], { type });
    }
    // First floor: the archive, with its management uplink down a riser.
    link('n-mgmt', ['arc-01', 'eth0'], ['sw-arc-01', 'swp1']);
    link('n-mgmt', ['arc-02', 'eth0'], ['sw-arc-01', 'swp2']);
    for (const [arc, jbods] of [['arc-01', ['arc-jbod-01', 'arc-jbod-02']], ['arc-02', ['arc-jbod-03', 'arc-jbod-04']]]) {
      jbods.forEach((jbod, k) => link('n-sas', [arc, `sas${k}`], [jbod, 'sas-a']));
    }
    link('n-mgmt', ['sw-arc-01', 'swp52'], ['sw-mgmt-b01', 'swp52'], { type: 'lc-om4', lengthM: 30, notes: 'Riser to the ground floor' });
  }

  /** True when the plan still equals the example (the notice flag aside). */
  function isPristineExample(project) {
    const ex = createExampleProject();
    const pick = (p) =>
      JSON.stringify([p.name, p.info, p.deviceTypes, p.rackTypes, p.cableTypes, p.transceivers, p.cordTypes, p.floors, p.views, p.networks, p.powerGrids, p.powerSettings, p.devices, p.cables, p.powerCords]);
    return pick(project) === pick(ex);
  }

  // -------------------------------------------------------------- placement

  function formatSpan(top, bottom) {
    return top === bottom ? `U${top}` : `U${top}–${bottom}`;
  }

  /** Units of a rack occupied by devices not in `ignore` (index = unit number). */
  function rackGrid(project, rackId, ignore) {
    const skip = ignore instanceof Set ? ignore : new Set([].concat(ignore || []));
    const units = rackUnits(project, rackId);
    const grid = new Uint8Array(units + 2);
    for (const d of project.devices) {
      if (d.loc.rack !== rackId || d.loc.kind !== 'u' || skip.has(d.id)) continue;
      const [b, t] = deviceSpan(project, d);
      for (let u = Math.max(1, b); u <= Math.min(units, t); u++) grid[u] = 1;
    }
    return grid;
  }

  /** True when units `at` … `at + h - 1` are inside the rack of `grid` (from rackGrid) and free. */
  function spanFree(grid, at, h) {
    if (at < 1 || at + h - 1 > grid.length - 2) return false;
    for (let u = at; u < at + h; u++) if (grid[u]) return false;
    return true;
  }

  /**
   * Checks whether a device of `typeId` fits at `loc`. Devices listed in
   * `ignore` (an id or array of ids) are treated as absent, which is how a
   * device is checked against its own new position when moving. `height`
   * applies to reserved space only.
   */
  function canPlace(project, typeId, loc, ignore, height) {
    const skip = new Set([].concat(ignore || []));
    const type = typeOf(project, typeId);
    if (!type) return { ok: false, reason: 'Unknown device type' };
    const rack = loc ? rackById(project, loc.rack) : null;
    if (!rack) return { ok: false, reason: 'Drop it on a rack' };
    const h = heightOf(project, typeId, height);

    if (loc.kind === 'pdu') {
      if (!isPduType(type)) return { ok: false, reason: 'PDU slots take vertical PDUs only' };
      const slots = rackPduSlots(project, rack).length;
      if (!slots) return { ok: false, reason: `${rack.name} has no PDU slots` };
      if (!Number.isInteger(loc.at) || loc.at < 0 || loc.at >= slots) return { ok: false, reason: 'There is no such PDU slot' };
      const other = project.devices.find((d) => !skip.has(d.id) && d.loc.rack === loc.rack && d.loc.kind === 'pdu' && d.loc.at === loc.at);
      if (other) return { ok: false, reason: `PDU slot P${loc.at + 1} holds ${other.name}`, conflict: other.id };
      return { ok: true };
    }
    if (isPduType(type)) return { ok: false, reason: 'A vertical PDU goes in a PDU slot' };

    if (loc.kind === 'side') {
      const slots = rackSideSlots(project, rack);
      if (!slots) return { ok: false, reason: `${rack.name} has no side slots` };
      if (!Number.isInteger(loc.at) || loc.at < 0 || loc.at >= slots) return { ok: false, reason: 'There is no such side slot' };
      if (h !== 1) return { ok: false, reason: 'Side slots take 1U devices only' };
      const other = project.devices.find((d) => !skip.has(d.id) && d.loc.rack === loc.rack && d.loc.kind === 'side' && d.loc.at === loc.at);
      if (other) return { ok: false, reason: `Side slot V${loc.at + 1} holds ${other.name}`, conflict: other.id };
      return { ok: true };
    }

    if (loc.kind !== 'u') return { ok: false, reason: 'Unknown mounting position' };
    const units = rackUnits(project, rack);
    const top = loc.at;
    const bottom = loc.at + h - 1;
    if (!Number.isInteger(top) || top < 1 || bottom > units) {
      return { ok: false, reason: `A ${h}U device must sit within U1–${units}` };
    }
    for (const d of project.devices) {
      if (skip.has(d.id) || d.loc.rack !== loc.rack || d.loc.kind !== 'u') continue;
      const [b, t] = deviceSpan(project, d);
      if (b <= bottom && top <= t) return { ok: false, reason: `Overlaps ${d.name} at ${formatSpan(b, t)}`, conflict: d.id };
    }
    return { ok: true };
  }

  /**
   * Finds up to `count` free positions (lowest unit number of each device)
   * for devices of `typeId` in a rack, starting at `startU` and stacking
   * toward higher unit numbers (dir > 0, downward in the rack) or lower ones
   * (dir < 0, upward). Occupied units are skipped.
   */
  function planPositions(project, typeId, rackId, startU, count, dir, ignore, height) {
    if (!typeOf(project, typeId) || !rackById(project, rackId)) return [];
    const h = heightOf(project, typeId, height);
    const grid = rackGrid(project, rackId, ignore);
    const units = grid.length - 2;
    const step = dir < 0 ? -1 : 1;
    const out = [];
    let u = startU;
    while (out.length < count && u >= 1 && u + h - 1 <= units) {
      if (spanFree(grid, u, h)) {
        out.push(u);
        for (let k = u; k < u + h; k++) grid[k] = 1;
        u += step * h;
      } else {
        u += step;
      }
    }
    return out;
  }

  /**
   * Plans `count` devices spread evenly over `rackIds`, each rack stacked
   * from `startU` as in planPositions. When a rack runs out of space the
   * others take the rest. Returns [{ rack, at }] rack by rack; fewer than
   * `count` when the racks are full.
   */
  function planSpread(project, typeId, rackIdsList, startU, count, dir, height) {
    const racks = rackIdsList.filter((id) => rackById(project, id));
    if (!racks.length || !typeOf(project, typeId)) return [];
    const h = heightOf(project, typeId, height);
    const avail = racks.map((id) => {
      const units = rackUnits(project, id);
      const start = Math.max(1, Math.min(units - h + 1, startU));
      return planPositions(project, typeId, id, start, count, dir, null, height);
    });
    return spreadOver(racks, avail, count);
  }

  /**
   * Plans `count` devices of `typeId` in the free side slots of `rackIds`,
   * spread evenly over them as in planSpread: in the first rack from slot
   * `start` on and then the slots before it, in the others from the top.
   * Returns [{ rack, at }] rack by rack; fewer than `count` when the side
   * slots are full. With `kind` 'pdu', the same for PDU slots.
   */
  function planSideSlots(project, typeId, rackIdsList, start, count, kind) {
    const racks = rackIdsList.filter((id) => rackById(project, id));
    if (!racks.length || !typeOf(project, typeId)) return [];
    const avail = racks.map((id, i) => {
      const free = validLocs(project, typeId, id).filter((l) => l.kind === (kind || 'side')).map((l) => l.at);
      return i ? free : free.filter((at) => at >= start).concat(free.filter((at) => at < start));
    });
    return spreadOver(racks, avail, count);
  }

  /** Takes `count` of the positions `avail[i]` of racks `racks[i]`, as evenly as they allow: [{ rack, at }]. */
  function spreadOver(racks, avail, count) {
    const k = racks.length;
    const take = racks.map((_, i) => Math.min(avail[i].length, Math.floor(count / k) + (i < count % k ? 1 : 0)));
    let rest = count - take.reduce((a, b) => a + b, 0);
    while (rest > 0) {
      let progressed = false;
      for (let i = 0; i < k && rest > 0; i++) {
        if (take[i] < avail[i].length) {
          take[i]++;
          rest--;
          progressed = true;
        }
      }
      if (!progressed) break;
    }
    const out = [];
    racks.forEach((rack, i) => avail[i].slice(0, take[i]).forEach((at) => out.push({ rack, at })));
    return out;
  }

  /** All positions in a rack where a device of `typeId` fits, side slots first, then top to bottom. */
  function validLocs(project, typeId, rackId, ignore, height) {
    const type = typeOf(project, typeId);
    const out = [];
    if (!type || !rackById(project, rackId)) return out;
    if (isPduType(type)) {
      rackPduSlots(project, rackId).forEach((side, s) => {
        const loc = { rack: rackId, kind: 'pdu', at: s };
        if (canPlace(project, typeId, loc, ignore).ok) out.push(loc);
      });
      return out;
    }
    const h = heightOf(project, typeId, height);
    if (h === 1) {
      for (let s = 0; s < rackSideSlots(project, rackId); s++) {
        const loc = { rack: rackId, kind: 'side', at: s };
        if (canPlace(project, typeId, loc, ignore, height).ok) out.push(loc);
      }
    }
    const grid = rackGrid(project, rackId, ignore);
    for (let u = 1; u + h - 1 <= grid.length - 2; u++) {
      if (spanFree(grid, u, h)) out.push({ rack: rackId, kind: 'u', at: u });
    }
    return out;
  }

  /** Nearest free U position with a higher (dir > 0, further down) or lower (dir < 0, further up) number. */
  function nudgeTarget(project, device, dir) {
    const moves = groupNudge(project, [device.id], dir);
    return moves ? moves[0].loc : null;
  }

  /** Free position closest to `near` (a U number) in a rack, or null. */
  function nearestLoc(project, typeId, rackId, near, ignore, preferSide, height) {
    const locs = validLocs(project, typeId, rackId, ignore, height);
    if (!locs.length) return null;
    if (preferSide) {
      const side = locs.find((l) => l.kind === 'side');
      if (side) return side;
    }
    const inRack = locs.filter((l) => l.kind === 'u');
    if (!inRack.length) return locs[0];
    return inRack.reduce((best, l) => (Math.abs(l.at - near) < Math.abs(best.at - near) ? l : best));
  }

  /**
   * The first free position for a device of `typeId` in `rackIds`, rack by
   * rack, from the top unit down; a side slot only when no rack has units
   * free. With `preferSide`, the first free side slot, and units only when
   * no rack has a side slot free. Null when nothing fits.
   */
  function firstFreeLoc(project, typeId, rackIds, height, preferSide) {
    let other = null;
    for (const id of rackIds) {
      const locs = validLocs(project, typeId, id, null, height);
      const first = locs.find((l) => (l.kind === 'side') === !!preferSide);
      if (first) return first;
      if (!other && locs.length) other = locs[0];
    }
    return other;
  }

  /**
   * Whether devices of `typeId` belong in side slots rather than in rack
   * units: a 1U type with more of its devices in side slots than in units,
   * or, as many as in each, a PDU.
   */
  function prefersSideSlot(project, typeId) {
    const type = typeOf(project, typeId);
    if (!type || type.variable || type.height !== 1) return false;
    let side = 0;
    let units = 0;
    for (const d of project.devices) {
      if (d.type !== typeId) continue;
      if (d.loc.kind === 'side') side++;
      else units++;
    }
    return side !== units ? side > units : type.face === 'pdu';
  }

  /**
   * Checks moving several devices at once, each to its own `loc`. Every
   * device is checked against the devices that stay and against the other
   * moved ones in their new places.
   */
  function canMoveAll(project, moves) {
    const ids = new Set(moves.map((m) => m.id));
    const scratch = Object.assign({}, project, { devices: project.devices.filter((d) => !ids.has(d.id)) });
    for (const m of moves) {
      const d = deviceById(project, m.id);
      if (!d) return { ok: false, reason: 'Unknown device' };
      const r = canPlace(scratch, d.type, m.loc, null, d.height);
      if (!r.ok) return Object.assign({ device: d.id }, r, { reason: `${d.name}: ${r.reason}` });
      scratch.devices.push(Object.assign({}, d, { loc: m.loc }));
    }
    return { ok: true };
  }

  /**
   * Checks adding new devices ([{ type, height, loc }]) at once: each against
   * the plan and against the ones before it.
   */
  function canAddAll(project, items) {
    const scratch = Object.assign({}, project, { devices: project.devices.slice() });
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const r = canPlace(scratch, it.type, it.loc, null, it.height);
      if (!r.ok) return Object.assign({}, r, { reason: `${it.name || 'A copy'}: ${r.reason}` });
      scratch.devices.push({ id: `__add-${i}`, type: it.type, height: it.height, name: it.name || '', loc: it.loc });
    }
    return { ok: true };
  }

  /**
   * Moves for shifting devices by `dRack` racks within their rows and `dU`
   * units (side-slot devices only change racks). Null when a device would
   * leave its row.
   */
  function shiftMoves(project, ids, dRack, dU) {
    const moves = [];
    for (const id of ids) {
      const d = deviceById(project, id);
      if (!d) continue;
      const pos = locateRack(project, d.loc.rack);
      const target = pos && pos.row.racks[pos.index + dRack];
      if (!target) return null;
      moves.push({ id, loc: { rack: target.id, kind: d.loc.kind, at: d.loc.kind === 'u' ? d.loc.at + dU : d.loc.at } });
    }
    return moves;
  }

  /**
   * Smallest shift of the selected rack-unit devices up (dir < 0) or down
   * (dir > 0) at which all of them fit, as moves; null if there is none.
   */
  function groupNudge(project, ids, dir) {
    const set = new Set(ids);
    const moving = project.devices.filter((d) => set.has(d.id) && d.loc.kind === 'u');
    if (!moving.length) return null;
    const grids = new Map();
    for (const d of moving) if (!grids.has(d.loc.rack)) grids.set(d.loc.rack, rackGrid(project, d.loc.rack, set));
    for (let k = 1; k <= LIMITS.unitsMax; k++) {
      let fits = true;
      for (const d of moving) {
        const h = deviceHeight(project, d);
        const g = grids.get(d.loc.rack);
        const at = d.loc.at + k * dir;
        // Further shifts only take it further out of its rack.
        if (at < 1 || at + h - 1 > g.length - 2) return null;
        if (!spanFree(g, at, h)) {
          fits = false;
          break;
        }
      }
      if (fits) return moving.map((d) => ({ id: d.id, loc: { rack: d.loc.rack, kind: 'u', at: d.loc.at + k * dir } }));
    }
    return null;
  }

  /**
   * Where copies of the devices in `ids` fit as a block, keeping their
   * spacing: below them in their racks, else above, else in the nearest
   * racks of their rows (same height first). Side-slot devices take the same
   * slot or another free one in their target rack. Returns [{ id, loc }]
   * with `id` the original's, or null when there is no room.
   */
  function copyTargets(project, ids) {
    const set = new Set(ids);
    const devs = sortedDevices(project).filter((d) => set.has(d.id));
    if (!devs.length) return null;
    const grids = new Map();
    const grid = (rackId) => {
      if (!grids.has(rackId)) grids.set(rackId, rackGrid(project, rackId));
      return grids.get(rackId);
    };
    const taken = (rackId, kind) => new Set(project.devices.filter((d) => d.loc.rack === rackId && d.loc.kind === kind).map((d) => d.loc.at));
    const sideTaken = (rackId) => taken(rackId, 'side');
    const attempt = (dRack, dU) => {
      const claimed = new Map();
      const out = [];
      for (const d of devs) {
        const pos = locateRack(project, d.loc.rack);
        const target = pos && pos.row.racks[pos.index + dRack];
        if (!target) return null;
        let mine = claimed.get(target.id);
        if (!mine) claimed.set(target.id, (mine = { units: new Set(), side: sideTaken(target.id), pdu: taken(target.id, 'pdu') }));
        if (d.loc.kind === 'pdu') {
          // The same PDU slot, or another free one of the target rack.
          const slots = rackPduSlots(project, target).length;
          const order = [d.loc.at].concat(Array.from({ length: slots }, (_, i) => i));
          const at = order.find((s) => s < slots && !mine.pdu.has(s));
          if (at === undefined) return null;
          mine.pdu.add(at);
          out.push({ id: d.id, loc: { rack: target.id, kind: 'pdu', at } });
          continue;
        }
        if (d.loc.kind === 'side') {
          if (deviceHeight(project, d) !== 1) return null;
          const slots = rackSideSlots(project, target);
          const order = [d.loc.at].concat(Array.from({ length: slots }, (_, i) => i));
          const at = order.find((s) => s < slots && !mine.side.has(s));
          if (at === undefined) return null;
          mine.side.add(at);
          out.push({ id: d.id, loc: { rack: target.id, kind: 'side', at } });
          continue;
        }
        const h = deviceHeight(project, d);
        const at = d.loc.at + dU;
        if (!spanFree(grid(target.id), at, h)) return null;
        for (let u = at; u < at + h; u++) if (mine.units.has(u)) return null;
        for (let u = at; u < at + h; u++) mine.units.add(u);
        out.push({ id: d.id, loc: { rack: target.id, kind: 'u', at } });
      }
      return out;
    };
    const tryShifts = (dRack) => {
      if (dRack !== 0) {
        const same = attempt(dRack, 0);
        if (same) return same;
      }
      for (let k = 1; k <= LIMITS.unitsMax; k++) {
        const down = attempt(dRack, k);
        if (down) return down;
      }
      for (let k = 1; k <= LIMITS.unitsMax; k++) {
        const up = attempt(dRack, -k);
        if (up) return up;
      }
      return null;
    };
    const found = tryShifts(0);
    if (found) return found;
    for (let n = 1; n < LIMITS.racks; n++) {
      for (const dRack of [n, -n]) {
        const r = tryShifts(dRack);
        if (r) return r;
      }
    }
    return null;
  }

  /**
   * Copies of devices for new places (`moves`: [{ id, loc }]), with new ids
   * and names that continue each series, and without the serial number,
   * asset tag and IP address of the original. The plan itself is not
   * changed.
   */
  function copiesAt(project, moves) {
    const named = { devices: project.devices.slice() };
    return moves.map((m) => {
      const d = deviceById(project, m.id);
      // A name with the code of its rack takes the code of the copy's (see nameInRack).
      const name = rackCodeIn(project, d.name, d.loc.rack) ? nameInRack(Object.assign({}, project, named), d.name, d.loc.rack, m.loc.rack, 1) : nextFreeName(named, d.name);
      const c = Object.assign(clone(d), { id: uid('d'), name, loc: { rack: m.loc.rack, kind: m.loc.kind, at: m.loc.at } });
      for (const f of FIELDS) if (f.instance) c[f.key] = '';
      named.devices.push(c);
      return c;
    });
  }

  /**
   * Adds copies of the devices in racks that `rackMap` maps (old rack id →
   * new rack id), at the same positions, with the cables between them.
   */
  function copyDevicesInto(project, rackMap) {
    const moves = sortedDevices(project)
      .filter((d) => rackMap.has(d.loc.rack))
      .map((d) => ({ id: d.id, loc: Object.assign({}, d.loc, { rack: rackMap.get(d.loc.rack) }) }));
    const copies = copiesAt(project, moves);
    project.devices.push(...copies);
    const idMap = new Map(moves.map((m, i) => [m.id, copies[i].id]));
    copyCables(project, idMap);
    copyCords(project, idMap);
  }

  /** Inserts a copy of a rack, with copies of its devices, right after it. Null when the row is full. */
  function duplicateRack(project, rackId) {
    const pos = locateRack(project, rackId);
    const rack = pos && addRack(project, pos.row.id, { index: pos.index + 1, type: pos.rack.type, empty: true });
    if (rack) {
      Object.assign(rack, { trayM: orNull(pos.rack.trayM), slackM: orNull(pos.rack.slackM) });
      copyDevicesInto(project, new Map([[rackId, rack.id]]));
    }
    return rack || null;
  }

  /**
   * Inserts a copy of row `source` (its racks, not their devices) into
   * `floor` at `index`, named `name` or the next free row name. Adds the
   * old → new rack ids to `rackMap`.
   */
  function copyRowInto(project, source, floor, index, name, rackMap) {
    const row = insertRow(project, floor, name, index);
    source.racks.forEach((r, i) => {
      const rack = { id: uid('r'), name: defaultRackName(project, row.id, i), type: r.type, trayM: orNull(r.trayM), slackM: orNull(r.slackM) };
      row.racks.push(rack);
      rackMap.set(r.id, rack.id);
    });
    return row;
  }

  /** Inserts a copy of a row, with its racks and devices, right after it. Null when the floor is full. */
  function duplicateRow(project, rowId) {
    const pos = locateRow(project, rowId);
    if (!pos || pos.floor.rows.length >= LIMITS.rows) return null;
    const map = new Map();
    const row = copyRowInto(project, pos.row, pos.floor, pos.rowIndex + 1, '', map);
    copyDevicesInto(project, map);
    return row;
  }

  /** Inserts a copy of a floor, with everything on it, right after it. Null when the plan has six floors. */
  function duplicateFloor(project, floorId) {
    const i = project.floors.findIndex((f) => f.id === floorId);
    if (i < 0) return null;
    const source = project.floors[i];
    const floor = insertFloor(project, copyName(project.floors, source.name), i + 1);
    if (!floor) return null;
    if (source.rowPitchM) floor.rowPitchM = source.rowPitchM;
    // Rows keep their names on the copied floor, and racks are named after them.
    const map = new Map();
    source.rows.forEach((r) => copyRowInto(project, r, floor, null, r.name, map));
    copyDevicesInto(project, map);
    return floor;
  }

  /**
   * Finds devices that don't fit their rack: outside its units or side
   * slots, or overlapping. Limited to `rackIdSet` when given. Returns a
   * message for the first problem, or null.
   */
  function layoutProblem(project, rackIdSet) {
    const grids = new Map();
    for (const d of project.devices) {
      if (rackIdSet && !rackIdSet.has(d.loc.rack)) continue;
      const rack = rackById(project, d.loc.rack);
      if (!rack) return `${d.name} is in an unknown rack`;
      let g = grids.get(rack.id);
      if (!g) {
        g = { units: new Array(rackUnits(project, rack) + 1).fill(null), side: new Array(rackSideSlots(project, rack)).fill(null), pdu: new Array(rackPduSlots(project, rack).length).fill(null) };
        grids.set(rack.id, g);
      }
      const h = deviceHeight(project, d);
      if (d.loc.kind === 'pdu') {
        if (d.loc.at >= g.pdu.length) return `${d.name} would lose its PDU slot in ${rack.name}`;
        if (g.pdu[d.loc.at]) return `${d.name} and ${g.pdu[d.loc.at]} share a PDU slot in ${rack.name}`;
        g.pdu[d.loc.at] = d.name;
        continue;
      }
      if (d.loc.kind === 'side') {
        if (d.loc.at >= g.side.length) return `${d.name} would lose its side slot in ${rack.name}`;
        if (h !== 1) return `${d.name} is too tall for a side slot`;
        if (g.side[d.loc.at]) return `${d.name} and ${g.side[d.loc.at]} share a side slot in ${rack.name}`;
        g.side[d.loc.at] = d.name;
        continue;
      }
      const top = d.loc.at;
      const bottom = top + h - 1;
      if (bottom >= g.units.length) return `${d.name} would stick out below U${g.units.length - 1} of ${rack.name}`;
      for (let u = top; u <= bottom; u++) {
        if (g.units[u]) return `${d.name} would overlap ${g.units[u]} in ${rack.name}`;
        g.units[u] = d.name;
      }
    }
    return null;
  }

  function formatPosition(project, loc, typeId, height) {
    if (loc.kind === 'side') return `V${loc.at + 1}`;
    if (loc.kind === 'pdu') return `P${loc.at + 1}`;
    return formatSpan(loc.at, loc.at + heightOf(project, typeId, height) - 1);
  }
  function formatLoc(project, loc, typeId, height) {
    const rack = rackById(project, loc.rack);
    const rackName = rack ? rack.name : 'Unknown rack';
    if (loc.kind === 'side') return `${rackName} · side slot V${loc.at + 1}`;
    if (loc.kind === 'pdu') return `${rackName} · PDU slot P${loc.at + 1}`;
    return `${rackName} · ${formatPosition(project, loc, typeId, height)}`;
  }
  /** A PDU slot of a rack as lists show it: "P1 · left" (the side seen from the front). */
  function formatPduSlot(project, rack, at) {
    const side = rackPduSlots(project, rack)[at];
    return side ? `P${at + 1} · ${side}` : `P${at + 1}`;
  }
  function formatDeviceLoc(project, d) {
    return formatLoc(project, d.loc, d.type, d.height);
  }
  /** "Ground floor · Row A" for a row, rack or device location. */
  function formatWhere(project, rackOrRowId) {
    const rack = locateRack(project, rackOrRowId);
    if (rack) return `${rack.floor.name} · ${rack.row.name}`;
    const row = locateRow(project, rackOrRowId);
    return row ? `${row.floor.name} · ${row.row.name}` : '';
  }

  // ------------------------------------------------------------------ names

  function parseSerial(name) {
    const m = /^(.*?)(\d+)(\D*)$/.exec(name);
    return m ? { head: m[1], num: parseInt(m[2], 10), width: m[2].length, tail: m[3] } : null;
  }

  /**
   * `head` and then `tail` within the length of a name: a long head is cut
   * before the dashes or dots it ends in, so that they and the number in
   * `tail` stay.
   */
  function fitName(head, tail) {
    const sep = /[^a-z0-9]*$/i.exec(head)[0];
    if (head.length + tail.length <= NAME_MAX) return head + tail;
    return (head.slice(0, Math.max(0, NAME_MAX - tail.length - sep.length)) + sep + tail).slice(0, NAME_MAX);
  }

  function formatSerial(s, n) {
    return fitName(s.head, String(n).padStart(s.width, '0') + s.tail);
  }

  /** Like parseSerial; a name without a number starts a series: db → db-01, db-02, … */
  function seriesOf(name) {
    return parseSerial(name) || { head: name + '-', num: 1, width: 2, tail: '' };
  }

  /** `count` names counting up from `first` (cn-007 → cn-007, cn-008, …). */
  function nameSequence(first, count) {
    const name = String(first == null ? '' : first).trim();
    if (count <= 1) return [name];
    const s = seriesOf(name);
    return Array.from({ length: count }, (_, i) => formatSerial(s, s.num + i));
  }

  /**
   * Names for new devices in racks `rackIds` (one per device), named after
   * `first`, a name for rack `fromRackId`. When `first` holds the code of
   * that rack, each name holds the code of its own rack and counts on there
   * (pdu-a01-a, pdu-a01-b, pdu-a02-a); otherwise they count on from `first`
   * as in nameSequence.
   */
  function namesAt(project, first, fromRackId, rackIds) {
    const name = String(first == null ? '' : first).trim();
    if (!rackCodeIn(project, name, fromRackId)) return nameSequence(name, rackIds.length);
    const names = [];
    for (const rackId of rackIds) {
      const named = { devices: project.devices.concat(names.map((n) => ({ name: n }))) };
      names.push(rackId === fromRackId && !names.includes(name) ? name : nameInRack(Object.assign({}, project, named), name, fromRackId, rackId, 1, true));
    }
    return names;
  }

  /**
   * Next name in the series `seed` belongs to: one past the highest number
   * already used with the same prefix and suffix, leaving room for `count`
   * consecutive names. With `inclusive`, `seed` itself may be returned.
   * The names of devices in `ignore` (ids) count as free.
   */
  function nextInSeries(project, seed, count, inclusive, ignore) {
    const skip = new Set([].concat(ignore || []));
    const used = namesOf(project.devices.filter((d) => !skip.has(d.id)));
    const s = seriesOf(seed);
    let max = inclusive ? s.num - 1 : s.num;
    for (const name of used) {
      const o = parseSerial(name);
      if (o && o.head === s.head && o.tail === s.tail) max = Math.max(max, o.num);
    }
    let n = max + 1;
    const clash = (k) => {
      for (let i = 0; i < count; i++) if (used.has(formatSerial(s, k + i))) return true;
      return false;
    };
    while (clash(n)) n++;
    return formatSerial(s, n);
  }

  /** The code of a rack that device names carry: A01 of Rack A01. */
  const rackCode = (name) => String(name).replace(/^rack\s+/i, '');

  /** Where device name `name` holds the code of rack `rackId` (b03 in pdu-b03-a, of Rack B03): [start, end), or null. */
  function rackCodeIn(project, name, rackId) {
    const rack = rackById(project, rackId);
    const code = rack ? rackCode(rack.name) : '';
    // A code of letters only (Rack A) or digits only (Rack 12) is too likely a word or a number of the name.
    if (!/\d/.test(code) || !/[a-z]/i.test(code)) return null;
    const lower = name.toLowerCase();
    const c = code.toLowerCase();
    const word = (ch) => !!ch && /[a-z0-9]/i.test(ch);
    for (let i = lower.indexOf(c); i >= 0; i = lower.indexOf(c, i + 1)) {
      if (!word(name[i - 1]) && !word(name[i + c.length])) return [i, i + c.length];
    }
    return null;
  }

  /**
   * A free name like `name` (of a device in rack `fromRackId`) for a new
   * device in rack `toRackId`, leaving room for `count` names in series.
   * A name with the code of its rack gets the code of the new one
   * (pdu-b03-a → pdu-a01-a); when the code holds its last number, the code
   * stays as it is and a letter at the end counts up (pdu-a01-a →
   * pdu-a01-b). Other names count up in their series (cn-012 → cn-013).
   * With `fresh` (a new device, not a copy), the letter starts again at a
   * in another rack: pdu-b02-b in Rack A01 suggests pdu-a01-a.
   */
  function nameInRack(project, name, fromRackId, toRackId, count, fresh) {
    const at = rackCodeIn(project, name, fromRackId);
    const to = rackById(project, toRackId);
    if (!at || !to) return nextInSeries(project, name, count, false);
    const code = rackCode(to.name);
    const was = name.slice(at[0], at[1]);
    const seed = fitName(name.slice(0, at[0]), (was === was.toLowerCase() ? code.toLowerCase() : code) + name.slice(at[1]));
    const moved = seed !== name;
    const s = parseSerial(name);
    const end = s ? name.length - s.tail.length : -1;
    if (!s || end <= at[0] || end > at[1]) return nextInSeries(project, seed, count, moved);
    const used = namesOf(project.devices);
    const letter = /^(.*[^a-z])([a-y])$/i.exec(seed);
    const restart = moved && fresh && letter;
    if (moved && !restart && !used.has(seed)) return seed;
    if (letter) {
      const first = restart ? (letter[2] === letter[2].toLowerCase() ? 97 : 65) : letter[2].charCodeAt(0) + 1;
      for (let c = first; /[a-z]/i.test(String.fromCharCode(c)); c++) {
        const next = letter[1] + String.fromCharCode(c);
        if (!used.has(next)) return next;
      }
    }
    return firstFree(used, 2, (i) => fitName(seed, `-${i}`));
  }

  /**
   * Suggests name and cluster for new devices of `typeId` placed at `loc`.
   * The reference is the nearest device of the same type in the same rack
   * (dropping next to cn-012 of cluster Kestrel suggests cn-013, Kestrel),
   * otherwise in the nearest rack of the same row, otherwise the most
   * recently added device of that type; without one, the type's default
   * name. The name follows the reference's in rack `loc.rack` (see
   * nameInRack). `cluster` is the reference's cluster in view `viewId`,
   * undefined when there is no reference; `groups` its clusters in every
   * view ({} without one) and `from` its name (null without one).
   */
  function suggestPlacement(project, typeId, loc, count, viewId) {
    const type = typeOf(project, typeId);
    const n = Math.max(1, count || 1);
    const same = project.devices.filter((d) => d.type === typeId);
    const units = loc ? rackUnits(project, loc.rack) : RACK_UNITS;
    const slots = loc ? Math.max(1, rackSideSlots(project, loc.rack)) : SIDE_SLOTS;
    const pos = (l) => (l.kind === 'u' ? l.at : (l.at + 0.5) * (units / slots));
    let ref = null;
    const here = loc ? locateRack(project, loc.rack) : null;
    if (here) {
      // Racks of the row by distance from the target: 0 is its own rack.
      const away = new Map(here.row.racks.map((r, i) => [r.id, Math.abs(i - here.index)]));
      const better = (d) => {
        const a = away.get(d.loc.rack);
        const b = away.get(ref.loc.rack);
        return a !== b ? a < b : Math.abs(pos(d.loc) - pos(loc)) < Math.abs(pos(ref.loc) - pos(loc));
      };
      for (const d of same) if (away.has(d.loc.rack) && (!ref || better(d))) ref = d;
    }
    if (!ref && same.length) ref = same[same.length - 1];
    return {
      name: ref ? nameInRack(project, ref.name, ref.loc.rack, loc ? loc.rack : ref.loc.rack, n, true) : nextInSeries(project, type ? type.defaultName : 'dev-01', n, true),
      cluster: ref ? clusterIdOf(project, ref, viewId) : undefined,
      groups: ref ? Object.assign({}, ref.groups) : {},
      from: ref ? ref.name : null,
    };
  }

  /** The names in `names` that devices other than `ignore` (ids) have already, each once. */
  function takenNames(project, names, ignore) {
    const skip = new Set([].concat(ignore || []));
    const used = namesOf(project.devices.filter((d) => !skip.has(d.id)));
    return [...new Set(names.filter((n) => used.has(n)))];
  }

  function suggestName(project, typeId, count) {
    return suggestPlacement(project, typeId, null, count).name;
  }

  /** Next unused name derived from `name` (for duplicates): cn-004 → cn-005, db → db-2. */
  function nextFreeName(project, name) {
    const used = namesOf(project.devices);
    const s = parseSerial(name);
    return s ? firstFree(used, s.num + 1, (n) => formatSerial(s, n)) : firstFree(used, 2, (i) => fitName(name, `-${i}`));
  }

  function nextClusterColor(project, viewId) {
    const list = clustersOf(project, viewId);
    const used = new Set(list.map((c) => c.color));
    return CLUSTER_COLORS.find((c) => !used.has(c)) || CLUSTER_COLORS[list.length % CLUSTER_COLORS.length];
  }

  function nextClusterName(project, viewId) {
    const list = clustersOf(project, viewId);
    return firstFreeName(list, list.length + 1, (i) => `Cluster ${i}`);
  }

  /**
   * Adds a cluster to view `viewId`: `props.id` or a new one, `props.name`
   * or Cluster N (with a number when another cluster of the view has that
   * name), `props.color` or a free one.
   */
  function addCluster(project, viewId, props) {
    const o = props || {};
    const list = clustersOf(project, viewId);
    const c = { id: o.id || uid('c'), name: uniqueLabel(list, 'name', str(o.name, LIMITS.name) || nextClusterName(project, viewId)), color: normalizeHex(o.color) || nextClusterColor(project, viewId) };
    list.push(c);
    return c;
  }

  /** Changes a cluster's name or color; an error message, and no change, when another cluster of its view has the name. */
  function updateCluster(project, id, changes) {
    const v = viewOfCluster(project, id);
    if (!v) return 'Unknown cluster';
    const c = v.clusters.find((x) => x.id === id);
    const name = changes.name === undefined ? c.name : str(changes.name, LIMITS.name);
    if (!name) return 'A cluster needs a name';
    if (name !== c.name && nameTaken(v.clusters, name, id)) return `Another cluster in ${v.name} is named ${name}`;
    c.name = name;
    if (changes.color !== undefined) c.color = normalizeHex(changes.color) || c.color;
    return null;
  }

  /** Removes a cluster from its view; its devices are unassigned there. */
  function removeCluster(project, id) {
    const v = viewOfCluster(project, id);
    if (!v) return false;
    v.clusters = v.clusters.filter((c) => c.id !== id);
    for (const d of project.devices) if (d.groups && d.groups[v.id] === id) delete d.groups[v.id];
    return true;
  }

  // ------------------------------------------------------------------ views

  function nextViewName(project) {
    return firstFreeName(project.views, project.views.length + 1, (i) => `View ${i}`);
  }

  /** Name for a copy of view `id`: "Lustre (copy)", then "Lustre (copy 2)"; no other view has it, in any case. */
  function copyViewName(project, id) {
    return copyName(project.views, viewOf(project, id).name);
  }

  /**
   * Adds a view at the end, named `name` or View N, with a number when
   * another view has that name in any case. With `fromViewId`, the
   * new view starts as a copy of that view: its clusters (with new ids) and
   * every device's cluster in it. Null when the plan has eight views.
   */
  function addView(project, name, fromViewId) {
    if (project.views.length >= LIMITS.views) return null;
    const view = { id: uid('v'), name: uniqueLabel(project.views, 'name', str(name, LIMITS.name) || nextViewName(project)), clusters: [] };
    const from = fromViewId ? viewById(project, fromViewId) : null;
    if (from) {
      const ids = new Map();
      for (const c of from.clusters) {
        const nc = Object.assign({}, c, { id: uid('c') });
        ids.set(c.id, nc.id);
        view.clusters.push(nc);
      }
      for (const d of project.devices) {
        const c = clusterIdOf(project, d, from.id);
        if (c) d.groups = Object.assign({}, d.groups, { [view.id]: ids.get(c) });
      }
    }
    project.views.push(view);
    return view;
  }

  /** Renames a view; false, and the old name kept, for an empty name or one another view has, in any case. */
  function renameView(project, id, name) {
    return renameIn(project.views, viewById(project, id), name);
  }

  /** Removes a view with its clusters. A plan keeps at least one view. */
  function removeView(project, id) {
    const v = viewById(project, id);
    if (!v || project.views.length <= 1) return false;
    project.views = project.views.filter((x) => x !== v);
    for (const d of project.devices) if (d.groups) delete d.groups[v.id];
    return true;
  }

  /** Moves a view to position `toIndex`. */
  function moveView(project, id, toIndex) {
    const i = project.views.findIndex((v) => v.id === id);
    if (i < 0) return false;
    const [v] = project.views.splice(i, 1);
    project.views.splice(Math.max(0, Math.min(project.views.length, toIndex)), 0, v);
    return true;
  }

  /** A new device with every field set; `props` overrides the defaults. */
  function newDevice(props) {
    return Object.assign(
      { id: uid('d'), type: '', name: '', groups: {}, notes: '', serial: '', asset: '', ip: '', owner: '', powerW: null, weightKg: null, reversed: false, slackM: null, loc: null },
      props
    );
  }

  /** Sets a device's notes or a field of FIELDS to `value`, cut to the length a plan keeps. */
  function setDeviceText(d, key, value) {
    d[key] = String(value == null ? '' : value).slice(0, key === 'notes' ? NOTES_MAX : FIELD_MAX);
  }

  /**
   * The serial numbers, asset tags and IP addresses that more than one
   * device has (case and spaces around them aside), in the order of FIELDS
   * and of the devices: [{ key, label, value, devices }]. With `d`, only
   * those of device `d`.
   */
  function repeatedFields(project, d) {
    const out = [];
    for (const f of FIELDS) {
      if (!f.instance) continue;
      const by = new Map();
      for (const x of project.devices) {
        const v = typeof x[f.key] === 'string' ? x[f.key].trim() : '';
        if (!v) continue;
        const k = v.toLowerCase();
        if (!by.has(k)) by.set(k, { key: f.key, label: f.label, value: v, devices: [] });
        by.get(k).devices.push(x);
      }
      for (const r of by.values()) if (r.devices.length > 1 && (!d || r.devices.includes(d))) out.push(r);
    }
    return out;
  }

  // ----------------------------------------------------------------- cables

  /** The set ends of a cable: [{ end, role: 'a'|'b', leg }], `leg` being the index in a breakout's `b` (null otherwise). */
  function cableEnds(cable) {
    const out = cable.a ? [{ end: cable.a, role: 'a', leg: null }] : [];
    if (Array.isArray(cable.b)) cable.b.forEach((e, i) => e && out.push({ end: e, role: 'b', leg: i }));
    else if (cable.b) out.push({ end: cable.b, role: 'b', leg: null });
    return out;
  }
  /** The `b` ends of a cable as a list: the legs of a breakout, or the one far end. */
  function legsOf(cable) {
    return Array.isArray(cable.b) ? cable.b : [cable.b];
  }
  const portKey = (device, port) => `${device}|${port}`;

  /** A cable end from untrusted input: { device, port } and `transceiver` when one is chosen. */
  function cleanCableEnd(raw) {
    if (!isObj(raw)) return null;
    const end = { device: String(raw.device == null ? '' : raw.device), port: String(raw.port == null ? '' : raw.port) };
    if (raw.transceiver) end.transceiver = String(raw.transceiver);
    return end;
  }

  /**
   * What checking cables needs, built once: devices and their port names by
   * id, and the ports already taken by cables other than `ignoreCableId`.
   * `used` maps "device|port" to the cable there.
   */
  function cableContext(project, ignoreCableId) {
    const byType = new Map();
    const ports = new Map();
    const devices = new Map();
    for (const d of project.devices) {
      let names = byType.get(d.type);
      if (!names) byType.set(d.type, (names = new Set(expandPorts(typeOf(project, d.type)).map((p) => p.name))));
      ports.set(d.id, names);
      devices.set(d.id, d);
    }
    const used = new Map();
    for (const c of project.cables || []) {
      if (c.id === ignoreCableId) continue;
      for (const x of cableEnds(c)) used.set(portKey(x.end.device, x.end.port), c);
    }
    return { devices, ports, used };
  }

  /** Marks the ports of `cable` as taken in a context from cableContext. */
  function claimPorts(ctx, cable) {
    for (const x of cableEnds(cable)) ctx.used.set(portKey(x.end.device, x.end.port), cable);
  }

  /**
   * Why `cable` cannot be in the plan, or null: an end on a device or port
   * that does not exist, a port that already has a cable, the same port
   * twice, a device cabled to itself, a type, transceiver or network that is
   * not in the plan, or legs that don't match a breakout type.
   */
  function cableProblem(project, cable, ctx) {
    const c = ctx || cableContext(project, cable.id);
    const type = cable.type ? cableTypeById(project, cable.type) : null;
    if (cable.type && !type) return `Unknown cable type “${cable.type}”`;
    if (cable.network && !networkById(project, cable.network)) return `Unknown network “${cable.network}”`;
    if (Array.isArray(cable.b)) {
      if (!type || type.legs < 2) return 'A breakout cable needs a breakout cable type';
      if (cable.b.length !== type.legs) return `${type.name} has ${type.legs} legs, not ${cable.b.length}`;
      if (!cable.b.some(Boolean)) return 'A breakout cable needs at least one leg';
    } else if (type && type.legs > 1) {
      return `${type.name} is a breakout cable: give it its legs`;
    }
    if (!cable.a || (!Array.isArray(cable.b) && !cable.b)) return 'A cable needs two ends';
    const seen = new Set();
    for (const x of cableEnds(cable)) {
      const e = x.end;
      const d = c.devices.get(e.device);
      if (!d) return `Unknown device “${e.device}”`;
      if (!c.ports.get(d.id).has(e.port)) return `${d.name} has no port ${e.port}`;
      if (e.transceiver && !transceiverById(project, e.transceiver)) return `Unknown transceiver “${e.transceiver}”`;
      const key = portKey(e.device, e.port);
      if (seen.has(key)) return `${d.name} ${e.port} is used twice in this cable`;
      seen.add(key);
      if (x.role === 'b' && e.device === cable.a.device) {
        return x.leg === null ? `A cable cannot join ${d.name} to itself` : `The legs of a breakout cable go to other devices than ${d.name}, its head`;
      }
      const other = c.used.get(key);
      if (other && other.id !== cable.id) return `${d.name} ${e.port} already has cable ${other.label || 'without a label'}`;
    }
    return null;
  }

  /**
   * Drops cable ends on devices or ports that no longer exist (and ends on a
   * port another cable already uses). A cable that loses its head or its far
   * end goes; a breakout loses only the leg, unless none is left. Clears
   * networks that no longer exist. Power cords are pruned along with the
   * cables (see pruneCords). Returns the number of cables removed or
   * changed.
   */
  function pruneCables(project) {
    pruneCords(project);
    if (!Array.isArray(project.cables) || !project.cables.length) return 0;
    const ctx = cableContext(Object.assign({}, project, { cables: [] }));
    const nets = new Set((project.networks || []).map((n) => n.id));
    const used = new Set();
    const free = (e) => !!e && ctx.ports.has(e.device) && ctx.ports.get(e.device).has(e.port) && !used.has(portKey(e.device, e.port));
    let changed = 0;
    const keep = (c) => {
      if (!free(c.a)) return false;
      const head = portKey(c.a.device, c.a.port);
      used.add(head);
      if (!Array.isArray(c.b)) {
        const ok = free(c.b) && c.b.device !== c.a.device;
        if (ok) used.add(portKey(c.b.device, c.b.port));
        else used.delete(head);
        return ok;
      }
      const legs = c.b.map((e) => {
        if (!e || e.device === c.a.device || !free(e)) return null;
        used.add(portKey(e.device, e.port));
        return e;
      });
      if (!legs.some(Boolean)) {
        used.delete(head);
        return false;
      }
      if (legs.some((e, i) => e !== c.b[i])) {
        c.b = legs;
        return 'changed';
      }
      return true;
    };
    project.cables = project.cables.filter((c) => {
      const lostNetwork = !!c.network && !nets.has(c.network);
      if (lostNetwork) c.network = null;
      const k = keep(c);
      if (!k || k === 'changed' || lostNetwork) changed++;
      return !!k;
    });
    return changed;
  }

  const LABEL_MAX = 40;

  /** formatSerial within the length of a label: a number that outgrows it shortens the head (LLL-9999 → LL-10000). */
  function formatLabel(s, n) {
    const num = String(n).padStart(s.width, '0');
    const head = s.head.slice(0, Math.max(0, LABEL_MAX - num.length - s.tail.length));
    return (head + num + s.tail).slice(0, LABEL_MAX).trim();
  }

  /** Series of a label to continue: IB-0009 → IB-0010; a label without a number starts one (uplink → uplink-0001). */
  const labelSeries = (seed) => parseSerial(seed) || { head: `${seed}-`, num: 1, width: 4, tail: '' };

  /**
   * Hands out cable labels that continue series past the highest label of
   * each series among the plan's cables and `taken` (a Set), reading those
   * once, or (with `from`) fill a series from a label given by hand. Every
   * label handed out counts as taken. With `items`, the labels of those
   * (the plan's power cords, say) count instead of the cables'.
   */
  function labeler(project, taken, items) {
    const used = new Set((items || project.cables || []).map((c) => c.label));
    if (taken) for (const l of taken) used.add(l);
    const highest = new Map();
    const note = (label) => {
      const o = parseSerial(label);
      if (o) highest.set(`${o.head}\u0000${o.tail}`, Math.max(highest.get(`${o.head}\u0000${o.tail}`) || 0, o.num));
    };
    used.forEach(note);
    const take = (label) => {
      used.add(label);
      note(label);
      return label;
    };
    return {
      /** The next label of the series `seed` starts; with `inclusive`, `seed` itself may be it. */
      next(seed, inclusive) {
        const s = labelSeries(seed);
        const max = Math.max(inclusive ? s.num - 1 : s.num, highest.get(`${s.head}\u0000${s.tail}`) || 0);
        return take(firstFree(used, max + 1, (n) => formatLabel(s, n)));
      },
      /** Counts `label` as taken (a label given by hand) and returns it. */
      take,
      /**
       * `seed` itself when free, else the first free label of its series
       * after it (not past the highest). A seed without a number is a series
       * to start (uplink → uplink-0001, see labelSeries), never kept as it
       * is: a label kept as typed is take's.
       */
      from(seed) {
        const s = labelSeries(seed);
        return take(firstFree(used, s.num, (n) => formatLabel(s, n)));
      },
      /** The label after `label`: IB-0009 → IB-0010 (past the highest used), uplink → uplink-2. */
      after(label) {
        return parseSerial(label) ? this.next(label, false) : take(firstFree(used, 2, (i) => `${label.slice(0, LABEL_MAX - 1 - String(i).length)}-${i}`));
      },
    };
  }

  /**
   * The next label of the series `seed` starts: one past the highest label of
   * that series among the plan's cables and `taken` (a Set). With
   * `inclusive`, `seed` itself may be the answer.
   */
  function continueLabel(project, seed, inclusive, taken) {
    return labeler(project, taken).next(seed, inclusive);
  }

  /** The label after `label` in its series (IB-0009 → IB-0010 past the highest used); uplink → uplink-2. */
  function nextLabelAfter(project, label, taken) {
    return labeler(project, taken).after(label);
  }

  /** First label of the series of a network's cables (null: no network, C-0001 …). */
  function labelSeed(project, networkId) {
    const net = networkById(project, networkId);
    return net ? net.firstLabel || defaultFirstLabel(net.name) : 'C-0001';
  }

  /** Label for a new cable of a network (null: none): its series continued. */
  function nextCableLabel(project, networkId, taken) {
    return continueLabel(project, labelSeed(project, networkId), true, taken);
  }

  /**
   * Copies the cables between devices that were copied: `idMap` maps old to
   * new device ids. A cable is copied when all its ends are on mapped
   * devices; the copy continues the original's label series. Returns the
   * copies.
   */
  function copyCables(project, idMap) {
    if (!Array.isArray(project.cables) || !idMap.size) return [];
    const labels = labeler(project);
    const out = [];
    for (const c of project.cables.slice()) {
      const ends = cableEnds(c);
      if (!ends.length || !ends.every((x) => idMap.has(x.end.device))) continue;
      if (project.cables.length + out.length >= LIMITS.cables) break;
      const copy = clone(c);
      copy.id = uid('cb');
      copy.label = c.label ? labels.after(c.label) : labels.next(labelSeed(project, c.network), true);
      for (const x of cableEnds(copy)) x.end.device = idMap.get(x.end.device);
      out.push(copy);
    }
    project.cables.push(...out);
    return out;
  }

  /**
   * Where each port of the groups `oldPorts` goes in the groups `newPorts`:
   * a Map from old to new port name. Groups are matched first by their
   * pattern (swp[1-48]), then by name, then the groups left over are paired
   * in order when as many are left on both sides (groups renamed in place)
   * and a plug of the old group fits the new one: an InfiniBand cable does
   * not move to an RJ45 port that took the place of its port.
   * A port keeps its place in its matched group; a port without one keeps
   * its name when that port still exists and no other port moves to it.
   * `fits(oldConnector, newConnector)` replaces plugFits for groups that
   * are no network ports (inlets, outlets).
   */
  function portMoves(oldPorts, newPorts, fits) {
    const olds = Array.isArray(oldPorts) ? oldPorts : [];
    const news = Array.isArray(newPorts) ? newPorts : [];
    const match = new Map();
    const taken = new Set();
    const pair = (same) => {
      olds.forEach((g, i) => {
        if (match.has(i)) return;
        const j = news.findIndex((h, k) => !taken.has(k) && same(g, h));
        if (j < 0) return;
        match.set(i, j);
        taken.add(j);
      });
    };
    pair((g, h) => portPattern(g) === portPattern(h));
    pair((g, h) => g.name === h.name);
    const leftOld = olds.map((g, i) => i).filter((i) => !match.has(i));
    const leftNew = news.map((h, j) => j).filter((j) => !taken.has(j));
    if (leftOld.length === leftNew.length) leftOld.forEach((i, k) => (fits || plugFits)(olds[i].connector, news[leftNew[k]].connector) && match.set(i, leftNew[k]));
    const names = news.map((h) => groupNames(h));
    const out = new Map();
    const targets = new Set();
    olds.forEach((g, i) => {
      if (!match.has(i)) return;
      groupNames(g).forEach((name, place) => {
        const to = names[match.get(i)][place];
        if (to === undefined) return;
        out.set(name, to);
        targets.add(to);
      });
    });
    const after = new Set([].concat(...names));
    for (const g of olds) for (const name of groupNames(g)) if (!out.has(name) && after.has(name) && !targets.has(name)) out.set(name, name);
    return out;
  }

  /**
   * Calls `visit(ref, owner, kind)` for each place in the plan that names
   * a port, inlet or outlet of a device: the { device, port } of each
   * cable end and breakout leg (kind 'port'), and the { device, inlet }
   * and { device, outlet } of each power cord (kinds 'inlet' and
   * 'outlet'; the name is at ref[kind]). Code that renames or moves ports
   * goes through here, so that whatever names one moves with it.
   */
  function forEachPortRef(project, visit) {
    for (const c of project.cables || []) for (const x of cableEnds(c)) visit(x.end, c, 'port');
    for (const c of project.powerCords || []) {
      if (c.inlet) visit(c.inlet, c, 'inlet');
      if (c.outlet) visit(c.outlet, c, 'outlet');
    }
  }

  /**
   * Moves the references on the devices of `deviceIds` (a Set) to the
   * names `moves` gives: { port, inlet, outlet }, each a Map from portMoves
   * (a kind without one stays as it is), and drops those whose place is
   * gone. Returns what pruneCables returns.
   */
  function movePortRefs(project, deviceIds, moves) {
    forEachPortRef(project, (ref, owner, kind) => {
      // Names are never empty, so prune removes an end set to ''.
      if (deviceIds.has(ref.device) && moves[kind]) ref[kind] = moves[kind].get(ref[kind]) || '';
    });
    return pruneCables(project);
  }

  const sameConnector = (a, b) => a === b;
  const outletsOf = (type) => (type && type.pdu ? type.pdu.outlets : []);
  /**
   * Where the ports, inlets and outlets of a device type go when it
   * becomes `next` (another type, or itself changed): the maps
   * movePortRefs takes, only of the kinds that differ; null when none does.
   */
  function typeMoves(before, next) {
    const out = {};
    const differ = (a, b) => JSON.stringify(a || []) !== JSON.stringify(b || []);
    if (differ(before.ports, next.ports)) out.port = portMoves(before.ports, next.ports);
    if (differ(before.inlets, next.inlets)) out.inlet = portMoves(before.inlets, next.inlets, sameConnector);
    if (differ(outletsOf(before), outletsOf(next))) out.outlet = portMoves(outletsOf(before), outletsOf(next), sameConnector);
    return Object.keys(out).length ? out : null;
  }

  /**
   * After the ports of a device type changed from `oldPorts`, moves the
   * cable ends on its devices to the port at the same place (see portMoves)
   * and drops the ends whose place is gone.
   */
  function remapPorts(project, typeId, oldPorts) {
    const type = typeOf(project, typeId);
    if (!type || !Array.isArray(project.cables)) return 0;
    const devices = new Set(project.devices.filter((d) => d.type === typeId).map((d) => d.id));
    return movePortRefs(project, devices, { port: portMoves(oldPorts, type.ports) });
  }

  /**
   * Gives device `deviceId` the type `typeId` (of the catalog, or reserved
   * space), where it is. Its cable ends move to the port at the same place
   * in the new type's port groups (see portMoves); the ends whose place is
   * gone are unplugged (see pruneCables). A device mounted the way devices
   * of its old type are by default is mounted the way those of the new
   * type are. Returns an error message and leaves the plan unchanged when
   * the device would not fit where it is. Its power cords move with its
   * inlets (a PDU's with its outlets) in the same way.
   */
  function setDeviceType(project, deviceId, typeId) {
    const d = deviceById(project, deviceId);
    const type = typeOf(project, typeId);
    if (!d || !type) return 'Unknown device or device type';
    const before = typeOf(project, d.type);
    if (before === type) return null;
    // Reserved space takes the height of what it replaces.
    const height = type.variable ? deviceHeight(project, d) : undefined;
    const fit = canPlace(project, typeId, d.loc, d.id, height);
    if (!fit.ok) return fit.reason;
    if (!before || mountsReversed(before) === !!d.reversed) d.reversed = mountsReversed(type);
    d.type = typeId;
    if (type.variable) d.height = height;
    else delete d.height;
    movePortRefs(project, new Set([d.id]), typeMoves(before || {}, type) || {});
    return null;
  }

  // ------------------------------------------------------------ power cords

  const endKey = (device, name) => `${device}|${name}`;

  /** A power cord from untrusted input: its ends as { device, inlet } and { device, outlet }, null for an end that is none. */
  function cleanCordEnd(raw, key) {
    if (!isObj(raw)) return null;
    return { device: String(raw.device == null ? '' : raw.device), [key]: portName(raw[key]) };
  }

  /**
   * What checking power cords needs, built once: devices by id with the
   * names of their inlets and outlets, and the inlets and outlets taken by
   * cords other than `ignoreCordId` ("device|name" → cord).
   */
  function cordContext(project, ignoreCordId) {
    const byType = new Map();
    const devices = new Map();
    const inlets = new Map();
    const outlets = new Map();
    for (const d of project.devices) {
      let names = byType.get(d.type);
      if (!names) {
        const t = typeOf(project, d.type);
        byType.set(d.type, (names = { inlets: new Set(expandInlets(t).map((x) => x.name)), outlets: new Set(expandOutlets(t).map((x) => x.name)) }));
      }
      devices.set(d.id, d);
      inlets.set(d.id, names.inlets);
      outlets.set(d.id, names.outlets);
    }
    const usedInlets = new Map();
    const usedOutlets = new Map();
    for (const c of project.powerCords || []) {
      if (c.id === ignoreCordId) continue;
      if (c.inlet) usedInlets.set(endKey(c.inlet.device, c.inlet.inlet), c);
      if (c.outlet) usedOutlets.set(endKey(c.outlet.device, c.outlet.outlet), c);
    }
    return { devices, inlets, outlets, usedInlets, usedOutlets };
  }

  /** Marks the inlet and the outlet of `cord` as taken in a context from cordContext. */
  function claimCord(ctx, cord) {
    ctx.usedInlets.set(endKey(cord.inlet.device, cord.inlet.inlet), cord);
    ctx.usedOutlets.set(endKey(cord.outlet.device, cord.outlet.outlet), cord);
  }

  /**
   * Why `cord` cannot be in the plan, or null: an end on a device, inlet
   * or outlet that does not exist, an inlet or outlet that already has a
   * cord, ends in two racks, or a cord type that is not in the plan.
   */
  function cordProblem(project, cord, ctx) {
    const c = ctx || cordContext(project, cord.id);
    if (cord.type && !cordTypeById(project, cord.type)) return `Unknown cord type “${cord.type}”`;
    if (!cord.inlet || !cord.outlet) return 'A power cord needs an inlet and an outlet';
    const d = c.devices.get(cord.inlet.device);
    if (!d) return `Unknown device “${cord.inlet.device}”`;
    if (!c.inlets.get(d.id).has(cord.inlet.inlet)) return `${d.name} has no inlet ${cord.inlet.inlet}`;
    const pdu = c.devices.get(cord.outlet.device);
    if (!pdu) return `Unknown PDU “${cord.outlet.device}”`;
    if (!c.outlets.get(pdu.id).has(cord.outlet.outlet)) return `${pdu.name} has no outlet ${cord.outlet.outlet}`;
    if (d.loc.rack !== pdu.loc.rack) return `${d.name} and ${pdu.name} are in different racks: a power cord stays in its rack`;
    const a = c.usedInlets.get(endKey(d.id, cord.inlet.inlet));
    if (a && a.id !== cord.id) return `${d.name} ${cord.inlet.inlet} already has cord ${a.label || 'without a label'}`;
    const b = c.usedOutlets.get(endKey(pdu.id, cord.outlet.outlet));
    if (b && b.id !== cord.id) return `Outlet ${cord.outlet.outlet} of ${pdu.name} already has cord ${b.label || 'without a label'}`;
    return null;
  }

  /**
   * Drops the power cords that cannot be in the plan any more (see
   * cordProblem): an end on a device, inlet or outlet that is gone, ends
   * in two racks. A cord type that is gone becomes Auto, and a PDU's grid
   * that is gone none. Returns the number of cords removed.
   */
  function pruneCords(project) {
    const grids = new Set((project.powerGrids || []).map((g) => g.id));
    for (const d of project.devices) if (d.grid && !grids.has(d.grid)) d.grid = null;
    if (!Array.isArray(project.powerCords) || !project.powerCords.length) return 0;
    const ctx = cordContext(Object.assign({}, project, { powerCords: [] }));
    const before = project.powerCords.length;
    project.powerCords = project.powerCords.filter((c) => {
      if (c.type && !cordTypeById(project, c.type)) c.type = null;
      if (cordProblem(project, c, ctx)) return false;
      claimCord(ctx, c);
      return true;
    });
    return before - project.powerCords.length;
  }

  /** The power cords with an end on a device of `deviceIds` (a Set or list). */
  function cordsOf(project, deviceIds) {
    const ids = deviceIds instanceof Set ? deviceIds : new Set(deviceIds);
    return (project.powerCords || []).filter((c) => ids.has(c.inlet.device) || ids.has(c.outlet.device));
  }

  /**
   * The power cords that moving devices (`moves`: [{ id, loc }]) would
   * unplug: those with one end in another rack than the other afterwards.
   */
  function cordsBrokenBy(project, moves) {
    const to = new Map(moves.map((m) => [m.id, m.loc.rack]));
    const rackOf = (id) => {
      if (to.has(id)) return to.get(id);
      const d = deviceById(project, id);
      return d ? d.loc.rack : null;
    };
    return (project.powerCords || []).filter((c) => (to.has(c.inlet.device) || to.has(c.outlet.device)) && rackOf(c.inlet.device) !== rackOf(c.outlet.device));
  }

  /** Label for a new power cord: the series P-0001 continued. */
  function nextCordLabel(project, taken) {
    return labeler(project, taken, project.powerCords || []).next(CORD_LABEL, true);
  }

  /**
   * Copies the power cords between devices that were copied (`idMap`: old
   * → new device ids), like copyCables: a cord is copied when its device
   * and its PDU both are. Returns the copies.
   */
  function copyCords(project, idMap) {
    if (!Array.isArray(project.powerCords) || !idMap.size) return [];
    const labels = labeler(project, null, project.powerCords);
    const out = [];
    for (const c of project.powerCords.slice()) {
      if (!idMap.has(c.inlet.device) || !idMap.has(c.outlet.device)) continue;
      if (project.powerCords.length + out.length >= LIMITS.powerCords) break;
      const copy = clone(c);
      copy.id = uid('pc');
      copy.label = c.label ? labels.after(c.label) : labels.next(CORD_LABEL, true);
      copy.inlet.device = idMap.get(c.inlet.device);
      copy.outlet.device = idMap.get(c.outlet.device);
      out.push(copy);
    }
    project.powerCords.push(...out);
    return out;
  }

  // ------------------------------------------------------------------ PDUs

  /**
   * Name for a new PDU of `typeId` in slot `at` of a rack: by its rack
   * and slot (pdu-a01-a in P1 of Rack A01, pdu-a01-b in P2), with the
   * head of the nearest PDU of its type when that is named this way
   * (rpdu-b02-a → rpdu-a01-a). After a PDU named another way, or in a
   * rack whose name holds no code, it continues that series or the
   * type's default name (see suggestPlacement).
   */
  function pduNameFor(project, typeId, rackId, at) {
    const s = suggestPlacement(project, typeId, { rack: rackId, kind: 'pdu', at }, 1);
    const rack = rackById(project, rackId);
    const code = rack ? rackCode(rack.name) : '';
    let head = null;
    if (!s.from) {
      if (/\d/.test(code) && /[a-z]/i.test(code) && !/\s/.test(code)) head = `pdu-${code.toLowerCase()}-`;
    } else if (rackCodeIn(project, s.name, rackId)) {
      const m = /^(.*[^a-z])[a-z]$/i.exec(s.name);
      if (m) head = m[1];
    }
    if (!head) return s.name;
    const used = namesOf(project.devices);
    const first = /[A-Z]$/.test(s.from ? s.name : head + 'a') ? 65 : 97;
    for (let i = at; i < 26; i++) if (!used.has(head + String.fromCharCode(first + i))) return head + String.fromCharCode(first + i);
    return s.name;
  }

  /**
   * The grid a new PDU in slot `at` gets by default: the plan's grids in
   * turn, so that P1 is on the first and P2 on the second; null without
   * grids.
   */
  function gridForSlot(project, at) {
    const grids = project.powerGrids || [];
    return grids.length ? grids[at % grids.length].id : null;
  }

  /** The PDU type that fills the PDU slots of racks of type `rt`: its default PDU, else `typeId`; null when neither is a vertical PDU type. */
  function fillType(project, rt, typeId) {
    return [rt.defaultPdu, typeId].map((id) => (id ? typeOf(project, id) : null)).find(isPduType) || null;
  }

  /**
   * Puts a PDU of the rack type's default PDU type into each free PDU slot
   * of the racks `rackIds`, named by pduNameFor and fed by gridForSlot.
   * Racks whose type names none get PDU type `typeId`, or stay as they
   * are without it. Returns the new devices.
   */
  function fillPduSlots(project, rackIds, typeId) {
    const out = [];
    for (const rackId of rackIds) {
      const rack = rackById(project, rackId);
      if (!rack) continue;
      const rt = rackTypeOf(project, rack);
      const type = fillType(project, rt, typeId);
      if (!type) continue;
      const taken = new Set(project.devices.filter((d) => d.loc.rack === rack.id && d.loc.kind === 'pdu').map((d) => d.loc.at));
      (rt.pduSlots || []).forEach((side, at) => {
        if (taken.has(at)) return;
        const d = newDevice({ type: type.id, name: pduNameFor(project, type.id, rack.id, at), grid: gridForSlot(project, at), loc: { rack: rack.id, kind: 'pdu', at } });
        project.devices.push(d);
        out.push(d);
      });
    }
    return out;
  }

  /** The racks among `rackIds` that fillPduSlots would give a PDU: a default PDU type (or `typeId`) and a free slot. */
  function fillableRacks(project, rackIds, typeId) {
    return rackIds.filter((id) => {
      const rack = rackById(project, id);
      const rt = rack ? rackTypeOf(project, rack) : null;
      if (!rt || !fillType(project, rt, typeId)) return false;
      return project.devices.filter((d) => d.loc.rack === id && d.loc.kind === 'pdu').length < (rt.pduSlots || []).length;
    });
  }

  /**
   * Makes a vertical PDU type of device type `typeId` (a 1U PDU of an
   * older plan), with the `pdu` block given, and moves its devices into
   * the PDU slots of their racks: from side slot V1 to P1 and V2 to P2
   * where that slot is free, else to the first free one. Names, clusters
   * and network cables stay. Returns an error message and leaves the plan
   * unchanged when a device finds no free PDU slot.
   */
  function makeVerticalPdu(project, typeId, pdu) {
    const i = project.deviceTypes.findIndex((t) => t.id === typeId);
    if (i < 0) return 'Unknown device type';
    const before = project.deviceTypes[i];
    if (isPduType(before)) return `${before.label} is a vertical PDU already`;
    const next = cleanDeviceType(Object.assign({}, before, { pdu: isObj(pdu) ? pdu : PDU_1P_20 }));
    next.id = typeId;
    const taken = new Map();
    const slotsOf = (rackId) => {
      if (!taken.has(rackId)) taken.set(rackId, new Set(project.devices.filter((d) => d.loc.rack === rackId && d.loc.kind === 'pdu').map((d) => d.loc.at)));
      return taken.get(rackId);
    };
    const moves = [];
    for (const d of sortedDevices(project).filter((x) => x.type === typeId)) {
      const slots = rackPduSlots(project, d.loc.rack).length;
      const used = slotsOf(d.loc.rack);
      const order = (d.loc.kind === 'side' ? [d.loc.at] : []).concat(Array.from({ length: slots }, (_, k) => k));
      const at = order.find((s) => s < slots && !used.has(s));
      if (at === undefined) {
        const rack = rackById(project, d.loc.rack);
        return `${d.name} finds no free PDU slot in ${rack ? rack.name : 'its rack'}`;
      }
      used.add(at);
      moves.push([d, at]);
    }
    project.deviceTypes[i] = next;
    for (const [d, at] of moves) {
      d.loc = { rack: d.loc.rack, kind: 'pdu', at };
      d.reversed = false;
      if (d.grid === undefined) d.grid = null;
    }
    const changed = typeMoves(before, next);
    if (changed) movePortRefs(project, new Set(moves.map(([d]) => d.id)), changed);
    return null;
  }

  // ------------------------------------------------------------- statistics

  function emptyStats(project, rack) {
    const rt = rackTypeOf(project, rack);
    return {
      units: rt.units,
      used: 0,
      reserved: 0,
      free: rt.units,
      largestFree: rt.units,
      sideUsed: 0,
      sideSlots: rt.sideSlots,
      pduUsed: 0,
      pduSlots: (rt.pduSlots || []).length,
      count: 0,
      powerW: 0,
      powerBudgetW: rt.powerW,
      weightKg: 0,
      weightBudgetKg: rt.weightKg,
      overPower: false,
      overWeight: false,
    };
  }

  function finishStats(st, occupied) {
    let run = 0;
    st.largestFree = 0;
    for (let u = 1; u <= st.units; u++) {
      run = occupied[u] ? 0 : run + 1;
      st.largestFree = Math.max(st.largestFree, run);
    }
    st.free = st.units - st.used - st.reserved;
    st.powerW = Math.round(st.powerW * 100) / 100;
    st.weightKg = Math.round(st.weightKg * 100) / 100;
    st.overPower = st.powerBudgetW > 0 && st.powerW > st.powerBudgetW;
    st.overWeight = st.weightBudgetKg > 0 && st.weightKg > st.weightBudgetKg;
    return st;
  }

  /**
   * Usage of every rack in one pass: units used by devices and reserved,
   * free space, side slots, and power and weight against the rack type's
   * budgets. Reserved space counts its planned power and weight too.
   */
  function statsByRack(project) {
    const out = new Map();
    const occ = new Map();
    for (const { rack } of allRacks(project)) {
      const st = emptyStats(project, rack);
      out.set(rack.id, st);
      occ.set(rack.id, new Uint8Array(st.units + 2));
    }
    for (const d of project.devices) {
      const st = out.get(d.loc.rack);
      if (!st) continue;
      const reserved = d.type === RESERVED.id;
      st.powerW += powerOf(project, d);
      st.weightKg += weightOf(project, d);
      if (!reserved) st.count++;
      if (d.loc.kind === 'side') {
        st.sideUsed++;
        continue;
      }
      if (d.loc.kind === 'pdu') {
        st.pduUsed++;
        continue;
      }
      const [b, t] = deviceSpan(project, d);
      const grid = occ.get(d.loc.rack);
      for (let u = b; u <= Math.min(t, st.units); u++) grid[u] = 1;
      if (reserved) st.reserved += t - b + 1;
      else st.used += t - b + 1;
    }
    for (const [id, st] of out) finishStats(st, occ.get(id));
    return out;
  }

  function rackStats(project, rackId) {
    const rack = rackById(project, rackId);
    if (!rack) return null;
    const scoped = Object.assign({}, project, {
      floors: [{ id: '_', name: '', rows: [{ id: '_', name: '', racks: [rack] }] }],
      devices: project.devices.filter((d) => d.loc.rack === rackId),
    });
    return statsByRack(scoped).get(rackId);
  }

  /**
   * The racks that adding `devices` (new ones, with type, loc and any
   * height, power or weight of their own) would leave over their power or
   * weight budget, the devices in `ignore` (ids) taken out: [{ rack,
   * stats }], stats as they would be.
   */
  function overBudgetWith(project, devices, ignore) {
    const skip = new Set([].concat(ignore || []));
    const after = Object.assign({}, project, { devices: project.devices.filter((d) => !skip.has(d.id)).concat(devices) });
    const out = [];
    for (const id of new Set(devices.map((d) => d.loc.rack))) {
      const stats = rackStats(after, id);
      if (stats && (stats.overPower || stats.overWeight)) out.push({ rack: rackById(project, id), stats });
    }
    return out;
  }

  /** Totals over several racks' stats (for a row, floor or the plan). */
  function sumStats(list) {
    const t = { racks: 0, units: 0, used: 0, reserved: 0, free: 0, sideUsed: 0, sideSlots: 0, pduUsed: 0, pduSlots: 0, count: 0, powerW: 0, powerBudgetW: 0, weightKg: 0, weightBudgetKg: 0, overPower: 0, overWeight: 0 };
    for (const s of list) {
      t.racks++;
      for (const k of ['units', 'used', 'reserved', 'free', 'sideUsed', 'sideSlots', 'pduUsed', 'pduSlots', 'count', 'powerW', 'powerBudgetW', 'weightKg', 'weightBudgetKg']) t[k] += s[k];
      if (s.overPower) t.overPower++;
      if (s.overWeight) t.overWeight++;
    }
    t.powerW = Math.round(t.powerW * 100) / 100;
    t.weightKg = Math.round(t.weightKg * 100) / 100;
    return t;
  }

  /** Stats of the racks within a rack, row or floor id (or the whole plan). */
  function statsWithin(project, id, byRack) {
    const all = byRack || statsByRack(project);
    const ids = id ? rackIdsWithin(project, id) : null;
    const list = [];
    for (const [rid, st] of all) if (!ids || ids.has(rid)) list.push(st);
    return sumStats(list);
  }

  /** Order of racks across the plan, for sorting. */
  function rackOrder(project) {
    const m = new Map();
    allRacks(project).forEach((r, i) => m.set(r.rack.id, i));
    return m;
  }

  /** Devices ordered by rack (in plan order), then top to bottom, then side slots, then PDU slots. */
  function sortedDevices(project, rackId) {
    const order = rackOrder(project);
    const key = (d) => {
      const pos = d.loc.kind === 'u' ? d.loc.at : d.loc.kind === 'side' ? 1000 + d.loc.at : 2000 + d.loc.at;
      return (order.has(d.loc.rack) ? order.get(d.loc.rack) : 1e6) * 10000 + pos;
    };
    return project.devices.filter((d) => !rackId || d.loc.rack === rackId).sort((a, b) => key(a) - key(b));
  }

  /** Devices per rack id, in one pass. */
  function devicesByRack(project) {
    const m = new Map();
    for (const d of project.devices) {
      let list = m.get(d.loc.rack);
      if (!list) m.set(d.loc.rack, (list = []));
      list.push(d);
    }
    return m;
  }

  // ----------------------------------------------------------------- search

  function queryWords(query) {
    return String(query || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  /** Text a device can be found by: name, type, cluster in view `viewId` and its fields. */
  function deviceHaystack(project, d, viewId) {
    const t = typeOf(project, d.type);
    const c = clusterOf(project, d, viewId);
    return [d.name, t ? t.label : '', c ? c.name : '', d.serial, d.asset, d.ip, d.owner].join(' ').toLowerCase();
  }

  /** Predicate for devices matching `query` (every word must occur; clusters of view `viewId`), or null for an empty query. */
  function deviceMatcher(project, query, viewId) {
    const words = queryWords(query);
    if (!words.length) return null;
    return (d) => {
      const text = deviceHaystack(project, d, viewId);
      return words.every((w) => text.includes(w));
    };
  }

  /**
   * Finds floors, rows, racks and devices whose names (and, for devices, type,
   * cluster, serial number, asset tag, IP address or owner) contain every word
   * of `query` (clusters of view `viewId`), and the clusters of the other
   * views whose names do. Each group is capped at `limit`; `counts` has the
   * full numbers.
   */
  function search(project, query, limit, viewId) {
    const words = queryWords(query);
    const out = { floors: [], rows: [], racks: [], devices: [], clusters: [], counts: { floors: 0, rows: 0, racks: 0, devices: 0, clusters: 0 } };
    if (!words.length) return out;
    const max = limit || 8;
    const hit = (text) => words.every((w) => text.includes(w));
    const push = (group, item) => {
      out.counts[group]++;
      if (out[group].length < (group === 'devices' ? max * 4 : max)) out[group].push(item);
    };
    project.floors.forEach((floor) => {
      if (hit(floor.name.toLowerCase())) push('floors', { kind: 'floor', id: floor.id, name: floor.name, detail: plural(floor.rows.length, 'row') });
      floor.rows.forEach((row) => {
        if (hit(`${row.name} ${floor.name}`.toLowerCase())) push('rows', { kind: 'row', id: row.id, name: row.name, detail: `${floor.name} · ${plural(row.racks.length, 'rack')}` });
        row.racks.forEach((rack) => {
          if (hit(rack.name.toLowerCase())) push('racks', { kind: 'rack', id: rack.id, name: rack.name, detail: `${floor.name} · ${row.name}` });
        });
      });
    });
    const match = deviceMatcher(project, query, viewId);
    for (const d of sortedDevices(project)) {
      if (!match(d)) continue;
      const pos = locateRack(project, d.loc.rack);
      push('devices', { kind: 'device', id: d.id, name: d.name, detail: `${pos.floor.name} · ${pos.row.name} · ${formatDeviceLoc(project, d)}` });
    }
    // Clusters of the other views, to show the view they are in.
    const shown = viewOf(project, viewId);
    for (const v of project.views) {
      if (v === shown) continue;
      for (const c of v.clusters) {
        if (!hit(c.name.toLowerCase())) continue;
        const n = project.devices.filter((d) => d.groups && d.groups[v.id] === c.id).length;
        push('clusters', { kind: 'cluster', id: c.id, view: v.id, name: c.name, detail: `Cluster in view ${v.name} · ${plural(n, 'device')}` });
      }
    }
    return out;
  }

  return {
    SCHEMA_VERSION,
    LIMITS,
    NAME_MAX,
    FIELD_MAX,
    NOTES_MAX,
    RACK_UNITS,
    SIDE_SLOTS,
    DEFAULT_RACKS,
    MOUNT_KINDS,
    FACES,
    DEFAULT_DEVICE_TYPES,
    DEFAULT_RACK_TYPES,
    TYPE_TEMPLATES,
    RESERVED,
    FIELDS,
    CLUSTER_COLORS,
    COLOR_NEAR,
    CONNECTORS,
    MEDIA,
    DEFAULT_CABLE_TYPES,
    DEFAULT_TRANSCEIVERS,
    DEFAULT_ROW_PITCH_M,
    DEFAULT_VIEW_NAME,
    PDU_SIDES,
    DEFAULT_PDU_SLOTS,
    PDU_SLOT_UNITS,
    PHASES,
    METERING,
    POWER_CONNECTORS,
    DEFAULT_CORD_TYPES,
    DEFAULT_POWER_SETTINGS,
    DEFAULT_INLETS,
    GRID_COLORS,
    CORD_LABEL,
    rackPduSlots,
    isPduType,
    isPdu,
    powerGridById,
    cordTypeById,
    gridOf,
    powerSettings,
    powerConnectorById,
    powerConnectorId,
    powerConnectorLabel,
    cleanInlets,
    cleanOutlets,
    powerGroupsProblem,
    expandInlets,
    expandOutlets,
    formatOutletList,
    parseOutletList,
    cleanPdu,
    pduProblem,
    outletGroups,
    groupOutlets,
    cleanPduSlots,
    cleanCordType,
    cleanPowerGrid,
    cleanPowerSettings,
    nextGridColor,
    nextGridName,
    formatPduSlot,
    cleanCordEnd,
    cordContext,
    claimCord,
    cordProblem,
    pruneCords,
    cordsOf,
    cordsBrokenBy,
    nextCordLabel,
    copyCords,
    pduNameFor,
    gridForSlot,
    fillPduSlots,
    fillableRacks,
    makeVerticalPdu,
    typeMoves,
    movePortRefs,
    clone,
    str,
    plural,
    pluralName,
    slug,
    clampInt,
    clampNum,
    letters,
    uid,
    nextId,
    addFirstFloor,
    nameTaken,
    uniqueLabel,
    structureIds,
    normalizeHex,
    colorDistance,
    typeOf,
    placeableTypes,
    rackTypeById,
    rackTypeOf,
    rackUnits,
    rackSideSlots,
    maxSideSlots,
    viewById,
    viewOf,
    clustersOf,
    clusterById,
    viewOfCluster,
    clusterIdOf,
    clusterOf,
    setClusterOf,
    deviceById,
    floorById,
    rowById,
    rackById,
    allRows,
    allRacks,
    locateRow,
    locateRack,
    heightOf,
    deviceHeight,
    deviceSpan,
    powerOf,
    weightOf,
    rackTrayM,
    rackSlackM,
    deviceSlackM,
    cableTypeById,
    transceiverById,
    networkById,
    connectorById,
    connectorId,
    plugFits,
    cleanPortGroup,
    cleanPorts,
    portsProblem,
    groupNames,
    expandPorts,
    portsSide,
    mountsReversed,
    portPattern,
    parsePortPattern,
    portPatternProblem,
    cleanDeviceType,
    cleanRackType,
    mediaConnectors,
    cleanCableType,
    cleanTransceiver,
    cleanNetwork,
    defaultFirstLabel,
    nextNetworkColor,
    formatTypeSpec,
    addDeviceType,
    updateDeviceType,
    deleteDeviceType,
    moveDeviceType,
    moveRackType,
    addRackType,
    updateRackType,
    rackTypeUse,
    deleteRackType,
    setRackType,
    defaultRackName,
    nextRackName,
    nextFloorName,
    nextRowName,
    newProjectShell,
    createEmptyProject,
    createExampleProject,
    copyLayout,
    isPristineExample,
    insertFloor,
    renameFloor,
    renameRow,
    renameRack,
    insertRow,
    addFloor,
    addRow,
    addRack,
    removeDevicesIn,
    removeRack,
    moveRack,
    renumberRacks,
    setRowRackCount,
    devicesBeyond,
    removeRow,
    moveRow,
    removeFloor,
    moveFloor,
    rackIdsWithin,
    devicesWithin,
    formatSpan,
    rackGrid,
    canPlace,
    planPositions,
    planSpread,
    planSideSlots,
    validLocs,
    nudgeTarget,
    nearestLoc,
    firstFreeLoc,
    prefersSideSlot,
    canMoveAll,
    canAddAll,
    shiftMoves,
    groupNudge,
    copyTargets,
    copiesAt,
    duplicateRack,
    duplicateRow,
    duplicateFloor,
    layoutProblem,
    formatPosition,
    formatLoc,
    formatDeviceLoc,
    formatWhere,
    parseSerial,
    nameSequence,
    nextInSeries,
    takenNames,
    suggestPlacement,
    suggestName,
    nameInRack,
    namesAt,
    nextFreeName,
    nextClusterColor,
    nextClusterName,
    addCluster,
    updateCluster,
    removeCluster,
    nextViewName,
    copyViewName,
    addView,
    renameView,
    removeView,
    moveView,
    newDevice,
    setDeviceText,
    repeatedFields,
    cableEnds,
    legsOf,
    cleanCableEnd,
    cableContext,
    claimPorts,
    cableProblem,
    pruneCables,
    labeler,
    labelSeed,
    continueLabel,
    nextLabelAfter,
    nextCableLabel,
    copyCables,
    portMoves,
    forEachPortRef,
    remapPorts,
    setDeviceType,
    statsByRack,
    rackStats,
    overBudgetWith,
    sumStats,
    statsWithin,
    sortedDevices,
    devicesByRack,
    queryWords,
    deviceMatcher,
    search,
  };
});
