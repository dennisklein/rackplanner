/*
 * Rackplanner: data model and placement rules.
 *
 * Pure functions without DOM access, shared by the browser app and the Node
 * tests. A project looks like this:
 *
 *   {
 *     version: 2,
 *     name: 'Untitled rack plan',
 *     racks:    [{ id: 'r1', name: 'Rack A01' }, ...],          // 1 to 5
 *     clusters: [{ id, name, color: '#rrggbb' }],
 *     devices:  [{ id, type, name, cluster: id|null, notes,
 *                  loc: { rack: 'r1', kind: 'u', at: 21 } }],   // at = lowest U
 *     meta: {}
 *   }
 *
 * A device either sits in the rack's 47 height units (kind 'u', `at` is the
 * lowest-numbered unit it occupies; units are numbered from the top, so U1 is
 * the topmost unit and U47 the bottom one) or in one of the two vertical side
 * slots (kind 'side', `at` is 0 for the upper and 1 for the lower slot).
 * Side slots take 1U devices only.
 *
 * Version 1 plans numbered units from the bottom; normalizeProject converts
 * them so their layout stays the same.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.RP = root.RP || {}).model = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const RACK_UNITS = 47;
  const SIDE_SLOTS = 2;
  const MIN_RACKS = 1;
  const MAX_RACKS = 5;
  const DEFAULT_RACKS = 3;

  const DEVICE_TYPES = [
    { id: 'switch-rj45', label: '48-port switch', tag: 'SWITCH', spec: '1U · 48 × RJ45', height: 1, defaultName: 'sw-rj45-01' },
    { id: 'switch-qsfp', label: '24-port switch', tag: 'SWITCH', spec: '1U · 24 × QSFP', height: 1, defaultName: 'sw-qsfp-01' },
    { id: 'compute-node', label: 'Compute node', tag: 'COMPUTE', spec: '2U · server', height: 2, defaultName: 'cn-001' },
    { id: 'storage-node', label: 'Storage node', tag: 'STORAGE', spec: '4U · server, 24 bays', height: 4, defaultName: 'sn-01' },
    { id: 'storage-enclosure', label: 'Storage enclosure', tag: 'JBOD', spec: '4U · JBOD, 2 drawers', height: 4, defaultName: 'jbod-01' },
  ];
  const TYPE_BY_ID = Object.fromEntries(DEVICE_TYPES.map((t) => [t.id, t]));

  // Ordered so that the first few clusters get clearly distinct hues.
  const CLUSTER_COLORS = [
    '#2f6fdb', // cobalt
    '#e56b1f', // orange
    '#0f9d8a', // teal
    '#8a5cd6', // violet
    '#d9a21b', // amber
    '#d64545', // red
    '#3aa655', // green
    '#1f9fc9', // cyan
    '#d94c8a', // rose
    '#5b62d6', // indigo
    '#8aa82c', // olive
    '#9a6b3f', // brown
  ];

  // ---------------------------------------------------------------- lookups

  function typeById(id) {
    return TYPE_BY_ID[id] || null;
  }
  function rackById(project, id) {
    return project.racks.find((r) => r.id === id) || null;
  }
  function rackIndex(project, id) {
    return project.racks.findIndex((r) => r.id === id);
  }
  function clusterById(project, id) {
    return id ? project.clusters.find((c) => c.id === id) || null : null;
  }
  function deviceById(project, id) {
    return project.devices.find((d) => d.id === id) || null;
  }

  let uidCounter = 0;
  function uid(prefix) {
    uidCounter = (uidCounter + 1) % 1679616;
    return `${prefix}-${Date.now().toString(36)}${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  function normalizeHex(value) {
    if (typeof value !== 'string') return null;
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    if (!m) return null;
    let hex = m[1].toLowerCase();
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return '#' + hex;
  }

  // --------------------------------------------------------------- projects

  function defaultRackName(index) {
    return `Rack A${String(index + 1).padStart(2, '0')}`;
  }

  function clampRackCount(n) {
    const v = Math.round(Number(n));
    return Number.isFinite(v) ? Math.max(MIN_RACKS, Math.min(MAX_RACKS, v)) : DEFAULT_RACKS;
  }

  function createEmptyProject(rackCount) {
    const racks = Array.from({ length: clampRackCount(rackCount || DEFAULT_RACKS) }, (_, i) => ({
      id: `r${i + 1}`,
      name: defaultRackName(i),
    }));
    return { version: SCHEMA_VERSION, name: 'Untitled rack plan', racks, clusters: [], devices: [], meta: {} };
  }

  /**
   * Adds racks on the right or removes them from the right until the project
   * has `n` racks (clamped to 1–5). Devices in removed racks are removed too.
   */
  function setRackCount(project, n) {
    const count = clampRackCount(n);
    while (project.racks.length < count) {
      const used = new Set(project.racks.map((r) => r.id));
      let k = project.racks.length + 1;
      while (used.has(`r${k}`)) k++;
      project.racks.push({ id: `r${k}`, name: defaultRackName(project.racks.length) });
    }
    if (project.racks.length > count) {
      const removed = new Set(project.racks.slice(count).map((r) => r.id));
      project.racks = project.racks.slice(0, count);
      project.devices = project.devices.filter((d) => !removed.has(d.loc.rack));
    }
    return project;
  }

  /** Devices that setRackCount(project, n) would remove. */
  function devicesBeyond(project, n) {
    const keep = new Set(project.racks.slice(0, clampRackCount(n)).map((r) => r.id));
    return project.devices.filter((d) => !keep.has(d.loc.rack));
  }

  function createExampleProject() {
    const p = createEmptyProject();
    p.name = 'Hall 2, row A';
    p.meta.example = true;
    p.clusters = [
      { id: 'c-net', name: 'Core network', color: '#d9a21b' },
      { id: 'c-kestrel', name: 'Kestrel HPC', color: '#2f6fdb' },
      { id: 'c-osprey', name: 'Osprey GPU', color: '#e56b1f' },
      { id: 'c-ceph', name: 'Ceph object store', color: '#0f9d8a' },
      { id: 'c-lustre', name: 'Lustre scratch', color: '#8a5cd6' },
    ];
    let n = 0;
    const add = (type, name, cluster, rack, kind, at) =>
      p.devices.push({ id: `ex-${++n}`, type, name, cluster, notes: '', loc: { rack, kind, at } });

    // Every rack gets a management switch and a high-speed leaf on top.
    ['r1', 'r2', 'r3'].forEach((rack, i) => {
      add('switch-rj45', `sw-mgmt-a0${i + 1}`, 'c-net', rack, 'u', 1);
      add('switch-qsfp', `ib-leaf-a0${i + 1}`, 'c-net', rack, 'u', 2);
    });
    add('switch-rj45', 'sw-bmc-a01', 'c-net', 'r1', 'side', 0);
    add('switch-rj45', 'sw-bmc-a03', 'c-net', 'r3', 'side', 0);

    for (let i = 0; i < 12; i++) add('compute-node', `cn-${String(i + 1).padStart(3, '0')}`, 'c-kestrel', 'r1', 'u', 4 + i * 2);
    for (let i = 0; i < 8; i++) add('compute-node', `gpu-${String(i + 1).padStart(3, '0')}`, 'c-osprey', 'r2', 'u', 4 + i * 2);
    for (let i = 0; i < 3; i++) add('storage-node', `ceph-0${i + 1}`, 'c-ceph', 'r2', 'u', 24 + i * 4);
    add('storage-node', 'oss-01', 'c-lustre', 'r3', 'u', 4);
    add('storage-node', 'oss-02', 'c-lustre', 'r3', 'u', 8);
    for (let i = 0; i < 4; i++) add('storage-enclosure', `jbod-0${i + 1}`, 'c-lustre', 'r3', 'u', 12 + i * 4);
    return p;
  }

  // -------------------------------------------------------------- placement

  function formatSpan(bottom, top) {
    return bottom === top ? `U${bottom}` : `U${bottom}–${top}`;
  }

  function deviceSpan(device) {
    const h = typeById(device.type).height;
    return [device.loc.at, device.loc.at + h - 1];
  }

  /**
   * Checks whether a device of `typeId` fits at `loc`. Devices listed in
   * `ignore` (an id or array of ids) are treated as absent, which is how a
   * device is checked against its own new position when moving.
   */
  function canPlace(project, typeId, loc, ignore) {
    const skip = new Set([].concat(ignore || []));
    const type = typeById(typeId);
    if (!type) return { ok: false, reason: 'Unknown device type' };
    if (!loc || !rackById(project, loc.rack)) return { ok: false, reason: 'Drop it on a rack' };

    if (loc.kind === 'side') {
      if (!Number.isInteger(loc.at) || loc.at < 0 || loc.at >= SIDE_SLOTS) return { ok: false, reason: 'There is no such side slot' };
      if (type.height !== 1) return { ok: false, reason: 'Side slots take 1U devices only' };
      const other = project.devices.find(
        (d) => !skip.has(d.id) && d.loc.rack === loc.rack && d.loc.kind === 'side' && d.loc.at === loc.at
      );
      if (other) return { ok: false, reason: `Side slot V${loc.at + 1} holds ${other.name}`, conflict: other.id };
      return { ok: true };
    }

    if (loc.kind !== 'u') return { ok: false, reason: 'Unknown mounting position' };
    const bottom = loc.at;
    const top = loc.at + type.height - 1;
    if (!Number.isInteger(bottom) || bottom < 1 || top > RACK_UNITS) {
      return { ok: false, reason: `A ${type.height}U device must sit within U1–${RACK_UNITS}` };
    }
    for (const d of project.devices) {
      if (skip.has(d.id) || d.loc.rack !== loc.rack || d.loc.kind !== 'u') continue;
      const [b, t] = deviceSpan(d);
      if (b <= top && bottom <= t) return { ok: false, reason: `Overlaps ${d.name} at ${formatSpan(b, t)}`, conflict: d.id };
    }
    return { ok: true };
  }

  /**
   * Finds up to `count` free positions (lowest unit number of each device)
   * for devices of `typeId` in a rack, starting at `startU` and stacking
   * toward higher unit numbers (dir > 0, downward in the rack) or lower ones
   * (dir < 0, upward). Occupied units are skipped.
   */
  function planPositions(project, typeId, rackId, startU, count, dir, ignore) {
    const type = typeById(typeId);
    if (!type) return [];
    const h = type.height;
    const step = dir < 0 ? -1 : 1;
    const scratch = { racks: project.racks, clusters: [], devices: project.devices.slice() };
    const out = [];
    let u = startU;
    while (out.length < count && u >= 1 && u + h - 1 <= RACK_UNITS) {
      const loc = { rack: rackId, kind: 'u', at: u };
      if (canPlace(scratch, typeId, loc, ignore).ok) {
        out.push(u);
        scratch.devices.push({ id: `__plan-${out.length}`, type: typeId, name: '', loc });
        u += step * h;
      } else {
        u += step;
      }
    }
    return out;
  }

  /** All positions in a rack where a device of `typeId` fits, top to bottom, side slots first. */
  function validLocs(project, typeId, rackId, ignore) {
    const type = typeById(typeId);
    const out = [];
    if (!type) return out;
    if (type.height === 1) {
      for (let s = 0; s < SIDE_SLOTS; s++) {
        const loc = { rack: rackId, kind: 'side', at: s };
        if (canPlace(project, typeId, loc, ignore).ok) out.push(loc);
      }
    }
    for (let u = 1; u + type.height - 1 <= RACK_UNITS; u++) {
      const loc = { rack: rackId, kind: 'u', at: u };
      if (canPlace(project, typeId, loc, ignore).ok) out.push(loc);
    }
    return out;
  }

  /** Nearest free U position with a higher (dir > 0, further down) or lower (dir < 0, further up) number. */
  function nudgeTarget(project, device, dir) {
    if (device.loc.kind !== 'u') return null;
    const h = typeById(device.type).height;
    for (let u = device.loc.at + dir; u >= 1 && u + h - 1 <= RACK_UNITS; u += dir) {
      const loc = { rack: device.loc.rack, kind: 'u', at: u };
      if (canPlace(project, device.type, loc, device.id).ok) return loc;
    }
    return null;
  }

  /** Free position closest to `near` (a U number) in a rack, or null. */
  function nearestLoc(project, typeId, rackId, near, ignore, preferSide) {
    const locs = validLocs(project, typeId, rackId, ignore);
    if (!locs.length) return null;
    if (preferSide) {
      const side = locs.find((l) => l.kind === 'side');
      if (side) return side;
    }
    const inRack = locs.filter((l) => l.kind === 'u');
    if (!inRack.length) return locs[0];
    return inRack.reduce((best, l) => (Math.abs(l.at - near) < Math.abs(best.at - near) ? l : best));
  }

  function formatLoc(project, loc, typeId) {
    const rack = rackById(project, loc.rack);
    const rackName = rack ? rack.name : 'Unknown rack';
    if (loc.kind === 'side') return `${rackName} · side slot V${loc.at + 1}`;
    const h = typeById(typeId).height;
    return `${rackName} · ${formatSpan(loc.at, loc.at + h - 1)}`;
  }

  function formatPosition(loc, typeId) {
    if (loc.kind === 'side') return `V${loc.at + 1}`;
    return formatSpan(loc.at, loc.at + typeById(typeId).height - 1);
  }

  // ------------------------------------------------------------------ names

  function parseSerial(name) {
    const m = /^(.*?)(\d+)(\D*)$/.exec(name);
    return m ? { head: m[1], num: parseInt(m[2], 10), width: m[2].length, tail: m[3] } : null;
  }

  function formatSerial(s, n) {
    return s.head + String(n).padStart(s.width, '0') + s.tail;
  }

  /** `count` names counting up from `first` (cn-007 → cn-007, cn-008, …). */
  function nameSequence(first, count) {
    const name = String(first == null ? '' : first).trim();
    if (count <= 1) return [name];
    const s = parseSerial(name) || { head: name + '-', num: 1, width: 2, tail: '' };
    return Array.from({ length: count }, (_, i) => formatSerial(s, s.num + i));
  }

  /**
   * Next name in the series `seed` belongs to: one past the highest number
   * already used with the same prefix and suffix, leaving room for `count`
   * consecutive names. With `inclusive`, `seed` itself may be returned.
   */
  function nextInSeries(project, seed, count, inclusive) {
    const used = new Set(project.devices.map((d) => d.name));
    const s = parseSerial(seed) || { head: seed + '-', num: 1, width: 2, tail: '' };
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

  /**
   * Suggests name and cluster for new devices of `typeId` placed at `loc`.
   * The nearest device of the same type in the same rack is the reference
   * (dropping next to cn-012 of cluster Kestrel suggests cn-013, Kestrel);
   * otherwise the most recently added device of that type, otherwise the
   * type's default name. `cluster` is undefined when there is no reference.
   */
  function suggestPlacement(project, typeId, loc, count) {
    const type = typeById(typeId);
    const n = Math.max(1, count || 1);
    const same = project.devices.filter((d) => d.type === typeId);
    const pos = (l) => (l.kind === 'u' ? l.at : (l.at + 0.5) * (RACK_UNITS / SIDE_SLOTS));
    let ref = null;
    if (loc) {
      for (const d of same) {
        if (d.loc.rack !== loc.rack) continue;
        if (!ref || Math.abs(pos(d.loc) - pos(loc)) < Math.abs(pos(ref.loc) - pos(loc))) ref = d;
      }
    }
    if (!ref && same.length) ref = same[same.length - 1];
    return {
      name: ref ? nextInSeries(project, ref.name, n, false) : nextInSeries(project, type.defaultName, n, true),
      cluster: ref ? ref.cluster : undefined,
    };
  }

  function suggestName(project, typeId, count) {
    return suggestPlacement(project, typeId, null, count).name;
  }

  /** Next unused name derived from `name` (for duplicates): cn-004 → cn-005, db → db-2. */
  function nextFreeName(project, name) {
    const used = new Set(project.devices.map((d) => d.name));
    const s = parseSerial(name);
    if (s) {
      let n = s.num + 1;
      while (used.has(formatSerial(s, n))) n++;
      return formatSerial(s, n);
    }
    let i = 2;
    while (used.has(`${name}-${i}`)) i++;
    return `${name}-${i}`;
  }

  function nextClusterColor(project) {
    const used = new Set(project.clusters.map((c) => c.color));
    return CLUSTER_COLORS.find((c) => !used.has(c)) || CLUSTER_COLORS[project.clusters.length % CLUSTER_COLORS.length];
  }

  function nextClusterName(project) {
    const used = new Set(project.clusters.map((c) => c.name));
    let i = project.clusters.length + 1;
    while (used.has(`Cluster ${i}`)) i++;
    return `Cluster ${i}`;
  }

  // ------------------------------------------------------------- statistics

  function rackStats(project, rackId) {
    const devices = project.devices.filter((d) => d.loc.rack === rackId);
    const occupied = new Array(RACK_UNITS + 1).fill(false);
    let used = 0;
    let sideUsed = 0;
    for (const d of devices) {
      if (d.loc.kind === 'side') {
        sideUsed++;
        continue;
      }
      const [b, t] = deviceSpan(d);
      for (let u = b; u <= t; u++) occupied[u] = true;
      used += t - b + 1;
    }
    let largestFree = 0;
    let run = 0;
    for (let u = 1; u <= RACK_UNITS; u++) {
      run = occupied[u] ? 0 : run + 1;
      largestFree = Math.max(largestFree, run);
    }
    return { used, free: RACK_UNITS - used, largestFree, sideUsed, count: devices.length };
  }

  /** Devices ordered by rack, then top to bottom, then side slots. */
  function sortedDevices(project, rackId) {
    const order = (d) => {
      const r = rackIndex(project, d.loc.rack);
      const pos = d.loc.kind === 'u' ? d.loc.at : RACK_UNITS + 1 + d.loc.at;
      return r * 1000 + pos;
    };
    return project.devices.filter((d) => !rackId || d.loc.rack === rackId).sort((a, b) => order(a) - order(b));
  }

  // ------------------------------------------------------- import / export

  function serialize(project) {
    return JSON.stringify(
      {
        app: 'rackplanner',
        version: SCHEMA_VERSION,
        name: project.name,
        racks: project.racks,
        clusters: project.clusters,
        devices: project.devices,
        meta: project.meta || {},
      },
      null,
      2
    );
  }

  /**
   * Turns untrusted JSON (an imported file or saved state) into a valid
   * project. Anything that doesn't fit is dropped and reported in `warnings`.
   */
  function normalizeProject(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('This file is not a rack plan.');
    if (!Array.isArray(raw.devices) && !Array.isArray(raw.racks)) {
      throw new Error('This file is not a rack plan: it has no racks or devices.');
    }
    const warnings = [];
    const rawRacks = Array.isArray(raw.racks) ? raw.racks.filter((r) => r && typeof r === 'object') : [];
    const p = createEmptyProject(rawRacks.length ? Math.min(rawRacks.length, MAX_RACKS) : DEFAULT_RACKS);
    // Version 1 counted units from the bottom of the rack.
    const bottomUp = Number(raw.version) === 1;
    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    // Ids may be written as numbers in hand-made files; they are kept as strings.
    const idOf = (v) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v).trim().slice(0, 80) : '');
    if (str(raw.name, 120)) p.name = str(raw.name, 120);

    // Map the file's rack ids to r1..rN by position. Without racks in the
    // file, devices may refer to the default ids directly.
    const rackIds = new Map();
    if (rawRacks.length) {
      rawRacks.slice(0, MAX_RACKS).forEach((r, i) => {
        if (str(r.name, 60)) p.racks[i].name = str(r.name, 60);
        rackIds.set(idOf(r.id) || p.racks[i].id, p.racks[i].id);
      });
    } else {
      p.racks.forEach((r) => rackIds.set(r.id, r.id));
    }
    if (rawRacks.length > MAX_RACKS) warnings.push(`Only the first ${MAX_RACKS} racks were kept.`);

    const clusterIds = new Set();
    (Array.isArray(raw.clusters) ? raw.clusters : []).forEach((c, i) => {
      if (!c || typeof c !== 'object') return;
      const id = idOf(c.id);
      const label = str(c.name, 60) || `#${i + 1}`;
      if (!id) return void warnings.push(`Skipped cluster ${label}: it has no id.`);
      if (clusterIds.has(id)) return void warnings.push(`Skipped cluster ${label}: its id “${id}” is used twice.`);
      clusterIds.add(id);
      p.clusters.push({
        id,
        name: str(c.name, 60) || nextClusterName(p),
        color: normalizeHex(c.color) || nextClusterColor(p),
      });
    });

    const deviceIds = new Set();
    (Array.isArray(raw.devices) ? raw.devices : []).forEach((d, i) => {
      if (!d || typeof d !== 'object') return;
      const type = typeById(d.type);
      const name = str(d.name, 80) || (type ? suggestName(p, type.id) : `device ${i + 1}`);
      if (!type) {
        warnings.push(`Skipped ${name}: unknown device type “${String(d.type)}”.`);
        return;
      }
      const loc = d.loc && typeof d.loc === 'object' ? d.loc : {};
      const nloc = {
        rack: rackIds.get(idOf(loc.rack)) || null,
        kind: loc.kind === 'side' ? 'side' : 'u',
        at: Number(loc.at),
      };
      if (!nloc.rack) {
        const ref = idOf(loc.rack);
        return void warnings.push(`Skipped ${name}: ${ref ? `rack “${ref}” is not in the plan` : 'it has no rack'}.`);
      }
      if (bottomUp && nloc.kind === 'u') nloc.at = RACK_UNITS + 2 - nloc.at - type.height;
      const fit = canPlace(p, type.id, nloc);
      if (!fit.ok) {
        warnings.push(`Skipped ${name}: ${fit.reason}.`);
        return;
      }
      let id = idOf(d.id);
      if (!id || deviceIds.has(id)) id = uid('d');
      deviceIds.add(id);
      const cluster = idOf(d.cluster);
      if (cluster && !clusterIds.has(cluster)) warnings.push(`${name} refers to unknown cluster “${cluster}” and is left unassigned.`);
      p.devices.push({
        id,
        type: type.id,
        name,
        cluster: clusterIds.has(cluster) ? cluster : null,
        notes: typeof d.notes === 'string' ? d.notes.slice(0, 2000) : '',
        loc: nloc,
      });
    });
    if (raw.meta && typeof raw.meta === 'object' && raw.meta.example === true) p.meta.example = true;
    return { project: p, warnings };
  }

  /** True when the plan still equals the example (the notice flag aside). */
  function isPristineExample(project) {
    const ex = createExampleProject();
    const pick = (p) => JSON.stringify([p.name, p.racks, p.clusters, p.devices]);
    return pick(project) === pick(ex);
  }

  function csvCell(value) {
    let s = String(value == null ? '' : value);
    // Keep spreadsheet apps from evaluating cells as formulas.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCSV(project) {
    const rows = [['Rack', 'Position', 'Height (U)', 'Type', 'Name', 'Cluster', 'Notes']];
    for (const d of sortedDevices(project)) {
      const type = typeById(d.type);
      const cluster = clusterById(project, d.cluster);
      rows.push([
        rackById(project, d.loc.rack).name,
        d.loc.kind === 'side' ? `Side V${d.loc.at + 1}` : formatPosition(d.loc, d.type).replace('–', '-'),
        type.height,
        type.label,
        d.name,
        cluster ? cluster.name : '',
        d.notes || '',
      ]);
    }
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  return {
    SCHEMA_VERSION,
    RACK_UNITS,
    SIDE_SLOTS,
    MIN_RACKS,
    MAX_RACKS,
    DEFAULT_RACKS,
    DEVICE_TYPES,
    CLUSTER_COLORS,
    typeById,
    rackById,
    rackIndex,
    clusterById,
    deviceById,
    uid,
    normalizeHex,
    createEmptyProject,
    createExampleProject,
    isPristineExample,
    defaultRackName,
    setRackCount,
    devicesBeyond,
    formatSpan,
    deviceSpan,
    canPlace,
    planPositions,
    validLocs,
    nudgeTarget,
    nearestLoc,
    formatLoc,
    formatPosition,
    parseSerial,
    nameSequence,
    nextInSeries,
    suggestPlacement,
    suggestName,
    nextFreeName,
    nextClusterColor,
    nextClusterName,
    rackStats,
    sortedDevices,
    serialize,
    normalizeProject,
    toCSV,
  };
});
