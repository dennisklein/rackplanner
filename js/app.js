/*
 * Rackplanner: browser UI.
 *
 * Owns the editable state (the open plan + undo history), renders it through
 * RP.render, and wires up navigation between floors and rows, the floor
 * map, search, drag and drop, click-to-place, selection of one or several
 * devices, dialogs, the inspector, keyboard shortcuts, the plan library in
 * browser storage, and import, export, share links and printing.
 */
(function () {
  'use strict';

  const M = window.RP.model;
  const C = window.RP.cabling;
  const IO = window.RP.io;
  const R = window.RP.render;
  const G = R.geometry;

  const PREFS_KEY = 'rackplanner.prefs.v1';
  const HISTORY_LIMIT = 200;
  // Undo keeps whole snapshots; cap their total size for very large plans.
  const HISTORY_CHARS = 40e6;
  const COLOR_NAMES = ['Cobalt', 'Orange', 'Teal', 'Violet', 'Amber', 'Red', 'Green', 'Cyan', 'Rose', 'Indigo', 'Olive', 'Brown'];
  const SHARE_PREFIX = '#plan=';
  // What the theme button offers, and how it names each one.
  const THEME_PICKS = new Map([
    ['system', 'match system'],
    ['light', 'light'],
    ['dark', 'dark'],
  ]);

  // ------------------------------------------------------------ utilities

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = R.esc;
  const plural = M.plural;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  const icon = (id, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const fmtPower = R.formatPower;
  const fmtKg = (kg) => `${Math.round(kg).toLocaleString('en')} kg`;
  const fmtKw = (w) => `${(Math.round(w / 100) / 10).toLocaleString('en', { minimumFractionDigits: 1 })} kW`;
  /** "3.2 kW of 12.0 kW", or just "3.2 kW" without a budget. */
  const withBudget = (fmt, value, budget) => fmt(value) + (budget ? ` of ${fmt(budget)}` : '');
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const shortRack = (name) => name.replace(/^rack\s+/i, '');
  const FULL = {
    rack: `A row holds up to ${M.LIMITS.racks} racks`,
    row: `A floor holds up to ${M.LIMITS.rows} rows`,
    floor: `A plan holds up to ${M.LIMITS.floors} floors`,
  };
  /** Height of a new device of `type` while it is placed: reserved space starts at 2U. */
  const startHeight = (type) => (type.variable ? 2 : type.height);

  // Browser storage can be missing or throw (private windows, sandboxes, a full quota).
  const storage = {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
        return true;
      } catch (e) {
        return false;
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch (e) {
        /* nothing to clean up */
      }
    },
  };
  function readJSON(key) {
    const raw = storage.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  const measureCtx = document.createElement('canvas').getContext('2d');
  const measureCache = new Map();
  function measure(text, font) {
    const key = font + '|' + text;
    let w = measureCache.get(key);
    if (w === undefined) {
      measureCtx.font = font;
      w = measureCtx.measureText(text).width;
      if (measureCache.size > 5000) measureCache.clear();
      measureCache.set(key, w);
    }
    return w;
  }

  const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const todayISO = () => isoDate(new Date());

  function relTime(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return plural(Math.round(s / 3600), 'hour') + ' ago';
    return isoDate(new Date(ms));
  }

  function detectTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // ---------------------------------------------------------------- state

  const prefs = Object.assign({ zoom: null, lastCluster: null, view: 'sheet', metric: 'space', rows: {}, theme: 'system' }, readJSON(PREFS_KEY) || {});
  if (!prefs.rows || typeof prefs.rows !== 'object') prefs.rows = {};
  if (!THEME_PICKS.has(prefs.theme)) prefs.theme = 'system';
  const lib = window.RP.library.create(storage);
  let planId = null;
  let project = null;
  let projectJSON = '';
  let savedJSON = null; // projectJSON as last loaded or saved
  const history = { past: [], future: [], key: null, at: 0, chars: 0 };
  const ui = {
    selection: null, // { kind: 'devices', ids } | { kind: 'rack' | 'row' | 'floor', id }
    rowId: null, // the row shown
    view: prefs.view === 'map' ? 'map' : 'sheet',
    metric: ['space', 'power', 'weight'].includes(prefs.metric) ? prefs.metric : 'space',
    focusCluster: null, // cluster id, '__none' for unassigned, or null
    hoverCluster: null,
    query: '',
    searchOpen: false,
    searchActive: -1,
    searchItems: [],
    armed: null, // device type id while click-to-place is active
    drag: null,
    press: null,
    pan: null,
    marquee: null,
    zoom: 1,
    theme: detectTheme(),
    sceneW: 1200,
    sceneH: 1200,
    layout: null,
  };
  let lastPaletteDragEnd = -Infinity;
  let restoringFocus = false;

  function savePrefs() {
    storage.set(PREFS_KEY, JSON.stringify(prefs));
  }

  /** Makes `p`, saved as plan `id`, the open plan, with a fresh undo history. */
  function openPlan(id, p) {
    planId = id;
    project = p;
    projectJSON = JSON.stringify(project);
    savedJSON = projectJSON;
    history.past = [];
    history.future = [];
    history.chars = 0;
    history.key = null;
    ui.selection = null;
    ui.focusCluster = null;
    ui.hoverCluster = null;
    ui.armed = null;
    // Undo buttons in toasts refer to the previous plan.
    el.toasts.textContent = '';
    const remembered = prefs.rows[id];
    ui.rowId = remembered && M.rowById(project, remembered) ? remembered : M.allRows(project)[0].row.id;
    if (id) lib.setCurrent(id);
  }

  function bootPlan() {
    lib.migrate();
    let id = lib.current() || (lib.list()[0] || {}).id || null;
    let loaded = id ? lib.load(id) : null;
    if (!loaded) {
      const p = M.createExampleProject();
      id = lib.add(p);
      loaded = { project: p };
    }
    openPlan(id, loaded.project);
  }

  let persistTimer = null;
  let storageWarned = false;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(flushPersist, 300);
  }
  function flushPersist() {
    clearTimeout(persistTimer);
    persistTimer = null;
    if (!project || (planId && projectJSON === savedJSON)) return;
    let ok = false;
    if (planId) ok = lib.save(planId, project);
    else if ((planId = lib.add(project))) {
      lib.setCurrent(planId);
      ok = true;
    }
    if (ok) savedJSON = projectJSON;
    if (!ok && !storageWarned) {
      storageWarned = true;
      toast('This browser did not save the plan: its storage is full or blocked. Export the plan file to keep your work.', { warn: true });
    } else if (ok) storageWarned = false;
  }

  function pushPast(s) {
    history.past.push(s);
    history.chars += s.length;
    while (history.past.length > HISTORY_LIMIT || (history.chars > HISTORY_CHARS && history.past.length > 1)) {
      history.chars -= history.past.shift().length;
    }
  }
  function popPast() {
    const s = history.past.pop();
    history.chars -= s.length;
    return s;
  }

  /**
   * Applies `mutate` to a copy of the project and records an undo step.
   * Edits sharing `opts.key` within two seconds (typing) share one step.
   */
  function commit(mutate, opts) {
    const o = opts || {};
    const draft = JSON.parse(projectJSON);
    if (mutate(draft) === false) return false;
    const after = JSON.stringify(draft);
    if (after === projectJSON) return false;
    const now = Date.now();
    const coalesce = o.key && history.key === o.key && now - history.at < 2000;
    if (!coalesce) pushPast(projectJSON);
    history.key = o.key || null;
    history.at = now;
    history.future.length = 0;
    project = draft;
    projectJSON = after;
    persist();
    render(o);
    return true;
  }

  /** Commits `make(draft)`, which returns what it added, or null to leave the plan as it is. */
  function commitAdd(make) {
    let made = null;
    commit((p) => {
      made = make(p);
      return made ? undefined : false;
    });
    return made;
  }

  /** Commits `change(draft)`, which returns an error message and leaves the plan as it is, or null. */
  function commitOrError(change) {
    let err = null;
    commit((p) => {
      err = change(p);
      return err ? false : undefined;
    });
    return err;
  }

  function restore(json) {
    projectJSON = json;
    project = JSON.parse(json);
    history.key = null;
    persist();
    render();
    // Text refused for the plan as it was belongs to no field of this one.
    cat.keep = null;
    cat.error = '';
    if ($('#dlg-catalog').open) renderCatalog();
  }
  function undo() {
    if (!history.past.length) return;
    history.future.push(projectJSON);
    restore(popPast());
  }
  function redo() {
    if (!history.future.length) return;
    pushPast(projectJSON);
    restore(history.future.pop());
  }

  // ------------------------------------------------------------- elements

  const el = {
    svg: $('#scene'),
    canvas: $('#canvas'),
    stage: $('#stage'),
    floormap: $('#floormap'),
    parts: $('#parts'),
    clusters: $('#clusters'),
    clustersHint: $('#clusters-hint'),
    inspector: $('#inspector'),
    planName: $('#plan-name'),
    undo: $('#btn-undo'),
    redo: $('#btn-redo'),
    zoom: $('#zoom'),
    zoomLevel: $('#btn-zoom-reset'),
    floorTabs: $('#floor-tabs'),
    rowLabel: $('#row-label'),
    rowPrev: $('#btn-row-prev'),
    rowNext: $('#btn-row-next'),
    rowMenu: $('#menu-row'),
    search: $('#search'),
    searchResults: $('#search-results'),
    notice: $('#example-notice'),
    armedHint: $('#armed-hint'),
    chip: $('#drag-chip'),
    toasts: $('#toasts'),
    fileInput: $('#file-input'),
    printRoot: $('#print-root'),
  };

  // ------------------------------------------------------------ selection

  function selIds() {
    const s = ui.selection;
    return s && s.kind === 'devices' ? s.ids : [];
  }
  function selSet() {
    return new Set(selIds());
  }
  function selectedDevice() {
    const ids = selIds();
    return ids.length === 1 ? M.deviceById(project, ids[0]) : null;
  }
  function rowOfRack(rackId) {
    const pos = M.locateRack(project, rackId);
    return pos ? pos.row.id : null;
  }
  function currentRow() {
    return M.locateRow(project, ui.rowId) || M.allRows(project)[0];
  }

  function setRow(rowId, opts) {
    const o = opts || {};
    if (!M.rowById(project, rowId)) return;
    const changed = rowId !== ui.rowId;
    ui.rowId = rowId;
    if (o.view) ui.view = o.view;
    prefs.rows[planId] = rowId;
    prefs.rows[`${planId}:${M.locateRow(project, rowId).floor.id}`] = rowId;
    prefs.view = ui.view;
    savePrefs();
    if (o.render !== false) render();
    if (changed && !o.keepScroll) scrollToOrigin();
  }

  /**
   * Selects devices. With `follow`, the view moves to the row of the first
   * one; `focus` puts keyboard focus on it, `reveal` scrolls it into view.
   */
  function selectDevices(ids, opts) {
    const o = opts || {};
    const list = [...new Set(ids)].filter((id) => M.deviceById(project, id));
    ui.selection = list.length ? { kind: 'devices', ids: list } : null;
    if (list.length && o.follow) {
      const row = rowOfRack(M.deviceById(project, list[0]).loc.rack);
      if (row !== ui.rowId || ui.view !== 'sheet') setRow(row, { view: 'sheet', render: false });
    }
    render();
    if (list.length && (o.focus || o.reveal)) revealDevice(list[0], o.focus);
  }
  function selectDevice(id, focus) {
    selectDevices([id], { focus, reveal: focus });
  }
  function toggleDevice(id) {
    const ids = selIds();
    selectDevices(ids.includes(id) ? ids.filter((x) => x !== id) : ids.concat([id]));
  }

  function selectThing(kind, id, opts) {
    ui.selection = { kind, id };
    if (kind === 'rack') {
      const row = rowOfRack(id);
      if (row && (row !== ui.rowId || (opts && opts.sheet))) setRow(row, { view: 'sheet', render: false });
    }
    render();
    if (kind === 'rack' && opts && opts.reveal) revealRack(id);
  }

  function clearSelection() {
    if (!ui.selection) return;
    ui.selection = null;
    render();
  }

  // ------------------------------------------------------------ rendering

  function render(opts) {
    const o = opts || {};
    pruneUiState();
    renderNav();
    renderStage();
    renderParts();
    renderClusters();
    if (o.inspector !== false) renderInspector();
    renderChrome();
    if (ui.searchOpen) renderSearchResults();
  }

  function pruneUiState() {
    if (!M.rowById(project, ui.rowId)) ui.rowId = M.allRows(project)[0].row.id;
    const s = ui.selection;
    if (s && s.kind === 'devices') {
      const ids = s.ids.filter((id) => M.deviceById(project, id));
      ui.selection = ids.length ? { kind: 'devices', ids } : null;
    } else if (s && s.kind === 'rack' && !M.rackById(project, s.id)) ui.selection = null;
    else if (s && s.kind === 'row' && !M.rowById(project, s.id)) ui.selection = null;
    else if (s && s.kind === 'floor' && !M.floorById(project, s.id)) ui.selection = null;
    const valid = (c) => !c || (c === '__none' ? project.devices.some((d) => !d.cluster) : !!M.clusterById(project, c));
    if (!valid(ui.focusCluster)) ui.focusCluster = null;
    if (!valid(ui.hoverCluster)) ui.hoverCluster = null;
    if (ui.armed && !M.typeOf(project, ui.armed)) ui.armed = null;
  }

  function findDevEl(id) {
    return el.svg.querySelector(`.dev[data-id="${CSS.escape(id)}"]`);
  }
  /** Scrolls a device into view; `focus` also gives it keyboard focus. */
  function revealDevice(id, focus) {
    const g = findDevEl(id);
    if (!g) return;
    if (focus) g.focus({ preventScroll: true });
    ensureVisible(g);
  }
  function revealRack(id) {
    const head = el.svg.querySelector(`.rack-head[data-rack="${CSS.escape(id)}"]`);
    if (head) ensureVisible(head);
  }
  /** Replaces the previews drawn over the sheet (placement ghosts, the selection rectangle). */
  function setGhosts(html) {
    const layer = el.svg.querySelector('#ghost-layer');
    if (layer) layer.innerHTML = html;
  }

  /** Devices to show at full strength: the focused cluster and search matches. */
  function highlightFn() {
    const focus = ui.hoverCluster || ui.focusCluster;
    const match = ui.query.trim() ? M.deviceMatcher(project, ui.query) : null;
    if (!focus && !match) return null;
    return (d) => (!focus || (focus === '__none' ? !d.cluster : d.cluster === focus)) && (!match || match(d));
  }

  function sheetInfo(rowId) {
    const rows = M.allRows(project);
    return { index: Math.max(0, rows.findIndex((r) => r.row.id === rowId)), count: rows.length };
  }

  /**
   * Runs `fn`, which rebuilds `container`, and puts keyboard focus back on
   * the element with the same first data attribute (a floor tab, a rack tile).
   */
  function keepFocus(container, fn) {
    const a = document.activeElement;
    let sel = null;
    if (a && a !== container && container.contains(a)) {
      const attr = [...a.attributes].find((x) => x.name.startsWith('data-'));
      if (attr) sel = `[${attr.name}="${CSS.escape(attr.value)}"]`;
    }
    fn();
    if (sel) {
      const t = container.querySelector(sel);
      if (t) t.focus({ preventScroll: true });
    }
  }

  function renderStage() {
    const map = ui.view === 'map';
    el.svg.toggleAttribute('hidden', map);
    el.floormap.hidden = !map;
    el.zoom.hidden = map;
    el.canvas.classList.toggle('is-map', map);
    if (map) keepFocus(el.floormap, renderFloorMap);
    else renderScene();
  }

  function renderScene() {
    if (ui.view === 'map') return;
    const active = document.activeElement;
    const focusedId = active && active !== el.svg && el.svg.contains(active) && active.dataset ? active.dataset.id : null;
    const sel = ui.selection;
    const d = ui.drag;
    const out = R.renderScene(project, {
      rowId: ui.rowId,
      theme: ui.theme,
      interactive: true,
      measure,
      date: todayISO(),
      sheet: sheetInfo(ui.rowId),
      selected: selSet(),
      selectedRack: sel && sel.kind === 'rack' ? sel.id : null,
      highlight: highlightFn(),
      dragging: d && d.active && d.source === 'device' && !d.copy ? new Set(d.ids) : null,
    });
    ui.layout = out.layout;
    ui.sceneW = out.width;
    ui.sceneH = out.height;
    el.svg.setAttribute('viewBox', `0 0 ${out.width} ${out.height}`);
    el.svg.setAttribute('aria-label', `Rack elevation of ${out.layout.floor.name}, ${out.layout.row.name}`);
    el.svg.innerHTML = out.body + '<g id="ghost-layer"></g>';
    applyZoom();
    // Keep keyboard focus on the redrawn device only while it stays selected;
    // otherwise restoring it would select it again.
    if (focusedId && selSet().has(focusedId)) {
      const g = findDevEl(focusedId);
      if (g) {
        restoringFocus = true;
        g.focus({ preventScroll: true });
        restoringFocus = false;
      }
    }
  }

  // Floor map ----------------------------------------------------------

  const METRICS = { space: 'Space', power: 'Power', weight: 'Weight' };

  function metricOf(st) {
    if (ui.metric === 'power') {
      return { p: st.powerBudgetW ? st.powerW / st.powerBudgetW : 0, text: fmtKw(st.powerW), over: st.overPower };
    }
    if (ui.metric === 'weight') {
      return { p: st.weightBudgetKg ? st.weightKg / st.weightBudgetKg : 0, text: fmtKg(st.weightKg), over: st.overWeight };
    }
    const occ = st.used + st.reserved;
    return { p: occ / st.units, text: `${pct(occ, st.units)}%`, over: false };
  }

  function statsLine(t) {
    const occ = t.used + t.reserved;
    let s = `${plural(t.racks, 'rack')} · ${pct(occ, t.units)}% of ${t.units} U`;
    s += ` · ${withBudget(fmtKw, t.powerW, t.powerBudgetW)}`;
    if (t.overPower || t.overWeight) s += ` · ${plural(t.overPower + t.overWeight, 'budget')} exceeded`;
    return s;
  }

  function renderFloorMap() {
    const pos = currentRow();
    const floor = pos.floor;
    const stats = M.statsByRack(project);
    const byRack = M.devicesByRack(project);
    const hl = highlightFn();
    const match = ui.query.trim() ? M.deviceMatcher(project, ui.query) : null;
    const sel = ui.selection;
    const colors = new Map(project.clusters.map((c) => [c.id, c.color]));
    const fs = M.statsWithin(project, floor.id, stats);
    let html =
      `<div class="fm-head"><div class="fm-title"><h2 title="${esc(floor.name)}">${esc(floor.name)}</h2><p>${esc(plural(floor.rows.length, 'row'))} · ${esc(statsLine(fs))}</p></div>` +
      `<div class="seg fm-metric" role="group" aria-label="Rack meters show">` +
      Object.entries(METRICS)
        .map(([k, label]) => `<button type="button" data-metric="${k}" aria-pressed="${ui.metric === k}">${label}</button>`)
        .join('') +
      `</div></div><div class="fm-rows">`;
    for (const row of floor.rows) {
      const rs = M.statsWithin(project, row.id, stats);
      html +=
        `<section class="fm-row${row.id === ui.rowId ? ' is-current' : ''}${sel && sel.kind === 'row' && sel.id === row.id ? ' is-selected' : ''}" aria-label="${esc(row.name)}">` +
        `<div class="fm-row-head"><button type="button" class="fm-row-open" data-open-row="${esc(row.id)}" title="Show the elevation of ${esc(row.name)}"><span>${esc(row.name)}</span>${icon('right', 'ic-sm')}</button>` +
        `<span class="fm-row-meta">${esc(statsLine(rs))}</span>` +
        `<button type="button" class="btn icon sm subtle" data-edit-row="${esc(row.id)}" title="Row settings" aria-label="Settings for ${esc(row.name)}">${icon('pencil')}</button></div>` +
        `<div class="fm-racks">`;
      for (const rack of row.racks) {
        const st = stats.get(rack.id);
        const devs = byRack.get(rack.id) || [];
        const hits = match ? devs.filter(match).length : 0;
        const m = metricOf(st);
        let blocks = '';
        for (const d of devs) {
          if (d.loc.kind !== 'u') continue;
          const h = M.deviceHeight(project, d);
          const res = d.type === M.RESERVED.id;
          const c = colors.get(d.cluster);
          blocks += `<i class="${res ? 'res' : ''}${hl && !hl(d) ? ' dim' : ''}" style="top:${(((d.loc.at - 1) / st.units) * 100).toFixed(2)}%;height:${((h / st.units) * 100).toFixed(2)}%${c ? `;--c:${c}` : ''}"></i>`;
        }
        const cls = ['fm-rack'];
        if (m.over) cls.push('is-over');
        if (hits) cls.push('is-hit');
        if (sel && sel.kind === 'rack' && sel.id === rack.id) cls.push('is-selected');
        const label = `${rack.name}: ${st.used + st.reserved} of ${st.units} U used, ${withBudget(fmtPower, st.powerW, st.powerBudgetW)}, ${fmtKg(st.weightKg)}${m.over ? ', over budget' : ''}${hits ? `, ${plural(hits, 'match', 'matches')}` : ''}`;
        html +=
          `<button type="button" class="${cls.join(' ')}" data-rack="${esc(rack.id)}" title="${esc(label)}" aria-label="${esc(label)}">` +
          `<span class="fm-elev" style="height:${st.units * 2}px">${blocks}</span>` +
          `<span class="fm-meter"><span style="width:${Math.min(100, m.p * 100).toFixed(1)}%"></span></span>` +
          `<span class="fm-name">${esc(shortRack(rack.name))}</span><span class="fm-val">${esc(m.text)}</span>` +
          (hits ? `<span class="fm-hits">${hits}</span>` : '') +
          `</button>`;
      }
      if (row.racks.length < M.LIMITS.racks) {
        html += `<button type="button" class="fm-add" data-add-rack="${esc(row.id)}" title="Add a rack to ${esc(row.name)}" aria-label="Add a rack to ${esc(row.name)}">${icon('plus')}</button>`;
      }
      html += `</div></section>`;
    }
    html += `</div>`;
    if (floor.rows.length < M.LIMITS.rows) html += `<button type="button" class="btn fm-add-row" data-add-row="${esc(floor.id)}">${icon('plus')}Add row to ${esc(floor.name)}</button>`;
    el.floormap.innerHTML = html;
  }

  el.floormap.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.metric) {
      ui.metric = t.dataset.metric;
      prefs.metric = ui.metric;
      savePrefs();
      renderStage();
    } else if (t.dataset.openRow) setRow(t.dataset.openRow, { view: 'sheet' });
    else if (t.dataset.editRow) selectThing('row', t.dataset.editRow);
    else if (t.dataset.rack) selectThing('rack', t.dataset.rack, { sheet: true, reveal: true });
    else if (t.dataset.addRack) addRackTo(t.dataset.addRack);
    else if (t.dataset.addRow) addRowTo(t.dataset.addRow);
  });

  // Navigation bar -----------------------------------------------------

  function renderNav() {
    keepFocus(el.floorTabs, renderFloorTabs);
    const pos = currentRow();
    el.rowLabel.textContent = pos.row.name;
    const rows = M.allRows(project);
    const i = rows.findIndex((r) => r.row === pos.row);
    el.rowPrev.disabled = i <= 0;
    el.rowNext.disabled = i >= rows.length - 1;
    for (const b of $$('.view-toggle button')) b.setAttribute('aria-pressed', String(b.dataset.view === ui.view));
  }

  function renderFloorTabs() {
    const pos = currentRow();
    const sel = ui.selection;
    el.floorTabs.innerHTML =
      project.floors
        .map((f) => {
          const on = f === pos.floor;
          const picked = sel && sel.kind === 'floor' && sel.id === f.id;
          return `<button type="button" class="ftab${picked ? ' is-selected' : ''}" data-floor="${esc(f.id)}" aria-pressed="${on}" title="${on ? `${esc(f.name)}: click for floor settings` : `Show ${esc(f.name)}`}">${esc(f.name)}</button>`;
        })
        .join('') +
      (project.floors.length < M.LIMITS.floors ? `<button type="button" class="ftab ftab-add" data-add-floor title="Add a floor" aria-label="Add a floor">${icon('plus', 'ic-sm')}</button>` : '');
  }

  function stepRow(dir) {
    const rows = M.allRows(project);
    const i = rows.findIndex((r) => r.row.id === ui.rowId) + dir;
    if (i < 0 || i >= rows.length) return;
    setRow(rows[i].row.id);
    toast(`${rows[i].floor.name} · ${rows[i].row.name}`);
  }

  el.floorTabs.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.hasAttribute('data-add-floor')) return addFloor();
    const floor = M.floorById(project, t.dataset.floor);
    if (!floor) return;
    if (floor === currentRow().floor) return selectThing('floor', floor.id);
    const remembered = floor.rows.find((r) => r.id === prefs.rows[`${planId}:${floor.id}`]);
    setRow((remembered || floor.rows[0]).id);
  });
  el.rowPrev.addEventListener('click', () => stepRow(-1));
  el.rowNext.addEventListener('click', () => stepRow(1));
  $$('.view-toggle button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  function setView(view) {
    if (view === ui.view) return;
    ui.view = view;
    prefs.view = view;
    savePrefs();
    disarm();
    render();
  }

  function renderRowMenu() {
    const pos = currentRow();
    const stats = M.statsByRack(project);
    el.rowMenu.innerHTML =
      pos.floor.rows
        .map((row) => {
          const t = M.statsWithin(project, row.id, stats);
          return (
            `<button type="button" role="menuitemradio" aria-checked="${row === pos.row}" data-row="${esc(row.id)}">` +
            `<span>${esc(row.name)}</span><small>${esc(`${plural(t.racks, 'rack')} · ${pct(t.used + t.reserved, t.units)}% used · ${fmtKw(t.powerW)}`)}</small></button>`
          );
        })
        .join('') +
      `<hr>` +
      (pos.floor.rows.length < M.LIMITS.rows ? `<button type="button" role="menuitem" data-row-action="add"><span>${icon('plus', 'ic-sm')} Add row</span><small>A new row of racks on ${esc(pos.floor.name)}</small></button>` : '') +
      `<button type="button" role="menuitem" data-row-action="settings"><span>${icon('pencil', 'ic-sm')} Row settings</span><small>Rename, reorder racks, move or delete ${esc(pos.row.name)}</small></button>`;
  }
  el.rowMenu.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    closeMenus();
    if (t.dataset.row) setRow(t.dataset.row, { view: 'sheet' });
    else if (t.dataset.rowAction === 'add') addRowTo(currentRow().floor.id);
    else if (t.dataset.rowAction === 'settings') selectThing('row', ui.rowId);
  });

  // Structure edits ----------------------------------------------------

  function addFloor() {
    const made = commitAdd((p) => M.addFloor(p));
    if (!made) return toast(FULL.floor, { warn: true });
    setRow(made.rows[0].id);
    toast(`Added ${made.name} with ${made.rows[0].name}`, { action: 'Undo', onAction: undo });
  }

  function addRowTo(floorId, index) {
    const made = commitAdd((p) => M.addRow(p, floorId, { index }));
    if (!made) return toast(FULL.row, { warn: true });
    setRow(made.id, { view: ui.view });
    toast(`Added ${made.name} with ${plural(made.racks.length, 'rack')}`, { action: 'Undo', onAction: undo });
  }

  function addRackTo(rowId, index) {
    const made = commitAdd((p) => M.addRack(p, rowId, { index }));
    if (!made) return toast(FULL.rack, { warn: true });
    toast(`Added ${made.name}`, { action: 'Undo', onAction: undo });
    return made;
  }

  function duplicateStructure(kind, id) {
    const name = kind === 'rack' ? M.rackById(project, id).name : kind === 'row' ? M.rowById(project, id).name : M.floorById(project, id).name;
    const before = project.devices.length;
    const made = commitAdd((p) => (kind === 'rack' ? M.duplicateRack(p, id) : kind === 'row' ? M.duplicateRow(p, id) : M.duplicateFloor(p, id)));
    if (!made) return toast(FULL[kind], { warn: true });
    const n = project.devices.length - before;
    if (kind === 'rack') selectThing('rack', made.id, { reveal: true });
    else {
      ui.selection = { kind, id: made.id };
      setRow(kind === 'row' ? made.id : made.rows[0].id);
    }
    toast(`Added ${made.name}, a copy of ${name}${n ? ` with ${plural(n, 'device')}` : ''}`, { action: 'Undo', onAction: undo });
  }

  async function deleteRack(rackId) {
    const pos = M.locateRack(project, rackId);
    if (!pos) return;
    if (pos.row.racks.length <= 1) return toast(`${pos.row.name} needs at least one rack; delete the row instead`, { warn: true });
    const devs = M.devicesWithin(project, rackId);
    const n = devs.length;
    if (n) {
      const ok = await confirmDialog({
        title: `Delete ${pos.rack.name}?`,
        body: `It holds ${devicesAndCables(devs)}, which are deleted with it. Undo brings everything back.`,
        ok: 'Delete rack',
      });
      if (!ok) return;
    }
    commit((p) => void M.removeRack(p, rackId));
    toast(`Deleted ${pos.rack.name}`, { action: 'Undo', onAction: undo });
  }

  async function deleteRow(rowId) {
    const pos = M.locateRow(project, rowId);
    if (!pos) return;
    if (pos.floor.rows.length <= 1) return toast(`${pos.floor.name} needs at least one row; delete the floor instead`, { warn: true });
    const devs = M.devicesWithin(project, rowId);
    const n = devs.length;
    const cables = cablesGoingWith(idSet(devs));
    const ok = await confirmDialog({
      title: `Delete ${pos.row.name}?`,
      body: `This deletes its ${listAnd([plural(pos.row.racks.length, 'rack'), n && plural(n, 'device'), cables && plural(cables, 'cable')])}. Undo brings everything back.`,
      ok: 'Delete row',
    });
    if (!ok) return;
    commit((p) => void M.removeRow(p, rowId));
    toast(`Deleted ${pos.row.name}`, { action: 'Undo', onAction: undo });
  }

  async function deleteFloor(floorId) {
    const floor = M.floorById(project, floorId);
    if (!floor) return;
    if (project.floors.length <= 1) return toast('A plan needs at least one floor', { warn: true });
    const devs = M.devicesWithin(project, floorId);
    const n = devs.length;
    const cables = cablesGoingWith(idSet(devs));
    const racks = floor.rows.reduce((a, r) => a + r.racks.length, 0);
    const ok = await confirmDialog({
      title: `Delete ${floor.name}?`,
      body: `This deletes ${listAnd([plural(floor.rows.length, 'row'), plural(racks, 'rack'), n && plural(n, 'device'), cables && plural(cables, 'cable')])}. Undo brings everything back.`,
      ok: 'Delete floor',
    });
    if (!ok) return;
    commit((p) => void M.removeFloor(p, floorId));
    toast(`Deleted ${floor.name}`, { action: 'Undo', onAction: undo });
  }

  async function setRowRackCount(rowId, n) {
    const row = M.rowById(project, rowId);
    const count = clamp(n, 1, M.LIMITS.racks);
    if (!row || count === row.racks.length) return;
    const lost = M.devicesBeyond(project, rowId, count);
    const removed = row.racks.slice(count);
    if (lost.length) {
      const names = removed.map((r) => r.name).join(', ');
      const ok = await confirmDialog({
        title: removed.length === 1 ? `Remove ${names}?` : `Remove ${removed.length} racks?`,
        body: `${names} ${removed.length === 1 ? 'holds' : 'hold'} ${devicesAndCables(lost)}, which ${lost.length === 1 && !cablesGoingWith(idSet(lost)) ? 'is' : 'are'} removed too. Undo brings everything back.`,
        ok: removed.length === 1 ? 'Remove rack' : 'Remove racks',
      });
      if (!ok) return;
    }
    commit((p) => void M.setRowRackCount(p, rowId, count));
  }

  // Parts bin and clusters ---------------------------------------------

  let partsKey = null;
  function renderParts() {
    const types = M.placeableTypes(project);
    const key = ui.theme + '|' + JSON.stringify(types);
    if (partsKey !== key) {
      el.parts.innerHTML = types
        .map((t) => {
          const pv = R.renderPreview(t, ui.theme, null, t.variable ? 'reserved' : t.defaultName, measure, 2);
          // The drawing fits a box at most 72 px tall: tall devices get narrower, not taller.
          const artH = clamp(Math.round(pv.height * 0.62) + 8, 22, 72);
          return (
            `<button type="button" class="part${t.variable ? ' part-reserved' : ''}" data-type="${esc(t.id)}" aria-pressed="false">` +
            `<span class="part-art" style="height:${artH}px"><svg viewBox="0 0 ${pv.width} ${pv.height}" preserveAspectRatio="xMinYMid meet" aria-hidden="true">${pv.body}</svg></span>` +
            `<span class="part-meta"><span class="part-name">${esc(t.label)}</span><span class="part-spec">${esc(M.formatTypeSpec(t))}</span></span>` +
            `<span class="part-count" data-count></span></button>`
          );
        })
        .join('');
      partsKey = key;
    }
    const counts = new Map();
    for (const d of project.devices) counts.set(d.type, (counts.get(d.type) || 0) + 1);
    for (const t of types) {
      const card = el.parts.querySelector(`[data-type="${CSS.escape(t.id)}"]`);
      if (!card) continue;
      const n = counts.get(t.id) || 0;
      const count = card.querySelector('[data-count]');
      count.textContent = n;
      count.title = `${n} placed`;
      count.classList.toggle('is-zero', !n);
      card.classList.toggle('is-armed', ui.armed === t.id);
      card.setAttribute('aria-pressed', String(ui.armed === t.id));
      card.setAttribute('aria-label', `${t.label}, ${M.formatTypeSpec(t)}, ${n} placed. Click, then click a free slot to place it.`);
    }
  }

  function renderClusters() {
    const counts = new Map();
    let unassigned = 0;
    for (const d of project.devices) {
      if (d.type === M.RESERVED.id && !d.cluster) continue;
      if (d.cluster) counts.set(d.cluster, (counts.get(d.cluster) || 0) + 1);
      else unassigned++;
    }
    const row = (id, name, color, count, editable) =>
      `<li class="cl-row" data-cluster="${esc(id)}">` +
      `<button type="button" class="cl-main" aria-pressed="${ui.focusCluster === id}">` +
      `<span class="sw" style="--c:${color || 'var(--unassigned)'}"></span>` +
      `<span class="cl-name">${esc(name)}</span><span class="cl-count" title="${count} devices">${count}</span></button>` +
      `<button type="button" class="btn icon sm subtle cl-select" aria-label="Select the devices of ${esc(name)}" title="Select its devices">${icon('select')}</button>` +
      (editable
        ? `<button type="button" class="btn icon sm subtle cl-edit" aria-label="Edit ${esc(name)}" title="Rename or recolor">${icon('pencil')}</button>`
        : `<span class="btn icon sm subtle" aria-hidden="true" style="visibility:hidden"></span>`) +
      `</li>`;
    let html = project.clusters.map((c) => row(c.id, c.name, c.color, counts.get(c.id) || 0, true)).join('');
    if (unassigned) html += row('__none', 'Unassigned', null, unassigned, false);
    el.clusters.innerHTML = html || `<li class="cl-empty">No clusters yet.</li>`;
    el.clustersHint.textContent = !project.clusters.length
      ? 'Clusters give devices that belong together one color.'
      : ui.focusCluster
        ? 'Click the highlighted cluster again to show all devices.'
        : 'Click a cluster to highlight its devices in the racks.';
  }

  function renderChrome() {
    el.undo.disabled = !history.past.length;
    el.redo.disabled = !history.future.length;
    if (document.activeElement !== el.planName) el.planName.value = project.name;
    el.notice.hidden = !(project.meta && project.meta.example);
    el.stage.classList.toggle('is-armed', !!ui.armed);
    if (ui.armed) {
      const t = M.typeOf(project, ui.armed);
      el.armedHint.innerHTML =
        `<span>Click a free slot to place ${t.variable ? '' : 'a '}<strong>${esc(t.label.toLowerCase())}</strong></span><kbd>Esc</kbd>` +
        `<button type="button" data-disarm aria-label="Stop placing">${icon('x', 'ic-sm')}</button>`;
    }
    el.armedHint.hidden = !ui.armed;
  }

  // ------------------------------------------------------------ inspector

  function clusterChips(name, selected, withNew) {
    const chip = (value, label, color, checked, cls) =>
      `<label class="chip${cls || ''}"><input type="radio" name="${name}" value="${esc(value)}"${checked ? ' checked' : ''}>` +
      `<span>${color !== undefined ? `<i class="sw" style="--c:${color || 'var(--unassigned)'}"></i>` : ''}${esc(label)}</span></label>`;
    let s = chip('', 'None', null, selected === null);
    for (const c of project.clusters) s += chip(c.id, c.name, c.color, selected === c.id);
    if (withNew) s += chip('__new', '+ New cluster', undefined, selected === '__new', ' chip-new');
    return s;
  }

  const locKey = (l) => `${l.kind}:${l.at}`;
  function parseLocKey(rack, key) {
    const [kind, at] = key.split(':');
    return { rack, kind, at: parseInt(at, 10) };
  }

  /** <option>s for every rack, grouped by floor and row. */
  function rackOptions(selectedId) {
    let s = '';
    for (const { floor, row } of M.allRows(project)) {
      s += `<optgroup label="${esc(`${floor.name} · ${row.name}`)}">`;
      for (const r of row.racks) {
        s += `<option value="${esc(r.id)}"${r.id === selectedId ? ' selected' : ''}>${esc(r.name)}</option>`;
      }
      s += `</optgroup>`;
    }
    return s;
  }

  function meterHTML(label, value, max, text, over) {
    const p = max ? clamp((value / max) * 100, 0, 100) : 0;
    return (
      `<div class="meter${over ? ' is-over' : ''}${max ? '' : ' no-max'}"><div class="meter-top"><span>${esc(label)}</span><span class="mono">${esc(text)}</span></div>` +
      `<div class="meter-track"><span style="width:${p.toFixed(1)}%"></span></div></div>`
    );
  }

  /** Power and weight against their budgets, for a rack's stats or totals from M.sumStats. */
  function budgetMeters(st) {
    return (
      meterHTML('Power', st.powerW, st.powerBudgetW, withBudget(fmtKw, st.powerW, st.powerBudgetW), st.overPower > 0) +
      meterHTML('Weight', st.weightKg, st.weightBudgetKg, withBudget(fmtKg, st.weightKg, st.weightBudgetKg), st.overWeight > 0)
    );
  }

  /** A button with a usage bar: used and reserved units of `st`. */
  function usageBar(attrs, name, value, st) {
    return (
      `<button type="button" class="rack-bar${st.overPower || st.overWeight ? ' is-over' : ''}" ${attrs}>` +
      `<span class="rb-name">${esc(name)}</span><span class="rb-val">${esc(value)}</span>` +
      `<span class="rb-track"><span class="rb-fill" style="width:${pct(st.used, st.units)}%"></span><span class="rb-res" style="width:${pct(st.reserved, st.units)}%"></span></span></button>`
    );
  }
  function rackBars(row, stats) {
    return row.racks
      .map((r) => {
        const st = stats.get(r.id);
        return usageBar(`data-rack="${esc(r.id)}"`, r.name, `${st.used + st.reserved}/${st.units} U · ${fmtKw(st.powerW)}`, st);
      })
      .join('');
  }

  /**
   * Draws the inspector of the selection. A form control with focus is
   * left first, so an edit made in it is kept and shown, and gets focus
   * back when the same selection is drawn again, so arrow keys on a radio
   * keep switching it rather than moving the device. For another selection
   * focus leaves the inspector, as keys then belong to the plan.
   */
  let inspectorKey = null;
  function renderInspector() {
    const active = document.activeElement;
    const focusId = active && active.id && el.inspector.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName) ? active.id : null;
    // Leaving the control fires its change (a value typed but not yet
    // committed), which may redraw the plan and this inspector.
    if (focusId) active.blur();
    const key = JSON.stringify(ui.selection || null);
    const same = key === inspectorKey;
    inspectorKey = key;
    drawInspector();
    const again = focusId && same && document.getElementById(focusId);
    if (again && el.inspector.contains(again) && !again.disabled) again.focus();
  }

  function drawInspector() {
    const s = ui.selection;
    if (s && s.kind === 'devices') {
      if (s.ids.length === 1) renderDeviceInspector(M.deviceById(project, s.ids[0]));
      else renderMultiInspector(s.ids.map((id) => M.deviceById(project, id)));
    } else if (s && s.kind === 'rack') renderRackInspector(M.rackById(project, s.id));
    else if (s && s.kind === 'row') renderRowInspector(M.locateRow(project, s.id));
    else if (s && s.kind === 'floor') renderFloorInspector(M.floorById(project, s.id));
    else renderOverview();
  }

  /**
   * Commits every keystroke in a text field through `apply(draft, value)`;
   * typing in a row is one undo step. A field left empty gets `fallback()`.
   */
  function bindText(input, key, apply, fallback) {
    input.addEventListener('input', () => {
      const v = input.value;
      commit((p) => void apply(p, v), { key, inspector: false });
    });
    if (!fallback) return;
    input.addEventListener('change', () => {
      if (input.value.trim()) return;
      const v = fallback();
      commit((p) => void apply(p, v), { key });
      input.value = v;
    });
  }

  /** A field bound to a device property: text as typed, or `parse`d when the field is left. */
  function bindField(input, id, prop, parse) {
    if (!parse) return bindText(input, `${prop}:${id}`, (p, v) => (M.deviceById(p, id)[prop] = v));
    bindProp(input, (p) => M.deviceById(p, id), prop, parse);
  }
  /** A field bound to property `prop` of what `get(draft)` finds (a rack, a floor …), `parse`d when the field is left. */
  function bindProp(input, get, prop, parse) {
    input.addEventListener('change', () => {
      const v = parse(input.value);
      commit((p) => void (get(p)[prop] = v), { inspector: false });
      // Show what is kept: a value out of range is clamped.
      const kept = get(project)[prop];
      input.value = kept == null ? '' : kept;
    });
  }
  const parseOptNum = (max) => (v) => (String(v).trim() === '' ? null : M.clampNum(v, 0, max, null));

  /** A "Front to front | Back to front" radio group for `reversed`; `value` undefined checks neither (mixed). */
  function mountRadios(name, value, labelId) {
    const radio = (v, text) =>
      `<label><input type="radio" name="${name}" id="${name}-${v ? 'back' : 'front'}" value="${v ? 'back' : 'front'}"${value === v ? ' checked' : ''}><span>${text}</span></label>`;
    return (
      `<div class="field"><span class="label" id="${labelId}">Mounted</span>` +
      `<div class="seg seg-fill" role="radiogroup" aria-labelledby="${labelId}">${radio(false, 'Front to front')}${radio(true, 'Back to front')}</div></div>`
    );
  }

  function renderDeviceInspector(d) {
    const type = M.typeOf(project, d.type);
    const cluster = M.clusterById(project, d.cluster);
    const hU = M.deviceHeight(project, d);
    const pos = M.locateRack(project, d.loc.rack);
    const slotOpts = M.validLocs(project, d.type, d.loc.rack, d.id, d.height)
      .map((l) => {
        const cur = l.kind === d.loc.kind && l.at === d.loc.at;
        const label = l.kind === 'side' ? `Side slot V${l.at + 1}` : M.formatPosition(project, l, d.type, d.height);
        return `<option value="${locKey(l)}"${cur ? ' selected' : ''}>${label}</option>`;
      })
      .join('');
    const canUp = !!M.nudgeTarget(project, d, -1);
    const canDown = !!M.nudgeTarget(project, d, 1);
    const fields = M.FIELDS.map(
      (f) =>
        `<div class="field"><label for="insp-f-${f.key}">${esc(f.label)}</label>` +
        `<input id="insp-f-${f.key}" type="text" value="${esc(d[f.key] || '')}" spellcheck="false" autocomplete="off" maxlength="120"${f.key === 'ip' || f.key === 'serial' || f.key === 'asset' ? ' class="mono"' : ''}></div>`
    ).join('');

    el.inspector.innerHTML =
      `<div class="insp-head">` +
      `<div class="kicker"><span class="sw" style="--c:${cluster ? cluster.color : 'var(--unassigned)'}"></span>${esc(type.label)} · ${hU}U</div>` +
      `<label for="insp-name" class="sr-only">Device name</label>` +
      `<input id="insp-name" class="name-input" type="text" value="${esc(d.name)}" spellcheck="false" autocomplete="off" maxlength="80">` +
      `<div class="insp-where">${esc(M.formatDeviceLoc(project, d))}</div>` +
      `<div class="insp-sub">${esc(`${pos.floor.name} · ${pos.row.name}`)}</div>` +
      `</div>` +
      `<section class="insp-sec"><h3 id="insp-cluster-label">Cluster</h3>` +
      `<div class="chips" role="radiogroup" aria-labelledby="insp-cluster-label">${clusterChips('insp-cluster', d.cluster, true)}</div></section>` +
      `<section class="insp-sec"><h3>Position</h3>` +
      `<div class="pos-grid">` +
      `<div class="field"><label for="insp-rack">Rack</label><select id="insp-rack">${rackOptions(d.loc.rack)}</select></div>` +
      `<div class="field"><label for="insp-slot">Slot</label><select id="insp-slot">${slotOpts}</select></div>` +
      (type.variable ? `<div class="field"><label for="insp-height">Height (U)</label><input id="insp-height" type="number" min="1" max="${M.rackUnits(project, d.loc.rack)}" step="1" value="${hU}" inputmode="numeric"></div>` : '') +
      `</div>` +
      (type.face === 'reserved' ? '' : mountRadios('insp-mount', !!d.reversed, 'insp-mount-label')) +
      (d.loc.kind === 'u'
        ? `<div class="nudge"><button type="button" class="btn sm" id="insp-up"${canUp ? '' : ' disabled'} title="Next free position above (↑)">${icon('up')}Move up</button>` +
          `<button type="button" class="btn sm" id="insp-down"${canDown ? '' : ' disabled'} title="Next free position below (↓)">${icon('down')}Move down</button></div>`
        : '') +
      `</section>` +
      `<section class="insp-sec"><h3>Details</h3><div class="field-grid">${fields}` +
      `<div class="field"><label for="insp-power">Power (W)</label><input id="insp-power" type="number" min="0" step="10" inputmode="decimal" value="${d.powerW == null ? '' : d.powerW}" placeholder="${type.powerW} (type)"></div>` +
      `<div class="field"><label for="insp-weight">Weight (kg)</label><input id="insp-weight" type="number" min="0" step="0.5" inputmode="decimal" value="${d.weightKg == null ? '' : d.weightKg}" placeholder="${type.weightKg} (type)"></div>` +
      `</div></section>` +
      `<section class="insp-sec"><h3><label for="insp-notes">Notes</label></h3>` +
      `<textarea id="insp-notes" rows="3" placeholder="Cabling, purchase order, plans …">${esc(d.notes || '')}</textarea></section>` +
      `<div class="insp-actions is-pinned">` +
      `<button type="button" class="btn" id="insp-dup" title="Duplicate (Ctrl+D)">${icon('copy')}Duplicate</button>` +
      `<button type="button" class="btn danger-text" id="insp-del" title="Delete (Del)">${icon('trash')}Delete</button>` +
      `</div>`;

    const id = d.id;
    bindText($('#insp-name'), 'name:' + id, (p, v) => (M.deviceById(p, id).name = v), () => M.suggestName(project, d.type));
    $$('input[name="insp-cluster"]', el.inspector).forEach((r) =>
      r.addEventListener('change', () => {
        if (r.value === '__new') {
          openClusterDialog(null, (p, cid) => void (M.deviceById(p, id).cluster = cid), () => renderInspector());
          return;
        }
        prefs.lastCluster = r.value || null;
        savePrefs();
        commit((p) => void (M.deviceById(p, id).cluster = r.value || null));
      })
    );
    $('#insp-rack').addEventListener('change', (e) => {
      const rackId = e.target.value;
      const cur = M.deviceById(project, id);
      const near = cur.loc.kind === 'u' ? cur.loc.at : Math.ceil(M.rackUnits(project, rackId) / 2);
      const loc = M.nearestLoc(project, cur.type, rackId, near, id, cur.loc.kind === 'side', cur.height);
      if (!loc) {
        toast(`${M.rackById(project, rackId).name} has no free space for ${cur.name}`, { warn: true });
        renderInspector();
        return;
      }
      moveDevice(id, loc, { follow: true });
    });
    $('#insp-slot').addEventListener('change', (e) => moveDevice(id, parseLocKey(d.loc.rack, e.target.value)));
    $$('input[name="insp-mount"]', el.inspector).forEach((r) =>
      r.addEventListener('change', () => commit((p) => void (M.deviceById(p, id).reversed = r.value === 'back')))
    );
    const heightInput = $('#insp-height');
    if (heightInput) {
      heightInput.addEventListener('change', () => {
        const h = M.clampInt(heightInput.value, 1, M.rackUnits(project, d.loc.rack), hU);
        const check = M.canPlace(project, d.type, d.loc, id, h);
        if (!check.ok) {
          toast(check.reason, { warn: true });
          heightInput.value = hU;
          return;
        }
        commit((p) => void (M.deviceById(p, id).height = h));
      });
    }
    const up = $('#insp-up');
    const down = $('#insp-down');
    if (up) up.addEventListener('click', () => nudge(id, -1));
    if (down) down.addEventListener('click', () => nudge(id, 1));
    for (const f of M.FIELDS) bindField($(`#insp-f-${f.key}`), id, f.key);
    bindField($('#insp-power'), id, 'powerW', parseOptNum(100000));
    bindField($('#insp-weight'), id, 'weightKg', parseOptNum(5000));
    bindField($('#insp-notes'), id, 'notes');
    $('#insp-dup').addEventListener('click', () => duplicateDevice(id));
    $('#insp-del').addEventListener('click', () => deleteDevices([id]));
  }

  function renderMultiInspector(devs) {
    const byType = new Map();
    for (const d of devs) byType.set(d.type, (byType.get(d.type) || 0) + 1);
    const summary = [...byType].map(([t, n]) => `${n} × ${M.typeOf(project, t).label}`).join(', ');
    const clusters = new Set(devs.map((d) => d.cluster || null));
    const owners = new Set(devs.map((d) => d.owner || ''));
    const same = clusters.size === 1 ? [...clusters][0] : undefined;
    // Reserved space faces no way: only devices are mounted one way or the other.
    const mountable = devs.filter((d) => M.typeOf(project, d.type).face !== 'reserved');
    const mounts = new Set(mountable.map((d) => !!d.reversed));
    const sorted = M.sortedDevices(Object.assign({}, project, { devices: devs }));
    const power = devs.reduce((a, d) => a + M.powerOf(project, d), 0);
    const units = devs.filter((d) => d.loc.kind === 'u').reduce((a, d) => a + M.deviceHeight(project, d), 0);
    const rows = sorted
      .map((d) => {
        const c = M.clusterById(project, d.cluster);
        return (
          `<li><button type="button" data-select="${esc(d.id)}" title="${esc(M.formatDeviceLoc(project, d))}">` +
          `<span class="u">${esc(shortRack(M.rackById(project, d.loc.rack).name))} ${M.formatPosition(project, d.loc, d.type, d.height)}</span>` +
          `<span class="sw" style="--c:${c ? c.color : 'var(--unassigned)'}"></span><span class="nm">${esc(d.name)}</span></button></li>`
        );
      })
      .join('');
    el.inspector.innerHTML =
      `<div class="insp-head"><div class="kicker">${icon('select', 'ic-sm')}Selection</div>` +
      `<div class="multi-title">${plural(devs.length, 'device')}</div>` +
      `<div class="insp-where">${esc(summary)}</div>` +
      `<div class="insp-sub">${units} U · ${esc(fmtPower(power))}</div></div>` +
      `<section class="insp-sec"><h3 id="multi-cluster-label">Cluster</h3>` +
      `<div class="chips" role="radiogroup" aria-labelledby="multi-cluster-label">${clusterChips('multi-cluster', same === undefined ? undefined : same, true)}</div>` +
      (same === undefined ? `<p class="sec-hint">Mixed clusters; pick one to give it to all.</p>` : '') +
      `</section>` +
      `<section class="insp-sec"><h3>Move together</h3>` +
      `<div class="btn-grid"><button type="button" class="btn sm" data-group="up" title="Next room above (↑)">${icon('up')}Up</button><button type="button" class="btn sm" data-group="down" title="Next room below (↓)">${icon('down')}Down</button>` +
      `<button type="button" class="btn sm" data-group="left" title="Rack to the left (←)">${icon('left')}Left rack</button><button type="button" class="btn sm" data-group="right" title="Rack to the right (→)">Right rack${icon('right')}</button></div>` +
      `<p class="sec-hint">Or drag any of them; hold <kbd>Alt</kbd> to copy the group.</p></section>` +
      `<section class="insp-sec"><h3>Set for all</h3>` +
      (mountable.length ? mountRadios('multi-mount', mounts.size === 1 ? [...mounts][0] : undefined, 'multi-mount-label') : '') +
      `<div class="field-grid">` +
      `<div class="field span2"><label for="multi-owner">Owner</label><input id="multi-owner" type="text" value="${owners.size === 1 ? esc([...owners][0]) : ''}" placeholder="${owners.size > 1 ? 'Mixed' : ''}" autocomplete="off" maxlength="120"></div>` +
      `<div class="field span2"><label for="multi-rename">Rename in series, top to bottom</label><div class="inline"><input id="multi-rename" class="mono" type="text" value="${esc(sorted[0].name)}" autocomplete="off" spellcheck="false" maxlength="80"><button type="button" class="btn sm" id="multi-rename-go">Rename</button></div></div>` +
      `</div></section>` +
      `<section class="insp-sec"><h3>Devices</h3><ol class="contents">${rows}</ol></section>` +
      `<div class="insp-actions is-pinned">` +
      `<button type="button" class="btn" id="multi-dup" title="Duplicate (Ctrl+D)">${icon('copy')}Duplicate</button>` +
      `<button type="button" class="btn" id="multi-clear">Clear selection</button>` +
      `<button type="button" class="btn danger-text" id="multi-del">${icon('trash')}Delete ${devs.length}</button>` +
      `</div>`;

    const ids = devs.map((d) => d.id);
    $$('input[name="multi-cluster"]', el.inspector).forEach((r) =>
      r.addEventListener('change', () => {
        const apply = (p, cid) => ids.forEach((id) => (M.deviceById(p, id).cluster = cid));
        if (r.value === '__new') return openClusterDialog(null, apply, () => renderInspector());
        commit((p) => void apply(p, r.value || null));
      })
    );
    $$('input[name="multi-mount"]', el.inspector).forEach((r) =>
      r.addEventListener('change', () => commit((p) => void mountable.forEach((d) => (M.deviceById(p, d.id).reversed = r.value === 'back'))))
    );
    $('#multi-owner').addEventListener('change', (e) => {
      const v = e.target.value.trim();
      commit((p) => void ids.forEach((id) => (M.deviceById(p, id).owner = v)));
    });
    $('#multi-rename-go').addEventListener('click', () => {
      const first = $('#multi-rename').value.trim();
      if (!first) return;
      const names = M.nameSequence(first, sorted.length);
      commit((p) => void sorted.forEach((d, i) => (M.deviceById(p, d.id).name = names[i])));
      toast(`Renamed ${names[0]} … ${names[names.length - 1]}`);
    });
    $$('[data-group]', el.inspector).forEach((b) =>
      b.addEventListener('click', () => {
        const g = b.dataset.group;
        if (g === 'up' || g === 'down') groupNudge(g === 'up' ? -1 : 1);
        else groupToRack(g === 'left' ? -1 : 1);
      })
    );
    $('#multi-dup').addEventListener('click', () => duplicateDevices(ids));
    $('#multi-clear').addEventListener('click', clearSelection);
    $('#multi-del').addEventListener('click', () => deleteDevices(ids));
  }

  function statsSection(st) {
    return (
      `<section class="insp-sec"><dl class="stats">` +
      `<div><dt>Used</dt><dd>${st.used} U <small>${pct(st.used, st.units)}%</small></dd></div>` +
      `<div><dt>Reserved</dt><dd>${st.reserved} U</dd></div>` +
      `<div><dt>Free</dt><dd>${st.free} U</dd></div>` +
      (st.largestFree !== undefined ? `<div><dt>Largest free block</dt><dd>${st.largestFree} U</dd></div>` : `<div><dt>Racks</dt><dd>${st.racks}</dd></div>`) +
      `</dl>` +
      budgetMeters(st) +
      `</section>`
    );
  }

  function contentsList(devs) {
    return devs
      .map((d) => {
        const c = M.clusterById(project, d.cluster);
        return (
          `<li><button type="button" data-select="${esc(d.id)}" title="${esc(M.typeOf(project, d.type).label)}">` +
          `<span class="u">${M.formatPosition(project, d.loc, d.type, d.height)}</span>` +
          `<span class="sw${d.type === M.RESERVED.id ? ' sw-res' : ''}" style="--c:${c ? c.color : 'var(--unassigned)'}"></span>` +
          `<span class="nm">${esc(d.name)}</span></button></li>`
        );
      })
      .join('');
  }

  function renderRackInspector(rack) {
    const pos = M.locateRack(project, rack.id);
    const st = M.rackStats(project, rack.id);
    const devs = M.sortedDevices(project, rack.id);
    const rt = M.rackTypeOf(project, rack);
    const typeOpts = project.rackTypes.map((t) => `<option value="${esc(t.id)}"${t.id === rack.type ? ' selected' : ''}>${esc(t.name)} · ${t.units}U</option>`).join('');
    const rowOpts = M.allRows(project)
      .map(({ row, floor }) => {
        const full = row !== pos.row && row.racks.length >= M.LIMITS.racks;
        return `<option value="${esc(row.id)}"${row === pos.row ? ' selected' : ''}${full ? ' disabled' : ''}>${esc(`${floor.name} · ${row.name}`)}${full ? ' (full)' : ''}</option>`;
      })
      .join('');
    const n = pos.row.racks.length;
    const rowFull = n >= M.LIMITS.racks;
    el.inspector.innerHTML =
      `<div class="insp-head">` +
      `<div class="kicker">${icon('rack', 'ic-sm')}Rack · ${esc(pos.floor.name)} · ${esc(pos.row.name)}</div>` +
      `<label for="insp-rack-name" class="sr-only">Rack name</label>` +
      `<input id="insp-rack-name" class="name-input" type="text" value="${esc(rack.name)}" spellcheck="false" autocomplete="off" maxlength="60">` +
      `<div class="insp-where">${esc(`19″ · ${rt.units}U · ${plural(rt.sideSlots, 'side slot')} · position ${pos.index + 1} of ${n}`)}</div>` +
      `</div>` +
      `<section class="insp-sec"><h3><label for="insp-rack-type">Rack type</label></h3>` +
      `<div class="inline"><select id="insp-rack-type">${typeOpts}</select><button type="button" class="btn sm" id="insp-rack-types">${icon('book')}Types</button></div></section>` +
      `<section class="insp-sec"><h3>Cable lengths</h3><div class="field-grid">` +
      `<div class="field"><label for="insp-rack-tray">To cable tray (m)</label><input id="insp-rack-tray" type="number" min="0" max="10" step="0.1" inputmode="decimal" value="${rack.trayM == null ? '' : rack.trayM}" placeholder="${rt.trayM} (type)"></div>` +
      `<div class="field"><label for="insp-rack-slack">Slack per cable (m)</label><input id="insp-rack-slack" type="number" min="0" max="10" step="0.05" inputmode="decimal" value="${rack.slackM == null ? '' : rack.slackM}" placeholder="${rt.slackM} (type)"></div>` +
      `</div><p class="sec-hint">From the top unit up to the tray, and the slack a cable gets at each end in this rack. Empty fields take the rack type’s.</p></section>` +
      statsSection(st) +
      `<section class="insp-sec"><h3>Place in the row</h3>` +
      `<div class="btn-grid">` +
      `<button type="button" class="btn sm" data-rack-act="left"${pos.index ? '' : ' disabled'}>${icon('left')}Move left</button>` +
      `<button type="button" class="btn sm" data-rack-act="right"${pos.index < n - 1 ? '' : ' disabled'}>Move right${icon('right')}</button>` +
      `<button type="button" class="btn sm" data-rack-act="insert-left"${rowFull ? ' disabled' : ''}>${icon('plus')}Insert left</button>` +
      `<button type="button" class="btn sm" data-rack-act="insert-right"${rowFull ? ' disabled' : ''}>${icon('plus')}Insert right</button>` +
      `</div>` +
      `<div class="field"><label for="insp-rack-row">Row</label><select id="insp-rack-row"${n <= 1 ? ' disabled title="The only rack of its row"' : ''}>${rowOpts}</select></div></section>` +
      `<section class="insp-sec"><h3>Contents · top to bottom</h3>` +
      (devs.length ? `<ol class="contents">${contentsList(devs)}</ol>` : `<p class="empty-note">Empty. Drag devices from the left onto this rack.</p>`) +
      `</section>` +
      `<div class="insp-actions">` +
      `<button type="button" class="btn" id="insp-dup-rack"${rowFull ? ` disabled title="${esc(pos.row.name)} is full"` : ' title="Duplicate (Ctrl+D)"'}>${icon('copy')}Duplicate rack</button>` +
      `<button type="button" class="btn" id="insp-rack-select"${devs.length ? '' : ' disabled'}>${icon('select')}Select devices</button>` +
      `<button type="button" class="btn danger-text" id="insp-clear-rack"${devs.length ? '' : ' disabled'}>${icon('trash')}Empty rack</button>` +
      `<button type="button" class="btn danger-text" id="insp-del-rack"${n <= 1 ? ' disabled title="A row needs at least one rack"' : ''}>${icon('trash')}Delete rack</button>` +
      `</div>`;

    const id = rack.id;
    bindText($('#insp-rack-name'), 'rack:' + id, (p, v) => (M.rackById(p, id).name = v), () => M.defaultRackName(project, pos.row.id, pos.index));
    $('#insp-rack-type').addEventListener('change', (e) => {
      const err = commitOrError((p) => M.setRackType(p, id, e.target.value));
      if (err) {
        toast(`Can’t change the type: ${err}`, { warn: true });
        renderInspector();
      }
    });
    $('#insp-rack-types').addEventListener('click', () => openCatalog('racks', rack.type));
    bindProp($('#insp-rack-tray'), (p) => M.rackById(p, id), 'trayM', parseOptNum(10));
    bindProp($('#insp-rack-slack'), (p) => M.rackById(p, id), 'slackM', parseOptNum(10));
    $$('[data-rack-act]', el.inspector).forEach((b) =>
      b.addEventListener('click', () => {
        const act = b.dataset.rackAct;
        if (act === 'left' || act === 'right') commit((p) => void M.moveRack(p, id, pos.row.id, pos.index + (act === 'left' ? -1 : 1)));
        else addRackTo(pos.row.id, pos.index + (act === 'insert-right' ? 1 : 0));
      })
    );
    $('#insp-rack-row').addEventListener('change', (e) => {
      const target = e.target.value;
      if (!commit((p) => (M.moveRack(p, id, target) ? undefined : false))) return renderInspector();
      setRow(target);
      toast(`Moved ${rack.name} to ${M.formatWhere(project, target)}`, { action: 'Undo', onAction: undo });
    });
    $('#insp-dup-rack').addEventListener('click', () => duplicateStructure('rack', id));
    $('#insp-rack-select').addEventListener('click', () => selectDevices(devs.map((d) => d.id)));
    $('#insp-clear-rack').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: `Empty ${rack.name}?`,
        body: `This removes all ${devicesAndCables(devs)} from ${rack.name}. Undo brings them back.`,
        ok: 'Remove devices',
      });
      if (ok) commit((p) => void M.removeDevicesIn(p, new Set([id])));
    });
    $('#insp-del-rack').addEventListener('click', () => deleteRack(id));
  }

  function renderRowInspector(pos) {
    const row = pos.row;
    const stats = M.statsByRack(project);
    const t = M.statsWithin(project, row.id, stats);
    const devs = M.devicesWithin(project, row.id);
    const floorOpts = project.floors
      .map((f) => {
        const full = f !== pos.floor && f.rows.length >= M.LIMITS.rows;
        return `<option value="${esc(f.id)}"${f === pos.floor ? ' selected' : ''}${full ? ' disabled' : ''}>${esc(f.name)}${full ? ' (full)' : ''}</option>`;
      })
      .join('');
    el.inspector.innerHTML =
      `<div class="insp-head"><div class="kicker">${icon('map', 'ic-sm')}Row · ${esc(pos.floor.name)}</div>` +
      `<label for="insp-row-name" class="sr-only">Row name</label>` +
      `<input id="insp-row-name" class="name-input ui" type="text" value="${esc(row.name)}" spellcheck="false" autocomplete="off" maxlength="60">` +
      `<div class="insp-where">${esc(`${plural(row.racks.length, 'rack')} · ${plural(devs.length, 'device')}`)}</div></div>` +
      statsSection(t) +
      `<section class="insp-sec"><h3>Racks</h3>` +
      `<div class="stepper" role="group" aria-label="Number of racks"><button type="button" class="btn icon sm" id="row-less" aria-label="One rack fewer"${row.racks.length <= 1 ? ' disabled' : ''}>${icon('minus')}</button>` +
      `<span class="stepper-val mono">${row.racks.length}</span><button type="button" class="btn icon sm" id="row-more" aria-label="One rack more"${row.racks.length >= M.LIMITS.racks ? ' disabled' : ''}>${icon('plus')}</button>` +
      `<span class="sec-hint">of up to ${M.LIMITS.racks}, added or removed at the end</span></div>` +
      `<div class="rack-bars">${rackBars(row, stats)}</div>` +
      `<button type="button" class="btn sm" id="row-renumber" title="Rack names by position: ${esc(M.defaultRackName(project, row.id, 0))}, ${esc(M.defaultRackName(project, row.id, 1))}, …">Rename racks by position</button></section>` +
      `<section class="insp-sec"><h3>Place</h3>` +
      `<div class="field"><label for="insp-row-floor">Floor</label><select id="insp-row-floor"${pos.floor.rows.length <= 1 ? ' disabled title="The only row of its floor"' : ''}>${floorOpts}</select></div>` +
      `<div class="btn-grid"><button type="button" class="btn sm" data-row-act="up"${pos.rowIndex ? '' : ' disabled'}>${icon('up')}Earlier</button>` +
      `<button type="button" class="btn sm" data-row-act="down"${pos.rowIndex < pos.floor.rows.length - 1 ? '' : ' disabled'}>${icon('down')}Later</button></div></section>` +
      `<div class="insp-actions">` +
      `<button type="button" class="btn" id="row-open">${icon('rack')}Show elevation</button>` +
      `<button type="button" class="btn" id="row-add"${pos.floor.rows.length >= M.LIMITS.rows ? ' disabled' : ''}>${icon('plus')}Add row after</button>` +
      `<button type="button" class="btn" id="row-dup"${pos.floor.rows.length >= M.LIMITS.rows ? ` disabled title="${esc(pos.floor.name)} is full"` : ' title="Duplicate (Ctrl+D)"'}>${icon('copy')}Duplicate row</button>` +
      `<button type="button" class="btn" id="row-select"${devs.length ? '' : ' disabled'}>${icon('select')}Select devices</button>` +
      `<button type="button" class="btn danger-text" id="row-del"${pos.floor.rows.length <= 1 ? ' disabled title="A floor needs at least one row"' : ''}>${icon('trash')}Delete row</button>` +
      `</div>`;

    const id = row.id;
    bindText($('#insp-row-name'), 'row:' + id, (p, v) => (M.rowById(p, id).name = v), () => `Row ${M.letters(pos.rowIndex)}`);
    $('#row-less').addEventListener('click', () => setRowRackCount(id, row.racks.length - 1));
    $('#row-more').addEventListener('click', () => setRowRackCount(id, row.racks.length + 1));
    $('#row-renumber').addEventListener('click', () => commit((p) => void M.renumberRacks(p, id)));
    $('#insp-row-floor').addEventListener('change', (e) => {
      if (!commit((p) => (M.moveRow(p, id, e.target.value) ? undefined : false))) renderInspector();
    });
    $$('[data-row-act]', el.inspector).forEach((b) =>
      b.addEventListener('click', () => commit((p) => void M.moveRow(p, id, pos.floor.id, pos.rowIndex + (b.dataset.rowAct === 'up' ? -1 : 1))))
    );
    $('#row-open').addEventListener('click', () => setRow(id, { view: 'sheet' }));
    $('#row-add').addEventListener('click', () => addRowTo(pos.floor.id, pos.rowIndex + 1));
    $('#row-dup').addEventListener('click', () => duplicateStructure('row', id));
    $('#row-select').addEventListener('click', () => {
      setRow(id, { view: 'sheet', render: false });
      selectDevices(devs.map((d) => d.id));
    });
    $('#row-del').addEventListener('click', () => deleteRow(id));
  }

  function renderFloorInspector(floor) {
    const i = project.floors.indexOf(floor);
    const stats = M.statsByRack(project);
    const t = M.statsWithin(project, floor.id, stats);
    const rows = floor.rows
      .map((row) => {
        const rs = M.statsWithin(project, row.id, stats);
        return usageBar(`data-open-row="${esc(row.id)}"`, row.name, `${plural(rs.racks, 'rack')} · ${fmtKw(rs.powerW)}`, rs);
      })
      .join('');
    el.inspector.innerHTML =
      `<div class="insp-head"><div class="kicker">Floor ${i + 1} of ${project.floors.length}</div>` +
      `<label for="insp-floor-name" class="sr-only">Floor name</label>` +
      `<input id="insp-floor-name" class="name-input ui" type="text" value="${esc(floor.name)}" spellcheck="false" autocomplete="off" maxlength="60">` +
      `<div class="insp-where">${esc(`${plural(floor.rows.length, 'row')} · ${plural(t.racks, 'rack')} · ${plural(t.count, 'device')}`)}</div></div>` +
      statsSection(t) +
      `<section class="insp-sec"><h3>Rows</h3><div class="rack-bars">${rows}</div></section>` +
      `<section class="insp-sec"><h3>Cable lengths</h3><div class="field-grid">` +
      `<div class="field"><label for="floor-pitch">Row pitch (m)</label><input id="floor-pitch" type="number" min="0.5" max="50" step="0.1" inputmode="decimal" value="${floor.rowPitchM == null ? '' : floor.rowPitchM}" placeholder="${M.DEFAULT_ROW_PITCH_M}"></div>` +
      `</div><p class="sec-hint">From one row to the next, which a cable crosses for every row between its ends.</p></section>` +
      `<section class="insp-sec"><h3>Order</h3><div class="btn-grid">` +
      `<button type="button" class="btn sm" data-floor-act="-1"${i ? '' : ' disabled'}>${icon('left')}Earlier</button>` +
      `<button type="button" class="btn sm" data-floor-act="1"${i < project.floors.length - 1 ? '' : ' disabled'}>Later${icon('right')}</button></div></section>` +
      `<div class="insp-actions">` +
      `<button type="button" class="btn" id="floor-map">${icon('map')}Floor map</button>` +
      `<button type="button" class="btn" id="floor-add-row"${floor.rows.length >= M.LIMITS.rows ? ' disabled' : ''}>${icon('plus')}Add row</button>` +
      `<button type="button" class="btn" id="floor-dup"${project.floors.length >= M.LIMITS.floors ? ` disabled title="${FULL.floor}"` : ' title="Duplicate (Ctrl+D)"'}>${icon('copy')}Duplicate floor</button>` +
      `<button type="button" class="btn danger-text" id="floor-del"${project.floors.length <= 1 ? ' disabled title="A plan needs at least one floor"' : ''}>${icon('trash')}Delete floor</button>` +
      `</div>`;
    const id = floor.id;
    bindText($('#insp-floor-name'), 'floor:' + id, (p, v) => (M.floorById(p, id).name = v), () => `Floor ${i + 1}`);
    bindProp($('#floor-pitch'), (p) => M.floorById(p, id), 'rowPitchM', (v) => M.clampNum(String(v).trim() === '' ? null : v, 0.5, 50, M.DEFAULT_ROW_PITCH_M));
    $$('[data-open-row]', el.inspector).forEach((b) => b.addEventListener('click', () => setRow(b.dataset.openRow, { view: 'sheet' })));
    $$('[data-floor-act]', el.inspector).forEach((b) => b.addEventListener('click', () => commit((p) => void M.moveFloor(p, id, i + Number(b.dataset.floorAct)))));
    $('#floor-map').addEventListener('click', () => setRow(currentRow().floor.id === id ? ui.rowId : floor.rows[0].id, { view: 'map' }));
    $('#floor-add-row').addEventListener('click', () => addRowTo(id));
    $('#floor-dup').addEventListener('click', () => duplicateStructure('floor', id));
    $('#floor-del').addEventListener('click', () => deleteFloor(id));
  }

  function renderOverview() {
    const stats = M.statsByRack(project);
    const t = M.statsWithin(project, null, stats);
    const pos = currentRow();
    const counts = new Map();
    for (const d of project.devices) counts.set(d.type, (counts.get(d.type) || 0) + 1);
    const typeRows = M.placeableTypes(project)
      .filter((ty) => counts.get(ty.id))
      .map((ty) => {
        const devs = project.devices.filter((d) => d.type === ty.id);
        const u = devs.reduce((a, d) => a + M.deviceHeight(project, d), 0);
        const w = devs.reduce((a, d) => a + M.powerOf(project, d), 0);
        return `<tr><td>${esc(ty.label)}</td><td>${devs.length}</td><td>${u}</td><td>${(w / 1000).toFixed(1)}</td></tr>`;
      })
      .join('');
    const info = project.info;
    const infoField = (k, label, ph) =>
      `<div class="field"><label for="info-${k}">${label}</label><input id="info-${k}" type="text" value="${esc(info[k] || '')}" placeholder="${ph}" autocomplete="off" maxlength="60"></div>`;

    el.inspector.innerHTML =
      `<div class="insp-head"><div class="kicker">Plan overview</div>` +
      `<p class="insp-note">Select a device, a rack’s yellow label, a row or a floor to edit it. Shift-click or Shift-drag to select several devices.</p></div>` +
      `<section class="insp-sec"><h3>Title block</h3><div class="field-grid">` +
      infoField('site', 'Site', 'Data center, hall') +
      infoField('author', 'Drawn by', 'Name') +
      infoField('revision', 'Revision', 'A') +
      `</div></section>` +
      `<section class="insp-sec"><dl class="stats">` +
      `<div><dt>Floors · rows</dt><dd>${project.floors.length} · ${M.allRows(project).length}</dd></div>` +
      `<div><dt>Racks</dt><dd>${t.racks}</dd></div>` +
      `<div><dt>Devices</dt><dd>${t.count}</dd></div>` +
      `<div><dt>Clusters</dt><dd>${project.clusters.length}</dd></div>` +
      `<div><dt>Units used</dt><dd>${t.used} <small>of ${t.units}</small></dd></div>` +
      `<div><dt>Reserved</dt><dd>${t.reserved} U</dd></div>` +
      `</dl>` +
      budgetMeters(t) +
      (t.overPower || t.overWeight ? `<p class="warn-note">${esc(`${plural(t.overPower, 'rack')} over the power budget, ${plural(t.overWeight, 'rack')} over the weight limit.`)}</p>` : '') +
      `</section>` +
      `<section class="insp-sec"><h3>${esc(`${pos.floor.name} · ${pos.row.name}`)}</h3><div class="rack-bars">${rackBars(pos.row, stats)}</div></section>` +
      `<section class="insp-sec"><h3>By device type</h3>` +
      (typeRows
        ? `<table class="type-table"><thead><tr><th>Type</th><th>Count</th><th>U</th><th>kW</th></tr></thead><tbody>${typeRows}</tbody></table>`
        : `<p class="empty-note">No devices yet.</p>`) +
      `</section>` +
      `<section class="insp-sec keys-sec"><h3>Shortcuts</h3><dl class="keys">` +
      `<dt><kbd>/</kbd></dt><dd>Search</dd>` +
      `<dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous, next row</dd>` +
      `<dt><kbd>M</kbd></dt><dd>Floor map</dd>` +
      `<dt><kbd>Shift</kbd> + click</dt><dd>Add to selection</dd>` +
      `<dt><kbd>Shift</kbd> + drag</dt><dd>Select an area</dd>` +
      `<dt><kbd>Ctrl</kbd> <kbd>A</kbd></dt><dd>Select the row</dd>` +
      `<dt><kbd>Alt</kbd> + drop</dt><dd>Copy instead of move</dd>` +
      `<dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Next free position</dd>` +
      `<dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Neighbouring rack</dd>` +
      `<dt><kbd>Ctrl</kbd> <kbd>D</kbd></dt><dd>Duplicate the selection</dd>` +
      `<dt><kbd>Del</kbd></dt><dd>Delete</dd>` +
      `<dt><kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo; add <kbd>Shift</kbd> to redo</dd>` +
      `<dt><kbd>0</kbd> <kbd>1</kbd></dt><dd>Fit sheet, 100%</dd>` +
      `<dt><kbd>Esc</kbd></dt><dd>Cancel, deselect, clear search</dd>` +
      `</dl></section>`;
    for (const k of ['site', 'author', 'revision']) bindText($(`#info-${k}`), 'info:' + k, (p, v) => (p.info[k] = v));
  }

  el.inspector.addEventListener('click', (e) => {
    const sel = e.target.closest('[data-select]');
    if (sel) return selectDevices([sel.dataset.select], { follow: true, focus: true });
    const bar = e.target.closest('.rack-bar[data-rack]');
    if (bar) selectThing('rack', bar.dataset.rack, { sheet: true, reveal: true });
  });

  // -------------------------------------------------------------- actions

  function moveDevice(id, loc, opts) {
    const d = M.deviceById(project, id);
    if (!d) return false;
    const check = M.canPlace(project, d.type, loc, id, d.height);
    if (!check.ok) {
      toast(check.reason, { warn: true });
      render();
      return false;
    }
    ui.selection = { kind: 'devices', ids: [id] };
    if (opts && opts.follow) {
      const row = rowOfRack(loc.rack);
      if (row !== ui.rowId) setRow(row, { render: false });
    }
    const changed = commit((p) => void (M.deviceById(p, id).loc = { rack: loc.rack, kind: loc.kind, at: loc.at }));
    if (!changed) render();
    if (opts && (opts.reveal || opts.follow)) revealDevice(id, opts.reveal);
    return changed;
  }

  function applyMoves(moves) {
    if (!moves || !moves.length) return false;
    const check = M.canMoveAll(project, moves);
    if (!check.ok) {
      toast(check.reason, { warn: true });
      return false;
    }
    ui.selection = { kind: 'devices', ids: moves.map((m) => m.id) };
    return commit((p) => void moves.forEach((m) => (M.deviceById(p, m.id).loc = { rack: m.loc.rack, kind: m.loc.kind, at: m.loc.at })));
  }

  // dir follows unit numbers: -1 moves up the rack (toward U1), +1 moves down.
  function nudge(id, dir, reveal) {
    const d = M.deviceById(project, id);
    if (!d || d.loc.kind !== 'u') return;
    const loc = M.nudgeTarget(project, d, dir);
    if (!loc) return toast(dir < 0 ? `No free space above ${d.name}` : `No free space below ${d.name}`, { warn: true });
    moveDevice(id, loc, { reveal });
  }

  function moveToRack(id, dir) {
    const d = M.deviceById(project, id);
    if (!d) return;
    const pos = M.locateRack(project, d.loc.rack);
    const rack = pos.row.racks[pos.index + dir];
    if (!rack) return;
    const same = { rack: rack.id, kind: d.loc.kind, at: d.loc.at };
    const near = d.loc.kind === 'u' ? d.loc.at : Math.ceil(M.rackUnits(project, rack) / 2);
    const loc = M.canPlace(project, d.type, same, id, d.height).ok ? same : M.nearestLoc(project, d.type, rack.id, near, id, d.loc.kind === 'side', d.height);
    if (!loc) return toast(`${rack.name} has no free space for ${d.name}`, { warn: true });
    moveDevice(id, loc, { reveal: true });
  }

  function groupNudge(dir) {
    const ids = selIds();
    const moves = M.groupNudge(project, ids, dir);
    if (!moves) return toast(dir < 0 ? 'No room above the selection' : 'No room below the selection', { warn: true });
    applyMoves(moves);
  }

  function groupToRack(dir) {
    const moves = M.shiftMoves(project, selIds(), dir, 0);
    if (!moves) return toast(dir < 0 ? 'There is no rack to the left' : 'There is no rack to the right', { warn: true });
    applyMoves(moves);
  }

  function duplicateDevice(id, at) {
    const d = M.deviceById(project, id);
    if (!d) return;
    const h = M.deviceHeight(project, d);
    let loc = at || null;
    if (!loc && d.loc.kind === 'u') {
      // Prefer the next free spot below, where the next name in series belongs.
      const below = M.planPositions(project, d.type, d.loc.rack, d.loc.at + h, 1, 1, null, d.height);
      const above = M.planPositions(project, d.type, d.loc.rack, d.loc.at - h, 1, -1, null, d.height);
      const u = below.length ? below[0] : above[0];
      if (u) loc = { rack: d.loc.rack, kind: 'u', at: u };
    } else if (!loc) {
      loc = M.nearestLoc(project, d.type, d.loc.rack, M.rackUnits(project, d.loc.rack), null, true, d.height);
    }
    if (!loc) {
      for (const r of currentRow().row.racks.concat(M.allRacks(project).map((x) => x.rack))) {
        loc = M.nearestLoc(project, d.type, r.id, d.loc.kind === 'u' ? d.loc.at : 24, null, false, d.height);
        if (loc) break;
      }
    }
    if (!loc) return toast(`No free space left for a copy of ${d.name}`, { warn: true });
    const check = M.canPlace(project, d.type, loc, null, d.height);
    if (!check.ok) return toast(check.reason, { warn: true });
    const [copy] = M.copiesAt(project, [{ id, loc }]);
    ui.selection = { kind: 'devices', ids: [copy.id] };
    const row = rowOfRack(loc.rack);
    if (row !== ui.rowId) setRow(row, { render: false });
    // A cable never joins a device to itself, so a single copy has none; copyCables is a no-op kept for symmetry.
    commit((p) => {
      p.devices.push(copy);
      M.copyCables(p, new Map([[id, copy.id]]));
    });
    toast(`Added ${copy.name} at ${M.formatDeviceLoc(project, copy)}`);
  }

  /** Duplicates the selected devices: one like duplicateDevice, several as a block. */
  function duplicateDevices(ids) {
    if (ids.length === 1) return duplicateDevice(ids[0]);
    const targets = M.copyTargets(project, ids);
    if (!targets) return toast(`No room left for a copy of the ${plural(ids.length, 'device')}`, { warn: true });
    copyGroup(targets, 'Duplicated');
    revealDevice(ui.selection.ids[0]);
  }

  /** Copies devices to `moves` ([{ id, loc }]) with the cables between them, in one undo step. */
  function copyGroup(moves, verb) {
    const copies = M.copiesAt(project, moves);
    // copiesAt keeps the order of `moves`, which maps each original to its copy.
    const idMap = new Map(moves.map((m, i) => [m.id, copies[i].id]));
    ui.selection = { kind: 'devices', ids: copies.map((c) => c.id) };
    let cables = 0;
    commit((p) => {
      p.devices.push(...copies);
      cables = M.copyCables(p, idMap).length;
    });
    const first = copies[0];
    toast(`${verb || 'Copied'} ${plural(copies.length, 'device')}${andCables(cables)}, from ${first.name} at ${M.formatDeviceLoc(project, first)}`, { action: 'Undo', onAction: undo });
  }

  /**
   * How many cables go when the devices `gone` (a Set of ids) go: the ones
   * that lose their head or every far end (a breakout that keeps a leg only
   * loses the others).
   */
  function cablesGoingWith(gone) {
    if (!project.cables.length || !gone.size) return 0;
    const work = Object.assign({}, project, { devices: project.devices.filter((d) => !gone.has(d.id)), cables: M.clone(project.cables) });
    M.pruneCables(work);
    return project.cables.length - work.cables.length;
  }
  /** " and 37 cables", or nothing without cables. */
  const andCables = (n) => (n ? ` and ${plural(n, 'cable')}` : '');
  const idSet = (devs) => new Set(devs.map((d) => d.id));
  /** "15 devices and 37 cables": the devices `devs` and the cables that go with them. */
  function devicesAndCables(devs) {
    return plural(devs.length, 'device') + andCables(cablesGoingWith(idSet(devs)));
  }
  /** "a, b and c" of the parts that are not empty. */
  function listAnd(parts) {
    const p = parts.filter(Boolean);
    return p.length > 1 ? `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}` : p.join('');
  }

  function deleteDevices(ids) {
    const devs = ids.map((id) => M.deviceById(project, id)).filter(Boolean);
    if (!devs.length) return;
    const gone = idSet(devs);
    const cables = cablesGoingWith(gone);
    ui.selection = null;
    commit((p) => {
      p.devices = p.devices.filter((x) => !gone.has(x.id));
      M.pruneCables(p);
    });
    toast(`Deleted ${devs.length === 1 ? devs[0].name : plural(devs.length, 'device')}${andCables(cables)}`, { action: 'Undo', onAction: undo });
  }

  function replaceProject(next) {
    ui.selection = null;
    ui.focusCluster = null;
    ui.hoverCluster = null;
    disarm();
    const ok = commit((p) => {
      Object.keys(p).forEach((k) => delete p[k]);
      Object.assign(p, M.clone(next));
      // Imports and a fresh start come checked, but no cable may point past the plan.
      M.pruneCables(p);
    });
    if (!M.rowById(project, ui.rowId)) ui.rowId = M.allRows(project)[0].row.id;
    render();
    return ok;
  }

  function ensureVisible(node) {
    const r = node.getBoundingClientRect();
    const c = el.canvas.getBoundingClientRect();
    const m = 32;
    if (r.top < c.top + m) el.canvas.scrollTop -= c.top + m - r.top;
    else if (r.bottom > c.bottom - m) el.canvas.scrollTop += Math.min(r.bottom - (c.bottom - m), r.top - (c.top + m));
    if (r.left < c.left + m) el.canvas.scrollLeft -= c.left + m - r.left;
    else if (r.right > c.right - m) el.canvas.scrollLeft += Math.min(r.right - (c.right - m), r.left - (c.left + m));
  }

  // ------------------------------------------------------------------ zoom

  function applyZoom() {
    el.svg.setAttribute('width', Math.round(ui.sceneW * ui.zoom));
    el.svg.setAttribute('height', Math.round(ui.sceneH * ui.zoom));
    el.zoomLevel.textContent = Math.round(ui.zoom * 100) + '%';
  }

  function setZoom(z, anchor, remember) {
    if (ui.view === 'map') return;
    const nz = clamp(Math.round(z * 1000) / 1000, 0.1, 3);
    const c = el.canvas;
    const cr = c.getBoundingClientRect();
    const ax = anchor ? anchor.clientX : cr.left + c.clientWidth / 2;
    const ay = anchor ? anchor.clientY : cr.top + c.clientHeight / 2;
    const before = el.svg.getBoundingClientRect();
    const sx = (ax - before.left) / ui.zoom;
    const sy = (ay - before.top) / ui.zoom;
    ui.zoom = nz;
    applyZoom();
    const after = el.svg.getBoundingClientRect();
    c.scrollLeft += after.left + sx * nz - ax;
    c.scrollTop += after.top + sy * nz - ay;
    if (remember !== false) {
      prefs.zoom = nz;
      savePrefs();
    }
  }

  // Fit the sheet's width, but never so small that labels become unreadable,
  // and show it from the top left.
  function fitWidth() {
    if (ui.view === 'map') return;
    fitZoom('width', false);
    if (ui.zoom < 0.5) setZoom(0.5, null, false);
    scrollToOrigin();
  }

  function scrollToOrigin() {
    el.canvas.scrollTop = 0;
    el.canvas.scrollLeft = 0;
  }

  function fitZoom(mode, remember) {
    if (ui.view === 'map') return;
    const cs = getComputedStyle(el.canvas);
    const cw = el.canvas.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ch = el.canvas.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const zw = cw / ui.sceneW;
    const zh = ch / ui.sceneH;
    setZoom(mode === 'width' ? Math.min(1, zw) : Math.min(zw, zh), null, remember);
    if (mode !== 'width') scrollToOrigin();
  }

  // --------------------------------------------------- pointer interaction

  function toScene(e) {
    const r = el.svg.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * ui.sceneW) / r.width, y: ((e.clientY - r.top) * ui.sceneH) / r.height };
  }

  function clusterColor(id) {
    const c = M.clusterById(project, id);
    return c ? c.color : null;
  }

  function drawGhost(typeId, loc, ok, device, height) {
    if (!loc) return setGhosts('');
    const hint = device ? null : M.suggestPlacement(project, typeId, loc, 1);
    const clusterId = device ? device.cluster : hint.cluster !== undefined ? hint.cluster : prefs.lastCluster;
    setGhosts(
      R.renderGhost(project, typeId, loc, ok, {
        theme: ui.theme,
        measure,
        layout: ui.layout,
        height: device ? device.height : height,
        color: clusterColor(clusterId),
        name: device ? device.name : hint.name,
        reversed: !!(device && device.reversed),
      })
    );
  }

  function drawGhosts(moves, ok) {
    const items = moves.map((m) => {
      const d = M.deviceById(project, m.id);
      return { typeId: d.type, loc: m.loc, height: d.height, name: d.name, color: clusterColor(d.cluster), reversed: !!d.reversed };
    });
    setGhosts(R.renderGhosts(project, items, ok, { theme: ui.theme, measure, layout: ui.layout, rowId: ui.rowId }));
  }

  function showChip(e, title, detail, state) {
    el.chip.hidden = false;
    el.chip.className = 'drag-chip' + (state ? ' ' + state : '');
    el.chip.innerHTML = `<span>${esc(title)}</span>${detail ? `<span class="mono">${esc(detail)}</span>` : ''}`;
    const x = Math.min(e.clientX + 16, window.innerWidth - el.chip.offsetWidth - 8);
    const y = Math.min(e.clientY + 18, window.innerHeight - el.chip.offsetHeight - 8);
    el.chip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }

  function hideDragFeedback() {
    el.chip.hidden = true;
    setGhosts('');
  }

  function capturePointer(node, pointerId) {
    try {
      node.setPointerCapture(pointerId);
    } catch (err) {
      /* pointer capture is a convenience */
    }
  }

  function startDrag(e, d) {
    ui.drag = Object.assign({ pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, loc: null, ok: false, copy: false, ids: [], moves: null }, d);
    capturePointer(d.captureEl, e.pointerId);
  }

  function autoScroll(e) {
    const c = el.canvas.getBoundingClientRect();
    const edge = 36;
    const step = 18;
    if (e.clientX < c.left + edge) el.canvas.scrollLeft -= step;
    else if (e.clientX > c.right - edge) el.canvas.scrollLeft += step;
    if (e.clientY < c.top + edge) el.canvas.scrollTop -= step;
    else if (e.clientY > c.bottom - edge) el.canvas.scrollTop += step;
  }

  function updateDrag(e) {
    const d = ui.drag;
    const copy = d.source === 'device' && e.altKey;
    if (copy !== d.copy && d.source === 'device') {
      d.copy = copy;
      for (const id of d.ids) {
        const src = findDevEl(id);
        if (src) src.classList.toggle('is-dragging', !copy);
      }
    }
    const c = el.canvas.getBoundingClientRect();
    const inside = e.clientX >= c.left && e.clientX <= c.right && e.clientY >= c.top && e.clientY <= c.bottom;
    if (inside) autoScroll(e);
    const pt = toScene(e);
    const primary = d.source === 'device' ? M.deviceById(project, d.deviceId) : null;
    const loc = inside ? R.locateDrop(project, ui.rowId, d.typeId, pt.x, pt.y, d.grab, primary ? primary.height : d.height) : null;
    d.loc = loc;
    d.moves = null;

    if (d.source === 'device' && d.ids.length > 1) {
      let check = { ok: false, reason: 'Drop it on a rack' };
      if (loc && loc.kind !== primary.loc.kind) check = { ok: false, reason: primary.loc.kind === 'u' ? 'Drop the group on rack units' : 'Drop the group on a side slot' };
      else if (loc) {
        const from = M.locateRack(project, primary.loc.rack);
        const to = M.locateRack(project, loc.rack);
        const moves = M.shiftMoves(project, d.ids, to.index - from.index, loc.kind === 'u' ? loc.at - primary.loc.at : 0);
        if (!moves) check = { ok: false, reason: 'Not enough racks in the row' };
        else {
          d.moves = moves;
          check = d.copy
            ? M.canAddAll(project, moves.map((m) => Object.assign({}, M.deviceById(project, m.id), { loc: m.loc })))
            : M.canMoveAll(project, moves);
        }
      }
      d.ok = check.ok;
      d.reason = check.ok ? '' : check.reason;
      if (d.moves) drawGhosts(d.moves, d.ok);
      else setGhosts('');
      const title = `${d.copy ? 'Copy' : 'Move'} ${plural(d.ids.length, 'device')}`;
      const detail = loc && d.ok ? `${loc.kind === 'u' ? 'by ' + (loc.at - primary.loc.at) + ' U' : 'side slots'}${d.moves && d.moves[0].loc.rack !== primary.loc.rack ? ', other racks' : ''}` : d.reason;
      return showChip(e, title, detail, loc ? (d.ok ? 'ok' : 'bad') : '');
    }

    const check = loc ? M.canPlace(project, d.typeId, loc, d.source === 'device' && !d.copy ? d.deviceId : null, primary ? primary.height : d.height) : null;
    d.ok = !!(check && check.ok);
    d.reason = check && !check.ok ? check.reason : '';
    drawGhost(d.typeId, loc, d.ok, primary, d.height);
    const title = primary ? (d.copy ? `Copy of ${primary.name}` : primary.name) : M.typeOf(project, d.typeId).label;
    const detail = loc ? (d.ok ? M.formatLoc(project, loc, d.typeId, primary ? primary.height : d.height) : d.reason) : 'Drop it on a rack';
    showChip(e, title, detail, loc ? (d.ok ? 'ok' : 'bad') : '');
  }

  function endDrag() {
    const d = ui.drag;
    ui.drag = null;
    document.body.classList.remove('is-dragging');
    hideDragFeedback();
    if (!d.active) {
      if (d.source === 'device') selectDevice(d.deviceId, true);
      return;
    }
    // A drag from the parts bin ends with a click on the card; ignore that one.
    if (d.source === 'palette') lastPaletteDragEnd = performance.now();
    if (!d.loc || !d.ok) {
      render();
      if (d.loc && d.reason) toast(d.reason, { warn: true });
      return;
    }
    if (d.source === 'palette') {
      render();
      openPlaceDialog(d.typeId, d.loc);
    } else if (d.moves) {
      if (d.copy) copyGroup(d.moves);
      else applyMoves(d.moves);
    } else if (d.copy) duplicateDevice(d.deviceId, d.loc);
    else moveDevice(d.deviceId, d.loc);
  }

  function cancelDrag() {
    if (!ui.drag) return;
    const wasActive = ui.drag.active;
    ui.drag = null;
    document.body.classList.remove('is-dragging');
    hideDragFeedback();
    if (wasActive) render();
  }

  function startPan(e) {
    ui.pan = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, sl: el.canvas.scrollLeft, st: el.canvas.scrollTop, moved: false, button: e.button };
    capturePointer(el.svg, e.pointerId);
  }

  // Shift-drag on the empty sheet selects the devices inside a rectangle.
  function startMarquee(e) {
    const pt = toScene(e);
    ui.marquee = { pointerId: e.pointerId, x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, add: e.ctrlKey || e.metaKey, base: selIds() };
    capturePointer(el.svg, e.pointerId);
  }
  function marqueeIds(m) {
    const x = Math.min(m.x0, m.x1);
    const y = Math.min(m.y0, m.y1);
    const w = Math.abs(m.x1 - m.x0);
    const h = Math.abs(m.y1 - m.y0);
    const ids = [];
    for (const r of ui.layout.racks) {
      for (const d of M.devicesWithin(project, r.rack.id)) {
        const b = R.locRect(project, d.loc, d.type, d.height, ui.layout);
        if (b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y) ids.push(d.id);
      }
    }
    return ids;
  }
  function updateMarquee(e) {
    const m = ui.marquee;
    const pt = toScene(e);
    m.x1 = pt.x;
    m.y1 = pt.y;
    autoScroll(e);
    const T = R.THEMES[ui.theme];
    const ids = marqueeIds(m);
    let s = `<rect x="${Math.min(m.x0, m.x1)}" y="${Math.min(m.y0, m.y1)}" width="${Math.abs(m.x1 - m.x0)}" height="${Math.abs(m.y1 - m.y0)}" fill="${T.handle}" fill-opacity="0.12" stroke="${T.select}" stroke-dasharray="4 3" pointer-events="none"/>`;
    for (const id of ids) {
      const d = M.deviceById(project, id);
      const b = R.locRect(project, d.loc, d.type, d.height, ui.layout);
      s += `<rect x="${b.x - 2}" y="${b.y - 2}" width="${b.w + 4}" height="${b.h + 4}" rx="2" fill="none" stroke="${T.select}" stroke-width="1.5" pointer-events="none"/>`;
    }
    setGhosts(s);
    showChip(e, `Select ${plural(ids.length, 'device')}`, m.add ? 'added to the selection' : '', ids.length ? 'ok' : '');
  }
  function endMarquee() {
    const m = ui.marquee;
    ui.marquee = null;
    hideDragFeedback();
    const ids = marqueeIds(m);
    selectDevices(m.add ? m.base.concat(ids) : ids);
  }

  // Parts bin: drag a part onto a rack, or click it to arm click-to-place.
  el.parts.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.part');
    if (!card || e.button !== 0 || e.pointerType === 'touch') return;
    e.preventDefault();
    if (ui.view === 'map') return;
    const type = M.typeOf(project, card.dataset.type);
    const h = startHeight(type);
    startDrag(e, { source: 'palette', typeId: type.id, height: h, grab: (h * G.U) / 2, captureEl: card });
  });
  el.parts.addEventListener('click', (e) => {
    const card = e.target.closest('.part');
    if (!card || performance.now() - lastPaletteDragEnd < 400) return;
    if (ui.view === 'map') setView('sheet');
    toggleArm(card.dataset.type);
  });

  function toggleArm(typeId) {
    ui.armed = ui.armed === typeId ? null : typeId;
    if (ui.armed) ui.selection = null;
    hideDragFeedback();
    render();
  }

  function disarm() {
    if (!ui.armed) return;
    ui.armed = null;
    hideDragFeedback();
    renderParts();
    renderChrome();
  }

  el.armedHint.addEventListener('click', (e) => {
    if (e.target.closest('[data-disarm]')) disarm();
  });

  el.svg.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button === 1) {
      e.preventDefault();
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    const press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    if (e.target.closest('.add-rack')) {
      if (e.pointerType === 'mouse') e.preventDefault();
      ui.press = Object.assign(press, { kind: 'add-rack' });
      return;
    }
    if (ui.armed) {
      if (e.pointerType === 'mouse') e.preventDefault();
      ui.press = Object.assign(press, { kind: 'armed' });
      return;
    }
    const devEl = e.target.closest('.dev');
    if (devEl) {
      const dev = M.deviceById(project, devEl.dataset.id);
      if (!dev) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        ui.press = Object.assign(press, { kind: 'toggle', id: dev.id });
        return;
      }
      if (e.pointerType === 'touch') {
        ui.press = Object.assign(press, { kind: 'device', id: dev.id });
        return;
      }
      e.preventDefault();
      const pt = toScene(e);
      const r = R.locRect(project, dev.loc, dev.type, dev.height, ui.layout);
      const h = M.deviceHeight(project, dev) * G.U;
      const grab = r.rotated ? h / 2 : clamp(pt.y - r.y, 0, h);
      const sel = selIds();
      const ids = sel.length > 1 && sel.includes(dev.id) ? sel : [dev.id];
      startDrag(e, { source: 'device', deviceId: dev.id, ids, typeId: dev.type, grab, captureEl: el.svg });
      return;
    }
    const head = e.target.closest('.rack-head');
    if (head) {
      if (e.pointerType === 'mouse') e.preventDefault();
      ui.press = Object.assign(press, { kind: 'rack', id: head.dataset.rack });
      return;
    }
    if (e.pointerType === 'mouse') {
      e.preventDefault();
      if (e.shiftKey || e.ctrlKey || e.metaKey) startMarquee(e);
      else startPan(e);
    } else {
      ui.press = Object.assign(press, { kind: 'bg' });
    }
  });

  /** Where the armed type would go at the pointer, and whether it fits there. */
  function armedTarget(e) {
    const type = M.typeOf(project, ui.armed);
    const h = startHeight(type);
    const pt = toScene(e);
    const loc = R.locateDrop(project, ui.rowId, type.id, pt.x, pt.y, (h * G.U) / 2, h);
    return { type, h, loc, check: loc ? M.canPlace(project, type.id, loc, null, h) : null };
  }

  el.svg.addEventListener('pointermove', (e) => {
    if (!ui.armed || ui.drag || e.pointerType === 'touch') return;
    const { type, h, loc, check } = armedTarget(e);
    drawGhost(type.id, loc, !!(check && check.ok), null, h);
    showChip(e, type.label, loc ? (check.ok ? M.formatLoc(project, loc, type.id, h) : check.reason) : 'Point at a rack', loc ? (check.ok ? 'ok' : 'bad') : '');
  });
  el.svg.addEventListener('pointerleave', () => {
    if (ui.armed && !ui.drag) hideDragFeedback();
  });

  function placeArmedAt(e) {
    const { type, loc, check } = armedTarget(e);
    if (!loc) return;
    if (!check.ok) return toast(check.reason, { warn: true });
    disarm();
    openPlaceDialog(type.id, loc);
  }

  window.addEventListener('pointermove', (e) => {
    const pan = ui.pan;
    if (pan && e.pointerId === pan.pointerId) {
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (!pan.moved && Math.hypot(dx, dy) < 4) return;
      pan.moved = true;
      el.canvas.classList.add('is-panning');
      el.canvas.scrollLeft = pan.sl - dx;
      el.canvas.scrollTop = pan.st - dy;
      return;
    }
    if (ui.marquee && e.pointerId === ui.marquee.pointerId) return updateMarquee(e);
    const d = ui.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
      d.active = true;
      document.body.classList.add('is-dragging');
      if (ui.armed) {
        ui.armed = null;
        renderParts();
        renderChrome();
      }
      if (d.source === 'device') {
        ui.selection = { kind: 'devices', ids: d.ids };
        render();
      }
    }
    updateDrag(e);
  });

  window.addEventListener('pointerup', (e) => {
    const pan = ui.pan;
    if (pan && e.pointerId === pan.pointerId) {
      ui.pan = null;
      el.canvas.classList.remove('is-panning');
      if (!pan.moved && pan.button === 0) clearSelection();
      return;
    }
    if (ui.marquee && e.pointerId === ui.marquee.pointerId) return endMarquee();
    if (ui.drag && e.pointerId === ui.drag.pointerId) return endDrag();
    const p = ui.press;
    ui.press = null;
    if (!p || p.pointerId !== e.pointerId || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) return;
    if (p.kind === 'armed') placeArmedAt(e);
    else if (p.kind === 'device') selectDevice(p.id, false);
    else if (p.kind === 'toggle') toggleDevice(p.id);
    else if (p.kind === 'rack') selectThing('rack', p.id);
    else if (p.kind === 'add-rack') addRackTo(ui.rowId);
    else if (p.kind === 'bg') clearSelection();
  });

  window.addEventListener('pointercancel', (e) => {
    if (ui.drag && e.pointerId === ui.drag.pointerId) cancelDrag();
    if (ui.pan && e.pointerId === ui.pan.pointerId) {
      ui.pan = null;
      el.canvas.classList.remove('is-panning');
    }
    if (ui.marquee && e.pointerId === ui.marquee.pointerId) {
      ui.marquee = null;
      hideDragFeedback();
    }
    ui.press = null;
  });

  // Keyboard focus on a device selects it, so Tab walks through the racks.
  el.svg.addEventListener('focusin', (e) => {
    const g = e.target.closest && e.target.closest('.dev');
    if (!g || ui.drag || restoringFocus) return;
    if (selSet().has(g.dataset.id)) return;
    ui.selection = { kind: 'devices', ids: [g.dataset.id] };
    render();
  });
  el.svg.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.add-rack')) {
      e.preventDefault();
      addRackTo(ui.rowId);
    }
  });

  el.canvas.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(ui.zoom * Math.exp(-e.deltaY * 0.0015), e);
    },
    { passive: false }
  );

  // ------------------------------------------------------ cluster sidebar

  el.clusters.addEventListener('click', (e) => {
    const rowEl = e.target.closest('.cl-row');
    if (!rowEl) return;
    const id = rowEl.dataset.cluster;
    if (e.target.closest('.cl-edit')) return openClusterDialog(id);
    if (e.target.closest('.cl-select')) {
      const devs = project.devices.filter((d) => (id === '__none' ? !d.cluster && d.type !== M.RESERVED.id : d.cluster === id));
      const inRow = devs.filter((d) => rowOfRack(d.loc.rack) === ui.rowId);
      selectDevices((inRow.length ? inRow : devs).map((d) => d.id), { follow: !inRow.length });
      if (inRow.length < devs.length) toast(`Selected ${plural(inRow.length || devs.length, 'device')}${inRow.length ? ' in this row' : ''} of ${devs.length}`);
      return;
    }
    if (e.target.closest('.cl-main')) {
      ui.focusCluster = ui.focusCluster === id ? null : id;
      ui.hoverCluster = null;
      render({ inspector: false });
    }
  });
  el.clusters.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const rowEl = e.target.closest('.cl-row');
    const id = rowEl ? rowEl.dataset.cluster : null;
    if (id === ui.hoverCluster) return;
    ui.hoverCluster = id;
    renderStage();
  });
  el.clusters.addEventListener('pointerleave', () => {
    if (!ui.hoverCluster) return;
    ui.hoverCluster = null;
    renderStage();
  });
  $('#btn-add-cluster').addEventListener('click', () => openClusterDialog(null));

  // ---------------------------------------------------------------- search

  function renderSearchResults() {
    const q = ui.query.trim();
    const res = M.search(project, q, 6);
    const groups = [
      ['floors', 'Floors', 'map'],
      ['rows', 'Rows', 'map'],
      ['racks', 'Racks', 'rack'],
      ['devices', 'Devices', 'rack'],
    ];
    const items = [];
    let html = '';
    for (const [key, label, kind] of groups) {
      if (!res[key].length) continue;
      const more = res.counts[key] - res[key].length;
      html += `<div class="sr-group" role="presentation"><span>${label}</span><span class="mono">${res.counts[key]}</span></div>`;
      for (const it of res[key]) {
        const i = items.length;
        items.push(it);
        html +=
          `<div class="sr-item${i === ui.searchActive ? ' is-active' : ''}" role="option" id="sr-${i}" data-i="${i}" aria-selected="${i === ui.searchActive}">` +
          `<span class="sr-kind">${icon(kind, 'ic-sm')}</span>` +
          `<span class="sr-name">${esc(it.name)}</span><span class="sr-detail">${esc(it.detail)}</span></div>`;
      }
      if (more > 0) html += `<div class="sr-more" role="presentation">and ${more} more${key === 'devices' ? ' (highlighted in the racks)' : ''}</div>`;
    }
    if (!items.length) html = `<div class="sr-empty" role="presentation">Nothing matches “${esc(q)}”.</div>`;
    else if (res.counts.devices) html += `<div class="sr-foot" role="presentation">Matching devices stay highlighted; <kbd>Esc</kbd> clears the search.</div>`;
    ui.searchItems = items;
    if (ui.searchActive >= items.length) ui.searchActive = items.length - 1;
    el.searchResults.innerHTML = html;
    el.searchResults.hidden = false;
    el.search.setAttribute('aria-expanded', 'true');
    el.search.setAttribute('aria-activedescendant', ui.searchActive >= 0 ? `sr-${ui.searchActive}` : '');
    const active = el.searchResults.querySelector('.is-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function focusSearch() {
    el.search.focus();
    el.search.select();
  }

  function closeSearch() {
    ui.searchOpen = false;
    el.searchResults.hidden = true;
    el.search.setAttribute('aria-expanded', 'false');
    el.search.removeAttribute('aria-activedescendant');
  }

  function setQuery(q) {
    ui.query = q;
    ui.searchActive = q.trim() ? 0 : -1;
    ui.searchOpen = !!q.trim();
    if (ui.searchOpen) renderSearchResults();
    else closeSearch();
    renderStage();
  }

  function chooseResult(it) {
    closeSearch();
    if (it.kind === 'device') {
      el.search.blur();
      selectDevices([it.id], { follow: true, focus: true });
    } else if (it.kind === 'rack') selectThing('rack', it.id, { sheet: true, reveal: true });
    else if (it.kind === 'row') {
      setRow(it.id, { view: 'sheet', render: false });
      selectThing('row', it.id);
    } else if (it.kind === 'floor') {
      const floor = M.floorById(project, it.id);
      setRow(floor.rows[0].id, { view: 'map', render: false });
      selectThing('floor', it.id);
    }
  }

  el.search.addEventListener('input', () => setQuery(el.search.value));
  el.search.addEventListener('focus', () => {
    if (ui.query.trim()) {
      ui.searchOpen = true;
      renderSearchResults();
    }
  });
  el.search.addEventListener('blur', () => setTimeout(() => document.activeElement !== el.search && closeSearch(), 120));
  el.search.addEventListener('keydown', (e) => {
    const n = ui.searchItems.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!ui.searchOpen && ui.query.trim()) ui.searchOpen = true;
      if (n) ui.searchActive = (ui.searchActive + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      renderSearchResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = ui.searchItems[Math.max(0, ui.searchActive)];
      if (ui.searchOpen && it) chooseResult(it);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (ui.searchOpen) closeSearch();
      else {
        el.search.value = '';
        setQuery('');
        el.search.blur();
      }
    }
  });
  // Keep focus in the field while clicking a result.
  el.searchResults.addEventListener('pointerdown', (e) => e.preventDefault());
  el.searchResults.addEventListener('click', (e) => {
    const item = e.target.closest('.sr-item');
    if (item) chooseResult(ui.searchItems[Number(item.dataset.i)]);
  });

  // --------------------------------------------------------------- dialogs

  function openDialog(dlg) {
    closeMenus();
    closeSearch();
    if (!dlg.open) dlg.showModal();
    hostToasts();
  }

  // Close on Cancel buttons and on a click on the backdrop.
  $$('dialog').forEach((dlg) => {
    let downOnBackdrop = false;
    dlg.addEventListener('pointerdown', (e) => (downOnBackdrop = e.target === dlg));
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) dlg.close('cancel');
      else if (e.target === dlg && downOnBackdrop) dlg.close('cancel');
    });
  });

  function showError(sel, msg) {
    const node = $(sel);
    node.textContent = msg || '';
    node.hidden = !msg;
  }

  function renderSwatches(container, name, value, onChange) {
    const preset = M.CLUSTER_COLORS.includes(value);
    container.innerHTML =
      M.CLUSTER_COLORS.map(
        (c, i) =>
          `<label class="swatch" title="${COLOR_NAMES[i]}"><input type="radio" name="${name}" value="${c}"${c === value ? ' checked' : ''} aria-label="${COLOR_NAMES[i]}"><span style="--c:${c}"></span></label>`
      ).join('') +
      `<label class="swatch custom${preset ? '' : ' is-on'}" title="Custom color"><input type="color" value="${value}" aria-label="Custom color">` +
      `<span style="--c:${value}">${preset ? icon('plus', 'ic-sm') : ''}</span></label>`;
    const custom = container.querySelector('.custom');
    container.onchange = container.oninput = (e) => {
      const t = e.target;
      if (t.type === 'radio' && t.checked) {
        custom.classList.remove('is-on');
        custom.querySelector('span').innerHTML = icon('plus', 'ic-sm');
        onChange(t.value);
      } else if (t.type === 'color') {
        const hex = M.normalizeHex(t.value);
        if (!hex) return;
        $$('input[type="radio"]', container).forEach((r) => (r.checked = false));
        custom.classList.add('is-on');
        const span = custom.querySelector('span');
        span.style.setProperty('--c', hex);
        span.innerHTML = '';
        onChange(hex);
      }
    };
  }

  // Place dialog -------------------------------------------------------

  const place = { typeId: null, loc: null, nameTouched: false, newColor: null, positions: [], valid: true };

  function openPlaceDialog(typeId, loc) {
    const type = M.typeOf(project, typeId);
    Object.assign(place, { typeId, loc, nameTouched: false, positions: [], valid: true });
    const row = M.locateRack(project, loc.rack).row;
    $('#place-title').textContent = type.label;
    $('#place-where').textContent = `${M.formatLoc(project, loc, typeId, type.variable && loc.kind === 'u' ? 2 : 1)} · ${M.formatTypeSpec(type)}`;
    $('#place-height-field').hidden = !type.variable;
    $('#place-height').value = loc.kind === 'side' ? '1' : '2';
    $('#place-height').max = String(M.rackUnits(project, loc.rack));
    $('#place-qty-field').hidden = loc.kind !== 'u';
    $('#place-dir-field').hidden = loc.kind !== 'u';
    $('#place-qty').value = '1';
    $('input[name="place-dir"][value="down"]').checked = true;
    const canSpread = loc.kind === 'u' && row.racks.length > 1;
    $('#place-spread-wrap').hidden = !canSpread;
    $('#place-spread').checked = false;
    $('#place-racks').hidden = true;
    const start = row.racks.findIndex((r) => r.id === loc.rack);
    $('#place-racks').innerHTML = row.racks
      .map(
        (r, i) =>
          `<label class="chip chip-check"><input type="checkbox" value="${esc(r.id)}"${i >= start ? ' checked' : ''}><span>${esc(shortRack(r.name))}</span></label>`
      )
      .join('');
    const hint = M.suggestPlacement(project, typeId, loc, 1);
    const last = prefs.lastCluster && M.clusterById(project, prefs.lastCluster) ? prefs.lastCluster : null;
    const initial = hint.cluster !== undefined ? hint.cluster : type.variable ? null : last || (project.clusters.length ? null : '__new');
    $('#place-clusters').innerHTML = clusterChips('place-cluster', initial, true);
    place.newColor = M.nextClusterColor(project);
    $('#place-new-name').value = M.nextClusterName(project);
    renderSwatches($('#place-new-colors'), 'place-new-color', place.newColor, (c) => (place.newColor = c));
    $('#place-new').hidden = initial !== '__new';
    showError('#place-error', '');
    openDialog($('#dlg-place'));
    updatePlacePreview();
    const name = $('#place-name');
    name.focus();
    name.select();
  }

  function placeHeight() {
    const type = M.typeOf(project, place.typeId);
    return type.variable ? M.clampInt($('#place-height').value, 1, M.rackUnits(project, place.loc.rack), 1) : undefined;
  }

  function updatePlacePreview() {
    // Its inputs can still change while closed (the browser's own undo).
    if (!$('#dlg-place').open) return;
    const type = M.typeOf(project, place.typeId);
    const height = placeHeight();
    const qtyInput = $('#place-qty');
    let qty = parseInt(qtyInput.value, 10);
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    const dir = $('input[name="place-dir"]:checked').value === 'up' ? -1 : 1;
    const nameInput = $('#place-name');
    if (!place.nameTouched) nameInput.value = M.suggestPlacement(project, type.id, place.loc, qty).name;
    const line = $('#place-preview');
    const submit = $('#place-submit');
    line.classList.remove('bad');
    line.textContent = '';
    place.valid = true;
    const loc = place.loc;
    if (loc.kind !== 'u') {
      const check = M.canPlace(project, type.id, loc, null, height);
      place.positions = [{ rack: loc.rack, at: loc.at }];
      place.valid = check.ok;
      line.textContent = check.ok ? '' : check.reason;
      line.classList.toggle('bad', !check.ok);
      line.hidden = check.ok;
      submit.textContent = 'Place';
      submit.disabled = !place.valid;
      return;
    }
    const spread = !$('#place-spread-wrap').hidden && $('#place-spread').checked;
    $('#place-racks').hidden = !spread;
    let max;
    if (spread) {
      const racks = $$('#place-racks input:checked').map((i) => i.value);
      place.positions = M.planSpread(project, type.id, racks, loc.at, qty, dir, height);
      max = M.planSpread(project, type.id, racks, loc.at, Infinity, dir, height).length;
      if (!racks.length) {
        place.valid = false;
        line.classList.add('bad');
        line.textContent = 'Pick the racks to spread over.';
      }
    } else {
      place.positions = M.planPositions(project, type.id, loc.rack, loc.at, qty, dir, null, height).map((at) => ({ rack: loc.rack, at }));
      max = M.planPositions(project, type.id, loc.rack, loc.at, Infinity, dir, null, height).length;
      // The first device goes where it was dropped (a taller reservation may no longer fit there).
      const here = M.canPlace(project, type.id, loc, null, height);
      if (!here.ok) {
        place.valid = false;
        line.classList.add('bad');
        line.textContent = here.reason;
      }
    }
    qtyInput.max = String(Math.max(1, max));
    if (!place.valid) {
      /* message set above */
    } else if (place.positions.length < qty) {
      place.valid = false;
      line.classList.add('bad');
      line.textContent = `Only ${max} fit ${dir < 0 ? 'upward' : 'downward'} from U${loc.at} in ${spread ? 'these racks' : 'this rack'}.`;
    } else if (!place.positions.length) {
      place.valid = false;
      line.classList.add('bad');
      line.textContent = M.canPlace(project, type.id, loc, null, height).reason || 'It does not fit here.';
    } else if (qty > 1 || spread) {
      const names = M.nameSequence(nameInput.value.trim(), qty);
      const per = new Map();
      for (const p of place.positions) per.set(p.rack, (per.get(p.rack) || 0) + 1);
      const h = M.heightOf(project, type.id, height);
      const lo = Math.min(...place.positions.map((p) => p.at));
      const hi = Math.max(...place.positions.map((p) => p.at)) + h - 1;
      const where =
        per.size > 1
          ? [...per].map(([r, n]) => `${shortRack(M.rackById(project, r).name)} ×${n}`).join(', ')
          : M.formatSpan(lo, hi);
      line.textContent = `${names[0]}${qty > 1 ? ` … ${names[qty - 1]}` : ''} · ${where}`;
    }
    line.hidden = !line.textContent;
    submit.textContent = qty > 1 ? `Place ${qty}` : 'Place';
    submit.disabled = !place.valid;
  }

  $('#place-name').addEventListener('input', () => {
    place.nameTouched = true;
    showError('#place-error', '');
    updatePlacePreview();
  });
  $('#place-qty').addEventListener('input', updatePlacePreview);
  $('#place-height').addEventListener('input', updatePlacePreview);
  $('#place-spread').addEventListener('change', updatePlacePreview);
  $('#place-racks').addEventListener('change', updatePlacePreview);
  $$('input[name="place-dir"]').forEach((r) => r.addEventListener('change', updatePlacePreview));
  $('#place-clusters').addEventListener('change', (e) => {
    if (e.target.name !== 'place-cluster') return;
    const isNew = e.target.value === '__new';
    $('#place-new').hidden = !isNew;
    if (isNew) $('#place-new-name').select();
  });

  $('#place-form').addEventListener('submit', (e) => {
    e.preventDefault();
    updatePlacePreview();
    if (!place.valid) return;
    const type = M.typeOf(project, place.typeId);
    const name = $('#place-name').value.trim();
    if (!name) {
      showError('#place-error', 'Give the device a name.');
      $('#place-name').focus();
      return;
    }
    const picked = ($('input[name="place-cluster"]:checked') || { value: '' }).value;
    let newCluster = null;
    if (picked === '__new') {
      const cname = $('#place-new-name').value.trim();
      if (!cname) {
        showError('#place-error', 'Name the new cluster, or pick another one.');
        $('#place-new-name').focus();
        return;
      }
      newCluster = { id: M.uid('c'), name: cname, color: place.newColor };
    }
    const clusterId = newCluster ? newCluster.id : picked || null;
    const count = place.positions.length;
    const names = M.nameSequence(name, count);
    const height = placeHeight();
    const devices = place.positions.map((pos, i) =>
      M.newDevice(
        Object.assign(
          { type: type.id, name: names[i], cluster: clusterId, loc: { rack: pos.rack, kind: place.loc.kind, at: place.loc.kind === 'u' ? pos.at : place.loc.at } },
          type.variable ? { height } : {}
        )
      )
    );
    ui.selection = { kind: 'devices', ids: count > 1 ? devices.map((d) => d.id) : [devices[0].id] };
    commit((p) => {
      if (newCluster) p.clusters.push(newCluster);
      p.devices.push(...devices);
    });
    if (!type.variable) {
      prefs.lastCluster = clusterId;
      savePrefs();
    }
    $('#dlg-place').close('ok');
    toast(count > 1 ? `Placed ${count} devices, ${names[0]} to ${names[count - 1]}` : `Placed ${names[0]}`);
  });

  // Cluster dialog -----------------------------------------------------

  const clusterDlg = { id: null, color: null, onCreate: null, onCancel: null, saved: false };

  function openClusterDialog(id, onCreate, onCancel) {
    const c = id ? M.clusterById(project, id) : null;
    Object.assign(clusterDlg, {
      id: c ? c.id : null,
      color: c ? c.color : M.nextClusterColor(project),
      onCreate: onCreate || null,
      onCancel: onCancel || null,
      saved: false,
    });
    $('#cluster-kicker').textContent = c ? 'Edit cluster' : 'New cluster';
    $('#cluster-title').textContent = c ? c.name : 'Create a cluster';
    $('#cluster-name').value = c ? c.name : M.nextClusterName(project);
    $('#cluster-delete').hidden = !c;
    $('#cluster-submit').textContent = c ? 'Save' : 'Create';
    renderSwatches($('#cluster-colors'), 'cluster-color', clusterDlg.color, (col) => {
      clusterDlg.color = col;
      updateClusterPreview();
    });
    showError('#cluster-error', '');
    updateClusterPreview();
    openDialog($('#dlg-cluster'));
    $('#cluster-name').focus();
    $('#cluster-name').select();
  }

  function updateClusterPreview() {
    const name = $('#cluster-name').value.trim() || 'cluster';
    const sample = (name.toLowerCase().match(/[a-z0-9]+/) || ['node'])[0].slice(0, 8);
    const type = M.typeOf(project, 'compute-node') || project.deviceTypes.find((t) => t.height === 2) || M.cleanDeviceType({ height: 2, face: 'compute' });
    const pv = R.renderPreview(type, ui.theme, clusterDlg.color, `${sample}-01`);
    $('#cluster-preview').innerHTML = `<svg viewBox="0 0 ${pv.width} ${pv.height}">${pv.body}</svg>`;
  }

  $('#cluster-name').addEventListener('input', () => {
    showError('#cluster-error', '');
    updateClusterPreview();
  });

  $('#cluster-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#cluster-name').value.trim();
    if (!name) {
      showError('#cluster-error', 'Give the cluster a name.');
      return;
    }
    const color = clusterDlg.color;
    if (clusterDlg.id) {
      const id = clusterDlg.id;
      commit((p) => {
        const c = M.clusterById(p, id);
        c.name = name;
        c.color = color;
      });
    } else {
      const nc = { id: M.uid('c'), name, color };
      const onCreate = clusterDlg.onCreate;
      commit((p) => {
        p.clusters.push(nc);
        if (onCreate) onCreate(p, nc.id);
      });
      prefs.lastCluster = nc.id;
      savePrefs();
    }
    clusterDlg.saved = true;
    $('#dlg-cluster').close('ok');
  });

  $('#dlg-cluster').addEventListener('close', () => {
    if (!clusterDlg.saved && clusterDlg.onCancel) clusterDlg.onCancel();
  });

  $('#cluster-delete').addEventListener('click', async () => {
    const id = clusterDlg.id;
    const c = M.clusterById(project, id);
    if (!c) return;
    const count = project.devices.filter((d) => d.cluster === id).length;
    $('#dlg-cluster').close('cancel');
    const ok =
      !count ||
      (await confirmDialog({
        title: `Delete ${c.name}?`,
        body: `Its ${plural(count, 'device')} stay in place but lose their cluster color. Undo brings the cluster back.`,
        ok: 'Delete cluster',
      }));
    if (!ok) return;
    commit((p) => {
      p.clusters = p.clusters.filter((x) => x.id !== id);
      p.devices.forEach((d) => {
        if (d.cluster === id) d.cluster = null;
      });
    });
    toast(`Deleted cluster ${c.name}`, { action: 'Undo', onAction: undo });
  });

  // Confirm and report dialogs -----------------------------------------

  function confirmDialog(o) {
    return new Promise((resolve) => {
      const dlg = $('#dlg-confirm');
      $('#confirm-title').textContent = o.title;
      $('#confirm-body').textContent = o.body;
      $('#confirm-ok').textContent = o.ok || 'OK';
      dlg.returnValue = '';
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      openDialog(dlg);
      $('#confirm-ok').focus();
    });
  }

  function reportWarnings(title, sub, warnings) {
    if (!warnings.length) return;
    $('#report-title').textContent = title;
    $('#report-sub').textContent = sub;
    const shown = warnings.slice(0, 200);
    $('#report-list').innerHTML =
      shown.map((w) => `<li>${esc(w)}</li>`).join('') + (warnings.length > shown.length ? `<li>… and ${warnings.length - shown.length} more (see the browser console)</li>` : '');
    if (warnings.length > shown.length) console.warn('Rackplanner import:', warnings);
    openDialog($('#dlg-report'));
  }

  // Catalog dialog -----------------------------------------------------

  /**
   * The catalog's state: the tab and the selected type, the part of a device
   * type shown ('general' or 'ports'), an error shown again after a redraw,
   * a refused value kept in its field ({ id, value }), a field to focus
   * after the next redraw, and the pointer guard of refreshCatalog.
   */
  const cat = { tab: 'devices', id: null, sub: 'general', error: '', keep: null, focus: null, pressed: false, pending: false, skipClick: false };
  // Stock lengths of cable types made to length in this session, given back when they are unticked.
  const lastLengths = new Map();

  function openCatalog(tab, id) {
    cat.tab = tab || cat.tab;
    cat.sub = 'general';
    selectCatalogItem(id || null);
    openDialog($('#dlg-catalog'));
  }

  function selectCatalogItem(id) {
    cat.id = id;
    cat.error = '';
    cat.keep = null;
    renderCatalog();
  }

  const catTab = () => CAT_TABS[cat.tab] || CAT_TABS.devices;
  function catalogUse(tab, id) {
    return CAT_TABS[tab].use(id);
  }

  function renderCatalog() {
    // This render does what a deferred one would have.
    cat.pending = false;
    const tab = catTab();
    const list = tab.list();
    if (!list.some((t) => t.id === cat.id)) cat.id = list.length ? list[0].id : null;
    // Only the catalog's own tabs: the device type's General | Ports switch is no tab.
    for (const b of $$('#dlg-catalog .dlg-head [role="tab"]')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === cat.tab));
      // On a phone the tabs scroll sideways: keep the selected one in sight.
      if (b.dataset.tab === cat.tab && $('#dlg-catalog').open) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    const active = document.activeElement;
    const focusId = cat.focus || (active && $('#cat-form').contains(active) ? active.id : null);
    cat.focus = null;
    // A text field focused again keeps its caret and selection.
    const caret = active && active.id === focusId && /^(text|search|number)?$/.test(active.getAttribute('type') || '') && active.tagName === 'INPUT' ? [active.selectionStart, active.selectionEnd] : null;
    $('#cat-list').dataset.tab = cat.tab;
    $('#cat-list').innerHTML = list
      .map((t) => {
        const n = tab.use(t.id);
        return (
          `<button type="button" role="option" class="cat-item" data-id="${esc(t.id)}" aria-selected="${t.id === cat.id}">` +
          `<span class="cat-grip" title="Drag to reorder" aria-hidden="true">${icon('grip', 'ic-sm')}</span>` +
          `${tab.art(t)}<span class="cat-meta"><span class="cat-name">${esc(tab.name(t))}</span><span class="cat-sub">${esc(tab.sub(t))}</span></span>` +
          `<span class="cat-count" title="${esc(tab.useText(n))}">${n}</span></button>`
        );
      })
      .join('');
    const sel = cat.id ? tab.byId(project, cat.id) : null;
    $('#menu-cat-new').innerHTML =
      tab
        .templates()
        .map(([key, label, sub]) => `<button type="button" role="menuitem" data-template="${esc(String(key))}"><span>${esc(label)}</span><small>${esc(sub)}</small></button>`)
        .join('') +
      (sel ? `<hr><button type="button" role="menuitem" data-template="copy"><span>Copy of the selected ${tab.noun}</span><small>${esc(tab.name(sel))}</small></button>` : '');
    $('#cat-form').innerHTML = sel ? tab.form(sel) : `<p class="empty-note">${esc(tab.empty)}</p>`;
    const kept = cat.keep && document.getElementById(cat.keep.id);
    if (kept) kept.value = cat.keep.value;
    if (cat.error) showError('#cat-error', cat.error);
    const f = focusId && (focusId.startsWith('@') ? catTabbables()[Number(focusId.slice(1))] : document.getElementById(focusId));
    if (f && !f.disabled) f.focus();
    if (f && caret && caret[0] !== null && f.tagName === 'INPUT' && f.value === active.value) {
      try {
        f.setSelectionRange(caret[0], caret[1]);
      } catch (e) {
        // A field type without a caret.
      }
    }
  }

  /**
   * Redraws the catalog, but not while a pointer is down in it: a field
   * commits on blur, which happens on pointerdown, and rebuilding the
   * buttons then would swallow the click that follows.
   */
  function refreshCatalog() {
    if (cat.pressed) cat.pending = true;
    else renderCatalog();
  }
  $('#dlg-catalog').addEventListener('pointerdown', () => (cat.pressed = true));
  window.addEventListener('pointerup', () => {
    if (!cat.pressed) return;
    cat.pressed = false;
    // After the click that belongs to this pointerup.
    // Not when that click has redrawn the catalog already.
    if (cat.pending) setTimeout(() => {
      if (cat.pending && $('#dlg-catalog').open) renderCatalog();
    });
  });

  /** Buttons moving the selected type up or down its list. */
  function orderButtons(list, id) {
    const i = list.findIndex((t) => t.id === id);
    return (
      `<button type="button" class="btn icon sm" data-cat-move="-1" title="Move up (Alt+↑)" aria-label="Move up in the list"${i <= 0 ? ' disabled' : ''}>${icon('up')}</button>` +
      `<button type="button" class="btn icon sm" data-cat-move="1" title="Move down (Alt+↓)" aria-label="Move down in the list"${i >= list.length - 1 ? ' disabled' : ''}>${icon('down')}</button>`
    );
  }

  /** The bar under a form: order buttons, how much uses the type, and Delete. */
  function catActions(list, t, n, attrs) {
    return (
      `<p class="form-error" id="cat-error" role="alert" hidden></p>` +
      `<div class="cat-actions">${orderButtons(list, t.id)}<span class="sec-hint">${esc(catTab().useText(n))}</span><span class="spacer"></span>` +
      `<button type="button" class="btn sm danger-text" id="cat-delete"${attrs || ''}>${icon('trash')}Delete ${catTab().noun}</button></div>`
    );
  }

  const options = (list, cur) => list.map(([v, label]) => `<option value="${esc(String(v))}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const svgArt = (w, h, body) => `<svg class="cat-art" viewBox="0 0 ${w} ${h}" aria-hidden="true">${body}</svg>`;
  const previewSVG = (pv) => `<svg viewBox="0 0 ${pv.width} ${pv.height}" aria-hidden="true">${pv.body}</svg>`;
  const connName = (id) => (M.connectorById(id) || { label: id }).label;

  // Device types: General | Ports -------------------------------------

  function deviceTypeForm(t) {
    const b = (sub, text) => `<button type="button" id="cat-sub-${sub}" data-cat-sub="${sub}" aria-pressed="${cat.sub === sub}">${text}</button>`;
    return (
      `<div class="seg cat-subs" role="group" aria-label="Part of the type">${b('general', 'General')}${b('ports', `Ports · ${M.expandPorts(t).length}`)}</div>` +
      (cat.sub === 'ports' ? portsForm(t) : generalForm(t))
    );
  }

  function generalForm(t) {
    const n = catalogUse('devices', t.id);
    const pv = R.renderPreview(t, ui.theme, '#2f6fdb', t.defaultName, measure);
    const faces = M.FACES.map((f) => `<option value="${f.id}"${f.id === t.face ? ' selected' : ''}>${esc(f.label)}</option>`).join('');
    return (
      `<div class="cat-preview">${previewSVG(pv)}</div>` +
      `<div class="field-grid cat-fields">` +
      `<div class="field span2"><label for="cat-label">Name</label><input id="cat-label" data-prop="label" type="text" value="${esc(t.label)}" maxlength="60" autocomplete="off"></div>` +
      `<div class="field"><label for="cat-tag">Tag on the front</label><input id="cat-tag" data-prop="tag" type="text" value="${esc(t.tag)}" maxlength="12" autocomplete="off"></div>` +
      `<div class="field"><label for="cat-height">Height (U)</label><input id="cat-height" data-prop="height" data-num type="number" min="1" max="${M.LIMITS.deviceHeight}" step="1" value="${t.height}"></div>` +
      `<div class="field span2"><label for="cat-face">Drawing</label><select id="cat-face" data-prop="face">${faces}</select></div>` +
      `<div class="field span2"><label for="cat-spec">Description</label><input id="cat-spec" data-prop="spec" type="text" value="${esc(t.spec)}" maxlength="60" placeholder="48 × RJ45, 24 bays …" autocomplete="off"></div>` +
      `<div class="field span2"><label for="cat-default">First name</label><input id="cat-default" class="mono" data-prop="defaultName" type="text" value="${esc(t.defaultName)}" maxlength="80" autocomplete="off" spellcheck="false"></div>` +
      `<div class="field"><label for="cat-power">Power (W)</label><input id="cat-power" data-prop="powerW" data-num type="number" min="0" step="10" value="${t.powerW}"></div>` +
      `<div class="field"><label for="cat-weight">Weight (kg)</label><input id="cat-weight" data-prop="weightKg" data-num type="number" min="0" step="0.5" value="${t.weightKg}"></div>` +
      `</div>` +
      catActions(project.deviceTypes, t, n)
    );
  }

  const SPEEDS = [0.1, 1, 10, 25, 40, 50, 100, 200, 400, 800];
  const SIDES = [
    ['front', 'Front'],
    ['rear', 'Rear'],
  ];

  function portsForm(t) {
    const front = R.renderPreview(t, ui.theme, null, t.defaultName, measure, undefined, 'front');
    const rear = R.renderPreview(t, ui.theme, null, t.defaultName, measure, undefined, 'rear');
    const conns = M.CONNECTORS.map((c) => [c.id, c.label]);
    const rows = t.ports
      .map((g, i) => {
        const pattern = M.portPattern(g);
        const speeds = (SPEEDS.includes(g.speedGbps) ? SPEEDS : SPEEDS.concat(g.speedGbps).sort((a, b) => a - b)).map((s) => [s, C.shortSpeed(s) || 'not rated']);
        const id = (k) => `cat-pg-${i}-${k}`;
        return (
          `<tr><td><input id="${id('names')}" class="mono" type="text" data-pg="${i}" data-pg-prop="names" value="${esc(pattern)}" maxlength="48" autocomplete="off" spellcheck="false" aria-label="Names of port group ${i + 1}"></td>` +
          `<td><select id="${id('connector')}" data-pg="${i}" data-pg-prop="connector" aria-label="Connector of ${esc(pattern)}">${options(conns, g.connector)}</select></td>` +
          `<td><select id="${id('speed')}" data-pg="${i}" data-pg-prop="speedGbps" aria-label="Speed of ${esc(pattern)}">${options(speeds, g.speedGbps)}</select></td>` +
          `<td><select id="${id('side')}" data-pg="${i}" data-pg-prop="side" aria-label="Side of ${esc(pattern)}">${options(SIDES, g.side)}</select></td>` +
          `<td class="pt-count mono">${M.groupNames(g).length}</td>` +
          `<td><button type="button" class="btn icon sm subtle" id="${id('del')}" data-pg-del="${i}" title="Remove these ports" aria-label="Remove ${esc(pattern)}">${icon('trash')}</button></td></tr>`
        );
      })
      .join('');
    const others = project.deviceTypes.filter((x) => x.id !== t.id && x.ports.length);
    const devs = new Set(project.devices.filter((d) => d.type === t.id).map((d) => d.id));
    let cabled = 0;
    for (const c of project.cables) for (const x of M.cableEnds(c)) if (devs.has(x.end.device)) cabled++;
    const full = t.ports.length >= M.LIMITS.portGroups;
    return (
      `<div class="cat-preview cat-preview-2"><span class="cat-side">Front</span>${previewSVG(front)}<span class="cat-side">Rear</span>${previewSVG(rear)}</div>` +
      (t.ports.length
        ? `<div class="pt-wrap"><table class="pt-table"><thead><tr><th scope="col">Names</th><th scope="col">Connector</th><th scope="col">Speed</th><th scope="col">Side</th>` +
          `<th scope="col" class="pt-count">Ports</th><th><span class="sr-only">Remove</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="empty-note">No ports yet. Add a group, or copy the ports of another type.</p>`) +
      `<p class="form-error" id="cat-error" role="alert" hidden></p>` +
      `<div class="cat-actions">` +
      `<button type="button" class="btn sm" id="cat-pg-add"${full ? ` disabled title="A device type has at most ${M.LIMITS.portGroups} port groups"` : ''}>${icon('plus', 'ic-sm')}Add ports</button>` +
      `<div class="menu-wrap"><button type="button" class="btn sm subtle" id="cat-pg-copy" aria-haspopup="menu" aria-expanded="false" aria-controls="cat-pg-menu"${others.length ? '' : ' disabled'}>Copy ports from…${icon('chevron', 'ic-sm')}</button>` +
      `<div class="menu" id="cat-pg-menu" role="menu" hidden>` +
      others.map((x) => `<button type="button" role="menuitem" data-pg-copy="${esc(x.id)}"><span>${esc(x.label)}</span><small>${esc(x.ports.map(M.portPattern).join(', '))}</small></button>`).join('') +
      `</div></div></div>` +
      `<p class="sec-hint">A range in brackets names a series: swp[1-48] is swp1 … swp48, Ethernet1/[1-32] works too; a plain name such as bmc is one port. Side is the device’s own side: a device mounted back to front has its front ports at the rack’s rear.</p>` +
      `<div class="field-grid"><div class="field"><label for="cat-slack">Slack per cable (m)</label>` +
      `<input id="cat-slack" data-prop="slackM" data-num type="number" min="0" max="10" step="0.05" inputmode="decimal" value="${t.slackM}"></div>` +
      `<p class="sec-hint cat-slack-hint">Extra length a cable gets at a device of this type; a device can set its own.</p></div>` +
      (devs.size
        ? `<p class="cat-note">${icon('info', 'ic-sm')}<span>${plural(devs.size, 'device')} of this type ${devs.size === 1 ? 'has' : 'have'} ${plural(cabled, 'port')} cabled. A change that unplugs cables names them before it applies.</span></p>`
        : '')
    );
  }

  /** Group `i` of the ports of `t` changed: its names (a pattern), connector, speed or side. A message why when the names are no pattern. */
  function editedPorts(t, i, prop, value) {
    const ports = M.clone(t.ports);
    const g = ports[i];
    if (!g) return ports;
    if (prop === 'names') {
      const problem = M.portPatternProblem(value);
      if (problem) return problem;
      const parsed = M.parsePortPattern(value);
      delete g.first;
      delete g.count;
      Object.assign(g, parsed);
    } else if (prop === 'connector') {
      g.connector = value;
      // A new connector brings its usual speed: an RJ45 group turned QSFP56 runs at 200G.
      const c = M.connectorById(value);
      if (c && c.speedGbps) g.speedGbps = c.speedGbps;
    } else if (prop === 'speedGbps') g.speedGbps = Number(value);
    else if (prop === 'side') g.side = value === 'front' ? 'front' : 'rear';
    return ports;
  }

  /**
   * Gives the selected device type the port groups `ports` (or refuses a
   * message in their place). Groups that are not valid are refused with
   * the reason, keeping `keep` ({ id, value }) in its field; a change that
   * unplugs cables names them and asks first, and can be undone. Focus
   * goes to cat.focus after the change, or to the control `back` (an id)
   * when the question is answered No.
   */
  async function setTypePorts(ports, keep, back) {
    const id = cat.id;
    const t = M.typeOf(project, id);
    if (!t) return;
    // Where focus goes after the redraw, kept across the question below.
    const focus = cat.focus;
    const problem = typeof ports === 'string' ? ports : M.portsProblem(ports);
    if (problem) {
      cat.error = problem;
      cat.keep = keep || null;
      return refreshCatalog();
    }
    cat.keep = null;
    const lost = C.portChangeImpact(project, id, ports);
    if (lost.length) {
      const shown = lost.slice(0, 6).map((c) => c.label || 'one without a label');
      const ok = await confirmDialog({
        title: `Unplug ${plural(lost.length, 'cable')}?`,
        body:
          `This change takes away ports of ${t.label} that ${lost.length === 1 ? 'a cable is' : 'cables are'} plugged into: ` +
          `${shown.join(', ')}${lost.length > shown.length ? ` and ${lost.length - shown.length} more` : ''}. Undo plugs them back in.`,
        ok: lost.length === 1 ? 'Unplug the cable' : `Unplug ${lost.length} cables`,
      });
      cat.focus = ok ? focus : back || focus;
      if (!ok) {
        cat.error = '';
        return renderCatalog();
      }
      openDialog($('#dlg-catalog'));
    }
    const err = commitOrError((p) => M.updateDeviceType(p, id, { ports }));
    cat.error = err || '';
    refreshCatalog();
    if (lost.length && !err) toast(`Unplugged ${plural(lost.length, 'cable')} from ${t.label}`, { action: 'Undo', onAction: undo });
  }

  function portChange(input) {
    const t = M.typeOf(project, cat.id);
    if (!t) return;
    const ports = editedPorts(t, Number(input.dataset.pg), input.dataset.pgProp, input.value);
    if (typeof ports !== 'string' && JSON.stringify(ports) === JSON.stringify(t.ports)) {
      // Typed back to what it was: drop an error about it.
      if (cat.keep && cat.keep.id === input.id) {
        cat.keep = null;
        cat.error = '';
        refreshCatalog();
      }
      return;
    }
    setTypePorts(ports, { id: input.id, value: input.value });
  }

  /** Adds the next free single port eth0, eth1 … (RJ45, 1G, rear) and puts the cursor in its names. */
  function addPortGroup() {
    const t = M.typeOf(project, cat.id);
    const names = new Set(M.expandPorts(t).map((p) => p.name));
    let n = 0;
    while (names.has(`eth${n}`)) n++;
    const field = `cat-pg-${t.ports.length}-names`;
    cat.focus = field;
    setTypePorts(t.ports.concat({ name: `eth${n}`, connector: 'rj45', speedGbps: 1, side: 'rear' }));
    cat.focus = null;
    const input = document.getElementById(field);
    if (input) input.select();
  }

  // Rack types --------------------------------------------------------

  function rackTypeForm(t) {
    const n = catalogUse('racks', t.id);
    const maxSlots = M.maxSideSlots(t.units);
    return (
      `<div class="field-grid cat-fields">` +
      `<div class="field span2"><label for="cat-rname">Name</label><input id="cat-rname" data-prop="name" type="text" value="${esc(t.name)}" maxlength="60" autocomplete="off"></div>` +
      `<div class="field"><label for="cat-units">Height (U)</label><input id="cat-units" data-prop="units" data-num type="number" min="${M.LIMITS.unitsMin}" max="${M.LIMITS.unitsMax}" step="1" value="${t.units}"></div>` +
      `<div class="field"><label for="cat-slots">Side slots</label><input id="cat-slots" data-prop="sideSlots" data-num type="number" min="0" max="${maxSlots}" step="1" value="${t.sideSlots}"></div>` +
      `<div class="field"><label for="cat-rpower">Power budget (kW)</label><input id="cat-rpower" data-prop="powerW" data-kw type="number" min="0" step="0.5" value="${t.powerW / 1000}" placeholder="none"></div>` +
      `<div class="field"><label for="cat-rweight">Max. load (kg)</label><input id="cat-rweight" data-prop="weightKg" data-num type="number" min="0" step="10" value="${t.weightKg}" placeholder="none"></div>` +
      `<div class="field"><label for="cat-rwidth">Width (mm)</label><input id="cat-rwidth" data-prop="widthMm" data-num type="number" min="300" max="1200" step="50" value="${t.widthMm}"></div>` +
      `<div class="field"><label for="cat-rdepth">Depth (mm)</label><input id="cat-rdepth" data-prop="depthMm" data-num type="number" min="600" max="1600" step="50" value="${t.depthMm}"></div>` +
      `<div class="field"><label for="cat-rtray">To cable tray (m)</label><input id="cat-rtray" data-prop="trayM" data-num type="number" min="0" max="10" step="0.1" inputmode="decimal" value="${t.trayM}"></div>` +
      `<div class="field"><label for="cat-rslack">Slack per cable (m)</label><input id="cat-rslack" data-prop="slackM" data-num type="number" min="0" max="10" step="0.05" inputmode="decimal" value="${t.slackM}"></div>` +
      `</div>` +
      `<p class="sec-hint">Up to ${maxSlots} side slot${maxSlots === 1 ? '' : 's'} fit a ${t.units}U rack. A budget of 0 means none; racks over their budget are flagged in red. ` +
      `Cable lengths count the width and depth, the way from the top unit up to the cable tray, and the slack a cable gets at each end; racks can override the tray and the slack.</p>` +
      catActions(project.rackTypes, t, n, n || project.rackTypes.length <= 1 ? ` disabled title="${n ? 'Give its racks another type first' : 'A plan needs at least one rack type'}"` : '')
    );
  }

  // Cable types -------------------------------------------------------

  /** Jacket colors in the catalog's drawings; direct cables (DAC, SAS) take the ink color. */
  const JACKET = { cat6: '#5f86b3', cat6a: '#5f86b3', cat8: '#4a6f9e', aoc: '#e2a23b', om3: '#3fb7c9', om4: '#3fb7c9', om5: '#7fb83a', os2: '#e3c43c' };
  const FIBER_MODE = { mmf: '#3fb7c9', smf: '#e3c43c' };
  const fmtLen = (m) => (m >= 1000 ? `${Math.round(m / 100) / 10} km` : `${m} m`);

  /** "0.5–3 m", "3 m" or "made to length". */
  function stockText(t) {
    const l = t.lengthsM;
    if (!l.length) return 'made to length';
    return l.length === 1 ? fmtLen(l[0]) : `${l[0]}–${fmtLen(l[l.length - 1])}`;
  }
  /** "QSFP56", "QSFP56 → QSFP28", "OSFP → 2 × QSFP56". */
  function plugsText(t) {
    if (t.legs > 1) return `${connName(t.connector)} → ${t.legs} × ${connName(t.connectorB)}`;
    return t.connector === t.connectorB ? connName(t.connector) : `${connName(t.connector)} → ${connName(t.connectorB)}`;
  }
  /** Parts of a sub line joined by dots, which are the only places it breaks (not at spaces, nor after a dash: "0.5–3 m"). */
  const subLine = (parts) => parts.map((x) => x.replace(/ /g, '\u00a0').replace(/[–-]/g, '$&\u2060')).join(' · ');
  /** "DAC · QSFP56 · 0.5–3 m", "OM4 · MPO · made to length", "DAC · OSFP → 2 × QSFP56". */
  function cableSub(t) {
    const media = (C.MEDIA[t.media] || { short: t.media }).short;
    return subLine(t.legs > 1 ? [media, plugsText(t)] : [media, plugsText(t), stockText(t)]);
  }

  /** A cable in its jacket's color with a plug at each end; a breakout fans out into its legs. */
  function cableArt(t) {
    const color = JACKET[t.media] ? ` style="stroke:${JACKET[t.media]}"` : '';
    const plug = (x, y, w, h) => `<rect class="ca-plug" x="${x}" y="${y - h / 2}" width="${w}" height="${h}" rx="1"/>`;
    let body = '';
    if (t.legs <= 1) body = `<path class="ca-cord"${color} d="M12 12H52"/>` + plug(1, 12, 11, 7) + plug(52, 12, 11, 7);
    else {
      const gap = Math.min(6, 18 / (t.legs - 1));
      body = `<path class="ca-cord"${color} d="M12 12H26"/>`;
      let plugs = '';
      for (let i = 0; i < t.legs; i++) {
        const y = Math.round((12 + (i - (t.legs - 1) / 2) * gap) * 10) / 10;
        body += `<path class="ca-cord ca-leg"${color} d="M26 12C36 12 38 ${y} 46 ${y}H53"/>`;
        plugs += plug(53, y, 10, Math.max(1.6, Math.min(5, gap - 1)));
      }
      body += plugs + plug(1, 12, 11, 8);
    }
    return svgArt(64, 24, body);
  }

  /** Stock lengths typed as "0.5, 1, 1.5 m": a list of numbers, or a message naming what is no length. */
  function parseLengths(text) {
    const parts = String(text)
      .split(/[\s,;]+/)
      .map((x) => x.replace(/m$/i, ''))
      .filter(Boolean);
    const bad = parts.find((x) => !(Number(x) > 0));
    return bad ? `“${bad}” isn’t a length in metres` : parts.map(Number);
  }

  /** Stock lengths for a cable type that stops being made to length: what it had, else those of a standard type like it. */
  function stockLengthsFor(t) {
    if (lastLengths.has(t.id)) return lastLengths.get(t.id);
    const like = (f) => M.DEFAULT_CABLE_TYPES.find((d) => d.lengthsM.length && f(d));
    const d = like((x) => x.media === t.media && x.connector === t.connector) || like((x) => x.media === t.media);
    return d ? d.lengthsM.slice() : [1, 2, 3, 5];
  }

  function madeToLength(on) {
    const id = cat.id;
    const t = M.cableTypeById(project, id);
    if (!t) return;
    if (on && t.lengthsM.length) lastLengths.set(id, t.lengthsM);
    const err = commitOrError((p) => C.updateCableType(p, id, { lengthsM: on ? [] : stockLengthsFor(t) }));
    cat.error = err || '';
    cat.keep = null;
    refreshCatalog();
  }

  function cableTypeForm(t) {
    const n = catalogUse('cables', t.id);
    const media = Object.keys(C.MEDIA).map((k) => [k, C.MEDIA[k].label]);
    const plugs = M.mediaConnectors(t.media).map((id) => [id, connName(id)]);
    const made = !t.lengthsM.length;
    return (
      `<div class="field-grid cat-fields">` +
      `<div class="field span2"><label for="cat-c-name">Name</label><input id="cat-c-name" data-prop="name" type="text" value="${esc(t.name)}" maxlength="60" autocomplete="off"></div>` +
      `<div class="field"><label for="cat-c-media">Media</label><select id="cat-c-media" data-prop="media">${options(media, t.media)}</select></div>` +
      `<div class="field"><label for="cat-c-legs">Legs</label><input id="cat-c-legs" data-prop="legs" data-num type="number" min="1" max="${M.LIMITS.legs}" step="1" value="${t.legs}">` +
      `<small class="field-hint">2 to ${M.LIMITS.legs}: a breakout</small></div>` +
      `<div class="field"><label for="cat-c-conn">Plug at end A</label><select id="cat-c-conn" data-prop="connector">${options(plugs, t.connector)}</select></div>` +
      `<div class="field"><label for="cat-c-connb">Plug at the other ends</label><select id="cat-c-connb" data-prop="connectorB">${options(plugs, t.connectorB)}</select></div>` +
      `<div class="field"><label for="cat-c-speed">Speed rating (Gb/s)</label><input id="cat-c-speed" data-prop="speedGbps" data-num type="number" min="0" max="1600" step="1" value="${t.speedGbps}">` +
      `<small class="field-hint">0: not rated</small></div>` +
      `<div class="field"><label for="cat-c-reach">Reach (m)</label><input id="cat-c-reach" data-prop="maxM" data-num type="number" min="0" step="1" value="${t.maxM}">` +
      `<small class="field-hint">0: no limit${C.MEDIA[t.media] && C.MEDIA[t.media].kind === 'fiber' ? '; the transceivers’ reach counts' : ''}</small></div>` +
      `<div class="field span2"><label for="cat-c-lengths">Stock lengths (m)</label>` +
      `<input id="cat-c-lengths" class="mono" data-prop="lengthsM" data-list type="text" value="${esc(t.lengthsM.join(', '))}" placeholder="${made ? 'made to length' : '0.5, 1, 1.5, 2'}" autocomplete="off" spellcheck="false"${made ? ' disabled' : ''}>` +
      `<label class="check"><input type="checkbox" id="cat-c-made"${made ? ' checked' : ''}><span>Made to length</span></label></div>` +
      `</div>` +
      `<p class="sec-hint">A cable without a type picks the first one in this order that fits its ports and reaches, and gets the next stock length up; a type made to length gets the length the cable needs, and the order list shows those lengths.</p>` +
      catActions(project.cableTypes, t, n)
    );
  }

  // Transceivers ------------------------------------------------------

  const FIBERS = [
    ['lc', 'LC duplex'],
    ['mpo', 'MPO'],
  ];
  const MODES = [
    ['mmf', 'Multimode'],
    ['smf', 'Single-mode'],
  ];

  /** "QSFP56 · MPO · MMF · 100 m". */
  const transceiverSub = (t) => subLine([connName(t.connector), t.fiber.toUpperCase(), t.mode.toUpperCase(), fmtLen(t.reachM)]);

  /** A module: its body, the fiber sockets at the front and the pull tab in the color of its fiber's mode. */
  function transceiverArt(t) {
    const sockets =
      t.fiber === 'mpo'
        ? `<rect class="ca-socket" x="45.5" y="9.2" width="4" height="5.6" rx=".6"/>`
        : `<rect class="ca-socket" x="45.5" y="7.6" width="4" height="3.6" rx=".6"/><rect class="ca-socket" x="45.5" y="12.8" width="4" height="3.6" rx=".6"/>`;
    return svgArt(
      64,
      24,
      `<rect class="ca-plug" x="4" y="7" width="40" height="10" rx="1"/><path class="ca-fin" d="M9 10h30M9 12h30M9 14h30"/>` +
        `<rect class="ca-face" x="44" y="5.5" width="7" height="13" rx="1"/>${sockets}` +
        `<path class="ca-bail" style="stroke:${FIBER_MODE[t.mode] || FIBER_MODE.mmf}" d="M51 7.5H60V16.5H51"/>`
    );
  }

  function transceiverForm(t) {
    const n = catalogUse('transceivers', t.id);
    const cages = M.CONNECTORS.filter((c) => c.cage).map((c) => [c.id, c.label]);
    return (
      `<div class="field-grid cat-fields">` +
      `<div class="field span2"><label for="cat-x-name">Name</label><input id="cat-x-name" data-prop="name" type="text" value="${esc(t.name)}" maxlength="60" autocomplete="off"></div>` +
      `<div class="field"><label for="cat-x-conn">Fits</label><select id="cat-x-conn" data-prop="connector">${options(cages, t.connector)}</select></div>` +
      `<div class="field"><label for="cat-x-fiber">Fiber plug</label><select id="cat-x-fiber" data-prop="fiber">${options(FIBERS, t.fiber)}</select></div>` +
      `<div class="field"><label for="cat-x-mode">Mode</label><select id="cat-x-mode" data-prop="mode">${options(MODES, t.mode)}</select></div>` +
      `<div class="field"><label for="cat-x-speed">Speed (Gb/s)</label><input id="cat-x-speed" data-prop="speedGbps" data-num type="number" min="0" max="1600" step="1" value="${t.speedGbps}"></div>` +
      `<div class="field"><label for="cat-x-reach">Reach (m)</label><input id="cat-x-reach" data-prop="reachM" data-num type="number" min="0" step="10" value="${t.reachM}"></div>` +
      `</div>` +
      `<p class="sec-hint">A fiber cable needs a transceiver at every cage it plugs into. Cables pick the first one in this order that fits the cage, takes the fiber’s plug and mode, and reaches.</p>` +
      catActions(project.transceivers, t, n)
    );
  }

  // Tabs --------------------------------------------------------------

  async function deleteDeviceType(id) {
    const t = M.typeOf(project, id);
    const devs = project.devices.filter((d) => d.type === id);
    if (devs.length) {
      const cables = cablesGoingWith(idSet(devs));
      const ok = await confirmDialog({
        title: `Delete ${t.label}?`,
        body: `${plural(devs.length, 'device')} of this type${andCables(cables)} ${devs.length === 1 && !cables ? 'is' : 'are'} deleted with it. Undo brings everything back.`,
        ok: 'Delete type and devices',
      });
      if (!ok) return false;
      openDialog($('#dlg-catalog'));
    }
    commit((p) => void M.deleteDeviceType(p, id));
    toast(`Deleted the type ${t.label}`, { action: 'Undo', onAction: undo });
    return true;
  }

  /** Deletes through `remove(draft, id)`, which refuses with a message (shown under the form) while the type is in use. */
  function deleteOrRefuse(remove, id, what) {
    const err = commitOrError((p) => remove(p, id));
    if (err) {
      cat.error = err;
      showError('#cat-error', err);
      return false;
    }
    toast(`Deleted ${what}`, { action: 'Undo', onAction: undo });
    return true;
  }

  /**
   * What each catalog tab lists and how: names, sub lines, drawings, use
   * counts, the form, and the model functions that change, move, add and
   * delete its types. `templates` are [key, name, sub line] for “New type”.
   */
  const CAT_TABS = {
    devices: {
      noun: 'type',
      list: () => project.deviceTypes,
      byId: M.typeOf,
      name: (t) => t.label,
      sub: (t) => M.formatTypeSpec(t),
      art: (t) => {
        const pv = R.renderPreview(t, ui.theme, null, t.defaultName, measure);
        return svgArt(pv.width, pv.height, pv.body);
      },
      use: (id) => project.devices.filter((d) => d.type === id).length,
      useText: (n) => (n ? `${plural(n, 'device')} of this type` : 'Not used yet'),
      form: deviceTypeForm,
      update: M.updateDeviceType,
      move: M.moveDeviceType,
      templates: () => M.TYPE_TEMPLATES.map((t, i) => [i, t.label, M.formatTypeSpec(t)]),
      add: (p, tpl) => M.addDeviceType(p, tpl === 'copy' ? M.typeOf(p, cat.id) : M.TYPE_TEMPLATES[Number(tpl)]),
      del: deleteDeviceType,
      empty: 'No types yet. Add one with “New type”.',
    },
    racks: {
      noun: 'type',
      list: () => project.rackTypes,
      byId: M.rackTypeById,
      name: (t) => t.name,
      sub: (t) => `${t.units}U · ${plural(t.sideSlots, 'side slot')}${t.powerW ? ` · ${fmtKw(t.powerW)}` : ''}`,
      art: (t) => `<span class="cat-rack" style="--u:${t.units}" aria-hidden="true"></span>`,
      use: (id) => M.rackTypeUse(project, id),
      useText: (n) => (n ? `Used by ${plural(n, 'rack')}` : 'Not used yet'),
      form: rackTypeForm,
      update: M.updateRackType,
      move: M.moveRackType,
      templates: () => [['rack', 'New rack type', '42U, 2 side slots']],
      add: (p, tpl) => M.addRackType(p, tpl === 'copy' ? M.rackTypeById(p, cat.id) : { name: 'Custom rack', units: 42, sideSlots: 2, powerW: 8000, weightKg: 1000 }),
      del: (id) => deleteOrRefuse(M.deleteRackType, id, `the rack type ${M.rackTypeById(project, id).name}`),
      empty: 'No types yet. Add one with “New type”.',
    },
    cables: {
      noun: 'type',
      list: () => project.cableTypes,
      byId: M.cableTypeById,
      name: (t) => t.name,
      sub: cableSub,
      art: cableArt,
      use: (id) => C.cableTypeUse(project, id),
      useText: (n) => (n ? `${plural(n, 'cable')} name${n === 1 ? 's' : ''} this type` : 'No cable names this type'),
      form: cableTypeForm,
      update: C.updateCableType,
      move: C.moveCableType,
      templates: () => M.DEFAULT_CABLE_TYPES.map((t, i) => [i, t.name, cableSub(t)]),
      add: (p, tpl) => C.addCableType(p, tpl === 'copy' ? M.cableTypeById(p, cat.id) : M.DEFAULT_CABLE_TYPES[Number(tpl)]),
      del: (id) => deleteOrRefuse(C.deleteCableType, id, `the cable type ${M.cableTypeById(project, id).name}`),
      empty: 'No cable types: cables can’t pick a type or be ordered. Add one with “New type”.',
    },
    transceivers: {
      noun: 'transceiver',
      list: () => project.transceivers,
      byId: M.transceiverById,
      name: (t) => t.name,
      sub: transceiverSub,
      art: transceiverArt,
      use: (id) => C.transceiverUse(project, id),
      useText: (n) => (n ? `${plural(n, 'cable end')} name${n === 1 ? 's' : ''} this transceiver` : 'No cable end names this transceiver'),
      form: transceiverForm,
      update: C.updateTransceiver,
      move: C.moveTransceiver,
      templates: () => M.DEFAULT_TRANSCEIVERS.map((t, i) => [i, t.name, transceiverSub(t)]),
      add: (p, tpl) => C.addTransceiver(p, tpl === 'copy' ? M.transceiverById(p, cat.id) : M.DEFAULT_TRANSCEIVERS[Number(tpl)]),
      del: (id) => deleteOrRefuse(C.deleteTransceiver, id, `the transceiver ${M.transceiverById(project, id).name}`),
      empty: 'No transceivers: fiber cables can’t plug into cages. Add one with “New type”.',
    },
  };

  function catalogChange(input) {
    const prop = input.dataset.prop;
    let value = input.value;
    if (input.dataset.num !== undefined) value = Number(value);
    if (input.dataset.kw !== undefined) value = Number(value) * 1000;
    if (input.dataset.list !== undefined) {
      value = parseLengths(input.value);
      if (typeof value === 'string') {
        cat.error = value;
        cat.keep = { id: input.id, value: input.value };
        return refreshCatalog();
      }
    }
    const id = cat.id;
    const update = catTab().update;
    const err = commitOrError((p) => update(p, id, { [prop]: value }));
    cat.error = err || '';
    cat.keep = null;
    refreshCatalog();
  }

  $('#cat-form').addEventListener('change', (e) => {
    const t = e.target;
    if (!t.dataset) return;
    if (t.dataset.pgProp) portChange(t);
    else if (t.id === 'cat-c-made') madeToLength(t.checked);
    else if (t.dataset.prop) catalogChange(t);
  });
  $('#cat-form').addEventListener('click', async (e) => {
    if (!e.target.closest('#cat-delete')) return;
    if (await catTab().del(cat.id)) selectCatalogItem(null);
  });
  $('#cat-form').addEventListener('click', (e) => {
    const sub = e.target.closest('[data-cat-sub]');
    if (sub) {
      cat.sub = sub.dataset.catSub;
      cat.error = '';
      cat.keep = null;
      renderCatalog();
      return $(`#cat-sub-${cat.sub}`).focus();
    }
    if (e.target.closest('#cat-pg-add')) return addPortGroup();
    const del = e.target.closest('[data-pg-del]');
    if (del) {
      // Focus moves to the remove button of the row that takes its place, or
      // of the row above, or to Add ports when no row is left.
      const t = M.typeOf(project, cat.id);
      const i = Number(del.dataset.pgDel);
      // Answered No, focus goes back to this button.
      cat.focus = t.ports.length > 1 ? `cat-pg-${Math.min(i, t.ports.length - 2)}-del` : 'cat-pg-add';
      setTypePorts(t.ports.filter((g, k) => k !== i), null, del.id);
      cat.focus = null;
      return;
    }
    if (e.target.closest('#cat-pg-copy')) {
      // A field left by this click redraws first, or that redraw would
      // close the menu again.
      if (cat.pending) renderCatalog();
      return toggleMenu($('#cat-pg-copy'), $('#cat-pg-menu'), true);
    }
    const copy = e.target.closest('[data-pg-copy]');
    if (copy) {
      closeMenus();
      cat.focus = 'cat-pg-copy';
      setTypePorts(M.clone(M.typeOf(project, copy.dataset.pgCopy).ports), null, 'cat-pg-copy');
      cat.focus = null;
    }
  });
  // In the port table Enter moves on like Tab. Both commit the field
  // before moving, so that the redraw this causes knows where focus goes.
  $('#cat-form').addEventListener('keydown', (e) => {
    const menu = e.target.closest('#cat-pg-menu');
    if (menu) return menuKeydown(e, menu, $('#cat-pg-copy'));
    const field = e.target.closest('.pt-table input, .pt-table select, .pt-table button');
    if (!field || (e.key !== 'Enter' && e.key !== 'Tab') || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Enter' && field.tagName !== 'INPUT') return;
    const fields = $$('.pt-table input, .pt-table select, .pt-table button', $('#cat-form'));
    const next = fields[fields.indexOf(field) + (e.shiftKey ? -1 : 1)];
    if (!next && e.key === 'Tab') return;
    e.preventDefault();
    cat.focus = next ? next.id : field.id;
    if (next) next.focus();
    else field.blur();
    cat.focus = null;
  });
  // Tab out of any other field of the form likewise: its change redraws
  // the form, and the control the browser was moving to is gone with it.
  $('#cat-form').addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    const field = e.target.closest('input, select, textarea');
    if (!field || field.type === 'radio' || field.type === 'checkbox') return;
    const list = catTabbables();
    const k = list.indexOf(field) + (e.shiftKey ? -1 : 1);
    if (k < 0 || k >= list.length) return;
    e.preventDefault();
    cat.focus = list[k].id || `@${k}`;
    list[k].focus();
    cat.focus = null;
  });
  /** The controls of the catalog's form Tab stops at, in order (one per radio group). */
  function catTabbables() {
    return $$('input, select, textarea, button, [tabindex]', $('#cat-form')).filter((x) => {
      if (x.disabled || x.tabIndex < 0 || !x.getClientRects().length || x.closest('[hidden]')) return false;
      if (x.type !== 'radio') return true;
      const group = $$(`input[type="radio"][name="${CSS.escape(x.name)}"]`, $('#cat-form'));
      return x.checked || (!group.some((r) => r.checked) && group[0] === x);
    });
  }

  /** Moves a type to `toIndex` of its list and keeps it selected. */
  function moveCatalogItem(id, toIndex, refocus) {
    const move = catTab().move;
    commit((p) => (move(p, id, toIndex) ? undefined : false));
    selectCatalogItem(id);
    const item = $(`#cat-list .cat-item[data-id="${CSS.escape(id)}"]`);
    if (item && refocus) item.focus();
    if (item) item.scrollIntoView({ block: 'nearest' });
  }

  $('#cat-form').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat-move]');
    if (!b) return;
    const list = catTab().list();
    moveCatalogItem(cat.id, list.findIndex((t) => t.id === cat.id) + Number(b.dataset.catMove));
    const again = $(`#cat-form [data-cat-move="${b.dataset.catMove}"]`);
    if (again && !again.disabled) again.focus();
  });

  // Arrow keys walk the list; with Alt they move the focused type.
  $('#cat-list').addEventListener('keydown', (e) => {
    const item = e.target.closest('.cat-item');
    if (!item || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const items = $$('.cat-item', $('#cat-list'));
    const i = items.indexOf(item);
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    if (e.altKey) return moveCatalogItem(item.dataset.id, i + dir, true);
    const next = items[i + dir];
    if (!next) return;
    selectCatalogItem(next.dataset.id);
    $(`#cat-list .cat-item[data-id="${CSS.escape(cat.id)}"]`).focus();
  });

  // Drag to reorder: anywhere on a type with a mouse, by its grip on touch screens.
  let catDrag = null;
  function endCatDrag() {
    $('#cat-list').classList.remove('is-sorting');
    $$('#cat-list .cat-item').forEach((it) => it.classList.remove('is-dragging', 'drop-before', 'drop-after'));
  }
  $('#cat-list').addEventListener('pointerdown', (e) => {
    const item = e.target.closest('.cat-item');
    if (!item || e.button !== 0) return;
    const grip = e.target.closest('.cat-grip');
    if (e.pointerType !== 'mouse' && !grip) return;
    if (grip) e.preventDefault();
    catDrag = { id: item.dataset.id, pointerId: e.pointerId, y: e.clientY, active: false, to: null };
  });
  window.addEventListener('pointermove', (e) => {
    const d = catDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    const list = $('#cat-list');
    if (!d.active) {
      if (Math.abs(e.clientY - d.y) < 5) return;
      d.active = true;
      list.classList.add('is-sorting');
      const src = list.querySelector(`.cat-item[data-id="${CSS.escape(d.id)}"]`);
      if (src) src.classList.add('is-dragging');
    }
    const lr = list.getBoundingClientRect();
    if (e.clientY < lr.top + 24) list.scrollTop -= 10;
    else if (e.clientY > lr.bottom - 24) list.scrollTop += 10;
    const items = $$('.cat-item', list);
    let to = items.length;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        to = i;
        break;
      }
    }
    d.to = to;
    items.forEach((it, i) => {
      it.classList.toggle('drop-before', i === to);
      it.classList.toggle('drop-after', to === items.length && i === items.length - 1);
    });
  });
  window.addEventListener('pointerup', (e) => {
    const d = catDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    catDrag = null;
    if (!d.active) return;
    endCatDrag();
    // The click that ends a drag is not a selection.
    cat.skipClick = true;
    setTimeout(() => (cat.skipClick = false));
    const from = $$('#cat-list .cat-item').findIndex((it) => it.dataset.id === d.id);
    moveCatalogItem(d.id, d.to > from ? d.to - 1 : d.to);
  });
  window.addEventListener('pointercancel', (e) => {
    if (!catDrag || e.pointerId !== catDrag.pointerId) return;
    catDrag = null;
    endCatDrag();
  });

  $('#cat-list').addEventListener('click', (e) => {
    const item = e.target.closest('.cat-item');
    if (!item || cat.skipClick) return;
    selectCatalogItem(item.dataset.id);
  });
  $$('#dlg-catalog .dlg-head [role="tab"]').forEach((b) =>
    b.addEventListener('click', () => {
      cat.tab = b.dataset.tab;
      selectCatalogItem(null);
    })
  );
  $('#menu-cat-new').addEventListener('click', (e) => {
    const item = e.target.closest('[data-template]');
    if (!item) return;
    closeMenus();
    const tpl = item.dataset.template;
    const add = catTab().add;
    const made = commitAdd((p) => add(p, tpl));
    if (!made) return toast(`The catalog is full`, { warn: true });
    cat.sub = 'general';
    selectCatalogItem(made.id);
    const first = $('#cat-form input');
    if (first) first.select();
  });
  $('#btn-catalog').addEventListener('click', () => openCatalog('devices'));

  // Plans dialog -------------------------------------------------------

  function renderPlans() {
    flushPersist();
    const list = lib.list();
    $('#plan-list').innerHTML = list.length
      ? list
          .map((p) => {
            const cur = p.id === planId;
            return (
              `<li class="plan-item${cur ? ' is-current' : ''}" data-plan="${esc(p.id)}">` +
              `<div class="plan-meta"><span class="plan-name-l">${esc(p.name)}</span>` +
              `<span class="plan-sub">${esc(`${plural(p.floors || 1, 'floor')} · ${plural(p.racks || 0, 'rack')} · ${plural(p.devices || 0, 'device')} · edited ${relTime(p.updated)}`)}</span></div>` +
              `<div class="plan-actions">` +
              (cur ? `<span class="plan-now">Open now</span>` : `<button type="button" class="btn sm primary" data-plan-act="open">Open</button>`) +
              `<button type="button" class="btn icon sm" data-plan-act="dup" title="Duplicate" aria-label="Duplicate ${esc(p.name)}">${icon('copy')}</button>` +
              `<button type="button" class="btn icon sm danger-text" data-plan-act="del" title="Delete" aria-label="Delete ${esc(p.name)}">${icon('trash')}</button>` +
              `</div></li>`
            );
          })
          .join('')
      : `<li class="empty-note">No saved plans. Storage may be blocked in this browser.</li>`;
  }

  function switchPlan(id, message) {
    if (id === planId) return;
    flushPersist();
    const loaded = lib.load(id);
    if (!loaded) return toast('That plan could not be read', { warn: true });
    openPlan(id, loaded.project);
    render();
    fitWidth();
    toast(message || `Opened ${project.name}`);
  }

  /** Adds `p` as a new plan and opens it. */
  function createPlan(p, message, warnings) {
    flushPersist();
    const prev = planId;
    const id = lib.add(p);
    if (!id) toast('The browser storage is full, so this plan is not saved. Delete old plans or export this one.', { warn: true });
    lib.setCurrent(id);
    openPlan(id, p);
    render();
    fitWidth();
    const initial = IO.serialize(p, { compact: true });
    toast(message || `Started ${p.name}`, {
      action: prev ? 'Back' : null,
      onAction: () => {
        // Going straight back discards the new plan if it is still untouched.
        const now = id && lib.load(id);
        const untouched = now && IO.serialize(now.project, { compact: true }) === initial && id === planId;
        switchPlan(prev);
        if (untouched) lib.remove(id);
      },
    });
    if (warnings && warnings.length) reportWarnings(`Opened ${p.name}`, `${plural(warnings.length, 'thing')} in the file needed fixing:`, warnings);
  }

  $('#plan-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-plan-act]');
    if (!b) return;
    const id = b.closest('[data-plan]').dataset.plan;
    const act = b.dataset.planAct;
    if (act === 'open') {
      $('#dlg-plans').close();
      switchPlan(id);
    } else if (act === 'dup') {
      flushPersist();
      const loaded = lib.load(id);
      if (!loaded) return;
      loaded.project.name = `${loaded.project.name} (copy)`;
      delete loaded.project.meta.example;
      if (!lib.add(loaded.project)) toast('The browser storage is full', { warn: true });
      renderPlans();
    } else if (act === 'del') {
      const entry = lib.list().find((p) => p.id === id);
      const ok = await confirmDialog({
        title: `Delete ${entry.name}?`,
        body: `This removes the plan from this browser. Export it first if you may need it again.`,
        ok: 'Delete plan',
      });
      openDialog($('#dlg-plans'));
      if (!ok) return;
      const saved = lib.load(id);
      const wasOpen = id === planId;
      if (wasOpen) {
        // Nothing may save the deleted plan back while switching away from it.
        clearTimeout(persistTimer);
        persistTimer = null;
        planId = null;
        project = null;
      }
      lib.remove(id);
      if (wasOpen) {
        const next = lib.list().find((p) => lib.load(p.id));
        if (next) switchPlan(next.id);
        else createPlan(M.createEmptyProject(), 'Started an empty plan');
      }
      renderPlans();
      toast(`Deleted ${entry.name}`, {
        action: 'Undo',
        onAction: () => {
          if (saved && lib.save(id, saved.project)) renderPlans();
        },
      });
    }
  });
  $('#dlg-plans').addEventListener('click', (e) => {
    const b = e.target.closest('[data-plan-new]');
    if (!b) return;
    $('#dlg-plans').close();
    newPlan(b.dataset.planNew);
  });
  $('#btn-plans').addEventListener('click', () => {
    renderPlans();
    openDialog($('#dlg-plans'));
  });

  function newPlan(kind) {
    if (kind === 'example') return createPlan(M.createExampleProject(), 'Opened the example plan');
    if (kind === 'layout') return createPlan(M.copyLayout(project), 'Started a plan with this layout');
    createPlan(M.createEmptyProject(), 'Started an empty plan');
  }

  // Open dialog --------------------------------------------------------

  $('#btn-open').addEventListener('click', () => {
    $('#open-text').value = '';
    $('#open-merge').checked = false;
    showError('#open-error', '');
    openDialog($('#dlg-open'));
  });
  $('#open-file').addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', async () => {
    const file = el.fileInput.files && el.fileInput.files[0];
    el.fileInput.value = '';
    if (!file) return;
    try {
      openText(await file.text(), file.name);
    } catch (err) {
      showError('#open-error', `Could not read ${file.name}.`);
    }
  });
  $('#open-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#open-text').value.trim();
    if (!text) return showError('#open-error', 'Paste a plan or CSV rows first, or choose a file.');
    openText(text, '');
  });

  function openText(text, fileName) {
    const csv = /\.(csv|tsv|txt)$/i.test(fileName) || !/^\s*[[{]/.test(text);
    if (csv) return importCSVText(text, fileName);
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return showError('#open-error', 'That is not valid JSON. Check that the whole plan was copied.');
    }
    let result;
    try {
      result = IO.normalizeProject(raw);
    } catch (e) {
      return showError('#open-error', e.message);
    }
    $('#dlg-open').close('ok');
    delete result.project.meta.example;
    createPlan(result.project, `Opened ${result.project.name}: ${plural(result.project.devices.length, 'device')}`, result.warnings);
  }

  function importCSVText(text, fileName) {
    const merge = $('#open-merge').checked;
    let result;
    try {
      result = IO.importCSV(text, merge ? project : null);
    } catch (e) {
      return showError('#open-error', e.message);
    }
    $('#dlg-open').close('ok');
    const sub = `${plural(result.warnings.length, 'row')} or detail${result.warnings.length === 1 ? '' : 's'} needed attention:`;
    if (merge) {
      replaceProject(result.project);
      toast(`Added ${plural(result.added, 'device')} from the CSV`, { action: 'Undo', onAction: undo });
      reportWarnings(`Imported ${plural(result.added, 'device')}`, sub, result.warnings);
    } else {
      const base = fileName.replace(/\.[^.]+$/, '').trim();
      if (base) result.project.name = base.slice(0, 120);
      createPlan(result.project, `Imported ${plural(result.added, 'device')} into a new plan`);
      reportWarnings(`Imported ${plural(result.added, 'device')}`, sub, result.warnings);
    }
  }

  // ---------------------------------------------------------------- menus

  function closeMenus() {
    $$('.menu').forEach((m) => (m.hidden = true));
    $$('[aria-haspopup="menu"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }

  /** Opens or closes `menu` under `btn`; `fit` keeps it inside the dialog body it opens in. */
  function toggleMenu(btn, menu, fit) {
    const willOpen = menu.hidden;
    closeMenus();
    if (!willOpen) return;
    menu.hidden = false;
    if (fit) fitMenu(menu);
    btn.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('[aria-checked="true"]') || menu.querySelector('button');
    if (first) first.focus();
  }

  /**
   * Keeps an open menu inside the scrolling box it opens in (a dialog's
   * body): upward when there is more room above, scrolling itself when it
   * is taller than the room, and right-aligned when it would run past the
   * right edge.
   */
  function fitMenu(menu) {
    const box = menu.closest('.dlg-body');
    if (!box || menu.hidden) return;
    menu.classList.remove('menu-up', 'menu-right');
    menu.style.maxHeight = '';
    const b = box.getBoundingClientRect();
    const btn = menu.parentElement.getBoundingClientRect();
    const below = b.bottom - btn.bottom - 12;
    const above = btn.top - b.top - 12;
    const h = menu.offsetHeight;
    const up = h > below && above > below;
    menu.classList.toggle('menu-up', up);
    const room = up ? above : below;
    if (h > room) menu.style.maxHeight = `${Math.max(120, Math.floor(room))}px`;
    if (menu.getBoundingClientRect().right > b.right) menu.classList.add('menu-right');
  }

  /** Arrow keys walk a menu, Escape closes it back to its button `btn`, Tab leaves it. */
  function menuKeydown(e, menu, btn) {
    const items = $$('button', menu);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenus();
      btn.focus();
    } else if (e.key === 'Tab') closeMenus();
  }

  // Menu buttons, their menus, and what fills a menu before it opens.
  [
    ['#btn-export', '#menu-export'],
    ['#btn-new', '#menu-new'],
    ['#btn-row', '#menu-row', renderRowMenu],
    ['#cat-new', '#menu-cat-new'],
    ['#btn-theme', '#menu-theme'],
  ].forEach(([b, m, fill]) => {
    const btn = $(b);
    const menu = $(m);
    btn.addEventListener('click', () => {
      if (fill) fill();
      toggleMenu(btn, menu);
    });
    menu.addEventListener('keydown', (e) => menuKeydown(e, menu, btn));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.menu-wrap')) closeMenus();
  });

  $('#menu-export').addEventListener('click', (e) => {
    const item = e.target.closest('[data-export]');
    if (!item) return;
    closeMenus();
    doExport(item.dataset.export);
  });

  $('#menu-new').addEventListener('click', (e) => {
    const item = e.target.closest('[data-new]');
    if (!item) return;
    closeMenus();
    newPlan(item.dataset.new);
  });

  $('#menu-theme').addEventListener('click', (e) => {
    const item = e.target.closest('[data-theme-pick]');
    if (!item) return;
    closeMenus();
    prefs.theme = item.dataset.themePick;
    savePrefs();
    applyTheme();
  });

  // The example notice replaces the example in place, asking first if it was edited.
  async function startEmptyInPlace() {
    if (project.devices.length && !M.isPristineExample(project)) {
      const ok = await confirmDialog({
        title: 'Start with empty racks?',
        body: `This replaces “${project.name}”. Undo brings it back, or export it first to keep a copy.`,
        ok: 'Start empty',
      });
      if (!ok) return;
    }
    replaceProject(M.createEmptyProject());
    fitWidth();
    toast('Started an empty plan', { action: 'Undo', onAction: undo });
  }

  $('#btn-start-empty').addEventListener('click', startEmptyInPlace);
  $('#btn-keep-example').addEventListener('click', () => commit((p) => void delete p.meta.example));

  // --------------------------------------------------------------- export

  function fileBase(rowScoped) {
    const base = M.slug(project.name) || 'rack-plan';
    if (!rowScoped || M.allRows(project).length === 1) return base;
    const pos = currentRow();
    return `${base}-${M.slug(pos.floor.name)}-${M.slug(pos.row.name)}`.slice(0, 100);
  }

  function download(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function exportOpts() {
    return { rowId: ui.rowId, measure, date: todayISO(), sheet: sheetInfo(ui.rowId) };
  }

  function renderPNG(scale) {
    const svg = R.exportSVG(project, exportOpts());
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the browser could not encode the PNG'))), 'image/png');
      };
      img.onerror = () => reject(new Error('the drawing could not be rendered'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  function copyText(text, done, fallback) {
    try {
      navigator.clipboard.writeText(text).then(done, fallback);
    } catch (e) {
      fallback();
    }
  }

  function copyJSON() {
    const text = IO.serialize(project);
    copyText(
      text,
      () => toast('Plan copied as JSON'),
      () => {
        const ta = $('#copy-text');
        ta.value = text;
        openDialog($('#dlg-copy'));
        ta.focus();
        ta.select();
      }
    );
  }

  async function doExport(kind) {
    try {
      if (kind === 'copy') return copyJSON();
      if (kind === 'share') return openShare();
      if (kind === 'print') return openPrint();
      let name;
      if (kind === 'json') download((name = `${fileBase()}.json`), new Blob([IO.serialize(project)], { type: 'application/json' }));
      else if (kind === 'csv') download((name = `${fileBase()}.csv`), new Blob(['﻿' + IO.toCSV(project)], { type: 'text/csv;charset=utf-8' }));
      else if (kind === 'svg') download((name = `${fileBase(true)}.svg`), new Blob([R.exportSVG(project, exportOpts())], { type: 'image/svg+xml' }));
      else if (kind === 'png') download((name = `${fileBase(true)}.png`), await renderPNG(2));
      toast(`Exported ${name}`);
    } catch (err) {
      toast(`Export failed: ${err.message}`, { warn: true });
    }
  }

  // Share links --------------------------------------------------------

  async function openShare() {
    let code;
    try {
      code = await IO.encodeShare(project);
    } catch (e) {
      return toast(`Could not create the link: ${e.message}`, { warn: true });
    }
    const url = location.href.split('#')[0] + SHARE_PREFIX + code;
    $('#share-url').value = url;
    const n = url.length;
    $('#share-size').textContent =
      n > 8000
        ? `This link is ${n.toLocaleString('en')} characters long. Browsers open it, but chat and mail programs may cut it off; send the plan file instead if it breaks.`
        : `${n.toLocaleString('en')} characters.`;
    openDialog($('#dlg-share'));
    $('#share-url').select();
  }
  $('#share-copy').addEventListener('click', () => {
    const ta = $('#share-url');
    copyText(
      ta.value,
      () => toast('Link copied'),
      () => {
        ta.focus();
        ta.select();
        toast('Copy the selected link with Ctrl+C or ⌘C');
      }
    );
  });

  /** Opens a plan passed in the address (#plan=…) as a new plan. */
  async function openSharedFromHash() {
    const hash = location.hash;
    if (!hash.startsWith(SHARE_PREFIX)) return;
    window.history.replaceState(null, '', location.pathname + location.search);
    let result;
    try {
      result = IO.normalizeProject(await IO.decodeShare(hash.slice(SHARE_PREFIX.length)));
    } catch (e) {
      return toast(e.message, { warn: true });
    }
    delete result.project.meta.example;
    createPlan(result.project, `Opened the shared plan ${result.project.name}`, result.warnings);
  }
  window.addEventListener('hashchange', openSharedFromHash);

  // Printing -----------------------------------------------------------

  function openPrint() {
    const pos = currentRow();
    const all = M.allRows(project).length;
    const opts = [
      ['row', `This row`, `${pos.floor.name} · ${pos.row.name}`],
      ['floor', `This floor`, `${pos.floor.name}, ${plural(pos.floor.rows.length, 'sheet')}`],
      ['all', `Whole plan`, plural(all, 'sheet')],
    ];
    $('#print-scope').innerHTML = opts
      .map(([v, label, sub], i) => `<label class="radio"><input type="radio" name="print-scope" value="${v}"${i === 0 ? ' checked' : ''}><span>${esc(label)} <small>${esc(sub)}</small></span></label>`)
      .join('');
    if (prefs.paper) $('#print-paper').value = prefs.paper;
    openDialog($('#dlg-print'));
  }

  $('#print-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const scope = $('input[name="print-scope"]:checked').value;
    const paper = $('#print-paper').value;
    const orient = $('input[name="print-orient"]:checked').value;
    prefs.paper = paper;
    savePrefs();
    $('#dlg-print').close('ok');
    printSheets(scope, paper, orient);
  });

  function printSheets(scope, paper, orient) {
    const pos = currentRow();
    const all = M.allRows(project);
    const rows = scope === 'row' ? [pos.row.id] : scope === 'floor' ? pos.floor.rows.map((r) => r.id) : all.map((r) => r.row.id);
    const date = todayISO();
    el.printRoot.innerHTML = rows
      .map((rowId) => {
        const sc = R.renderScene(project, { rowId, theme: 'light', measure, date, sheet: sheetInfo(rowId) });
        return `<section class="print-page"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sc.width} ${sc.height}" preserveAspectRatio="xMidYMid meet">${sc.body}</svg></section>`;
      })
      .join('');
    let style = $('#print-page-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'print-page-style';
      document.head.appendChild(style);
    }
    style.textContent = `@page { size: ${paper} ${orient}; margin: 8mm; }`;
    document.body.classList.add('is-printing');
    const cleanup = () => {
      document.body.classList.remove('is-printing');
      el.printRoot.innerHTML = '';
    };
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
  }

  // ---------------------------------------------------------------- toasts

  /**
   * A modal dialog makes the rest of the page inert, so while one is open
   * the toasts live in it (fixed to the window all the same) to keep their
   * Undo buttons in reach.
   */
  function hostToasts() {
    const host = $$('dialog[open]').pop() || document.body;
    if (el.toasts.parentNode !== host) host.appendChild(el.toasts);
  }
  $$('dialog').forEach((dlg) => dlg.addEventListener('close', hostToasts));

  function toast(message, opts) {
    const o = opts || {};
    const t = document.createElement('div');
    t.className = 'toast' + (o.warn ? ' warn' : '');
    t.setAttribute('role', o.warn ? 'alert' : 'status');
    const span = document.createElement('span');
    span.textContent = message;
    t.appendChild(span);
    let timer = null;
    const dismiss = () => {
      clearTimeout(timer);
      t.remove();
    };
    if (o.action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.action;
      b.addEventListener('click', () => {
        dismiss();
        o.onAction();
      });
      t.appendChild(b);
    }
    hostToasts();
    el.toasts.appendChild(t);
    while (el.toasts.children.length > 3) el.toasts.firstElementChild.remove();
    timer = setTimeout(dismiss, o.action ? 6000 : o.warn ? 5000 : 3200);
  }

  // -------------------------------------------------------------- toolbar

  el.undo.addEventListener('click', undo);
  el.redo.addEventListener('click', redo);
  $('#btn-zoom-in').addEventListener('click', () => setZoom(ui.zoom * 1.2));
  $('#btn-zoom-out').addEventListener('click', () => setZoom(ui.zoom / 1.2));
  $('#btn-zoom-fit').addEventListener('click', () => fitZoom('sheet'));
  el.zoomLevel.addEventListener('click', () => setZoom(1));

  bindText(el.planName, 'plan-name', (p, v) => (p.name = v), () => 'Untitled rack plan');

  // ------------------------------------------------------------- keyboard

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || $('dialog[open]')) return;
    const t = e.target;
    // Form controls keep their own keys (arrows switch radio buttons); only
    // text fields also keep their own undo.
    const formControl = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const textEntry =
      formControl && t.tagName !== 'SELECT' && !(t.tagName === 'INPUT' && /^(radio|checkbox|button|submit|reset|color|file|range)$/.test(t.type));
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const letter = key.length === 1 ? key.toLowerCase() : '';

    if (mod && !e.altKey && letter === 'z') {
      if (textEntry) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && letter === 'y') {
      if (textEntry) return;
      e.preventDefault();
      redo();
      return;
    }
    if (mod && letter === 'k') {
      e.preventDefault();
      focusSearch();
      return;
    }
    if (formControl) {
      if (textEntry && (key === 'Escape' || (key === 'Enter' && t.tagName === 'INPUT'))) t.blur();
      return;
    }
    if (t.closest && t.closest('.menu')) return;

    if (key === 'Escape') {
      if (ui.drag) cancelDrag();
      else if (ui.marquee) {
        ui.marquee = null;
        hideDragFeedback();
      } else if (ui.armed) disarm();
      else if (!$$('.menu').every((m) => m.hidden)) closeMenus();
      else if (ui.selection) clearSelection();
      else if (ui.query) {
        el.search.value = '';
        setQuery('');
      } else if (ui.focusCluster) {
        ui.focusCluster = null;
        render({ inspector: false });
      }
      return;
    }

    const ids = selIds();
    const d = selectedDevice();
    if (ids.length && !mod) {
      if (key === 'Delete' || key === 'Backspace') {
        e.preventDefault();
        return deleteDevices(ids);
      }
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        e.preventDefault();
        if (d) return nudge(d.id, key === 'ArrowUp' ? -1 : 1, true);
        return groupNudge(key === 'ArrowUp' ? -1 : 1);
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        e.preventDefault();
        if (d) return moveToRack(d.id, key === 'ArrowLeft' ? -1 : 1);
        return groupToRack(key === 'ArrowLeft' ? -1 : 1);
      }
      if (d && (key === 'Enter' || key === 'F2')) {
        // On a focused button or link, Enter keeps activating it.
        if (key === 'Enter' && t.closest && t.closest('button, a[href], summary, .add-rack')) return;
        e.preventDefault();
        const input = $('#insp-name');
        if (input) {
          input.focus();
          input.select();
        }
        return;
      }
    }
    if (mod && !e.shiftKey && !e.altKey && letter === 'd' && ui.selection) {
      e.preventDefault();
      const s = ui.selection;
      return s.kind === 'devices' ? duplicateDevices(s.ids) : duplicateStructure(s.kind, s.id);
    }
    if (mod && letter === 'a' && ui.view === 'sheet') {
      e.preventDefault();
      return selectDevices(M.devicesWithin(project, ui.rowId).map((x) => x.id));
    }
    if (mod || e.altKey) return;
    if (key === '/') {
      e.preventDefault();
      focusSearch();
    } else if (key === '[') stepRow(-1);
    else if (key === ']') stepRow(1);
    else if (letter === 'm') setView(ui.view === 'map' ? 'sheet' : 'map');
    else if (key === '+' || key === '=') setZoom(ui.zoom * 1.2);
    else if (key === '-' || key === '_') setZoom(ui.zoom / 1.2);
    else if (key === '0') fitZoom('sheet');
    else if (key === '1') setZoom(1);
  });

  // --------------------------------------------------------- environment

  /**
   * Applies the theme picked with the theme button: light or dark, or none
   * so the system's setting decides. The head of index.html does the same
   * before the first paint.
   */
  function applyTheme() {
    const pick = prefs.theme;
    if (pick === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', pick);
    const btn = $('#btn-theme');
    btn.querySelector('use').setAttribute('href', `#i-theme-${pick}`);
    btn.title = `Theme: ${THEME_PICKS.get(pick)}`;
    btn.setAttribute('aria-label', btn.title);
    for (const b of $$('[data-theme-pick]')) b.setAttribute('aria-checked', String(b.dataset.themePick === pick));
  }

  function onThemeChange() {
    const theme = detectTheme();
    if (theme === ui.theme) return;
    ui.theme = theme;
    render();
  }
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', onThemeChange);
  }
  new MutationObserver(onThemeChange).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // Web fonts change text widths; re-measure labels once they arrive.
  if (document.fonts) {
    const remeasure = () => {
      measureCache.clear();
      partsKey = null;
      renderParts();
      renderStage();
    };
    const faces = Object.values(R.FONTS).map((f) => f.css);
    Promise.all(faces.map((f) => document.fonts.load(f).catch(() => null))).then(remeasure);
    if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', remeasure);
  }

  window.addEventListener('pagehide', flushPersist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersist();
  });

  // Another tab may have changed the list of plans or this plan.
  window.addEventListener('storage', (e) => {
    if ($('#dlg-plans').open && e.key && e.key.startsWith('rackplanner.')) renderPlans();
  });

  // ----------------------------------------------------------------- boot

  applyTheme();
  ui.theme = detectTheme();
  bootPlan();
  render();
  if (prefs.zoom) {
    setZoom(prefs.zoom, null, false);
    scrollToOrigin();
  } else fitWidth();
  openSharedFromHash();

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline use is a bonus */
    });
  }

  // Read-only handle for the browser tests and for poking around in the console.
  window.RP.app = { project: () => project, ui, planId: () => planId };
})();
