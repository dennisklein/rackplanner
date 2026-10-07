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
   * setWorkspace(ws); keepFocus(container, fn); esc, icon, plural.
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
      pending: null, // the first port of a connection being made: { device, port }
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
        cache.typeCounts = null;
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
      const pd = ui.pending && deviceById(ui.pending.device);
      if (ui.pending && (!pd || !portsOf(pd).has(ui.pending.port) || cableIndex().has(`${pd.id}|${ui.pending.port}`))) ui.pending = null;
      if (sched.anchor && !cableById(sched.anchor.id)) sched.anchor = null;
      for (const k of sched.hidden) if (k !== NONE && !netOf(k)) sched.hidden.delete(k);
    }

    /** Forgets the state of the plan that was open: for another plan, or a plan replaced whole. */
    function reset() {
      Object.assign(ui, { cabSel: null, focusNetwork: null, hoverNetwork: null, cabType: 'auto', pending: null });
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

    /** Cancels a connection being made; true when there was one. */
    function cancelPending() {
      if (!ui.pending) return false;
      ui.pending = null;
      ctx.render({ inspector: false });
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
      ctx.render(selCableIds().length > 1 ? {} : { inspector: false });
    }

    // ------------------------------------------------------------ views

    function placeholder(id, label, iconId) {
      return {
        id,
        kind: 'html',
        render(box) {
          if (box.dataset.view === id) return;
          box.dataset.view = id;
          box.innerHTML =
            `<div class="cab-empty">${icon(iconId)}<h2>${esc(label)}</h2>` +
            `<p>This view is not drawn yet. The schedule lists every cable with its ends, type, length and checks.</p>` +
            `<button type="button" class="btn" data-cab-view="schedule">${icon('table')}Open the schedule</button></div>`;
        },
      };
    }

    /** The views of the stage by id: `kind` 'svg' draws into el.svg (zoom and pan apply), 'html' into the host next to it. */
    const VIEWS = {
      elevation: placeholder('elevation', 'Elevation', 'rack'),
      ports: placeholder('ports', 'Port map', 'ports'),
      schedule: { id: 'schedule', kind: 'html', render: renderSchedule },
      fabric: placeholder('fabric', 'Fabric', 'fabric'),
    };
    if (!VIEWS[prefs.cabView]) prefs.cabView = 'schedule';
    ui.cabView = prefs.cabView;
    const view = () => VIEWS[ui.cabView] || VIEWS.schedule;
    /** Whether the stage shows a drawing that zooms (an svg view). */
    const zoomable = () => view().kind === 'svg';

    function setView(id) {
      if (!VIEWS[id] || id === ui.cabView) return;
      ui.cabView = id;
      prefs.cabView = id;
      ctx.savePrefs();
      ui.pending = null;
      ctx.render();
    }
    $('#cab-toggle').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cab-view]');
      if (b) setView(b.dataset.cabView);
    });

    function renderStage() {
      if (typing.hold) return;
      const v = view();
      el.floormap.hidden = true;
      el.canvas.classList.remove('is-map');
      if (v.kind === 'svg') {
        host.hidden = true;
        delete el.canvas.dataset.cab;
        el.svg.removeAttribute('hidden');
        el.zoom.hidden = false;
        v.render();
      } else {
        el.svg.setAttribute('hidden', '');
        el.zoom.hidden = true;
        host.hidden = false;
        el.canvas.dataset.cab = v.id;
        v.render(host);
      }
    }
    /** Back to the Racks workspace: the host goes, the drawing comes back. */
    function hideStage() {
      host.hidden = true;
      delete el.canvas.dataset.cab;
    }

    function renderNav() {
      $('.view-toggle').hidden = true;
      $('#cab-toggle').hidden = false;
      for (const b of $$('#cab-toggle [data-cab-view]')) b.setAttribute('aria-pressed', String(b.dataset.cabView === ui.cabView));
    }

    function renderChrome() {
      el.notice.hidden = true;
      if (ui.pending) {
        const d = deviceById(ui.pending.device);
        const t = ui.cabType === 'auto' ? null : M.cableTypeById(project(), ui.cabType);
        el.armedHint.innerHTML =
          `<span>Click a second port to connect <strong>${esc(`${d.name} ${ui.pending.port}`)}</strong>${t ? ` with ${esc(t.name)}` : ''}</span><kbd>Esc</kbd>` +
          `<button type="button" data-cab-cancel aria-label="Stop connecting">${icon('x', 'ic-sm')}</button>`;
      }
      el.armedHint.hidden = !ui.pending;
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
        `<div class="sc-tools"><div class="fm-title"><h2 id="sc-title"></h2><p id="sc-sub"></p></div><span class="spacer"></span>` +
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
        `<th>Label</th><th>From</th><th>Position</th><th class="sc-arrow" aria-label="to"></th><th>To</th><th>Position</th>` +
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
      const end = (e) => (e && e.device ? `<div>${devButton(e.device)} ${esc(e.end.port)}</div>` : '<div>–</div>');
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

    /** How many cables are of each type, named or picked. */
    function typeCounts() {
      const k = fresh();
      if (!k.typeCounts) {
        k.typeCounts = new Map();
        for (const c of project().cables) {
          const t = describe(c).type;
          if (t) k.typeCounts.set(t.id, (k.typeCounts.get(t.id) || 0) + 1);
        }
      }
      return k.typeCounts;
    }

    let binHTML = { types: null, nets: null };
    function renderBin() {
      if (typing.hold) return;
      const p = project();
      $('#racks-parts-sec').hidden = true;
      $('#racks-clusters-sec').hidden = true;
      $('#cab-types-sec').hidden = false;
      $('#cab-nets-sec').hidden = false;
      $('#bin').setAttribute('aria-label', 'Cables and networks');
      const counts = typeCounts();
      const card = (id, name, spec, art, n, title) => {
        const on = ui.cabType === id;
        return (
          `<button type="button" class="cab-card${on ? ' is-armed' : ''}" role="radio" aria-checked="${on}" data-cab-type="${esc(id)}" title="${esc(title)}">` +
          `<span class="part-art">${art}</span><span class="part-meta"><span class="part-name">${esc(name)}</span><span class="part-spec">${esc(spec)}</span></span>` +
          (n === null ? '' : `<span class="part-count${n ? '' : ' is-zero'}" title="${n} in the plan">${n}</span>`) +
          `</button>`
        );
      };
      const types =
        card('auto', 'Auto', 'by connectors and length', cableArt(null), null, 'New cables get the first cable type that fits both ports and reaches') +
        p.cableTypes.map((t) => card(t.id, t.name, typeSpec(t), cableArt(t), counts.get(t.id) || 0, `New cables are ${t.name}`)).join('');
      const typesKey = ui.theme + types;
      if (binHTML.types !== typesKey) {
        ctx.keepFocus($('#cab-types'), () => ($('#cab-types').innerHTML = types));
        binHTML.types = typesKey;
      }

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
      ui.cabType = card.dataset.cabType;
      ctx.render({ inspector: false });
    });
    // Arrow keys move between the cable types like a radio group.
    $('#cab-types').addEventListener('keydown', (e) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const cards = $$('[data-cab-type]', $('#cab-types'));
      const i = cards.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const next = cards[(i + (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1) + cards.length) % cards.length];
      ui.cabType = next.dataset.cabType;
      ctx.render({ inspector: false });
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
        renderAfterFocus();
      }
    });
    // Hovering a network highlights its cables in the drawings; the schedule only follows a click.
    $('#networks').addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch') return;
      const rowEl = e.target.closest('.cl-row');
      const id = rowEl ? rowEl.dataset.network : null;
      if (id === ui.hoverNetwork) return;
      ui.hoverNetwork = id;
      if (zoomable()) ctx.renderStage();
    });
    $('#networks').addEventListener('pointerleave', () => {
      if (!ui.hoverNetwork) return;
      ui.hoverNetwork = null;
      if (zoomable()) ctx.renderStage();
    });
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

    /** Commits `mutate(draft)`, which returns an error message (the plan stays as it is) or nothing; returns the message. */
    function change(mutate, opts) {
      let err = null;
      ctx.commit((p) => {
        err = mutate(p) || null;
        return err ? false : undefined;
      }, opts);
      return err;
    }
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
      return JSON.stringify(ui.cabSel || null);
    }

    function renderInspector() {
      const s = ui.cabSel;
      if (s && s.kind === 'cables') {
        const list = s.ids.map(cableById).filter(Boolean);
        if (list.length === 1) cableInspector(list[0]);
        else cablesInspector(list);
      } else if (s && s.kind === 'devices') {
        if (s.ids.length === 1) deviceInspector(deviceById(s.ids[0]));
        else devicesInspector(s.ids.map(deviceById).filter(Boolean));
      } else if (s && s.kind === 'port') portInspector(deviceById(s.device), s.port);
      else overviewInspector();
    }

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

    /** Transceivers for one end of a fiber cable at a cage: Auto (the one picked) and those that fit; null where none applies. */
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
        else html += `<li class="end-item is-free"><span class="end-tag">Leg ${i + 1}</span><div class="end-main"><small>Not plugged in</small></div></li>`;
      });
      return `<section class="insp-sec"><h3>Ends</h3><ul class="end-list">${html}</ul></section>`;
    }

    /** Network, type, length and notes of a cable (and its label, when the name above is something else). */
    function cableFields(c, d, withLabel) {
      const auto = d.type && d.needM !== null ? C.stockLength(d.type, d.needM) : null;
      const need = d.needM === null ? '' : needText(d.needM).replace(/ m$/, '');
      const placeholder = d.needM === null ? 'enter the length' : auto === null ? `needs ${need} m` : `${C.fmtM(auto)} (needs ${need})`;
      return (
        `<section class="insp-sec"><h3 id="cab-net-label">Network</h3>` +
        `<div class="chips" role="radiogroup" aria-labelledby="cab-net-label">${networkRadios('cab-net', netOf(c.network) ? c.network : null)}</div></section>` +
        `<section class="insp-sec"><h3>Cable</h3><div class="field-grid">` +
        (withLabel ? `<div class="field span2"><label for="cab-label">Label</label><input id="cab-label" class="mono" type="text" value="${esc(c.label)}" maxlength="40" autocomplete="off" spellcheck="false"></div>` : '') +
        `<div class="field span2"><label for="cab-type">Cable type</label><select id="cab-type">${typeOptions(c, c.type)}</select></div>` +
        `<div class="field span2"><label for="cab-length">Length (m)</label><input id="cab-length" type="number" min="0.1" max="10000" step="0.1" inputmode="decimal" value="${c.lengthM === null ? '' : c.lengthM}" placeholder="${esc(placeholder)}">` +
        `<small class="field-hint">Empty: the length it needs, rounded up to a stock length.</small></div>` +
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
        `<div class="insp-actions is-pinned"><button type="button" class="btn danger-text" id="cab-del" title="Delete (Del)">${icon('trash')}Delete</button></div>`;
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
            return openNetworkDialog(null, (p, nid) => C.updateCable(p, id, { network: nid }), () => ctx.render());
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
      if (!err) toast(left ? `Unplugged leg ${i + 1} of ${c.label}` : `Deleted ${c.label}, its last leg unplugged`, { action: 'Undo', onAction: ctx.undo });
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
      ctx.commit((p) => void C.disconnect(p, list.map((c) => c.id)));
      toast(`Deleted ${list.length === 1 ? list[0].label || 'a cable' : plural(list.length, 'cable')}`, { action: 'Undo', onAction: ctx.undo });
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
        `<section class="insp-sec"><h3>Cables</h3><ol class="contents">${rows}</ol>${list.length > 200 ? `<p class="sec-hint">and ${list.length - 200} more</p>` : ''}</section>` +
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
          if (r.value === '__new') return openNetworkDialog(null, apply, () => ctx.render());
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
        if (!err) toast(`Labeled ${labels[0]} … ${labels[labels.length - 1]}`, { action: 'Undo', onAction: ctx.undo });
      });
      $('#multi-clear').addEventListener('click', clearSelection);
      $('#multi-del').addEventListener('click', () => deleteCables(ids));
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
          ? `<ul class="port-list">${shown.map((pt) => portRow(d, pt, idx)).join('')}</ul>${ports.length > shown.length ? `<p class="sec-hint">and ${ports.length - shown.length} more ports</p>` : ''}`
          : `<p class="empty-note">${esc(type.label)} has no ports. Give its type ports in the catalog.</p>`) +
        `</section>` +
        `<div class="insp-actions is-pinned"><button type="button" class="btn" id="cab-dev-series"${ports.length ? '' : ' disabled'}>${icon('swap')}Connect series…</button>` +
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
        `<section class="insp-sec"><h3>Devices</h3><ol class="contents">${rows}</ol></section>` +
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
          `<div class="insp-actions is-pinned">${back}<button type="button" class="btn danger-text" id="cab-del" title="${hit.role === 'b' && Array.isArray(c.b) ? 'Unplug this leg of the breakout cable (Del)' : 'Unplug the cable (Del)'}">${icon('unplug')}Unplug</button></div>`;
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
        `<p class="insp-note">Select a cable in the schedule, or search for a device or a cable. Shift-click selects a range of cables.</p></div>` +
        `<section class="insp-sec"><dl class="stats"><div><dt>Cables</dt><dd>${cables.length}</dd></div><div><dt>To other rows</dt><dd>${toOther}</dd></div>` +
        `<div><dt>Networks</dt><dd>${[...nets].filter((n) => n !== NONE).length}</dd></div><div><dt>To check</dt><dd>${bad.length}</dd></div></dl></section>` +
        (bad.length ? `<section class="insp-sec"><h3>To check</h3><ul class="check-list">${issues}</ul>${bad.length > 6 ? `<p class="sec-hint">and ${bad.length - 6} more</p>` : ''}</section>` : '') +
        `<section class="insp-sec"><h3>Ports in use</h3><div class="rack-bars">${bars}</div></section>` +
        `<section class="insp-sec"><h3>Cable lengths</h3><div class="field-grid">` +
        `<div class="field"><label for="cab-pitch">Row pitch (m)</label><input id="cab-pitch" type="number" min="0.5" max="50" step="0.1" inputmode="decimal" value="${floor.rowPitchM == null ? '' : floor.rowPitchM}" placeholder="${M.DEFAULT_ROW_PITCH_M}"></div>` +
        `</div><p class="sec-hint">From one row of ${esc(floor.name)} to the next. Racks set their way up to the tray and their slack.</p></section>` +
        `<section class="insp-sec keys-sec"><h3>Shortcuts</h3><dl class="keys">` +
        `<dt><kbd>C</kbd></dt><dd>Racks or Cabling</dd>` +
        `<dt><kbd>Shift</kbd> + click</dt><dd>Select a range of cables</dd>` +
        `<dt><kbd>Ctrl</kbd> + click</dt><dd>Add or remove a cable</dd>` +
        `<dt><kbd>Ctrl</kbd> <kbd>A</kbd></dt><dd>Select the cables shown</dd>` +
        `<dt><kbd>Del</kbd></dt><dd>Delete the selected cables</dd>` +
        `<dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous, next row</dd>` +
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
    /** A device to connect to: a switch of the same row with a free port of the family, else any such device. */
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
      const armed = ui.cabType !== 'auto' ? ui.cabType : '';
      $('#cs-type').innerHTML =
        `<option value="">Auto: by connectors and length</option>` +
        p.cableTypes.map((t) => `<option value="${esc(t.id)}"${t.id === armed ? ' selected' : ''}>${esc(t.name)}${t.legs > 1 ? ` (head on the right, ${t.legs} devices per port)` : ''}</option>`).join('');
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
    function fillToPorts(preset) {
      const d = deviceById($('#cs-to').value);
      const sel = $('#cs-to-port');
      sel.innerHTML = d ? portOptions(d, null, !cs.series) : '';
      if (!d) return;
      const fromDev = deviceById($('#cs-from').value);
      const like = fromDev ? portsOf(fromDev).get($('#cs-from-port').value) : null;
      const pt = preset && portsOf(d).has(preset) ? portsOf(d).get(preset) : firstFreePort(d, like);
      if (pt) sel.value = pt.name;
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
      $('#cs-summary').textContent = cs.items.length
        ? [plural(ok, 'cable')].concat([...sum].map(([key, n]) => `${key} × ${n}`), refused ? [`${refused} left out`] : []).join(' · ')
        : '';
      const submit = $('#cs-submit');
      submit.disabled = !ok;
      submit.textContent = ok > 1 ? `Connect ${ok} cables` : ok ? 'Connect 1 cable' : 'Connect';
      const first = deviceById($('#cs-from').value);
      $('#connect-title').textContent = cs.series
        ? `${plural(o.from.length, 'device')} from ${first ? where(first).pos.rack.name : 'this row'}`
        : ok
          ? `${cs.items[0].label}: ${cs.items[0].info}`
          : 'Connect two ports';
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
      if (t.id === 'cs-from' || t.id === 'cs-from-port') fillToPorts($('#cs-to-port').value);
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
      dlg.close('ok');
      if (!added.length) return toast('Nothing was connected', { warn: true });
      rememberNetwork(items[0].network);
      selectCables(added.map((c) => c.id), { reveal: true });
      const names = added.length === 1 ? added[0].label : `${plural(added.length, 'cable')}, ${added[0].label} … ${added[added.length - 1].label}`;
      toast(`Connected ${names}`, { action: 'Undo', onAction: ctx.undo });
    });

    // ------------------------------------------------------------ network dialog

    const netDlg = { id: null, color: null, onCreate: null, onCancel: null, saved: false, labelTouched: false };

    /** Opens the network dialog for network `id`, or to create one; `onCreate(draft, id)` runs in the same commit. */
    function openNetworkDialog(id, onCreate, onCancel) {
      const p = project();
      const n = id && id !== NONE ? M.networkById(p, id) : null;
      if (!n && p.networks.length >= M.LIMITS.networks) {
        toast(`A plan holds up to ${M.LIMITS.networks} networks`, { warn: true });
        if (onCancel) onCancel();
        return;
      }
      const name = n ? n.name : nextNetworkName(p);
      Object.assign(netDlg, { id: n ? n.id : null, color: n ? n.color : M.nextNetworkColor(p), onCreate: onCreate || null, onCancel: onCancel || null, saved: false, labelTouched: !!n });
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
      $('#network-label-hint').textContent = `New cables of this network continue this series: ${series.join(', ')}, …`;
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
        return true;
      }
      if ((key === 'Enter' || key === 'F2') && !k.mod && !rowBox && selCableIds().length === 1) {
        if (key === 'Enter' && t.closest && t.closest('button, a[href], summary')) return false;
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

    /** Cables whose label or ends contain every word: { items, count }. */
    function searchCables(query, limit) {
      const words = M.queryWords(query);
      const out = { items: [], count: 0 };
      if (!words.length) return out;
      for (const c of project().cables) {
        const ends = M.cableEnds(c).map((x) => endText(x.end));
        const text = [c.label].concat(ends).join(' ').toLowerCase();
        if (!words.every((w) => text.includes(w))) continue;
        out.count++;
        if (out.items.length < limit) out.items.push({ kind: 'cable', id: c.id, name: c.label || '–', detail: `${ends[0]} → ${ends.slice(1).join(', ')}` });
      }
      return out;
    }

    /** A search result chosen in Cabling: cables and devices are selected here, places shown. */
    function chooseResult(it) {
      const p = project();
      if (it.kind === 'cable') {
        const c = cableById(it.id);
        if (!c) return;
        followDevice(c.a.device);
        if (ui.cabView !== 'schedule' && !zoomable()) setView('schedule');
        sched.hidden.clear();
        sched.filter = '';
        showCable(c);
        ui.cabSel = { kind: 'cables', ids: [c.id] };
        ctx.render();
        revealCable(c.id);
      } else if (it.kind === 'device') {
        followDevice(it.id);
        ui.cabSel = { kind: 'devices', ids: [it.id] };
        ctx.render();
      } else if (it.kind === 'rack') {
        const pos = M.locateRack(p, it.id);
        if (pos) ctx.setRow(pos.row.id);
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
    };
  }

  (window.RP = window.RP || {}).cablingUI = { create };
})();
