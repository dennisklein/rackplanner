/*
 * Rackplanner: the Cabling workspace.
 *
 * Everything the Cabling workspace shows and does, next to the Racks
 * workspace in js/app.js: its state (the cables, port or devices selected,
 * the network in focus, the cable type armed for new cables, a connection
 * being made), the left panel (cable types and networks), the views of the
 * stage (Elevation, Port map, Schedule, Fabric), the inspectors, the
 * Connect series and network dialogs, and its keyboard, search and export
 * handling.
 *
 * app.js creates it once with create(ctx), handing over what it needs from
 * the app (the plan, commit and undo, render, dialogs, toasts, helpers),
 * and calls the hooks it returns at its dispatch points (render, prune,
 * keyboard, search, open, export) while ui.workspace is 'cabling'.
 */
(function () {
  'use strict';

  const M = window.RP.model;
  const C = window.RP.cabling;
  const IO = window.RP.io;

  const NONE = '__none'; // the cables without a network, as a network to focus or filter
  const SCOPES = ['row', 'floor', 'plan'];
  const GROUPS = [
    ['route', 'By route'],
    ['network', 'By network'],
    ['device', 'By device'],
    ['type', 'By cable type'],
  ];
  // Jacket colors of the cable drawings in the left panel; direct cables take the ink color of the theme.
  const JACKET = { cat6: '#5f86b3', cat6a: '#5f86b3', cat8: '#4a6f9e', aoc: '#e2a23b', om3: '#3fb7c9', om4: '#3fb7c9', om5: '#7fb83a', os2: '#e3c43c' };

  /**
   * Builds the workspace. `ctx` (from app.js): project() → the open plan;
   * ui, prefs, savePrefs; el (svg, canvas, inspector, armedHint, zoom,
   * floormap); commit(mutate, opts), commitAdd(make), undo(); render(opts),
   * renderStage(), renderInspector() (keeps focus on a field drawn again);
   * setRow(rowId, opts), currentRow(); toast(msg, opts),
   * openDialog(dlg), showError(sel, msg), confirmDialog(o), reportWarnings(
   * title, sub, list), renderSwatches(container, name, value, onChange),
   * openCatalog(tab); download(name, blob), fileBase(rowScoped);
   * setWorkspace(ws); keepFocus(container, fn); measure(text, font) for
   * the drawings, applyZoom() and fitWidth() of the stage's svg; esc,
   * icon, plural.
   */
  function create(ctx) {
    const { ui, prefs, el, esc, icon, plural, toast } = ctx;
    const project = () => ctx.project();
    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
    const shortRack = (name) => String(name).replace(/^rack\s+/i, '');
    const connLabel = (id) => (M.connectorById(id) || { label: id }).label;
    const portSpec = (pt) => `${connLabel(pt.connector)}${pt.speedGbps ? ' ' + C.shortSpeed(pt.speedGbps) : ''}`;
    /** Parts of a line joined by dots, which are where it breaks: a number keeps its unit, a plug its speed ("4.9 m", "QSFP56 200G"). */
    const dotLine = (parts) => parts.filter(Boolean).map((x) => x.replace(/ /g, '\u00a0')).join(' · ');
    /** "4.6 m": a needed length rounded up to 0.1 m. */
    const needText = (m) => C.fmtM(Math.ceil(m * 10 - 1e-6) / 10, 1);
    const host = $('#cab-host');

    // ------------------------------------------------------------ state

    Object.assign(ui, {
      cabSel: null, // { kind: 'cables', ids } | { kind: 'devices', ids } | { kind: 'port', device, port }
      focusNetwork: null, // network id, NONE for the cables without one, or null
      hoverNetwork: null,
      cabType: 'auto', // cable type armed for new cables: 'auto' or a cable type id
      pending: null, // the first port of a connection being made, and the legs set of a breakout cable: { device, port, legs: [{ device, port }] }
    });
    if (!SCOPES.includes(prefs.cabScope)) prefs.cabScope = 'row';
    if (!GROUPS.some(([k]) => k === prefs.cabGroup)) prefs.cabGroup = 'route';

    /** The schedule's own state for this session: its filters, the groups folded, the anchor of Shift-click ranges (the row clicked last: { id, key, at }), and what is drawn. */
    const sched = { filter: '', hidden: new Set(), collapsed: new Set(), anchor: null, visible: [], drawn: null, items: null, from: 0, to: 0, tops: null, marked: new Set(), chips: null, bom: null };

    /** A label or notes being typed on a large plan: `hold` while a keystroke commits, `timer` till the schedule follows. */
    const typing = { hold: false, timer: null };
    /** The schedule's filter typed on a large plan, till typing pauses and it applies. */
    let filterTimer = null;
    /** Applies the filter text typed and still waiting, without drawing (the caller draws). */
    function applyFilter() {
      clearTimeout(filterTimer);
      filterTimer = null;
      const f = $('#sc-filter');
      if (f) sched.filter = f.value;
    }
    /** Drops the filter text still waiting, for a filter set from elsewhere. */
    function dropFilter() {
      clearTimeout(filterTimer);
      filterTimer = null;
    }

    // ------------------------------------------------------------ cached lookups

    /**
     * Lookups for the plan as it is: the cabling context, descriptions of
     * its cables, the cable at each port and device places. A commit makes
     * a new plan object, which starts a new cache.
     */
    const cache = { project: null };
    function fresh() {
      const p = project();
      if (cache.project !== p) {
        cache.project = p;
        cache.ctx = C.context(p, { memo: true });
        cache.where = new Map();
        cache.index = null;
        cache.byId = null;
        cache.busiest = undefined;
        cache.fabrics = null;
        cache.fabricNets = null;
      }
      return cache;
    }
    /** C.describe of a cable of the plan, once per plan (the context keeps it). */
    function describe(c) {
      return C.describe(project(), c, fresh().ctx);
    }
    function cableIndex() {
      const k = fresh();
      return k.index || (k.index = C.cableIndex(project()));
    }
    function cableById(id) {
      const k = fresh();
      if (!k.byId) k.byId = new Map(project().cables.map((c) => [c.id, c]));
      return k.byId.get(id) || null;
    }
    function portsOf(d) {
      const k = fresh();
      const ports = k.ctx.ports;
      if (!ports.has(d.type)) ports.set(d.type, new Map(M.expandPorts(M.typeOf(project(), d.type)).map((x) => [x.name, x])));
      return ports.get(d.type);
    }
    /** Where a device is: { pos, at: 'U24–27' | 'V1', short: 'A02 · U24–27', full: 'Rack A02 · U24–27' }. */
    function where(d) {
      const k = fresh();
      let w = k.where.get(d.id);
      if (w) return w;
      const pos = k.ctx.racks.get(d.loc.rack);
      const at = d.loc.kind === 'side' ? `V${d.loc.at + 1}` : M.formatSpan(...M.deviceSpan(project(), d));
      w = { pos, at, short: `${shortRack(pos.rack.name)} · ${at}`, full: `${pos.rack.name} · ${at}` };
      k.where.set(d.id, w);
      return w;
    }
    const deviceById = (id) => fresh().ctx.devices.get(id) || null;
    const netOf = (id) => (id ? fresh().ctx.networks.get(id) || null : null);
    const netKey = (c) => (netOf(c.network) ? c.network : NONE);
    const netColor = (id) => (netOf(id) ? netOf(id).color : 'var(--unassigned)');
    const netName = (id) => (netOf(id) ? netOf(id).name : 'No network');
    const endText = (e) => {
      const d = e && deviceById(e.device);
      return d ? `${d.name} ${e.port}` : '–';
    };
    const shortType = (t) => (t ? (C.MEDIA[t.media] || { short: t.name }).short : '–');

    // ------------------------------------------------------------ selection

    function selCableIds() {
      const s = ui.cabSel;
      return s && s.kind === 'cables' ? s.ids : [];
    }
    function hasSelection() {
      return !!ui.cabSel;
    }
    function clearSelection() {
      if (!ui.cabSel) return false;
      ui.cabSel = null;
      sched.anchor = null;
      ctx.render();
      return true;
    }
    /** Selects cables; `reveal` shows the first one in the schedule (its row, unfolded and let through the filters) and scrolls it into view. */
    function selectCables(ids, opts) {
      const list = [...new Set(ids)].filter((id) => cableById(id));
      const reveal = list.length && opts && opts.reveal && ui.cabView === 'schedule';
      if (reveal) showCable(cableById(list[0]));
      ui.cabSel = list.length ? { kind: 'cables', ids: list } : null;
      ctx.render();
      if (reveal) revealCable(list[0]);
    }
    function selectDevices(ids) {
      const list = [...new Set(ids)].filter((id) => deviceById(id));
      ui.cabSel = list.length ? { kind: 'devices', ids: list } : null;
      ctx.render();
    }
    function selectPort(device, port) {
      ui.cabSel = { kind: 'port', device, port };
      ctx.render();
    }
    /** Shows the row of a device, keeping the workspace. */
    function followDevice(id) {
      const d = deviceById(id);
      const pos = d && fresh().ctx.racks.get(d.loc.rack);
      if (pos && pos.row.id !== ui.rowId) ctx.setRow(pos.row.id, { render: false });
    }

    /** Drops what no longer exists after a change or an undo. */
    function prune() {
      const p = project();
      const s = ui.cabSel;
      if (s && s.kind === 'cables') {
        const ids = s.ids.filter((id) => cableById(id));
        ui.cabSel = ids.length ? (ids.length === s.ids.length ? s : { kind: 'cables', ids }) : null;
      } else if (s && s.kind === 'devices') {
        const ids = s.ids.filter((id) => deviceById(id));
        ui.cabSel = ids.length ? (ids.length === s.ids.length ? s : { kind: 'devices', ids }) : null;
      } else if (s && s.kind === 'port') {
        const d = deviceById(s.device);
        if (!d || !portsOf(d).has(s.port)) ui.cabSel = null;
      } else if (s) ui.cabSel = null;
      const valid = (n) => !n || (n === NONE ? p.cables.some((c) => !netOf(c.network)) : !!netOf(n));
      if (!valid(ui.focusNetwork)) ui.focusNetwork = null;
      if (!valid(ui.hoverNetwork)) ui.hoverNetwork = null;
      if (ui.cabType !== 'auto' && !M.cableTypeById(p, ui.cabType)) ui.cabType = 'auto';
      // A connection being made keeps the ports that are still there and free.
      const freePort = (e) => {
        const d = deviceById(e.device);
        return !!d && portsOf(d).has(e.port) && !cableIndex().has(`${d.id}|${e.port}`);
      };
      // A leg armed to plug in ("Plug in…") keeps while its cable has it free; its head is the cable's own.
      const fill = ui.pending && ui.pending.fill;
      if (fill) {
        const c = cableById(fill.cable);
        if (!c || !Array.isArray(c.b) || c.b[fill.leg] || c.a.device !== ui.pending.device || c.a.port !== ui.pending.port) ui.pending = null;
      } else if (ui.pending && !freePort(ui.pending)) ui.pending = null;
      if (ui.pending && ui.pending.legs.some((e) => !freePort(e))) ui.pending = Object.assign({}, ui.pending, { legs: ui.pending.legs.filter(freePort) });
      if (sched.anchor && !cableById(sched.anchor.id)) sched.anchor = null;
      for (const k of sched.hidden) if (k !== NONE && !netOf(k)) sched.hidden.delete(k);
    }

    /** Forgets the state of the plan that was open: for another plan, or a plan replaced whole. */
    function reset() {
      Object.assign(ui, { cabSel: null, focusNetwork: null, hoverNetwork: null, cabType: 'auto', pending: null });
      fab.network = null;
      pm.rack = null;
      sched.filter = '';
      sched.hidden.clear();
      sched.collapsed.clear();
      sched.anchor = null;
      sched.drawn = null;
      sched.items = null;
      sched.scopeKey = null;
      dropFilter();
      const f = $('#sc-filter');
      if (f) f.value = '';
    }

    /** Cancels a connection being made; true when there was one. The inspector follows when it offered the leg being plugged in. */
    function cancelPending() {
      if (!ui.pending) return false;
      const fill = !!ui.pending.fill;
      ui.pending = null;
      ctx.render(fill ? {} : { inspector: false });
      return true;
    }
    /** Leaves the network in focus; true when there was one. */
    function clearFocus() {
      if (!ui.focusNetwork) return false;
      ui.focusNetwork = null;
      renderAfterFocus();
      return true;
    }
    /** Draws what the network in focus changes: the schedule and the panel, and the inspector of several cables, which lists them in the schedule's order. */
    function renderAfterFocus() {
      const was = fab.shown;
      ctx.render(selCableIds().length > 1 || ui.cabView === 'fabric' ? {} : { inspector: false });
      // The fabric follows the network in focus: another network is another drawing, which opens fitted, as the view does.
      if (ui.workspace === 'cabling' && ui.cabView === 'fabric' && fab.shown !== was) ctx.fitWidth();
    }

    // ------------------------------------------------------------ views

    /** The views of the stage by id: `kind` 'svg' draws into el.svg (zoom and pan apply), 'html' into the host next to it. */
    const VIEWS = {
      elevation: { id: 'elevation', kind: 'svg', render: renderElevation },
      ports: { id: 'ports', kind: 'html', render: renderPortMap },
      schedule: { id: 'schedule', kind: 'html', render: renderSchedule },
      fabric: { id: 'fabric', kind: 'svg', render: renderFabric },
    };
    if (!VIEWS[prefs.cabView]) prefs.cabView = 'elevation';
    if (prefs.cabSide !== 'front') prefs.cabSide = 'rear';
    if (prefs.cabPortsOf !== 'all') prefs.cabPortsOf = 'switches';
    if (typeof prefs.cabGrouped !== 'boolean') prefs.cabGrouped = true;
    ui.cabView = prefs.cabView;
    const view = () => VIEWS[ui.cabView] || VIEWS.schedule;
    /** What the stage shows: 'svg', a drawing that zooms, or 'html'; the fabric of a plan without cables says so in HTML. */
    const stageKind = () => (ui.cabView === 'fabric' && !fabricNetworks().length ? 'html' : view().kind);
    /** Whether the stage shows a drawing that zooms (an svg view). */
    const zoomable = () => stageKind() === 'svg';

    /** Shows another view; a drawing that zooms opens fitted to the stage's width, the port map at the rack of the device selected. */
    function setView(id, opts) {
      if (!VIEWS[id] || id === ui.cabView) return;
      ui.cabView = id;
      prefs.cabView = id;
      ctx.savePrefs();
      ui.pending = null;
      if (id === 'ports') pm.rack = startRack();
      ctx.render();
      if (zoomable() && !(opts && opts.keepZoom)) ctx.fitWidth();
    }
    $('#cab-toggle').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cab-view]');
      if (b) setView(b.dataset.cabView);
    });

    // ------------------------------------------------------------ drawings: what they show

    const CR = window.RP.cablingRender;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    /** "dev|port" (data-port) to { device, port }: port names never hold "|" (M.portName drops it), but a device id from a plan file may, so the key splits at its last "|". */
    const splitKey = (key) => {
      const i = key.lastIndexOf('|');
      return { device: key.slice(0, i), port: key.slice(i + 1) };
    };
    const keyOf = (e) => `${e.device}|${e.port}`;
    const armedType = () => (ui.cabType === 'auto' ? null : M.cableTypeById(project(), ui.cabType));

    /** Ids of the cables with an end at any of the devices `ids`. */
    function cablesOfDevices(ids) {
      const set = new Set(ids);
      return project().cables.filter((c) => M.cableEnds(c).some((x) => set.has(x.end.device))).map((c) => c.id);
    }
    /** The selection as the drawings take it (cabling-render's selectedCables). */
    function drawnSelection() {
      const s = ui.cabSel;
      if (!s) return null;
      if (s.kind === 'cables') return { kind: 'cables', ids: s.ids };
      if (s.kind === 'port') return { kind: 'port', deviceId: s.device, port: s.port };
      return s.ids.length === 1 ? { kind: 'device', id: s.ids[0] } : { kind: 'cables', ids: cablesOfDevices(s.ids) };
    }
    /** The network the drawings bring forward: the one hovered or in focus; '' for the cables without one. */
    function drawnFocus() {
      const f = ui.hoverNetwork || ui.focusNetwork;
      return f ? (f === NONE ? '' : f) : null;
    }
    let searchMatcher = { project: null, query: null, ids: null };
    /** Ids of the cables that the search box (or `query`) matches, or null without a search. */
    function searchHits(query) {
      const q = (query === undefined ? ui.query || '' : query).trim();
      if (!q) return null;
      const p = project();
      if (searchMatcher.project !== p || searchMatcher.query !== q) {
        const match = C.cableMatcher(p, q, fresh().ctx);
        searchMatcher = { project: p, query: q, ids: match ? new Set(p.cables.filter(match).map((c) => c.id)) : null };
      }
      return searchMatcher.ids;
    }

    /** Draws a drawing into the stage's svg, at the zoom it has. */
    function setScene(out, label) {
      ui.sceneW = out.width;
      ui.sceneH = out.height;
      el.svg.setAttribute('viewBox', `0 0 ${out.width} ${out.height}`);
      el.svg.setAttribute('aria-label', label);
      el.svg.innerHTML = out.body;
      ctx.applyZoom();
    }

    /** Rings the legs of a breakout cable being made, which the drawings do not know of. */
    function markLegs(root) {
      const pd = ui.pending;
      if (!pd || !pd.legs.length || !root) return;
      for (const leg of pd.legs) {
        const g = root.querySelector(`[data-port="${CSS.escape(keyOf(leg))}"]`);
        const shape = g && g.firstElementChild;
        if (!shape || !shape.getBBox) continue;
        let b;
        try {
          b = shape.getBBox();
        } catch (err) {
          continue;
        }
        const r = document.createElementNS(SVG_NS, 'rect');
        const at = { x: b.x - 3, y: b.y - 3, width: b.width + 6, height: b.height + 6, rx: 2.5, class: 'leg-ring', 'pointer-events': 'none' };
        for (const [k, v] of Object.entries(at)) r.setAttribute(k, typeof v === 'number' ? Math.round(v * 10) / 10 : v);
        g.parentNode.appendChild(r);
      }
    }

    /** Scrolls the stage so that the box `b` of the drawing (in its units) is in view, in the middle when it was not. */
    function revealBox(b) {
      if (!b) return;
      const c = el.canvas;
      const s = el.svg.getBoundingClientRect();
      const r = c.getBoundingClientRect();
      const z = ui.zoom;
      const x1 = s.left + b.x * z;
      const y1 = s.top + b.y * z;
      const x2 = x1 + Math.max(1, b.w) * z;
      const y2 = y1 + Math.max(1, b.h) * z;
      const m = 40;
      if (x1 < r.left + m || x2 > r.right - m) c.scrollLeft += (x1 + x2) / 2 - (r.left + r.right) / 2;
      if (y1 < r.top + m || y2 > r.bottom - m) c.scrollTop += Math.min((y1 + y2) / 2 - (r.top + r.bottom) / 2, y1 - r.top - m);
    }

    // ------------------------------------------------------------ elevation

    /** The elevation drawn last: its layout (boxes of devices, ports and cables), row and side. */
    const elev = { layout: null, rowId: null, side: null };

    function renderElevation() {
      const pos = ctx.currentRow();
      const out = CR.elevation(project(), {
        rowId: pos.row.id,
        side: prefs.cabSide,
        theme: ui.theme,
        measure: ctx.measure,
        interactive: true,
        selected: drawnSelection(),
        focusNetwork: drawnFocus(),
        pending: ui.pending,
        highlight: searchHits(),
      });
      Object.assign(elev, { layout: out.layout, rowId: out.rowId, side: out.side });
      setScene(out, `Cabling of ${pos.floor.name}, ${pos.row.name}, seen from the ${out.side}`);
      markLegs(el.svg);
    }

    function setSide(side) {
      if (side === prefs.cabSide || (side !== 'front' && side !== 'rear')) return;
      prefs.cabSide = side;
      ctx.savePrefs();
      // The inspector too: whether it offers Show in elevation depends on the side drawn.
      ctx.render();
      renderSides();
    }
    const sidesEl = $('#cab-sides');
    function renderSides() {
      for (const b of $$('[data-cab-side]', sidesEl)) b.setAttribute('aria-pressed', String(b.dataset.cabSide === prefs.cabSide));
    }
    sidesEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cab-side]');
      if (b) setSide(b.dataset.cabSide);
    });

    /**
     * "Show in elevation": the elevation of the row and side where a cable
     * (an end in the row shown, else its head) or a device is seen, scrolled
     * to it.
     */
    function showInElevation(o) {
      const p = project();
      const k = fresh();
      let deviceId = null;
      let side = prefs.cabSide;
      if (o.cable) {
        const c = cableById(o.cable);
        if (!c) return;
        const ends = M.cableEnds(c).map((x) => x.end).filter((e) => deviceById(e.device));
        const here = ends.find((e) => k.ctx.racks.get(deviceById(e.device).loc.rack).row.id === ui.rowId) || ends[0];
        if (!here) return;
        deviceId = here.device;
        side = C.portFace(p, here, k.ctx) || side;
      } else {
        const d = deviceById(o.device);
        if (!d) return;
        deviceId = d.id;
        // The side where most of its ports are seen.
        const faces = { front: 0, rear: 0 };
        for (const name of portsOf(d).keys()) faces[C.portFace(p, { device: d.id, port: name }, k.ctx) || 'rear']++;
        if (faces.front !== faces.rear) side = faces.front > faces.rear ? 'front' : 'rear';
      }
      const d = deviceById(deviceId);
      const row = k.ctx.racks.get(d.loc.rack).row.id;
      const entering = ui.cabView !== 'elevation';
      if (row !== ui.rowId) ctx.setRow(row, { render: false });
      prefs.cabSide = side;
      ui.cabView = 'elevation';
      prefs.cabView = 'elevation';
      ctx.savePrefs();
      // Opening the elevation stops a connection being made, as another view does; within it, as another row does not.
      if (entering) ui.pending = null;
      ctx.render();
      if (entering) ctx.fitWidth();
      const L = elev.layout;
      revealBox(L && (o.cable ? L.cables.get(o.cable) : L.devices.get(deviceId)));
    }

    // ------------------------------------------------------------ port map

    /** The port map's rack (an id), and the width it was drawn for. */
    const pm = { rack: null, shown: null, width: 0 };
    /** Whether the pointer is a finger: ports then need more room. */
    const coarse = () => !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

    /**
     * The rack the port map starts at: the selected device's (its row is
     * shown), the end of the selected cable that it draws (a switch's, unless
     * it shows every device; in the row shown first), else the first rack of
     * the row shown that it draws something of.
     */
    function startRack() {
      const s = ui.cabSel;
      let id = null;
      if (s && s.kind === 'port') id = s.device;
      else if (s && s.kind === 'devices') id = s.ids[0];
      else if (s && s.kind === 'cables') {
        const c = cableById(s.ids[0]);
        const ends = c ? M.cableEnds(c).map((x) => x.end.device).filter(deviceById) : [];
        const drawn = (dev) => prefs.cabPortsOf === 'all' || C.isSwitch(project(), deviceById(dev));
        const here = (dev) => fresh().ctx.racks.get(deviceById(dev).loc.rack).row.id === ui.rowId;
        id = ends.find((dev) => drawn(dev) && here(dev)) || ends.find(drawn) || ends.find(here) || ends[0] || null;
      }
      const d = id && deviceById(id);
      if (d) {
        followDevice(d.id);
        return d.loc.rack;
      }
      return firstRack(ctx.currentRow().row);
    }
    /** The first rack of a row that the port map draws something of (a switch, unless it shows every device), else its first rack; null without racks. */
    function firstRack(row) {
      if (!row.racks.length) return null;
      const p = project();
      const all = prefs.cabPortsOf === 'all';
      const has = (rack) => p.devices.some((d) => d.loc.rack === rack.id && d.type !== M.RESERVED.id && (all || C.isSwitch(p, d)));
      return (row.racks.find(has) || row.racks[0]).id;
    }
    /** The port map's rack, in the row shown: the first of the row it draws something of when the row changed. */
    function pmRack() {
      const p = project();
      const pos = pm.rack && M.locateRack(p, pm.rack);
      if (pos && pos.row.id === ui.rowId) return pos;
      pm.rack = firstRack(ctx.currentRow().row);
      return pm.rack ? M.locateRack(p, pm.rack) : null;
    }
    /** Shows another rack in the port map, and its row in the nav. */
    function setRack(id) {
      const pos = M.locateRack(project(), id);
      if (!pos) return;
      pm.rack = id;
      if (pos.row.id !== ui.rowId) ctx.setRow(pos.row.id, { render: false });
      ctx.render();
    }

    /** "swp1–48 · 48 × RJ45 1G, swp49–52 · 4 × SFP+ 10G, bmc · RJ45 1G": a device's port groups as its type has them. */
    function portSummary(d) {
      const byGroup = new Map();
      for (const pt of portsOf(d).values()) {
        if (!byGroup.has(pt.group)) byGroup.set(pt.group, []);
        byGroup.get(pt.group).push(pt);
      }
      const type = M.typeOf(project(), d.type);
      return [...byGroup]
        .map(([gi, list]) => {
          const g = type.ports[gi];
          const first = list[0].name;
          const last = list[list.length - 1].name;
          const range = list.length < 2 ? first : g && last.startsWith(g.name) && first.startsWith(g.name) ? `${first}–${last.slice(g.name.length)}` : `${first}–${last}`;
          return `${range} · ${list.length > 1 ? `${list.length} × ` : ''}${portSpec(list[0])}`;
        })
        .join(', ');
    }

    function portCard(d, plate, current, faded) {
      const type = M.typeOf(project(), d.type);
      const cl = M.clusterById(project(), d.cluster);
      const ports = portsOf(d);
      const idx = cableIndex();
      let used = 0;
      for (const name of ports.keys()) if (idx.has(`${d.id}|${name}`)) used++;
      const w = where(d);
      const meta = [type.label, `${w.at}${d.loc.kind === 'side' ? ' (side slot)' : ''}`, ports.size ? portSummary(d) : 'no ports'].join(' · ');
      return (
        `<section class="pm-card${current ? ' is-current' : ''}${faded ? ' is-faded' : ''}" data-pm-dev="${esc(d.id)}">` +
        `<header class="pm-head"><span class="sw" style="--c:${cl ? cl.color : 'var(--unassigned)'}"></span>` +
        `<button type="button" class="pm-name" data-cab-select-device="${esc(d.id)}" title="Select ${esc(d.name)}">${esc(d.name)}</button>` +
        `<span class="pm-meta" title="${esc(meta)}">${esc(meta)}</span>` +
        (ports.size ? `<span class="pm-use" title="${esc(`${used} of ${plural(ports.size, 'port')} cabled`)}"><span class="fm-meter"><span style="width:${((used / ports.size) * 100).toFixed(1)}%"></span></span>${used} of ${ports.size}</span>` : '') +
        `<button type="button" class="btn sm" data-pm-series="${esc(d.id)}"${ports.size ? '' : ' disabled'} title="Connect many devices to the ports of ${esc(d.name)}">${icon('swap', 'ic-sm')}Connect series…</button></header>` +
        `<div class="pm-plate-wrap"><svg class="pm-plate" viewBox="0 0 ${plate.width} ${plate.height}" width="${plate.width}" height="${plate.height}" role="group" aria-label="${esc(`Ports of ${d.name}`)}">${plate.body}</svg></div></section>`
      );
    }

    function renderPortMap(box) {
      if (box.dataset.view !== 'ports') {
        box.dataset.view = 'ports';
        box.innerHTML = `<div class="pm-scroll" id="pm-scroll"><div class="pm" id="pm"></div></div>`;
        pm.shown = null;
      }
      const p = project();
      const scroll = $('#pm-scroll');
      const pos = pmRack();
      pm.width = scroll.clientWidth;
      if (!pos) {
        $('#pm').innerHTML = `<div class="cab-empty">${icon('ports')}<h2>No racks</h2><p>${esc(ctx.currentRow().row.name)} has no racks. Add racks to it in the Racks workspace.</p></div>`;
        return;
      }
      const rack = pos.rack;
      const all = prefs.cabPortsOf === 'all';
      const devs = M.sortedDevices(p, rack.id).filter((d) => d.type !== M.RESERVED.id && (all ? true : C.isSwitch(p, d)));
      // The port selected, the ends of the cables selected and the devices selected, in this rack: every end drawn is ringed.
      const s = ui.cabSel;
      const current = new Set();
      const selected = [];
      if (s && s.kind === 'port') {
        current.add(s.device);
        selected.push({ deviceId: s.device, port: s.port });
      } else if (s && s.kind === 'devices') s.ids.forEach((id) => current.add(id));
      else if (s && s.kind === 'cables') {
        for (const id of s.ids) {
          const c = cableById(id);
          if (!c) continue;
          for (const x of M.cableEnds(c)) {
            const d = deviceById(x.end.device);
            if (!d || d.loc.rack !== rack.id) continue;
            current.add(d.id);
            selected.push({ deviceId: d.id, port: x.end.port });
          }
        }
      }
      if (ui.pending) current.add(ui.pending.device);
      const width = Math.max(520, pm.width - 42);
      const focus = drawnFocus();
      const plates = new Map(
        CR.portMap(
          p,
          devs.map((d) => d.id),
          // Ports far enough apart for their numbers, and for a finger on a touch screen; the card scrolls sideways when they need it.
          { theme: ui.theme, measure: ctx.measure, width, minPitch: coarse() ? 28 : 16, selected, pending: ui.pending, focusNetwork: focus, highlight: searchHits() }
        ).map((x) => [x.deviceId, x])
      );
      // A device with no cable in the network brought forward fades too.
      const idx = cableIndex();
      const faded = (d) =>
        focus !== null && ![...portsOf(d).keys()].some((name) => {
          const hit = idx.get(`${d.id}|${name}`);
          return hit && (netKey(hit.cable) === NONE ? '' : hit.cable.network) === focus;
        });

      const racks = M.allRacks(p);
      const at = racks.findIndex((r) => r.rack.id === rack.id);
      let options = '';
      let group = null;
      for (const r of racks) {
        if (r.row !== group) {
          if (group) options += '</optgroup>';
          group = r.row;
          options += `<optgroup label="${esc(`${r.floor.name} · ${r.row.name}`)}">`;
        }
        options += `<option value="${esc(r.rack.id)}"${r.rack.id === rack.id ? ' selected' : ''}>${esc(r.rack.name)}</option>`;
      }
      options += '</optgroup>';
      const nets = new Set();
      for (const d of devs) for (const name of portsOf(d).keys()) {
        const hit = idx.get(`${d.id}|${name}`);
        if (hit) nets.add(netKey(hit.cable));
      }
      const legend = p.networks
        .filter((n) => nets.has(n.id))
        .map((n) => [n.name, n.color])
        .concat(nets.has(NONE) ? [['No network', 'var(--unassigned)']] : [])
        .map(([name, color]) => `<span class="pm-key"><span class="sw" style="--c:${color}"></span>${esc(name)}</span>`)
        .join('');
      const what = all ? 'devices' : 'switches';
      const html =
        `<div class="pm-top"><div class="fm-title"><h2>${esc(`${rack.name} · ${what}`)}</h2>` +
        `<p>${esc(`${pos.floor.name} · ${pos.row.name}. Above and below each port: the device at the other end; a dot marks one in another rack.`)}</p></div>` +
        `<div class="pm-tools"><div class="seg" role="group" aria-label="Devices shown">` +
        `<button type="button" data-pm-filter="switches" aria-pressed="${!all}">Switches</button><button type="button" data-pm-filter="all" aria-pressed="${all}">All devices</button></div>` +
        `<div class="row-nav pm-racks"><button class="btn icon sm" type="button" data-pm-step="-1" title="Previous rack" aria-label="Previous rack"${at <= 0 ? ' disabled' : ''}>${icon('left')}</button>` +
        `<label class="pm-pick">${icon('rack', 'ic-sm')}<span class="sr-only">Rack</span><select data-pm-rack id="pm-rack">${options}</select>${icon('chevron', 'ic-sm')}</label>` +
        `<button class="btn icon sm" type="button" data-pm-step="1" title="Next rack" aria-label="Next rack"${at >= racks.length - 1 ? ' disabled' : ''}>${icon('right')}</button></div></div></div>` +
        `<div class="pm-legend">${legend}<span class="pm-key"><span class="sw sw-free"></span>Free</span><span class="pm-key"><i class="pm-dot"></i>Other rack</span>` +
        `<span class="pm-hint"><span class="hint-pointer">Click a free port, then another; or drag from one to the other.</span><span class="hint-touch">Tap a free port, then another.</span></span></div>` +
        (devs.length
          ? devs.map((d) => portCard(d, plates.get(d.id), current.has(d.id), faded(d))).join('')
          : `<div class="pm-none"><p>${esc(all ? `${rack.name} holds no devices.` : `${rack.name} holds no switches.`)}</p>${all ? '' : `<button type="button" class="btn sm" data-pm-filter="all">Show all devices</button>`}</div>`);
      // A faceplate wider than its card keeps where it was scrolled to, in the same rack.
      const sideways = new Map();
      if (pm.shown === rack.id) for (const w of $$('.pm-card[data-pm-dev] .pm-plate-wrap', $('#pm'))) if (w.scrollLeft) sideways.set(w.closest('.pm-card').dataset.pmDev, w.scrollLeft);
      ctx.keepFocus($('#pm'), () => ($('#pm').innerHTML = html));
      for (const [id, left] of sideways) {
        const w = $(`.pm-card[data-pm-dev="${CSS.escape(id)}"] .pm-plate-wrap`, $('#pm'));
        if (w) w.scrollLeft = left;
      }
      markLegs($('#pm'));
      // Another rack opens at its top.
      if (pm.shown !== rack.id) {
        scroll.scrollTop = 0;
        pm.shown = rack.id;
      }
    }

    /** The cables at the ports the port map shows. */
    function portMapCables() {
      const idx = cableIndex();
      const out = [];
      for (const card of $$('.pm-card[data-pm-dev]', host)) {
        const d = deviceById(card.dataset.pmDev);
        if (d) for (const name of portsOf(d).keys()) {
          const hit = idx.get(`${d.id}|${name}`);
          if (hit) out.push(hit.cable.id);
        }
      }
      return out;
    }

    host.addEventListener('click', (e) => {
      if (ui.cabView !== 'ports') return;
      const t = e.target;
      const f = t.closest('[data-pm-filter]');
      if (f) {
        prefs.cabPortsOf = f.dataset.pmFilter;
        ctx.savePrefs();
        return ctx.renderStage();
      }
      const step = t.closest('[data-pm-step]');
      if (step) {
        const racks = M.allRacks(project());
        const at = racks.findIndex((r) => r.rack.id === pm.rack) + Number(step.dataset.pmStep);
        if (at >= 0 && at < racks.length) setRack(racks[at].rack.id);
        return;
      }
      const series = t.closest('[data-pm-series]');
      if (series) return openConnect({ series: true, to: series.dataset.pmSeries });
      const dev = t.closest('.pm-name[data-cab-select-device]');
      if (dev) return selectDevices([dev.dataset.cabSelectDevice]);
    });
    host.addEventListener('change', (e) => {
      if (e.target.id === 'pm-rack') setRack(e.target.value);
    });
    // The port map draws again for a new width, once a frame.
    let pmFrame = 0;
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (pmFrame || ui.workspace !== 'cabling' || ui.cabView !== 'ports') return;
        pmFrame = requestAnimationFrame(() => {
          pmFrame = 0;
          const s = $('#pm-scroll');
          if (s && Math.abs(s.clientWidth - pm.width) > 1 && ui.workspace === 'cabling' && ui.cabView === 'ports') ctx.renderStage();
        });
      }).observe(host);
    }

    // ------------------------------------------------------------ fabric

    /** The network picked for the fabric (null until one is picked: then the one in focus, else the busiest between switches), the one drawn last, its node groups as drawn and the box around its switches. */
    const fab = { network: null, shown: null, groups: [], switchBox: null };

    /** Networks with cables, by id (NONE for the cables without one), in the plan's order; once per plan. */
    function fabricNetworks() {
      const k = fresh();
      if (!k.fabricNets) {
        const p = project();
        const used = new Set(p.cables.map(netKey));
        k.fabricNets = p.networks.filter((n) => used.has(n.id)).map((n) => n.id);
        if (used.has(NONE)) k.fabricNets.push(NONE);
      }
      return k.fabricNets;
    }
    /** The network the fabric shows. */
    function fabricNetwork() {
      const list = fabricNetworks();
      if (fab.network && list.includes(fab.network)) return fab.network;
      if (ui.focusNetwork && list.includes(ui.focusNetwork)) return ui.focusNetwork;
      const k = fresh();
      if (k.busiest === undefined) {
        // The network with the most links between two switches, else the most cables.
        const p = project();
        const sw = new Map();
        const all = new Map();
        const isSw = (id) => {
          const d = deviceById(id);
          return !!d && C.isSwitch(p, d);
        };
        for (const c of p.cables) {
          const n = netKey(c);
          all.set(n, (all.get(n) || 0) + 1);
          if (M.cableEnds(c).every((x) => isSw(x.end.device))) sw.set(n, (sw.get(n) || 0) + 1);
        }
        const best = (m) => list.reduce((a, id) => ((m.get(id) || 0) > (m.get(a) || 0) ? id : a), list[0]);
        k.busiest = list.length ? (sw.size ? best(sw) : best(all)) : null;
      }
      return k.busiest;
    }
    /** C.fabric of a network (NONE: the cables without one), once per plan. */
    function fabricOf(net) {
      const k = fresh();
      if (!k.fabrics) k.fabrics = new Map();
      if (!k.fabrics.has(net)) k.fabrics.set(net, C.fabric(project(), net === NONE ? null : net));
      return k.fabrics.get(net);
    }

    /** Devices at the ends of cables. */
    function endDevices(ids) {
      const out = new Set();
      for (const id of ids) {
        const c = cableById(id);
        if (c) for (const x of M.cableEnds(c)) out.add(x.end.device);
      }
      return [...out];
    }

    /** What the fabric drawn last was drawn from: drawn again only when any of it changes, not for each render of the app. */
    let fabricDrawn = null;
    function renderFabric() {
      const p = project();
      const net = fabricNetwork();
      const s = ui.cabSel;
      // Devices stand for cables here: the ends of the cables selected or matched by the search.
      const selected = s && s.kind === 'devices' ? s.ids : s && s.kind === 'port' ? [s.device] : s && s.kind === 'cables' ? endDevices(s.ids) : [];
      const hits = searchHits();
      const highlight = hits ? endDevices(hits) : null;
      const key = [net, prefs.cabGrouped, ui.theme, selected.slice().sort().join('\u0000'), highlight ? highlight.slice().sort().join('\u0000') : '-'].join('|');
      renderFabricBar(net);
      if (fabricDrawn && fabricDrawn.project === p && fabricDrawn.key === key && el.svg.dataset.drawn === 'fabric') return;
      const out = CR.fabric(p, net === NONE ? null : net, {
        theme: ui.theme,
        measure: ctx.measure,
        grouped: prefs.cabGrouped,
        selected,
        highlight,
        fabric: net ? fabricOf(net) : undefined,
        interactive: true,
      });
      fab.shown = net;
      fab.groups = out.groups;
      fab.switchBox = out.switchBox;
      setScene(out, `${netName(net === NONE ? null : net)} fabric`);
      el.svg.dataset.drawn = 'fabric';
      fabricDrawn = { project: p, key };
    }
    /** The fabric of a plan without cables: what to do instead of an empty drawing. */
    function renderFabricEmpty(box) {
      fab.shown = null;
      fab.groups = [];
      fab.switchBox = null;
      if (box.dataset.view === 'fabric-empty') return;
      box.dataset.view = 'fabric-empty';
      box.innerHTML =
        `<div class="cab-empty">${icon('fabric')}<h2>No cables yet</h2>` +
        `<p>The fabric draws how switches and nodes connect, network by network, once ports are connected: click two ports in the elevation or the port map, or add cables in the schedule.</p>` +
        `<div class="cab-empty-actions"><button type="button" class="btn sm" data-cab-view="elevation">${icon('rack', 'ic-sm')}Elevation</button>` +
        `<button type="button" class="btn sm" data-cab-view="schedule">${icon('table', 'ic-sm')}Schedule</button></div></div>`;
    }
    /**
     * After the fabric is fitted to the stage's width: a fabric still wider
     * than the stage (every device drawn) is scrolled to its switches,
     * which sit over the middle of the node tier.
     */
    function afterFit(width) {
      if (ui.cabView !== 'fabric' || !fab.switchBox) return;
      // Wider than the stage: known from the width fitted to, without reading the layout of the drawing just drawn.
      if (width !== undefined ? ui.sceneW * ui.zoom <= width + 1 : el.canvas.scrollWidth <= el.canvas.clientWidth + 1) return;
      revealBox(fab.switchBox);
    }

    const barEl = $('#cab-head');
    const noteEl = $('#cab-note');
    /**
     * The fabric's header: its title and sub line, the network picked and
     * Grouped | Every device. Drawn once and then changed in place, so that
     * the control just clicked stays (taking it out of the page while it
     * has focus would make the browser lay out the new drawing at once).
     */
    function renderFabricBar(net) {
      if (!barEl.querySelector('#fb-net')) {
        barEl.innerHTML =
          `<div class="fm-title"><h2 id="fb-title"></h2><p id="fb-sub"></p></div>` +
          `<div class="pm-tools" id="fb-tools"><label class="cab-head-field"><span>Network</span><select data-fb-net id="fb-net"></select></label>` +
          `<div class="seg" role="group" aria-label="Nodes"><button type="button" data-fb-grouped="1" aria-pressed="true">Grouped</button>` +
          `<button type="button" data-fb-grouped="0" aria-pressed="false">Every device</button></div></div>`;
        barEl.dataset.opts = '';
      }
      const list = fabricNetworks();
      let title = 'Fabric · whole plan';
      let sub = 'No cables yet: connect ports in the elevation, the port map or the schedule.';
      if (net) {
        const f = fabricOf(net);
        const links = f.links.reduce((a, l) => a + l.count, 0);
        // The tiers drawn: one with nothing in it is not named.
        const parts = [f.cores.length && plural(f.cores.length, 'core switch', 'core switches'), f.leaves.length && plural(f.leaves.length, 'leaf', 'leaves'), f.nodes.length && plural(f.nodes.length, 'node')].filter(Boolean);
        title = `${netName(net === NONE ? null : net)} fabric · whole plan`;
        sub =
          `${plural(links, 'link')}${parts.length ? ` between ${listAnd(parts)}` : ''}. ` +
          (f.nodes.length ? (prefs.cabGrouped ? 'Nodes with the same links and cluster are drawn as one box.' : 'Every node is drawn as a box of its own.') : '');
      }
      const setText = (node, text) => {
        if (node.textContent !== text) node.textContent = text;
      };
      setText($('#fb-title', barEl), title);
      setText($('#fb-sub', barEl), sub.trim());
      $('#fb-tools', barEl).hidden = !net;
      const select = $('#fb-net', barEl);
      const opts = list.map((id) => `<option value="${esc(id)}">${esc(id === NONE ? 'No network' : netName(id))}</option>`).join('');
      if (barEl.dataset.opts !== opts) {
        select.innerHTML = opts;
        barEl.dataset.opts = opts;
      }
      if (net && select.value !== net) select.value = net;
      for (const b of $$('[data-fb-grouped]', barEl)) b.setAttribute('aria-pressed', String((b.dataset.fbGrouped === '1') === prefs.cabGrouped));
      // The note on line widths and leaf badges: without the leaves it tells of, only the line widths; without links, nothing.
      const f = net ? fabricOf(net) : null;
      noteEl.hidden = !f || !f.links.length;
      const leafNote = $('#cab-note-leaf');
      if (leafNote) leafNote.hidden = !f || !f.leaves.length;
    }
    const listAnd = (parts) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
    barEl.addEventListener('change', (e) => {
      if (e.target.id !== 'fb-net') return;
      fab.network = e.target.value;
      ctx.render();
      // Another network is another drawing: it opens fitted, as the view does.
      ctx.fitWidth();
    });
    barEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fb-grouped]');
      if (!b) return;
      const on = b.dataset.fbGrouped === '1';
      if (on === prefs.cabGrouped) return;
      prefs.cabGrouped = on;
      ctx.savePrefs();
      ctx.renderStage();
      ctx.fitWidth();
    });

    // ------------------------------------------------------------ drawings: pointer

    /*
     * One gesture at a time on the drawings: a press on a port (a click, or
     * a drag from a free port to another, with a line to the pointer), or a
     * press on anything else (a click on it; with a mouse on a zooming
     * drawing, a drag pans it).
     */
    const press = { cur: null };
    const band = document.createElementNS(SVG_NS, 'svg');
    band.setAttribute('class', 'cab-band');
    band.setAttribute('aria-hidden', 'true');
    band.innerHTML = '<line/><circle r="4"/>';
    band.style.display = 'none';
    document.body.appendChild(band);

    function pressTarget(t) {
      const exit = t.closest('.exit[data-row]');
      if (exit) return { kind: 'exit', row: exit.dataset.row };
      const cable = t.closest('[data-cable]');
      if (cable) return { kind: 'cable', id: cable.dataset.cable };
      const group = t.closest('[data-group]');
      if (group) return { kind: 'group', index: Number(group.dataset.group) };
      const dev = t.closest('[data-dev]') || t.closest('[data-pm-dev]');
      if (dev) return { kind: 'device', id: dev.dataset.dev || dev.dataset.pmDev };
      return { kind: 'bg' };
    }

    function onPointerDown(e) {
      if (ui.workspace !== 'cabling' || e.button !== 0) return;
      const t = e.target;
      const inSvg = el.svg.contains(t);
      if (inSvg ? !zoomable() : ui.cabView !== 'ports' || !t.closest('.pm')) return;
      if (!inSvg && t.closest('button, select, label, input, a')) return;
      hideChip();
      // A mouse press below keeps the browser from moving focus (no text
      // selection, no focus ring on the drawing), so focus leaves the control
      // it was on here: the search closes its results as it does in Racks,
      // and Delete, Enter and Esc reach the drawing's keys.
      const a = document.activeElement;
      if (a && a !== document.body && !a.contains(t) && a.blur) a.blur();
      const base = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, add: e.shiftKey || e.ctrlKey || e.metaKey };
      const portEl = t.closest('[data-port]');
      if (portEl) {
        if (e.pointerType === 'mouse') e.preventDefault();
        press.cur = Object.assign(base, { kind: 'port', key: portEl.dataset.port, root: inSvg ? el.svg : host, el: portEl, free: !cableIndex().has(portEl.dataset.port), drag: false });
        return;
      }
      const target = pressTarget(t);
      if (inSvg && e.pointerType === 'mouse') {
        e.preventDefault();
        press.cur = Object.assign(base, { kind: 'pan', target, sl: el.canvas.scrollLeft, st: el.canvas.scrollTop, moved: false });
      } else press.cur = Object.assign(base, { kind: 'tap', target });
    }
    el.svg.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointerdown', onPointerDown);

    window.addEventListener('pointermove', (e) => {
      const pr = press.cur;
      if (!pr || e.pointerId !== pr.pointerId) return;
      const dx = e.clientX - pr.x;
      const dy = e.clientY - pr.y;
      if (pr.kind === 'pan') {
        if (!pr.moved && Math.hypot(dx, dy) < 4) return;
        pr.moved = true;
        el.canvas.classList.add('is-panning');
        el.canvas.scrollLeft = pr.sl - dx;
        el.canvas.scrollTop = pr.st - dy;
      } else if (pr.kind === 'port' && pr.free && pr.type !== 'touch') {
        if (!pr.drag && Math.hypot(dx, dy) < 5) return;
        pr.drag = true;
        drawBand(pr, e);
      }
    });
    window.addEventListener('pointerup', (e) => {
      const pr = press.cur;
      if (!pr || e.pointerId !== pr.pointerId) return;
      press.cur = null;
      const far = Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > 10;
      if (pr.kind === 'pan') {
        el.canvas.classList.remove('is-panning');
        if (!pr.moved) clickTarget(pr.target, pr.add);
      } else if (pr.kind === 'port') {
        if (pr.drag) {
          band.style.display = 'none';
          const at = document.elementFromPoint(e.clientX, e.clientY);
          const to = at && at.closest && at.closest('[data-port]');
          if (to && to.dataset.port !== pr.key) dragConnect(pr.key, to.dataset.port);
        } else if (!far) clickPort(pr.key, pr.add);
      } else if (!far) clickTarget(pr.target, pr.add);
    });
    window.addEventListener('pointercancel', (e) => {
      const pr = press.cur;
      if (pr && e.pointerId === pr.pointerId) cancelPress();
    });
    /** Forgets the press on a drawing, so that its release does nothing; true when it was a drag (from a port, or a pan) under way. */
    function cancelPress() {
      const pr = press.cur;
      if (!pr) return false;
      press.cur = null;
      band.style.display = 'none';
      el.canvas.classList.remove('is-panning');
      return !!(pr.drag || pr.moved);
    }

    /** The rubber band from the port pressed to the pointer. */
    function drawBand(pr, e) {
      // The drawing may have been drawn again since the press (an edit left by it commits): the port is found again by its key.
      if (!pr.el.isConnected) pr.el = pr.root.querySelector(`[data-port="${CSS.escape(pr.key)}"]`) || pr.el;
      if (!pr.el.isConnected) return;
      const r = (pr.el.firstElementChild || pr.el).getBoundingClientRect();
      const [line, dot] = band.children;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      line.setAttribute('x1', x);
      line.setAttribute('y1', y);
      line.setAttribute('x2', e.clientX);
      line.setAttribute('y2', e.clientY);
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);
      band.style.display = '';
    }

    /** A click on something of a drawing other than a port; `add` (Shift, Ctrl or ⌘) adds a cable or a device to the selection. */
    function clickTarget(t, add) {
      if (!t) return;
      if (t.kind === 'exit') {
        const pos = M.locateRow(project(), t.row);
        if (!pos) return;
        ctx.setRow(t.row);
        toast(`${pos.floor.name} · ${pos.row.name}`);
      } else if (t.kind === 'cable') {
        const ids = selCableIds();
        if (add) selectCables(ids.includes(t.id) ? ids.filter((x) => x !== t.id) : ids.concat([t.id]));
        else selectCables([t.id]);
      } else if (t.kind === 'group') {
        if (fab.groups[t.index]) selectDevices(fab.groups[t.index]);
      } else if (t.kind === 'device') {
        const s = ui.cabSel;
        const ids = s && s.kind === 'devices' ? s.ids : [];
        if (add) selectDevices(ids.includes(t.id) ? ids.filter((x) => x !== t.id) : ids.concat([t.id]));
        else selectDevices([t.id]);
      } else clearSelection();
    }

    /**
     * A click on a port. While a connection is being made it is the other
     * end (or the next leg of a breakout cable); the pending port again
     * stops. Otherwise a cabled port selects its cable (Shift adds it) and a
     * free one starts a connection.
     */
    function clickPort(key, add) {
      const end = splitKey(key);
      const d = deviceById(end.device);
      if (!d || !portsOf(d).has(end.port)) return;
      const pd = ui.pending;
      if (pd) {
        if (keyOf(pd) === key) return cancelPending();
        if (pd.legs.some((x) => keyOf(x) === key)) return;
        return connectTo(end);
      }
      const hit = cableIndex().get(key);
      if (hit) {
        const ids = selCableIds();
        const id = hit.cable.id;
        if (add) return selectCables(ids.includes(id) ? ids.filter((x) => x !== id) : ids.concat([id]));
        return selectCables([id]);
      }
      ui.pending = { device: end.device, port: end.port, legs: [] };
      ui.cabSel = { kind: 'port', device: end.device, port: end.port };
      ctx.render();
    }

    /**
     * A drag from a free port to another: the first starts the connection
     * (unless it is the one pending), the second ends it. A drag is one
     * gesture: a connection refused leaves the one pending before it, if
     * any, as it was.
     */
    function dragConnect(fromKey, toKey) {
      const to = splitKey(toKey);
      const d = deviceById(to.device);
      if (!d || !portsOf(d).has(to.port)) return;
      const before = ui.pending;
      if (!before || keyOf(before) !== fromKey) {
        const from = splitKey(fromKey);
        ui.pending = { device: from.device, port: from.port, legs: [] };
      } else if (before.legs.some((x) => keyOf(x) === toKey)) return;
      if (connectTo(to)) return;
      ui.pending = before;
      ctx.render({ inspector: false });
    }

    /** The second end of the connection being made; with a breakout cable armed, its next leg, and the cable once every leg is set. True unless it was refused. */
    function connectTo(end) {
      const pd = ui.pending;
      if (pd.fill) return fillLeg(end);
      const t = armedType();
      const network = defaultNetwork();
      if (t && t.legs > 1) {
        const legs = pd.legs.concat([{ device: end.device, port: end.port }]);
        const b = legs.concat(new Array(t.legs - legs.length).fill(null));
        const err = C.checkConnect(project(), { a: { device: pd.device, port: pd.port }, b, type: t.id, network });
        if (err) {
          toast(err, { warn: true });
          return false;
        }
        if (legs.length < t.legs) {
          pd.legs = legs;
          ctx.render({ inspector: false });
          return true;
        }
        return finishConnect(legs);
      }
      return finishConnect([{ device: end.device, port: end.port }]);
    }

    /** Connects the port pending to `legs` (one end, or the legs of a breakout cable, the others left unplugged); false when it was refused. */
    function finishConnect(legs) {
      const pd = ui.pending;
      const t = armedType();
      const breakout = t && t.legs > 1;
      const props = {
        a: { device: pd.device, port: pd.port },
        b: breakout ? legs.concat(new Array(t.legs - legs.length).fill(null)) : legs[0],
        type: t ? t.id : null,
        network: defaultNetwork(),
      };
      let made = null;
      const err = change(
        (p) => {
          const r = C.connect(p, props);
          made = r.cable || null;
          return r.error;
        },
        { inspector: false }
      );
      if (err) {
        toast(err, { warn: true });
        ctx.render();
        return false;
      }
      ui.pending = null;
      ui.cabSel = { kind: 'cables', ids: [made.id] };
      ctx.render();
      toast(`Connected ${made.label}${breakout && legs.length < t.legs ? `, ${legs.length} of ${t.legs} legs` : ''}`, { action: 'Undo', onAction: ctx.undo });
      return true;
    }

    /** What Enter activates when it has focus, rather than the drawing's keys. */
    const ACTIVATES = 'button, a[href], summary, [role="button"]';

    /** Enter or Esc with legs of a breakout cable set: connects it with those. True when it did. */
    function finishLegs() {
      const pd = ui.pending;
      const t = armedType();
      if (!pd || !pd.legs.length || !t || t.legs <= 1) return false;
      finishConnect(pd.legs);
      return true;
    }

    // Exits of the elevation and the boxes of the fabric are buttons for the keyboard too.
    el.svg.addEventListener('keydown', (e) => {
      if (ui.workspace !== 'cabling' || (e.key !== 'Enter' && e.key !== ' ') || e.repeat) return;
      const t = e.target.closest && e.target.closest('.exit[data-row], .fb-box');
      if (!t) return;
      e.preventDefault();
      if (t.classList.contains('exit')) return clickTarget({ kind: 'exit', row: t.dataset.row });
      // The fabric is drawn again with the box selected: focus stays on the same box.
      const attr = ['data-group', 'data-core', 'data-leaf', 'data-dev'].find((a) => t.hasAttribute(a));
      const sel = attr && `.fb-box[${attr}="${CSS.escape(t.getAttribute(attr))}"]`;
      clickTarget(pressTarget(t), e.shiftKey || e.ctrlKey || e.metaKey);
      const again = sel && !t.isConnected && el.svg.querySelector(sel);
      if (again) again.focus({ preventScroll: true });
    });

    // ------------------------------------------------------------ drawings: hover

    /** "cn-004 ib0 · QSFP56 200G → ib-leaf-a01 p4": a port and what it connects to. */
    function portChipText(key) {
      const end = splitKey(key);
      const d = deviceById(end.device);
      const pt = d && portsOf(d).get(end.port);
      if (!pt) return null;
      const hit = cableIndex().get(key);
      const head = `${d.name} ${pt.name} · ${portSpec(pt)}`;
      if (!hit) return { text: `${head} · free`, color: null };
      const far = hit.role === 'a' ? M.legsOf(hit.cable).filter(Boolean) : [hit.cable.a];
      return { text: `${head} → ${far.map(endText).join(', ') || '–'}`, color: netColor(hit.cable.network) };
    }
    let chipKey = null;
    function hideChip() {
      if (chipKey === null) return;
      chipKey = null;
      el.chip.hidden = true;
    }
    function onHover(e) {
      if (ui.workspace !== 'cabling' || e.pointerType !== 'mouse' || press.cur) return hideChip();
      const portEl = e.target.closest && e.target.closest('[data-port]');
      if (!portEl) return hideChip();
      const key = portEl.dataset.port;
      if (key !== chipKey) {
        const info = portChipText(key);
        if (!info) return hideChip();
        chipKey = key;
        el.chip.className = 'drag-chip port-chip';
        el.chip.style.setProperty('--c', info.color || 'var(--surface-3)');
        el.chip.innerHTML = `<span class="mono">${esc(info.text)}</span>`;
        el.chip.hidden = false;
      }
      const x = Math.min(e.clientX + 14, window.innerWidth - el.chip.offsetWidth - 8);
      const y = Math.min(e.clientY + 18, window.innerHeight - el.chip.offsetHeight - 8);
      el.chip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
    }
    el.svg.addEventListener('pointermove', onHover);
    host.addEventListener('pointermove', onHover);
    el.svg.addEventListener('pointerleave', hideChip);
    host.addEventListener('pointerleave', hideChip);

    function renderStage() {
      if (typing.hold) return;
      const v = view();
      el.floormap.hidden = true;
      el.canvas.classList.remove('is-map');
      hideChip();
      // Over the drawings: the elevation's Front | Rear, the fabric's header and its note (which the fabric shows when it has something to explain).
      sidesEl.hidden = v.id !== 'elevation';
      barEl.hidden = v.id !== 'fabric';
      if (v.id !== 'fabric') noteEl.hidden = true;
      el.canvas.classList.toggle('has-sides', v.id === 'elevation');
      if (v.id === 'elevation') renderSides();
      if (stageKind() === 'svg') {
        host.hidden = true;
        delete el.canvas.dataset.cab;
        el.svg.removeAttribute('hidden');
        el.zoom.hidden = false;
        if (v.id !== 'fabric') delete el.svg.dataset.drawn;
        v.render();
      } else {
        el.svg.setAttribute('hidden', '');
        delete el.svg.dataset.drawn;
        el.zoom.hidden = true;
        host.hidden = false;
        el.canvas.dataset.cab = v.id;
        if (v.id === 'fabric') {
          renderFabricBar(null);
          renderFabricEmpty(host);
        } else v.render(host);
      }
    }
    /** Back to the Racks workspace: the host goes, the drawing comes back. */
    function hideStage() {
      host.hidden = true;
      // The Racks sheet takes the svg: a fabric shown again is drawn anew.
      delete el.svg.dataset.drawn;
      delete el.canvas.dataset.cab;
      sidesEl.hidden = true;
      barEl.hidden = true;
      noteEl.hidden = true;
      el.canvas.classList.remove('has-sides');
      hideChip();
    }

    function renderNav() {
      $('.view-toggle').hidden = true;
      $('#cab-toggle').hidden = false;
      for (const b of $$('#cab-toggle [data-cab-view]')) b.setAttribute('aria-pressed', String(b.dataset.cabView === ui.cabView));
    }

    function renderChrome() {
      el.notice.hidden = true;
      const pd = ui.pending;
      if (pd) {
        const d = deviceById(pd.device);
        const t = armedType();
        const from = `<strong>${esc(`${d.name} ${pd.port}`)}</strong>`;
        const with_ = `<strong>${esc(t ? t.name : 'Auto')}</strong>`;
        let msg;
        if (pd.fill) {
          const c = cableById(pd.fill.cable);
          msg = `Click a free port for leg ${pd.fill.leg + 1} of <strong>${esc(c ? c.label || 'the cable' : 'the cable')}</strong> from ${from}, <kbd>Esc</kbd> to cancel`;
        } else if (t && t.legs > 1) {
          const n = pd.legs.length;
          msg = n
            ? `Click leg ${n + 1} of ${t.legs} of ${with_} from ${from}; <kbd>Enter</kbd> or <kbd>Esc</kbd> to finish with ${n}`
            : `Click the first of ${t.legs} legs to connect ${from} with ${with_}, <kbd>Esc</kbd> to cancel`;
        } else msg = `Click a second port to connect ${from} with ${with_}, <kbd>Esc</kbd> to cancel`;
        el.armedHint.innerHTML = `<span>${msg}</span><button type="button" data-cab-cancel aria-label="Stop connecting" title="Stop connecting">${icon('x', 'ic-sm')}</button>`;
      }
      el.armedHint.hidden = !pd;
    }
    el.armedHint.addEventListener('click', (e) => {
      if (e.target.closest('[data-cab-cancel]')) cancelPending();
    });

    // ------------------------------------------------------------ schedule

    /** The cables of the schedule's scope: { name, what, cables, key, file }. */
    function scopeInfo() {
      const p = project();
      const pos = ctx.currentRow();
      if (prefs.cabScope === 'plan') return { name: p.name || 'Plan', what: 'in the plan', cables: p.cables, key: 'plan', file: ctx.fileBase() };
      const id = prefs.cabScope === 'floor' ? pos.floor.id : pos.row.id;
      const file = prefs.cabScope === 'floor' ? `${ctx.fileBase()}-${M.slug(pos.floor.name)}`.slice(0, 100) : ctx.fileBase(true);
      return {
        name: prefs.cabScope === 'floor' ? pos.floor.name : pos.row.name,
        what: prefs.cabScope === 'floor' ? 'with an end on this floor' : 'with an end in this row',
        cables: C.cablesWithin(p, id),
        key: `${prefs.cabScope}:${id}`,
        file,
      };
    }

    let matcher = { project: null, query: null, fn: null };
    function textMatch(query) {
      const p = project();
      if (matcher.project !== p || matcher.query !== query) matcher = { project: p, query, fn: C.cableMatcher(p, query, fresh().ctx) };
      return matcher.fn;
    }

    /** The scope's cables that the filters let through: the network in focus (which overrides the chips) or the networks shown, and the text. */
    function filtered(scope) {
      let list = scope.cables;
      const f = ui.focusNetwork;
      if (f) list = list.filter((c) => netKey(c) === f);
      else if (sched.hidden.size) list = list.filter((c) => !sched.hidden.has(netKey(c)));
      const match = textMatch(sched.filter);
      if (match) list = list.filter(match);
      return list;
    }

    /**
     * Lets a cable's row show in the schedule: the schedule moves to a row
     * of the cable when its scope has none, and the network in focus, a
     * network chip, the text filter or a folded group that hides it give
     * way. The stage is drawn by the caller.
     */
    function showCable(c) {
      if (!c) return;
      if (!scopeInfo().cables.some((x) => x.id === c.id)) followDevice(c.a.device);
      const net = netKey(c);
      if (ui.focusNetwork && ui.focusNetwork !== net) ui.focusNetwork = null;
      if (!ui.focusNetwork) sched.hidden.delete(net);
      if (filterTimer) applyFilter();
      const match = textMatch(sched.filter);
      if (match && !match(c)) {
        sched.filter = '';
        const f = $('#sc-filter');
        if (f) f.value = '';
      }
      const by = prefs.cabGroup;
      for (const g of C.groupCables(project(), [c], by, fresh().ctx)) sched.collapsed.delete(`${by}:${g.key}`);
    }

    function scheduleSkeleton() {
      return (
        `<div class="sc">` +
        `<div class="sc-tools"><div class="fm-title"><h2 id="sc-title"></h2><p id="sc-sub"></p><p class="sr-only" id="sc-status" role="status"></p></div><span class="spacer"></span>` +
        `<div class="seg sc-scope" role="group" aria-label="Cables of">` +
        `<button type="button" data-sc-scope="row" aria-pressed="false" id="sc-scope-row"><span class="sc-scope-name">Row</span></button>` +
        `<button type="button" data-sc-scope="floor" aria-pressed="false">Floor</button>` +
        `<button type="button" data-sc-scope="plan" aria-pressed="false">Plan</button></div>` +
        `<button type="button" class="btn sm" id="sc-series" title="Connect many devices to the ports of one device">${icon('swap', 'ic-sm')}Connect series…</button>` +
        `<button type="button" class="btn sm" id="sc-add" title="Connect two ports">${icon('plus', 'ic-sm')}Cable</button></div>` +
        `<div class="sc-filters">` +
        `<label class="sc-search">${icon('filter', 'ic-sm')}<span class="sr-only">Filter the cables</span>` +
        `<input id="sc-filter" type="search" placeholder="Filter by device, port, label" autocomplete="off" spellcheck="false"></label>` +
        `<div class="chips sc-nets" id="sc-nets" role="group" aria-label="Networks shown"></div><span class="spacer"></span>` +
        `<label class="sc-group-by"><span class="sr-only">Group the cables</span><select id="sc-group">${GROUPS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label></div>` +
        `<div class="sc-scroll" id="sc-scroll"><table class="sched" id="sc-table" aria-label="Cable schedule"><thead><tr>` +
        `<th class="sc-check"><input type="checkbox" id="sc-all" aria-label="Select every cable shown"></th>` +
        `<th>Label</th><th>From</th><th class="sc-pos">Position</th><th class="sc-arrow" aria-label="to"></th><th>To</th><th class="sc-pos">Position</th>` +
        `<th>Cable</th><th class="sc-num">Speed</th><th class="sc-num">Length</th><th>Check</th></tr></thead><tbody id="sc-body"></tbody></table></div>` +
        `<div class="bom" id="sc-bom"></div></div>`
      );
    }

    const issueIcon = (level) => (level === 'warn' ? icon('warn', 'ic-sm is-warn') : icon('info', 'ic-sm is-info'));
    // A device name longer than this many characters is cut short in the schedule (its title has it whole), so that the port after it and the other columns keep their place.
    const DEV_CHARS = 24;
    const devButton = (d) => `<button type="button" class="sc-dev" data-cab-device="${esc(d.id)}" tabindex="-1"${d.name.length > DEV_CHARS ? ` title="${esc(d.name)}"` : ''}>${esc(d.name)}</button>`;

    /**
     * One cable as a row of the table. `stats` (optional) keeps the widest
     * text of each column: characters of the monospaced ones, the texts of
     * the cable column, and whether any row has a check.
     */
    function cableRow(c, stats) {
      const d = describe(c);
      const a = d.ends.find((e) => e.role === 'a');
      const far = d.ends.filter((e) => e.role === 'b');
      // A schedule too narrow for the Position columns shows each end's position under it instead (css/cabling.css).
      const end = (e) => (e && e.device ? `<div data-at="${esc(where(e.device).short)}">${devButton(e.device)} ${esc(e.end.port)}</div>` : '<div>–</div>');
      const pos = (e) => `<div>${e && e.device ? esc(where(e.device).short) : ''}</div>`;
      const issue = d.issues[0];
      const len = d.lengthM === null ? '–' : C.fmtM(d.lengthM);
      const lenTitle = d.needM === null ? (d.lengthAuto ? 'The ends are on different floors: enter the length' : 'set by hand') : `${d.lengthAuto ? 'needs' : 'set by hand; needs'} ${needText(d.needM)}`;
      const type = d.type ? `${esc(shortType(d.type))}${d.type.legs > 1 ? `<small> 1→${d.type.legs}</small>` : ''}` : '–';
      const label = c.label || '–';
      if (stats) {
        const chars = (e) => (e && e.device ? Math.min(e.device.name.length, DEV_CHARS) + 1 + e.end.port.length : 1);
        const place = (e) => (e && e.device ? where(e.device).short.length : 0);
        stats.label = Math.max(stats.label, label.length);
        stats.from = Math.max(stats.from, chars(a));
        stats.fromPos = Math.max(stats.fromPos, place(a));
        for (const e of far) {
          stats.to = Math.max(stats.to, chars(e));
          stats.toPos = Math.max(stats.toPos, place(e));
        }
        stats.types.add(d.type ? `${shortType(d.type)}${d.type.legs > 1 ? ` 1→${d.type.legs}` : ''}` : '–');
        stats.speed = Math.max(stats.speed, C.shortSpeed(d.speedGbps).length);
        stats.length = Math.max(stats.length, len.length);
        stats.issue = stats.issue || !!issue;
      }
      return (
        `<tr data-cable="${esc(c.id)}"${issue && issue.level === 'warn' ? ' class="is-warn"' : ''}>` +
        `<td class="sc-check"><input type="checkbox" aria-label="Select ${esc(label)}"></td>` +
        `<td class="mono"><span class="sc-label"><span class="sc-net" style="--c:${netColor(c.network)}" title="${esc(netName(c.network))}"></span>${esc(label)}</span></td>` +
        `<td class="mono sc-end">${end(a)}</td><td class="mono sc-pos">${pos(a)}</td>` +
        `<td class="sc-arrow">→</td>` +
        `<td class="mono sc-end">${far.map(end).join('') || '<div>–</div>'}</td><td class="mono sc-pos">${far.map(pos).join('')}</td>` +
        `<td title="${esc(d.type ? d.type.name : 'No cable type fits')}">${type}</td>` +
        `<td class="mono sc-num">${esc(C.shortSpeed(d.speedGbps))}</td>` +
        `<td class="mono sc-num${d.lengthAuto ? ' is-auto' : ''}" title="${esc(lenTitle)}">${esc(len)}</td>` +
        `<td class="sc-issue">${issue ? `<span class="sc-flag is-${issue.level === 'warn' ? 'warn' : 'info'}" title="${esc(d.issues.map((x) => x.text).join('\n'))}">${issueIcon(issue.level)}<span>${esc(issue.short)}</span></span>` : ''}</td>` +
        `</tr>`
      );
    }

    /** The rows of the table as [{ key, html, cable, lines }]: each group's header, then its cables unless it is folded; `lines` is how many ends a row stacks. */
    function tableRows(list) {
      const by = prefs.cabGroup;
      const visible = [];
      const out = [];
      const stats = { label: 0, from: 0, fromPos: 0, to: 0, toPos: 0, types: new Set(), speed: 0, length: 0, issue: false };
      sched.stats = stats;
      for (const g of C.groupCables(project(), list, by, fresh().ctx)) {
        const key = `${by}:${g.key}`;
        const open = !sched.collapsed.has(key);
        const warn = g.cables.filter((c) => describe(c).issues.some((x) => x.level === 'warn')).length;
        out.push({
          key: `g\u0000${key}`,
          cable: null,
          lines: 0,
          html:
            `<tr class="sc-group"><td colspan="11"><button type="button" class="sc-fold" data-sc-group="${esc(key)}" aria-expanded="${open}">${icon(open ? 'chevron' : 'right', 'ic-sm')}<b>${esc(g.label)}</b></button>` +
            `<span class="sc-count">${plural(g.cables.length, 'cable')}</span>` +
            (warn ? `<span class="sc-flag is-warn">${icon('warn', 'ic-sm is-warn')}${warn} to check</span>` : '') +
            `</td></tr>`,
        });
        if (!open) continue;
        for (const c of g.cables) {
          visible.push(c.id);
          out.push({ key: `c\u0000${c.id}\u0000${key}`, cable: c.id, lines: Array.isArray(c.b) ? c.b.filter(Boolean).length || 1 : 1, html: cableRow(c, stats) });
        }
      }
      // Grouped by device, a cable is listed under each of its devices; it is selected once.
      sched.visible = by === 'device' ? [...new Set(visible)] : visible;
      return out;
    }

    /*
     * A long table draws only the rows near the view: a spacer row above
     * and one below stand for the others, sized from the rows' heights
     * (measured once drawn, estimated before), and scrolling draws the rows
     * that come into view. So 2000 cables cost no more than a hundred.
     */
    const WINDOW = 250; // tables with more rows than this draw a window of them
    const MARGIN = 40; // rows drawn above and below the view
    // Heights in px, estimated until a row of the kind is measured: a cable row, a group's row, and each further end a row stacks.
    const rowH = { cable: 29, group: 35, line: 20 };
    const estimate = (x) => (x.cable ? rowH.cable + Math.max(0, x.lines - 1) * rowH.line : rowH.group);
    const windowed = () => !!sched.items && sched.items.length > WINDOW;
    const gapRow = (side) => `<tr class="sc-gap" data-sc-gap="${side}" aria-hidden="true"><td colspan="11"></td></tr>`;

    /**
     * Draws the rows of the table. When they are the same rows as before
     * (an edit of a cable), only the drawn rows that changed are drawn
     * again; else the table is drawn anew.
     */
    function drawRows(items, empty) {
      const body = $('#sc-body');
      const prev = sched.items;
      if (prev && items.length && prev.length === items.length && items.every((x, i) => x.key === prev[i].key)) {
        sched.items = items;
        const tpl = document.createElement('template');
        for (let i = sched.from; i < sched.to; i++) {
          if (items[i].html === prev[i].html) continue;
          tpl.innerHTML = items[i].html;
          const tr = tpl.content.firstElementChild;
          body.replaceChild(tr, rowAt(i));
          mark(tr, i);
          if (items[i].lines !== prev[i].lines) {
            sched.heights[i] = estimate(items[i]);
            sched.measured[i] = 0;
          }
        }
        if (windowed()) {
          fitColumns();
          measure();
        }
        return;
      }
      sched.items = items;
      sched.heights = items.map(estimate);
      sched.measured = new Uint8Array(items.length);
      sched.tops = null;
      sched.from = 0;
      sched.to = 0;
      sched.fitted = false;
      $('#sc-table').removeAttribute('aria-rowcount');
      for (const th of $('#sc-table').tHead.rows[0].cells) th.style.minWidth = '';
      if (!items.length) {
        body.innerHTML = `<tr class="sc-none"><td colspan="11">${esc(empty)}</td></tr>`;
        return;
      }
      if (!windowed()) {
        body.innerHTML = items.map((x) => x.html).join('');
        sched.to = items.length;
        for (let i = 0; i < items.length; i++) mark(body.children[i], i);
        return;
      }
      $('#sc-table').setAttribute('aria-rowcount', String(items.length + 1));
      body.innerHTML = gapRow('top') + gapRow('end');
      drawWindow();
    }

    /** The table row of item `i`, when it is drawn. */
    function rowAt(i) {
      if (i < sched.from || i >= sched.to) return null;
      return $('#sc-body').children[i - sched.from + (windowed() ? 1 : 0)];
    }

    /** Offsets of the rows from the top of the table's body: tops[i] is where row i starts, tops[n] the height of them all. */
    function tops() {
      if (!sched.tops) {
        const h = sched.heights;
        const t = new Float64Array(h.length + 1);
        for (let i = 0; i < h.length; i++) t[i + 1] = t[i] + h[i];
        sched.tops = t;
      }
      return sched.tops;
    }
    /** The row at `y` px from the top of the table's body. */
    function rowAtY(y) {
      const t = tops();
      let lo = 0;
      let hi = t.length - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (t[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return Math.max(0, lo);
    }

    /** Draws the rows of a long table that are in view or near it; nothing when they are drawn already. */
    function drawWindow(force) {
      const box = $('#sc-scroll');
      const body = $('#sc-body');
      if (!box || !body || !windowed()) return;
      const n = sched.items.length;
      const head = $('#sc-table').tHead.offsetHeight;
      const first = rowAtY(box.scrollTop - head);
      const last = rowAtY(box.scrollTop + box.clientHeight - head);
      // Drawn already, with rows to spare on both sides: nothing to do.
      const spare = MARGIN / 4;
      if (!force && sched.to > sched.from && sched.from <= Math.max(0, first - spare) && sched.to >= Math.min(n, last + 1 + spare)) return;
      const from = Math.max(0, first - MARGIN);
      const to = Math.min(n, last + MARGIN + 1);
      // Where the view is, to keep it there while the heights of rows drawn for the first time replace their estimates.
      const anchor = first;
      const offset = box.scrollTop - head - tops()[anchor];
      // Keyboard focus in a row comes back to the same row once it is drawn again.
      const active = body.contains(document.activeElement) ? document.activeElement : null;
      const activeTr = active && active.closest('tr[data-cable], tr.sc-group');
      const focusAt = activeTr ? sched.from + [...body.children].indexOf(activeTr) - 1 : -1;
      const focusSel = active ? (active.matches('input') ? 'input' : '.sc-fold') : null;

      const html = [];
      for (let i = from; i < to; i++) html.push(sched.items[i].html);
      body.innerHTML = gapRow('top') + html.join('') + gapRow('end');
      sched.from = from;
      sched.to = to;
      for (let i = from; i < to; i++) mark(body.children[i - from + 1], i);
      if (!sched.fitted) fitColumns();
      measure();
      const want = Math.round(head + tops()[anchor] + offset);
      if (Math.abs(box.scrollTop - want) >= 1) box.scrollTop = want;
      if (focusAt >= from && focusAt < to) {
        const again = rowAt(focusAt).querySelector(focusSel);
        if (again) again.focus({ preventScroll: true });
      }
    }

    /**
     * Gives the columns of a long table the width of their widest text in
     * any row, drawn or not, so that they keep their width while it scrolls.
     */
    function fitColumns() {
      const cell = $('#sc-body td.mono');
      const typeCell = cell && cell.parentElement.cells[7];
      if (!cell || !typeCell) return;
      sched.fitted = true;
      const st = sched.stats;
      const canvas = fitColumns.canvas || (fitColumns.canvas = document.createElement('canvas'));
      const g = canvas.getContext('2d');
      const font = (el) => {
        const cs = getComputedStyle(el);
        return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      };
      g.font = font(cell);
      const ch = g.measureText('0000000000').width / 10;
      g.font = font(typeCell);
      const pad = 12; // a cell's padding
      const mono = (n) => `${Math.ceil(n * ch + pad)}px`;
      const types = Math.ceil(Math.max(0, ...[...st.types].map((t) => g.measureText(t).width)) + pad);
      // Label (with its network's bar), From, its position, the arrow, To, its position, Cable, Speed, Length, Check.
      const widths = [null, `${Math.ceil(st.label * ch + pad + 11)}px`, mono(st.from), mono(st.fromPos), null, mono(st.to), mono(st.toPos), `${types}px`, mono(st.speed), mono(st.length), st.issue ? '152px' : null];
      [...$('#sc-table').tHead.rows[0].cells].forEach((th, i) => (th.style.minWidth = widths[i] || ''));
    }

    /** Measures the drawn rows of a long table, keeps their heights for the offsets, and sizes the spacers for the rows not drawn. */
    function measure() {
      const body = $('#sc-body');
      const was = `${rowH.cable} ${rowH.group} ${rowH.line}`;
      let changed = false;
      for (let i = sched.from; i < sched.to; i++) {
        const tr = rowAt(i);
        const h = tr.getBoundingClientRect().height;
        if (!h) continue;
        const x = sched.items[i];
        if (!x.cable) rowH.group = h;
        else if (x.lines === 1) rowH.cable = h;
        else rowH.line = (h - rowH.cable) / (x.lines - 1);
        sched.measured[i] = 1;
        if (Math.abs(h - sched.heights[i]) > 0.01) {
          sched.heights[i] = h;
          changed = true;
        }
      }
      // Rows of a kind measured for the first time make better estimates of the rows not drawn yet.
      if (was !== `${rowH.cable} ${rowH.group} ${rowH.line}`) {
        for (let i = 0; i < sched.items.length; i++) if (!sched.measured[i]) sched.heights[i] = estimate(sched.items[i]);
        changed = true;
      }
      if (changed) sched.tops = null;
      const t = tops();
      body.firstElementChild.firstElementChild.style.height = `${t[sched.from]}px`;
      body.lastElementChild.firstElementChild.style.height = `${t[t.length - 1] - t[sched.to]}px`;
    }

    // A long table draws the rows that scroll into view, once per frame.
    let windowFrame = 0;
    function drawWindowSoon() {
      if (windowFrame || !windowed()) return;
      windowFrame = requestAnimationFrame(() => {
        windowFrame = 0;
        drawWindow();
      });
    }
    host.addEventListener('scroll', (e) => {
      if (e.target.id === 'sc-scroll') drawWindowSoon();
    }, true);
    if (window.ResizeObserver) new ResizeObserver(drawWindowSoon).observe(host);

    /** Marks a row drawn anew (item `i`) as selected when its cable is; a row of a long table gets its place in the table. */
    function mark(tr, i) {
      if (windowed()) tr.setAttribute('aria-rowindex', String(i + 2));
      const id = tr.dataset.cable;
      if (!id || !sched.marked.has(id)) return;
      tr.classList.add('is-selected');
      tr.querySelector('input').checked = true;
    }

    /**
     * Chips to show or hide the networks of the scope's cables. While a
     * network is in focus, the schedule shows it alone: its chip stands for
     * all of them, with a button to show every network again.
     */
    function networkChips(present) {
      const f = ui.focusNetwork;
      const nets = project().networks.filter((n) => (f ? n.id === f : present.has(n.id))).map((n) => [n.id, n.name, n.color]);
      if (f ? f === NONE : present.has(NONE)) nets.push([NONE, 'No network', 'var(--unassigned)']);
      const chips = nets
        .map(
          ([id, name, color]) =>
            `<label class="chip chip-net"${f ? ` title="${esc(`Only ${name} is shown`)}"` : ''}><input type="checkbox" data-sc-net="${esc(id)}"${f || !sched.hidden.has(id) ? ' checked' : ''}${f ? ' disabled' : ''}>` +
            `<span><i class="sw" style="--c:${color}"></i>${esc(name)}</span></label>`
        )
        .join('');
      if (!f) return chips;
      return chips + `<button type="button" class="btn sm subtle sc-unfocus" data-sc-unfocus title="Show the cables of every network (Esc)">Show all</button>`;
    }

    function bomHTML(scope) {
      const bom = C.billOfMaterials(project(), scope.cables, fresh().ctx);
      const groups = new Map();
      for (const x of bom.cables) {
        if (!groups.has(x.type.id)) groups.set(x.type.id, { type: x.type, items: [] });
        groups.get(x.type.id).items.push(x);
      }
      const item = (l, n) => `<span class="bom-item"><b>${esc(C.fmtM(l))}</b> × ${n}</span>`;
      const dot = '<i>·</i>';
      let metres = 0;
      let html = '';
      for (const g of groups.values()) {
        const n = g.items.reduce((a, x) => a + x.count, 0);
        metres += g.items.reduce((a, x) => a + x.count * x.lengthM, 0);
        html += `<div class="bom-type"><span class="bom-name">${esc(g.type.name)} <small>${n}</small></span><span class="bom-items">${g.items.map((x) => item(x.lengthM, x.count)).join(dot)}</span></div>`;
      }
      for (const x of bom.madeToLength) {
        const n = x.lengths.reduce((a, l) => a + l.count, 0);
        metres += x.totalM;
        html +=
          `<div class="bom-type is-made"><span class="bom-name">${esc(x.type.name)} <small>${n}</small></span>` +
          `<span class="bom-items">${x.lengths.map((l) => item(l.lengthM, l.count)).join(dot)}${dot}<span class="bom-item bom-total">total <b>${esc(C.fmtM(x.totalM))}</b></span></span></div>`;
      }
      for (const x of bom.transceivers) {
        html += `<div class="bom-type is-optic"><span class="bom-name">${esc(x.transceiver.name)}</span><span class="bom-items"><span class="bom-item">× <b>${x.count}</b></span></span></div>`;
      }
      const cables = bom.cables.reduce((a, x) => a + x.count, 0) + bom.madeToLength.reduce((a, x) => a + x.lengths.reduce((s, l) => s + l.count, 0), 0);
      const optics = bom.transceivers.reduce((a, x) => a + x.count, 0);
      const summary = [plural(cables, 'cable'), `${Math.round(metres * 10) / 10} m`].concat(optics ? [plural(optics, 'transceiver')] : []).join(', ');
      return (
        `<div class="bom-head"><b>To order</b><span>${esc(summary)}${bom.unresolved ? ` · <em class="bom-warn">${esc(plural(bom.unresolved, 'cable'))} without a type or a length to buy</em>` : ''}</span>` +
        `<button type="button" class="btn sm subtle" id="sc-order-csv" title="What to order for these cables, as CSV">${icon('download', 'ic-sm')}Order list (CSV)</button>` +
        `<button type="button" class="btn sm subtle" id="sc-cables-csv" title="These cables with both ends, as CSV">${icon('download', 'ic-sm')}Cable schedule (CSV)</button></div>` +
        (html ? `<div class="bom-types">${html}</div>` : `<p class="bom-empty">Nothing to order yet.</p>`)
      );
    }

    function renderSchedule(box) {
      if (box.dataset.view !== 'schedule') {
        box.dataset.view = 'schedule';
        box.innerHTML = scheduleSkeleton();
        sched.drawn = null;
        sched.items = null;
        sched.chips = null;
        sched.bom = null;
        sched.marked = new Set();
      }
      const p = project();
      const pos = ctx.currentRow();
      const scope = scopeInfo();
      $('#sc-title').textContent = `${scope.name} · cable schedule`;
      $('#sc-title').title = $('#sc-title').textContent;
      // A long row name is cut short in the button; its title has it whole.
      $('#sc-scope-row .sc-scope-name').textContent = pos.row.name;
      $('#sc-scope-row').title = `The cables of ${pos.row.name}`;
      for (const b of $$('[data-sc-scope]', box)) b.setAttribute('aria-pressed', String(b.dataset.scScope === prefs.cabScope));
      $('#sc-group').value = prefs.cabGroup;
      const filter = $('#sc-filter');
      // Text typed and not yet applied (a large plan waits for typing to pause) applies now, rather than being put back.
      if (filterTimer) applyFilter();
      else if (filter.value !== sched.filter && document.activeElement !== filter) filter.value = sched.filter;

      const present = new Set(scope.cables.map(netKey));
      const chips = networkChips(present);
      if (sched.chips !== chips) {
        ctx.keepFocus($('#sc-nets'), () => ($('#sc-nets').innerHTML = chips));
        sched.chips = chips;
      }

      // Another row, floor or plan opens at the top of its table, not where the one before was scrolled to.
      if (sched.scopeKey !== scope.key) {
        $('#sc-scroll').scrollTop = 0;
        sched.scopeKey = scope.key;
      }
      const list = filtered(scope);
      const key = [scope.key, sched.filter, [...sched.hidden].join(), ui.focusNetwork, prefs.cabGroup, [...sched.collapsed].join('\u0000')].join('|');
      if (!sched.drawn || sched.drawn.project !== p || sched.drawn.key !== key) {
        drawRows(tableRows(list), emptyText(scope, list));
        sched.drawn = { project: p, key };
        const shown = list.length === scope.cables.length ? '' : `${list.length} shown · `;
        $('#sc-sub').textContent = `${plural(scope.cables.length, 'cable')} ${scope.what} · ${shown}lengths in italics are estimates`;
        $('#sc-sub').title = $('#sc-sub').textContent;
        // Read out when the filters change what is shown (the filter applies as typing pauses on a large plan, so once then).
        const status = `${list.length} of ${plural(scope.cables.length, 'cable')} shown`;
        if (sched.status && sched.status.scope === scope.key && sched.status.text !== status) $('#sc-status').textContent = status;
        sched.status = { scope: scope.key, text: status };
      }
      if (sched.bom !== scope.key || sched.bomProject !== p) {
        $('#sc-bom').innerHTML = bomHTML(scope);
        sched.bom = scope.key;
        sched.bomProject = p;
      }
      syncSelection();
      // A long table shown again (after the other workspace, say) draws the rows where it is scrolled to.
      if (windowed()) drawWindow();
    }

    function emptyText(scope, list) {
      if (scope.cables.length) return 'No cable matches the filters.';
      return prefs.cabScope === 'plan' ? 'No cables yet. Connect ports with Connect series… or + Cable.' : `No cables ${scope.what} yet. Connect ports with Connect series… or + Cable.`;
    }

    /** Marks the selected rows, without drawing the table again. */
    function syncSelection() {
      const body = $('#sc-body');
      if (!body) return;
      const sel = new Set(selCableIds());
      const changed = new Set();
      for (const id of sched.marked) if (!sel.has(id)) changed.add(id);
      for (const id of sel) if (!sched.marked.has(id)) changed.add(id);
      if (changed.size) {
        for (const tr of body.querySelectorAll('tr[data-cable]')) {
          if (!changed.has(tr.dataset.cable)) continue;
          const on = sel.has(tr.dataset.cable);
          tr.classList.toggle('is-selected', on);
          tr.querySelector('input').checked = on;
        }
      }
      sched.marked = sel;
      const all = $('#sc-all');
      const n = sched.visible.filter((id) => sel.has(id)).length;
      all.checked = n > 0 && n === sched.visible.length;
      all.indeterminate = n > 0 && n < sched.visible.length;
      all.disabled = !sched.visible.length;
    }

    /** Scrolls the schedule to the row of a cable, a third of the way down, unless it is in view. */
    function revealCable(id) {
      const box = $('#sc-scroll');
      const at = sched.items ? sched.items.findIndex((x) => x.cable === id) : -1;
      if (!box || at < 0) return;
      const head = $('#sc-table').tHead.offsetHeight;
      if (!rowAt(at)) {
        // A long table draws the rows around it first.
        box.scrollTop = Math.max(0, tops()[at] - (box.clientHeight - head) / 3);
        drawWindow(true);
      }
      const tr = rowAt(at);
      if (!tr) return;
      const r = tr.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      if (r.top < b.top + head || r.bottom > b.bottom) {
        box.scrollTop += r.top - b.top - head - (b.height - head) / 3;
        drawWindow();
      }
    }

    /** The item of the table that a drawn row stands for (its index in sched.items). */
    function itemOf(tr) {
      const k = [...$('#sc-body').children].indexOf(tr);
      return k < 0 ? -1 : sched.from + k - (windowed() ? 1 : 0);
    }

    /**
     * A click on the row of item `at`: alone it selects its cable, Shift
     * adds the rows from the one clicked last to this one, Ctrl or ⌘ (or
     * the checkbox) toggles it. The range is of the rows as drawn: grouped
     * by device, a cable is listed under each of its devices, and only the
     * rows between the two clicked count.
     */
    function clickRow(at, e, toggle) {
      const ids = selCableIds();
      const items = sched.items || [];
      const id = items[at] && items[at].cable;
      if (!id) return;
      const a = sched.anchor;
      const from = a ? (items[a.at] && items[a.at].key === a.key ? a.at : items.findIndex((x) => x.key === a.key)) : -1;
      if (e.shiftKey && from >= 0) {
        const range = [];
        for (let i = Math.min(from, at); i <= Math.max(from, at); i++) if (items[i].cable) range.push(items[i].cable);
        return selectCables(e.ctrlKey || e.metaKey ? ids.concat(range) : range);
      }
      sched.anchor = { id, key: items[at].key, at };
      if (toggle || e.ctrlKey || e.metaKey) return selectCables(ids.includes(id) ? ids.filter((x) => x !== id) : ids.concat([id]));
      selectCables([id]);
    }

    /** Draws the schedule again after its scope, grouping, filters or folds change; the inspector of several cables follows its new order. */
    function restage() {
      if (selCableIds().length > 1) ctx.render();
      else ctx.renderStage();
    }

    host.addEventListener('input', (e) => {
      if (e.target.id !== 'sc-filter') return;
      clearTimeout(filterTimer);
      filterTimer = null;
      const apply = () => {
        filterTimer = null;
        sched.filter = e.target.value;
        restage();
      };
      // On large plans the table follows typing once it pauses.
      if (project().cables.length > 400) filterTimer = setTimeout(apply, 150);
      else apply();
    });
    host.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'sc-group') {
        prefs.cabGroup = t.value;
        ctx.savePrefs();
        restage();
      } else if (t.dataset && t.dataset.scNet !== undefined) {
        if (t.checked) sched.hidden.delete(t.dataset.scNet);
        else sched.hidden.add(t.dataset.scNet);
        restage();
      } else if (t.id === 'sc-all') {
        const sel = new Set(selCableIds());
        const all = sched.visible.length && sched.visible.every((id) => sel.has(id));
        selectCables(all ? selCableIds().filter((id) => !sched.visible.includes(id)) : selCableIds().concat(sched.visible));
      }
    });
    // A click on a checkbox of the table (or beside it in its cell) leaves keyboard focus where it was, so Delete still deletes the cables.
    // Shift-click selects rows, not their text.
    host.addEventListener('pointerdown', (e) => {
      if (!e.target.closest) return;
      if (e.target.closest('.sched tbody td.sc-check')) e.preventDefault();
      else if (e.shiftKey && e.target.closest('tr[data-cable]')) e.preventDefault();
    });
    host.addEventListener('click', (e) => {
      const t = e.target;
      const go = t.closest('[data-cab-view]');
      if (go) return setView(go.dataset.cabView);
      const scope = t.closest('[data-sc-scope]');
      if (scope) {
        prefs.cabScope = scope.dataset.scScope;
        ctx.savePrefs();
        return restage();
      }
      if (t.closest('[data-sc-unfocus]')) return clearFocus();
      const fold = t.closest('[data-sc-group]');
      if (fold) {
        const k = fold.dataset.scGroup;
        if (sched.collapsed.has(k)) sched.collapsed.delete(k);
        else sched.collapsed.add(k);
        restage();
        const again = host.querySelector(`[data-sc-group="${CSS.escape(k)}"]`);
        if (again) again.focus({ preventScroll: true });
        return;
      }
      if (t.closest('#sc-series')) return openConnect({ series: true });
      if (t.closest('#sc-add')) return openConnect({ series: false });
      if (t.closest('#sc-order-csv')) return exportScope('order');
      if (t.closest('#sc-cables-csv')) return exportScope('cables');
      const dev = t.closest('[data-cab-device]');
      if (dev) return selectDevices([dev.dataset.cabDevice]);
      // The header's checkbox cell works as its checkbox too.
      if (t.matches('th.sc-check')) {
        if (!$('#sc-all').disabled) $('#sc-all').click();
        return;
      }
      const tr = t.closest('tr[data-cable]');
      if (!tr) return;
      // The checkbox's whole cell toggles it, so that a tap a little beside it does not replace the selection.
      const box = !!t.closest('td.sc-check');
      if (t.matches('input[type="checkbox"]')) t.checked = !t.checked; // drawn by the selection, as for a click on the row
      clickRow(itemOf(tr), e, box);
    });

    function exportScope(what) {
      const scope = scopeInfo();
      try {
        const name = `${scope.file}-${what === 'order' ? 'cable-order' : 'cables'}.csv`;
        const text = what === 'order' ? IO.exportOrderCSV(project(), scope.cables) : IO.exportCablesCSV(project(), scope.cables);
        ctx.download(name, new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
        toast(`Exported ${name}`);
      } catch (err) {
        toast(`Export failed: ${err.message}`, { warn: true });
      }
    }

    // ------------------------------------------------------------ left panel

    /** A small drawing of a cable: plugs at both ends and a loop of cord; a breakout fans out into its legs. Auto is drawn dashed. */
    function cableArt(ct) {
      const dark = ui.theme === 'dark';
      const direct = dark ? '#aab4bf' : '#2d3339';
      const cord = ct ? JACKET[ct.media] || direct : dark ? '#8e99a6' : '#9aa5b1';
      const metal = dark ? '#77818c' : '#c3cad2';
      const ink = dark ? '#0d1115' : '#2a3038';
      const fam = (id) => (ct ? (M.connectorById(id) || { family: 'qsfp' }).family : 'auto');
      // A plug whose cord leaves at (x, y) and whose body points the way of `dir`, scaled by `s`.
      const plug = (x, y, dir, f, s) => {
        let body;
        if (f === 'rj45') body = `<path d="M0 16h12l4 2v8l-4 2H0z" fill="${cord}"/><rect x="16" y="17" width="12" height="10" rx="1" fill="${metal}" stroke="${ink}" stroke-width=".8"/><path d="M19 17v-3h6v3" fill="none" stroke="${ink}" stroke-width=".8"/>`;
        else if (f === 'auto') body = `<rect x="0" y="16" width="26" height="12" rx="2" fill="none" stroke="${cord}" stroke-width="1.2" stroke-dasharray="3 2"/>`;
        else if (f === 'lc' || f === 'mpo') body = `<rect x="0" y="17.5" width="12" height="9" rx="2" fill="${cord}"/><rect x="11" y="16" width="${f === 'mpo' ? 16 : 13}" height="12" rx="1.5" fill="${metal}" stroke="${ink}" stroke-width=".8"/><path d="M15 20h${f === 'mpo' ? 8 : 5}M15 24h${f === 'mpo' ? 8 : 5}" stroke="${ink}" stroke-width=".7" opacity=".5"/>`;
        else body = `<rect x="0" y="16.5" width="10" height="11" rx="2" fill="${cord}"/><rect x="9" y="15" width="22" height="14" rx="1.5" fill="${metal}" stroke="${ink}" stroke-width=".8"/><path d="M13 20h14M13 24h14" stroke="${ink}" stroke-width=".7" opacity=".5"/><path d="M0 22h-6" stroke="${f === 'sas' ? '#8a5cd6' : '#2f6fdb'}" stroke-width="2.5" stroke-linecap="round"/>`;
        return `<g transform="translate(${x} ${y}) scale(${dir * s} ${s}) translate(0 -22)">${body}</g>`;
      };
      const w = fam(ct && ct.connector) === 'rj45' ? 3 : 4;
      const dash = ct ? '' : ' stroke-dasharray="5 4"';
      if (!ct || ct.legs <= 1) {
        const loop = `<path d="M40 22 C 62 4, 82 4, 94 22 S 128 40, 148 22" fill="none" stroke="${cord}" stroke-width="${w}" stroke-linecap="round"${dash}/>`;
        return `<svg viewBox="0 0 188 44" width="188" height="44" aria-hidden="true">${loop}${plug(40, 22, -1, fam(ct && ct.connector), 1)}${plug(148, 22, 1, fam(ct && ct.connectorB), 1)}</svg>`;
      }
      const n = ct.legs;
      const gap = Math.min(13, 34 / (n - 1));
      const s = Math.max(0.42, Math.min(0.8, gap / 15));
      let legs = '';
      let plugs = '';
      for (let i = 0; i < n; i++) {
        const y = 22 + (i - (n - 1) / 2) * gap;
        legs += `<path d="M108 22 C 122 22, 128 ${y}, 142 ${y}H152" fill="none" stroke="${cord}" stroke-width="${Math.max(1.6, w - 1.5)}" stroke-linecap="round"/>`;
        plugs += plug(152, y, 1, fam(ct.connectorB), s);
      }
      const loop = `<path d="M40 22 C 58 6, 76 6, 88 22 S 100 22, 108 22" fill="none" stroke="${cord}" stroke-width="${w}" stroke-linecap="round"/>`;
      return `<svg viewBox="0 0 188 44" width="188" height="44" aria-hidden="true">${loop}${legs}${plug(40, 22, -1, fam(ct.connector), 1)}${plugs}</svg>`;
    }

    /** "RJ45 · 0.5–20 m", "OSFP → 2 × QSFP56 · 1–3 m", "MPO · made to length". */
    function typeSpec(t) {
      const plugs = t.legs > 1 ? `${connLabel(t.connector)} → ${t.legs} × ${connLabel(t.connectorB)}` : t.connector === t.connectorB ? connLabel(t.connector) : `${connLabel(t.connector)} → ${connLabel(t.connectorB)}`;
      const l = t.lengthsM;
      const stock = !l.length ? 'made to length' : l.length === 1 ? C.fmtM(l[0]) : `${l[0]}–${C.fmtM(l[l.length - 1])}`;
      return `${plugs} · ${stock}`;
    }

    /*
     * How many cables are of each cable type and how many cable ends have
     * each transceiver, named or picked: every cable described. On a large
     * plan that is too slow for each edit, so the panel shows the counts it
     * had while they are counted again in the browser's idle time, a slice
     * at a time, and then shows them.
     */
    const uses = { project: null, at: 0, types: null, transceivers: null, complete: null, job: 0 };
    /** Counts on for up to `ms` milliseconds (all of them without); true once every cable is counted. */
    function countUses(ms) {
      const p = project();
      if (uses.project !== p) Object.assign(uses, { project: p, at: 0, types: new Map(), transceivers: new Map() });
      const add = (m, id) => m.set(id, (m.get(id) || 0) + 1);
      const until = ms === undefined ? Infinity : performance.now() + ms;
      const cables = p.cables;
      while (uses.at < cables.length) {
        const d = describe(cables[uses.at++]);
        if (d.type) add(uses.types, d.type.id);
        for (const x of d.ends) if (x.transceiver) add(uses.transceivers, x.transceiver.id);
        if (uses.at % 64 === 0 && performance.now() > until) return false;
      }
      if (!uses.complete || uses.complete.project !== p) uses.complete = { project: p, types: uses.types, transceivers: uses.transceivers };
      return true;
    }
    /** The counts of the plan as it is, counted now if need be: { types, transceivers } (Maps by id). */
    function useCounts() {
      countUses();
      return uses.complete;
    }
    /** Counts the plan as it is in idle time, then draws the counts in the panel. */
    function countUsesSoon() {
      if (uses.job) return;
      const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 30));
      const step = (deadline) => {
        uses.job = 0;
        const done = countUses(Math.max(4, Math.min(12, deadline.timeRemaining())));
        if (!done) uses.job = idle(step) || 1;
        else if (ui.workspace === 'cabling') drawTypeCards();
      };
      uses.job = idle(step) || 1;
    }

    let binHTML = { types: null, nets: null };
    /** The cable types of the panel, with how many cables of the plan are of each (the counts last complete on a large plan). */
    function drawTypeCards() {
      const p = project();
      let counts = null;
      if (p.cables.length <= 400) counts = useCounts().types;
      else {
        if (!uses.complete || uses.complete.project !== p) countUsesSoon();
        counts = uses.complete ? uses.complete.types : null;
      }
      // Only the card armed is a stop for Tab; arrow keys go through the others.
      const card = (id, name, spec, art, n, title) => {
        const on = ui.cabType === id;
        return (
          `<button type="button" class="cab-card${on ? ' is-armed' : ''}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-cab-type="${esc(id)}" title="${esc(title)}">` +
          `<span class="part-art">${art}</span><span class="part-meta"><span class="part-name">${esc(name)}</span><span class="part-spec">${esc(spec)}</span></span>` +
          (n === null ? '' : `<span class="part-count${n ? '' : ' is-zero'}" title="${n} in the plan">${n}</span>`) +
          `</button>`
        );
      };
      const types =
        card('auto', 'Auto', 'by connectors and length', cableArt(null), null, 'New cables get the first cable type that fits both ports and reaches') +
        p.cableTypes.map((t) => card(t.id, t.name, typeSpec(t), cableArt(t), counts ? counts.get(t.id) || 0 : null, `New cables are ${t.name}`)).join('');
      const typesKey = ui.theme + types;
      if (binHTML.types !== typesKey) {
        ctx.keepFocus($('#cab-types'), () => ($('#cab-types').innerHTML = types));
        binHTML.types = typesKey;
      }
    }

    function renderBin() {
      if (typing.hold) return;
      const p = project();
      $('#racks-parts-sec').hidden = true;
      $('#racks-clusters-sec').hidden = true;
      $('#cab-types-sec').hidden = false;
      $('#cab-nets-sec').hidden = false;
      $('#bin').setAttribute('aria-label', 'Cables and networks');
      drawTypeCards();

      const per = new Map();
      for (const c of p.cables) per.set(netKey(c), (per.get(netKey(c)) || 0) + 1);
      // Each button has a data attribute of its own, by which keyboard focus finds it again once the list is drawn anew.
      const row = (id, name, color, n, editable) =>
        `<li class="cl-row" data-network="${esc(id)}">` +
        `<button type="button" class="cl-main" data-net-focus="${esc(id)}" aria-pressed="${ui.focusNetwork === id}"><span class="sw sw-net" style="--c:${color}"></span>` +
        `<span class="cl-name">${esc(name)}</span><span class="cl-count" title="${plural(n, 'cable')}">${n}</span></button>` +
        (editable
          ? `<button type="button" class="btn icon sm subtle cl-edit" data-net-edit="${esc(id)}" aria-label="Edit ${esc(name)}" title="Rename, recolor or change its labels">${icon('pencil')}</button>`
          : `<span class="btn icon sm subtle" aria-hidden="true" style="visibility:hidden"></span>`) +
        `</li>`;
      let nets = p.networks.map((n) => row(n.id, n.name, n.color, per.get(n.id) || 0, true)).join('');
      if (per.get(NONE)) nets += row(NONE, 'No network', 'var(--unassigned)', per.get(NONE), false);
      nets = nets || `<li class="cl-empty">No networks yet.</li>`;
      if (binHTML.nets !== nets) {
        ctx.keepFocus($('#networks'), () => ($('#networks').innerHTML = nets));
        binHTML.nets = nets;
      }
      const ports = p.devices.reduce((a, d) => a + portsOf(d).size, 0);
      const free = ports - cableIndex().size;
      $('#networks-hint').textContent = !p.networks.length
        ? 'Networks give cables a color and a series of labels.'
        : ui.focusNetwork
          ? 'Click the highlighted network again to show all cables.'
          : `Click a network to show only its cables. ${plural(free, 'port is', 'ports are')} still free.`;
    }
    /** Back to the Racks workspace. */
    function hideBin() {
      $('#racks-parts-sec').hidden = false;
      $('#racks-clusters-sec').hidden = false;
      $('#cab-types-sec').hidden = true;
      $('#cab-nets-sec').hidden = true;
      $('#bin').setAttribute('aria-label', 'Devices and clusters');
      $('.view-toggle').hidden = false;
      $('#cab-toggle').hidden = true;
      hideStage();
    }

    $('#cab-types').addEventListener('click', (e) => {
      const card = e.target.closest('[data-cab-type]');
      if (!card) return;
      armType(card.dataset.cabType);
    });
    /** Arms a cable type for new cables; legs set for a breakout cable start again. */
    function armType(id) {
      ui.cabType = id;
      if (ui.pending) ui.pending = Object.assign({}, ui.pending, { legs: [] });
      ctx.render({ inspector: false });
    }
    // Arrow keys move between the cable types like a radio group.
    $('#cab-types').addEventListener('keydown', (e) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const cards = $$('[data-cab-type]', $('#cab-types'));
      const i = cards.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const next = cards[(i + (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1) + cards.length) % cards.length];
      armType(next.dataset.cabType);
      const again = $(`[data-cab-type="${CSS.escape(ui.cabType)}"]`);
      if (again) again.focus();
    });
    $('#btn-cab-catalog').addEventListener('click', () => ctx.openCatalog('cables'));

    $('#networks').addEventListener('click', (e) => {
      const rowEl = e.target.closest('.cl-row');
      if (!rowEl) return;
      const id = rowEl.dataset.network;
      if (e.target.closest('.cl-edit')) return openNetworkDialog(id);
      if (e.target.closest('.cl-main')) {
        ui.focusNetwork = ui.focusNetwork === id ? null : id;
        ui.hoverNetwork = null;
        // The fabric follows the network put in focus.
        fab.network = null;
        renderAfterFocus();
      }
    });
    // Hovering a network highlights its cables in the elevation and the port map; the schedule only follows a click.
    $('#networks').addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch') return;
      const rowEl = e.target.closest('.cl-row');
      const id = rowEl ? rowEl.dataset.network : null;
      if (id === ui.hoverNetwork) return;
      ui.hoverNetwork = id;
      if (showsHover()) ctx.renderStage();
    });
    $('#networks').addEventListener('pointerleave', () => {
      if (!ui.hoverNetwork) return;
      ui.hoverNetwork = null;
      if (showsHover()) ctx.renderStage();
    });
    /** Whether the view shown brings the network hovered forward: the elevation and the port map (the fabric shows one network, the schedule follows clicks). */
    const showsHover = () => ui.cabView === 'elevation' || ui.cabView === 'ports';
    $('#btn-add-network').addEventListener('click', () => openNetworkDialog(null));

    /** The network new cables get: the one in focus, else the one used last. */
    function defaultNetwork() {
      if (ui.focusNetwork && ui.focusNetwork !== NONE && netOf(ui.focusNetwork)) return ui.focusNetwork;
      if (ui.focusNetwork === NONE) return null;
      return prefs.lastNetwork && netOf(prefs.lastNetwork) ? prefs.lastNetwork : null;
    }
    function rememberNetwork(id) {
      prefs.lastNetwork = id || null;
      ctx.savePrefs();
    }

    // ------------------------------------------------------------ inspectors

    /**
     * Commits `mutate(draft)`, which returns an error message (the plan
     * stays as it is) or nothing; returns the message. `change.made` says
     * whether the plan changed: an edit that changes nothing records no
     * undo step, so its toast offers no Undo (that would undo the step
     * before it).
     */
    function change(mutate, opts) {
      let err = null;
      change.made = ctx.commit((p) => {
        err = mutate(p) || null;
        return err ? false : undefined;
      }, opts) === true;
      return err;
    }
    change.made = false;
    /**
     * Commits a keystroke in a cable's label or notes. On a large plan the
     * schedule and the panel follow once typing pauses, as the schedule's
     * filter does: each keystroke would describe every cable again.
     */
    function changeTyped(mutate, key, after) {
      const big = project().cables.length > 400;
      typing.hold = big;
      try {
        change(mutate, { key, inspector: false });
      } finally {
        typing.hold = false;
      }
      if (!big) {
        if (after) after();
        return;
      }
      clearTimeout(typing.timer);
      typing.timer = setTimeout(() => {
        if (ui.workspace !== 'cabling') return;
        ctx.render({ inspector: false });
        if (after) after();
      }, 150);
    }

    /**
     * Commits a field that commits as it is left: a length, a slack, a row
     * pitch. Its change fires before focus reaches the next field, so the
     * inspector, which shows what follows from the value, is drawn again
     * once focus has got there: drawn at once, it would take that field away.
     */
    function changeOnLeave(mutate) {
      const err = change(mutate, { inspector: false });
      if (err) toast(err, { warn: true });
      renderInspectorSoon();
      return err;
    }
    let inspectorTimer = null;
    /** Draws the inspector again after the event under way, with keyboard focus back on the field or button it was on. */
    function renderInspectorSoon() {
      clearTimeout(inspectorTimer);
      inspectorTimer = setTimeout(() => {
        inspectorTimer = null;
        if (ui.workspace !== 'cabling') return;
        const a = document.activeElement;
        let sel = null;
        if (a && a !== el.inspector && el.inspector.contains(a)) {
          const attr = [...a.attributes].find((x) => x.name.startsWith('data-'));
          sel = a.id ? `#${CSS.escape(a.id)}` : attr ? `[${attr.name}="${CSS.escape(attr.value)}"]` : null;
        }
        ctx.renderInspector();
        const again = sel && el.inspector.querySelector(sel);
        if (again && document.activeElement !== again && !again.disabled) again.focus({ preventScroll: true });
      });
    }

    function changeOrToast(mutate, opts) {
      const err = change(mutate, opts);
      if (err) {
        toast(err, { warn: true });
        ctx.render();
      }
      return err;
    }

    function inspectorKey() {
      return JSON.stringify([ui.cabSel || null, ui.cabView]);
    }

    function renderInspector() {
      const s = ui.cabSel;
      if (s && s.kind === 'cables') {
        const list = s.ids.map(cableById).filter(Boolean);
        if (list.length === 1) cableInspector(list[0]);
        else cablesInspector(list);
      } else if (s && s.kind === 'devices') {
        const d = s.ids.length === 1 ? deviceById(s.ids[0]) : null;
        const net = d && ui.cabView === 'fabric' ? fabricNetwork() : null;
        if (net && fabricOf(net).switches.some((x) => x.id === d.id)) fabricInspector(d, net);
        else if (d) deviceInspector(d);
        else devicesInspector(s.ids.map(deviceById).filter(Boolean));
      } else if (s && s.kind === 'port') portInspector(deviceById(s.device), s.port);
      else overviewInspector();
    }

    /** Whether the elevation shown draws a cable (on the side shown) or a device (in the row shown). */
    function drawnInElevation(kind, id) {
      const L = ui.cabView === 'elevation' && elev.layout;
      if (!L || elev.rowId !== ui.rowId || elev.side !== prefs.cabSide) return false;
      return kind === 'cable' ? L.cables.has(id) : L.devices.has(id);
    }
    /** "Show in elevation" for a cable or a device, unless the elevation shown already draws it. */
    const showButton = (kind, id) =>
      drawnInElevation(kind, id) ? '' : `<button type="button" class="btn" data-cab-show-${kind}="${esc(id)}" title="The row and side of the racks where it is seen, scrolled to it">${icon('rack')}Show in elevation</button>`;
    const swatch = (color) => `<span class="sw sw-net" style="--c:${color}"></span>`;
    const checkItem = (x) => `<li>${issueIcon(x.level)}<span>${esc(x.text)}</span></li>`;
    function checksSection(d) {
      return (
        `<section class="insp-sec" id="cab-checks"><h3>Checks</h3><ul class="check-list">` +
        (d.issues.length ? d.issues.map(checkItem).join('') : `<li>${icon('check', 'ic-sm is-ok')}<span>No problems</span></li>`) +
        `</ul></section>`
      );
    }

    /**
     * Network chips: none, the networks, and “+ New network”; `selected`
     * undefined checks none (mixed). Each has an id, so that the inspector
     * drawn again after a change puts focus back on it and arrow keys go on
     * through the chips.
     */
    function networkRadios(name, selected) {
      const chip = (value, label, color, checked, cls) =>
        `<label class="chip${cls || ''}"><input type="radio" name="${name}" id="${esc(`${name}-${value || 'none'}`)}" value="${esc(value)}"${checked ? ' checked' : ''}>` +
        `<span>${color !== undefined ? `<i class="sw" style="--c:${color}"></i>` : ''}${esc(label)}</span></label>`;
      let s = chip('', 'None', 'var(--unassigned)', selected === null);
      for (const n of project().networks) s += chip(n.id, n.name, n.color, selected === n.id);
      if (project().networks.length < M.LIMITS.networks) s += chip('__new', '+ New network', undefined, false, ' chip-new');
      return s;
    }

    /** <option>s of cable types for a cable: Auto (single cables only), the types that fit its ports, then the others. */
    function typeOptions(c, current) {
      const p = project();
      const k = fresh();
      const breakout = Array.isArray(c.b);
      const need = C.neededLength(p, c, k.ctx);
      const metres = c.lengthM === null || c.lengthM === undefined ? (need ? need.m : null) : c.lengthM;
      const fits = [];
      const others = [];
      for (const t of p.cableTypes) {
        if (breakout ? t.legs !== c.b.length : t.legs > 1) continue;
        const r = C.resolve(p, Object.assign({}, c, { type: t.id }), metres, k.ctx);
        const ok = r.fits.a && r.fits.b.every((f, i) => f || !M.legsOf(c)[i]);
        (ok ? fits : others).push(t);
      }
      const opt = (t, extra) => `<option value="${esc(t.id)}"${t.id === current ? ' selected' : ''}>${esc(t.name)}${extra || ''}</option>`;
      let html = '';
      if (!breakout) {
        const auto = C.resolve(p, Object.assign({}, c, { type: null }), metres, k.ctx).type;
        html += `<option value=""${!current ? ' selected' : ''}>Auto: ${esc(auto ? auto.name : 'no type fits')}</option>`;
      }
      html += fits.map((t) => opt(t)).join('');
      if (others.length) html += `<optgroup label="Don’t fit these ports">${others.map((t) => opt(t, ' (doesn’t fit)')).join('')}</optgroup>`;
      return html;
    }

    /** Transceivers for one end of a fiber cable at a cage: Auto (the one picked) and those that fit; '' where none applies. */
    function transceiverField(c, d, x, k) {
      if (!d.type || !d.type.media || (C.MEDIA[d.type.media] || {}).kind !== 'fiber' || !x.port) return '';
      const conn = M.connectorById(x.port.connector);
      if (!conn || !conn.cage) return '';
      const p = project();
      const metres = d.lengthAuto ? d.needM : c.lengthM;
      const flip = C.resolve(p, c, metres, fresh().ctx).flip;
      const plug = (x.role === 'a') !== flip ? d.type.connector : d.type.connectorB;
      const mode = C.MEDIA[d.type.media].mode;
      const chosen = x.end.transceiver || '';
      const list = p.transceivers.filter((t) => M.plugFits(t.connector, x.port.connector) && t.fiber === plug && t.mode === mode);
      // What Auto picks: the one picked now, or with a transceiver chosen by hand, the one picked without it (for this cable type).
      let auto = x.transceiver;
      if (chosen) {
        const bare = (e) => Object.assign({}, e, { transceiver: undefined });
        const leg = x.leg === null ? 0 : x.leg;
        const draft = Object.assign({}, c, { type: d.type.id }, x.role === 'a' ? { a: bare(c.a) } : Array.isArray(c.b) ? { b: c.b.map((e, i) => (i === leg ? bare(e) : e)) } : { b: bare(c.b) });
        const r = C.resolve(p, draft, metres, fresh().ctx);
        auto = x.role === 'a' ? r.transceivers.a : r.transceivers.b[leg];
      }
      const picked = auto ? auto.name : 'none fits';
      let opts = `<option value=""${chosen ? '' : ' selected'}>Auto: ${esc(picked)}</option>`;
      opts += list.map((t) => `<option value="${esc(t.id)}"${t.id === chosen ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
      if (chosen && !list.some((t) => t.id === chosen)) {
        const t = M.transceiverById(p, chosen);
        opts += `<option value="${esc(chosen)}" selected>${esc(t ? t.name : chosen)} (doesn’t fit)</option>`;
      }
      return `<label class="sr-only" for="cab-tr-${k}">Transceiver</label><select id="cab-tr-${k}" class="end-tr" data-cab-tr="${k}">${opts}</select>`;
    }

    /** The ends of a cable: the head, then the far end or each leg of a breakout. */
    function endsSection(c, d) {
      const legs = M.legsOf(c);
      const breakout = Array.isArray(c.b);
      const item = (x, tag, k) => {
        const dev = x.device;
        if (!dev) return '';
        const face = x.face ? `${x.face} of the rack` : '';
        const spec = x.port ? portSpec(x.port) : 'no such port';
        const w = where(dev);
        // A long device name is cut short, not the port after it.
        return (
          `<li class="end-item"><span class="end-tag">${tag}</span><div class="end-main">` +
          `<button type="button" class="end-dev" data-cab-select-device="${esc(dev.id)}" title="${esc(`${dev.name} · ${x.end.port}: select the device`)}"><b>${esc(dev.name)}</b><span> · ${esc(x.end.port)}</span></button>` +
          `<small>${esc(dotLine([w.pos.rack.name, w.at, face, spec]))}</small>${transceiverField(c, d, x, k)}</div>` +
          (breakout && x.role === 'b' ? `<button type="button" class="btn icon sm subtle" data-cab-unplug-leg="${x.leg}" title="Unplug this leg" aria-label="Unplug leg ${x.leg + 1}">${icon('unplug')}</button>` : '') +
          `</li>`
        );
      };
      let html = '';
      const head = d.ends.find((x) => x.role === 'a');
      if (head) html += item(head, breakout ? 'Head' : 'A', 'a');
      legs.forEach((leg, i) => {
        const x = d.ends.find((e) => e.role === 'b' && (e.leg === null ? 0 : e.leg) === i);
        if (x) html += item(x, breakout ? `Leg ${i + 1}` : 'B', `b${i}`);
        else {
          const armed = ui.pending && ui.pending.fill && ui.pending.fill.cable === c.id && ui.pending.fill.leg === i;
          html +=
            `<li class="end-item is-free"><span class="end-tag">Leg ${i + 1}</span><div class="end-main"><small>${armed ? 'Click a free port to plug it in' : 'Not plugged in'}</small></div>` +
            `<button type="button" class="btn sm subtle" data-cab-plug-leg="${i}" aria-pressed="${!!armed}" title="Plug this leg into the next free port clicked">${icon('cable', 'ic-sm')}Plug in…</button></li>`;
        }
      });
      return `<section class="insp-sec"><h3>Ends</h3><ul class="end-list">${html}</ul></section>`;
    }

    /** Network, type, length and notes of a cable (and its label, when the name above is something else). */
    function cableFields(c, d, withLabel) {
      const auto = d.type && d.needM !== null ? C.stockLength(d.type, d.needM) : null;
      const need = d.needM === null ? '' : needText(d.needM).replace(/ m$/, '');
      const placeholder = d.needM === null ? 'enter the length' : auto === null ? `needs ${need} m` : `${C.fmtM(auto)} (needs ${need})`;
      // What an empty field gives, for this cable and its type.
      const hint = !d.type
        ? 'Empty: the length it needs, once a cable type fits it.'
        : d.needM === null
          ? 'Its ends are on different floors: enter the length.'
          : !d.type.lengthsM.length
            ? `Empty: the length it needs, rounded up to 0.1 m (${d.type.name} is made to length).`
            : auto === null
              ? `Empty: no length, as no stock length of ${d.type.name} reaches ${need} m.`
              : 'Empty: the length it needs, rounded up to a stock length.';
      return (
        `<section class="insp-sec"><h3 id="cab-net-label">Network</h3>` +
        `<div class="chips" role="radiogroup" aria-labelledby="cab-net-label">${networkRadios('cab-net', netOf(c.network) ? c.network : null)}</div></section>` +
        `<section class="insp-sec"><h3>Cable</h3><div class="field-grid">` +
        (withLabel ? `<div class="field span2"><label for="cab-label">Label</label><input id="cab-label" class="mono" type="text" value="${esc(c.label)}" maxlength="40" autocomplete="off" spellcheck="false"></div>` : '') +
        `<div class="field span2"><label for="cab-type">Cable type</label><select id="cab-type">${typeOptions(c, c.type)}</select></div>` +
        `<div class="field span2"><label for="cab-length">Length (m)</label><input id="cab-length" type="number" min="0.1" max="10000" step="0.1" inputmode="decimal" value="${c.lengthM === null ? '' : c.lengthM}" placeholder="${esc(placeholder)}">` +
        `<small class="field-hint">${esc(hint)}</small></div>` +
        `<div class="field span2"><label for="cab-notes">Notes</label><textarea id="cab-notes" rows="2" placeholder="Route, purchase order …">${esc(c.notes || '')}</textarea></div>` +
        `</div></section>`
      );
    }

    /** The head of a cable's inspector and its sections. */
    function cableInspector(c) {
      const d = describe(c);
      const route = C.routeOf(project(), c, fresh().ctx);
      const head = d.ends.find((x) => x.role === 'a');
      const farNames = [...new Set(d.ends.filter((x) => x.role === 'b').map((x) => x.device.name))];
      const sub = [...route.label.split(' · '), d.type ? d.type.name : 'no cable type', d.lengthM === null ? 'no length' : `${C.fmtM(d.lengthM)}${d.lengthAuto ? ' (est.)' : ''}`];
      el.inspector.innerHTML =
        `<div class="insp-head"><div class="kicker">${swatch(netColor(c.network))}Cable · ${esc(netName(c.network))}</div>` +
        `<label for="cab-label" class="sr-only">Cable label</label>` +
        `<input id="cab-label" class="name-input" type="text" value="${esc(c.label)}" spellcheck="false" autocomplete="off" maxlength="40">` +
        `<div class="insp-where">${esc(`${head ? head.device.name : '–'} → ${farNames.join(', ') || '–'}`)}</div>` +
        `<div class="insp-sub">${esc(dotLine(sub))}</div></div>` +
        endsSection(c, d) +
        cableFields(c, d, false) +
        checksSection(d) +
        `<div class="insp-actions is-pinned">${showButton('cable', c.id)}<button type="button" class="btn danger-text" id="cab-del" title="Delete (Del)">${icon('trash')}Delete</button></div>`;
      bindCable(c);
      $('#cab-del').addEventListener('click', () => deleteCables([c.id]));
    }

    function bindCable(c) {
      const id = c.id;
      const label = $('#cab-label');
      label.addEventListener('input', () => changeTyped((p) => C.updateCable(p, id, { label: label.value }), `cable-label:${id}`, () => labelChanged(id)));
      label.addEventListener('change', () => {
        if (label.value.trim()) return;
        // An empty label continues the network's series.
        const cur = cableById(id);
        if (cur) label.value = cur.label;
      });
      $$('input[name="cab-net"]', el.inspector).forEach((r) =>
        r.addEventListener('change', () => {
          if (r.value === '__new') {
            return openNetworkDialog(null, (p, nid) => C.updateCable(p, id, { network: nid }), () => ctx.render(), (nid) => `#${CSS.escape(`cab-net-${nid}`)}`);
          }
          rememberNetwork(r.value);
          changeOrToast((p) => C.updateCable(p, id, { network: r.value || null }));
        })
      );
      $('#cab-type').addEventListener('change', (e) => changeOrToast((p) => C.updateCable(p, id, { type: e.target.value || null })));
      const len = $('#cab-length');
      len.addEventListener('change', () => {
        const v = len.value.trim();
        const m = v === '' ? null : M.clampNum(v, 0.1, 10000, null);
        if (v !== '' && m === null) return renderInspectorSoon();
        changeOnLeave((p) => C.updateCable(p, id, { lengthM: m }));
      });
      const notes = $('#cab-notes');
      notes.addEventListener('input', () => changeTyped((p) => C.updateCable(p, id, { notes: notes.value }), `cable-notes:${id}`));
      $$('[data-cab-tr]', el.inspector).forEach((s) =>
        s.addEventListener('change', () => {
          const k = s.dataset.cabTr;
          changeOrToast((p) => {
            const cur = C.cableById(p, id);
            const set = (end) => {
              const e = Object.assign({}, end);
              if (s.value) e.transceiver = s.value;
              else delete e.transceiver;
              return e;
            };
            if (k === 'a') return C.updateCable(p, id, { a: set(cur.a) });
            const i = Number(k.slice(1));
            if (!Array.isArray(cur.b)) return C.updateCable(p, id, { b: set(cur.b) });
            const b = cur.b.slice();
            b[i] = set(b[i]);
            return C.updateCable(p, id, { b });
          });
        })
      );
      $$('[data-cab-unplug-leg]', el.inspector).forEach((b) => b.addEventListener('click', () => unplugLeg(id, Number(b.dataset.cabUnplugLeg))));
      $$('[data-cab-plug-leg]', el.inspector).forEach((b) => b.addEventListener('click', () => armLeg(id, Number(b.dataset.cabPlugLeg))));
    }

    /**
     * After a keystroke in a cable's label: what else the inspector shows of
     * it, its checks (a label used twice) and a port's line naming its
     * cable, drawn again without the field being typed in.
     */
    function labelChanged(id) {
      const c = cableById(id);
      const checks = $('#cab-checks');
      if (!c || !checks || !el.inspector.contains(checks)) return;
      checks.outerHTML = checksSection(describe(c));
      const s = ui.cabSel;
      const sub = $('#cab-port-sub');
      if (sub && s && s.kind === 'port') sub.textContent = portSubText(deviceById(s.device), c);
    }

    /**
     * "Plug in…" on a leg of a breakout cable that is not plugged in: the
     * next free port clicked (in the elevation, or the port map) takes it.
     * The connection being made is the cable's head, with the leg to fill;
     * pressed again, it stops. Opens the elevation of the cable when the
     * view shown has no ports to click.
     */
    function armLeg(id, i) {
      const c = cableById(id);
      if (!c || !Array.isArray(c.b) || c.b[i]) return;
      const pd = ui.pending;
      if (pd && pd.fill && pd.fill.cable === id && pd.fill.leg === i) return cancelPending();
      if (ui.cabView !== 'elevation' && ui.cabView !== 'ports') showInElevation({ cable: id });
      ui.pending = { device: c.a.device, port: c.a.port, legs: [], fill: { cable: id, leg: i } };
      ui.cabSel = { kind: 'cables', ids: [id] };
      ctx.render();
      const again = $(`[data-cab-plug-leg="${i}"]`, el.inspector);
      if (again) again.focus({ preventScroll: true });
    }

    /** Plugs the leg armed by "Plug in…" into `end`; false when it was refused. */
    function fillLeg(end) {
      const { cable: id, leg: i } = ui.pending.fill;
      const c = cableById(id);
      if (!c) return false;
      const err = change(
        (p) => {
          const cur = C.cableById(p, id);
          if (!cur || !Array.isArray(cur.b)) return 'Unknown cable';
          const b = cur.b.slice();
          b[i] = { device: end.device, port: end.port };
          return C.updateCable(p, id, { b });
        },
        { inspector: false }
      );
      if (err) {
        toast(err, { warn: true });
        ctx.render();
        return false;
      }
      ui.pending = null;
      ui.cabSel = { kind: 'cables', ids: [id] };
      ctx.render();
      toast(`Plugged leg ${i + 1} of ${c.label || 'the cable'} into ${endText(end)}`, { action: 'Undo', onAction: ctx.undo });
      return true;
    }

    function unplugLeg(id, i) {
      const c = cableById(id);
      if (!c || !Array.isArray(c.b)) return;
      const left = c.b.filter((e, k) => e && k !== i).length;
      const err = changeOrToast((p) => {
        if (!left) return void C.disconnect(p, id);
        const b = C.cableById(p, id).b.slice();
        b[i] = null;
        return C.updateCable(p, id, { b });
      });
      // The cable as it is now: one without a label may have been given one.
      const now = left ? cableById(id) : null;
      const name = (now && now.label) || c.label || 'the cable';
      if (!err) toast(left ? `Unplugged leg ${i + 1} of ${name}` : `Deleted ${name}, its last leg unplugged`, { action: 'Undo', onAction: ctx.undo });
    }

    /**
     * Unplugs the cable at a port, which stays selected: a breakout loses
     * only the leg plugged in there (all of it with its last leg), any
     * other cable goes. Returns false when the port has no cable.
     */
    function unplugPort(deviceId, portName) {
      const hit = cableIndex().get(`${deviceId}|${portName}`);
      if (!hit) return false;
      const c = hit.cable;
      if (hit.role === 'b' && Array.isArray(c.b)) {
        unplugLeg(c.id, hit.leg);
        return true;
      }
      ctx.commit((p) => void C.disconnect(p, c.id));
      toast(`Unplugged ${c.label || 'a cable'}`, { action: 'Undo', onAction: ctx.undo });
      return true;
    }

    function deleteCables(ids) {
      const list = ids.map(cableById).filter(Boolean);
      if (!list.length) return;
      ui.cabSel = null;
      const focus = rowFocus(list.map((c) => c.id));
      ctx.commit((p) => void C.disconnect(p, list.map((c) => c.id)));
      restoreRowFocus(focus);
      toast(`Deleted ${list.length === 1 ? list[0].label || 'a cable' : plural(list.length, 'cable')}`, { action: 'Undo', onAction: ctx.undo });
    }

    /**
     * The schedule's row whose checkbox has keyboard focus, before cables
     * `going` go: { at, key } (its item), where `at` is the first row going
     * when that row goes too (so that the row after them takes its place);
     * or null.
     */
    function rowFocus(going) {
      const a = document.activeElement;
      const body = $('#sc-body');
      if (ui.cabView !== 'schedule' || !body || !a || !body.contains(a) || !a.matches('input[type="checkbox"]')) return null;
      const items = sched.items || [];
      let at = itemOf(a.closest('tr'));
      if (at < 0 || !items[at]) return null;
      const gone = new Set(going);
      if (gone.has(items[at].cable)) at = items.findIndex((x) => gone.has(x.cable));
      return { at, key: items[itemOf(a.closest('tr'))].key };
    }
    /**
     * After the table is drawn anew (its cables deleted), keyboard focus goes
     * back to the checkbox of the row it was on when that is still there,
     * else to the row that took its place (the one before, at the end), else
     * to the header's checkbox.
     */
    function restoreRowFocus(f) {
      if (!f || ui.cabView !== 'schedule') return;
      const a = document.activeElement;
      if (a && a !== document.body && host.contains(a)) return;
      const items = sched.items || [];
      let i = items.findIndex((x) => x.key === f.key);
      if (i < 0) i = Math.min(f.at, items.length - 1);
      let j = i;
      while (j >= 0 && j < items.length && !items[j].cable) j++;
      if (j >= items.length) for (j = Math.min(i, items.length - 1); j >= 0 && !items[j].cable; j--);
      let tr = j >= 0 ? rowAt(j) : null;
      if (j >= 0 && !tr) {
        revealCable(items[j].cable);
        tr = rowAt(j);
      }
      const box = tr && tr.querySelector('input[type="checkbox"]');
      const all = $('#sc-all');
      if (box) box.focus({ preventScroll: true });
      else if (all && !all.disabled) all.focus({ preventScroll: true });
      else if ($('#sc-filter')) $('#sc-filter').focus({ preventScroll: true });
    }

    /** Cables in the order of their rows in the schedule; those it does not show go last, as they were. */
    function inScheduleOrder(list) {
      const order = new Map(sched.visible.map((id, i) => [id, i]));
      const at = (c) => (order.has(c.id) ? order.get(c.id) : 1e9);
      return list.slice().sort((x, y) => at(x) - at(y));
    }

    /** Several cables: set their network or type, renumber their labels, delete them. */
    function cablesInspector(list) {
      const p = project();
      const ds = list.map(describe);
      const byType = new Map();
      for (const d of ds) byType.set(d.type ? d.type.name : 'no type', (byType.get(d.type ? d.type.name : 'no type') || 0) + 1);
      const nets = new Set(list.map((c) => (netOf(c.network) ? c.network : null)));
      const sameNet = nets.size === 1 ? [...nets][0] : undefined;
      const types = new Set(list.map((c) => c.type || ''));
      const sameType = types.size === 1 ? [...types][0] : undefined;
      const metres = ds.reduce((a, d) => a + (d.lengthM || 0), 0);
      const warn = ds.filter((d) => d.issues.some((x) => x.level === 'warn')).length;
      // In the order of the schedule, so that renumbering follows the rows.
      const sorted = inScheduleOrder(list);
      const single = list.every((c) => !Array.isArray(c.b));
      const typeOpts =
        (sameType === undefined ? `<option value="__keep" selected>Mixed: pick one for all</option>` : '') +
        (single ? `<option value=""${sameType === '' ? ' selected' : ''}>Auto: by connectors and length</option>` : '') +
        p.cableTypes.map((t) => `<option value="${esc(t.id)}"${t.id === sameType ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
      const rows = sorted
        .slice(0, 200)
        .map((c) => {
          const d = describe(c);
          return (
            `<li><button type="button" data-cab-cable="${esc(c.id)}" title="${esc(`${endText(c.a)} → ${M.legsOf(c).filter(Boolean).map(endText).join(', ')}`)}">` +
            `<span class="u">${esc(shortType(d.type))}</span><span class="sw sw-net" style="--c:${netColor(c.network)}"></span><span class="nm">${esc(c.label || '–')}</span></button></li>`
          );
        })
        .join('');
      el.inspector.innerHTML =
        `<div class="insp-head"><div class="kicker">${icon('select', 'ic-sm')}Selection</div>` +
        `<div class="multi-title">${plural(list.length, 'cable')}</div>` +
        `<div class="insp-where">${esc([...byType].map(([t, n]) => `${n} × ${t}`).join(', '))}</div>` +
        `<div class="insp-sub">${esc(`${Math.round(metres * 10) / 10} m of cable${warn ? ` · ${warn} to check` : ''}`)}</div></div>` +
        `<section class="insp-sec"><h3 id="multi-net-label">Network</h3>` +
        `<div class="chips" role="radiogroup" aria-labelledby="multi-net-label">${networkRadios('multi-net', sameNet)}</div>` +
        (sameNet === undefined ? `<p class="sec-hint">Mixed networks; pick one to give it to all.</p>` : '') +
        `</section>` +
        `<section class="insp-sec"><h3><label for="multi-type">Cable type</label></h3><select id="multi-type">${typeOpts}</select></section>` +
        `<section class="insp-sec"><div class="field"><label for="multi-label">Labels in series, in the schedule’s order</label>` +
        `<div class="inline"><input id="multi-label" class="mono" type="text" value="${esc(sorted[0].label)}" maxlength="40" autocomplete="off" spellcheck="false">` +
        `<button type="button" class="btn sm" id="multi-renumber">Renumber</button></div></div></section>` +
        `<section class="insp-sec"><h3>Cables</h3><ol class="contents" style="--u-w:${Math.max(0, ...sorted.slice(0, 200).map((c) => shortType(describe(c).type).length))}ch">${rows}</ol>${list.length > 200 ? `<p class="sec-hint">and ${list.length - 200} more</p>` : ''}</section>` +
        `<div class="insp-actions is-pinned"><button type="button" class="btn" id="multi-clear">Clear selection</button>` +
        `<button type="button" class="btn danger-text" id="multi-del" title="Delete (Del)">${icon('trash')}Delete ${list.length}</button></div>`;

      const ids = list.map((c) => c.id);
      // One refused change leaves them all as they were.
      const all = (p2, changes) => {
        const refused = C.updateCables(p2, ids, changes);
        return refused.length ? refused[0].error : null;
      };
      $$('input[name="multi-net"]', el.inspector).forEach((r) =>
        r.addEventListener('change', () => {
          const apply = (p2, nid) => all(p2, { network: nid });
          if (r.value === '__new') return openNetworkDialog(null, apply, () => ctx.render(), (nid) => `#${CSS.escape(`multi-net-${nid}`)}`);
          rememberNetwork(r.value);
          changeOrToast((p2) => apply(p2, r.value || null));
        })
      );
      $('#multi-type').addEventListener('change', (e) => {
        const v = e.target.value;
        if (v === '__keep') return;
        let refused = [];
        ctx.commit((p2) => {
          refused = C.updateCables(p2, ids, { type: v || null });
          return refused.length === ids.length ? false : undefined;
        });
        if (refused.length) toast(`${plural(refused.length, 'cable')} kept ${refused.length === 1 ? 'its' : 'their'} type: ${refused[0].error}`, { warn: true });
        if (refused.length === ids.length) ctx.render();
      });
      $('#multi-renumber').addEventListener('click', () => {
        const first = $('#multi-label').value.trim();
        if (!first) return;
        // The schedule's order as it is now: its grouping or filters may have changed since this was drawn.
        const order = inScheduleOrder(ids.map(cableById).filter(Boolean)).map((c) => c.id);
        const labels = M.nameSequence(first, order.length).map((l) => l.slice(0, 40));
        const err = changeOrToast((p2) => {
          const refused = C.updateCables(p2, order, (c, i) => ({ label: labels[i] }));
          return refused.length ? refused[0].error : null;
        });
        if (err) return;
        if (change.made) toast(`Labeled ${labels[0]} … ${labels[labels.length - 1]}`, { action: 'Undo', onAction: ctx.undo });
        else toast(`${labels[0]} … ${labels[labels.length - 1]}: the labels are in this sequence already`);
      });
      $('#multi-clear').addEventListener('click', clearSelection);
      $('#multi-del').addEventListener('click', () => deleteCables(ids));
    }

    /**
     * The width of the port names in a port list, in px: as wide as the
     * longest name, so that "Ethernet1/1" to "Ethernet1/32" are not all cut
     * to "Ethernet1…" (the CSS keeps it to part of the list's width).
     */
    function nameColumn(ports) {
      const font = `600 12.5px ${getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || 'monospace'}`;
      let w = 0;
      for (const pt of ports) w = Math.max(w, ctx.measure(pt.name, font));
      // A little over the measure: a font still loading measures narrower than the one drawn.
      return Math.ceil(w * 1.05) + 2;
    }

    /** One port of a device, as a row of its port list. */
    function portRow(d, pt, idx) {
      const hit = idx.get(`${d.id}|${pt.name}`);
      // A long spec breaks between the plug and the speed ("Mini-SAS HD" / "12G").
      const spec = dotLine([connLabel(pt.connector)]) + (pt.speedGbps ? ` ${C.shortSpeed(pt.speedGbps)}` : '');
      const name = `<button type="button" class="pl-port" data-cab-port="${esc(pt.name)}" title="${esc(`${pt.name} · ${portSpec(pt)}: show this port`)}"><b>${esc(pt.name)}</b><small>${esc(spec)}</small></button>`;
      if (!hit) {
        return (
          `<li class="pl-row is-free"><span class="pl-jack"></span>${name}` +
          `<span class="pl-peer"><span class="pl-free">Free</span></span><button type="button" class="btn sm subtle" data-cab-connect="${esc(pt.name)}">Connect…</button></li>`
        );
      }
      const c = hit.cable;
      const info = describe(c);
      const far = hit.role === 'a' ? M.legsOf(c).filter(Boolean) : [c.a];
      const farDev = far.length ? deviceById(far[0].device) : null;
      const peer = far.length > 1 ? `${farDev.name} · ${far.length} legs` : farDev ? `${farDev.name} · ${far[0].port}` : '–';
      // On a narrow inspector the far device and its port break between the two, not inside either.
      const peerLine = far.length > 1 ? dotLine([farDev.name, `${far.length} legs`]) : farDev ? dotLine([farDev.name, far[0].port]) : '–';
      // The far end's place (without the rack when it is this device's own), then the cable and its length, as short as they go.
      const place = farDev ? (farDev.loc.rack === d.loc.rack ? where(farDev).at : where(farDev).short) : '';
      const cable = [info.type ? shortType(info.type) : '', info.lengthM === null ? '' : C.fmtM(info.lengthM)].filter(Boolean).join(' ');
      // On a narrow inspector it breaks between the two, not inside either.
      const meta = dotLine([place, cable]);
      const issue = info.issues[0];
      return (
        `<li class="pl-row"><span class="pl-jack" style="--c:${netColor(c.network)}"></span>${name}` +
        `<button type="button" class="pl-peer" data-cab-cable="${esc(c.id)}" title="${esc(`${c.label}: ${peer} · ${meta.replace(/\u00a0/g, ' ')}. Click to select this cable`)}"><b>${esc(peerLine)}</b><small>${esc(meta)}</small></button>` +
        `<span class="pl-flag"${issue ? ` title="${esc(issue.text)}"` : ''}>${issue ? issueIcon(issue.level) : ''}</span></li>`
      );
    }

    function mountField(d) {
      const radio = (v, text) =>
        `<label><input type="radio" name="cab-mount" id="cab-mount-${v ? 'back' : 'front'}" value="${v ? 'back' : 'front'}"${!!d.reversed === v ? ' checked' : ''}><span>${text}</span></label>`;
      return `<div class="seg seg-fill" role="radiogroup" aria-labelledby="cab-mount-label">${radio(false, 'Front to front')}${radio(true, 'Back to front')}</div>`;
    }

    function deviceInspector(d) {
      const p = project();
      const type = M.typeOf(p, d.type);
      const cl = M.clusterById(p, d.cluster);
      const w = where(d);
      const ports = [...portsOf(d).values()];
      const idx = cableIndex();
      const used = ports.filter((pt) => idx.has(`${d.id}|${pt.name}`)).length;
      const cables = C.cablesOfDevice(p, d.id);
      const shown = ports.slice(0, 400);
      el.inspector.innerHTML =
        `<div class="insp-head"><div class="kicker"><span class="sw" style="--c:${cl ? cl.color : 'var(--unassigned)'}"></span>${esc(type.label)} · ${M.deviceHeight(p, d)}U</div>` +
        `<div class="name-input name-static">${esc(d.name)}</div>` +
        `<div class="insp-where">${esc(w.full)}</div>` +
        `<div class="insp-sub">${esc(`${w.pos.floor.name} · ${w.pos.row.name} · ${used} of ${plural(ports.length, 'port')} cabled`)}</div></div>` +
        (type.face === 'reserved'
          ? ''
          : `<section class="insp-sec"><h3 id="cab-mount-label">Mounted</h3>${mountField(d)}<div class="field-grid">` +
            `<div class="field"><label for="cab-dev-slack">Slack per cable (m)</label><input id="cab-dev-slack" type="number" min="0" max="10" step="0.05" inputmode="decimal" value="${d.slackM == null ? '' : d.slackM}" placeholder="${type.slackM || 0} (type)"></div>` +
            `</div></section>`) +
        `<section class="insp-sec"><h3>Ports</h3>` +
        (ports.length
          ? `<ul class="port-list" style="--pl-name:${nameColumn(shown)}px">${shown.map((pt) => portRow(d, pt, idx)).join('')}</ul>${ports.length > shown.length ? `<p class="sec-hint">and ${ports.length - shown.length} more ports</p>` : ''}`
          : `<p class="empty-note">${esc(type.label)} has no ports. Give its type ports in the catalog.</p>`) +
        `</section>` +
        `<div class="insp-actions is-pinned">${showButton('device', d.id)}<button type="button" class="btn" id="cab-dev-series"${ports.length ? '' : ' disabled'}>${icon('swap')}Connect series…</button>` +
        `<button type="button" class="btn danger-text" id="cab-dev-unplug"${cables.length ? '' : ' disabled'}>${icon('unplug')}Unplug all</button></div>`;
      const id = d.id;
      $$('input[name="cab-mount"]', el.inspector).forEach((r) => r.addEventListener('change', () => ctx.commit((p2) => void (M.deviceById(p2, id).reversed = r.value === 'back'))));
      const slack = $('#cab-dev-slack');
      if (slack) {
        slack.addEventListener('change', () => {
          const v = slack.value.trim() === '' ? null : M.clampNum(slack.value, 0, 10, null);
          changeOnLeave((p2) => void (M.deviceById(p2, id).slackM = v));
          const kept = deviceById(id);
          slack.value = kept && kept.slackM != null ? kept.slackM : '';
        });
      }
      // From a switch the series ends at it; from anything else it starts there.
      $('#cab-dev-series').addEventListener('click', () => openConnect(C.isSwitch(p, d) ? { series: true, to: id } : { series: true, from: [id] }));
      $('#cab-dev-unplug').addEventListener('click', () => unplugDevice(d));
    }

    const rangeName = C.rangeName;
    /** "11 × 200G", or "3 · 600G" for links of different speeds. */
    function linksText(links) {
      const n = links.reduce((a, l) => a + l.count, 0);
      const speeds = new Set(links.map((l) => l.speedGbps));
      const total = links.reduce((a, l) => a + l.totalGbps, 0);
      if (speeds.size === 1 && [...speeds][0]) return { n, per: `× ${C.shortSpeed([...speeds][0])}` };
      return { n, per: total ? `· ${C.shortSpeed(total)}` : '' };
    }
    /** "2.2 Tb/s", "400 Gb/s". */
    const bandwidth = (g) => (g >= 1000 ? `${Math.round(g / 100) / 10} <small>Tb/s</small>` : `${Math.round(g * 10) / 10} <small>Gb/s</small>`);

    /**
     * A switch of the fabric shown: its links down and up, the bandwidth and
     * oversubscription of a leaf, its links by peer, and the fabric's checks.
     */
    function fabricInspector(d, net) {
      const p = project();
      const f = fabricOf(net);
      const leafIds = new Set(f.leaves.map((x) => x.id));
      const swIds = new Set(f.switches.map((x) => x.id));
      const leaf = leafIds.has(d.id);
      const name = net === NONE ? 'No network' : netName(net);
      const mine = f.links.filter((l) => l.a === d.id || l.b === d.id).map((l) => Object.assign({ peer: l.a === d.id ? l.b : l.a }, l));
      // Up from a leaf: other switches; down from a core: the leaves (and nodes); between cores: across.
      const dir = (peer) => (leaf ? (swIds.has(peer) ? 'up' : 'down') : leafIds.has(peer) || !swIds.has(peer) ? 'down' : 'across');
      const down = mine.filter((l) => dir(l.peer) === 'down');
      const up = mine.filter((l) => dir(l.peer) !== 'down');
      const dt = linksText(down);
      const ut = linksText(up);
      const ratio = leaf ? f.ratios.get(d.id) : null;
      const over = ratio && ratio.ratio !== null && ratio.ratio > C.OVERSUBSCRIBED;
      // Links by peer: a switch each, nodes by their group.
      const rows = [];
      for (const l of mine.filter((x) => swIds.has(x.peer))) {
        const peer = deviceById(l.peer);
        const t = linksText([l]);
        rows.push(`<tr><td><button type="button" class="fb-peer" data-cab-select-device="${esc(peer.id)}">${esc(peer.name)}</button></td><td>${dir(l.peer)}</td><td>${t.n} ${esc(t.per)}</td></tr>`);
      }
      for (const g of f.groups) {
        const ls = mine.filter((l) => g.devices.some((x) => x.id === l.peer));
        if (!ls.length) continue;
        const names = g.devices.filter((x) => ls.some((l) => l.peer === x.id)).map((x) => x.name);
        const t = linksText(ls);
        rows.push(`<tr><td class="mono">${esc(rangeName(names))}</td><td>down</td><td>${t.n} ${esc(t.per)}</td></tr>`);
      }
      // The fabric's checks, this switch's first; nodes on several leaves on those leaves only.
      const checks = f.checks
        .filter((x) => !x.leaves || x.leaves.includes(d.id))
        .sort((a, b) => (b.device === d.id) - (a.device === d.id))
        .map((x) => ({ level: x.level, text: x.text }));
      const idx = cableIndex();
      const ports = [...portsOf(d).keys()];
      const inNet = ports.filter((n) => {
        const hit = idx.get(`${d.id}|${n}`);
        return hit && netKey(hit.cable) === net;
      }).length;
      const free = ports.filter((n) => !idx.has(`${d.id}|${n}`)).length;
      checks.push({ level: 'info', text: `${plural(free, 'free port')} on ${d.name}${free ? ' for growth' : ''}` });
      const checkIcon = (level) => (level === 'ok' ? icon('check', 'ic-sm is-ok') : issueIcon(level));
      const w = where(d);
      el.inspector.innerHTML =
        `<div class="insp-head"><div class="kicker">${swatch(netColor(net === NONE ? null : net))}${leaf ? 'Leaf' : 'Core'} switch · ${esc(name)}</div>` +
        `<div class="name-input name-static">${esc(d.name)}</div>` +
        `<div class="insp-where">${esc(w.short)}</div>` +
        `<div class="insp-sub">${esc(`${w.pos.floor.name} · ${w.pos.row.name} · ${inNet} of ${plural(ports.length, 'port')} in this network`)}</div></div>` +
        `<section class="insp-sec"><dl class="stats">` +
        `<div><dt>Down</dt><dd>${dt.n} <small>${esc(dt.per)}</small></dd></div><div><dt>${leaf ? 'Up' : 'Across'}</dt><dd>${ut.n} <small>${esc(ut.per)}</small></dd></div>` +
        `<div><dt>Bandwidth down</dt><dd>${bandwidth(down.reduce((a, l) => a + l.totalGbps, 0))}</dd></div>` +
        (leaf
          ? `<div><dt>Oversubscription</dt><dd${over ? ' class="is-bad"' : ''}>${ratio && ratio.ratio !== null ? `${esc(C.fmtRatio(ratio.ratio).replace(/:1$/, ''))} <small>: 1</small>` : '– <small>no uplinks</small>'}</dd></div>`
          : `<div><dt>Leaves</dt><dd>${down.filter((l) => leafIds.has(l.peer)).length}</dd></div>`) +
        `</dl></section>` +
        `<section class="insp-sec"><h3>Links</h3>` +
        (rows.length ? `<table class="type-table fb-links"><thead><tr><th>To</th><th>Dir.</th><th>Links</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : `<p class="empty-note">No links in ${esc(name)}.</p>`) +
        `</section>` +
        `<section class="insp-sec"><h3>Fabric checks</h3><ul class="check-list">${checks.map((x) => `<li>${checkIcon(x.level)}<span>${esc(x.text)}</span></li>`).join('')}</ul></section>` +
        `<div class="insp-actions is-pinned">${showButton('device', d.id)}<button type="button" class="btn" id="cab-fb-series">${icon('swap')}Connect series…</button></div>`;
      $('#cab-fb-series').addEventListener('click', () => openConnect({ series: true, to: d.id }));
    }

    function devicesInspector(devs) {
      const sorted = M.sortedDevices(Object.assign({}, project(), { devices: devs }));
      const rows = sorted
        .map((d) => {
          const cl = M.clusterById(project(), d.cluster);
          return (
            `<li><button type="button" data-cab-select-device="${esc(d.id)}" title="${esc(where(d).full)}">` +
            `<span class="u">${esc(where(d).short)}</span><span class="sw" style="--c:${cl ? cl.color : 'var(--unassigned)'}"></span><span class="nm">${esc(d.name)}</span></button></li>`
          );
        })
        .join('');
      el.inspector.innerHTML =
        `<div class="insp-head"><div class="kicker">${icon('select', 'ic-sm')}Selection</div><div class="multi-title">${plural(devs.length, 'device')}</div></div>` +
        `<section class="insp-sec"><h3>Devices</h3><ol class="contents" style="--u-w:${Math.max(0, ...sorted.map((d) => where(d).short.length))}ch">${rows}</ol></section>` +
        `<div class="insp-actions is-pinned"><button type="button" class="btn" id="cab-devs-series">${icon('swap')}Connect series…</button><button type="button" class="btn" id="cab-devs-clear">Clear selection</button></div>`;
      $('#cab-devs-series').addEventListener('click', () => openConnect({ series: true, from: sorted.map((d) => d.id) }));
      $('#cab-devs-clear').addEventListener('click', clearSelection);
    }

    async function unplugDevice(d) {
      const n = C.cablesOfDevice(project(), d.id).length;
      if (!n) return;
      if (n > 1) {
        const ok = await ctx.confirmDialog({ title: `Unplug ${plural(n, 'cable')}?`, body: `Every cable of ${d.name} goes; a breakout cable only loses its legs on ${d.name}. Undo brings them back.`, ok: 'Unplug all' });
        if (!ok) return;
      }
      ctx.commit((p) => {
        const id = d.id;
        p.cables = p.cables.filter((c) => {
          if (c.a.device === id) return false;
          if (!Array.isArray(c.b)) return c.b.device !== id;
          const legs = c.b.map((e) => (e && e.device === id ? null : e));
          if (!legs.some(Boolean)) return false;
          c.b = legs;
          return true;
        });
      });
      toast(`Unplugged ${plural(n, 'cable')} from ${d.name}`, { action: 'Undo', onAction: ctx.undo });
    }

    /** "Compute node · cable IB-0002", "Compute node · free". */
    function portSubText(d, cable) {
      return `${M.typeOf(project(), d.type).label} · ${cable ? `cable ${cable.label}` : 'free'}`;
    }

    function portInspector(d, portName) {
      const p = project();
      const pt = portsOf(d).get(portName);
      const hit = cableIndex().get(`${d.id}|${portName}`);
      const w = where(d);
      const ports = portsOf(d).size;
      const face = d.reversed ? (pt.side === 'front' ? 'rear' : 'front') : pt.side;
      const head =
        `<div class="insp-head"><div class="kicker">${swatch(hit ? netColor(hit.cable.network) : 'var(--surface-3)')}Port · ${esc(portSpec(pt))}</div>` +
        `<div class="name-input name-static">${esc(`${d.name} · ${pt.name}`)}</div>` +
        `<div class="insp-where">${esc(`${w.full} · ${face} of the rack`)}</div>` +
        `<div class="insp-sub" id="cab-port-sub">${esc(portSubText(d, hit && hit.cable))}</div></div>`;
      const back = `<button type="button" class="btn" data-cab-select-device="${esc(d.id)}">${icon('left')}${esc(d.name)}</button>`;
      if (hit) {
        const c = hit.cable;
        const info = describe(c);
        el.inspector.innerHTML =
          head +
          endsSection(c, info) +
          cableFields(c, info, true) +
          checksSection(info) +
          `<div class="insp-actions is-pinned">${ui.cabView === 'elevation' ? back : showButton('cable', c.id)}<button type="button" class="btn danger-text" id="cab-del" title="${hit.role === 'b' && Array.isArray(c.b) ? 'Unplug this leg of the breakout cable (Del)' : 'Unplug the cable (Del)'}">${icon('unplug')}Unplug</button></div>`;
        bindCable(c);
        $('#cab-del').addEventListener('click', () => unplugPort(d.id, portName));
        return;
      }
      const targets = deviceOptions(allDevices(), null, d.id);
      if (!targets) {
        el.inspector.innerHTML =
          head +
          `<section class="insp-sec"><h3>Connect to</h3><p class="empty-note">No other device has ports to connect to. Give a device type ports in the catalog.</p></section>` +
          `<div class="insp-actions is-pinned">${back}</div>`;
        return;
      }
      const net = defaultNetwork();
      el.inspector.innerHTML =
        head +
        `<section class="insp-sec"><h3>Connect to</h3><div class="field-grid">` +
        `<div class="field span2"><label for="cab-pc-device">Device</label><select id="cab-pc-device">${targets}</select></div>` +
        `<div class="field span2"><label for="cab-pc-port">Port</label><select id="cab-pc-port"></select></div>` +
        `<div class="field span2"><label for="cab-pc-net">Network</label><select id="cab-pc-net"><option value="">None</option>${p.networks.map((n) => `<option value="${esc(n.id)}"${n.id === net ? ' selected' : ''}>${esc(n.name)}</option>`).join('')}</select></div>` +
        `<div class="field span2"><label for="cab-pc-type">Cable type</label><select id="cab-pc-type"></select></div>` +
        `</div><p class="form-error" id="cab-pc-error" role="alert" hidden></p>` +
        `<button type="button" class="btn primary" id="cab-pc-go">${icon('cable')}Connect</button></section>` +
        `<div class="insp-actions is-pinned">${back}</div>`;
      const devSel = $('#cab-pc-device');
      const portSel = $('#cab-pc-port');
      const typeSel = $('#cab-pc-type');
      // A device to start from: a switch in the same row with a free port that takes this plug.
      const guess = guessTarget([d.id], pt);
      if (guess) devSel.value = guess.id;
      const fillPorts = () => {
        const target = deviceById(devSel.value);
        portSel.innerHTML = target ? portOptions(target, null, true) : '';
        const first = target && firstFreePort(target, pt);
        if (first) portSel.value = first.name;
        fillTypes();
      };
      const fillTypes = () => {
        const draft = { id: null, type: null, network: null, a: { device: d.id, port: pt.name }, b: { device: devSel.value, port: portSel.value }, lengthM: null };
        const cur = ui.cabType !== 'auto' && M.cableTypeById(p, ui.cabType) && M.cableTypeById(p, ui.cabType).legs === 1 ? ui.cabType : typeSel.value || '';
        typeSel.innerHTML = devSel.value && portSel.value ? typeOptions(draft, cur) : '<option value="">Auto: by connectors and length</option>';
      };
      devSel.addEventListener('change', fillPorts);
      portSel.addEventListener('change', fillTypes);
      fillPorts();
      $('#cab-pc-go').addEventListener('click', () => {
        const target = deviceById(devSel.value);
        const opt = portSel.options[portSel.selectedIndex];
        if (!target) return ctx.showError('#cab-pc-error', 'Pick a device to connect to.');
        if (!opt || opt.disabled) return ctx.showError('#cab-pc-error', `Every port of ${target.name} is in use: pick another device.`);
        let made = null;
        const props = { a: { device: d.id, port: pt.name }, b: { device: devSel.value, port: portSel.value }, type: typeSel.value || null, network: $('#cab-pc-net').value || null };
        const err = change((p2) => {
          const r = C.connect(p2, props);
          made = r.cable || null;
          return r.error;
        });
        if (err) return ctx.showError('#cab-pc-error', err);
        rememberNetwork(props.network);
        ui.cabSel = { kind: 'cables', ids: [made.id] };
        ctx.render();
        toast(`Connected ${made.label}`, { action: 'Undo', onAction: ctx.undo });
      });
    }

    /** The overview's note per view: [with a mouse, on a touch screen] (a drag from a port connects with a mouse only). */
    const OVERVIEW_NOTES = {
      elevation: ['Click a device or a port to see its cables. Drag from a port to another port to connect them.', 'Tap a device or a port to see its cables. Tap a free port, then another, to connect them.'],
      ports: ['Click a port to see its cable. Click a free port and then another, or drag from one to the other, to connect them.', 'Tap a port to see its cable. Tap a free port, then another, to connect them.'],
      schedule: ['Select a cable in the schedule, or search for a device or a cable. Shift-click selects a range of cables.', 'Select a cable in the schedule, or search for a device or a cable. Its checkbox adds it to the cables selected.'],
      fabric: ['Click a switch to see its links and oversubscription, or a box of nodes to list them.', 'Tap a switch to see its links and oversubscription, or a box of nodes to list them.'],
    };
    /** Nothing selected: the cabling of the row shown. */
    function overviewInspector() {
      const p = project();
      const pos = ctx.currentRow();
      const cables = C.cablesWithin(p, pos.row.id);
      const k = fresh();
      const inRow = new Set(pos.row.racks.map((r) => r.id));
      const toOther = cables.filter((c) => M.cableEnds(c).some((x) => {
        const d = k.ctx.devices.get(x.end.device);
        return d && !inRow.has(d.loc.rack);
      })).length;
      const bad = cables.map(describe).filter((d) => d.issues.length);
      const nets = new Set(cables.map(netKey));
      const idx = cableIndex();
      const bars = pos.row.racks
        .map((r) => {
          const devs = M.devicesWithin(p, r.id);
          let all = 0;
          let used = 0;
          for (const d of devs) {
            for (const name of portsOf(d).keys()) {
              all++;
              if (idx.has(`${d.id}|${name}`)) used++;
            }
          }
          return (
            `<div class="rack-bar cab-bar"><span class="rb-name">${esc(r.name)}</span><span class="rb-val">${used}/${all} ports</span>` +
            `<span class="rb-track"><span class="rb-fill" style="width:${all ? ((used / all) * 100).toFixed(1) : 0}%"></span></span></div>`
          );
        })
        .join('');
      const issues = bad
        .slice(0, 6)
        .map((d) => `<li><button type="button" class="check-link" data-cab-cable="${esc(d.cable.id)}">${issueIcon(d.issues[0].level)}<span><b class="mono">${esc(d.cable.label)}</b> ${esc(d.issues[0].text)}</span></button></li>`)
        .join('');
      const floor = pos.floor;
      el.inspector.innerHTML =
        `<div class="insp-head"><div class="kicker">Cabling · ${esc(pos.row.name)}</div>` +
        `<p class="insp-note">${(OVERVIEW_NOTES[ui.cabView] || OVERVIEW_NOTES.schedule).map((t, i) => `<span class="${i ? 'hint-touch' : 'hint-pointer'}">${esc(t)}</span>`).join('')}</p></div>` +
        `<section class="insp-sec"><dl class="stats"><div><dt>Cables</dt><dd>${cables.length}</dd></div><div><dt>To other rows</dt><dd>${toOther}</dd></div>` +
        `<div><dt>Networks</dt><dd>${[...nets].filter((n) => n !== NONE).length}</dd></div><div><dt>To check</dt><dd>${bad.length}</dd></div></dl></section>` +
        (bad.length ? `<section class="insp-sec"><h3>To check</h3><ul class="check-list">${issues}</ul>${bad.length > 6 ? `<p class="sec-hint">and ${bad.length - 6} more</p>` : ''}</section>` : '') +
        `<section class="insp-sec"><h3>Ports in use</h3><div class="rack-bars">${bars}</div></section>` +
        `<section class="insp-sec"><h3>Cable lengths</h3><div class="field-grid">` +
        `<div class="field"><label for="cab-pitch">Row pitch (m)</label><input id="cab-pitch" type="number" min="0.5" max="50" step="0.1" inputmode="decimal" value="${floor.rowPitchM == null ? '' : floor.rowPitchM}" placeholder="${M.DEFAULT_ROW_PITCH_M}"></div>` +
        `</div><p class="sec-hint">From one row of ${esc(floor.name)} to the next. Racks set their way up to the tray and their slack.</p></section>` +
        `<section class="insp-sec keys-sec"><h3>Shortcuts</h3><dl class="keys">` +
        `<dt><kbd>C</kbd></dt><dd>Racks or Cabling</dd>` +
        // The schedule selects ranges of its rows; the drawings add or remove what is clicked.
        (ui.cabView === 'schedule'
          ? `<dt><kbd>Shift</kbd> + click</dt><dd>Select a range of cables</dd><dt><kbd>Ctrl</kbd> + click</dt><dd>Add or remove a cable</dd>`
          : `<dt><kbd>Shift</kbd> or <kbd>Ctrl</kbd> + click</dt><dd>Add or remove a cable</dd>`) +
        (ui.cabView === 'fabric' ? '' : `<dt><kbd>Ctrl</kbd> <kbd>A</kbd></dt><dd>Select the cables shown</dd>`) +
        `<dt><kbd>Del</kbd></dt><dd>Delete the selected cables</dd>` +
        `<dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous, next row</dd>` +
        (zoomable() ? `<dt><kbd>+</kbd> <kbd>−</kbd> <kbd>0</kbd> <kbd>1</kbd></dt><dd>Zoom in, out, to fit, to 100%</dd>` : '') +
        `<dt><kbd>Esc</kbd></dt><dd>Cancel, deselect, show all networks</dd>` +
        `</dl></section>`;
      const pitch = $('#cab-pitch');
      const fid = floor.id;
      pitch.addEventListener('change', () => {
        const v = M.clampNum(pitch.value.trim() === '' ? null : pitch.value, 0.5, 50, M.DEFAULT_ROW_PITCH_M);
        changeOnLeave((p2) => void (M.floorById(p2, fid).rowPitchM = v));
        const kept = M.floorById(project(), fid);
        pitch.value = kept && kept.rowPitchM != null ? kept.rowPitchM : '';
      });
    }

    // Delegated: links between the inspector's parts.
    el.inspector.addEventListener('click', (e) => {
      if (ui.workspace !== 'cabling') return;
      const t = e.target;
      const show = t.closest('[data-cab-show-cable], [data-cab-show-device]');
      if (show) return showInElevation(show.dataset.cabShowCable ? { cable: show.dataset.cabShowCable } : { device: show.dataset.cabShowDevice });
      const cable = t.closest('[data-cab-cable]');
      if (cable) return selectCables([cable.dataset.cabCable], { reveal: true });
      const dev = t.closest('[data-cab-select-device]');
      if (dev) return selectDevices([dev.dataset.cabSelectDevice]);
      const s = ui.cabSel;
      const deviceId = s && s.kind === 'devices' && s.ids.length === 1 ? s.ids[0] : null;
      const port = t.closest('[data-cab-port]');
      if (port && deviceId) return selectPort(deviceId, port.dataset.cabPort);
      const connect = t.closest('[data-cab-connect]');
      if (connect && deviceId) return openConnect({ series: false, from: [deviceId], fromPort: connect.dataset.cabConnect });
    });

    // ------------------------------------------------------------ connect dialog

    const cs = { series: true, list: [], labelTouched: false, items: [], fromPortTouched: false };
    const dlg = $('#dlg-connect');

    const usable = (d) => d.type !== M.RESERVED.id && portsOf(d).size > 0;
    function allDevices() {
      return M.sortedDevices(project()).filter(usable);
    }
    function rowDevices(rowId) {
      const row = M.rowById(project(), rowId);
      const racks = new Set(row ? row.racks.map((r) => r.id) : []);
      return M.sortedDevices(project()).filter((d) => racks.has(d.loc.rack) && usable(d));
    }
    /** <option>s of devices grouped by rack; `skip` leaves one out. */
    function deviceOptions(list, selected, skip) {
      let html = '';
      let rack = null;
      for (const d of list) {
        if (d.id === skip) continue;
        const w = where(d);
        if (w.pos.rack !== rack) {
          if (rack) html += '</optgroup>';
          rack = w.pos.rack;
          html += `<optgroup label="${esc(`${rack.name} · ${w.pos.row.name} · ${w.pos.floor.name}`)}">`;
        }
        html += `<option value="${esc(d.id)}"${d.id === selected ? ' selected' : ''}>${esc(`${d.name} · ${w.at}`)}</option>`;
      }
      return rack ? html + '</optgroup>' : html;
    }
    /** <option>s of a device's ports, marked when in use (and disabled with `freeOnly`). */
    function portOptions(d, selected, freeOnly) {
      const idx = cableIndex();
      return [...portsOf(d).values()]
        .map((pt) => {
          const hit = idx.get(`${d.id}|${pt.name}`);
          return `<option value="${esc(pt.name)}"${pt.name === selected ? ' selected' : ''}${hit && freeOnly ? ' disabled' : ''}>${esc(`${pt.name} · ${portSpec(pt)}${hit ? ` · ${hit.cable.label || 'in use'}` : ''}`)}</option>`;
        })
        .join('');
    }
    const family = (pt) => (pt ? (M.connectorById(pt.connector) || { family: '' }).family : '');
    /** The first free port of `d`, of the family of `like` when it has one. */
    function firstFreePort(d, like) {
      const idx = cableIndex();
      const free = [...portsOf(d).values()].filter((pt) => !idx.has(`${d.id}|${pt.name}`));
      return (like && free.find((pt) => family(pt) === family(like))) || free[0] || null;
    }
    /** A device to connect to: a switch of the same row with a free port of the family, else any such device, else one with a free port joined to it. */
    function guessTarget(fromIds, like) {
      const first = deviceById(fromIds[0]);
      if (!first) return null;
      const skip = new Set(fromIds);
      const pos = fresh().ctx.racks.get(first.loc.rack);
      const pool = rowDevices(pos.row.id).filter((d) => !skip.has(d.id));
      const fits = (d) => {
        const pt = firstFreePort(d, like);
        return pt && (!like || family(pt) === family(like));
      };
      const sameRack = (d) => d.loc.rack === first.loc.rack;
      return (
        pool.find((d) => C.isSwitch(project(), d) && sameRack(d) && fits(d)) ||
        pool.find((d) => C.isSwitch(project(), d) && fits(d)) ||
        pool.find(fits) ||
        // Else one with a free port a cable joins to it, of another family (a QSFP-DD cage for a QSFP56 port).
        pool.find((d) => C.isSwitch(project(), d) && joiningPort(d, first, like)) ||
        pool.find((d) => joiningPort(d, first, like)) ||
        pool[0] ||
        null
      );
    }

    /**
     * Opens the Connect dialog. With `series`, many devices (a range of the
     * row, or `from`) get a cable each to the ports of one device; without,
     * it connects two ports. `from` and `fromPort` preset the first end.
     */
    function openConnect(o) {
      const p = project();
      cs.series = !!o.series;
      cs.labelTouched = false;
      const preset = (o.from || []).filter((id) => deviceById(id) && usable(deviceById(id)));
      const firstDev = preset.length ? deviceById(preset[0]) : null;
      const rowId = firstDev ? fresh().ctx.racks.get(firstDev.loc.rack).row.id : ui.rowId;
      cs.list = cs.series ? rowDevices(rowId) : allDevices();
      if (!cs.list.length) return toast(cs.series ? 'This row has no devices with ports' : 'No device has ports yet', { warn: true });

      $('#connect-kicker').textContent = cs.series ? 'Connect series' : 'New cable';
      $('#connect-sub').textContent = cs.series
        ? 'Each device gets a cable from its port to the next free port of the To device, top to bottom. Nothing is connected until you confirm.'
        : 'Pick both ends. The cable type, length and label follow from the ports unless you set them.';
      $('#cs-from-label').textContent = cs.series ? 'Devices' : 'Device';
      $('#cs-from-port-label').textContent = cs.series ? 'Port on each' : 'Port';
      $('#cs-to-port-label').textContent = cs.series ? 'First port' : 'Port';
      $('label[for="cs-label"]').textContent = cs.series ? 'First label' : 'Label';
      for (const s of ['#cs-dots', '#cs-from-last', '#cs-only-wrap', '#cs-step-field', '#cs-skip-wrap']) $(s).hidden = !cs.series;
      $('#cs-to-port').closest('.field').classList.toggle('span2', !cs.series);
      $('.cs-range').classList.toggle('is-one', !cs.series);

      const from = $('#cs-from');
      const last = $('#cs-from-last');
      from.innerHTML = deviceOptions(cs.list, null);
      last.innerHTML = deviceOptions(cs.list, null);
      // Without devices given: the first device of the row shown that is no switch (with a free port, for one cable), and the others of its type in its rack.
      // One cable may join any two devices of the plan, but starts in the row shown, if it has a device with ports.
      const free = (d) => cs.series || !!firstFreePort(d);
      const first = (list) => list.find((d) => !C.isSwitch(p, d) && free(d)) || list.find(free);
      const inRow = cs.series ? cs.list : rowDevices(rowId);
      const start = firstDev || first(inRow) || first(cs.list) || inRow[0] || cs.list[0];
      from.value = start.id;
      if (cs.series) {
        const same = preset.length > 1 ? preset.map(deviceById) : cs.list.filter((d) => d.type === start.type && d.loc.rack === start.loc.rack);
        const sameType = same.every((d) => d.type === start.type);
        const end = preset.length === 1 ? start : same[same.length - 1] || start;
        last.value = end.id;
        $('#cs-only').checked = sameType;
      }
      // The cable type first: the To port prefilled is one that it joins to the From port.
      const armed = ui.cabType !== 'auto' ? ui.cabType : '';
      $('#cs-type').innerHTML =
        `<option value="">Auto: by connectors and length</option>` +
        p.cableTypes.map((t) => `<option value="${esc(t.id)}"${t.id === armed ? ' selected' : ''}>${esc(t.name)}${t.legs > 1 ? ` (head on the right, ${t.legs} devices per port)` : ''}</option>`).join('');
      cs.fromPortTouched = !!o.fromPort;
      // Toward a device given (a switch's Connect series…), the port on each is one of the family of that device's ports: a node's ib0 for a leaf, not its bmc.
      const toDev = o.to && deviceById(o.to);
      fillFromPorts(o.fromPort, toDev ? firstFreePort(toDev) || portsOf(toDev).values().next().value : null);
      const like = portsOf(start).get($('#cs-from-port').value);
      const to = $('#cs-to');
      to.innerHTML = deviceOptions(allDevices(), null);
      const target = (o.to && deviceById(o.to)) || guessTarget(cs.series ? rangeIds() : [start.id], like);
      if (target) to.value = target.id;
      fillToPorts(o.toPort);
      $('#cs-step').value = '1';
      $('#cs-skip').checked = true;
      const net = defaultNetwork();
      $('#cs-nets').innerHTML =
        `<label class="chip"><input type="radio" name="cs-net" value=""${net ? '' : ' checked'}><span><i class="sw" style="--c:var(--unassigned)"></i>None</span></label>` +
        p.networks.map((n) => `<label class="chip"><input type="radio" name="cs-net" value="${esc(n.id)}"${n.id === net ? ' checked' : ''}><span><i class="sw" style="--c:${n.color}"></i>${esc(n.name)}</span></label>`).join('');
      $('#cs-label').value = '';
      ctx.openDialog(dlg);
      updateConnect();
      (cs.series ? from : $('#cs-to')).focus();
    }

    /** The ports of the From device; `preset` picks one, else the first free one (of the family of `like`, when given). */
    function fillFromPorts(preset, like) {
      const d = deviceById($('#cs-from').value);
      const sel = $('#cs-from-port');
      const cur = preset || (like ? null : sel.value);
      sel.innerHTML = d ? portOptions(d, null, !cs.series) : '';
      if (!d) return;
      const keep = cur && portsOf(d).has(cur) && (cs.series || !cableIndex().has(`${d.id}|${cur}`));
      const pt = keep ? portsOf(d).get(cur) : firstFreePort(d, like);
      if (pt) sel.value = pt.name;
      $('#cs-only-text').textContent = `only ${M.pluralName(M.typeOf(project(), d.type).label)}`;
    }
    /**
     * The ports of the To device; `preset` picks one. A port only kept
     * (`keep`: the one picked before the From end changed) stays when a cable
     * joins it to the From port, or when no free port is joined either.
     */
    function fillToPorts(preset, keep) {
      const d = deviceById($('#cs-to').value);
      const sel = $('#cs-to-port');
      sel.innerHTML = d ? portOptions(d, null, !cs.series) : '';
      if (!d) return;
      const fromDev = deviceById($('#cs-from').value);
      const like = fromDev ? portsOf(fromDev).get($('#cs-from-port').value) : null;
      const joining = joiningPort(d, fromDev, like);
      const given = preset && portsOf(d).has(preset) ? portsOf(d).get(preset) : null;
      const joinsGiven = given && fromDev && like && C.joins(project(), { device: fromDev.id, port: like.name }, { device: d.id, port: given.name }, $('#cs-type').value || null, fresh().ctx);
      const pt = given && (!keep || joinsGiven || !joining) ? given : joining || firstFreePort(d, like);
      if (pt) sel.value = pt.name;
    }
    /**
     * The first free port of `d` that a cable joins to port `like` of
     * `fromDev` (of the cable type picked, else any of the catalog), of the
     * family of `like` when one is, so that the preview does not start with
     * refusals: the QSFP-DD cage of a switch for a QSFP56 port, not the RJ45
     * port before it. Null when none is joined.
     */
    function joiningPort(d, fromDev, like) {
      if (!fromDev || !like || fromDev.id === d.id) return null;
      const p = project();
      const k = fresh();
      const idx = cableIndex();
      const type = $('#cs-type').value || null;
      const a = { device: fromDev.id, port: like.name };
      let other = null;
      for (const pt of portsOf(d).values()) {
        if (idx.has(`${d.id}|${pt.name}`) || !C.joins(p, a, { device: d.id, port: pt.name }, type, k.ctx)) continue;
        if (family(pt) === family(like)) return pt;
        other = other || pt;
      }
      return other;
    }

    /** The devices of the From range, top to bottom: from the first to the last picked, only of the first one's type when asked. */
    function rangeIds() {
      const ids = cs.list.map((d) => d.id);
      let i = ids.indexOf($('#cs-from').value);
      let j = ids.indexOf($('#cs-from-last').value);
      if (i < 0) return [];
      if (j < 0) j = i;
      if (j < i) [i, j] = [j, i];
      let list = cs.list.slice(i, j + 1);
      const first = deviceById($('#cs-from').value);
      if ($('#cs-only').checked && first) list = list.filter((d) => d.type === first.type);
      return list.map((d) => d.id);
    }

    function connectOptions() {
      const net = ($('input[name="cs-net"]:checked', dlg) || { value: '' }).value || null;
      return {
        from: cs.series ? rangeIds() : [$('#cs-from').value],
        fromPort: $('#cs-from-port').value,
        to: $('#cs-to').value,
        toPort: $('#cs-to-port').value,
        step: cs.series ? M.clampInt($('#cs-step').value, 1, 64, 1) : 1,
        skipUsed: cs.series ? $('#cs-skip').checked : false,
        type: $('#cs-type').value || null,
        network: net,
        firstLabel: $('#cs-label').value.trim() || null,
      };
    }

    function updateConnect() {
      if (!dlg.open) return;
      const p = project();
      const o = connectOptions();
      if (!cs.labelTouched) {
        $('#cs-label').value = M.nextCableLabel(p, o.network);
        o.firstLabel = $('#cs-label').value;
      }
      cs.items = o.fromPort && o.to ? C.planSeries(p, o) : [];
      const k = fresh();
      const sum = new Map();
      const rows = cs.items
        .map((it) => {
          const from = `${endText(it.a)}`;
          const to = Array.isArray(it.b) ? it.b.filter(Boolean).map(endText).join(', ') : endText(it.b);
          if (!it.ok) {
            return `<tr class="is-refused"><td class="mono">–</td><td class="mono" colspan="3">${esc(it.info)}</td><td colspan="3"><span class="sc-flag is-warn">${icon('x', 'ic-sm')}${esc(it.reason)}</span></td></tr>`;
          }
          const d = C.describe(p, { id: null, a: it.a, b: it.b, type: it.type, network: it.network, label: it.label, lengthM: null }, k.ctx);
          const sk = `${d.type ? d.type.name : 'no type'} ${d.lengthM === null ? '–' : C.fmtM(d.lengthM)}`;
          sum.set(sk, (sum.get(sk) || 0) + 1);
          // A label used elsewhere already is no problem of this preview: connecting counts it.
          const issue = d.issues.find((x) => x.code !== 'label');
          return (
            `<tr><td class="mono">${esc(it.label)}</td><td class="mono">${esc(from)}</td><td class="sc-arrow">→</td><td class="mono">${esc(to)}</td>` +
            `<td>${esc(d.type ? d.type.name : '–')}</td><td class="mono sc-num is-auto">${esc(d.lengthM === null ? '–' : C.fmtM(d.lengthM))}</td>` +
            `<td class="sc-issue">${issue ? `<span class="sc-flag is-${issue.level === 'warn' ? 'warn' : 'info'}" title="${esc(issue.text)}">${issueIcon(issue.level)}${esc(issue.short)}</span>` : icon('check', 'ic-sm is-ok')}</td></tr>`
          );
        })
        .join('');
      $('#cs-rows').innerHTML = rows || `<tr><td class="sc-none">${esc(emptyPreview(o))}</td></tr>`;
      const ok = cs.items.filter((it) => it.ok).length;
      const refused = cs.items.length - ok;
      // Read out as it changes; with every pair left out, why the first one is.
      const why = !ok && refused ? cs.items.find((it) => !it.ok) : null;
      $('#cs-summary').textContent = cs.items.length
        ? [plural(ok, 'cable')].concat([...sum].map(([key, n]) => `${key} × ${n}`), refused ? [`${refused} left out`] : []).join(' · ') + (why ? `: ${why.reason}` : '')
        : '';
      const submit = $('#cs-submit');
      submit.disabled = !ok;
      submit.textContent = ok > 1 ? `Connect ${ok} cables` : ok ? 'Connect 1 cable' : 'Connect';
      $('#connect-title').textContent = cs.series
        ? `${plural(o.from.length, 'device')} from ${seriesPlace(o.from)}`
        : ok
          ? `${cs.items[0].label}: ${cs.items[0].info}`
          : 'Connect two ports';
    }

    /** Where the devices of a series are: "Rack A01", "Rack A01 to A03" when they span racks (in the order of the range), else "this row". */
    function seriesPlace(ids) {
      const racks = [];
      for (const id of ids) {
        const d = deviceById(id);
        const name = d && where(d).pos.rack.name;
        if (name && !racks.includes(name)) racks.push(name);
      }
      if (!racks.length) return 'this row';
      return racks.length === 1 ? racks[0] : `${racks[0]} to ${shortRack(racks[racks.length - 1])}`;
    }

    /** What the preview says when it has no cable: why, when the devices picked can't be joined. */
    function emptyPreview(o) {
      const to = deviceById(o.to);
      if (to && o.fromPort && o.from.length && o.from.every((id) => id === o.to)) {
        return cs.series ? `${to.name} is the device to connect to: pick other devices to connect from.` : `A cable cannot join ${to.name} to itself: pick another device.`;
      }
      return 'Pick the devices and ports to connect.';
    }

    dlg.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'cs-from') {
        if (!cs.series || !deviceById($('#cs-from-last').value)) $('#cs-from-last').value = t.value;
        fillFromPorts();
      }
      if (t.id === 'cs-from' || t.id === 'cs-from-port' || t.id === 'cs-type') fillToPorts($('#cs-to-port').value, true);
      if (t.id === 'cs-to') fillToPorts();
      updateConnect();
    });
    dlg.addEventListener('input', (e) => {
      if (e.target.id === 'cs-label') cs.labelTouched = !!e.target.value.trim();
      if (e.target.id === 'cs-label' || e.target.id === 'cs-step') updateConnect();
    });
    $('#connect-form').addEventListener('submit', (e) => {
      e.preventDefault();
      updateConnect();
      const items = cs.items.filter((it) => it.ok);
      if (!items.length) return;
      let added = [];
      ctx.commit((p) => {
        added = C.connectSeries(p, items);
        return added.length ? undefined : false;
      });
      // Focus goes back to what opened the dialog, or when that is gone (a port's Connect…, now a cable), to the new cable's label.
      dlg.dataset.returnFocus = added.length === 1 ? '#cab-label' : '#multi-label';
      dlg.close('ok');
      if (!added.length) return toast('Nothing was connected', { warn: true });
      rememberNetwork(items[0].network);
      selectCables(added.map((c) => c.id), { reveal: true });
      const names = added.length === 1 ? added[0].label : `${plural(added.length, 'cable')}, ${added[0].label} … ${added[added.length - 1].label}`;
      toast(`Connected ${names}`, { action: 'Undo', onAction: ctx.undo });
    });

    // ------------------------------------------------------------ network dialog

    const netDlg = { id: null, color: null, onCreate: null, onCancel: null, focusFor: null, saved: false, labelTouched: false };

    /**
     * Opens the network dialog for network `id`, or to create one;
     * `onCreate(draft, id)` runs in the same commit, and `focusFor(id)` is a
     * selector of what takes keyboard focus once it is created (the chip of
     * the new network, rather than “+ New network” that opened it).
     */
    function openNetworkDialog(id, onCreate, onCancel, focusFor) {
      const p = project();
      const n = id && id !== NONE ? M.networkById(p, id) : null;
      if (!n && p.networks.length >= M.LIMITS.networks) {
        toast(`A plan holds up to ${M.LIMITS.networks} networks`, { warn: true });
        if (onCancel) onCancel();
        return;
      }
      const name = n ? n.name : nextNetworkName(p);
      Object.assign(netDlg, { id: n ? n.id : null, color: n ? n.color : M.nextNetworkColor(p), onCreate: onCreate || null, onCancel: onCancel || null, focusFor: focusFor || null, saved: false, labelTouched: !!n });
      $('#network-kicker').textContent = n ? 'Edit network' : 'New network';
      $('#network-title').textContent = n ? n.name : 'Create a network';
      $('#network-name').value = name;
      $('#network-label').value = n ? n.firstLabel : M.defaultFirstLabel(name);
      labelHint();
      $('#network-delete').hidden = !n;
      $('#network-submit').textContent = n ? 'Save' : 'Create';
      ctx.renderSwatches($('#network-colors'), 'network-color', netDlg.color, (col) => (netDlg.color = col));
      ctx.showError('#network-error', '');
      ctx.openDialog($('#dlg-network'));
      $('#network-name').focus();
      $('#network-name').select();
    }
    function nextNetworkName(p) {
      const used = new Set(p.networks.map((n) => n.name));
      let i = p.networks.length + 1;
      while (used.has(`Network ${i}`)) i++;
      return `Network ${i}`;
    }
    /** The hint under the first label: the series it starts. */
    function labelHint() {
      const first = $('#network-label').value.trim() || M.defaultFirstLabel($('#network-name').value.trim() || 'Network');
      const labels = M.labeler({ cables: [] });
      const series = [labels.next(first, true), labels.next(first, true)];
      // Each label on one line: "IB-" and "0002" apart would read as two labels.
      $('#network-label-hint').innerHTML = `New cables of this network continue this series: ${series.map((l) => `<span class="label-eg">${esc(l)}</span>`).join(', ')}, …`;
    }
    $('#network-name').addEventListener('input', () => {
      ctx.showError('#network-error', '');
      if (!netDlg.labelTouched) $('#network-label').value = M.defaultFirstLabel($('#network-name').value.trim() || 'Network');
      labelHint();
    });
    $('#network-label').addEventListener('input', () => {
      netDlg.labelTouched = true;
      labelHint();
    });
    $('#network-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#network-name').value.trim();
      if (!name) return ctx.showError('#network-error', 'Give the network a name.');
      const props = { name, color: netDlg.color, firstLabel: $('#network-label').value.trim() || M.defaultFirstLabel(name) };
      if (netDlg.id) {
        const id = netDlg.id;
        const err = change((p) => C.updateNetwork(p, id, props));
        if (err) return ctx.showError('#network-error', err);
      } else {
        const onCreate = netDlg.onCreate;
        let err = null;
        const made = ctx.commitAdd((p) => {
          const n = C.addNetwork(p, props);
          if (n && onCreate) err = onCreate(p, n.id) || null;
          return err ? null : n;
        });
        if (err) return ctx.showError('#network-error', err);
        if (!made) return ctx.showError('#network-error', `A plan holds up to ${M.LIMITS.networks} networks.`);
        rememberNetwork(made.id);
        if (netDlg.focusFor) {
          $('#dlg-network').dataset.opener = '';
          $('#dlg-network').dataset.returnFocus = netDlg.focusFor(made.id);
        }
      }
      netDlg.saved = true;
      $('#dlg-network').close('ok');
    });
    $('#dlg-network').addEventListener('close', () => {
      if (!netDlg.saved && netDlg.onCancel) netDlg.onCancel();
    });
    $('#network-delete').addEventListener('click', async () => {
      const id = netDlg.id;
      const n = M.networkById(project(), id);
      if (!n) return;
      const count = project().cables.filter((c) => c.network === id).length;
      $('#dlg-network').close('cancel');
      const ok =
        !count ||
        (await ctx.confirmDialog({
          title: `Delete ${n.name}?`,
          body: `Its ${plural(count, 'cable')} stay plugged in, without a network. Undo brings the network back.`,
          ok: 'Delete network',
        }));
      if (!ok) return;
      ctx.commit((p) => void C.deleteNetwork(p, id));
      toast(`Deleted network ${n.name}`, { action: 'Undo', onAction: ctx.undo });
    });

    // ------------------------------------------------------------ keyboard, search, open

    /**
     * Keys of the Cabling workspace, before the app's own: Delete deletes
     * the selected cables (or unplugs the port selected), Ctrl+A selects the
     * cables shown, Enter edits a cable's label; arrows, Ctrl+D and M do
     * nothing here. The schedule's checkboxes take these keys and Esc too,
     * as the table around them would. Returns true when the key is taken.
     */
    function onKeyDown(e, k) {
      const t = e.target;
      const rowBox = t && t.closest && t.closest('.sched tbody input[type="checkbox"], #sc-all');
      if (k.formControl && !rowBox) return false;
      const key = k.key;
      // Esc stops a press on a drawing first, so that its release does nothing: a drag from a port connects nothing, a pan stops where it is.
      if (key === 'Escape' && cancelPress()) {
        e.preventDefault();
        return true;
      }
      // On a focused button or link, Enter keeps activating it.
      const activates = key === 'Enter' && !!(t && t.closest && t.closest(ACTIVATES));
      // Enter or Esc with legs of a breakout cable set connects it with those.
      if ((key === 'Enter' || key === 'Escape') && !k.mod && !activates && finishLegs()) {
        e.preventDefault();
        return true;
      }
      if ((key === 'Delete' || key === 'Backspace') && !k.mod) {
        const ids = selCableIds();
        const s = ui.cabSel;
        if (s && s.kind === 'port' && unplugPort(s.device, s.port)) {
          e.preventDefault();
          return true;
        }
        if (!ids.length) return false;
        e.preventDefault();
        deleteCables(ids);
        return true;
      }
      if (key === 'Escape' && rowBox) {
        // Focus leaves the checkbox, then Esc goes down its chain: the connection being made, the selection, the network in focus.
        e.preventDefault();
        t.blur();
        if (!cancelPending() && !clearSelection()) clearFocus();
        return true;
      }
      if (k.mod && k.letter === 'a' && !e.altKey) {
        e.preventDefault();
        if (ui.cabView === 'schedule') selectCables(sched.visible);
        else if (ui.cabView === 'elevation' && elev.layout) selectCables([...elev.layout.cables.keys()]);
        else if (ui.cabView === 'ports') selectCables(portMapCables());
        return true;
      }
      if ((key === 'Enter' || key === 'F2') && !k.mod && !rowBox && selCableIds().length === 1) {
        if (activates) return false;
        e.preventDefault();
        const input = $('#cab-label');
        if (input) {
          input.focus();
          input.select();
        }
        return true;
      }
      if (key.startsWith('Arrow') && !k.mod) return !rowBox;
      if (k.mod && k.letter === 'd') {
        e.preventDefault();
        return true;
      }
      return !k.mod && !e.altKey && k.letter === 'm';
    }

    /** Cables that the search matches, as the drawings highlight them (C.cableMatcher: label, ends, notes, network, cable type): { items, count }. */
    function searchCables(query, limit) {
      const out = { items: [], count: 0 };
      const ids = searchHits(query);
      if (!ids) return out;
      for (const c of project().cables) {
        if (!ids.has(c.id)) continue;
        out.count++;
        if (out.items.length < limit) {
          const ends = M.cableEnds(c).map((x) => endText(x.end));
          out.items.push({ kind: 'cable', id: c.id, name: c.label || '–', detail: `${ends[0]} → ${ends.slice(1).join(', ')}` });
        }
      }
      return out;
    }

    /** A search result chosen in Cabling: cables and devices are selected here, places shown. */
    function chooseResult(it) {
      const p = project();
      if (it.kind === 'cable') {
        const c = cableById(it.id);
        if (!c) return;
        // The elevation shows it where it is seen; the other views in the schedule.
        if (ui.cabView === 'elevation') {
          ui.cabSel = { kind: 'cables', ids: [c.id] };
          return showInElevation({ cable: c.id });
        }
        followDevice(c.a.device);
        if (ui.cabView !== 'schedule') setView('schedule');
        sched.hidden.clear();
        sched.filter = '';
        showCable(c);
        ui.cabSel = { kind: 'cables', ids: [c.id] };
        ctx.render();
        revealCable(c.id);
      } else if (it.kind === 'device') {
        const d = deviceById(it.id);
        if (!d) return;
        ui.cabSel = { kind: 'devices', ids: [d.id] };
        if (ui.cabView === 'elevation') return showInElevation({ device: d.id });
        followDevice(d.id);
        if (ui.cabView === 'ports') pm.rack = d.loc.rack;
        ctx.render();
      } else if (it.kind === 'rack') {
        const pos = M.locateRack(p, it.id);
        if (!pos) return;
        pm.rack = it.id;
        ctx.setRow(pos.row.id);
      } else if (it.kind === 'row') ctx.setRow(it.id);
      else if (it.kind === 'floor') {
        const floor = M.floorById(p, it.id);
        if (floor) ctx.setRow(floor.rows[0].id);
      }
    }

    /** Adds the cables of a cable schedule CSV to the plan. Returns an error message for the Open dialog, or null. */
    function importCablesText(text) {
      let result = null;
      try {
        ctx.commit((p) => {
          result = IO.importCablesCSV(p, text);
          return result.added ? undefined : false;
        });
      } catch (err) {
        return err.message;
      }
      $('#dlg-open').close('ok');
      const sub = `${plural(result.warnings.length, 'line')} or detail${result.warnings.length === 1 ? '' : 's'} needed attention:`;
      if (!result.added) {
        toast('The CSV added no cables', { warn: true });
        ctx.reportWarnings('No cables added', sub, result.warnings);
        return null;
      }
      if (ui.workspace !== 'cabling') ctx.setWorkspace('cabling');
      toast(`Added ${plural(result.added, 'cable')} from the CSV`, { action: 'Undo', onAction: ctx.undo });
      ctx.reportWarnings(`Added ${plural(result.added, 'cable')}`, sub, result.warnings);
      return null;
    }

    /**
     * The drawing of the view shown, as a standalone SVG (light theme) for
     * the Export menu: { svg, file } (file without extension), or null in
     * a view that has none.
     */
    function exportDrawing() {
      const p = project();
      if (ui.cabView === 'elevation') {
        const side = prefs.cabSide;
        return { svg: CR.exportSVG('elevation', p, { rowId: ctx.currentRow().row.id, side, measure: ctx.measure }), file: `${ctx.fileBase(true)}-cabling-${side}`.slice(0, 120) };
      }
      if (ui.cabView === 'fabric') {
        const net = fabricNetwork();
        const name = net === NONE || !net ? 'no-network' : M.slug(netName(net)) || 'network';
        return { svg: CR.exportSVG('fabric', p, { networkId: net === NONE ? null : net, grouped: prefs.cabGrouped, measure: ctx.measure }), file: `${ctx.fileBase()}-${name}-fabric`.slice(0, 120) };
      }
      return null;
    }

    /** What exportDrawing gives, for the Export menu: "This row’s cabling from the rear", "The InfiniBand fabric of the whole plan", or null where it gives none (the Racks sheet is exported). */
    function drawingName() {
      if (ui.cabView === 'elevation') return `This row’s cabling from the ${prefs.cabSide}`;
      if (ui.cabView === 'fabric') {
        const net = fabricNetwork();
        if (!net) return 'The fabric of the whole plan';
        return net === NONE ? 'The fabric of the cables without a network' : `The ${netName(net)} fabric of the whole plan`;
      }
      return null;
    }

    /** After undo or redo: an open Connect dialog plans again on the plan as it is now. */
    function onRestore() {
      if (dlg.open) updateConnect();
    }

    return {
      VIEWS,
      zoomable,
      setView,
      renderStage,
      renderBin,
      hideBin,
      renderNav,
      renderChrome,
      inspectorKey,
      renderInspector,
      prune,
      reset,
      onRestore,
      cancelPending,
      hasSelection,
      clearSelection,
      clearFocus,
      onKeyDown,
      searchCables,
      chooseResult,
      importCablesText,
      openConnect,
      openNetworkDialog,
      exportDrawing,
      drawingName,
      showInElevation,
      afterFit,
      useCounts,
    };
  }

  (window.RP = window.RP || {}).cablingUI = { create };
})();
