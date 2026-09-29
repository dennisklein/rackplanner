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
  const IO = window.RP.io;
  const R = window.RP.render;
  const G = R.geometry;

  const PREFS_KEY = 'rackplanner.prefs.v1';
  const HISTORY_LIMIT = 200;
  // Undo keeps whole snapshots; cap their total size for very large plans.
  const HISTORY_CHARS = 40e6;
  const COLOR_NAMES = ['Cobalt', 'Orange', 'Teal', 'Violet', 'Amber', 'Red', 'Green', 'Cyan', 'Rose', 'Indigo', 'Olive', 'Brown'];
  const SHARE_PREFIX = '#plan=';

  // ------------------------------------------------------------ utilities

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  const icon = (id, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + 's'}`;
  const fmtPower = R.formatPower;
  const fmtKg = (kg) => `${Math.round(kg).toLocaleString('en')} kg`;
  const fmtKw = (w) => `${(Math.round(w / 100) / 10).toLocaleString('en', { minimumFractionDigits: 1 })} kW`;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const shortRack = (name) => name.replace(/^rack\s+/i, '');

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

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function relTime(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return plural(Math.round(s / 3600), 'hour') + ' ago';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function detectTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function slug(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .slice(0, 60);
  }

  // ---------------------------------------------------------------- state

  const prefs = Object.assign({ zoom: null, lastCluster: null, view: 'sheet', metric: 'space', rows: {} }, readJSON(PREFS_KEY) || {});
  if (!prefs.rows || typeof prefs.rows !== 'object') prefs.rows = {};
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

  /** Makes `loaded.project` the open plan, with a fresh undo history. */
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

  function restore(json) {
    projectJSON = json;
    project = JSON.parse(json);
    history.key = null;
    persist();
    render();
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
    if (changed && !o.keepScroll) {
      el.canvas.scrollTop = 0;
      el.canvas.scrollLeft = 0;
    }
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
    if (list.length && (o.focus || o.reveal)) {
      const g = findDevEl(list[0]);
      if (g) {
        if (o.focus) g.focus({ preventScroll: true });
        ensureVisible(g);
      }
    }
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
    if (kind === 'rack' && opts && opts.reveal) {
      const head = el.svg.querySelector(`.rack-head[data-rack="${CSS.escape(id)}"]`);
      if (head) ensureVisible(head);
    }
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
  function ghostLayer() {
    return el.svg.querySelector('#ghost-layer');
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
    s += ` · ${fmtKw(t.powerW)}${t.powerBudgetW ? ` of ${fmtKw(t.powerBudgetW)}` : ''}`;
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
        const label = `${rack.name}: ${st.used + st.reserved} of ${st.units} U used, ${fmtPower(st.powerW)}${st.powerBudgetW ? ` of ${fmtPower(st.powerBudgetW)}` : ''}, ${fmtKg(st.weightKg)}${m.over ? ', over budget' : ''}${hits ? `, ${plural(hits, 'match', 'matches')}` : ''}`;
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
    let made = null;
    commit((p) => {
      made = M.addFloor(p);
      return made ? undefined : false;
    });
    if (!made) return toast(`A plan holds up to ${M.LIMITS.floors} floors`, { warn: true });
    setRow(made.rows[0].id);
    toast(`Added ${made.name} with ${made.rows[0].name}`, { action: 'Undo', onAction: undo });
  }

  function addRowTo(floorId, index) {
    let made = null;
    commit((p) => {
      made = M.addRow(p, floorId, { index });
      return made ? undefined : false;
    });
    if (!made) return toast(`A floor holds up to ${M.LIMITS.rows} rows`, { warn: true });
    setRow(made.id, { view: ui.view });
    toast(`Added ${made.name} with ${plural(made.racks.length, 'rack')}`, { action: 'Undo', onAction: undo });
  }

  function addRackTo(rowId, index) {
    let made = null;
    commit((p) => {
      made = M.addRack(p, rowId, { index });
      return made ? undefined : false;
    });
    if (!made) return toast(`A row holds up to ${M.LIMITS.racks} racks`, { warn: true });
    toast(`Added ${made.name}`, { action: 'Undo', onAction: undo });
    return made;
  }

  function duplicateStructure(kind, id) {
    const name = kind === 'rack' ? M.rackById(project, id).name : kind === 'row' ? M.rowById(project, id).name : M.floorById(project, id).name;
    const before = project.devices.length;
    let made = null;
    commit((p) => {
      made = kind === 'rack' ? M.duplicateRack(p, id) : kind === 'row' ? M.duplicateRow(p, id) : M.duplicateFloor(p, id);
      return made ? undefined : false;
    });
    if (!made) {
      const full = { rack: `A row holds up to ${M.LIMITS.racks} racks`, row: `A floor holds up to ${M.LIMITS.rows} rows`, floor: `A plan holds up to ${M.LIMITS.floors} floors` };
      return toast(full[kind], { warn: true });
    }
    const n = project.devices.length - before;
    ui.selection = { kind, id: made.id };
    if (kind === 'rack') render();
    else setRow(kind === 'row' ? made.id : made.rows[0].id);
    if (kind === 'rack') {
      const head = el.svg.querySelector(`.rack-head[data-rack="${CSS.escape(made.id)}"]`);
      if (head) ensureVisible(head);
    }
    toast(`Added ${made.name}, a copy of ${name}${n ? ` with ${plural(n, 'device')}` : ''}`, { action: 'Undo', onAction: undo });
  }

  async function deleteRack(rackId) {
    const pos = M.locateRack(project, rackId);
    if (!pos) return;
    if (pos.row.racks.length <= 1) return toast(`${pos.row.name} needs at least one rack; delete the row instead`, { warn: true });
    const n = M.devicesWithin(project, rackId).length;
    if (n) {
      const ok = await confirmDialog({
        title: `Delete ${pos.rack.name}?`,
        body: `It holds ${plural(n, 'device')}, which are deleted with it. Undo brings everything back.`,
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
    const n = M.devicesWithin(project, rowId).length;
    const ok = await confirmDialog({
      title: `Delete ${pos.row.name}?`,
      body: `This deletes its ${plural(pos.row.racks.length, 'rack')}${n ? ` and ${plural(n, 'device')}` : ''}. Undo brings everything back.`,
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
    const n = M.devicesWithin(project, floorId).length;
    const racks = floor.rows.reduce((a, r) => a + r.racks.length, 0);
    const ok = await confirmDialog({
      title: `Delete ${floor.name}?`,
      body: `This deletes ${plural(floor.rows.length, 'row')}, ${plural(racks, 'rack')}${n ? ` and ${plural(n, 'device')}` : ''}. Undo brings everything back.`,
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
        body: `${names} ${removed.length === 1 ? 'holds' : 'hold'} ${plural(lost.length, 'device')}, which ${lost.length === 1 ? 'is' : 'are'} removed too. Undo brings everything back.`,
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
  function rackOptions(selectedId, disable) {
    let s = '';
    for (const { floor, row } of M.allRows(project)) {
      s += `<optgroup label="${esc(`${floor.name} · ${row.name}`)}">`;
      for (const r of row.racks) {
        const off = disable && disable(r, row);
        s += `<option value="${esc(r.id)}"${r.id === selectedId ? ' selected' : ''}${off ? ' disabled' : ''}>${esc(r.name)}</option>`;
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

  function renderInspector() {
    const s = ui.selection;
    if (s && s.kind === 'devices') {
      if (s.ids.length === 1) renderDeviceInspector(M.deviceById(project, s.ids[0]));
      else renderMultiInspector(s.ids.map((id) => M.deviceById(project, id)));
    } else if (s && s.kind === 'rack') renderRackInspector(M.rackById(project, s.id));
    else if (s && s.kind === 'row') renderRowInspector(M.locateRow(project, s.id));
    else if (s && s.kind === 'floor') renderFloorInspector(M.floorById(project, s.id));
    else renderOverview();
  }

  /** Text or number input bound to a device property, committed live. */
  function bindField(input, id, prop, parse) {
    input.addEventListener('input', () => {
      if (parse) return;
      const v = input.value;
      commit((p) => void (M.deviceById(p, id)[prop] = v), { key: `${prop}:${id}`, inspector: false });
    });
    if (parse) {
      input.addEventListener('change', () => {
        const v = parse(input.value);
        commit((p) => void (M.deviceById(p, id)[prop] = v), { inspector: false });
      });
    }
  }
  const parseOptNum = (max) => (v) => (String(v).trim() === '' ? null : M.clampNum(v, 0, max, null));

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
      `<div class="insp-actions">` +
      `<button type="button" class="btn" id="insp-dup" title="Duplicate (Ctrl+D)">${icon('copy')}Duplicate</button>` +
      `<button type="button" class="btn danger-text" id="insp-del" title="Delete (Del)">${icon('trash')}Delete</button>` +
      `</div>`;

    const id = d.id;
    const nameInput = $('#insp-name');
    nameInput.addEventListener('input', () => {
      const v = nameInput.value;
      commit((p) => void (M.deviceById(p, id).name = v), { key: 'name:' + id, inspector: false });
    });
    nameInput.addEventListener('change', () => {
      if (nameInput.value.trim()) return;
      const fallback = M.suggestName(project, d.type);
      commit((p) => void (M.deviceById(p, id).name = fallback), { key: 'name:' + id });
    });
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
      `<section class="insp-sec"><h3>Set for all</h3><div class="field-grid">` +
      `<div class="field span2"><label for="multi-owner">Owner</label><input id="multi-owner" type="text" value="${owners.size === 1 ? esc([...owners][0]) : ''}" placeholder="${owners.size > 1 ? 'Mixed' : ''}" autocomplete="off" maxlength="120"></div>` +
      `<div class="field span2"><label for="multi-rename">Rename in series, top to bottom</label><div class="inline"><input id="multi-rename" class="mono" type="text" value="${esc(sorted[0].name)}" autocomplete="off" spellcheck="false" maxlength="80"><button type="button" class="btn sm" id="multi-rename-go">Rename</button></div></div>` +
      `</div></section>` +
      `<section class="insp-sec"><h3>Devices</h3><ol class="contents">${rows}</ol></section>` +
      `<div class="insp-actions">` +
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
      meterHTML('Power', st.powerW, st.powerBudgetW, `${fmtKw(st.powerW)}${st.powerBudgetW ? ` of ${fmtKw(st.powerBudgetW)}` : ''}`, st.overPower) +
      meterHTML('Weight', st.weightKg, st.weightBudgetKg, `${fmtKg(st.weightKg)}${st.weightBudgetKg ? ` of ${fmtKg(st.weightBudgetKg)}` : ''}`, st.overWeight) +
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
    const input = $('#insp-rack-name');
    input.addEventListener('input', () => {
      const v = input.value;
      commit((p) => void (M.rackById(p, id).name = v), { key: 'rack:' + id, inspector: false });
    });
    input.addEventListener('change', () => {
      if (input.value.trim()) return;
      commit((p) => void (M.rackById(p, id).name = M.defaultRackName(p, pos.row.id, pos.index)), { key: 'rack:' + id });
    });
    $('#insp-rack-type').addEventListener('change', (e) => {
      let err = null;
      commit((p) => {
        err = M.setRackType(p, id, e.target.value);
        return err ? false : undefined;
      });
      if (err) {
        toast(`Can’t change the type: ${err}`, { warn: true });
        renderInspector();
      }
    });
    $('#insp-rack-types').addEventListener('click', () => openCatalog('racks', rack.type));
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
        body: `This removes all ${plural(devs.length, 'device')} from ${rack.name}. Undo brings them back.`,
        ok: 'Remove devices',
      });
      if (ok) commit((p) => void (p.devices = p.devices.filter((d) => d.loc.rack !== id)));
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
    const bars = row.racks
      .map((r) => {
        const st = stats.get(r.id);
        return (
          `<button type="button" class="rack-bar${st.overPower || st.overWeight ? ' is-over' : ''}" data-rack="${esc(r.id)}">` +
          `<span class="rb-name">${esc(r.name)}</span><span class="rb-val">${st.used + st.reserved}/${st.units} U · ${fmtKw(st.powerW)}</span>` +
          `<span class="rb-track"><span class="rb-fill" style="width:${pct(st.used, st.units)}%"></span><span class="rb-res" style="width:${pct(st.reserved, st.units)}%"></span></span></button>`
        );
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
      `<div class="rack-bars">${bars}</div>` +
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
    const input = $('#insp-row-name');
    input.addEventListener('input', () => {
      const v = input.value;
      commit((p) => void (M.rowById(p, id).name = v), { key: 'row:' + id, inspector: false });
    });
    input.addEventListener('change', () => {
      if (input.value.trim()) return;
      commit((p) => void (M.rowById(p, id).name = `Row ${M.letters(pos.rowIndex)}`), { key: 'row:' + id });
    });
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
        return (
          `<button type="button" class="rack-bar${rs.overPower || rs.overWeight ? ' is-over' : ''}" data-open-row="${esc(row.id)}">` +
          `<span class="rb-name">${esc(row.name)}</span><span class="rb-val">${esc(`${plural(rs.racks, 'rack')} · ${fmtKw(rs.powerW)}`)}</span>` +
          `<span class="rb-track"><span class="rb-fill" style="width:${pct(rs.used, rs.units)}%"></span><span class="rb-res" style="width:${pct(rs.reserved, rs.units)}%"></span></span></button>`
        );
      })
      .join('');
    el.inspector.innerHTML =
      `<div class="insp-head"><div class="kicker">Floor ${i + 1} of ${project.floors.length}</div>` +
      `<label for="insp-floor-name" class="sr-only">Floor name</label>` +
      `<input id="insp-floor-name" class="name-input ui" type="text" value="${esc(floor.name)}" spellcheck="false" autocomplete="off" maxlength="60">` +
      `<div class="insp-where">${esc(`${plural(floor.rows.length, 'row')} · ${plural(t.racks, 'rack')} · ${plural(t.count, 'device')}`)}</div></div>` +
      statsSection(t) +
      `<section class="insp-sec"><h3>Rows</h3><div class="rack-bars">${rows}</div></section>` +
      `<section class="insp-sec"><h3>Order</h3><div class="btn-grid">` +
      `<button type="button" class="btn sm" data-floor-act="-1"${i ? '' : ' disabled'}>${icon('left')}Earlier</button>` +
      `<button type="button" class="btn sm" data-floor-act="1"${i < project.floors.length - 1 ? '' : ' disabled'}>Later${icon('right')}</button></div></section>` +
      `<div class="insp-actions">` +
      `<button type="button" class="btn" id="floor-map">${icon('map')}Floor map</button>` +
      `<button type="button" class="btn" id="floor-add-row"${floor.rows.length >= M.LIMITS.rows ? ' disabled' : ''}>${icon('plus')}Add row</button>` +
      `<button type="button" class="btn" id="floor-dup"${project.floors.length >= M.LIMITS.floors ? ' disabled title="The plan has six floors"' : ' title="Duplicate (Ctrl+D)"'}>${icon('copy')}Duplicate floor</button>` +
      `<button type="button" class="btn danger-text" id="floor-del"${project.floors.length <= 1 ? ' disabled title="A plan needs at least one floor"' : ''}>${icon('trash')}Delete floor</button>` +
      `</div>`;
    const id = floor.id;
    const input = $('#insp-floor-name');
    input.addEventListener('input', () => {
      const v = input.value;
      commit((p) => void (M.floorById(p, id).name = v), { key: 'floor:' + id, inspector: false });
    });
    input.addEventListener('change', () => {
      if (input.value.trim()) return;
      commit((p) => void (M.floorById(p, id).name = `Floor ${i + 1}`), { key: 'floor:' + id });
    });
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
    const bars = pos.row.racks
      .map((r) => {
        const st = stats.get(r.id);
        return (
          `<button type="button" class="rack-bar${st.overPower || st.overWeight ? ' is-over' : ''}" data-rack="${esc(r.id)}">` +
          `<span class="rb-name">${esc(r.name)}</span><span class="rb-val">${st.used + st.reserved}/${st.units} U · ${fmtKw(st.powerW)}</span>` +
          `<span class="rb-track"><span class="rb-fill" style="width:${pct(st.used, st.units)}%"></span><span class="rb-res" style="width:${pct(st.reserved, st.units)}%"></span></span></button>`
        );
      })
      .join('');
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
      meterHTML('Power', t.powerW, t.powerBudgetW, `${fmtKw(t.powerW)}${t.powerBudgetW ? ` of ${fmtKw(t.powerBudgetW)}` : ''}`, t.overPower > 0) +
      meterHTML('Weight', t.weightKg, t.weightBudgetKg, `${fmtKg(t.weightKg)}${t.weightBudgetKg ? ` of ${fmtKg(t.weightBudgetKg)}` : ''}`, t.overWeight > 0) +
      (t.overPower || t.overWeight ? `<p class="warn-note">${esc(`${plural(t.overPower, 'rack')} over the power budget, ${plural(t.overWeight, 'rack')} over the weight limit.`)}</p>` : '') +
      `</section>` +
      `<section class="insp-sec"><h3>${esc(`${pos.floor.name} · ${pos.row.name}`)}</h3><div class="rack-bars">${bars}</div></section>` +
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
    for (const k of ['site', 'author', 'revision']) {
      const input = $(`#info-${k}`);
      input.addEventListener('input', () => {
        const v = input.value;
        commit((p) => void (p.info[k] = v), { key: 'info:' + k, inspector: false });
      });
    }
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
    if (opts && (opts.reveal || opts.follow)) {
      const g = findDevEl(id);
      if (g) {
        if (opts.reveal) g.focus({ preventScroll: true });
        ensureVisible(g);
      }
    }
    return changed;
  }

  function applyMoves(moves, opts) {
    if (!moves || !moves.length) return false;
    const check = M.canMoveAll(project, moves);
    if (!check.ok) {
      if (!(opts && opts.quiet)) toast(check.reason, { warn: true });
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
    const copy = Object.assign(M.clone(d), { id: M.uid('d'), name: M.nextFreeName(project, d.name), loc: { rack: loc.rack, kind: loc.kind, at: loc.at } });
    ui.selection = { kind: 'devices', ids: [copy.id] };
    const row = rowOfRack(loc.rack);
    if (row !== ui.rowId) setRow(row, { render: false });
    commit((p) => void p.devices.push(copy));
    toast(`Added ${copy.name} at ${M.formatDeviceLoc(project, copy)}`);
  }

  /** Duplicates the selected devices: one like duplicateDevice, several as a block. */
  function duplicateDevices(ids) {
    if (ids.length === 1) return duplicateDevice(ids[0]);
    const targets = M.copyTargets(project, ids);
    if (!targets) return toast(`No room left for a copy of the ${plural(ids.length, 'device')}`, { warn: true });
    copyGroup(targets, 'Duplicated');
    const g = findDevEl(ui.selection.ids[0]);
    if (g) ensureVisible(g);
  }

  function copyGroup(moves, verb) {
    const copies = [];
    const scratch = Object.assign({}, project, { devices: project.devices.slice() });
    for (const m of moves) {
      const d = M.deviceById(project, m.id);
      const c = Object.assign(M.clone(d), { id: M.uid('d'), name: M.nextFreeName(scratch, d.name), loc: m.loc });
      copies.push(c);
      scratch.devices.push(c);
    }
    ui.selection = { kind: 'devices', ids: copies.map((c) => c.id) };
    commit((p) => void p.devices.push(...copies));
    const first = copies[0];
    toast(`${verb || 'Copied'} ${plural(copies.length, 'device')}, from ${first.name} at ${M.formatDeviceLoc(project, first)}`, { action: 'Undo', onAction: undo });
  }

  function deleteDevices(ids) {
    const devs = ids.map((id) => M.deviceById(project, id)).filter(Boolean);
    if (!devs.length) return;
    const gone = new Set(devs.map((d) => d.id));
    ui.selection = null;
    commit((p) => void (p.devices = p.devices.filter((x) => !gone.has(x.id))));
    toast(devs.length === 1 ? `Deleted ${devs[0].name}` : `Deleted ${plural(devs.length, 'device')}`, { action: 'Undo', onAction: undo });
  }

  function replaceProject(next) {
    ui.selection = null;
    ui.focusCluster = null;
    ui.hoverCluster = null;
    disarm();
    const ok = commit((p) => {
      Object.keys(p).forEach((k) => delete p[k]);
      Object.assign(p, M.clone(next));
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
    if (mode !== 'width') {
      el.canvas.scrollTop = 0;
      el.canvas.scrollLeft = 0;
    }
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
    const layer = ghostLayer();
    if (!layer) return;
    if (!loc) {
      layer.innerHTML = '';
      return;
    }
    const hint = device ? null : M.suggestPlacement(project, typeId, loc, 1);
    const clusterId = device ? device.cluster : hint.cluster !== undefined ? hint.cluster : prefs.lastCluster;
    layer.innerHTML = R.renderGhost(project, typeId, loc, ok, {
      theme: ui.theme,
      measure,
      layout: ui.layout,
      height: device ? device.height : height,
      color: clusterColor(clusterId),
      name: device ? device.name : hint.name,
    });
  }

  function drawGhosts(moves, ok) {
    const layer = ghostLayer();
    if (!layer) return;
    const items = moves.map((m) => {
      const d = M.deviceById(project, m.id);
      return { typeId: d.type, loc: m.loc, height: d.height, name: d.name, color: clusterColor(d.cluster) };
    });
    layer.innerHTML = R.renderGhosts(project, items, ok, { theme: ui.theme, measure, layout: ui.layout, rowId: ui.rowId });
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
    const layer = ghostLayer();
    if (layer) layer.innerHTML = '';
  }

  function startDrag(e, d) {
    ui.drag = Object.assign({ pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, loc: null, ok: false, copy: false, ids: [], moves: null }, d);
    try {
      d.captureEl.setPointerCapture(e.pointerId);
    } catch (err) {
      /* pointer capture is a convenience */
    }
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
      else hideGhostOnly();
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

  function hideGhostOnly() {
    const layer = ghostLayer();
    if (layer) layer.innerHTML = '';
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
    try {
      el.svg.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
  }

  // Shift-drag on the empty sheet selects the devices inside a rectangle.
  function startMarquee(e) {
    const pt = toScene(e);
    ui.marquee = { pointerId: e.pointerId, x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, add: e.ctrlKey || e.metaKey, base: selIds() };
    try {
      el.svg.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
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
    const layer = ghostLayer();
    const T = R.THEMES[ui.theme];
    const ids = marqueeIds(m);
    let s = `<rect x="${Math.min(m.x0, m.x1)}" y="${Math.min(m.y0, m.y1)}" width="${Math.abs(m.x1 - m.x0)}" height="${Math.abs(m.y1 - m.y0)}" fill="${T.handle}" fill-opacity="0.12" stroke="${T.select}" stroke-dasharray="4 3" pointer-events="none"/>`;
    for (const id of ids) {
      const d = M.deviceById(project, id);
      const b = R.locRect(project, d.loc, d.type, d.height, ui.layout);
      s += `<rect x="${b.x - 2}" y="${b.y - 2}" width="${b.w + 4}" height="${b.h + 4}" rx="2" fill="none" stroke="${T.select}" stroke-width="1.5" pointer-events="none"/>`;
    }
    if (layer) layer.innerHTML = s;
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
    const h = type.variable ? 2 : type.height;
    startDrag(e, { source: 'palette', typeId: type.id, height: type.variable ? h : undefined, grab: (h * G.U) / 2, captureEl: card });
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

  el.svg.addEventListener('pointermove', (e) => {
    if (!ui.armed || ui.drag || e.pointerType === 'touch') return;
    const type = M.typeOf(project, ui.armed);
    const h = type.variable ? 2 : type.height;
    const pt = toScene(e);
    const loc = R.locateDrop(project, ui.rowId, type.id, pt.x, pt.y, (h * G.U) / 2, h);
    const check = loc ? M.canPlace(project, type.id, loc, null, h) : null;
    drawGhost(type.id, loc, !!(check && check.ok), null, h);
    showChip(e, type.label, loc ? (check.ok ? M.formatLoc(project, loc, type.id, h) : check.reason) : 'Point at a rack', loc ? (check.ok ? 'ok' : 'bad') : '');
  });
  el.svg.addEventListener('pointerleave', () => {
    if (ui.armed && !ui.drag) hideDragFeedback();
  });

  function placeArmedAt(e) {
    const type = M.typeOf(project, ui.armed);
    const h = type.variable ? 2 : type.height;
    const pt = toScene(e);
    const loc = R.locateDrop(project, ui.rowId, type.id, pt.x, pt.y, (h * G.U) / 2, h);
    if (!loc) return;
    const check = M.canPlace(project, type.id, loc, null, h);
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
      ['floors', 'Floors'],
      ['rows', 'Rows'],
      ['racks', 'Racks'],
      ['devices', 'Devices'],
    ];
    const items = [];
    let html = '';
    for (const [key, label] of groups) {
      if (!res[key].length) continue;
      const more = res.counts[key] - res[key].length;
      html += `<div class="sr-group" role="presentation"><span>${label}</span><span class="mono">${res.counts[key]}</span></div>`;
      for (const it of res[key]) {
        const i = items.length;
        items.push(it);
        html +=
          `<div class="sr-item${i === ui.searchActive ? ' is-active' : ''}" role="option" id="sr-${i}" data-i="${i}" aria-selected="${i === ui.searchActive}">` +
          `<span class="sr-kind">${icon(key === 'devices' ? 'rack' : key === 'floors' ? 'map' : key === 'rows' ? 'map' : 'rack', 'ic-sm')}</span>` +
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

  const cat = { tab: 'devices', id: null, error: '', pressed: false, pending: false };

  function openCatalog(tab, id) {
    cat.tab = tab || cat.tab;
    cat.id = id || null;
    cat.error = '';
    renderCatalog();
    openDialog($('#dlg-catalog'));
  }

  function catalogUse(tab, id) {
    return tab === 'devices' ? project.devices.filter((d) => d.type === id).length : M.rackTypeUse(project, id);
  }

  function renderCatalog() {
    const devices = cat.tab === 'devices';
    const list = devices ? project.deviceTypes : project.rackTypes;
    if (!list.some((t) => t.id === cat.id)) cat.id = list.length ? list[0].id : null;
    for (const b of $$('#dlg-catalog [role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.tab === cat.tab));
    const focusId = document.activeElement && $('#cat-form').contains(document.activeElement) ? document.activeElement.id : null;
    $('#cat-list').innerHTML = list
      .map((t) => {
        const n = catalogUse(cat.tab, t.id);
        const sub = devices ? M.formatTypeSpec(t) : `${t.units}U · ${plural(t.sideSlots, 'side slot')}${t.powerW ? ` · ${fmtKw(t.powerW)}` : ''}`;
        const art = devices
          ? (() => {
              const pv = R.renderPreview(t, ui.theme, null, t.defaultName, measure);
              return `<svg class="cat-art" viewBox="0 0 ${pv.width} ${pv.height}" aria-hidden="true">${pv.body}</svg>`;
            })()
          : `<span class="cat-rack" style="--u:${t.units}" aria-hidden="true"></span>`;
        return (
          `<button type="button" role="option" class="cat-item" data-id="${esc(t.id)}" aria-selected="${t.id === cat.id}">` +
          `<span class="cat-grip" title="Drag to reorder" aria-hidden="true">${icon('grip', 'ic-sm')}</span>` +
          `${art}<span class="cat-meta"><span class="cat-name">${esc(devices ? t.label : t.name)}</span><span class="cat-sub">${esc(sub)}</span></span>` +
          `<span class="cat-count" title="${n} in use">${n}</span></button>`
        );
      })
      .join('');
    const menu = $('#menu-cat-new');
    menu.innerHTML = devices
      ? M.TYPE_TEMPLATES.map((t, i) => `<button type="button" role="menuitem" data-template="${i}"><span>${esc(t.label)}</span><small>${esc(M.formatTypeSpec(t))}</small></button>`).join('') +
        (cat.id ? `<hr><button type="button" role="menuitem" data-template="copy"><span>Copy of the selected type</span><small>${esc(M.typeOf(project, cat.id).label)}</small></button>` : '')
      : `<button type="button" role="menuitem" data-template="rack"><span>New rack type</span><small>42U, 2 side slots</small></button>` +
        (cat.id ? `<button type="button" role="menuitem" data-template="copy"><span>Copy of the selected type</span><small>${esc(M.rackTypeById(project, cat.id).name)}</small></button>` : '');
    $('#cat-form').innerHTML = cat.id ? (devices ? deviceTypeForm(M.typeOf(project, cat.id)) : rackTypeForm(M.rackTypeById(project, cat.id))) : `<p class="empty-note">No types yet. Add one with “New type”.</p>`;
    if (cat.error) showError('#cat-error', cat.error);
    if (focusId && $(`#${focusId}`)) $(`#${focusId}`).focus();
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
    if (cat.pending) setTimeout(() => {
      cat.pending = false;
      if ($('#dlg-catalog').open) renderCatalog();
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

  function deviceTypeForm(t) {
    const n = catalogUse('devices', t.id);
    const pv = R.renderPreview(t, ui.theme, '#2f6fdb', t.defaultName, measure);
    const faces = M.FACES.map((f) => `<option value="${f.id}"${f.id === t.face ? ' selected' : ''}>${esc(f.label)}</option>`).join('');
    return (
      `<div class="cat-preview"><svg viewBox="0 0 ${pv.width} ${pv.height}" aria-hidden="true">${pv.body}</svg></div>` +
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
      `<p class="form-error" id="cat-error" role="alert" hidden></p>` +
      `<div class="cat-actions">${orderButtons(project.deviceTypes, t.id)}<span class="sec-hint">${n ? `${plural(n, 'device')} of this type` : 'Not used yet'}</span><span class="spacer"></span>` +
      `<button type="button" class="btn sm danger-text" id="cat-delete">${icon('trash')}Delete type</button></div>`
    );
  }

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
      `</div>` +
      `<p class="sec-hint">Up to ${maxSlots} side slot${maxSlots === 1 ? '' : 's'} fit a ${t.units}U rack. A budget of 0 means none; racks over their budget are flagged in red.</p>` +
      `<p class="form-error" id="cat-error" role="alert" hidden></p>` +
      `<div class="cat-actions">${orderButtons(project.rackTypes, t.id)}<span class="sec-hint">${n ? `Used by ${plural(n, 'rack')}` : 'Not used yet'}</span><span class="spacer"></span>` +
      `<button type="button" class="btn sm danger-text" id="cat-delete"${n || project.rackTypes.length <= 1 ? ' disabled' : ''} title="${n ? 'Give its racks another type first' : ''}">${icon('trash')}Delete type</button></div>`
    );
  }

  function catalogChange(input) {
    const prop = input.dataset.prop;
    let value = input.value;
    if (input.dataset.num !== undefined) value = Number(value);
    if (input.dataset.kw !== undefined) value = Number(value) * 1000;
    const id = cat.id;
    let err = null;
    commit((p) => {
      err = cat.tab === 'devices' ? M.updateDeviceType(p, id, { [prop]: value }) : M.updateRackType(p, id, { [prop]: value });
      return err ? false : undefined;
    });
    cat.error = err || '';
    refreshCatalog();
  }

  $('#cat-form').addEventListener('change', (e) => {
    if (e.target.dataset && e.target.dataset.prop) catalogChange(e.target);
  });
  $('#cat-form').addEventListener('click', async (e) => {
    if (!e.target.closest('#cat-delete')) return;
    const id = cat.id;
    if (cat.tab === 'devices') {
      const t = M.typeOf(project, id);
      const n = catalogUse('devices', id);
      if (n) {
        const ok = await confirmDialog({
          title: `Delete ${t.label}?`,
          body: `${plural(n, 'device')} of this type ${n === 1 ? 'is' : 'are'} deleted with it. Undo brings everything back.`,
          ok: 'Delete type and devices',
        });
        if (!ok) return;
        openDialog($('#dlg-catalog'));
      }
      commit((p) => void M.deleteDeviceType(p, id));
      toast(`Deleted the type ${t.label}`, { action: 'Undo', onAction: undo });
    } else {
      let err = null;
      commit((p) => {
        err = M.deleteRackType(p, id);
        return err ? false : undefined;
      });
      if (err) return showError('#cat-error', err);
    }
    cat.id = null;
    cat.error = '';
    renderCatalog();
  });
  /** Moves a type to `toIndex` of its list and keeps it selected. */
  function moveCatalogItem(id, toIndex, refocus) {
    const move = cat.tab === 'devices' ? M.moveDeviceType : M.moveRackType;
    commit((p) => (move(p, id, toIndex) ? undefined : false));
    cat.id = id;
    cat.error = '';
    renderCatalog();
    const item = $(`#cat-list .cat-item[data-id="${CSS.escape(id)}"]`);
    if (item && refocus) item.focus();
    if (item) item.scrollIntoView({ block: 'nearest' });
  }

  $('#cat-form').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat-move]');
    if (!b) return;
    const list = cat.tab === 'devices' ? project.deviceTypes : project.rackTypes;
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
    cat.id = next.dataset.id;
    cat.error = '';
    renderCatalog();
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
    cat.id = item.dataset.id;
    cat.error = '';
    renderCatalog();
  });
  $$('#dlg-catalog [role="tab"]').forEach((b) =>
    b.addEventListener('click', () => {
      cat.tab = b.dataset.tab;
      cat.id = null;
      cat.error = '';
      renderCatalog();
    })
  );
  $('#cat-new').addEventListener('click', () => toggleMenu($('#cat-new'), $('#menu-cat-new')));
  $('#menu-cat-new').addEventListener('click', (e) => {
    const item = e.target.closest('[data-template]');
    if (!item) return;
    closeMenus();
    const tpl = item.dataset.template;
    let made = null;
    commit((p) => {
      if (cat.tab === 'devices') {
        const src = tpl === 'copy' ? Object.assign({}, M.typeOf(p, cat.id)) : M.TYPE_TEMPLATES[Number(tpl)];
        made = M.addDeviceType(p, src);
      } else {
        const src = tpl === 'copy' ? Object.assign({}, M.rackTypeById(p, cat.id)) : { name: 'Custom rack', units: 42, sideSlots: 2, powerW: 8000, weightKg: 1000 };
        made = M.addRackType(p, src);
      }
      return made ? undefined : false;
    });
    if (!made) return toast(`The catalog is full`, { warn: true });
    cat.id = made.id;
    cat.error = '';
    renderCatalog();
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
      const text = lib.load(id);
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
          if (text && lib.save(id, text.project)) renderPlans();
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

  function toggleMenu(btn, menu) {
    const willOpen = menu.hidden;
    closeMenus();
    if (!willOpen) return;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('[aria-checked="true"]') || menu.querySelector('button');
    if (first) first.focus();
  }

  [
    ['#btn-export', '#menu-export'],
    ['#btn-new', '#menu-new'],
    ['#btn-row', '#menu-row'],
    ['#cat-new', '#menu-cat-new'],
  ].forEach(([b, m]) => {
    const btn = $(b);
    const menu = $(m);
    if (b !== '#cat-new') {
      btn.addEventListener('click', () => {
        if (b === '#btn-row') renderRowMenu();
        toggleMenu(btn, menu);
      });
    }
    menu.addEventListener('keydown', (e) => {
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
    });
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
    const base = slug(project.name) || 'rack-plan';
    if (!rowScoped || M.allRows(project).length === 1) return base;
    const pos = currentRow();
    return `${base}-${slug(pos.floor.name)}-${slug(pos.row.name)}`.slice(0, 100);
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

  el.planName.addEventListener('input', () => {
    const v = el.planName.value;
    commit((p) => void (p.name = v), { key: 'plan-name', inspector: false });
  });
  el.planName.addEventListener('change', () => {
    if (el.planName.value.trim()) return;
    commit((p) => void (p.name = 'Untitled rack plan'), { key: 'plan-name' });
    el.planName.value = project.name;
  });

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

    if (mod && !e.altKey && (key === 'z' || key === 'Z')) {
      if (textEntry) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && (key === 'y' || key === 'Y')) {
      if (textEntry) return;
      e.preventDefault();
      redo();
      return;
    }
    if (mod && (key === 'k' || key === 'K')) {
      e.preventDefault();
      el.search.focus();
      el.search.select();
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
    if (mod && !e.shiftKey && !e.altKey && (key === 'd' || key === 'D') && ui.selection) {
      e.preventDefault();
      const s = ui.selection;
      return s.kind === 'devices' ? duplicateDevices(s.ids) : duplicateStructure(s.kind, s.id);
    }
    if (mod && (key === 'a' || key === 'A') && ui.view === 'sheet') {
      e.preventDefault();
      return selectDevices(M.devicesWithin(project, ui.rowId).map((x) => x.id));
    }
    if (mod || e.altKey) return;
    if (key === '/') {
      e.preventDefault();
      el.search.focus();
      el.search.select();
    } else if (key === '[') stepRow(-1);
    else if (key === ']') stepRow(1);
    else if (key === 'm' || key === 'M') setView(ui.view === 'map' ? 'sheet' : 'map');
    else if (key === '+' || key === '=') setZoom(ui.zoom * 1.2);
    else if (key === '-' || key === '_') setZoom(ui.zoom / 1.2);
    else if (key === '0') fitZoom('sheet');
    else if (key === '1') setZoom(1);
  });

  // --------------------------------------------------------- environment

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

  bootPlan();
  render();
  if (prefs.zoom) {
    setZoom(prefs.zoom, null, false);
    el.canvas.scrollTop = 0;
    el.canvas.scrollLeft = 0;
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
