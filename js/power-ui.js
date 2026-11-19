/*
 * Rackplanner: the Power workspace.
 *
 * Everything the Power workspace shows and does, next to the Racks
 * workspace in js/app.js and the Cabling workspace in js/cabling-ui.js:
 * its state (the device, PDU, fuse group or cords selected, the cord type
 * armed for new cords, a connection being made, the grids hidden), the
 * left panel (cord types and power grids), the views of the stage
 * (Elevation, Outlet map, Schedule, Load), the inspectors, the power grid
 * and Connect series dialogs, and its keyboard, search and export
 * handling.
 *
 * app.js creates it once with create(ctx), handing over what it needs from
 * the app, and calls the hooks it returns at its dispatch points while
 * ui.workspace is 'power', as it does for the Cabling workspace.
 */
(function () {
  'use strict';

  const M = window.RP.model;
  const P = window.RP.power;
  const IO = window.RP.io;
  const PR = window.RP.powerRender;

  const NONE = ''; // the PDUs without a grid, as a grid to hide or count
  const UP = P.UP;
  /** "Click" in a hint, which a touch screen reads as "Tap" (css/app.css shows one of the two). */
  const CLICK = '<span class="hint-touch">Tap</span><span class="hint-pointer">Click</span>';
  const VIEW_IDS = ['elevation', 'outlets', 'schedule', 'load'];
  const SCOPES = ['row', 'floor', 'plan'];
  const GROUPS = [
    ['pdu', 'By PDU'],
    ['device', 'By device'],
    ['grid', 'By grid'],
    ['type', 'By cord type'],
    ['none', 'No groups'],
  ];
  /** The schedule draws this many cords at most; a filter or a smaller scope shows the others. */
  const MAX_ROWS = 1500;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** Builds the workspace. `ctx` (from app.js) is what the Cabling workspace gets (see js/cabling-ui.js). */
  function create(ctx) {
    const { ui, prefs, el, esc, icon, plural, toast } = ctx;
    const project = () => ctx.project();
    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
    const host = $('#pow-host');
    const sidesEl = $('#pow-sides');
    const conn = (id) => M.powerConnectorLabel(id);
    const pct = (v) => `${Math.round(v * 100)} %`;
    /** "dev|name" (data-inlet, data-outlet) to its two parts: a name never holds "|", a device id from a plan file may. */
    const splitKey = (key) => {
      const i = key.lastIndexOf('|');
      return [key.slice(0, i), key.slice(i + 1)];
    };

    // ------------------------------------------------------------ state

    Object.assign(ui, {
      powSel: null, // { kind: 'device' | 'pdu', id } | { kind: 'fuse', pdu, fuse } | { kind: 'cords', ids }
      powType: 'auto', // cord type armed for new cords: 'auto' or a cord type id
      powPending: null, // the first end of a connection being made: { device, inlet } or { device, outlet }
      hiddenGrids: new Set(), // grids whose cords the elevation does not draw: ids, NONE for the PDUs without one
      powScenario: UP, // the scenario the outlet map shows: all grids up, or the id of the grid that is down
    });
    if (!VIEW_IDS.includes(prefs.powView)) prefs.powView = 'elevation';
    if (prefs.powSide !== 'front') prefs.powSide = 'rear';
    if (!SCOPES.includes(prefs.powScope)) prefs.powScope = 'row';
    if (!GROUPS.some(([k]) => k === prefs.powGroup)) prefs.powGroup = 'pdu';
    ui.powView = prefs.powView;
    /** The rack the outlet map shows. */
    const om = { rack: null };
    /** The schedule's state for this session: its filter, the groups folded, the cords shown in order, and the row clicked last (for Shift-click). */
    const sched = { filter: '', collapsed: new Set(), visible: [], anchor: null };
    /** The PDUs folded in the Load view. */
    const ld = { collapsed: new Set() };

    // ------------------------------------------------------------ cached lookups

    /** Lookups for the plan as it is: a commit makes a new plan object, which starts a new cache. */
    const cache = { project: null };
    function fresh() {
      const p = project();
      if (cache.project !== p) Object.assign(cache, { project: p, ctx: P.context(p), load: null, desc: new Map(), byId: null, counts: null });
      return cache;
    }
    const pctx = () => fresh().ctx;
    function loads() {
      const c = fresh();
      return c.load || (c.load = P.loads(c.project, c.ctx));
    }
    function describe(cord) {
      const c = fresh();
      let d = c.desc.get(cord.id);
      if (!d) c.desc.set(cord.id, (d = P.describe(c.project, cord, c.ctx)));
      return d;
    }
    function cordById(id) {
      const c = fresh();
      if (!c.byId) c.byId = new Map((c.project.powerCords || []).map((x) => [x.id, x]));
      return c.byId.get(id) || null;
    }
    const deviceById = (id) => pctx().devices.get(id) || null;
    const isPdu = (d) => M.isPdu(project(), d);
    const gridKey = (pdu) => (pdu && pctx().grids.has(pdu.grid) ? pdu.grid : NONE);
    const gridName = (key) => (pctx().grids.get(key) || { name: 'No grid' }).name;
    const gridColor = (key) => (pctx().grids.get(key) || { color: P.NO_GRID_COLOR }).color;
    const slotOf = (pdu) => `P${pdu.loc.at + 1}`;
    const pduSpec = (pdu) => pctx().info(pdu.type).type.pdu;
    const fuseOf = (pdu, name) => (pduSpec(pdu).fuses || []).find((f) => f.name === name) || null;
    const rackOf = (d) => pctx().racks.get(d.loc.rack) || null;
    /** "6–10" for outlets in a row of numbers, else their names. */
    function outletRange(names) {
      if (!names.length) return 'none';
      const nums = names.map(Number);
      const run = nums.every((n, i) => Number.isInteger(n) && (i === 0 || n === nums[i - 1] + 1));
      if (run && names.length > 1) return `${names[0]}–${names[names.length - 1]}`;
      return names.length > 6 ? `${names.slice(0, 5).join(', ')}, …` : names.join(', ');
    }

    // An end of a cord: { device, inlet } on a device or { device, outlet } on a PDU.
    const isInlet = (e) => e.inlet !== undefined;
    const endKey = (e) => `${e.device}|${isInlet(e) ? e.inlet : e.outlet}`;
    const sameEnd = (a, b) => !!a && !!b && isInlet(a) === isInlet(b) && endKey(a) === endKey(b);
    const cordAt = (e) => (isInlet(e) ? pctx().byInlet : pctx().byOutlet).get(endKey(e)) || null;
    function endExists(e) {
      const d = deviceById(e.device);
      if (!d) return false;
      const t = pctx().info(d.type);
      return isInlet(e) ? t.inletBy.has(e.inlet) : t.outletBy.has(e.outlet);
    }
    const endText = (e) => {
      const d = deviceById(e.device);
      return `${d ? d.name : '?'} ${isInlet(e) ? e.inlet : `outlet ${e.outlet}`}`;
    };

    // ------------------------------------------------------------ selection

    const selCordIds = () => (ui.powSel && ui.powSel.kind === 'cords' ? ui.powSel.ids : []);
    const hasSelection = () => !!ui.powSel;
    function clearSelection() {
      if (!ui.powSel) return false;
      ui.powSel = null;
      ctx.render();
      return true;
    }
    function select(sel) {
      ui.powSel = sel;
      ctx.render();
    }
    const selectCords = (ids) => select(ids.length ? { kind: 'cords', ids } : null);
    function toggleCord(id) {
      const ids = selCordIds();
      selectCords(ids.includes(id) ? ids.filter((x) => x !== id) : ids.concat([id]));
    }
    /** The selection that shows device `id`: a PDU as a PDU. */
    const selOf = (id) => (isPdu(deviceById(id)) ? { kind: 'pdu', id } : { kind: 'device', id });
    function selectDevice(id) {
      if (deviceById(id)) select(selOf(id));
    }
    /** Shows the row of a device, keeping the workspace. */
    function followDevice(id) {
      const d = deviceById(id);
      const pos = d && rackOf(d);
      if (pos && pos.row.id !== ui.rowId) ctx.setRow(pos.row.id, { render: false });
    }

    /** Drops what no longer exists after a change or an undo. */
    function prune() {
      const p = project();
      const s = ui.powSel;
      if (s && s.kind === 'cords') {
        const ids = s.ids.filter(cordById);
        ui.powSel = ids.length ? (ids.length === s.ids.length ? s : { kind: 'cords', ids }) : null;
      } else if (s && s.kind === 'device') {
        const d = deviceById(s.id);
        if (!d || isPdu(d)) ui.powSel = null;
      } else if (s && s.kind === 'pdu') {
        if (!isPdu(deviceById(s.id))) ui.powSel = null;
      } else if (s && s.kind === 'fuse') {
        const d = deviceById(s.pdu);
        if (!isPdu(d) || !fuseOf(d, s.fuse)) ui.powSel = null;
      } else if (s) ui.powSel = null;
      const validGrid = (k) => (k === NONE ? P.pdus(p).some((d) => gridKey(d) === NONE) : pctx().grids.has(k));
      for (const k of ui.hiddenGrids) if (!validGrid(k)) ui.hiddenGrids.delete(k);
      if (ui.powType !== 'auto' && !pctx().cordTypes.has(ui.powType)) ui.powType = 'auto';
      if (ui.powScenario !== UP && !pctx().grids.has(ui.powScenario)) ui.powScenario = UP;
      // A connection being made keeps an end that is still there and free.
      const pd = ui.powPending;
      if (pd && (!endExists(pd) || cordAt(pd))) ui.powPending = null;
      if (om.rack && !pctx().racks.has(om.rack)) om.rack = null;
      if (sched.anchor && !cordById(sched.anchor)) sched.anchor = null;
    }

    /** Forgets the state of the plan that was open: for another plan, or a plan replaced whole. */
    function reset() {
      Object.assign(ui, { powSel: null, powType: 'auto', powPending: null, powScenario: UP });
      ui.hiddenGrids.clear();
      elevAt.clear();
      om.rack = null;
      sched.filter = '';
      sched.collapsed.clear();
      sched.anchor = null;
      ld.collapsed.clear();
      const f = $('#ps-filter');
      if (f) f.value = '';
    }

    /** Cancels a connection being made; true when there was one. */
    function cancelPending() {
      if (!ui.powPending) return false;
      ui.powPending = null;
      ctx.render();
      return true;
    }
    /** Stops a connection being made, with a toast that says so (unlike Esc, which the user pressed). */
    function stopPending() {
      const pd = ui.powPending;
      if (!pd) return;
      ui.powPending = null;
      toast(`Connection from ${endText(pd)} cancelled`);
    }

    // ------------------------------------------------------------ views

    const zoomable = () => ui.powView === 'elevation';
    /** The views where an inlet or an outlet is clicked to connect it. */
    const END_VIEWS = new Set(['elevation', 'outlets']);
    /**
     * Shows another view. The elevation comes back at the zoom and scroll
     * it had for the row, the outlet map at the rack of what is selected.
     */
    function setView(id) {
      if (!VIEW_IDS.includes(id) || id === ui.powView) return;
      keepElevation();
      ui.powView = id;
      prefs.powView = id;
      ctx.savePrefs();
      if (!END_VIEWS.has(id)) stopPending();
      if (id === 'outlets') om.rack = startRack();
      ctx.render();
      if (id === 'elevation') restoreElevation();
    }

    /** The zoom and scroll of the elevation of each row as it was left for another view or workspace: { zoom, left, top } by row id. */
    const elevAt = new Map();
    const elev = { rowId: null };
    function keepElevation() {
      if (ui.workspace === 'power' && ui.powView === 'elevation' && elev.rowId) elevAt.set(elev.rowId, { zoom: ui.zoom, left: el.canvas.scrollLeft, top: el.canvas.scrollTop });
    }
    function restoreElevation() {
      const at = elevAt.get(ui.rowId);
      if (!at) return ctx.fitWidth();
      ui.zoom = at.zoom;
      ctx.applyZoom();
      el.canvas.scrollLeft = at.left;
      el.canvas.scrollTop = at.top;
    }
    /** The elevation of another row, as it was left for it: false when it has not been shown at all, or another view is. */
    function elevationAgain() {
      if (ui.powView !== 'elevation' || !elevAt.has(ui.rowId)) return false;
      restoreElevation();
      return true;
    }
    /** The drawing as the workspace opens: the elevation as it was left, else fitted. */
    function fitStage() {
      if (ui.powView === 'elevation') restoreElevation();
    }
    $('#pow-toggle').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pow-view]');
      if (b) setView(b.dataset.powView);
    });

    /** The racks whose cords and PDUs a scope holds: a Set of rack ids, or null for the whole plan. */
    function scopeRacks(scope) {
      if (scope === 'plan') return null;
      const pos = ctx.currentRow();
      const rows = scope === 'floor' ? pos.floor.rows : [pos.row];
      return new Set(rows.flatMap((r) => r.racks.map((k) => k.id)));
    }
    const scopeName = (scope) => (scope === 'plan' ? 'the plan' : scope === 'floor' ? ctx.currentRow().floor.name : ctx.currentRow().row.name);
    function scopeSeg() {
      const row = ctx.currentRow().row.name;
      return (
        `<div class="seg sc-scope" role="group" aria-label="Show the cords of">` +
        SCOPES.map(
          (s) =>
            `<button type="button" data-pow-scope="${s}" aria-pressed="${prefs.powScope === s}">${s === 'row' ? `<span class="sc-scope-name">${esc(row)}</span>` : s === 'floor' ? 'Floor' : 'Plan'}</button>`
        ).join('') +
        `</div>`
      );
    }
    function setScope(s) {
      if (!SCOPES.includes(s) || s === prefs.powScope) return;
      prefs.powScope = s;
      ctx.savePrefs();
      ctx.render();
    }

    // ------------------------------------------------------------ elevation

    /** What the search matches, as the elevation keeps it at full strength: a Set of device ids, or null. */
    function searchHits() {
      const match = M.deviceMatcher(project(), ui.query || '', ctx.view());
      return match ? new Set(project().devices.filter(match).map((d) => d.id)) : null;
    }
    /** The selection as the elevation draws it. */
    function drawnSelection() {
      const s = ui.powSel;
      if (!s) return null;
      if (s.kind === 'cords') return { cords: s.ids, devices: [] };
      if (s.kind === 'fuse') {
        const pdu = deviceById(s.pdu);
        const f = fuseOf(pdu, s.fuse);
        return { devices: [], cords: f.outlets.map((o) => pctx().byOutlet.get(`${pdu.id}|${o}`)).filter(Boolean).map((c) => c.id) };
      }
      return { devices: [s.id], cords: [] };
    }

    function renderElevation() {
      const pos = ctx.currentRow();
      const out = PR.elevation(project(), {
        rowId: pos.row.id,
        side: prefs.powSide,
        theme: ui.theme,
        measure: ctx.measure,
        view: ctx.view(),
        hiddenGrids: [...ui.hiddenGrids],
        selected: drawnSelection(),
        pending: ui.powPending,
        match: searchHits(),
      });
      elev.rowId = out.rowId;
      ui.sceneW = out.width;
      ui.sceneH = out.height;
      el.svg.setAttribute('viewBox', `0 0 ${out.width} ${out.height}`);
      el.svg.setAttribute('aria-label', `Power cabling of ${pos.floor.name}, ${pos.row.name}, seen from the ${out.side}`);
      el.svg.innerHTML = out.body;
      ctx.applyZoom();
    }

    function setSide(side) {
      if (side === prefs.powSide || (side !== 'front' && side !== 'rear')) return;
      prefs.powSide = side;
      ctx.savePrefs();
      ctx.render();
      // The racks are mirrored: what is selected stays in sight.
      revealSelection();
    }
    function renderSides() {
      for (const b of $$('[data-pow-side]', sidesEl)) b.setAttribute('aria-pressed', String(b.dataset.powSide === prefs.powSide));
    }
    sidesEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pow-side]');
      if (b) setSide(b.dataset.powSide);
    });

    /** Scrolls the stage so that an element of the drawing is in view, in the middle when it was not. */
    function revealEl(g) {
      if (!g) return;
      const b = g.getBoundingClientRect();
      const c = el.canvas;
      const r = c.getBoundingClientRect();
      const m = 40;
      if (b.left < r.left + m || b.right > r.right - m) c.scrollLeft += (b.left + b.right) / 2 - (r.left + r.right) / 2;
      if (b.top < r.top + m || b.bottom > r.bottom - m) c.scrollTop += (b.top + b.bottom) / 2 - (r.top + r.bottom) / 2;
    }
    function revealSelection() {
      if (ui.powView !== 'elevation') return;
      const s = ui.powSel;
      if (!s) return;
      let id = s.kind === 'fuse' ? s.pdu : s.id;
      if (s.kind === 'cords') {
        const c = cordById(s.ids[0]);
        id = c ? c.inlet.device : null;
      }
      if (id) revealEl(el.svg.querySelector(`[data-dev="${CSS.escape(id)}"], [data-pdu="${CSS.escape(id)}"]`));
    }
    /** Shows a device, a PDU or a cord in the elevation: the row it is in, the rear for a cord, scrolled to it. */
    function showInElevation(sel) {
      const id = sel.kind === 'cords' ? (cordById(sel.ids[0]) || { inlet: {} }).inlet.device : sel.kind === 'fuse' ? sel.pdu : sel.id;
      ui.powSel = sel;
      const d = deviceById(id);
      const pos = d && rackOf(d);
      const rowChanged = !!pos && pos.row.id !== ui.rowId;
      if (ui.powView !== 'elevation') {
        keepElevation();
        ui.powView = 'elevation';
        prefs.powView = 'elevation';
      }
      if (sel.kind === 'cords') prefs.powSide = 'rear';
      ctx.savePrefs();
      if (rowChanged) ctx.setRow(pos.row.id, { render: false });
      ctx.render();
      if (rowChanged || !elevAt.has(ui.rowId)) ctx.fitWidth();
      revealSelection();
    }

    // ------------------------------------------------------------ connecting

    /**
     * Connects an inlet to an outlet with the cord type armed (Auto: the
     * cord picks its type). The new cord is selected; a grid the elevation
     * hides is shown again when the cord is on it. True unless refused (a
     * cord to another rack, an end that is taken).
     */
    function connectEnds(inlet, outlet) {
      let error = null;
      const type = ui.powType === 'auto' ? null : ui.powType;
      const before = ui.powPending;
      ui.powPending = null;
      const made = ctx.commitAdd((p) => {
        const r = P.connect(p, { inlet: { device: inlet.device, inlet: inlet.inlet }, outlet: { device: outlet.device, outlet: outlet.outlet }, type });
        error = r.error || null;
        return r.cord || null;
      });
      if (!made) {
        ui.powPending = before;
        toast(error || 'That cord cannot be connected', { warn: true });
        ctx.render({ inspector: false });
        return false;
      }
      const pdu = deviceById(outlet.device);
      const shown = ui.hiddenGrids.delete(gridKey(pdu));
      ui.powSel = { kind: 'cords', ids: [made.id] };
      ctx.render();
      // A cord whose plugs do not fit is a check, not a refusal: the toast says so.
      const cord = cordById(made.id);
      const issue = cord ? describe(cord).issues.find((x) => x.kind === 'fit') : null;
      toast(`Connected ${endText(inlet)} to ${endText(outlet)} as ${made.label}${issue ? `: ${issue.title.toLowerCase()}` : ''}${shown ? `; ${gridName(gridKey(pdu))} is shown again` : ''}`, {
        action: 'Undo',
        onAction: ctx.undo,
        warn: !!issue,
      });
      return true;
    }

    /**
     * A click on an inlet or an outlet. While a connection is being made
     * it is the other end; the pending end again stops. Otherwise an end
     * with a cord selects its cord (Shift adds it) and a free one starts a
     * connection.
     */
    function clickEnd(end, add) {
      if (!endExists(end)) return;
      const pd = ui.powPending;
      const cord = cordAt(end);
      if (pd) {
        if (sameEnd(pd, end)) return cancelPending();
        if (isInlet(pd) !== isInlet(end)) {
          if (cord) return toast(`${endText(end)} already has ${cord.label || 'a cord'}`, { warn: true });
          return isInlet(pd) ? connectEnds(pd, end) : connectEnds(end, pd);
        }
        // Another end of the same kind: the connection starts from it instead.
        if (!cord) {
          ui.powPending = end;
          ui.powSel = selOf(end.device);
          return ctx.render();
        }
      }
      if (cord) return add ? toggleCord(cord.id) : selectCords([cord.id]);
      ui.powPending = end;
      ui.powSel = selOf(end.device);
      ctx.render();
    }

    /** A drag from a free end to another: one gesture, which leaves a connection pending before it as it was when refused. */
    function dragConnect(from, to) {
      if (!endExists(to) || isInlet(from) === isInlet(to)) return;
      if (cordAt(to)) return toast(`${endText(to)} already has ${cordAt(to).label || 'a cord'}`, { warn: true });
      const inlet = isInlet(from) ? from : to;
      connectEnds(inlet, inlet === from ? to : from);
    }

    function deleteCords(ids) {
      const list = ids.map(cordById).filter(Boolean);
      if (!list.length) return;
      const what = list.length === 1 ? list[0].label || 'a cord' : plural(list.length, 'cord');
      ctx.commit((p) => void P.disconnect(p, ids));
      toast(`Unplugged ${what}`, { action: 'Undo', onAction: ctx.undo });
    }
    async function unplugDevice(d) {
      const cords = pctx().byDevice.get(d.id) || [];
      if (!cords.length) return;
      if (cords.length > 1) {
        const ok = await ctx.confirmDialog({ title: `Unplug ${plural(cords.length, 'cord')}?`, body: `Every power cord of ${d.name} goes. Undo brings them back.`, ok: 'Unplug all' });
        if (!ok) return;
      }
      ctx.commit((p) => void P.unplug(p, [d.id]));
      toast(`Unplugged ${plural(cords.length, 'cord')} of ${d.name}`, { action: 'Undo', onAction: ctx.undo });
    }

    // ------------------------------------------------------------ pointer

    const press = { cur: null };
    // The line of a drag from an inlet or an outlet, over the page.
    const band = document.createElementNS(SVG_NS, 'svg');
    band.setAttribute('class', 'pow-band');
    band.setAttribute('aria-hidden', 'true');
    band.innerHTML = '<line/><circle r="4"/>';
    band.style.display = 'none';
    document.body.appendChild(band);

    const endOfEl = (node) => {
      const inlet = node.dataset.inlet !== undefined;
      const [device, name] = splitKey(inlet ? node.dataset.inlet : node.dataset.outlet);
      return inlet ? { device, inlet: name } : { device, outlet: name };
    };
    function pressTarget(t) {
      const cord = t.closest('[data-cord]');
      if (cord) return { kind: 'cord', id: cord.dataset.cord };
      const pdu = t.closest('[data-pdu]');
      if (pdu) return { kind: 'device', id: pdu.dataset.pdu };
      const dev = t.closest('[data-dev]');
      if (dev && !dev.classList.contains('is-reserved')) return { kind: 'device', id: dev.dataset.dev };
      return { kind: 'bg' };
    }
    function clickTarget(t, add) {
      if (t.kind === 'cord') return add ? toggleCord(t.id) : selectCords([t.id]);
      if (t.kind === 'device') return selectDevice(t.id);
      clearSelection();
    }
    el.svg.addEventListener('pointerdown', (e) => {
      if (ui.workspace !== 'power' || e.button !== 0 || !zoomable()) return;
      const t = e.target;
      // A mouse press below keeps the browser from moving focus, so focus leaves the control it was on here.
      const a = document.activeElement;
      if (a && a !== document.body && !a.contains(t) && a.blur) a.blur();
      const base = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, add: e.shiftKey || e.ctrlKey || e.metaKey };
      const endEl = t.closest('[data-inlet], [data-outlet]');
      if (endEl) {
        if (e.pointerType === 'mouse') e.preventDefault();
        const end = endOfEl(endEl);
        press.cur = Object.assign(base, { kind: 'end', end, el: endEl, free: !cordAt(end), drag: false });
        return;
      }
      const target = pressTarget(t);
      if (e.pointerType === 'mouse') {
        e.preventDefault();
        press.cur = Object.assign(base, { kind: 'pan', target, sl: el.canvas.scrollLeft, st: el.canvas.scrollTop, moved: false });
      } else press.cur = Object.assign(base, { kind: 'tap', target });
    });
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
      } else if (pr.kind === 'end' && pr.free && pr.type !== 'touch') {
        if (!pr.drag && Math.hypot(dx, dy) < 5) return;
        pr.drag = true;
        if (!pr.el.isConnected) pr.el = el.svg.querySelector(`[${isInlet(pr.end) ? 'data-inlet' : 'data-outlet'}="${CSS.escape(endKey(pr.end))}"]`) || pr.el;
        if (!pr.el.isConnected) return;
        const r = pr.el.getBoundingClientRect();
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
    });
    window.addEventListener('pointerup', (e) => {
      const pr = press.cur;
      if (!pr || e.pointerId !== pr.pointerId) return;
      press.cur = null;
      const far = Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > 10;
      if (pr.kind === 'pan') {
        el.canvas.classList.remove('is-panning');
        if (!pr.moved) clickTarget(pr.target, pr.add);
      } else if (pr.kind === 'end') {
        if (pr.drag) {
          band.style.display = 'none';
          const at = document.elementFromPoint(e.clientX, e.clientY);
          const to = at && at.closest && at.closest('[data-inlet], [data-outlet]');
          if (to) dragConnect(pr.end, endOfEl(to));
        } else if (!far) clickEnd(pr.end, pr.add);
      } else if (!far) clickTarget(pr.target, pr.add);
    });
    window.addEventListener('pointercancel', (e) => {
      const pr = press.cur;
      if (pr && e.pointerId === pr.pointerId) cancelPress();
    });
    /** Forgets the press on the drawing, so that its release does nothing; true when it was a drag under way. */
    function cancelPress() {
      const pr = press.cur;
      if (!pr) return false;
      press.cur = null;
      band.style.display = 'none';
      el.canvas.classList.remove('is-panning');
      return !!(pr.drag || pr.moved);
    }
    // Enter or Space on a device or a PDU of the drawing selects it.
    el.svg.addEventListener('keydown', (e) => {
      if (ui.workspace !== 'power' || (e.key !== 'Enter' && e.key !== ' ')) return;
      const g = e.target.closest && e.target.closest('[data-dev], [data-pdu]');
      if (!g) return;
      e.preventDefault();
      selectDevice(g.dataset.dev || g.dataset.pdu);
      const again = el.svg.querySelector(`[data-dev="${CSS.escape(g.dataset.dev || '')}"], [data-pdu="${CSS.escape(g.dataset.pdu || '')}"]`);
      if (again) again.focus({ preventScroll: true });
    });

    // ------------------------------------------------------------ stage

    function renderStage() {
      el.floormap.hidden = true;
      el.canvas.classList.remove('is-map');
      const drawing = zoomable();
      sidesEl.hidden = !drawing;
      el.canvas.classList.toggle('has-sides', drawing);
      if (drawing) {
        host.hidden = true;
        delete el.canvas.dataset.cab;
        el.svg.removeAttribute('hidden');
        el.zoom.hidden = false;
        renderSides();
        renderElevation();
      } else {
        el.svg.setAttribute('hidden', '');
        el.zoom.hidden = true;
        host.hidden = false;
        el.canvas.dataset.cab = `pow-${ui.powView}`;
        if (ui.powView === 'outlets') renderOutletMap();
        else if (ui.powView === 'schedule') renderSchedule();
        else renderLoad();
      }
    }
    /** Back to another workspace: the host goes, the drawing comes back. */
    function hideStage() {
      host.hidden = true;
      delete el.canvas.dataset.cab;
      sidesEl.hidden = true;
      el.canvas.classList.remove('has-sides');
      band.style.display = 'none';
    }

    function renderNav() {
      $('.view-toggle').hidden = true;
      $('#pow-toggle').hidden = false;
      for (const b of $$('#pow-toggle [data-pow-view]')) b.setAttribute('aria-pressed', String(b.dataset.powView === ui.powView));
    }

    function renderChrome() {
      el.notice.hidden = true;
      const pd = ui.powPending;
      if (pd) {
        const t = ui.powType === 'auto' ? null : pctx().cordTypes.get(ui.powType);
        const from = `<strong>${esc(endText(pd))}</strong>`;
        const to = isInlet(pd) ? 'a free outlet of a PDU' : 'a free inlet of a device';
        el.armedHint.innerHTML =
          `<span>${CLICK} ${to} to connect ${from} with <strong>${esc(t ? t.name : 'Auto')}</strong><span class="hint-pointer">, <kbd>Esc</kbd> to cancel</span></span>` +
          `<button type="button" data-pow-cancel aria-label="Stop connecting" title="Stop connecting">${icon('x', 'ic-sm')}</button>`;
      }
      el.armedHint.hidden = !pd;
    }
    el.armedHint.addEventListener('click', (e) => {
      if (e.target.closest('[data-pow-cancel]')) cancelPending();
    });

    // What the views of the host share: clicks on what they name.
    host.addEventListener('click', (e) => {
      const t = e.target;
      const scope = t.closest('[data-pow-scope]');
      if (scope) return setScope(scope.dataset.powScope);
      // The fold of a group first: it sits in a line that is itself clicked.
      const fold = t.closest('[data-ps-fold]');
      if (fold) {
        const k = fold.dataset.psFold;
        if (!sched.collapsed.delete(k)) sched.collapsed.add(k);
        return ctx.render({ inspector: false });
      }
      const lfold = t.closest('[data-ld-fold]');
      if (lfold) {
        const k = lfold.dataset.ldFold;
        if (!ld.collapsed.delete(k)) ld.collapsed.add(k);
        return ctx.render({ inspector: false });
      }
      const out = t.closest('[data-pow-outlet]');
      if (out) {
        const [device, outlet] = splitKey(out.dataset.powOutlet);
        return clickEnd({ device, outlet }, e.shiftKey || e.ctrlKey || e.metaKey);
      }
      const fuse = t.closest('[data-pow-fuse]');
      if (fuse) {
        const [pdu, name] = splitKey(fuse.dataset.powFuse);
        return select({ kind: 'fuse', pdu, fuse: name });
      }
      const dev = t.closest('[data-pow-device]');
      if (dev) return selectDevice(dev.dataset.powDevice);
      const scen = t.closest('[data-pow-scen]');
      if (scen) {
        ui.powScenario = scen.dataset.powScen;
        return ctx.render();
      }
      const step = t.closest('[data-om-step]');
      if (step) return stepRack(Number(step.dataset.omStep));
      if (t.closest('[data-pow-go-racks]')) return ctx.setWorkspace('racks');
      if (t.closest('#ps-series')) return openSeries(seriesDevices());
      if (t.closest('#ps-order')) return exportCSV('order');
      if (t.closest('#ps-csv')) return exportCSV('cords');
      if (t.closest('#ld-csv')) return exportCSV('load');
      if (t.closest('#om-csv')) return exportCSV('outlets');
      if (t.closest('#ps-all')) return selectCords(t.closest('#ps-all').checked ? sched.visible.slice() : []);
      const tr = t.closest('tr[data-cord]');
      if (tr) return clickRow(tr.dataset.cord, e, !!t.closest('.sc-check'));
    });
    // A click on the checkbox of a row (or beside it in its cell) leaves keyboard focus where it was, as in the Cabling schedule; Tab and Space reach and switch it.
    host.addEventListener('pointerdown', (e) => {
      if (e.target.closest && e.target.closest('.sched tbody td.sc-check')) e.preventDefault();
    });
    host.addEventListener('change', (e) => {
      if (e.target.id === 'om-rack') setRack(e.target.value);
      if (e.target.id === 'ps-group') {
        prefs.powGroup = e.target.value;
        ctx.savePrefs();
        sched.collapsed.clear();
        ctx.render({ inspector: false });
      }
    });
    host.addEventListener('input', (e) => {
      if (e.target.id !== 'ps-filter') return;
      sched.filter = e.target.value;
      ctx.render({ inspector: false });
    });

    // ------------------------------------------------------------ outlet map

    /** The rack the outlet map opens at: the one of what is selected, else the one it showed, else the first of the row with a PDU. */
    function startRack() {
      const row = ctx.currentRow().row;
      const inRow = (id) => row.racks.some((r) => r.id === id);
      const s = ui.powSel;
      let d = null;
      if (s && s.kind === 'cords') d = deviceById((cordById(s.ids[0]) || { inlet: {} }).inlet.device);
      else if (s) d = deviceById(s.kind === 'fuse' ? s.pdu : s.id);
      if (d && inRow(d.loc.rack)) return d.loc.rack;
      if (om.rack && inRow(om.rack)) return om.rack;
      const withPdu = row.racks.find((r) => P.pdus(project(), new Set([r.id])).length);
      return (withPdu || row.racks[0]).id;
    }
    function omRack() {
      const row = ctx.currentRow().row;
      if (!om.rack || !row.racks.some((r) => r.id === om.rack)) om.rack = startRack();
      return row.racks.find((r) => r.id === om.rack);
    }
    function setRack(id) {
      if (!pctx().racks.has(id)) return;
      om.rack = id;
      ctx.render({ inspector: false });
    }
    function stepRack(by) {
      const racks = ctx.currentRow().row.racks;
      const i = racks.findIndex((r) => r.id === om.rack) + by;
      if (racks[i]) setRack(racks[i].id);
    }

    function renderOutletMap() {
      const p = project();
      const row = ctx.currentRow().row;
      const rack = omRack();
      const load = loads();
      const scen = load.scenarios.find((s) => s.id === ui.powScenario) || load.scenarios[0];
      const list = load.pdus.filter((x) => x.pdu.loc.rack === rack.id);
      const selCords = new Set(selCordIds());
      const s = ui.powSel;
      const pd = ui.powPending;
      const i = row.racks.indexOf(rack);
      let used = 0;
      let total = 0;
      const cols = list
        .map((x) => {
          const pdu = x.pdu;
          const key = gridKey(pdu);
          const down = scen.id !== UP && key === scen.id;
          const outlets = P.outletsOf(p, pdu, pctx());
          used += outlets.filter((o) => o.cord).length;
          total += outlets.length;
          const fuseValue = new Map(x.phases.flatMap((ph) => ph.fuses.map((f) => [f.fuse.name, f.value])));
          // The outlets from the top down, in runs of one fuse group.
          const runs = [];
          for (const o of outlets) {
            const name = o.fuse ? o.fuse.name : '';
            const last = runs[runs.length - 1];
            if (last && last.name === name) last.outlets.push(o);
            else runs.push({ name, fuse: o.fuse, outlets: [o] });
          }
          const meterW = new Map();
          const blocks = runs
            .map((run) => {
              const f = run.fuse;
              const v = f ? fuseValue.get(f.name) : null;
              const a = v ? v.a[scen.id] || 0 : 0;
              const picked = s && s.kind === 'fuse' && s.pdu === pdu.id && f && s.fuse === f.name;
              const head = f
                ? `<button type="button" class="om-fuse-head${picked ? ' is-selected' : ''}" data-pow-fuse="${esc(`${pdu.id}|${f.name}`)}" title="${esc(`Fuse group ${f.name}: ${f.ratingA} A on ${f.phase}`)}">` +
                  `<b>${esc(f.name)}</b><span class="om-ph">${esc(f.phase)}</span>` +
                  `<span class="fm-meter${a > f.ratingA * load.limit + 1e-9 ? ' is-over' : ''}"><span style="width:${Math.min(100, f.ratingA ? (a / f.ratingA) * 100 : 0).toFixed(1)}%"></span><i style="left:${(load.limit * 100).toFixed(0)}%"></i></span>` +
                  `<span class="mono">${esc(`${P.fmtA(a).replace(' A', '')} / ${f.ratingA} A`)}</span></button>`
                : `<div class="om-fuse-head is-none"><b>No fuse group</b></div>`;
              const items = run.outlets
                .map((o) => {
                  const w = o.cord ? P.cordW(load, o.cord.id, scen.id) : 0;
                  if (o.meter) meterW.set(o.meter.name, (meterW.get(o.meter.name) || 0) + w);
                  const pending = pd && !isInlet(pd) && pd.device === pdu.id && pd.outlet === o.name;
                  const cls = `om-out ${o.cord ? 'is-used' : 'is-free'}${o.cord && selCords.has(o.cord.id) ? ' is-selected' : ''}${pending ? ' is-pending' : ''}`;
                  const what = o.cord ? (o.device ? `${o.device.name} · ${o.inlet}` : '?') : `free · ${conn(o.connector)}`;
                  return (
                    `<li><button type="button" class="${cls}" data-pow-outlet="${esc(`${pdu.id}|${o.name}`)}" ` +
                    `title="${esc(o.cord ? `${o.cord.label || 'Cord'}: ${what}` : `Outlet ${o.name}, ${conn(o.connector)}: free`)}">` +
                    `<span class="om-n">${esc(o.name)}</span><i class="om-sock om-${esc(o.connector)}"></i><span class="om-dev">${esc(what)}</span>` +
                    `<span class="om-w">${o.cord ? esc(down ? '–' : P.fmtW(w)) : ''}</span><span class="om-m">${o.meter ? esc(o.meter.name) : ''}</span></button></li>`
                  );
                })
                .join('');
              return `<div class="om-fuse${f ? ` ph-${f.phase}` : ''}">${head}<ol class="om-outs">${items}</ol></div>`;
            })
            .join('');
          const spec = pduSpec(pdu);
          const meters = (spec.meters || []).length
            ? `<p class="om-meters">${spec.meters.map((m) => `<span title="${esc(`Meter group ${m.name}: outlets ${outletRange(m.outlets)}`)}"><b>${esc(m.name)}</b> ${esc(P.fmtW(meterW.get(m.name) || 0))}</span>`).join('')}</p>`
            : '';
          const picked = s && s.kind === 'pdu' && s.id === pdu.id;
          return (
            `<section class="om-pdu${down ? ' is-down' : ''}${picked ? ' is-selected' : ''}" style="--g:${gridColor(key)}" aria-label="${esc(pdu.name)}">` +
            `<header class="om-head"><i class="sw"></i><button type="button" class="pm-name" data-pow-device="${esc(pdu.id)}">${esc(pdu.name)}</button>` +
            `<span class="om-slot">${esc(M.formatPduSlot(p, rack, pdu.loc.at))}</span><span class="om-grid">${esc(gridName(key))}</span></header>` +
            `<p class="om-sub">${esc(`${x.type.label} · ${spec.phases} × ${spec.maxA} A · ${down ? 'no power' : `${P.fmtW(x.total.w[scen.id] || 0)} of ${P.fmtKw(x.capacityW)}`}`)}</p>` +
            meters +
            (down ? `<p class="om-down">${esc(`${scen.name}: no power`)}</p>` : '') +
            `<div class="om-fuses">${blocks}</div></section>`
          );
        })
        .join('');
      const slots = M.rackPduSlots(p, rack.id).length;
      const empty =
        `<div class="pm-none">${icon('power')}<span>${esc(rack.name)} has no PDU${slots ? ` in its ${plural(slots, 'PDU slot')}` : ', and its rack type has no PDU slots'}. ` +
        `Place vertical PDUs in the Racks workspace, or fill the PDU slots of a rack, row or floor there.</span>` +
        `<button type="button" class="btn sm" data-pow-go-racks>Go to Racks</button></div>`;
      const options = row.racks.map((r) => `<option value="${esc(r.id)}"${r.id === rack.id ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
      const scens = load.scenarios.map((x) => `<button type="button" data-pow-scen="${esc(x.id)}" aria-pressed="${x.id === scen.id}">${esc(x.name)}</button>`).join('');
      const html =
        `<div class="pm-scroll"><div class="pm om">` +
        `<div class="pm-top"><div class="fm-title"><h2>Outlets of ${esc(rack.name)}</h2>` +
        `<p>${esc(list.length ? `${plural(list.length, 'PDU')} · ${used} of ${plural(total, 'outlet')} used · load ${scen.id === UP ? 'with all grids up' : `when ${scen.grid.name} is down`}` : 'No PDUs')}</p></div>` +
        `<div class="pm-tools">` +
        `<button type="button" class="btn icon sm" data-om-step="-1" aria-label="Previous rack" title="Previous rack"${i <= 0 ? ' disabled' : ''}>${icon('left')}</button>` +
        `<label class="pm-pick">${icon('rack', 'ic-sm')}<span class="sr-only">Rack</span><select id="om-rack">${options}</select>${icon('chevron', 'ic-sm')}</label>` +
        `<button type="button" class="btn icon sm" data-om-step="1" aria-label="Next rack" title="Next rack"${i >= row.racks.length - 1 ? ' disabled' : ''}>${icon('right')}</button>` +
        (load.scenarios.length > 1 ? `<div class="seg om-scen" role="group" aria-label="Scenario">${scens}</div>` : '') +
        (list.length ? `<button type="button" class="btn sm" id="om-csv" title="Every outlet of this rack’s PDUs, as CSV">${icon('download', 'ic-sm')}Outlet plan (CSV)</button>` : '') +
        `</div></div>` +
        (list.length
          ? `<div class="om-cols">${cols}</div><p class="sec-hint">Bars: the load of each fuse group against its rating; the tick is the limit, ${pct(load.limit)}. ${CLICK} a free outlet to connect it, a used one to select its cord.</p>`
          : empty) +
        `</div></div>`;
      const scroll = host.querySelector('.pm-scroll');
      const at = scroll && host.dataset.view === 'outlets' ? { left: scroll.scrollLeft, top: scroll.scrollTop } : null;
      ctx.keepFocus(host, () => (host.innerHTML = html));
      host.dataset.view = 'outlets';
      if (at) {
        const again = host.querySelector('.pm-scroll');
        again.scrollLeft = at.left;
        again.scrollTop = at.top;
      }
    }

    // ------------------------------------------------------------ schedule

    const issueIcon = (level) => (level === 'warn' ? icon('warn', 'ic-sm is-warn') : icon('info', 'ic-sm is-info'));

    /** The cords of the schedule's scope that its filter keeps. */
    function scheduleCords() {
      const p = project();
      const all = P.cordsWithin(p, scopeRacks(prefs.powScope), pctx());
      const match = P.cordMatcher(p, sched.filter, pctx());
      return { all, shown: match ? all.filter(match) : all };
    }
    /** The devices Connect series starts from in the schedule: the ones selected, else those of the scope with a free inlet. */
    function seriesDevices() {
      const s = ui.powSel;
      if (s && s.kind === 'device') return [s.id];
      const racks = scopeRacks(prefs.powScope);
      return project()
        .devices.filter((d) => (!racks || racks.has(d.loc.rack)) && !isPdu(d))
        .map((d) => d.id);
    }

    function renderSchedule() {
      const p = project();
      if (host.dataset.view !== 'schedule') {
        host.innerHTML =
          `<div class="sc"><div class="sc-tools"><div class="fm-title"><h2 id="ps-title"></h2><p id="ps-sub"></p></div><span class="spacer"></span>` +
          `<span id="ps-scope"></span>` +
          `<button type="button" class="btn sm" id="ps-series" title="Connect the free inlets of devices to free outlets of their rack’s PDUs">${icon('swap', 'ic-sm')}Connect series…</button></div>` +
          `<div class="sc-filters"><label class="sc-search">${icon('filter', 'ic-sm')}<span class="sr-only">Filter the cords</span>` +
          `<input id="ps-filter" type="search" placeholder="Filter by device, PDU, label" autocomplete="off" spellcheck="false"></label><span class="spacer"></span>` +
          `<label class="sc-group-by"><span class="sr-only">Group the cords</span><select id="ps-group">${GROUPS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>` +
          `<button type="button" class="btn sm" id="ps-csv" title="These cords with their inlets and outlets, as CSV">${icon('download', 'ic-sm')}Schedule (CSV)</button>` +
          `<button type="button" class="btn sm" id="ps-order" title="The cords to order, by type, length and color, as CSV">${icon('download', 'ic-sm')}Order list (CSV)</button></div>` +
          `<div class="sc-scroll" id="ps-scroll"><table class="sched" id="ps-table" aria-label="Power cord schedule"><thead><tr>` +
          `<th class="sc-check"><input type="checkbox" id="ps-all" aria-label="Select every cord shown"></th>` +
          `<th>Label</th><th>Device · inlet</th><th>PDU</th><th class="sc-num">Outlet</th><th>Fuse</th><th>Phase</th><th>Meter</th>` +
          `<th>Cord type</th><th class="sc-num">Length</th><th class="sc-num">Draw</th><th class="sc-num">Grid down</th><th>Check</th></tr></thead><tbody id="ps-body"></tbody></table></div>` +
          `<div class="bom" id="ps-bom"></div></div>`;
        host.dataset.view = 'schedule';
        $('#ps-filter').value = sched.filter;
      }
      $('#ps-group').value = prefs.powGroup;
      $('#ps-scope').innerHTML = scopeSeg();
      const { all, shown } = scheduleCords();
      const load = loads();
      const groups = P.groupCords(p, shown, prefs.powGroup, pctx());
      const sel = new Set(selCordIds());
      const visible = [];
      let drawn = 0;
      let html = '';
      for (const g of groups) {
        const folded = sched.collapsed.has(g.key);
        if (prefs.powGroup !== 'none') {
          const color = g.color || (g.cords.length && (prefs.powGroup === 'pdu' || prefs.powGroup === 'grid') ? describe(g.cords[0]).grid : null);
          const sw = color ? `<span class="sw sw-net" style="--c:${color.color || color}"></span>` : '';
          html +=
            `<tr class="sc-group"><td colspan="13"><button type="button" class="sc-fold" data-ps-fold="${esc(g.key)}" aria-expanded="${!folded}">${icon(folded ? 'right' : 'chevron', 'ic-sm')}${sw}` +
            `<strong>${esc(g.label)}</strong></button><span class="sc-count">${plural(g.cords.length, 'cord')}</span></td></tr>`;
        }
        for (const cord of g.cords) {
          visible.push(cord.id);
          if (folded || drawn >= MAX_ROWS) continue;
          drawn++;
          html += cordRow(cord, load, sel.has(cord.id));
        }
      }
      if (visible.length > drawn && drawn >= MAX_ROWS) html += `<tr class="sc-none"><td colspan="13">${visible.length - drawn} more cords are not drawn: filter the list, fold a group or pick a row or a floor.</td></tr>`;
      if (!shown.length) {
        html = `<tr class="sc-none"><td colspan="13">${
          all.length ? 'No cord matches the filter.' : `No power cords in ${esc(scopeName(prefs.powScope))} yet. In the elevation, ${CLICK.toLowerCase()} an inlet and then an outlet, or use Connect series.`
        }</td></tr>`;
      }
      sched.visible = visible;
      // The rows are drawn again: the checkbox of a row or the fold of a group that has the focus keeps it.
      ctx.keepFocus($('#ps-body'), () => ($('#ps-body').innerHTML = html));
      $('#ps-title').textContent = `Power cords of ${scopeName(prefs.powScope)}`;
      $('#ps-sub').textContent = `${plural(all.length, 'cord')}${shown.length !== all.length ? ` · ${shown.length} shown` : ''} · lengths in italics are estimated`;
      const box = $('#ps-all');
      box.checked = visible.length > 0 && visible.every((id) => sel.has(id));
      box.indeterminate = !box.checked && visible.some((id) => sel.has(id));
      $('#ps-bom').innerHTML = orderHTML(all);
    }

    function cordRow(cord, load, selected) {
      const d = describe(cord);
      const ph = d.fuse ? d.fuse.phase : '';
      const issue = d.issues[0];
      const up = P.cordW(load, cord.id, UP);
      const down = P.cordDownW(load, cord.id);
      return (
        `<tr data-cord="${esc(cord.id)}"${selected ? ' class="is-selected" aria-selected="true"' : ''}>` +
        `<td class="sc-check"><input type="checkbox" data-ps-check="${esc(cord.id)}" aria-label="${esc(`Select ${cord.label || 'cord'}`)}"${selected ? ' checked' : ''}></td>` +
        `<td class="mono"><span class="sc-label"><span class="sc-net" style="--c:${d.color}"></span>${esc(cord.label || '–')}</span></td>` +
        `<td class="mono">${esc(d.device ? d.device.name : '?')} · ${esc(cord.inlet.inlet)}</td>` +
        `<td class="mono">${esc(d.pdu ? d.pdu.name : '?')}</td><td class="mono sc-num">${esc(cord.outlet.outlet)}</td>` +
        `<td class="mono">${esc(d.fuse ? d.fuse.name : '–')}</td><td class="mono${ph ? ` ph-${ph} ps-ph` : ''}">${esc(ph || '–')}</td><td class="mono">${esc(d.meter ? d.meter.name : '–')}</td>` +
        `<td>${esc(d.type ? d.type.name : 'No cord type')}${d.typeAuto && d.type ? ' <small>auto</small>' : ''}</td>` +
        `<td class="mono sc-num${d.lengthAuto ? ' is-auto' : ''}">${esc(d.lengthM === null ? '–' : P.fmtM(d.lengthM))}</td>` +
        `<td class="mono sc-num">${esc(P.fmtW(up))}</td><td class="mono sc-num">${esc(P.fmtW(down))}</td>` +
        `<td class="sc-issue">${issue ? `<span class="sc-flag is-warn" title="${esc(`${issue.title}: ${issue.text}`)}">${issueIcon('warn')}<span>${esc(issue.title)}</span></span>` : ''}</td></tr>`
      );
    }

    /** The order list under the table: the cords shown by type, length and color. */
    function orderHTML(cords) {
      const list = P.orderList(project(), cords, pctx());
      if (!list.length) return `<div class="bom-head"><strong>Order list</strong><span>Nothing to order yet.</span></div>`;
      const byType = new Map();
      for (const x of list) {
        const k = x.name;
        if (!byType.has(k)) byType.set(k, []);
        byType.get(k).push(x);
      }
      const types = [...byType]
        .map(([name, items]) => {
          const n = items.reduce((a, x) => a + x.count, 0);
          const parts = items
            .map(
              (x) =>
                `<span class="bom-item"><span class="sw" style="--c:${x.color}"></span> ${esc(x.lengthM === null ? 'no length' : P.fmtM(x.lengthM))} ${esc(x.colorName)} <i>×</i> <b>${x.count}</b></span>`
            )
            .join('<i>·</i>');
          return `<div class="bom-type"><span class="bom-name">${esc(name)}</span><span class="bom-items">${parts}<span class="bom-total">= ${n}</span></span></div>`;
        })
        .join('');
      return (
        `<div class="bom-head"><strong>Order list</strong><span>${esc(`${plural(cords.length, 'cord')} of ${scopeName(prefs.powScope)}, by cord type, length and color`)}</span></div>` +
        `<div class="bom-types">${types}</div>`
      );
    }

    /** A click on a row of the schedule: it selects the cord; Shift selects from the row clicked before, Ctrl or ⌘ (or the checkbox) adds or removes it. */
    function clickRow(id, e, toggle) {
      const ids = selCordIds();
      if (e.shiftKey && sched.anchor && sched.visible.includes(sched.anchor)) {
        const a = sched.visible.indexOf(sched.anchor);
        const b = sched.visible.indexOf(id);
        return selectCords([...new Set(ids.concat(sched.visible.slice(Math.min(a, b), Math.max(a, b) + 1)))]);
      }
      sched.anchor = id;
      if (toggle || e.ctrlKey || e.metaKey) return toggleCord(id);
      selectCords([id]);
    }

    // ------------------------------------------------------------ load

    function renderLoad() {
      const p = project();
      const load = loads();
      const racks = scopeRacks(prefs.powScope);
      const rows = load.pdus.filter((x) => !racks || racks.has(x.pdu.loc.rack));
      const s = ui.powSel;
      const settings = M.powerSettings(p);
      const scens = load.scenarios;
      const downs = scens.filter((x) => x.id !== UP);
      const sum = (list, id) => list.reduce((a, x) => a + (x.total.w[id] || 0), 0);
      const bar = (v) =>
        `<span class="ld-use${v.over ? ' is-over' : ''}"><span class="fm-meter"><span style="width:${Math.min(100, v.use * 100).toFixed(1)}%"></span><i style="left:${(load.limit * 100).toFixed(0)}%"></i></span>` +
        `<span class="mono">${pct(v.use)}</span></span>`;
      // Where a "One down" figure is from: the grid that is down for it, which need not be the worst case of the line (that may be all grids up).
      const when = (v) => (v.down === UP ? 'The plan has no power grid: the load with all grids up' : `Highest ${P.scenarioPhrase(p, v.down)}`);
      const amps = (v, rating) =>
        `<td class="mono sc-num">${rating} A</td><td class="mono sc-num">${esc(P.fmtA(v.upA))}</td><td class="mono sc-num" title="${esc(when(v))}">${esc(P.fmtA(v.downA))}</td><td>${bar(v)}</td>`;
      const flag = (text) => (text ? `<span class="sc-flag is-warn">${issueIcon('warn')}<span>${esc(text)}</span></span>` : '');
      // The grids of the plan in their order, then the PDUs without one.
      const keys = (p.powerGrids || []).map((g) => g.id).concat(rows.some((x) => gridKey(x.pdu) === NONE) ? [NONE] : []);
      let html = '';
      for (const key of keys) {
        const mine = rows.filter((x) => gridKey(x.pdu) === key);
        const up = sum(mine, UP);
        const down = downs.length ? Math.max(...downs.map((x) => sum(mine, x.id))) : up;
        html +=
          `<tr class="sc-group ld-grid"><td><span class="sw" style="--c:${gridColor(key)}"></span><strong>${esc(gridName(key))}</strong>` +
          `<span class="sc-count">${mine.length ? `${plural(mine.length, 'PDU')} in ${esc(scopeName(prefs.powScope))}` : 'no PDUs'}</span></td>` +
          `<td></td><td class="mono sc-num">${mine.length ? esc(P.fmtKw(up)) : '–'}</td><td class="mono sc-num">${mine.length ? esc(P.fmtKw(down)) : '–'}</td><td></td><td></td></tr>`;
        for (const x of mine) {
          const id = x.pdu.id;
          const folded = ld.collapsed.has(id);
          const picked = s && s.kind === 'pdu' && s.id === id;
          html +=
            `<tr class="ld-pdu${picked ? ' is-selected' : ''}" data-pow-device="${esc(id)}"><td><button type="button" class="sc-fold" data-ld-fold="${esc(id)}" aria-expanded="${!folded}" aria-label="${esc(`Phases and fuse groups of ${x.pdu.name}`)}">${icon(folded ? 'right' : 'chevron', 'ic-sm')}</button>` +
            `<button type="button" class="sc-dev" data-pow-device="${esc(id)}">${esc(x.pdu.name)}</button> <small>${esc(`${slotOf(x.pdu)} · ${(rackOf(x.pdu) || { rack: { name: '' } }).rack.name}`)}</small></td>` +
            `<td class="mono sc-num">${esc(P.fmtKw(x.capacityW))}</td><td class="mono sc-num">${esc(P.fmtKw(x.total.upW))}</td>` +
            `<td class="mono sc-num" title="${esc(when(x.total))}">${esc(P.fmtKw(x.total.downW))}</td><td>${bar(x.total)}</td><td class="sc-issue">${flag(x.total.over ? `Over ${pct(load.limit)}` : '')}</td></tr>`;
          if (folded) continue;
          const hi = Math.max(...x.phases.map((ph) => ph.value.worstA));
          for (const ph of x.phases) {
            const idle = x.phases.length > 1 && hi > 0 && ph.value.worstA < hi / 2;
            html +=
              `<tr class="ld-phase ph-${ph.phase}" data-pow-device="${esc(id)}"><td><span class="ld-in1 ps-ph">${esc(ph.phase)}</span></td>${amps(ph.value, ph.value.ratingA)}` +
              `<td class="sc-issue">${flag(ph.value.over ? `Over ${pct(load.limit)}` : idle ? (ph.value.worstA > 0 ? 'Not balanced' : 'No load') : '')}</td></tr>`;
            for (const f of ph.fuses) {
              const sel = s && s.kind === 'fuse' && s.pdu === id && s.fuse === f.fuse.name;
              html +=
                `<tr class="ld-fuse${sel ? ' is-selected' : ''}" data-pow-fuse="${esc(`${id}|${f.fuse.name}`)}"><td><span class="ld-in2"><button type="button" class="sc-dev" data-pow-fuse="${esc(`${id}|${f.fuse.name}`)}">${esc(f.fuse.name)}</button> ` +
                `<small>${esc(`outlets ${outletRange(f.fuse.outlets)}`)}</small></span></td>${amps(f.value, f.fuse.ratingA)}<td class="sc-issue">${flag(f.value.over ? `Over ${pct(load.limit)}` : '')}</td></tr>`;
            }
          }
        }
      }
      const volts = [...new Set(rows.map((x) => x.type.pdu.voltageV))];
      const sub =
        `Worst case: one grid down at a time. Amperes at ${volts.length === 1 ? `${volts[0]} V` : 'each PDU’s voltage'}, power factor ${settings.powerFactor}; ` +
        `the limit is ${settings.limitPct} % of a rating.`;
      const body = rows.length
        ? `<div class="sc-scroll"><table class="sched ld-table" aria-label="Power load"><thead><tr><th>Grid, PDU, phase, fuse group</th><th class="sc-num">Rating</th><th class="sc-num">All up</th>` +
          `<th class="sc-num">One down</th><th>Use at worst</th><th>Check</th></tr></thead><tbody>${html}</tbody></table></div>` +
          `<p class="sec-hint ld-foot">“One down” is the highest load of a line with one grid down${downs.length ? ` (${downs.map((x) => esc(x.name)).join(', ')})` : ''}. The tick on a bar is the limit.</p>`
        : `<div class="cab-empty">${icon('power')}<h2>No PDUs in ${esc(scopeName(prefs.powScope))}</h2><p>Place vertical PDUs in the Racks workspace, or fill the PDU slots of a rack, row or floor there. Their load shows here.</p>` +
          `<div class="cab-empty-actions"><button type="button" class="btn" data-pow-go-racks>Go to Racks</button></div></div>`;
      const html2 =
        `<div class="sc ld"><div class="sc-tools"><div class="fm-title"><h2>Load of ${esc(scopeName(prefs.powScope))}</h2><p>${esc(sub)}</p></div><span class="spacer"></span>${scopeSeg()}` +
        (rows.length ? `<button type="button" class="btn sm" id="ld-csv" title="Grid, PDU, phase and fuse group in every scenario, as CSV">${icon('download', 'ic-sm')}Load (CSV)</button>` : '') +
        `</div>${body}</div>`;
      const scroll = host.querySelector('.sc-scroll');
      const at = scroll && host.dataset.view === 'load' ? scroll.scrollTop : 0;
      ctx.keepFocus(host, () => (host.innerHTML = html2));
      host.dataset.view = 'load';
      const again = host.querySelector('.sc-scroll');
      if (again) again.scrollTop = at;
    }

    // ------------------------------------------------------------ left panel

    /** A power cord with its two plugs, for the cards of the panel; dashed for Auto. */
    function cordArt(t) {
      const dark = ui.theme === 'dark';
      const cord = t ? (dark ? '#aab4bf' : '#2d3339') : dark ? '#8e99a6' : '#9aa5b1';
      const metal = dark ? '#77818c' : '#c3cad2';
      const ink = dark ? '#0d1115' : '#2a3038';
      const big = (id) => /c19|c20|l6/.test(id || '');
      const plug = (x, dir, id) => {
        const h = big(id) ? 18 : 14;
        return (
          `<g transform="translate(${x} 22) scale(${dir} 1)"><rect x="0" y="${-h / 2 + 1.5}" width="12" height="${h - 3}" rx="2.5" fill="${t ? cord : 'none'}"/>` +
          `<rect x="11" y="${-h / 2}" width="17" height="${h}" rx="2" fill="${t ? metal : 'none'}" stroke="${t ? ink : cord}" stroke-width="${t ? 0.8 : 1.2}"${t ? '' : ' stroke-dasharray="3 2"'}/>` +
          (t ? `<path d="M16 -3v6M20 -3v6M24 -3v6" stroke="${ink}" stroke-width="1" opacity=".55"/>` : '') +
          `</g>`
        );
      };
      return (
        `<svg viewBox="0 0 188 44" width="188" height="44" aria-hidden="true"><path d="M40 22 C 62 4, 82 4, 94 22 S 128 40, 148 22" fill="none" stroke="${cord}" ` +
        `stroke-width="${t && (big(t.outlet) || big(t.inlet)) ? 5 : 3.5}" stroke-linecap="round"${t ? '' : ' stroke-dasharray="5 4"'}/>${plug(40, -1, t && t.outlet)}${plug(148, 1, t && t.inlet)}</svg>`
      );
    }
    /** How many cords of the plan are of each cord type, named or picked. */
    function typeCounts() {
      const c = fresh();
      if (!c.counts) {
        c.counts = new Map();
        for (const cord of c.project.powerCords || []) {
          const d = describe(cord);
          if (d.type) c.counts.set(d.type.id, (c.counts.get(d.type.id) || 0) + 1);
        }
      }
      return c.counts;
    }

    const binHTML = { types: null, grids: null };
    function renderBin() {
      const p = project();
      $('#racks-parts-sec').hidden = true;
      $('#racks-clusters-sec').hidden = true;
      $('#pow-types-sec').hidden = false;
      $('#pow-grids-sec').hidden = false;
      $('#bin').setAttribute('aria-label', 'Cord types and power grids');
      const counts = typeCounts();
      // Only the card armed is a stop for Tab; arrow keys go through the others.
      const card = (id, name, spec, art, n, title) => {
        const on = ui.powType === id;
        return (
          `<button type="button" class="cab-card${on ? ' is-armed' : ''}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-pow-type="${esc(id)}" title="${esc(title)}">` +
          `<span class="part-art">${art}</span><span class="part-meta"><span class="part-name">${esc(name)}</span><span class="part-spec">${esc(spec)}</span></span>` +
          (n === null ? '' : `<span class="part-count${n ? '' : ' is-zero'}" title="${n} in the plan">${n}</span>`) +
          `</button>`
        );
      };
      const types =
        card('auto', 'Auto', 'by plugs and length', cordArt(null), null, 'New cords take the first cord type whose plugs fit the outlet and the inlet') +
        (p.cordTypes || []).map((t) => card(t.id, t.name, `outlet ${conn(t.outlet)} · inlet ${conn(t.inlet)}`, cordArt(t), counts.get(t.id) || 0, `New cords are ${t.name}`)).join('');
      const typesKey = ui.theme + types;
      if (binHTML.types !== typesKey) {
        ctx.keepFocus($('#pow-types'), () => ($('#pow-types').innerHTML = types));
        binHTML.types = typesKey;
      }

      // The grids: the cords on each, and an eye that hides them in the elevation.
      const per = new Map();
      for (const c of p.powerCords || []) {
        const k = gridKey(deviceById(c.outlet.device));
        per.set(k, (per.get(k) || 0) + 1);
      }
      const fed = P.gridUse(p);
      const eyes = ui.powView === 'elevation';
      const row = (id, name, color, note, editable) => {
        const shown = !ui.hiddenGrids.has(id);
        const label = `Show the cords of ${name} in the elevation`;
        const n = per.get(id) || 0;
        const title = `${name}${note ? ` · ${note}` : ''} · ${plural(fed.get(id) || 0, 'PDU')}`;
        return (
          `<li class="cl-row${eyes && !shown ? ' is-hidden' : ''}" data-grid="${esc(id)}">` +
          (eyes
            ? `<button type="button" class="btn icon sm subtle cl-eye" data-grid-eye="${esc(id)}" aria-pressed="${shown}" aria-label="${esc(label)}" title="${esc(label)} (Alt-click: only it)">${icon(shown ? 'eye' : 'eye-off')}</button>`
            : '') +
          `<${editable ? 'button type="button"' : 'span'} class="cl-main"${editable ? ` data-grid-edit="${esc(id)}"` : ''} title="${esc(title)}"><span class="sw sw-net" style="--c:${color}"></span>` +
          `${ctx.listName(name)}${note ? `<small class="cl-note">${esc(note)}</small>` : ''}<span class="cl-count" title="${plural(n, 'cord')}">${n}</span></${editable ? 'button' : 'span'}>` +
          (editable
            ? `<span class="cl-tools"><button type="button" class="btn icon sm subtle cl-edit" data-grid-edit="${esc(id)}" aria-label="Edit ${esc(name)}" title="Rename, recolor or add a note">${icon('pencil')}</button></span>`
            : `<span class="cl-tools"><span class="btn icon sm subtle" aria-hidden="true" style="visibility:hidden"></span></span>`) +
          `</li>`
        );
      };
      let grids = (p.powerGrids || []).map((g) => row(g.id, g.name, g.color, g.note || '', true)).join('');
      if (fed.get(NONE)) grids += row(NONE, 'No grid', 'var(--unassigned)', '', false);
      grids = grids || `<li class="cl-empty">No power grids yet.</li>`;
      if (binHTML.grids !== grids) {
        ctx.keepFocus($('#pow-grids'), () => ($('#pow-grids').innerHTML = grids));
        binHTML.grids = grids;
      }
      $('#btn-add-grid').disabled = (p.powerGrids || []).length >= M.LIMITS.powerGrids;
      const nHidden = ui.hiddenGrids.size;
      ctx.hiddenNote($('#pow-grids-hidden'), nHidden ? `${plural(nHidden, 'grid')} hidden${eyes ? '' : ' in the elevation'}` : '');
      $('#pow-grids-hint').textContent = (p.powerGrids || []).length ? 'A grid feeds PDUs; its color colors their cords. Count: cords per grid.' : 'A grid feeds PDUs. Its color colors their cords.';
      const bare = P.typesWithoutInlets(p);
      const nBare = bare.reduce((a, x) => a + x.count, 0);
      const note = $('#pow-noinlets');
      note.hidden = !nBare;
      if (nBare) {
        note.innerHTML =
          `${icon('warn', 'ic-sm is-warn')}<span>${plural(nBare, 'device has', 'devices have')} no inlets. ` +
          `<button type="button" class="btn-link" data-pow-add-inlets title="${esc(`Gives ${bare.map((x) => x.type.label).join(', ')} two C14 inlets, psu1 and psu2`)}">Add psu[1-2] C14</button></span>`;
      }
    }
    /** Back to another workspace. */
    function hideBin() {
      $('#racks-parts-sec').hidden = false;
      $('#racks-clusters-sec').hidden = false;
      $('#pow-types-sec').hidden = true;
      $('#pow-grids-sec').hidden = true;
      $('#bin').setAttribute('aria-label', 'Devices and clusters');
      $('.view-toggle').hidden = false;
      $('#pow-toggle').hidden = true;
      hideStage();
    }

    function armType(id) {
      ui.powType = id;
      ctx.render({ inspector: false });
    }
    $('#pow-types').addEventListener('click', (e) => {
      const card = e.target.closest('[data-pow-type]');
      if (card) armType(card.dataset.powType);
    });
    // Arrow keys move between the cord types like a radio group.
    $('#pow-types').addEventListener('keydown', (e) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const cards = $$('[data-pow-type]', $('#pow-types'));
      const i = cards.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      armType(cards[(i + (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1) + cards.length) % cards.length].dataset.powType);
      const again = $(`[data-pow-type="${CSS.escape(ui.powType)}"]`);
      if (again) again.focus();
    });
    $('#btn-pow-catalog').addEventListener('click', () => ctx.openCatalog('cords'));
    $('#btn-add-grid').addEventListener('click', () => openGridDialog(null));
    $('#pow-grids').addEventListener('click', (e) => {
      const rowEl = e.target.closest('.cl-row');
      if (!rowEl) return;
      const id = rowEl.dataset.grid;
      if (e.target.closest('.cl-eye')) {
        ctx.toggleEye(ui.hiddenGrids, $$('.cl-row', $('#pow-grids')).map((x) => x.dataset.grid), id, e.altKey);
        return ctx.render({ inspector: false });
      }
      if (e.target.closest('[data-grid-edit]')) openGridDialog(id);
    });
    $('#pow-grids-hidden').addEventListener('click', (e) => {
      if (!e.target.closest('[data-show-all]')) return;
      ui.hiddenGrids.clear();
      ctx.render({ inspector: false });
    });
    $('#pow-noinlets').addEventListener('click', (e) => {
      if (e.target.closest('[data-pow-add-inlets]')) addInlets(P.typesWithoutInlets(project()).map((x) => x.type.id));
    });
    /** Gives device types without inlets the standard two (psu1 and psu2, C14). */
    function addInlets(typeIds) {
      const names = typeIds.map((id) => M.typeOf(project(), id).label);
      let err = null;
      ctx.commit((p) => {
        for (const id of typeIds) err = err || M.updateDeviceType(p, id, { inlets: M.DEFAULT_INLETS });
        return err ? false : undefined;
      });
      if (err) return toast(err, { warn: true });
      toast(`Gave ${names.length === 1 ? names[0] : plural(names.length, 'device type')} the inlets psu1 and psu2`, { action: 'Undo', onAction: ctx.undo });
    }

    // ------------------------------------------------------------ power grid dialog

    const gridDlg = { id: null, color: null };
    function openGridDialog(id) {
      const p = project();
      const g = id ? M.powerGridById(p, id) : null;
      if (!g && (p.powerGrids || []).length >= M.LIMITS.powerGrids) return toast(`A plan holds up to ${M.LIMITS.powerGrids} power grids`, { warn: true });
      const fresh0 = g || M.cleanPowerGrid({}, p);
      Object.assign(gridDlg, { id: g ? g.id : null, color: fresh0.color });
      $('#grid-kicker').textContent = g ? 'Edit power grid' : 'New power grid';
      $('#grid-title').textContent = g ? g.name : 'Add a power grid';
      $('#grid-name').value = fresh0.name;
      $('#grid-note').value = fresh0.note || '';
      $('#grid-delete').hidden = !g;
      $('#grid-submit').textContent = g ? 'Save' : 'Add';
      ctx.renderSwatches($('#grid-colors'), 'grid-color', gridDlg.color, (col) => (gridDlg.color = col));
      ctx.showError('#grid-error', '');
      ctx.openDialog($('#dlg-grid'));
      $('#grid-name').focus();
      $('#grid-name').select();
    }
    $('#grid-name').addEventListener('input', () => ctx.showError('#grid-error', ''));
    $('#grid-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#grid-name').value.trim();
      if (!name) return ctx.showError('#grid-error', 'Give the power grid a name.');
      const props = { name, color: gridDlg.color, note: $('#grid-note').value.trim() };
      if (gridDlg.id) {
        const id = gridDlg.id;
        let err = null;
        ctx.commit((p) => {
          err = P.updateGrid(p, id, props);
          return err ? false : undefined;
        });
        if (err) return ctx.showError('#grid-error', err);
      } else {
        if (M.nameTaken(project().powerGrids || [], name)) return ctx.showError('#grid-error', `Another power grid is named ${name}.`);
        const made = ctx.commitAdd((p) => P.addGrid(p, props));
        if (!made) return ctx.showError('#grid-error', `A plan holds up to ${M.LIMITS.powerGrids} power grids.`);
        toast(`Added ${made.name}`, { action: 'Undo', onAction: ctx.undo });
      }
      $('#dlg-grid').close();
    });
    $('#grid-delete').addEventListener('click', async () => {
      const g = M.powerGridById(project(), gridDlg.id);
      if (!g) return;
      const n = P.gridUse(project()).get(g.id) || 0;
      $('#dlg-grid').close();
      if (n) {
        const ok = await ctx.confirmDialog({ title: `Delete ${g.name}?`, body: `${plural(n, 'PDU stays', 'PDUs stay')}, without a grid: their load counts under “No grid”. Undo brings the grid back.`, ok: 'Delete grid' });
        if (!ok) return;
      }
      ctx.commit((p) => void P.deleteGrid(p, g.id));
      toast(`Deleted ${g.name}`, { action: 'Undo', onAction: ctx.undo });
    });

    // ------------------------------------------------------------ connect series

    const series = { devices: [], plan: null };
    /** Plans cords for the free inlets of `deviceIds` and shows them to confirm. */
    function openSeries(deviceIds) {
      series.devices = deviceIds;
      drawSeries();
      ctx.openDialog($('#dlg-pow-series'));
      $('#pow-series-submit').focus();
    }
    function drawSeries() {
      const p = project();
      const ids = series.devices.filter(deviceById);
      const plan = P.planSeries(p, ids, pctx());
      series.plan = plan;
      const names = ids.map((id) => deviceById(id).name);
      $('#pow-series-sub').textContent = `${names.length === 1 ? names[0] : plural(names.length, 'device')}: each free inlet goes to a free outlet of its rack’s PDUs, the first inlet to the first PDU, in the fuse group with the least load.`;
      const rows = plan.items
        .map((it) => {
          const d = deviceById(it.inlet.device);
          const pdu = deviceById(it.outlet.device);
          const g = pctx().info(pdu.type).groups.get(it.outlet.outlet) || {};
          return (
            `<tr><td class="mono"><span class="sc-label"><span class="sc-net" style="--c:${gridColor(gridKey(pdu))}"></span>${esc(d.name)} · ${esc(it.inlet.inlet)}</span></td>` +
            `<td class="mono">${esc(pdu.name)} · ${esc(it.outlet.outlet)}</td><td class="mono">${esc([g.fuse && g.fuse.name, g.fuse && g.fuse.phase, g.meter && g.meter.name].filter(Boolean).join(' · ') || '–')}</td></tr>`
          );
        })
        .join('');
      $('#pow-series-preview').innerHTML = plan.items.length
        ? `<table class="sched sched-mini" aria-label="Cords to connect"><thead><tr><th>Inlet</th><th>Outlet</th><th>Fuse · phase · meter</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="sc-none">No free inlet can be connected.</p>`;
      const skipped = plan.skipped.slice(0, 8).map((x) => `<li>${esc(`${(deviceById(x.device) || { name: '?' }).name}${x.inlet ? ` ${x.inlet}` : ''}: ${x.why}`)}</li>`);
      $('#pow-series-skipped').hidden = !plan.skipped.length;
      $('#pow-series-skipped').innerHTML =
        `<p>${plural(plan.skipped.length, 'inlet stays', 'inlets stay')} without a cord:</p><ul>${skipped.join('')}${plan.skipped.length > 8 ? `<li>and ${plan.skipped.length - 8} more</li>` : ''}</ul>`;
      $('#pow-series-submit').disabled = !plan.items.length;
      $('#pow-series-submit').textContent = plan.items.length ? `Connect ${plural(plan.items.length, 'cord')}` : 'Connect';
      ctx.showError('#pow-series-error', '');
    }
    $('#pow-series-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const items = series.plan ? series.plan.items : [];
      if (!items.length) return;
      let error = null;
      let made = [];
      ctx.commit((p) => {
        const r = P.connectSeries(p, items);
        error = r.error || null;
        made = r.cords || [];
        return error ? false : undefined;
      });
      if (error) return ctx.showError('#pow-series-error', error);
      $('#dlg-pow-series').close();
      for (const c of made) ui.hiddenGrids.delete(gridKey(deviceById(c.outlet.device)));
      ui.powSel = { kind: 'cords', ids: made.map((c) => c.id) };
      ctx.render();
      toast(`Connected ${plural(made.length, 'cord')}${made.length ? `: ${made[0].label}${made.length > 1 ? ` to ${made[made.length - 1].label}` : ''}` : ''}`, { action: 'Undo', onAction: ctx.undo });
    });
    /** After undo or redo: a plan of cords shown to confirm is worked out again. */
    function onRestore() {
      if ($('#dlg-pow-series').open) drawSeries();
    }

    // ------------------------------------------------------------ inspectors

    const swatch = (color) => `<span class="sw sw-net" style="--c:${color}"></span>`;
    const stat = (label, value, small) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}${small ? ` <small>${esc(small)}</small>` : ''}</dd></div>`;
    const where = (d) => M.formatDeviceLoc(project(), d);
    const showButton = (sel) =>
      ui.powView === 'elevation' ? '' : `<button type="button" class="btn" id="pow-show" title="The row of the racks where it is seen, scrolled to it">${icon('rack')}Show in elevation</button>`;
    function bindShow(sel) {
      const b = $('#pow-show');
      if (b) b.addEventListener('click', () => showInElevation(sel));
    }
    /** A meter like those of the Racks inspectors, with a tick at the limit. */
    function meter(label, value, max, text, over) {
      const w = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
      return (
        `<div class="meter${over ? ' is-over' : ''}"><div class="meter-top"><span>${esc(label)}</span><span class="mono">${esc(text)}</span></div>` +
        `<div class="meter-track pw-track"><span style="width:${w.toFixed(1)}%"></span><i style="left:${(loads().limit * 100).toFixed(0)}%"></i></div></div>`
      );
    }

    function inspectorKey() {
      return JSON.stringify([ui.powSel || null, ui.powView]);
    }

    function renderInspector() {
      const s = ui.powSel;
      if (s && s.kind === 'cords') {
        const list = s.ids.map(cordById).filter(Boolean);
        if (list.length === 1) cordInspector(list[0]);
        else cordsInspector(list);
      } else if (s && s.kind === 'device') deviceInspector(deviceById(s.id));
      else if (s && s.kind === 'pdu') pduInspector(deviceById(s.id));
      else if (s && s.kind === 'fuse') fuseInspector(deviceById(s.pdu), s.fuse);
      else overviewInspector();
    }

    /** The checks drawn last, which a click on one reads. */
    let checksShown = [];
    function checkList(list) {
      checksShown = list;
      if (!list.length) return `<ul class="check-list"><li>${icon('check', 'ic-sm is-ok')}<span>No problems</span></li></ul>`;
      const shown = list.slice(0, 60);
      return (
        `<ul class="check-list">` +
        shown
          .map((x, i) => {
            const act = x.kind === 'noinlets' ? ` <span class="check-act">Add psu[1-2] C14</span>` : '';
            return `<li><button type="button" class="check-link" data-pow-check="${i}">${issueIcon(x.level)}<span><b>${esc(x.title)}</b><br>${esc(x.text)}${act}</span></button></li>`;
          })
          .join('') +
        (list.length > shown.length ? `<li>${issueIcon('note')}<span>and ${list.length - shown.length} more</span></li>` : '') +
        `</ul>`
      );
    }
    /** A click on a check selects what it is about; a type without inlets gets the standard two. */
    function bindChecks() {
      $$('[data-pow-check]', el.inspector).forEach((b) =>
        b.addEventListener('click', () => {
          const x = checksShown[Number(b.dataset.powCheck)];
          if (!x) return;
          if (x.kind === 'noinlets') return addInlets([x.type]);
          const sel = x.cord ? { kind: 'cords', ids: [x.cord] } : x.fuse ? { kind: 'fuse', pdu: x.pdu, fuse: x.fuse } : x.pdu ? { kind: 'pdu', id: x.pdu } : x.device ? { kind: 'device', id: x.device } : null;
          if (!sel) return;
          if (ui.powView === 'elevation') return showInElevation(sel);
          followDevice(sel.kind === 'cords' ? cordById(x.cord).inlet.device : sel.kind === 'fuse' ? sel.pdu : sel.id);
          select(sel);
        })
      );
    }

    function overviewInspector() {
      const p = project();
      const pos = ctx.currentRow();
      const racks = new Set(pos.row.racks.map((r) => r.id));
      const load = loads();
      const rows = load.pdus.filter((x) => racks.has(x.pdu.loc.rack));
      const cords = P.cordsWithin(p, racks, pctx());
      const up = rows.reduce((a, x) => a + x.total.upW, 0);
      const grids = new Set(rows.map((x) => gridKey(x.pdu)));
      const settings = M.powerSettings(p);
      const list = P.checks(p, racks, load);
      const warns = list.filter((x) => x.level === 'warn').length;
      el.inspector.innerHTML =
        `<div class="insp-head"><div class="kicker">${icon('power', 'ic-sm')}${esc(pos.row.name)} · power</div>` +
        `<div class="multi-title">${esc(P.fmtKw(up))}</div>` +
        `<div class="insp-where">on its PDUs with all grids up</div>` +
        `<div class="insp-sub">${esc(`${plural(rows.length, 'PDU')} · ${plural(cords.length, 'cord')} · ${plural(grids.size, 'grid')}`)}</div></div>` +
        `<section class="insp-sec" id="pow-checks"><h3>Checks${list.length ? ` · ${warns ? plural(warns, 'warning') : plural(list.length, 'note')}` : ''}</h3>${checkList(list)}</section>` +
        `<section class="insp-sec" id="pow-settings"><h3>Settings of the plan</h3><div class="field-grid">` +
        `<div class="field"><label for="pow-limit">Limit (%)</label><input id="pow-limit" type="number" min="10" max="100" step="1" inputmode="numeric" value="${settings.limitPct}"></div>` +
        `<div class="field"><label for="pow-pf">Power factor</label><input id="pow-pf" type="number" min="0.5" max="1" step="0.01" inputmode="decimal" value="${settings.powerFactor}"></div></div>` +
        `<p class="sec-hint">A fuse group, phase or PDU over the limit at its worst gets a warning. Amperes are watts / (volts × power factor).</p></section>`;
      bindChecks();
      const setting = (sel, key) =>
        $(sel).addEventListener('change', (e) => {
          const v = Number(e.target.value);
          if (e.target.value.trim() === '' || !Number.isFinite(v)) return ctx.renderInspector();
          ctx.commit((p2) => void P.setPowerSettings(p2, { [key]: v }));
          ctx.renderInspector();
        });
      setting('#pow-limit', 'limitPct');
      setting('#pow-pf', 'powerFactor');
    }

    /** A row of an inlet list: the inlet, where its cord goes, and what it draws. */
    function inletRow(d, x, load) {
      const cord = x.cord;
      const row = (jack, main, right) => `<li class="pl-row${cord ? '' : ' is-free'}"><span class="pl-jack"${jack}></span>${main}${right}<span class="pl-flag"></span></li>`;
      const name = `<span class="pl-port"><b>${esc(x.name)}</b><small>${esc(conn(x.connector))}${cord ? ` · ${esc(P.fmtW(P.cordW(load, cord.id, UP)))}` : ''}</small></span>`;
      if (!cord) {
        const pending = sameEnd(ui.powPending, { device: d.id, inlet: x.name });
        return row('', name, `<span class="pl-free">no cord</span><button type="button" class="btn sm" data-pow-plug="${esc(x.name)}" aria-pressed="${pending}">${pending ? 'Connecting…' : 'Connect'}</button>`);
      }
      const r = describe(cord);
      const down = P.cordDownW(load, cord.id);
      const groups = [r.fuse && r.fuse.name, r.fuse && r.fuse.phase, r.meter && r.meter.name].filter(Boolean).join(' · ');
      const cordText = `${r.type ? r.type.name : 'no cord type'} · ${r.lengthM === null ? 'no length' : P.fmtM(r.lengthM)}`;
      const peer =
        `<button type="button" class="pl-peer" data-pow-cord="${esc(cord.id)}" title="${esc(`Select ${cord.label || 'the cord'}`)}"><b>${esc(`${r.pdu ? r.pdu.name : '?'} · ${cord.outlet.outlet}`)}</b>` +
        `<small>${esc(groups || 'no fuse group')}</small><small>${esc(cordText)}</small>` +
        (load.scenarios.length > 1 ? `<small>${esc(`${P.fmtW(down)} with one grid down`)}</small>` : '') +
        `</button>`;
      return row(` style="--c:${r.color}"`, name, peer);
    }

    function deviceInspector(d) {
      const p = project();
      const type = M.typeOf(p, d.type);
      const load = loads();
      const info = load.devices.get(d.id) || { inlets: [], corded: 0, grids: [], off: [], powerW: M.powerOf(p, d) };
      const cl = M.clusterOf(p, d, ctx.view());
      const pos = rackOf(d);
      const n = info.inlets.length;
      const gridNames = info.grids.map(gridName);
      const note = !n
        ? `${type.label} has no inlets: it cannot get a cord. Give its type inlets in the catalog.`
        : !info.corded
          ? 'No inlet has a cord yet.'
          : info.grids.length > 1
            ? `Redundant: ${gridNames.join(' and ')}`
            : info.corded > 1
              ? `No redundancy: every cord is on ${gridNames[0]}`
              : `One cord, on ${gridNames[0]}`;
      const ports = M.expandPorts ? M.expandPorts(type).length : 0;
      el.inspector.innerHTML =
        `<div class="insp-head"><div class="kicker"><span class="sw" style="--c:${cl ? cl.color : 'var(--unassigned)'}"></span>${esc(type.label)}</div>` +
        `<div class="name-input name-static">${esc(d.name)}</div>` +
        `<div class="insp-where">${esc(where(d))}</div>` +
        `<div class="insp-sub">${esc(`${pos ? `${pos.floor.name} · ${pos.row.name} · ` : ''}${P.fmtW(info.powerW)} · ${info.corded} of ${plural(n, 'inlet')} ${n === 1 ? 'has' : 'have'} a cord`)}</div></div>` +
        `<section class="insp-sec"><p class="insp-note" id="pow-dev-note">${esc(note)}</p></section>` +
        `<section class="insp-sec" id="pow-inlets"><h3>Inlets</h3>` +
        (n
          ? `<ul class="port-list">${info.inlets.map((x) => inletRow(d, x, load)).join('')}</ul>`
          : `<p class="empty-note"><button type="button" class="btn sm" id="pow-dev-add-inlets">Add psu[1-2] C14</button></p>`) +
        `</section>` +
        `<section class="insp-sec"><h3>Power</h3><dl class="stats">${stat('Draw', P.fmtW(info.powerW))}${stat('Inlets', `${info.corded} / ${n}`, 'with a cord')}${stat('Network ports', String(ports), 'in Network')}</dl></section>` +
        `<div class="insp-actions is-pinned">${showButton()}<button type="button" class="btn" id="pow-dev-series"${info.inlets.some((x) => !x.cord) ? '' : ' disabled'}>${icon('swap')}Connect series…</button>` +
        `<button type="button" class="btn danger-text" id="pow-dev-unplug"${info.corded ? '' : ' disabled'}>${icon('unplug')}Unplug all</button></div>`;
      const id = d.id;
      bindShow({ kind: 'device', id });
      $$('[data-pow-cord]', el.inspector).forEach((b) => b.addEventListener('click', () => selectCords([b.dataset.powCord])));
      $$('[data-pow-plug]', el.inspector).forEach((b) =>
        b.addEventListener('click', () =>
          // The inspector is drawn again: the button of this inlet keeps the focus, to stop what it started.
          ctx.keepFocus(el.inspector, () => {
            const end = { device: id, inlet: b.dataset.powPlug };
            if (sameEnd(ui.powPending, end)) return cancelPending();
            // The other end is an outlet: the views that show them take the click.
            if (ui.powPending && !isInlet(ui.powPending)) return connectEnds(end, ui.powPending);
            ui.powPending = end;
            if (!END_VIEWS.has(ui.powView)) return showInElevation({ kind: 'device', id });
            ctx.render();
          })
        )
      );
      const add = $('#pow-dev-add-inlets');
      if (add) add.addEventListener('click', () => addInlets([d.type]));
      $('#pow-dev-series').addEventListener('click', () => openSeries([id]));
      $('#pow-dev-unplug').addEventListener('click', () => unplugDevice(deviceById(id)));
    }

    function pduInspector(pdu) {
      const p = project();
      const load = loads();
      const x = load.pdus.find((r) => r.pdu.id === pdu.id);
      const key = gridKey(pdu);
      const spec = pduSpec(pdu);
      const outlets = P.outletsOf(p, pdu, pctx());
      const used = outlets.filter((o) => o.cord).length;
      const pos = rackOf(pdu);
      const worst = load.scenarios.find((s) => s.id === x.total.worst);
      const phases = x.phases
        .map(
          (ph) =>
            meter(ph.phase, ph.value.worstA, ph.value.ratingA, `${P.fmtA(ph.value.worstA)} of ${ph.value.ratingA} A`, ph.value.over) +
            `<ul class="pw-fuses ph-${ph.phase}">` +
            ph.fuses
              .map(
                (f) =>
                  `<li><button type="button" class="pw-fuse${f.value.over ? ' is-over' : ''}" data-pow-fuse="${esc(f.fuse.name)}"><b>${esc(f.fuse.name)}</b>` +
                  `<span>${esc(`outlets ${outletRange(f.fuse.outlets)}`)}</span><span class="mono">${esc(`${P.fmtA(f.value.worstA)} of ${f.fuse.ratingA} A`)}</span></button></li>`
              )
              .join('') +
            `</ul>`
        )
        .join('');
      const options = `<option value="">No grid</option>` + (p.powerGrids || []).map((g) => `<option value="${esc(g.id)}"${g.id === key ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
      el.inspector.innerHTML =
        `<div class="insp-head"><div class="kicker">${swatch(gridColor(key))}${esc(gridName(key))} · vertical PDU</div>` +
        `<div class="name-input name-static">${esc(pdu.name)}</div>` +
        `<div class="insp-where">${esc(where(pdu))}</div>` +
        `<div class="insp-sub">${esc(`${pos ? `${pos.floor.name} · ${pos.row.name} · ` : ''}${x.type.label} · ${spec.phases} × ${spec.maxA} A · ${P.fmtKw(x.capacityW)}`)}</div></div>` +
        `<section class="insp-sec"><div class="field"><label for="pow-pdu-grid">Power grid</label><select id="pow-pdu-grid">${options}</select></div></section>` +
        `<section class="insp-sec" id="pow-pdu-load"><h3>Load at worst</h3>` +
        meter('PDU', x.total.worstW, x.capacityW, `${P.fmtKw(x.total.worstW)} of ${P.fmtKw(x.capacityW)}`, x.total.over) +
        phases +
        `<p class="sec-hint">${esc(`With all grids up it carries ${P.fmtKw(x.total.upW)}${worst && worst.grid ? `; the worst is when ${worst.grid.name} is down` : ''}. The tick is the limit, ${pct(load.limit)}.`)}</p></section>` +
        `<section class="insp-sec"><h3>Outlets</h3><dl class="stats">${stat('Used', `${used} / ${outlets.length}`)}${stat('Meter groups', String((spec.meters || []).length), spec.metering === 'outlet' ? 'per outlet' : '')}</dl></section>` +
        `<div class="insp-actions is-pinned">${showButton()}<button type="button" class="btn" id="pow-pdu-map">${icon('ports')}Outlet map</button>` +
        `<button type="button" class="btn danger-text" id="pow-pdu-unplug"${used ? '' : ' disabled'}>${icon('unplug')}Unplug all</button></div>`;
      const id = pdu.id;
      bindShow({ kind: 'pdu', id });
      $('#pow-pdu-grid').addEventListener('change', (e) => {
        let err = null;
        const grid = e.target.value || null;
        ctx.commit((p2) => {
          err = P.setGrid(p2, id, grid);
          return err ? false : undefined;
        });
        if (err) toast(err, { warn: true });
      });
      $$('[data-pow-fuse]', el.inspector).forEach((b) => b.addEventListener('click', () => select({ kind: 'fuse', pdu: id, fuse: b.dataset.powFuse })));
      $('#pow-pdu-map').addEventListener('click', () => {
        followDevice(id);
        om.rack = deviceById(id).loc.rack;
        if (ui.powView === 'outlets') ctx.render();
        else setView('outlets');
      });
      $('#pow-pdu-unplug').addEventListener('click', () => unplugDevice(deviceById(id)));
    }

    function fuseInspector(pdu, name) {
      const p = project();
      const load = loads();
      const f = fuseOf(pdu, name);
      const x = load.pdus.find((r) => r.pdu.id === pdu.id);
      const v = x.phases.flatMap((ph) => ph.fuses).find((y) => y.fuse.name === name).value;
      const key = gridKey(pdu);
      const outlets = P.outletsOf(p, pdu, pctx()).filter((o) => f.outlets.includes(o.name));
      const lines = load.scenarios
        .map((s) => `<tr${s.id === v.worst && v.worstW > 0 ? ' class="is-worst"' : ''}><td>${esc(s.name)}</td><td>${esc(P.fmtW(v.w[s.id] || 0))}</td><td>${esc(P.fmtA(v.a[s.id] || 0))}</td></tr>`)
        .join('');
      const meters = [...new Set(outlets.map((o) => o.meter).filter(Boolean))];
      const spec = pduSpec(pdu);
      el.inspector.innerHTML =
        `<div class="insp-head"><div class="kicker">${swatch(gridColor(key))}Fuse group · ${esc(gridName(key))}</div>` +
        `<div class="name-input name-static">${esc(f.name)}</div>` +
        `<div class="insp-where">${esc(`${pdu.name} · ${f.ratingA} A · ${f.phase} · outlets ${outletRange(f.outlets)}`)}</div></div>` +
        `<section class="insp-sec" id="pow-fuse-load"><h3>Load</h3>` +
        `<table class="type-table pw-scen"><thead><tr><th>Scenario</th><th>W</th><th>A</th></tr></thead><tbody>${lines}</tbody></table>` +
        meter('At worst', v.worstA, f.ratingA, `${pct(v.use)} of ${f.ratingA} A`, v.over) +
        `<p class="sec-hint">${esc(`The limit is ${pct(load.limit)}: ${P.fmtA(f.ratingA * load.limit)}.`)}</p></section>` +
        `<section class="insp-sec"><h3>Outlets</h3><ul class="port-list">` +
        outlets
          .map((o) => {
            const main = `<span class="pl-port"><b>${esc(o.name)}</b><small>${esc(conn(o.connector))}</small></span>`;
            if (!o.cord) return `<li class="pl-row is-free"><span class="pl-jack"></span>${main}<span class="pl-free">free</span><span class="pl-flag"></span></li>`;
            return (
              `<li class="pl-row"><span class="pl-jack" style="--c:${describe(o.cord).color}"></span>${main}` +
              `<button type="button" class="pl-peer" data-pow-cord="${esc(o.cord.id)}"><b>${esc(`${o.device ? o.device.name : '?'} · ${o.inlet}`)}</b>` +
              `<small>${esc(`${o.cord.label || 'cord'} · ${P.fmtW(P.cordW(load, o.cord.id, UP))}`)}</small></button><span class="pl-flag"></span></li>`
            );
          })
          .join('') +
        `</ul></section>` +
        (meters.length
          ? `<section class="insp-sec"><h3>Meter group</h3>` +
            meters.map((m) => `<p class="insp-note"><span class="mono">${esc(`${m.name} · outlets ${outletRange(m.outlets)}`)}</span></p>`).join('') +
            `<p class="sec-hint">${spec.metering === 'outlet' ? 'The PDU reports a value per outlet.' : 'The PDU reports the outlets of a meter group as one value.'}</p></section>`
          : '') +
        `<div class="insp-actions is-pinned">${showButton()}<button type="button" class="btn" id="pow-fuse-pdu">${esc(pdu.name)}</button></div>`;
      bindShow({ kind: 'fuse', pdu: pdu.id, fuse: name });
      $$('[data-pow-cord]', el.inspector).forEach((b) => b.addEventListener('click', () => selectCords([b.dataset.powCord])));
      $('#pow-fuse-pdu').addEventListener('click', () => select({ kind: 'pdu', id: pdu.id }));
    }

    /** Commits a change of a cord; a refused one is told, and the inspector shows the cord as it is. */
    function changeCord(id, changes, opts) {
      let err = null;
      ctx.commit((p) => {
        err = P.updateCord(p, id, changes);
        return err ? false : undefined;
      }, opts);
      if (err) {
        toast(err, { warn: true });
        ctx.renderInspector();
      }
      return err;
    }

    function cordInspector(cord) {
      const p = project();
      const r = describe(cord);
      const load = loads();
      const key = gridKey(r.pdu);
      const fits = r.inlet && r.outlet ? new Set(P.fittingTypes(p, r.outlet.connector, r.inlet.connector).map((t) => t.id)) : new Set();
      const auto = r.typeAuto && r.type ? `Auto: ${r.type.name}` : 'Auto';
      const typeOptions =
        `<option value=""${cord.type ? '' : ' selected'}>${esc(auto)}</option>` +
        (p.cordTypes || []).map((t) => `<option value="${esc(t.id)}"${cord.type === t.id ? ' selected' : ''}>${esc(t.name)}${fits.has(t.id) ? '' : ' (does not fit)'}</option>`).join('');
      const est = r.lengthAuto && r.lengthM !== null ? P.fmtM(r.lengthM) : '';
      const groups = [r.fuse && r.fuse.name, r.fuse && r.fuse.phase, r.meter && r.meter.name].filter(Boolean).join(' · ');
      const sub = [r.type ? r.type.name : 'no cord type', r.lengthM === null ? 'no length' : `${P.fmtM(r.lengthM)}${r.lengthAuto ? ' (est.)' : ''}`];
      const end = (tag, d, text, small) =>
        `<li class="end-item"><span class="end-tag">${tag}</span><span class="end-main"><button type="button" class="end-dev" data-pow-device="${esc(d ? d.id : '')}"><b>${esc(d ? d.name : '?')}</b><span>${esc(text)}</span></button>` +
        `<small>${esc(small)}</small></span><span></span></li>`;
      el.inspector.innerHTML =
        `<div class="insp-head"><div class="kicker">${swatch(r.color)}Power cord · ${esc(gridName(key))}</div>` +
        `<label for="pow-label" class="sr-only">Cord label</label>` +
        `<input id="pow-label" class="name-input" type="text" value="${esc(cord.label)}" spellcheck="false" autocomplete="off" maxlength="40">` +
        `<div class="insp-where">${esc(`${r.device ? r.device.name : '?'} ${cord.inlet.inlet} → ${r.pdu ? r.pdu.name : '?'} · ${cord.outlet.outlet}`)}</div>` +
        `<div class="insp-sub">${esc(sub.join(' · '))}</div></div>` +
        `<section class="insp-sec"><h3>Ends</h3><ul class="end-list">` +
        end('Inlet', r.device, ` · ${cord.inlet.inlet}${r.inlet ? ` · ${conn(r.inlet.connector)}` : ''}`, r.device ? where(r.device) : '') +
        end('Outlet', r.pdu, ` · ${cord.outlet.outlet}${r.outlet ? ` · ${conn(r.outlet.connector)}` : ''}`, groups || 'no fuse group') +
        `</ul></section>` +
        `<section class="insp-sec"><h3>Cord</h3><div class="field-grid">` +
        `<div class="field span2"><label for="pow-type">Cord type</label><select id="pow-type">${typeOptions}</select></div>` +
        `<div class="field"><label for="pow-length">Length (m)</label><input id="pow-length" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${cord.lengthM == null ? '' : cord.lengthM}" placeholder="${esc(est ? `${est} (est.)` : 'estimated')}"></div>` +
        `<div class="field"><label for="pow-color">Color</label><span class="pw-color"><select id="pow-color"><option value=""${cord.color ? '' : ' selected'}>${esc(`As ${gridName(key)}`)}</option><option value="own"${cord.color ? ' selected' : ''}>Its own</option></select>` +
        `<input type="color" id="pow-color-own" aria-label="The cord’s own color" value="${esc(M.normalizeHex(cord.color) || r.color)}"${cord.color ? '' : ' hidden'}></span></div>` +
        `<div class="field span2"><label for="pow-notes">Notes</label><textarea id="pow-notes" rows="2" maxlength="500">${esc(cord.notes || '')}</textarea></div></div>` +
        `<p class="sec-hint">${esc(`Needs ${r.neededM === null ? '–' : P.fmtM(r.neededM)}. The color follows the grid unless set.`)}</p></section>` +
        `<section class="insp-sec"><h3>Draw</h3><dl class="stats">${stat('All grids up', P.fmtW(P.cordW(load, cord.id, UP)))}${stat('One grid down', P.fmtW(P.cordDownW(load, cord.id)))}</dl></section>` +
        `<section class="insp-sec" id="pow-cord-checks"><h3>Checks</h3><ul class="check-list">` +
        (r.issues.length ? r.issues.map((x) => `<li>${issueIcon('warn')}<span><b>${esc(x.title)}</b><br>${esc(x.text)}</span></li>`).join('') : `<li>${icon('check', 'ic-sm is-ok')}<span>No problems</span></li>`) +
        `</ul></section>` +
        `<div class="insp-actions is-pinned">${showButton()}<button type="button" class="btn danger-text" id="pow-unplug" title="Unplug (Del)">${icon('unplug')}Unplug</button></div>`;
      const id = cord.id;
      bindShow({ kind: 'cords', ids: [id] });
      const label = $('#pow-label');
      label.addEventListener('input', () => changeCord(id, { label: label.value }, { key: `cord-label:${id}`, inspector: false }));
      label.addEventListener('change', () => {
        // An empty label continues the series.
        const cur = cordById(id);
        if (cur && !label.value.trim()) label.value = cur.label;
      });
      $('#pow-type').addEventListener('change', (e) => changeCord(id, { type: e.target.value || null }));
      const len = $('#pow-length');
      len.addEventListener('change', () => {
        const v = len.value.trim().replace(',', '.').replace(/\s*m$/i, '');
        if (v === '') return changeCord(id, { lengthM: null });
        const m = Number(v);
        if (!Number.isFinite(m) || m <= 0) {
          toast(`${len.value} is no length: type it in metres, like 1.5`, { warn: true });
          return ctx.renderInspector();
        }
        changeCord(id, { lengthM: M.clampNum(m, 0.1, 100, null) });
      });
      $('#pow-color').addEventListener('change', (e) => changeCord(id, { color: e.target.value ? $('#pow-color-own').value : null }));
      $('#pow-color-own').addEventListener('change', (e) => changeCord(id, { color: e.target.value }));
      const notes = $('#pow-notes');
      notes.addEventListener('input', () => changeCord(id, { notes: notes.value }, { key: `cord-notes:${id}`, inspector: false }));
      $$('[data-pow-device]', el.inspector).forEach((b) => b.addEventListener('click', () => selectDevice(b.dataset.powDevice)));
      $('#pow-unplug').addEventListener('click', () => deleteCords([id]));
    }

    function cordsInspector(list) {
      const p = project();
      const load = loads();
      const sorted = P.sortCords(p, list, pctx());
      const rows = sorted
        .slice(0, 200)
        .map((c) => {
          const r = describe(c);
          return (
            `<li><button type="button" data-pow-cord="${esc(c.id)}" title="${esc(`${r.device ? r.device.name : '?'} ${c.inlet.inlet} → ${r.pdu ? r.pdu.name : '?'} · ${c.outlet.outlet}`)}">` +
            `<span class="u">${esc(c.label || '–')}</span><span class="sw" style="--c:${r.color}"></span><span class="nm">${esc(`${r.device ? r.device.name : '?'} ${c.inlet.inlet}`)}</span></button></li>`
          );
        })
        .join('');
      const up = list.reduce((a, c) => a + P.cordW(load, c.id, UP), 0);
      el.inspector.innerHTML =
        `<div class="insp-head"><div class="kicker">${icon('select', 'ic-sm')}Selection</div><div class="multi-title">${plural(list.length, 'power cord')}</div>` +
        `<div class="insp-sub">${esc(`${P.fmtW(up)} with all grids up`)}</div></div>` +
        `<section class="insp-sec"><h3>Cords</h3><ol class="contents" style="--u-w:${Math.max(0, ...sorted.map((c) => (c.label || '–').length))}ch">${rows}</ol>` +
        (sorted.length > 200 ? `<p class="sec-hint">and ${sorted.length - 200} more</p>` : '') +
        `</section>` +
        `<div class="insp-actions is-pinned"><button type="button" class="btn" id="pow-cords-clear">Clear selection</button>` +
        `<button type="button" class="btn danger-text" id="pow-cords-unplug">${icon('unplug')}Unplug ${list.length}</button></div>`;
      $$('[data-pow-cord]', el.inspector).forEach((b) => b.addEventListener('click', () => selectCords([b.dataset.powCord])));
      $('#pow-cords-clear').addEventListener('click', clearSelection);
      $('#pow-cords-unplug').addEventListener('click', () => deleteCords(list.map((c) => c.id)));
    }

    // ------------------------------------------------------------ keyboard, search

    /** Keys of the Power workspace; true when the key is dealt with (app.js then leaves it). */
    function onKeyDown(e, k) {
      const t = e.target;
      const rowBox = t && t.closest && t.closest('#ps-table input[type="checkbox"]');
      if (k.formControl && !rowBox) return false;
      const key = k.key;
      if (key === 'Escape' && cancelPress()) {
        e.preventDefault();
        return true;
      }
      if ((key === 'Delete' || key === 'Backspace') && !k.mod) {
        const ids = selCordIds();
        if (!ids.length) return false;
        e.preventDefault();
        deleteCords(ids);
        return true;
      }
      if (k.mod && k.letter === 'a' && !e.altKey) {
        e.preventDefault();
        if (ui.powView === 'schedule') selectCords(sched.visible.slice());
        else selectCords(P.cordsWithin(project(), scopeRacks('row'), pctx()).map((c) => c.id));
        return true;
      }
      const activates = key === 'Enter' && !!(t && t.closest && t.closest('button, a[href], summary, [role="button"]'));
      if ((key === 'Enter' || key === 'F2') && !k.mod && !rowBox && selCordIds().length === 1) {
        if (activates) return false;
        e.preventDefault();
        const input = $('#pow-label');
        if (input) {
          input.focus();
          input.select();
        }
        return true;
      }
      // The Racks workspace's keys for its own selection do nothing here.
      if (key.startsWith('Arrow') && !k.mod) return !rowBox;
      if (k.mod && k.letter === 'd') {
        e.preventDefault();
        return true;
      }
      return !k.mod && !e.altKey && (k.letter === 'm' || k.letter === 'b');
    }

    /** Cords that the search matches (label, notes, device, inlet, PDU, outlet, grid, cord type): { items, count }. */
    function searchCords(query, limit) {
      const out = { items: [], count: 0 };
      const match = P.cordMatcher(project(), query, pctx());
      if (!match) return out;
      for (const c of project().powerCords || []) {
        if (!match(c)) continue;
        out.count++;
        if (out.items.length < limit) out.items.push({ kind: 'cord', id: c.id, name: c.label || '–', detail: `${endText(c.inlet)} → ${endText(c.outlet)}` });
      }
      return out;
    }

    /** A search result chosen in Power: cords, devices and PDUs are selected here, places shown. */
    function chooseResult(it) {
      const p = project();
      if (it.kind === 'cord' || it.kind === 'device') {
        const sel = it.kind === 'cord' ? { kind: 'cords', ids: [it.id] } : selOf(it.id);
        const dev = deviceById(it.kind === 'cord' ? (cordById(it.id) || { inlet: {} }).inlet.device : it.id);
        if (!dev) return;
        if (ui.powView === 'elevation') return showInElevation(sel);
        followDevice(dev.id);
        if (ui.powView === 'outlets') om.rack = dev.loc.rack;
        if (it.kind === 'cord' && ui.powView === 'schedule') {
          sched.filter = '';
          const f = $('#ps-filter');
          if (f) f.value = '';
          sched.collapsed.clear();
        }
        select(sel);
        const tr = it.kind === 'cord' && host.querySelector(`tr[data-cord="${CSS.escape(it.id)}"]`);
        if (tr) tr.scrollIntoView({ block: 'nearest' });
      } else if (it.kind === 'rack') {
        const pos = M.locateRack(p, it.id);
        if (!pos) return;
        om.rack = it.id;
        ctx.setRow(pos.row.id);
      } else if (it.kind === 'row') ctx.setRow(it.id);
      else if (it.kind === 'floor') {
        const floor = M.floorById(p, it.id);
        if (floor) ctx.setRow(floor.rows[0].id);
      }
    }

    // ------------------------------------------------------------ export

    /** The drawing PNG and SVG give from Power: the row from the rear, with its cords and the grids named, whatever view is shown. */
    function exportDrawing() {
      return {
        svg: PR.exportSVG(project(), { rowId: ctx.currentRow().row.id, side: 'rear', measure: ctx.measure, view: ctx.view(), hiddenGrids: [...ui.hiddenGrids] }),
        file: `${ctx.fileBase(true)}-power-rear`.slice(0, 120),
      };
    }
    const drawingName = () => 'This row’s power cabling from the rear';
    /**
     * Exports a CSV of what a view shows: the cord schedule ('cords') or
     * the order list ('order') of the schedule's scope, the load ('load')
     * of the Load view's, or the outlet plan ('outlets') of the rack of the
     * outlet map. The file is named after the plan and the row, floor or
     * rack.
     */
    function exportCSV(what) {
      const p = project();
      const pos = ctx.currentRow();
      const scope = prefs.powScope;
      const file = scope === 'plan' ? ctx.fileBase() : scope === 'floor' ? `${ctx.fileBase()}-${M.slug(pos.floor.name)}`.slice(0, 100) : ctx.fileBase(true);
      try {
        let name;
        let text;
        if (what === 'outlets') {
          const rack = omRack();
          name = `${ctx.fileBase(true)}-${M.slug(rack.name)}`.slice(0, 110) + '-pdu-outlets.csv';
          text = IO.exportOutletsCSV(p, new Set([rack.id]));
        } else if (what === 'load') {
          name = `${file}-power-load.csv`;
          text = IO.exportLoadCSV(p, scopeRacks(scope));
        } else {
          const cords = P.cordsWithin(p, scopeRacks(scope), pctx());
          name = `${file}-${what === 'order' ? 'cord-order' : 'power-cords'}.csv`;
          text = what === 'order' ? IO.exportCordOrderCSV(p, cords) : IO.exportCordsCSV(p, cords);
        }
        ctx.download(name, new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }));
        toast(`Exported ${name}`);
      } catch (err) {
        toast(`Export failed: ${err.message}`, { warn: true });
      }
    }

    /** Adds the cords of a power cord schedule CSV to the plan. Returns an error message for the Open dialog, or null. */
    function importCordsText(text) {
      let result = null;
      try {
        ctx.commit((p) => {
          result = IO.importCordsCSV(p, text);
          return result.added ? undefined : false;
        });
      } catch (err) {
        return err.message;
      }
      $('#dlg-open').close('ok');
      const sub = `${plural(result.warnings.length, 'line')} or detail${result.warnings.length === 1 ? '' : 's'} needed attention:`;
      if (!result.added) {
        toast('The CSV added no power cords', { warn: true });
        ctx.reportWarnings('No power cords added', sub, result.warnings);
        return null;
      }
      if (ui.workspace !== 'power') ctx.setWorkspace('power');
      toast(`Added ${plural(result.added, 'power cord')} from the CSV`, { action: 'Undo', onAction: ctx.undo });
      ctx.reportWarnings(`Added ${plural(result.added, 'power cord')}`, sub, result.warnings);
      return null;
    }

    /** Opens the workspace's view of a device or a PDU: for the Racks inspector's "Open in Power". */
    function showDevice(id) {
      const d = deviceById(id);
      if (!d) return;
      ui.powSel = selOf(id);
      if (ui.powView === 'outlets') om.rack = d.loc.rack;
    }

    return {
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
      cancelPress,
      hasSelection,
      clearSelection,
      clearFocus: () => false,
      onKeyDown,
      searchCords,
      chooseResult,
      exportDrawing,
      drawingName,
      importCordsText,
      hiddenGridIds: () => [...ui.hiddenGrids],
      afterFit: () => {},
      fitStage,
      keepElevation,
      elevationAgain,
      showDevice,
      revealSelection,
    };
  }

  window.RP.powerUI = { create };
})();
