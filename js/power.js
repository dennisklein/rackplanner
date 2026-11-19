/*
 * Rackplanner: power cabling.
 *
 * Power grids, cord types and power cords on top of the plan of
 * js/model.js: connecting an inlet of a device to an outlet of a PDU in
 * its rack, picking a cord type and estimating its length, the load of
 * every fuse group, phase and PDU with all grids up and with one grid
 * down, and the checks. Pure functions without DOM access, shared by the
 * browser app and the Node tests. Functions that change the plan say so;
 * the rules of what a plan may hold are in js/model.js (cordProblem).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'));
  else (root.RP = root.RP || {}).power = factory(root.RP.model);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  const L = M.LIMITS;
  const UNIT_M = 0.04445; // one rack unit
  const ACROSS_M = 0.3; // from a device's inlet across to the side channel
  const SLACK_M = 0.15; // at each end of a cord
  // A cord without a grid (its PDU has none) is drawn in this color.
  const NO_GRID_COLOR = '#8a8f98';
  // The key of the scenario with every grid up; the others have the id of
  // the grid that is down. No grid has this one: ids that start with "__"
  // are the app's, and a file that has one gets a new id when it is read.
  const UP = '__up';

  // ------------------------------------------------------------ formatting

  const round = (v, digits) => {
    const f = Math.pow(10, digits);
    return Math.round(v * f) / f;
  };
  /** "350 W", "1.25 kW" from 1000 W on. */
  function fmtW(w) {
    return w >= 1000 ? `${round(w / 1000, 2)} kW` : `${Math.round(w)} W`;
  }
  /** "14.3 A". */
  const fmtA = (a) => `${round(a, 1)} A`;
  /** "22.1 kW". */
  const fmtKw = (w) => `${round(w / 1000, 1)} kW`;
  /** "1.5 m". */
  const fmtM = (m) => (m === null || m === undefined ? '–' : `${round(m, 2)} m`);
  const connLabel = (id) => M.powerConnectorLabel(id);
  const key = (device, name) => `${device}|${name}`;

  // --------------------------------------------------------------- context

  /**
   * What reading the power cords needs, built once: devices and racks by
   * id, the grids, the cords by their inlet ("device|inlet"), by their
   * outlet ("pdu|outlet") and by device, and `info(typeId)`: the inlets
   * and outlets of a device type with the fuse and meter group of each
   * outlet.
   */
  function context(project) {
    const types = new Map();
    const info = (typeId) => {
      let t = types.get(typeId);
      if (!t) {
        const type = M.typeOf(project, typeId);
        const inlets = M.expandInlets(type);
        const outlets = M.expandOutlets(type);
        t = {
          type,
          inlets,
          outlets,
          inletBy: new Map(inlets.map((x) => [x.name, x])),
          outletBy: new Map(outlets.map((x, i) => [x.name, Object.assign({ at: i }, x)])),
          groups: M.outletGroups(type),
        };
        types.set(typeId, t);
      }
      return t;
    };
    const byInlet = new Map();
    const byOutlet = new Map();
    const byDevice = new Map();
    const push = (id, c) => {
      const list = byDevice.get(id);
      if (list) list.push(c);
      else byDevice.set(id, [c]);
    };
    for (const c of project.powerCords || []) {
      byInlet.set(key(c.inlet.device, c.inlet.inlet), c);
      byOutlet.set(key(c.outlet.device, c.outlet.outlet), c);
      push(c.inlet.device, c);
      push(c.outlet.device, c);
    }
    const order = new Map();
    const racks = new Map();
    M.allRacks(project).forEach((r, i) => {
      racks.set(r.rack.id, r);
      order.set(r.rack.id, i);
    });
    return {
      project,
      devices: new Map(project.devices.map((d) => [d.id, d])),
      deviceOrder: new Map(M.sortedDevices(project).map((d, i) => [d.id, i])),
      racks,
      order,
      grids: new Map((project.powerGrids || []).map((g) => [g.id, g])),
      cordTypes: new Map((project.cordTypes || []).map((t) => [t.id, t])),
      settings: M.powerSettings(project),
      info,
      byInlet,
      byOutlet,
      byDevice,
    };
  }

  const cordById = (project, id) => (project.powerCords || []).find((c) => c.id === id) || null;
  /** The PDUs of the plan, in the order of their racks and slots; with `rackIds` (a Set), those in these racks. */
  function pdus(project, rackIds) {
    return M.sortedDevices(project).filter((d) => d.loc.kind === 'pdu' && (!rackIds || rackIds.has(d.loc.rack)));
  }
  /** The power cords with both ends in the racks of `rackIds` (a Set; all cords without one). */
  function cordsWithin(project, rackIds, ctx) {
    if (!rackIds) return (project.powerCords || []).slice();
    const c = ctx || context(project);
    return (project.powerCords || []).filter((x) => {
      const pdu = c.devices.get(x.outlet.device);
      return !!pdu && rackIds.has(pdu.loc.rack);
    });
  }

  // ----------------------------------------------------------------- grids

  /** Adds a power grid (name and color free ones by default); null when the plan has twelve. */
  function addGrid(project, props) {
    if (!Array.isArray(project.powerGrids)) project.powerGrids = [];
    if (project.powerGrids.length >= L.powerGrids) return null;
    const g = M.cleanPowerGrid(props, project);
    g.id = M.uid('pg');
    g.name = M.uniqueLabel(project.powerGrids, 'name', g.name);
    project.powerGrids.push(g);
    return g;
  }

  /** Changes a power grid; refuses (with a message) a name another grid has, in any case. */
  function updateGrid(project, id, changes) {
    const i = (project.powerGrids || []).findIndex((g) => g.id === id);
    if (i < 0) return 'Unknown power grid';
    const before = project.powerGrids[i];
    const merged = Object.assign({}, before, changes);
    if (!M.normalizeHex(merged.color)) merged.color = before.color;
    if (!M.str(merged.name, 60)) merged.name = before.name;
    const next = M.cleanPowerGrid(merged, project);
    next.id = id;
    if (next.name !== before.name && M.nameTaken(project.powerGrids, next.name, id)) return `Another power grid is named ${next.name}`;
    project.powerGrids[i] = next;
    return null;
  }

  /** Removes a power grid; its PDUs stay, without a grid. Returns how many PDUs it fed. */
  function deleteGrid(project, id) {
    let n = 0;
    for (const d of project.devices) {
      if (d.grid !== id) continue;
      d.grid = null;
      n++;
    }
    project.powerGrids = (project.powerGrids || []).filter((g) => g.id !== id);
    return n;
  }

  /** Moves a power grid to `toIndex`; new PDUs take the grids in this order. */
  function moveGrid(project, id, toIndex) {
    const list = project.powerGrids || [];
    const i = list.findIndex((g) => g.id === id);
    const to = Math.max(0, Math.min(list.length - 1, toIndex));
    if (i < 0 || i === to) return false;
    list.splice(to, 0, list.splice(i, 1)[0]);
    return true;
  }

  /** Feeds PDU `pduId` from grid `gridId` (null: none); an error message for anything else. */
  function setGrid(project, pduId, gridId) {
    const d = M.deviceById(project, pduId);
    if (!M.isPdu(project, d)) return 'Only a PDU is fed by a power grid';
    if (gridId && !M.powerGridById(project, gridId)) return 'Unknown power grid';
    d.grid = gridId || null;
    return null;
  }

  /** How many PDUs each grid feeds: Map from grid id ('' for none) to the number. */
  function gridUse(project) {
    const out = new Map();
    for (const d of project.devices) if (d.loc.kind === 'pdu') out.set(d.grid || '', (out.get(d.grid || '') || 0) + 1);
    return out;
  }

  /** Changes the plan's power factor or limit. */
  function setPowerSettings(project, changes) {
    project.powerSettings = M.cleanPowerSettings(Object.assign({}, M.powerSettings(project), changes));
    return project.powerSettings;
  }

  // ------------------------------------------------------------ cord types

  /** Cords that name cord type `id` (cords picking their type don't count). */
  function cordTypeUse(project, id) {
    return (project.powerCords || []).filter((c) => c.type === id).length;
  }

  function addCordType(project, template) {
    if (!Array.isArray(project.cordTypes)) project.cordTypes = [];
    if (project.cordTypes.length >= L.cordTypes) return null;
    const t = M.cleanCordType(template);
    t.id = M.uid('pt');
    t.name = M.uniqueLabel(project.cordTypes, 'name', t.name);
    project.cordTypes.push(t);
    return t;
  }

  /** Changes a cord type; its name stays unique. */
  function updateCordType(project, id, changes) {
    const i = (project.cordTypes || []).findIndex((t) => t.id === id);
    if (i < 0) return 'Unknown cord type';
    const next = M.cleanCordType(Object.assign({}, project.cordTypes[i], changes));
    next.id = id;
    next.name = M.uniqueLabel(project.cordTypes.filter((t) => t.id !== id), 'name', next.name);
    project.cordTypes[i] = next;
    return null;
  }

  /** Removes a cord type no cord names; returns an error message otherwise. */
  function deleteCordType(project, id) {
    const n = cordTypeUse(project, id);
    if (n) return `${n} cord${n === 1 ? ' uses' : 's use'} this type`;
    project.cordTypes = (project.cordTypes || []).filter((t) => t.id !== id);
    return null;
  }

  /** Moves a cord type to `toIndex`; picking goes by this order. */
  function moveCordType(project, id, toIndex) {
    const list = project.cordTypes || [];
    const i = list.findIndex((t) => t.id === id);
    const to = Math.max(0, Math.min(list.length - 1, toIndex));
    if (i < 0 || i === to) return false;
    list.splice(to, 0, list.splice(i, 1)[0]);
    return true;
  }

  // ------------------------------------------------------------ connecting

  /** A cord as the plan keeps it, from what a form or an import gives. */
  function draftCord(props, id) {
    const p = props || {};
    return {
      id: id || M.uid('pc'),
      label: M.str(p.label, 40),
      type: p.type || null,
      lengthM: M.clampNum(p.lengthM, 0.1, 100, null),
      color: M.normalizeHex(p.color) || null,
      notes: typeof p.notes === 'string' ? p.notes.slice(0, M.NOTES_MAX) : '',
      inlet: M.cleanCordEnd(p.inlet, 'inlet'),
      outlet: M.cleanCordEnd(p.outlet, 'outlet'),
    };
  }

  /** Why a cord with `props` cannot be added (or, with `ignoreCordId`, cannot replace that cord), or null. */
  function checkConnect(project, props, ignoreCordId) {
    const cord = draftCord(props, ignoreCordId || '__new');
    return M.cordProblem(project, cord, M.cordContext(project, cord.id));
  }

  /**
   * Adds a power cord from `props`: { inlet: { device, inlet }, outlet: {
   * device, outlet }, type, lengthM, label, color, notes }. Without a
   * label it gets the next of the series P-0001. Returns { cord } or
   * { error }.
   */
  function connect(project, props) {
    if (!Array.isArray(project.powerCords)) project.powerCords = [];
    if (project.powerCords.length >= L.powerCords) return { error: `A plan holds ${L.powerCords} power cords` };
    const cord = draftCord(props);
    const error = M.cordProblem(project, cord);
    if (error) return { error };
    if (!cord.label) cord.label = M.nextCordLabel(project);
    project.powerCords.push(cord);
    return { cord };
  }

  /**
   * Changes a cord's label, type, length, color, notes or ends; an error
   * message when the result breaks a rule. A label emptied continues the
   * series.
   */
  function updateCord(project, id, changes) {
    const i = (project.powerCords || []).findIndex((c) => c.id === id);
    if (i < 0) return 'Unknown power cord';
    const next = draftCord(Object.assign({}, project.powerCords[i], changes), id);
    const error = M.cordProblem(project, next);
    if (error) return error;
    if (!next.label) next.label = M.nextCordLabel(project);
    project.powerCords[i] = next;
    return null;
  }

  /** Removes the cords `ids`; returns how many went. */
  function disconnect(project, ids) {
    const gone = new Set(ids);
    const before = (project.powerCords || []).length;
    project.powerCords = (project.powerCords || []).filter((c) => !gone.has(c.id));
    return before - project.powerCords.length;
  }

  /** Removes every cord with an end on a device of `deviceIds`; returns how many went. */
  function unplug(project, deviceIds) {
    return disconnect(project, M.cordsOf(project, deviceIds).map((c) => c.id));
  }

  /**
   * The power cords that would be unplugged if device `deviceId` got the
   * type `typeId`, as model.setDeviceType does it: the cords on inlets (of
   * a PDU: outlets) that have no place in the new type. The plan stays as
   * it is. See cabling.typeChangeImpact for the cables.
   */
  function typeChangeImpact(project, deviceId, typeId) {
    if (!(project.powerCords || []).length) return [];
    const work = Object.assign({}, project, {
      devices: project.devices.map((d) => (d.id === deviceId ? M.clone(d) : d)),
      cables: M.clone(project.cables || []),
      powerCords: M.clone(project.powerCords),
    });
    if (M.setDeviceType(work, deviceId, typeId)) return [];
    const kept = new Set(work.powerCords.map((c) => c.id));
    return project.powerCords.filter((c) => !kept.has(c.id));
  }

  // ----------------------------------------------------------------- length

  /** How far below the top of its rack a device's inlets are, in metres: the middle of the device. */
  function inletDropM(ctx, d) {
    const p = ctx.project;
    if (d.loc.kind === 'side') {
      const slots = Math.max(1, M.rackSideSlots(p, d.loc.rack));
      return ((d.loc.at + 0.5) / slots) * M.rackUnits(p, d.loc.rack) * UNIT_M;
    }
    return (d.loc.at - 1 + M.deviceHeight(p, d) / 2) * UNIT_M;
  }

  /**
   * The units a PDU runs along in its rack, as [top, length]: its type's
   * length, centered on the rack's height, and no longer than the rack.
   */
  function pduSpan(project, pdu) {
    const units = M.rackUnits(project, pdu.loc.rack);
    const type = M.typeOf(project, pdu.type);
    const span = Math.min(units, type && type.pdu ? type.pdu.spanU : units);
    return [(units - span) / 2, span];
  }

  /** How far below the top of its rack an outlet of a PDU is, in metres: the outlets are spread evenly along the PDU, the first at the top. */
  function outletDropM(ctx, pdu, outlet) {
    const t = ctx.info(pdu.type);
    const o = t.outletBy.get(outlet);
    const [top, span] = pduSpan(ctx.project, pdu);
    return (top + (((o ? o.at : 0) + 0.5) * span) / Math.max(1, t.outlets.length)) * UNIT_M;
  }

  /** The length a cord needs, to the centimetre: the height between inlet and outlet, across to the side channel, and slack at both ends. Null when an end is gone. */
  function neededLength(project, cord, ctx0) {
    const ctx = ctx0 || context(project);
    const d = ctx.devices.get(cord.inlet.device);
    const pdu = ctx.devices.get(cord.outlet.device);
    if (!d || !pdu) return null;
    return round(Math.abs(inletDropM(ctx, d) - outletDropM(ctx, pdu, cord.outlet.outlet)) + ACROSS_M + 2 * SLACK_M, 2);
  }

  /** The length to buy for `m` metres: the next stock length of the cord type (null past the longest), or the next 0.1 m when it has none. */
  function stockLength(type, m) {
    if (!type || !type.lengthsM.length) return Math.max(0.1, Math.ceil(m * 10 - 1e-6) / 10);
    const l = type.lengthsM.find((x) => x >= m - 1e-9);
    return l === undefined ? null : l;
  }

  /** The cord types whose plugs fit outlet connector `outlet` and inlet connector `inlet`, in catalog order. */
  function fittingTypes(project, outlet, inlet) {
    return (project.cordTypes || []).filter((t) => t.outlet === outlet && t.inlet === inlet);
  }

  /**
   * A cord read out: its device, PDU, inlet and outlet (with connectors),
   * fuse and meter group, grid, the cord type (picked when the cord names
   * none: the first that fits both plugs, one with a stock length long
   * enough first), its length (estimated from the stock lengths when the
   * cord has none) and color, and what is wrong with it:
   * issues [{ kind: 'fit' | 'length', title, text }].
   */
  function describe(project, cord, ctx0) {
    const ctx = ctx0 || context(project);
    const device = ctx.devices.get(cord.inlet.device) || null;
    const pdu = ctx.devices.get(cord.outlet.device) || null;
    const inlet = device ? ctx.info(device.type).inletBy.get(cord.inlet.inlet) || null : null;
    const pt = pdu ? ctx.info(pdu.type) : null;
    const outlet = pt ? pt.outletBy.get(cord.outlet.outlet) || null : null;
    const groups = (pt && pt.groups.get(cord.outlet.outlet)) || { fuse: null, meter: null };
    const grid = pdu ? ctx.grids.get(pdu.grid) || null : null;
    const neededM = neededLength(project, cord, ctx);
    const issues = [];
    let type = cord.type ? ctx.cordTypes.get(cord.type) || null : null;
    const typeAuto = !type;
    const what = inlet && outlet ? `${connLabel(inlet.connector)} inlet on a ${connLabel(outlet.connector)} outlet` : '';
    if (type && inlet && outlet && (type.outlet !== outlet.connector || type.inlet !== inlet.connector)) {
      issues.push({ kind: 'fit', title: 'Plug does not fit', text: `${type.name} on a ${what}` });
    } else if (!type && inlet && outlet) {
      const fits = fittingTypes(project, outlet.connector, inlet.connector);
      type = fits.find((t) => neededM !== null && stockLength(t, neededM) !== null) || fits[0] || null;
      if (!type) issues.push({ kind: 'fit', title: 'Plug does not fit', text: `${what[0].toUpperCase()}${what.slice(1)}: no cord type joins them` });
    }
    let lengthM = cord.lengthM;
    const lengthAuto = lengthM === null || lengthM === undefined;
    if (lengthAuto) {
      lengthM = neededM === null ? null : stockLength(type, neededM);
      if (lengthM === null && neededM !== null && type) {
        issues.push({ kind: 'length', title: 'No stock length', text: `Needs ${fmtM(neededM)}, the longest ${type.name} is ${fmtM(type.lengthsM[type.lengthsM.length - 1])}` });
      }
    } else if (neededM !== null && lengthM < neededM - 1e-9) {
      issues.push({ kind: 'length', title: 'Cord too short', text: `Needs ${fmtM(neededM)}, the cord is ${fmtM(lengthM)}` });
    }
    return {
      cord,
      device,
      pdu,
      inlet,
      outlet,
      fuse: groups.fuse,
      meter: groups.meter,
      grid,
      type,
      typeAuto,
      neededM,
      lengthM,
      lengthAuto,
      color: cord.color || (grid ? grid.color : NO_GRID_COLOR),
      colorName: cord.color ? cord.color : grid ? grid.name : 'No grid',
      issues,
    };
  }

  // ------------------------------------------------------------------ loads

  /** The scenarios loads are worked out for: every grid up, and each grid down in turn. */
  function scenarios(project) {
    return [{ id: UP, name: 'All grids up', short: 'All up', grid: null }].concat(
      (project.powerGrids || []).map((g) => ({ id: g.id, name: `${g.name} down`, short: `${g.name} down`, grid: g }))
    );
  }

  /** "when Grid B is down" or "with all grids up", for a sentence about scenario `id`. */
  function scenarioPhrase(project, id) {
    const g = id === UP ? null : M.powerGridById(project, id);
    return g ? `when ${g.name} is down` : 'with all grids up';
  }

  /**
   * A load in every scenario: { w, a } by scenario id, with all grids up
   * (upW, upA), the highest with one grid down (downW, downA, in scenario
   * `down`; the load with all up when the plan has no grid) and the
   * highest of all (worstW, worstA, in scenario `worst`). `ratingA` or
   * `ratingW` is what it is held against: `use` is the worst as a share
   * of it, and `over` says that this is past the plan's limit.
   */
  function loadValue(scens, w, volts, limit, rating) {
    const a = {};
    for (const s of scens) a[s.id] = volts > 0 ? (w[s.id] || 0) / volts : 0;
    const downs = scens.filter((s) => s.id !== UP);
    const top = (list) => list.reduce((best, s) => ((w[s.id] || 0) > (w[best.id] || 0) ? s : best), list[0]);
    const down = downs.length ? top(downs) : scens[0];
    const worst = top(scens);
    const v = { w, a, upW: w[UP] || 0, upA: a[UP], downW: w[down.id] || 0, downA: a[down.id], down: down.id, worstW: w[worst.id] || 0, worstA: a[worst.id], worst: worst.id };
    if (rating.ratingA !== undefined) {
      v.ratingA = rating.ratingA;
      v.use = rating.ratingA > 0 ? v.worstA / rating.ratingA : 0;
    } else {
      v.ratingW = rating.ratingW;
      v.use = rating.ratingW > 0 ? v.worstW / rating.ratingW : 0;
    }
    v.over = v.use > limit + 1e-9;
    return v;
  }

  /**
   * The load of the plan's power cords, fuse groups, phases and PDUs in
   * every scenario. A device's power divides equally over its inlets that
   * have a cord to a PDU with power: with a grid down, the cords to the
   * PDUs on the other grids carry its share too. A PDU without a grid
   * always has power. Amperes are watts / (volts per phase × power
   * factor). Returns {
   *   scenarios, limit (0–1), ctx,
   *   cords:   Map cord id → { w: { scenario: W } },
   *   devices: Map device id → { device, powerW, inlets: [{ name, connector, cord, pdu, grid }], corded, grids: [grid id | ''], off: [scenario ids] },
   *   pdus:    [{ pdu, type, grid, capacityW, total, phases: [{ phase, value, fuses: [{ fuse, value }] }] }]
   * } with `value`/`total` from loadValue.
   */
  function loads(project, ctx0) {
    const ctx = ctx0 || context(project);
    const scens = scenarios(project);
    const limit = ctx.settings.limitPct / 100;
    const cords = new Map();
    const devices = new Map();
    for (const d of project.devices) {
      const t = ctx.info(d.type);
      if (!t.inlets.length) continue;
      const inlets = t.inlets.map((x) => {
        const cord = ctx.byInlet.get(key(d.id, x.name)) || null;
        const pdu = cord ? ctx.devices.get(cord.outlet.device) || null : null;
        return { name: x.name, connector: x.connector, cord, pdu, grid: pdu ? pdu.grid || '' : null };
      });
      const corded = inlets.filter((x) => x.cord && x.pdu);
      const powerW = M.powerOf(project, d);
      const off = [];
      for (const s of scens) {
        const live = corded.filter((x) => s.id === UP || x.grid !== s.id);
        if (corded.length && !live.length) off.push(s.id);
        for (const x of live) {
          let c = cords.get(x.cord.id);
          if (!c) cords.set(x.cord.id, (c = { w: {} }));
          c.w[s.id] = powerW / live.length;
        }
      }
      devices.set(d.id, { device: d, powerW, inlets, corded: corded.length, grids: [...new Set(corded.map((x) => x.grid))], off });
    }
    const out = [];
    for (const pdu of pdus(project)) {
      const t = ctx.info(pdu.type);
      const spec = t.type.pdu;
      const volts = spec.voltageV * ctx.settings.powerFactor;
      const sum = (names) => {
        const w = {};
        for (const s of scens) w[s.id] = 0;
        for (const n of names) {
          const c = ctx.byOutlet.get(key(pdu.id, n));
          const l = c && cords.get(c.id);
          if (l) for (const s of scens) w[s.id] += l.w[s.id] || 0;
        }
        return w;
      };
      const phases = M.PHASES.slice(0, spec.phases).map((phase) => {
        const fuses = spec.fuses.filter((f) => f.phase === phase).map((fuse) => ({ fuse, value: loadValue(scens, sum(fuse.outlets), volts, limit, { ratingA: fuse.ratingA }) }));
        const w = {};
        for (const s of scens) w[s.id] = fuses.reduce((n, f) => n + f.value.w[s.id], 0);
        return { phase, value: loadValue(scens, w, volts, limit, { ratingA: spec.maxA }), fuses };
      });
      const w = {};
      for (const s of scens) w[s.id] = phases.reduce((n, p) => n + p.value.w[s.id], 0);
      const capacityW = spec.phases * spec.voltageV * spec.maxA * ctx.settings.powerFactor;
      out.push({ pdu, type: t.type, grid: ctx.grids.get(pdu.grid) || null, capacityW, total: loadValue(scens, w, volts, limit, { ratingW: capacityW }), phases });
    }
    return { scenarios: scens, limit, ctx, cords, devices, pdus: out };
  }

  /** The watts a cord carries in scenario `id` of `load` (from loads); 0 without power. */
  function cordW(load, cordId, id) {
    const c = load.cords.get(cordId);
    return c ? c.w[id || UP] || 0 : 0;
  }
  /** The most a cord carries with one grid down (with all up when the plan has no grid). */
  function cordDownW(load, cordId) {
    const c = load.cords.get(cordId);
    if (!c) return 0;
    const downs = load.scenarios.filter((s) => s.id !== UP);
    return downs.length ? Math.max(...downs.map((s) => c.w[s.id] || 0)) : c.w[UP] || 0;
  }

  /**
   * The outlets of a PDU from the top down, each with its connector, fuse
   * and meter group, and the cord, device and inlet on it (null when
   * free): [{ name, connector, fuse, meter, cord, device, inlet }].
   */
  function outletsOf(project, pdu, ctx0) {
    const ctx = ctx0 || context(project);
    const t = ctx.info(pdu.type);
    return t.outlets.map((o) => {
      const cord = ctx.byOutlet.get(key(pdu.id, o.name)) || null;
      const g = t.groups.get(o.name) || { fuse: null, meter: null };
      return { name: o.name, connector: o.connector, fuse: g.fuse, meter: g.meter, cord, device: cord ? ctx.devices.get(cord.inlet.device) || null : null, inlet: cord ? cord.inlet.inlet : null };
    });
  }

  // ----------------------------------------------------------------- checks

  const CHECK_ORDER = ['fuse', 'phase', 'pdu', 'outlet', 'fit', 'length', 'redundancy', 'grid', 'inlet', 'noinlets', 'balance'];

  /**
   * What is wrong with the power cabling of the racks `rackIds` (a Set;
   * the whole plan without one), worst first: [{ kind, level: 'warn' |
   * 'note', title, text, device?, pdu?, cord?, fuse?, type? }] with ids
   * to select what a check is about. See docs/power/README.md for the
   * list.
   */
  function checks(project, rackIds, load0) {
    const load = load0 || loads(project);
    const ctx = load.ctx;
    const inScope = (d) => !rackIds || rackIds.has(d.loc.rack);
    const pct = `${round(load.limit * 100, 0)} %`;
    const when = (id) => scenarioPhrase(project, id);
    const out = [];
    const add = (kind, title, text, refs, level) => out.push(Object.assign({ kind, level: level || 'warn', title, text }, refs));

    for (const p of load.pdus) {
      if (!inScope(p.pdu)) continue;
      const name = p.pdu.name;
      if (!p.grid) add('grid', 'PDU without a grid', `${name}: its load counts under “No grid”`, { pdu: p.pdu.id });
      for (const ph of p.phases) {
        for (const f of ph.fuses) {
          if (f.value.over) add('fuse', `Fuse over ${pct}`, `${f.fuse.name} of ${name}: ${fmtA(f.value.worstA)} of ${fmtA(f.fuse.ratingA)} ${when(f.value.worst)}`, { pdu: p.pdu.id, fuse: f.fuse.name });
        }
        if (ph.value.over) add('phase', `Phase over ${pct}`, `${ph.phase} of ${name}: ${fmtA(ph.value.worstA)} of ${fmtA(ph.value.ratingA)} ${when(ph.value.worst)}`, { pdu: p.pdu.id });
      }
      if (p.total.over) add('pdu', `PDU over ${pct}`, `${name}: ${fmtKw(p.total.worstW)} of ${fmtKw(p.capacityW)} ${when(p.total.worst)}`, { pdu: p.pdu.id });
      if (p.phases.length > 1) {
        // At their worst: a phase with less than half the load of the highest.
        const hi = p.phases.reduce((a, b) => (b.value.worstA > a.value.worstA ? b : a));
        const lo = p.phases.reduce((a, b) => (b.value.worstA < a.value.worstA ? b : a));
        if (hi.value.worstA > 0 && lo.value.worstA < hi.value.worstA / 2) {
          const low = lo.value.worstA > 0 ? `has ${fmtA(lo.value.worstA)}` : 'has no load';
          add('balance', 'Phases not balanced', `${name}: ${lo.phase} ${low}, ${hi.phase} has ${fmtA(hi.value.worstA)}`, { pdu: p.pdu.id }, 'note');
        }
      }
    }

    const noInlets = new Map();
    const pduRacks = new Set(load.pdus.map((p) => p.pdu.loc.rack));
    for (const d of M.sortedDevices(project)) {
      if (!inScope(d) || d.loc.kind === 'pdu') continue;
      const type = M.typeOf(project, d.type);
      if (!type || type.variable) continue;
      const l = load.devices.get(d.id);
      if (!l) {
        if (M.powerOf(project, d) > 0) noInlets.set(type.id, (noInlets.get(type.id) || 0) + 1);
        continue;
      }
      if (l.powerW <= 0) continue;
      // Only in a rack that has a PDU: without one, power is not planned there yet.
      const open = l.inlets.filter((x) => !x.cord).map((x) => x.name);
      if (open.length && pduRacks.has(d.loc.rack)) {
        const names = open.length > 1 ? `${open.slice(0, -1).join(', ')} and ${open[open.length - 1]}` : open[0];
        add('inlet', 'Inlet without a cord', `${names} of ${d.name} ${open.length > 1 ? 'have' : 'has'} no cord`, { device: d.id });
      }
      if (l.corded > 1 && l.grids.length === 1) {
        const g = ctx.grids.get(l.grids[0]);
        add('redundancy', 'No redundancy', `All live inlets of ${d.name} are on ${g ? g.name : 'PDUs without a grid'}`, { device: d.id });
      }
    }
    for (const [typeId, n] of noInlets) {
      const type = M.typeOf(project, typeId);
      add('noinlets', 'No inlets', `Type “${type.label}” draws ${fmtW(type.powerW)}, but has no inlets (${M.plural(n, 'device')})`, { type: typeId });
    }

    for (const cord of cordsWithin(project, rackIds, ctx)) {
      const r = describe(project, cord, ctx);
      const label = cord.label || 'A cord';
      for (const issue of r.issues) add(issue.kind, issue.title, `${label}: ${issue.text}`, { cord: cord.id });
      if (!r.outlet || !r.pdu) continue;
      const spec = ctx.info(r.pdu.type).type.pdu;
      const c = load.cords.get(cord.id);
      if (!c) continue;
      const worst = load.scenarios.reduce((best, s) => ((c.w[s.id] || 0) > (c.w[best.id] || 0) ? s : best), load.scenarios[0]);
      const amps = (c.w[worst.id] || 0) / (spec.voltageV * ctx.settings.powerFactor);
      const conn = M.powerConnectorById(r.outlet.connector);
      const rating = Math.min(conn ? conn.maxA : Infinity, r.type ? r.type.maxA : Infinity);
      if (Number.isFinite(rating) && amps > rating + 1e-9) {
        const what = conn && conn.maxA <= rating ? `${conn.label} outlet, ${fmtA(conn.maxA)}` : `${r.type.name}, ${fmtA(r.type.maxA)}`;
        add('outlet', 'Outlet over its rating', `${what}: ${label} carries ${fmtA(amps)} ${when(worst.id)}`, { cord: cord.id });
      }
    }
    return out.sort((a, b) => CHECK_ORDER.indexOf(a.kind) - CHECK_ORDER.indexOf(b.kind));
  }

  /**
   * Device types with devices that draw power but have no inlets, with
   * the number of those devices: [{ type, count }] (reserved space and
   * PDUs aside).
   */
  function typesWithoutInlets(project) {
    const counts = new Map();
    for (const d of project.devices) {
      const type = M.typeOf(project, d.type);
      if (!type || type.variable || type.pdu || (type.inlets || []).length || M.powerOf(project, d) <= 0) continue;
      counts.set(type.id, (counts.get(type.id) || 0) + 1);
    }
    return project.deviceTypes.filter((t) => counts.has(t.id)).map((type) => ({ type, count: counts.get(type.id) }));
  }

  // --------------------------------------------------------------- schedule

  /**
   * One line of the cord schedule per cord: what describe gives, where
   * its device is and what it draws with all grids up (`drawW`) and at
   * most with one grid down (`downW`).
   */
  function scheduleRows(project, cords, load0) {
    const load = load0 || loads(project);
    const ctx = load.ctx;
    return cords.map((cord) => {
      const r = describe(project, cord, ctx);
      const pos = r.device ? ctx.racks.get(r.device.loc.rack) : null;
      return Object.assign(r, {
        pos,
        slot: r.pdu ? `P${r.pdu.loc.at + 1}` : '',
        drawW: cordW(load, cord.id, UP),
        downW: cordDownW(load, cord.id),
      });
    });
  }

  /** The cords in the order of the schedule: by rack, PDU slot and outlet. */
  function sortCords(project, cords, ctx0) {
    const ctx = ctx0 || context(project);
    const rank = (c) => {
      const pdu = ctx.devices.get(c.outlet.device);
      if (!pdu) return [Infinity, 0, 0];
      const o = ctx.info(pdu.type).outletBy.get(c.outlet.outlet);
      return [ctx.order.get(pdu.loc.rack), pdu.loc.at, o ? o.at : 0];
    };
    const ranks = new Map(cords.map((c) => [c, rank(c)]));
    return cords.slice().sort((a, b) => {
      const x = ranks.get(a);
      const y = ranks.get(b);
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
  }

  /**
   * Cords in groups for the schedule: by 'pdu' (default), 'device',
   * 'grid' or 'type'; 'none' gives one group. [{ key, label, cords }] in
   * the order of the plan.
   */
  function groupCords(project, cords, by, ctx0) {
    const ctx = ctx0 || context(project);
    const sorted = sortCords(project, cords, ctx);
    if (by === 'none') return sorted.length ? [{ key: '', label: '', cords: sorted }] : [];
    const groups = new Map();
    const put = (k, label, rank, cord) => {
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { key: k, label, rank, cords: [] }));
      g.cords.push(cord);
    };
    const gridIndex = new Map((project.powerGrids || []).map((g, i) => [g.id, i]));
    const typeIndex = new Map((project.cordTypes || []).map((t, i) => [t.id, i]));
    sorted.forEach((cord, i) => {
      const pdu = ctx.devices.get(cord.outlet.device);
      if (by === 'device') {
        const d = ctx.devices.get(cord.inlet.device);
        put(d ? d.id : '', d ? d.name : 'Unknown device', d ? ctx.deviceOrder.get(d.id) : Infinity, cord);
      } else if (by === 'grid') {
        const g = pdu ? ctx.grids.get(pdu.grid) : null;
        put(g ? g.id : '', g ? g.name : 'No grid', g ? gridIndex.get(g.id) : Infinity, cord);
      } else if (by === 'type') {
        const t = describe(project, cord, ctx).type;
        put(t ? t.id : '', t ? t.name : 'No cord type', t ? typeIndex.get(t.id) : Infinity, cord);
      } else {
        const rack = pdu ? ctx.racks.get(pdu.loc.rack) : null;
        put(pdu ? pdu.id : '', pdu ? `${pdu.name} · ${rack ? rack.rack.name : ''} · P${pdu.loc.at + 1}` : 'Unknown PDU', i, cord);
      }
    });
    return [...groups.values()].sort((a, b) => a.rank - b.rank).map(({ key: k, label, cords: list }) => ({ key: k, label, cords: list }));
  }

  /**
   * The cords to order: one line per cord type, length and color with
   * the number of cords, [{ type, name, lengthM, color, colorName, count,
   * estimated }] by type, length and color. A cord without a type or a
   * length is counted under "No cord type" or without a length.
   */
  function orderList(project, cords, ctx0) {
    const ctx = ctx0 || context(project);
    const lines = new Map();
    const typeIndex = new Map((project.cordTypes || []).map((t, i) => [t.id, i]));
    for (const cord of cords) {
      const r = describe(project, cord, ctx);
      const k = `${r.type ? r.type.id : ''}|${r.lengthM === null ? '' : r.lengthM}|${r.colorName}`;
      let line = lines.get(k);
      if (!line) lines.set(k, (line = { type: r.type, name: r.type ? r.type.name : 'No cord type', lengthM: r.lengthM, color: r.color, colorName: r.colorName, count: 0, estimated: 0 }));
      line.count++;
      if (r.lengthAuto) line.estimated++;
    }
    const rank = (l) => (l.type ? typeIndex.get(l.type.id) : Infinity);
    return [...lines.values()].sort((a, b) => rank(a) - rank(b) || (a.lengthM === null ? Infinity : a.lengthM) - (b.lengthM === null ? Infinity : b.lengthM) || a.colorName.localeCompare(b.colorName));
  }

  /** Predicate for cords matching `query` (every word occurs in its label, notes, device, inlet, PDU, outlet, grid or cord type), or null for an empty query. */
  function cordMatcher(project, query, ctx0) {
    const words = M.queryWords(query);
    if (!words.length) return null;
    const ctx = ctx0 || context(project);
    return (cord) => {
      const r = describe(project, cord, ctx);
      const text = [cord.label, cord.notes, r.device ? r.device.name : '', cord.inlet.inlet, r.pdu ? r.pdu.name : '', cord.outlet.outlet, r.grid ? r.grid.name : '', r.type ? r.type.name : '']
        .join(' ')
        .toLowerCase();
      return words.every((w) => text.includes(w));
    };
  }

  // ----------------------------------------------------------------- series

  /**
   * Plans cords for the inlets without one of the devices `deviceIds`,
   * from the top of each rack down. The PDUs of the rack (by slot) take
   * turns: inlet 1 starts at the first, inlet 2 at the second and so on,
   * around again when the device has more inlets than the rack has PDUs.
   * Of the PDUs with outlets that a cord type joins to the inlet, it goes
   * to the grid that feeds the device the least (a PDU without a grid
   * counts for itself), by the cords in the plan and the ones planned
   * here: a device without cords gets inlet 1 on the first PDU and inlet
   * 2 on the second, and one with a cord gets its other inlet on another
   * grid. On that grid it takes a PDU with a free outlet, the one with
   * the fewest cords of the device first, and there the free outlet in
   * the fuse group with the least load planned so far. An inlet is left
   * out, with the reason, rather than put on a grid that feeds the device
   * more. Returns { items: [{ inlet, outlet }], skipped: [{ device,
   * inlet, why }] }; the plan is not changed.
   */
  function planSeries(project, deviceIds, ctx0) {
    const ctx = ctx0 || context(project);
    const ids = new Set(deviceIds);
    const items = [];
    const skipped = [];
    const taken = new Set();
    // Planned watts per fuse group ("pdu|fuse"), from the cords in the plan and the ones planned here.
    const planned = new Map();
    const load = loads(project, ctx);
    for (const p of load.pdus) for (const ph of p.phases) for (const f of ph.fuses) planned.set(key(p.pdu.id, f.fuse.name), f.value.upW);
    const byRack = new Map();
    for (const p of pdus(project)) {
      const list = byRack.get(p.loc.rack);
      if (list) list.push(p);
      else byRack.set(p.loc.rack, [p]);
    }
    // The outlets of a PDU that a cord type joins to an inlet (by PDU type and inlet connector), and the free ones of them.
    const fits = new Map();
    const fitting = (pdu, inlet) => {
      const k = key(pdu.type, inlet.connector);
      if (!fits.has(k)) fits.set(k, ctx.info(pdu.type).outlets.filter((o) => fittingTypes(project, o.connector, inlet.connector).length));
      return fits.get(k);
    };
    const freeOn = (pdu, inlet) => fitting(pdu, inlet).filter((o) => !ctx.byOutlet.has(key(pdu.id, o.name)) && !taken.has(key(pdu.id, o.name)));
    // What feeds a device through a PDU: its grid, or the PDU itself when it has none.
    const feedOf = (pdu) => (pdu.grid ? `grid ${pdu.grid}` : `pdu ${pdu.id}`);
    for (const d of M.sortedDevices(project)) {
      if (!ids.has(d.id) || d.loc.kind === 'pdu') continue;
      const inlets = ctx.info(d.type).inlets;
      const rackPdus = byRack.get(d.loc.rack) || [];
      const share = inlets.length ? M.powerOf(project, d) / inlets.length : 0;
      // The cords of the device on each feed and on each PDU, in the plan and planned here.
      const onFeed = new Map();
      const onPdu = new Map();
      const cordsOn = (pdu) => [onFeed.get(feedOf(pdu)) || 0, onPdu.get(pdu.id) || 0];
      const claim = (pdu) => {
        const [feed, own] = cordsOn(pdu);
        onFeed.set(feedOf(pdu), feed + 1);
        onPdu.set(pdu.id, own + 1);
      };
      for (const inlet of inlets) {
        const cord = ctx.byInlet.get(key(d.id, inlet.name));
        const pdu = cord ? ctx.devices.get(cord.outlet.device) : null;
        if (pdu) claim(pdu);
      }
      inlets.forEach((inlet, i) => {
        if (ctx.byInlet.has(key(d.id, inlet.name))) return;
        if (!rackPdus.length) return void skipped.push({ device: d, inlet: inlet.name, why: 'its rack has no PDU' });
        const conn = connLabel(inlet.connector);
        // The PDUs in turn from the one of the inlet's number, those with outlets for the inlet only.
        const turn = rackPdus.map((_, k) => rackPdus[(i + k) % rackPdus.length]).filter((x) => fitting(x, inlet).length);
        if (!turn.length) return void skipped.push({ device: d, inlet: inlet.name, why: `no cord type joins a ${conn} inlet to an outlet of its rack’s PDUs` });
        // The feed with the fewest cords of the device, the first in turn of them; of its PDUs one with a free outlet, then the one with the fewest cords of the device.
        const fewest = Math.min(...turn.map((x) => cordsOn(x)[0]));
        const feed = feedOf(turn.find((x) => cordsOn(x)[0] === fewest));
        const rank = (x) => (freeOn(x, inlet).length ? 0 : L.inlets + 1) + cordsOn(x)[1];
        const pdu = turn.filter((x) => feedOf(x) === feed).reduce((a, b) => (rank(b) < rank(a) ? b : a));
        const t = ctx.info(pdu.type);
        const free = freeOn(pdu, inlet);
        if (!free.length) return void skipped.push({ device: d, inlet: inlet.name, why: `${pdu.name} has no free outlet that fits a ${conn} inlet` });
        const fuseOf = (o) => (t.groups.get(o.name) || {}).fuse;
        const weight = (o) => {
          const f = fuseOf(o);
          return f ? planned.get(key(pdu.id, f.name)) || 0 : 0;
        };
        const best = free.reduce((a, b) => (weight(b) < weight(a) ? b : a));
        taken.add(key(pdu.id, best.name));
        const f = fuseOf(best);
        if (f) planned.set(key(pdu.id, f.name), weight(best) + share);
        claim(pdu);
        items.push({ inlet: { device: d.id, inlet: inlet.name }, outlet: { device: pdu.id, outlet: best.name } });
      });
    }
    return { items, skipped };
  }

  /** Adds the cords of a plan from planSeries, labeled in series. Returns { cords } or { error } with the plan unchanged. */
  function connectSeries(project, items) {
    const before = (project.powerCords || []).slice();
    const cords = [];
    for (const it of items) {
      const r = connect(project, it);
      if (r.error) {
        project.powerCords = before;
        return { error: r.error };
      }
      cords.push(r.cord);
    }
    return { cords };
  }

  return {
    UNIT_M,
    ACROSS_M,
    SLACK_M,
    NO_GRID_COLOR,
    UP,
    fmtW,
    fmtA,
    fmtKw,
    fmtM,
    context,
    cordById,
    pdus,
    cordsWithin,
    addGrid,
    updateGrid,
    deleteGrid,
    moveGrid,
    setGrid,
    gridUse,
    setPowerSettings,
    cordTypeUse,
    addCordType,
    updateCordType,
    deleteCordType,
    moveCordType,
    draftCord,
    checkConnect,
    connect,
    updateCord,
    disconnect,
    unplug,
    typeChangeImpact,
    pduSpan,
    neededLength,
    stockLength,
    fittingTypes,
    describe,
    scenarios,
    scenarioPhrase,
    loads,
    cordW,
    cordDownW,
    outletsOf,
    checks,
    typesWithoutInlets,
    scheduleRows,
    sortCords,
    groupCords,
    orderList,
    cordMatcher,
    planSeries,
    connectSeries,
  };
});
