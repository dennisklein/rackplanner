/*
 * Rackplanner cabling: prototype of the proposed data model (see README.md
 * in this folder). Not loaded by the app; the mockups use it to put real
 * ports, cables, length estimates and checks into the screenshots.
 *
 * Pure functions without DOM access, like js/model.js. Additions to a plan:
 *
 *   deviceTypes[].ports: [{ name, first?, count?, connector, speedGbps, side: 'front'|'rear', passThrough? }]
 *   networks:   [{ id, name, color }]
 *   cableTypes: [{ id, name, media, connector, maxM, lengthsM: [m] }]
 *   cables:     [{ id, a: { device, port, side? }, b: { device, port, side? },
 *                  type: id|null (null = picked by connectors and length),
 *                  network: id|null, lengthM: null|m (null = estimated), label, notes }]
 *   cabling:    { rackWidthM, rowPitchM, slackPct }
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../js/model.js'));
  else (root.RP = root.RP || {}).cabling = factory(root.RP.model);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  /** Connectors: `family` decides which cables fit, `speedGbps` is the usual top speed. */
  const CONNECTORS = {
    rj45: { label: 'RJ45', family: 'rj45', speedGbps: 10 },
    'sfp+': { label: 'SFP+', family: 'sfp', speedGbps: 10 },
    sfp28: { label: 'SFP28', family: 'sfp', speedGbps: 25 },
    sfp56: { label: 'SFP56', family: 'sfp', speedGbps: 50 },
    'qsfp+': { label: 'QSFP+', family: 'qsfp', speedGbps: 40 },
    qsfp28: { label: 'QSFP28', family: 'qsfp', speedGbps: 100 },
    qsfp56: { label: 'QSFP56', family: 'qsfp', speedGbps: 200 },
    qsfp112: { label: 'QSFP112', family: 'qsfp', speedGbps: 400 },
    'qsfp-dd': { label: 'QSFP-DD', family: 'qsfp', speedGbps: 400 },
    osfp: { label: 'OSFP', family: 'osfp', speedGbps: 800 },
    lc: { label: 'LC duplex', family: 'lc', speedGbps: 100 },
    mpo: { label: 'MPO-12', family: 'mpo', speedGbps: 400 },
    'sas-hd': { label: 'Mini-SAS HD', family: 'sas', speedGbps: 12 },
  };

  const MEDIA = {
    cat6a: { label: 'Cat6a copper', families: ['rj45'] },
    dac: { label: 'Direct attach copper', families: ['sfp', 'qsfp', 'osfp'] },
    aoc: { label: 'Active optical', families: ['sfp', 'qsfp', 'osfp'] },
    om4: { label: 'Multimode fiber OM4', families: ['lc', 'mpo'] },
    os2: { label: 'Single-mode fiber OS2', families: ['lc', 'mpo'] },
    sas: { label: 'SAS copper', families: ['sas'] },
  };

  const DEFAULT_CABLE_TYPES = [
    { id: 'cat6a', name: 'Cat6a patch cord', media: 'cat6a', connector: 'rj45', maxM: 100, lengthsM: [0.5, 1, 1.5, 2, 3, 5, 7, 10, 15, 20] },
    { id: 'dac-sfp28', name: 'SFP28 DAC', media: 'dac', connector: 'sfp28', maxM: 5, lengthsM: [0.5, 1, 1.5, 2, 3, 5] },
    { id: 'dac-qsfp56', name: 'QSFP56 DAC', media: 'dac', connector: 'qsfp56', maxM: 3, lengthsM: [0.5, 1, 1.5, 2, 2.5, 3] },
    { id: 'aoc-qsfp56', name: 'QSFP56 AOC', media: 'aoc', connector: 'qsfp56', maxM: 100, lengthsM: [3, 5, 7, 10, 15, 20, 30] },
    { id: 'sas-hd', name: 'Mini-SAS HD cable', media: 'sas', connector: 'sas-hd', maxM: 4, lengthsM: [0.5, 1, 2, 3, 4] },
  ];

  const DEFAULT_RULES = { rackWidthM: 0.6, rowPitchM: 3.0, slackPct: 10 };
  const UNIT_M = 0.04445;
  const TO_MANAGER_M = 0.25; // from a port to the rack's cable manager, each end
  const TRAY_M = 0.3; // from the top of a rack up into the tray, each end

  const conn = (id) => CONNECTORS[id] || { label: id, family: id, speedGbps: 0 };
  const fmtSpeed = (g) => (!g ? '' : g < 1 ? `${Math.round(g * 1000)} Mb/s` : `${g} Gb/s`);
  const shortSpeed = (g) => (!g ? '' : g < 1 ? `${Math.round(g * 1000)}M` : `${g}G`);
  const fmtM = (m) => (m == null ? '–' : `${Number.isInteger(m) ? m : m.toFixed(1)} m`);

  // ------------------------------------------------------------------ ports

  /** Names of a port group: eth0; swp1 … swp48; 1 … 24. */
  function groupNames(g) {
    if (g.count == null && g.first == null) return [g.name];
    const first = g.first == null ? 1 : g.first;
    return Array.from({ length: g.count || 1 }, (_, i) => `${g.name}${first + i}`);
  }

  /** Every port of a device type, in catalog order. */
  function expandPorts(type) {
    const out = [];
    (type && type.ports ? type.ports : []).forEach((g, gi) =>
      groupNames(g).forEach((name, index) =>
        out.push({ name, group: gi, index, count: groupNames(g).length, connector: g.connector, speedGbps: g.speedGbps, side: g.side || 'rear', passThrough: !!g.passThrough })
      )
    );
    return out;
  }

  function portsOf(project, device) {
    return expandPorts(M.typeOf(project, device.type));
  }

  function portOf(project, end) {
    const d = M.deviceById(project, end.device);
    return d ? portsOf(project, d).find((p) => p.name === end.port) || null : null;
  }

  /** Short text for a port group: "swp1–48 · 48 × RJ45 1G". */
  function groupSpec(g) {
    const names = groupNames(g);
    const range = names.length > 1 ? `${names[0]}–${names[names.length - 1].slice(g.name.length)}` : names[0];
    return `${range} · ${names.length > 1 ? names.length + ' × ' : ''}${conn(g.connector).label} ${shortSpeed(g.speedGbps)}`;
  }

  const endKey = (e) => `${e.device}|${e.port}|${e.side || ''}`;

  /** Map from "device|port|side" to the cable plugged in there. */
  function cableIndex(project) {
    const map = new Map();
    for (const c of project.cables) {
      map.set(endKey(c.a), c);
      map.set(endKey(c.b), c);
    }
    return map;
  }

  /** The cable at a port, and the other end. */
  function peerOf(project, deviceId, port, side, index) {
    const idx = index || cableIndex(project);
    const c = idx.get(`${deviceId}|${port}|${side || ''}`);
    if (!c) return null;
    const mine = c.a.device === deviceId && c.a.port === port && (c.a.side || '') === (side || '') ? 'a' : 'b';
    return { cable: c, far: mine === 'a' ? c.b : c.a, near: mine === 'a' ? c.a : c.b };
  }

  /**
   * The whole run from one end of `cable`: cables joined through the front
   * and rear of pass-through ports (patch panels). Returns [{ cable, from, to }].
   */
  function trace(project, cable) {
    const idx = cableIndex(project);
    // Walk back to the first segment, then forward.
    let start = { cable, from: cable.a };
    for (let guard = 0; guard < 16; guard++) {
      const p = portOf(project, start.from);
      if (!p || !p.passThrough) break;
      const other = peerOf(project, start.from.device, start.from.port, start.from.side === 'rear' ? 'front' : 'rear', idx);
      if (!other) break;
      start = { cable: other.cable, from: other.far };
    }
    const out = [];
    let seg = start;
    for (let guard = 0; guard < 16; guard++) {
      const to = seg.cable.a === seg.from || endKey(seg.cable.a) === endKey(seg.from) ? seg.cable.b : seg.cable.a;
      out.push({ cable: seg.cable, from: seg.from, to });
      const p = portOf(project, to);
      if (!p || !p.passThrough) break;
      const next = peerOf(project, to.device, to.port, to.side === 'rear' ? 'front' : 'rear', idx);
      if (!next) break;
      seg = { cable: next.cable, from: next.near };
    }
    return out;
  }

  // ----------------------------------------------------------------- length

  /** Depth of a device's ports below the top of its rack, in meters. */
  function portDepth(project, d) {
    if (d.loc.kind === 'side') {
      const units = M.rackUnits(project, d.loc.rack);
      const slots = Math.max(1, M.rackSideSlots(project, d.loc.rack));
      return ((d.loc.at + 0.5) * units * UNIT_M) / slots;
    }
    return (d.loc.at - 1 + M.deviceHeight(project, d) / 2) * UNIT_M;
  }

  /**
   * Estimated length of a cable from where its ends are mounted: down the
   * rack's cable manager, or up into the tray, along the row (and across
   * rows) and down again, plus slack. Null across floors.
   */
  function estimate(project, cable) {
    const da = M.deviceById(project, cable.a.device);
    const db = M.deviceById(project, cable.b.device);
    if (!da || !db) return null;
    const ra = M.locateRack(project, da.loc.rack);
    const rb = M.locateRack(project, db.loc.rack);
    const rules = Object.assign({}, DEFAULT_RULES, project.cabling);
    if (ra.floor !== rb.floor) return null;
    const ya = portDepth(project, da);
    const yb = portDepth(project, db);
    let run;
    let how;
    if (ra.rack === rb.rack) {
      run = Math.abs(ya - yb) + 2 * TO_MANAGER_M;
      how = 'rack';
    } else {
      run = ya + yb + 2 * (TRAY_M + TO_MANAGER_M) + Math.abs(ra.index - rb.index) * rules.rackWidthM + Math.abs(ra.rowIndex - rb.rowIndex) * rules.rowPitchM;
      how = ra.row === rb.row ? 'row' : 'floor';
    }
    return { m: run * (1 + rules.slackPct / 100), how };
  }

  function cableTypeById(project, id) {
    return project.cableTypes.find((t) => t.id === id) || null;
  }

  /** Cable type for a cable: its own, or the first that joins both connectors and is long enough. */
  function resolveType(project, cable, meters) {
    if (cable.type) return cableTypeById(project, cable.type);
    const pa = portOf(project, cable.a);
    const pb = portOf(project, cable.b);
    if (!pa || !pb) return null;
    const fa = conn(pa.connector).family;
    const fits = project.cableTypes.filter((t) => conn(t.connector).family === fa && fa === conn(pb.connector).family);
    const exact = fits.filter((t) => t.connector === pa.connector || t.connector === pb.connector);
    const pool = exact.length ? exact : fits;
    return pool.find((t) => meters == null || meters <= t.maxM) || pool[pool.length - 1] || null;
  }

  /** The stock length to order: the next one up from the estimate. */
  function stockLength(type, meters) {
    if (!type || meters == null) return null;
    return type.lengthsM.find((l) => l >= meters - 1e-9) || Math.ceil(meters);
  }

  /**
   * Everything known about a cable: ends, estimate, chosen type and length,
   * speed, and problems [{ level: 'warn'|'info', text }].
   */
  function describe(project, cable) {
    const pa = portOf(project, cable.a);
    const pb = portOf(project, cable.b);
    const est = estimate(project, cable);
    const raw = cable.lengthM != null ? cable.lengthM : est ? est.m : null;
    const type = resolveType(project, cable, raw);
    const lengthM = cable.lengthM != null ? cable.lengthM : stockLength(type, raw);
    const issues = [];
    const speed = pa && pb ? Math.min(pa.speedGbps, pb.speedGbps) : 0;
    if (pa && pb && conn(pa.connector).family !== conn(pb.connector).family) {
      issues.push({ level: 'warn', text: `${conn(pa.connector).label} does not plug into ${conn(pb.connector).label}`, short: 'Plugs differ' });
    } else if (pa && pb && !pa.passThrough && !pb.passThrough && pa.speedGbps !== pb.speedGbps) {
      const slow = pa.speedGbps < pb.speedGbps ? cable.a : cable.b;
      const dev = M.deviceById(project, slow.device);
      issues.push({ level: 'info', text: `Runs at ${fmtSpeed(speed)}: ${dev.name} ${slow.port} is the slower end`, short: `Runs at ${shortSpeed(speed)}` });
    }
    if (!type) issues.push({ level: 'warn', text: 'No cable type in the catalog fits both ends', short: 'No cable type' });
    else if (raw != null && raw > type.maxM) issues.push({ level: 'warn', text: `Needs ${raw.toFixed(1)} m: ${type.name} reaches ${fmtM(type.maxM)}`, short: `Too long for ${type.media.toUpperCase()}` });
    if (!est && cable.lengthM == null) issues.push({ level: 'warn', text: 'The ends are on different floors: enter the length', short: 'Enter length' });
    return { cable, pa, pb, est, raw, type, lengthM, auto: cable.lengthM == null, speed, issues };
  }

  /** Cables to order: [{ type, lengthM, count }] by catalog order and length. */
  function billOfMaterials(project) {
    const counts = new Map();
    for (const c of project.cables) {
      const d = describe(project, c);
      if (!d.type || d.lengthM == null) continue;
      const k = `${d.type.id}|${d.lengthM}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const out = [];
    for (const t of project.cableTypes) {
      for (const l of t.lengthsM.concat([])) {
        const n = counts.get(`${t.id}|${l}`);
        if (n) out.push({ type: t, lengthM: l, count: n });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- example

  const EXAMPLE_PORTS = {
    'switch-rj45': [
      { name: 'swp', first: 1, count: 48, connector: 'rj45', speedGbps: 1, side: 'rear' },
      { name: 'swp', first: 49, count: 4, connector: 'sfp+', speedGbps: 10, side: 'rear' },
    ],
    'switch-qsfp': [{ name: 'p', first: 1, count: 24, connector: 'qsfp56', speedGbps: 200, side: 'rear' }],
    'compute-node': [
      { name: 'bmc', connector: 'rj45', speedGbps: 1, side: 'rear' },
      { name: 'eth0', connector: 'rj45', speedGbps: 1, side: 'rear' },
      { name: 'ib0', connector: 'qsfp56', speedGbps: 200, side: 'rear' },
    ],
    'storage-node': [
      { name: 'bmc', connector: 'rj45', speedGbps: 1, side: 'rear' },
      { name: 'eth0', connector: 'rj45', speedGbps: 1, side: 'rear' },
      { name: 'eth1', connector: 'sfp28', speedGbps: 25, side: 'rear' },
      { name: 'ib', first: 0, count: 2, connector: 'qsfp56', speedGbps: 200, side: 'rear' },
      { name: 'sas', first: 0, count: 4, connector: 'sas-hd', speedGbps: 12, side: 'rear' },
    ],
    'storage-enclosure': [
      { name: 'mgmt', connector: 'rj45', speedGbps: 1, side: 'rear' },
      { name: 'sas-a', connector: 'sas-hd', speedGbps: 12, side: 'rear' },
      { name: 'sas-b', connector: 'sas-hd', speedGbps: 12, side: 'rear' },
    ],
    'gpu-server': [
      { name: 'bmc', connector: 'rj45', speedGbps: 1, side: 'rear' },
      { name: 'eth0', connector: 'rj45', speedGbps: 1, side: 'rear' },
      { name: 'eth', first: 1, count: 2, connector: 'sfp28', speedGbps: 25, side: 'rear' },
      { name: 'ib', first: 0, count: 4, connector: 'qsfp56', speedGbps: 200, side: 'rear' },
    ],
    'patch-panel': [{ name: '', first: 1, count: 24, connector: 'rj45', speedGbps: 10, side: 'front', passThrough: true }],
    pdu: [{ name: 'mgmt', connector: 'rj45', speedGbps: 1, side: 'rear' }],
  };

  const EXAMPLE_NETWORKS = [
    { id: 'n-mgmt', name: 'Management', color: '#3aa655', prefix: 'MGT' },
    { id: 'n-bmc', name: 'BMC', color: '#d9a21b', prefix: 'BMC' },
    { id: 'n-ib', name: 'InfiniBand', color: '#2f6fdb', prefix: 'IB' },
    { id: 'n-eth', name: 'Storage 25G', color: '#1f9fc9', prefix: 'ETH' },
    { id: 'n-sas', name: 'SAS', color: '#8a5cd6', prefix: 'SAS' },
  ];

  /** Adds ports, networks, cable types and the example's cables to `project` (the example plan). */
  function addExampleCabling(project) {
    for (const t of project.deviceTypes) if (EXAMPLE_PORTS[t.id]) t.ports = M.clone(EXAMPLE_PORTS[t.id]);
    project.networks = EXAMPLE_NETWORKS.map(({ id, name, color }) => ({ id, name, color }));
    project.cableTypes = M.clone(DEFAULT_CABLE_TYPES);
    project.cabling = Object.assign({}, DEFAULT_RULES);
    project.cables = [];
    const byName = new Map(project.devices.map((d) => [d.name, d]));
    const numbers = new Map();
    const link = (net, an, ap, bn, bp, extra) => {
      const a = byName.get(an);
      const b = byName.get(bn);
      if (!a || !b) throw new Error(`No device ${a ? bn : an}`);
      const prefix = EXAMPLE_NETWORKS.find((n) => n.id === net).prefix;
      const n = (numbers.get(prefix) || 0) + 1;
      numbers.set(prefix, n);
      const ends = Object.assign({ a: { device: a.id, port: ap }, b: { device: b.id, port: bp } }, extra && extra.ends);
      project.cables.push(
        Object.assign(
          { id: `cb-${project.cables.length + 1}`, a: ends.a, b: ends.b, type: null, network: net, lengthM: null, label: `${prefix}-${String(n).padStart(4, '0')}`, notes: '' },
          extra && extra.props
        )
      );
    };
    const n3 = (i) => String(i).padStart(3, '0');

    // Rack A01: Kestrel compute nodes.
    for (let i = 1; i <= 12; i++) {
      link('n-mgmt', `cn-${n3(i)}`, 'eth0', 'sw-mgmt-a01', `swp${i}`);
      link('n-bmc', `cn-${n3(i)}`, 'bmc', 'sw-bmc-a01', `swp${i}`);
      link('n-ib', `cn-${n3(i)}`, 'ib0', 'ib-leaf-a01', `p${i}`);
    }
    // Rack A02: Osprey GPU nodes and Ceph.
    for (let i = 1; i <= 8; i++) {
      link('n-mgmt', `gpu-${n3(i)}`, 'eth0', 'sw-mgmt-a02', `swp${i}`);
      link('n-bmc', `gpu-${n3(i)}`, 'bmc', 'sw-bmc-a01', `swp${12 + i}`);
      link('n-ib', `gpu-${n3(i)}`, 'ib0', 'ib-leaf-a02', `p${i}`);
    }
    for (let i = 1; i <= 3; i++) {
      link('n-mgmt', `ceph-0${i}`, 'eth0', 'sw-mgmt-a02', `swp${8 + i}`);
      link('n-eth', `ceph-0${i}`, 'eth1', 'sw-mgmt-a02', `swp${48 + i}`);
      link('n-bmc', `ceph-0${i}`, 'bmc', 'sw-bmc-a03', `swp${i}`);
      link('n-ib', `ceph-0${i}`, 'ib0', 'ib-leaf-a02', `p${8 + i}`);
      link('n-ib', `ceph-0${i}`, 'ib1', 'ib-leaf-a03', `p${8 + i}`, i === 3 ? { props: { type: 'dac-qsfp56' } } : null);
    }
    // Rack A03: Lustre servers, dual-attached to every enclosure.
    for (let i = 1; i <= 2; i++) {
      link('n-mgmt', `oss-0${i}`, 'eth0', 'sw-mgmt-a03', `swp${i}`);
      link('n-bmc', `oss-0${i}`, 'bmc', 'sw-bmc-a03', `swp${3 + i}`);
      link('n-ib', `oss-0${i}`, 'ib0', 'ib-leaf-a03', `p${2 * i - 1}`);
      link('n-ib', `oss-0${i}`, 'ib1', 'ib-leaf-a03', `p${2 * i}`);
      for (let j = 1; j <= 4; j++) link('n-sas', `oss-0${i}`, `sas${j - 1}`, `jbod-0${j}`, i === 1 ? 'sas-a' : 'sas-b');
    }
    for (let j = 1; j <= 4; j++) link('n-mgmt', `jbod-0${j}`, 'mgmt', 'sw-mgmt-a03', `swp${2 + j}`);
    // Row A uplinks: BMC switches into management, management through the patch panel, leaves to the core.
    link('n-bmc', 'sw-bmc-a01', 'swp48', 'sw-mgmt-a01', 'swp48');
    link('n-bmc', 'sw-bmc-a03', 'swp48', 'sw-mgmt-a03', 'swp48');
    for (let k = 1; k <= 3; k++) {
      link('n-mgmt', `sw-mgmt-a0${k}`, 'swp47', 'pp-b01-1', String(k), { ends: { b: { device: byName.get('pp-b01-1').id, port: String(k), side: 'rear' } } });
      link('n-mgmt', 'pp-b01-1', String(k), 'sw-mgmt-b01', `swp${40 + k}`, { ends: { a: { device: byName.get('pp-b01-1').id, port: String(k), side: 'front' } } });
      link('n-ib', `ib-leaf-a0${k}`, 'p21', 'core-sw-01', `p${2 * k - 1}`);
      link('n-ib', `ib-leaf-a0${k}`, 'p22', 'core-sw-01', `p${2 * k}`);
      link('n-ib', `ib-leaf-a0${k}`, 'p23', 'core-sw-02', `p${2 * k - 1}`);
      link('n-ib', `ib-leaf-a0${k}`, 'p24', 'core-sw-02', `p${2 * k}`);
    }
    // Row B: Heron GPU servers.
    for (let i = 1; i <= 6; i++) {
      const name = `gpu-srv-0${i}`;
      const leaf = i <= 3 ? 'ib-leaf-b02' : 'ib-leaf-b03';
      for (let k = 0; k < 4; k++) link('n-ib', name, `ib${k}`, leaf, `p${((i - 1) % 3) * 4 + k + 1}`);
      link('n-mgmt', name, 'eth0', 'sw-mgmt-b01', `swp${i}`);
      link('n-bmc', name, 'bmc', 'sw-mgmt-b01', `swp${12 + i}`);
    }
    for (const [k, leaf] of [[7, 'ib-leaf-b02'], [8, 'ib-leaf-b03']]) {
      link('n-ib', leaf, 'p23', 'core-sw-01', `p${k}`);
      link('n-ib', leaf, 'p24', 'core-sw-02', `p${k}`);
    }
    return project;
  }

  return {
    CONNECTORS,
    MEDIA,
    DEFAULT_CABLE_TYPES,
    DEFAULT_RULES,
    conn,
    fmtSpeed,
    shortSpeed,
    fmtM,
    groupNames,
    groupSpec,
    expandPorts,
    portsOf,
    portOf,
    cableIndex,
    peerOf,
    trace,
    estimate,
    resolveType,
    stockLength,
    describe,
    billOfMaterials,
    addExampleCabling,
  };
});
