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
  const CR = window.RP.cablingRender;
  const IO = window.RP.io;
  const R = window.RP.render;
  const G = R.geometry;

  const PREFS_KEY = 'rackplanner.prefs.v1';
  const HISTORY_LIMIT = 200;
  // Undo keeps whole snapshots; cap their total size for very large plans.
  const HISTORY_CHARS = 40e6;
  // Characters a browser usually keeps in localStorage for a site, which all saved plans share.
  const STORAGE_CHARS = 5 * 1024 * 1024;
  /** "Click" in a hint, which a touch screen reads as "Tap" (css/app.css shows one of the two). */
  const CLICK = '<span class="hint-touch">Tap</span><span class="hint-pointer">Click</span>';
  const COLOR_NAMES = ['Cobalt', 'Amber', 'Sky', 'Teal', 'Vermilion', 'Plum', 'Yellow', 'Brown', 'Violet', 'Green', 'Rose', 'Olive'];
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
  /** What of a rack's stats is over budget: "12.1 kW of 12.0 kW", "1,020 kg of 1,000 kg" or both. */
  const overText = (st) =>
    [st.overPower && withBudget(fmtKw, st.powerW, st.powerBudgetW), st.overWeight && withBudget(fmtKg, st.weightKg, st.weightBudgetKg)].filter(Boolean).join(' and ');
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
    keys() {
      try {
        return Object.keys(window.localStorage);
      } catch (e) {
        return [];
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

  const prefs = Object.assign({ zoom: null, lastClusters: {}, view: 'sheet', metric: 'space', rows: {}, views: {}, noted: {}, theme: 'system', workspace: 'racks', detail: 'full' }, readJSON(PREFS_KEY) || {});
  if (!prefs.rows || typeof prefs.rows !== 'object') prefs.rows = {};
  if (!prefs.views || typeof prefs.views !== 'object') prefs.views = {};
  if (!prefs.lastClusters || typeof prefs.lastClusters !== 'object') prefs.lastClusters = {};
  if (!prefs.noted || typeof prefs.noted !== 'object') prefs.noted = {};
  delete prefs.lastCluster;
  if (prefs.workspace !== 'cabling') prefs.workspace = 'racks';
  if (!THEME_PICKS.has(prefs.theme)) prefs.theme = 'system';
  if (prefs.detail !== 'bare') prefs.detail = 'full';
  prefs.compactParts = prefs.compactParts === true;
  if (!(prefs.binSplit > 0)) delete prefs.binSplit;
  const lib = window.RP.library.create(storage);
  let planId = null;
  let project = null;
  let projectJSON = '';
  let savedJSON = null; // projectJSON as last loaded or saved
  let savedRev = 0; // the plan's revision in the library as last loaded or saved (see followOtherTab)
  let standIn = false; // the open plan only stands in for a shared one that is being read (see bootPlan)
  let backupDue = false; // the open plan needed fixing on load or has another version: the first save keeps it as stored (see flushPersist)
  const history = { past: [], future: [], key: null, at: 0, chars: 0 };
  // The next change of the address replaces the entry instead of adding one; none is written while one is followed (see writeAddress).
  const address = { replace: true, following: false };
  const ui = {
    workspace: prefs.workspace, // 'racks' | 'cabling'; the Cabling workspace keeps its own state (js/cabling-ui.js)
    selection: null, // { kind: 'devices', ids } | { kind: 'rack' | 'row' | 'floor', id }
    rowId: null, // the row shown
    view: prefs.view === 'map' ? 'map' : 'sheet',
    metric: ['space', 'power', 'weight'].includes(prefs.metric) ? prefs.metric : 'space',
    clusterView: null, // id of the plan view whose clusters color the devices (ui.view is the sheet or floor map)
    focusCluster: null, // cluster id, '__none' for unassigned, or null
    hoverCluster: null,
    hiddenClusters: new Map(), // view id → the clusters of that view the sheet does not draw: ids, '__none' for its unassigned devices
    query: '',
    searchOpen: false,
    searchActive: -1,
    searchItems: [],
    armed: null, // device type id while click-to-place is active
    moving: null, // id of the selected device that a tap on a free slot moves (touch screens)
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

  /** Makes `p`, saved as plan `id`, the open plan, with a fresh undo history. `backup` as from lib.load. */
  function openPlan(id, p, backup) {
    planId = id;
    standIn = false;
    backupDue = !!backup;
    setUnsaved(false);
    project = p;
    projectJSON = JSON.stringify(project);
    savedJSON = projectJSON;
    savedRev = id ? lib.rev(id) : 0;
    history.past = [];
    history.future = [];
    history.chars = 0;
    history.key = null;
    ui.selection = null;
    ui.focusCluster = null;
    ui.hoverCluster = null;
    ui.hiddenClusters.clear();
    ui.armed = null;
    cab.reset();
    // Undo buttons in toasts refer to the previous plan.
    el.toasts.textContent = '';
    // Back does not go to a row of the plan before.
    address.replace = true;
    const remembered = prefs.rows[id];
    ui.rowId = remembered && M.rowById(project, remembered) ? remembered : M.allRows(project)[0].row.id;
    ui.clusterView = M.viewOf(project, prefs.views[id]).id;
    if (id) lib.setCurrent(id);
  }

  function bootPlan() {
    const moved = lib.migrate();
    let id = lib.current() || (lib.list()[0] || {}).id || null;
    let loaded = id ? lib.load(id) : null;
    // A plan a newer version saved stays as it is, and another plan shows instead.
    const newer = !loaded && id && lib.newer(id);
    if (!loaded && location.hash.startsWith(SHARE_PREFIX)) {
      // Opened from a share link with no plans yet: the shared plan comes
      // instead of the example. Till it is read an empty plan stands in,
      // saved only once it is changed.
      openPlan(null, M.createEmptyProject());
      standIn = true;
      return;
    }
    if (!loaded) {
      const p = M.createExampleProject();
      id = lib.add(p);
      loaded = { project: p, warnings: [] };
    }
    openPlan(id, loaded.project, loaded.backup);
    const movedHere = !!moved && moved.id === id;
    reportLoad((movedHere ? moved.warnings : []).concat(loaded.warnings), loaded.backup || (movedHere && moved.backup));
    if (newer) toast(IO.NEWER, { warn: true });
  }

  /**
   * Lists what reading the saved plan that was just opened fixed, as Open
   * does for a file, when reading changed it (`changed`, so it has a
   * backup). Warnings that change nothing, such as two rows of one name,
   * are advice: they show when one of them is new, not at each open.
   */
  function reportLoad(warnings, changed) {
    const prints = warnings.map(fingerprint).slice(0, 200);
    const noted = prefs.noted[planId] || [];
    if (!changed && prints.every((x) => noted.includes(x))) return;
    if (prints.length) prefs.noted[planId] = prints;
    else delete prefs.noted[planId];
    savePrefs();
    const sub = changed ? 'needed fixing. A backup keeps the plan as it was saved.' : 'to look at. Opening it changed nothing.';
    reportWarnings(`Opened ${project.name}`, `${plural(warnings.length, 'thing')} in the saved plan ${sub}`, warnings);
  }

  let persistTimer = null;
  let storageWarned = false;
  let unsaved = false; // the last save failed: the latest changes are only in this tab
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(flushPersist, 300);
  }
  /** Saves the plan if it changed. False when it did not, because another tab saved it since and the user is asked first. */
  function flushPersist() {
    clearTimeout(persistTimer);
    persistTimer = null;
    if (!project || ((planId || standIn) && projectJSON === savedJSON)) {
      // Taken back to what is stored, by Undo, it is saved again.
      if (project) setUnsaved(false);
      return true;
    }
    if (planId && (changedElsewhere() || $('#dlg-elsewhere').open)) {
      askElsewhere();
      return false;
    }
    let ok = false;
    if (planId) {
      if (backupDue) lib.backup(planId);
      ok = lib.save(planId, project);
    } else if ((planId = lib.add(project))) {
      lib.setCurrent(planId);
      ok = true;
    }
    if (ok) {
      savedJSON = projectJSON;
      savedRev = lib.rev(planId);
      backupDue = false;
    }
    if (!ok && !storageWarned) {
      storageWarned = true;
      // A newer version of the app saved the plan meanwhile: it is not saved over.
      toast(lib.newer(planId) ? IO.NEWER : 'This browser did not save the plan: its storage is full or blocked. Delete plans you no longer need, or export the plan file to keep your work.', { warn: true });
    } else if (ok) storageWarned = false;
    setUnsaved(!ok);
    return true;
  }

  /** Marks the open plan as not saved, on the Plans button, while its saves fail; the toast of the first failure is not repeated. */
  function setUnsaved(on) {
    unsaved = on;
    const b = $('#btn-plans');
    b.classList.toggle('is-unsaved', on);
    b.title = on ? 'Plans saved in this browser. The latest changes to this plan are not saved: the browser storage is full or blocked' : 'Plans saved in this browser';
  }
  /** A size in characters, as browser storage counts it. */
  const sizeText = (n) => (n < 1000 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

  // Other tabs ---------------------------------------------------------

  /** True when another tab saved the open plan after this one loaded or saved it. */
  function changedElsewhere() {
    const rev = planId ? lib.rev(planId) : 0;
    return rev !== 0 && rev !== savedRev;
  }

  /**
   * Takes up what another tab saved to the open plan: at once while this
   * tab has no changes of its own to save, otherwise once the user picks
   * Reload or Keep mine as a copy. A newer save is never saved over.
   */
  function followOtherTab() {
    if (!changedElsewhere() || $('#dlg-elsewhere').open) return;
    if (projectJSON === savedJSON) {
      reloadPlan();
      toast('This plan changed in a different tab: it shows those changes now');
    } else askElsewhere();
  }

  /** Shows the open plan as it is saved; the undo history was of the plan before. */
  function reloadPlan() {
    const loaded = lib.load(planId);
    if (!loaded) {
      if (lib.newer(planId)) toast(IO.NEWER, { warn: true });
      return;
    }
    clearTimeout(persistTimer);
    persistTimer = null;
    savedJSON = JSON.stringify(loaded.project);
    savedRev = lib.rev(planId);
    backupDue = loaded.backup;
    history.past = [];
    history.future = [];
    history.chars = 0;
    el.toasts.textContent = '';
    restore(savedJSON);
    // The name field shows what was typed while it has focus: here that is gone.
    el.planName.value = project.name;
  }

  function askElsewhere() {
    const dlg = $('#dlg-elsewhere');
    if (dlg.open) return;
    $('#elsewhere-name').textContent = project.name;
    dlg.returnValue = '';
    openDialog(dlg);
  }
  // Nothing goes on before an answer; a dialog closed all the same keeps this tab's changes.
  $('#dlg-elsewhere').addEventListener('cancel', (e) => e.preventDefault());
  $('#dlg-elsewhere').addEventListener('close', () => {
    if ($('#dlg-elsewhere').returnValue === 'reload') return reloadPlan();
    // This tab's plan, with its undo history, goes on as a new plan; the other tab's stays as it saved it.
    const theirs = lib.list().find((p) => p.id === planId);
    planId = null;
    commit((p) => {
      p.name = lib.uniqueName(p.name);
      delete p.meta.example;
    });
    flushPersist();
    setRow(ui.rowId, { render: false });
    toast(`Kept this tab’s changes as ${project.name}${theirs ? `; ${theirs.name} has the other tab’s` : ''}`);
  });

  // An entry of the history is a plan as it was before a step, and that step.
  function pushPast(entry) {
    history.past.push(entry);
    history.chars += entry.json.length;
    while (history.past.length > HISTORY_LIMIT || (history.chars > HISTORY_CHARS && history.past.length > 1)) {
      history.chars -= history.past.shift().json.length;
    }
  }
  function popPast() {
    const entry = history.past.pop();
    history.chars -= entry.json.length;
    return entry;
  }
  /** The step that undo reverts next, or null. */
  const lastStep = () => (history.past.length ? history.past[history.past.length - 1].step : null);

  /**
   * Applies `mutate` to a copy of the project and records an undo step.
   * Edits sharing `opts.key` within two seconds (typing) share one step.
   * The step keeps the row and view shown, and `opts.label` to name it in
   * undo and redo (a toast with Undo names it otherwise).
   */
  function commit(mutate, opts) {
    const o = opts || {};
    const draft = JSON.parse(projectJSON);
    if (mutate(draft) === false) return false;
    const after = JSON.stringify(draft);
    if (after === projectJSON) return false;
    const now = Date.now();
    const coalesce = o.key && history.key === o.key && now - history.at < 2000;
    if (!coalesce) pushPast({ json: projectJSON, step: { label: o.label || null, rowId: ui.rowId, view: ui.clusterView } });
    history.key = o.key || null;
    history.at = now;
    history.future.length = 0;
    project = draft;
    projectJSON = after;
    persist();
    render(o);
    retireUndoToasts();
    return true;
  }

  /** Commits `make(draft)`, which returns what it added, or null to leave the plan as it is; `label(made)` names the step. */
  function commitAdd(make, label) {
    let made = null;
    const opts = {};
    commit((p) => {
      made = make(p);
      if (made && label) opts.label = label(made);
      return made ? undefined : false;
    }, opts);
    return made;
  }

  /** Commits `change(draft)`, which returns an error message and leaves the plan as it is, or null; `label` names the step. */
  function commitOrError(change, label) {
    let err = null;
    commit(
      (p) => {
        err = change(p);
        return err ? false : undefined;
      },
      { label }
    );
    return err;
  }

  /** Shows the plan `json`; with an undo `step`, at the row and in the view the step was made in. Returns where it went: 'Ground floor · Row A', or ''. */
  function restore(json, step) {
    projectJSON = json;
    project = JSON.parse(json);
    history.key = null;
    const went = [];
    if (step && step.rowId !== ui.rowId && M.rowById(project, step.rowId)) {
      setRow(step.rowId, { render: false });
      const pos = currentRow();
      went.push(pos.floor.name, pos.row.name);
    }
    if (step && setClusterView(step.view, { render: false })) went.push(M.viewById(project, step.view).name);
    persist();
    render();
    // Text refused for the plan as it was belongs to no field of this one.
    cat.keep = null;
    cat.error = '';
    if ($('#dlg-catalog').open) renderCatalog();
    if ($('#dlg-views').open) renderViewList();
    cab.onRestore();
    return went.join(' · ');
  }
  /** Says what undo or redo did (`verb`), and where when it went to another row or view. */
  function toastStep(verb, step, went) {
    toast(`${step.label ? `${verb}: ${step.label}` : `${verb} a change`}${went ? ` (${went})` : ''}`, { kind: 'undo' });
  }
  function undo() {
    if (!history.past.length) return;
    const entry = popPast();
    history.future.push({ json: projectJSON, step: entry.step });
    const went = restore(entry.json, entry.step);
    retireUndoToasts();
    toastStep('Undid', entry.step, went);
  }
  function redo() {
    if (!history.future.length) return;
    const entry = history.future.pop();
    pushPast({ json: projectJSON, step: entry.step });
    const went = restore(entry.json, entry.step);
    retireUndoToasts();
    toastStep('Redid', entry.step, went);
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
    bare: $('#btn-bare'),
    redo: $('#btn-redo'),
    navUndo: $('#btn-nav-undo'),
    navRedo: $('#btn-nav-redo'),
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
    status: $('#status'),
    fileInput: $('#file-input'),
    printRoot: $('#print-root'),
  };

  // The Cabling workspace: app.js hands it what it needs and calls its hooks
  // at the dispatch points below while ui.workspace is 'cabling'.
  const cab = window.RP.cablingUI.create({
    project: () => project,
    view: () => ui.clusterView,
    ui,
    prefs,
    savePrefs,
    el,
    commit,
    commitAdd,
    undo,
    render,
    renderStage,
    renderInspector,
    setRow,
    currentRow,
    setWorkspace,
    toast,
    openDialog,
    showError,
    confirmDialog,
    reportWarnings,
    renderSwatches,
    openCatalog,
    download,
    fileBase,
    keepFocus,
    listName,
    toggleEye,
    hiddenNote,
    measure,
    applyZoom: () => applyZoom(),
    fitWidth: () => fitWidth(),
    esc,
    icon,
    plural,
  });

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
    // The Cabling elevation keeps its zoom and scroll for each row.
    if (changed && ui.workspace === 'cabling') cab.keepElevation();
    ui.rowId = rowId;
    if (o.view) ui.view = o.view;
    prefs.rows[planId] = rowId;
    prefs.rows[`${planId}:${M.locateRow(project, rowId).floor.id}`] = rowId;
    prefs.view = ui.view;
    savePrefs();
    if (o.render !== false) render();
    if (!changed || o.keepScroll) return;
    if (o.render === false || ui.workspace !== 'cabling' || !cab.elevationAgain()) scrollToOrigin();
  }

  /**
   * Selects devices. With `follow`, the view moves to the row of the first
   * one; `focus` puts keyboard focus on it, `reveal` scrolls it into view.
   */
  function selectDevices(ids, opts) {
    const o = opts || {};
    const list = [...new Set(ids)].filter((id) => M.deviceById(project, id));
    ui.selection = list.length ? { kind: 'devices', ids: list } : null;
    if (list.length > 1) announce(`${plural(list.length, 'device')} selected`);
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
    // Racks, rows and floors are edited in the Racks workspace: the toast says so, with the way back.
    if (ui.workspace === 'cabling') {
      setWorkspace('racks');
      const what = { floor: 'Floor', row: 'Row', rack: 'Rack' }[kind];
      toast(`${what} settings open in Racks`, { kind: 'where', action: 'Back to Cabling', onAction: () => setWorkspace('cabling') });
    }
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
    if (ui.workspace === 'cabling') cab.renderBin();
    else {
      renderParts();
      renderClusters();
    }
    if (o.inspector !== false) renderInspector();
    renderChrome();
    if (ui.searchOpen) renderSearchResults();
    writeAddress();
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
    if (!M.viewById(project, ui.clusterView)) ui.clusterView = project.views[0].id;
    const validIn = (view, c) => !c || (c === '__none' ? project.devices.some((d) => !M.clusterIdOf(project, d, view)) : M.clustersOf(project, view).some((x) => x.id === c));
    const valid = (c) => validIn(ui.clusterView, c);
    if (!valid(ui.focusCluster)) ui.focusCluster = null;
    if (!valid(ui.hoverCluster)) ui.hoverCluster = null;
    // Each view keeps what it hides; a view deleted takes its set along.
    for (const [view, set] of ui.hiddenClusters) {
      if (!M.viewById(project, view)) ui.hiddenClusters.delete(view);
      else for (const c of set) if (!validIn(view, c)) set.delete(c);
    }
    if (ui.armed && !M.typeOf(project, ui.armed)) ui.armed = null;
    if (ui.moving && selIds().join() !== ui.moving) ui.moving = null;
    cab.prune();
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
  /**
   * In the one-column layout, where the page scrolls, brings the stage into
   * view after a jump that lands in it (a search result, a rack on the floor
   * map, a device type to place), unless it already fills the screen.
   */
  const oneColumn = window.matchMedia ? window.matchMedia('(max-width: 960px)') : { matches: false };
  const reducedMotion = () => !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function showStage() {
    if (!oneColumn.matches) return;
    const r = el.stage.getBoundingClientRect();
    const whole = r.top >= -1 && r.bottom <= window.innerHeight + 1;
    const covers = r.top <= 1 && r.bottom >= window.innerHeight - 1;
    if (!whole && !covers) el.stage.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
  /** The example's notice goes above the Devices panel in the one-column layout, to be seen first; beside the drawing, under its nav bar. */
  function placeNotice() {
    if (oneColumn.matches) $('#bin').before(el.notice);
    else $('.nav', el.stage).after(el.notice);
  }
  placeNotice();
  if (oneColumn.addEventListener) oneColumn.addEventListener('change', placeNotice);
  /** Whether keyboard focus was lost: on the page itself, or on a control gone, hidden or disabled. */
  function focusLost() {
    const a = document.activeElement;
    return !a || a === document.body || !a.isConnected || !a.getClientRects().length || !!a.disabled;
  }
  /** Puts keyboard focus on what the stage shows: the selected device, the floor map's current row, or the drawing or table itself. */
  function focusStage() {
    let t = null;
    if (ui.workspace === 'racks' && ui.view === 'map') t = el.floormap.querySelector(`[data-open-row="${CSS.escape(ui.rowId)}"]`);
    else if (ui.workspace === 'racks' && selIds().length) t = findDevEl(selIds()[0]);
    if (!t) t = [el.svg, $('#cab-host')].find((n) => n.getClientRects().length);
    if (t) t.focus({ preventScroll: true });
  }
  /** Puts keyboard focus in the name field of the rack shown in the inspector. */
  function focusRackName() {
    const input = $('#insp-rack-name');
    if (input) input.focus();
  }
  /** Whether a click came from the keyboard: Enter or Space on a button. */
  const byKeyboard = (e) => e.detail === 0;

  /** Replaces the previews drawn over the sheet (placement ghosts, the selection rectangle). */
  function setGhosts(html) {
    const layer = el.svg.querySelector('#ghost-layer');
    if (layer) layer.innerHTML = html;
  }

  /** Id of the cluster device `d` has in the view shown, or null. */
  const clusterIdOf = (d) => M.clusterIdOf(project, d, ui.clusterView);
  /** The clusters of the view shown. */
  const viewClusters = () => M.clustersOf(project, ui.clusterView);
  /** The devices the search matches, or null without a search. */
  const searchMatcher = () => (ui.query.trim() ? M.deviceMatcher(project, ui.query, ui.clusterView) : null);
  /** The clusters the view shown hides: ids, '__none' for its unassigned devices. */
  function hiddenClusters() {
    if (!ui.hiddenClusters.has(ui.clusterView)) ui.hiddenClusters.set(ui.clusterView, new Set());
    return ui.hiddenClusters.get(ui.clusterView);
  }
  /** The devices the sheet draws hidden: those of hidden clusters, but not the ones selected or matched by the search. */
  function drawnHidden() {
    const hide = hiddenFn();
    if (!hide) return null;
    const sel = selSet();
    const match = searchMatcher();
    return (d) => hide(d) && !sel.has(d.id) && !(match && match(d));
  }
  /**
   * An eye clicked in the cluster or network list, of the group `id` of
   * those `keys`, in the set hidden: it hides or shows the group; with
   * `only` (Alt-click) it shows that group alone, and all of them again
   * when it already was.
   */
  function toggleEye(hidden, keys, id, only) {
    if (!only) {
      if (!hidden.delete(id)) hidden.add(id);
      return;
    }
    const alone = keys.every((k) => (k === id) !== hidden.has(k));
    hidden.clear();
    if (!alone) for (const k of keys) if (k !== id) hidden.add(k);
  }
  /**
   * "2 clusters hidden · Show all" in `node`, under a list, while it hides
   * something (`text`); its button has data-show-all. Hidden, it keeps its
   * last text, which keeps its space (see .sec-foot).
   */
  function hiddenNote(node, text) {
    node.hidden = !text;
    if (!text || node.dataset.text === text) return;
    node.dataset.text = text;
    node.innerHTML = `${esc(text)} · <button type="button" class="btn-link" data-show-all>Show all</button>`;
  }
  /** Shows a cluster of the view shown that the racks hide. */
  function showCluster(id) {
    if (hiddenClusters().delete(id)) render();
  }
  /** The clusters hidden, as the sheet's legend marks them: ids, null for the unassigned devices. */
  const legendHidden = () => [...hiddenClusters()].map((k) => (k === '__none' ? null : k));
  /** Whether the view shown hides device `d`, or null when it hides nothing. */
  function hiddenFn() {
    const set = hiddenClusters();
    return set.size ? (d) => set.has(clusterIdOf(d) || '__none') : null;
  }

  /** Devices to show at full strength: the focused cluster (or the one hovered, unless it is hidden) and search matches. */
  function highlightFn() {
    const hover = ui.hoverCluster && !hiddenClusters().has(ui.hoverCluster) ? ui.hoverCluster : null;
    const focus = hover || ui.focusCluster;
    const match = searchMatcher();
    if (!focus && !match) return null;
    return (d) => (!focus || (focus === '__none' ? !clusterIdOf(d) : clusterIdOf(d) === focus)) && (!match || match(d));
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
    if (ui.workspace === 'cabling') return cab.renderStage();
    const map = ui.view === 'map';
    el.svg.toggleAttribute('hidden', map);
    el.floormap.hidden = !map;
    el.zoom.hidden = map;
    el.canvas.classList.toggle('is-map', map);
    if (map) keepFocus(el.floormap, renderFloorMap);
    else renderScene();
  }

  function renderScene() {
    if (ui.view === 'map' || ui.workspace === 'cabling') return;
    const active = document.activeElement;
    const inside = active && active !== el.svg && el.svg.contains(active) && active.dataset;
    const focusedId = inside ? active.dataset.id : null;
    const focusedRack = inside && active.classList.contains('rack-head') ? active.dataset.rack : null;
    const sel = ui.selection;
    const d = ui.drag;
    const out = R.renderScene(project, {
      rowId: ui.rowId,
      theme: ui.theme,
      bare: prefs.detail === 'bare',
      interactive: true,
      measure,
      date: todayISO(),
      sheet: sheetInfo(ui.rowId),
      selected: selSet(),
      selectedRack: sel && sel.kind === 'rack' ? sel.id : null,
      highlight: highlightFn(),
      hidden: drawnHidden(),
      hiddenClusters: legendHidden(),
      view: ui.clusterView,
      dragging: d && d.active && d.source === 'device' && !d.copy ? new Set(d.ids) : null,
    });
    ui.layout = out.layout;
    ui.sceneW = out.width;
    ui.sceneH = out.height;
    el.svg.setAttribute('viewBox', `0 0 ${out.width} ${out.height}`);
    el.svg.setAttribute('aria-label', `Rack elevation of ${out.layout.floor.name}, ${out.layout.row.name}`);
    el.svg.innerHTML = out.body + '<g id="ghost-layer"></g>';
    delete el.svg.dataset.drawn;
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
    const head = focusedRack && el.svg.querySelector(`.rack-head[data-rack="${CSS.escape(focusedRack)}"]`);
    if (head) head.focus({ preventScroll: true });
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
    const hidden = drawnHidden();
    const match = ui.query.trim() ? M.deviceMatcher(project, ui.query, ui.clusterView) : null;
    const sel = ui.selection;
    const colors = new Map(viewClusters().map((c) => [c.id, c.color]));
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
          // A hidden device keeps its units taken, without its cluster's color, as in the sheet.
          const off = !!(hidden && hidden(d));
          const c = off ? null : colors.get(clusterIdOf(d));
          blocks += `<i class="${res ? 'res' : ''}${off ? ' is-hidden' : hl && !hl(d) ? ' dim' : ''}" style="top:${(((d.loc.at - 1) / st.units) * 100).toFixed(2)}%;height:${((h / st.units) * 100).toFixed(2)}%${c ? `;--c:${c}` : ''}"></i>`;
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
    else if (t.dataset.rack) {
      selectThing('rack', t.dataset.rack, { sheet: true, reveal: true });
      showStage();
      // The floor map is gone: the keyboard goes on in the rack's settings.
      if (byKeyboard(e)) focusRackName();
    } else if (t.dataset.addRack) addRackTo(t.dataset.addRack);
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
    if (ui.workspace === 'cabling') cab.renderNav();
  }

  function renderFloorTabs() {
    const pos = currentRow();
    const sel = ui.selection;
    el.floorTabs.innerHTML =
      project.floors
        .map((f) => {
          const on = f === pos.floor;
          const picked = sel && sel.kind === 'floor' && sel.id === f.id;
          return `<button type="button" class="ftab${picked ? ' is-selected' : ''}" data-floor="${esc(f.id)}" aria-pressed="${on}" title="${on ? `${esc(f.name)}: click for floor settings${ui.workspace === 'cabling' ? ' (opens Racks)' : ''}` : `Show ${esc(f.name)}`}">${esc(f.name)}</button>`;
        })
        .join('') +
      (project.floors.length < M.LIMITS.floors ? `<button type="button" class="ftab ftab-add" data-add-floor title="Add a floor" aria-label="Add a floor">${icon('plus', 'ic-sm')}</button>` : '');
  }

  function stepRow(dir) {
    const rows = M.allRows(project);
    const i = rows.findIndex((r) => r.row.id === ui.rowId) + dir;
    if (i < 0 || i >= rows.length) return;
    // Some browsers move the focus of a button to the page as soon as it is disabled: note it first.
    const button = dir < 0 ? el.rowPrev : el.rowNext;
    const focused = document.activeElement === button;
    setRow(rows[i].row.id);
    toast(`${rows[i].floor.name} · ${rows[i].row.name}`, { kind: 'where' });
    // The first or last row disables its button: the row picker takes focus.
    if (focused && button.disabled) $('#btn-row').focus();
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

  /** Switches between the Racks and the Cabling workspace; each keeps its selection, and Racks its scroll. */
  const racksScroll = { at: null };
  function setWorkspace(ws) {
    if ((ws !== 'racks' && ws !== 'cabling') || ws === ui.workspace) return;
    if (ui.drag) cancelDrag();
    disarm();
    closeMenus();
    if (ui.workspace === 'racks') racksScroll.at = { left: el.canvas.scrollLeft, top: el.canvas.scrollTop, rowId: ui.rowId, view: ui.view, zoom: ui.zoom };
    else cab.keepElevation();
    ui.workspace = ws;
    prefs.workspace = ws;
    savePrefs();
    cab.cancelPending();
    if (ws === 'racks') {
      cab.hideBin();
      // The Racks sheet comes back at its own zoom: the Cabling drawings have theirs.
      const z = racksScroll.at ? racksScroll.at.zoom : prefs.zoom;
      if (z) ui.zoom = clamp(z, 0.1, 3);
    }
    render();
    placeToastsSoon();
    announce(ws === 'cabling' ? 'Cabling workspace' : 'Racks workspace');
    if (ws === 'cabling') cab.fitStage();
    else if (racksScroll.at && racksScroll.at.rowId === ui.rowId && racksScroll.at.view === ui.view) {
      el.canvas.scrollLeft = racksScroll.at.left;
      el.canvas.scrollTop = racksScroll.at.top;
    } else if (racksScroll.at || prefs.zoom) scrollToOrigin();
    else fitWidth();
  }
  $$('.ws-switch [data-workspace]').forEach((b) => b.addEventListener('click', () => setWorkspace(b.dataset.workspace)));

  /** Shows devices as plain name plates (Racks sheet, ghosts, exports) or with their drawn fronts. */
  function setDetail(detail) {
    if (detail === prefs.detail) return;
    prefs.detail = detail;
    savePrefs();
    el.bare.setAttribute('aria-pressed', String(detail === 'bare'));
    render();
  }
  el.bare.addEventListener('click', () => setDetail(prefs.detail === 'bare' ? 'full' : 'bare'));
  el.bare.setAttribute('aria-pressed', String(prefs.detail === 'bare'));

  /** Lists the device types one line each, without their drawings, so that more of them fit. */
  function setCompactParts(on) {
    prefs.compactParts = on;
    savePrefs();
    el.parts.classList.toggle('is-compact', on);
    $('#btn-parts-compact').setAttribute('aria-pressed', String(on));
  }
  $('#btn-parts-compact').addEventListener('click', () => setCompactParts(!prefs.compactParts));
  el.parts.classList.toggle('is-compact', prefs.compactParts);
  $('#btn-parts-compact').setAttribute('aria-pressed', String(prefs.compactParts));

  /**
   * The top edge of the Clusters (or Networks) list shares the left panel
   * out between it and the list above: dragged, or with the arrow keys.
   * `h` is its height in pixels; null gives it back the height it takes.
   */
  function setBinSplit(h, save) {
    const bin = $('#bin');
    bin.classList.toggle('is-split', h != null);
    if (h != null) bin.style.setProperty('--bin-low', `${Math.round(h)}px`);
    else bin.style.removeProperty('--bin-low');
    $$('.bin-split').forEach(binSplitValue);
    if (!save) return;
    if (h != null) prefs.binSplit = Math.round(h);
    else delete prefs.binSplit;
    savePrefs();
  }
  /** Says to screen readers how much of the panel the list under split `bar` takes, in percent. */
  function binSplitValue(bar) {
    const sec = bar.parentElement.getBoundingClientRect().height;
    if (sec) bar.setAttribute('aria-valuenow', String(Math.round((100 * sec) / $('#bin').clientHeight)));
  }
  /** Height `h` of the section under split `bar`, clamped so that each list keeps two rows or so in sight. */
  function binSplitHeight(bar, h) {
    const sec = bar.parentElement;
    const above = $$('.bin-parts', $('#bin')).find((x) => !x.hidden);
    const rest = (box, list) => box.getBoundingClientRect().height - $(list, box).getBoundingClientRect().height;
    return Math.max(rest(sec, '.clusters') + 56, Math.min(h, $('#bin').clientHeight - rest(above, '.parts') - 80));
  }
  for (const bar of $$('.bin-split')) {
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const y = e.clientY;
      const start = bar.parentElement.getBoundingClientRect().height;
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('is-dragging');
      const move = (ev) => setBinSplit(binSplitHeight(bar, start + y - ev.clientY));
      const end = () => {
        bar.classList.remove('is-dragging');
        bar.removeEventListener('pointermove', move);
        if ($('#bin').classList.contains('is-split')) setBinSplit(bar.parentElement.getBoundingClientRect().height, true);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', end, { once: true });
      bar.addEventListener('pointercancel', end, { once: true });
    });
    bar.addEventListener('dblclick', () => setBinSplit(null, true));
    bar.addEventListener('focus', () => binSplitValue(bar));
    bar.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowUp' ? 24 : e.key === 'ArrowDown' ? -24 : 0;
      if (!step) return;
      e.preventDefault();
      setBinSplit(binSplitHeight(bar, bar.parentElement.getBoundingClientRect().height + step), true);
    });
  }
  setBinSplit(prefs.binSplit || null);

  function setView(view) {
    if (view === ui.view) return;
    ui.view = view;
    prefs.view = view;
    savePrefs();
    disarm();
    render();
    announce(view === 'map' ? `Floor map of ${currentRow().floor.name}` : `Elevation of ${currentRow().row.name}`);
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
      `<button type="button" role="menuitem" data-row-action="settings"><span>${icon('pencil', 'ic-sm')} Row settings</span><small>${ui.workspace === 'cabling' ? 'In Racks: rename' : 'Rename'}, reorder racks, move or delete ${esc(pos.row.name)}</small></button>`;
  }
  el.rowMenu.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    closeMenus();
    // In Racks a row picked shows its elevation; Cabling keeps the Racks view as it was.
    if (t.dataset.row) setRow(t.dataset.row, ui.workspace === 'racks' ? { view: 'sheet' } : {});
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
    commit((p) => void M.setRowRackCount(p, rowId, count), { label: `Gave ${row.name} ${plural(count, 'rack')}` });
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
      card.setAttribute('aria-label', `${t.label}, ${M.formatTypeSpec(t)}, ${n} placed. Press Enter to choose a slot, or click it and then click a free slot.`);
    }
  }

  /**
   * The name in a row of the cluster or network list. A long name that does
   * not fit is cut in the middle, so its end stays in sight: its last word
   * or part of up to 8 characters, else its last 5 ("HDR…-GC5A-21").
   */
  function listName(name) {
    if (name.length <= 10) return `<span class="cl-name">${esc(name)}</span>`;
    let at = name.length - 5;
    for (let i = name.length - 8; i <= name.length - 3; i++) {
      if (/[\s._/:-]/.test(name[i])) {
        at = i;
        break;
      }
    }
    return `<span class="cl-name is-split"><span class="cl-head">${esc(name.slice(0, at))}</span><span class="cl-tail">${esc(name.slice(at))}</span></span>`;
  }

  function renderClusters() {
    const counts = new Map();
    let unassigned = 0;
    for (const d of project.devices) {
      const c = clusterIdOf(d);
      if (d.type === M.RESERVED.id && !c) continue;
      if (c) counts.set(c, (counts.get(c) || 0) + 1);
      else unassigned++;
    }
    // An eye per cluster shows or hides its devices in the racks.
    const eye = (id, name) => {
      const shown = !hiddenClusters().has(id);
      // A toggle: pressed while shown; its title says what its name says.
      const label = `Show ${name} in the racks`;
      return (
        `<button type="button" class="btn icon sm subtle cl-eye" data-cl-eye="${esc(id)}" aria-pressed="${shown}" aria-label="${esc(label)}" ` +
        `title="${esc(label)} (Alt-click: only it)">${icon(shown ? 'eye' : 'eye-off')}</button>`
      );
    };
    // The swatch of a cluster has its number, as on the ears of its devices.
    const row = (id, name, color, count, editable, mark) =>
      `<li class="cl-row${hiddenClusters().has(id) ? ' is-hidden' : ''}" data-cluster="${esc(id)}">` +
      eye(id, name) +
      `<button type="button" class="cl-main" aria-pressed="${ui.focusCluster === id}" title="${esc(name)}">` +
      (mark
        ? `<span class="sw sw-mark" style="--c:${color};color:${R.inkOn(color)}" aria-hidden="true">${mark}</span>`
        : `<span class="sw" style="--c:var(--unassigned)"></span>`) +
      `${listName(name)}<span class="cl-count" title="${count} devices">${count}</span></button>` +
      `<span class="cl-tools"><button type="button" class="btn icon sm subtle cl-select" aria-label="Select the devices of ${esc(name)}" title="Select its devices">${icon('select')}</button>` +
      (editable
        ? `<button type="button" class="btn icon sm subtle cl-edit" aria-label="Edit ${esc(name)}" title="Rename or recolor">${icon('pencil')}</button>`
        : `<span class="btn icon sm subtle" aria-hidden="true" style="visibility:hidden"></span>`) +
      `</span></li>`;
    const clusters = viewClusters();
    let html = clusters.map((c, i) => row(c.id, c.name, c.color, counts.get(c.id) || 0, true, i + 1)).join('');
    if (unassigned) html += row('__none', 'Unassigned', null, unassigned, false);
    keepFocus(el.clusters, () => (el.clusters.innerHTML = html || `<li class="cl-empty">No clusters yet.</li>`));
    const nHidden = hiddenClusters().size;
    hiddenNote($('#clusters-hidden'), nHidden ? `${plural(nHidden, 'cluster')} hidden` : '');
    el.clustersHint.innerHTML = !clusters.length
      ? 'Clusters give devices that belong together one color.'
      : ui.focusCluster
        ? `${CLICK} the highlighted cluster again to show all devices.`
        : `${CLICK} a cluster to highlight its devices in the racks.`;
  }

  function renderChrome() {
    const cabling = ui.workspace === 'cabling';
    for (const b of $$('.ws-switch [data-workspace]')) b.setAttribute('aria-pressed', String(b.dataset.workspace === ui.workspace));
    $('#app').classList.toggle('is-cabling', cabling);
    el.search.placeholder = cabling ? 'Search devices and cables' : 'Search devices, racks, rows, floors';
    el.bare.hidden = cabling; // the Cabling drawings keep the ports, and the nav bar its room
    renderViewSwitch();
    renderUndoButtons();
    if (document.activeElement !== el.planName) el.planName.value = project.name;
    el.notice.hidden = !(project.meta && project.meta.example);
    el.stage.classList.toggle('is-armed', !!(ui.armed || ui.moving));
    if (ui.moving) {
      const what = `<strong>${esc(M.deviceById(project, ui.moving).name)}</strong>`;
      el.armedHint.innerHTML =
        `<span class="hint-pointer">Click a free slot to move ${what} <kbd>Esc</kbd></span>` +
        `<span class="hint-touch">Tap a free slot to move ${what}</span>` +
        `<button type="button" data-disarm aria-label="Stop moving">${icon('x', 'ic-sm')}</button>`;
    } else if (ui.armed) {
      const t = M.typeOf(project, ui.armed);
      const what = `${t.variable ? '' : 'a '}<strong>${esc(t.label.toLowerCase())}</strong>`;
      el.armedHint.innerHTML =
        `<span class="hint-pointer">Click a free slot to place ${what}, or press <kbd>Enter</kbd> to choose one <kbd>Esc</kbd></span>` +
        `<span class="hint-touch">Tap a free slot to place ${what}</span>` +
        `<button type="button" data-disarm aria-label="Stop placing">${icon('x', 'ic-sm')}</button>`;
    }
    el.armedHint.hidden = !(ui.armed || ui.moving);
    if (cabling) cab.renderChrome();
  }

  /** The undo and redo buttons, whose tooltips name the step each one reverts. */
  function renderUndoButtons() {
    const next = history.future.length ? history.future[history.future.length - 1].step : null;
    const last = lastStep();
    el.undo.disabled = el.navUndo.disabled = !last;
    el.redo.disabled = el.navRedo.disabled = !next;
    el.undo.title = last && last.label ? `Undo: ${last.label} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    el.redo.title = next && next.label ? `Redo: ${next.label} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)';
    // Over the drawing on a phone, where there are no keys.
    el.navUndo.title = last && last.label ? `Undo: ${last.label}` : 'Undo';
    el.navRedo.title = next && next.label ? `Redo: ${next.label}` : 'Redo';
  }

  /** The menu button of the plan's views, shown when it has more than one; the cluster list names the view shown. */
  function renderViewSwitch() {
    const many = project.views.length > 1;
    const name = M.viewOf(project, ui.clusterView).name;
    $('#view-switch').hidden = !many;
    $('#clusters-view').hidden = !many;
    $('#clusters-view').textContent = name;
    $('#clusters-view').title = `View ${name}`;
    $('#view-label').textContent = name;
    const btn = $('#btn-cluster-view');
    btn.title = `View ${name}: its clusters color the devices (V)`;
    btn.setAttribute('aria-label', `View: ${name}`);
  }
  function renderViewMenu() {
    $('#menu-views').innerHTML =
      project.views
        .map(
          (v) =>
            `<button type="button" role="menuitemradio" aria-checked="${v.id === ui.clusterView}" data-cluster-view="${esc(v.id)}">` +
            `<span>${esc(v.name)}</span><small>${esc(plural(v.clusters.length, 'cluster'))}</small></button>`
        )
        .join('') +
      `<hr><button type="button" role="menuitem" data-edit-views><span>Edit views…</span><small>Add, copy, rename or delete views</small></button>`;
  }

  /** Shows view `id`: its clusters color the devices, fill the cluster list and take new devices. False when it is shown already or gone. */
  function setClusterView(id, opts) {
    if (id === ui.clusterView || !M.viewById(project, id)) return false;
    ui.clusterView = id;
    ui.focusCluster = null;
    ui.hoverCluster = null;
    if (planId) {
      prefs.views[planId] = id;
      savePrefs();
    }
    if (opts && opts.render === false) return true;
    render();
    if ($('#dlg-views').open) renderViewList();
    announce(`View: ${M.viewOf(project, id).name}`);
    return true;
  }
  $('#menu-views').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cluster-view], [data-edit-views]');
    if (!b) return;
    closeMenus();
    if (b.dataset.clusterView) setClusterView(b.dataset.clusterView);
    else openViewsDialog();
  });
  /** The view after the one shown (`step` 1) or before it (-1), round the end. */
  function stepClusterView(step) {
    const views = project.views;
    if (views.length < 2) return;
    const i = views.findIndex((v) => v.id === ui.clusterView);
    setClusterView(views[(i + step + views.length) % views.length].id);
  }

  // ------------------------------------------------------------ inspector

  /** "Cluster", or "Cluster in InfiniBand" when the plan has more views than the one shown. */
  const clusterHeading = () => (project.views.length > 1 ? `Cluster in ${M.viewOf(project, ui.clusterView).name}` : 'Cluster');

  /** Cluster chips; each has an id, so that an inspector drawn again after a change puts focus back on it and arrow keys go on through the chips. */
  function clusterChips(name, selected, withNew) {
    const chip = (value, label, color, checked, cls) =>
      `<label class="chip${cls || ''}"><input type="radio" name="${name}" id="${esc(`${name}-${value || 'none'}`)}" value="${esc(value)}"${checked ? ' checked' : ''}>` +
      `<span>${color !== undefined ? `<i class="sw" style="--c:${color || 'var(--unassigned)'}"></i>` : ''}${esc(label)}</span></label>`;
    let s = chip('', 'None', null, selected === null);
    for (const c of viewClusters()) s += chip(c.id, c.name, c.color, selected === c.id);
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
    const key = ui.workspace === 'cabling' ? 'cabling:' + cab.inspectorKey() : JSON.stringify(ui.selection || null);
    const same = key === inspectorKey;
    inspectorKey = key;
    drawInspector();
    const again = focusId && same && document.getElementById(focusId);
    if (again && el.inspector.contains(again) && !again.disabled) again.focus();
  }

  function drawInspector() {
    if (ui.workspace === 'cabling') return cab.renderInspector();
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

  /**
   * The name field of a floor, row or rack: `rename(draft, name)` as typed,
   * which refuses an empty name or one another `what` has (CSV files find
   * them by name). Left empty, the field takes `fallback()`; left with a
   * name taken, it says so and takes back the name it had.
   */
  function bindName(input, key, rename, current, fallback, what) {
    let before = current();
    input.addEventListener('focus', () => (before = current()));
    input.addEventListener('input', () => {
      const v = input.value;
      commit((p) => (rename(p, v) ? undefined : false), { key, inspector: false });
    });
    input.addEventListener('change', () => {
      const typed = input.value.trim().slice(0, M.LIMITS.name).trim();
      const name = typed || fallback();
      if (current() !== name && !commit((p) => (rename(p, name) ? undefined : false), { key }) && typed) {
        toast(`Another ${what} is named ${typed}.`, { warn: true });
        commit((p) => (rename(p, before) ? undefined : false), { key });
      }
      input.value = current();
    });
  }

  /** A field bound to a device property: text as typed, or `parse`d when the field is left. */
  function bindField(input, id, prop, parse) {
    if (!parse) return bindText(input, `${prop}:${id}`, (p, v) => M.setDeviceText(M.deviceById(p, id), prop, v));
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

  /**
   * A radio group for `reversed` (values front and back, for front to front
   * and back to front); `value` undefined checks neither (mixed). With
   * `portsSide`, the side of the device its ports are on, it asks where
   * the ports face: "Ports at Front | Rear".
   */
  function mountRadios(name, value, labelId, portsSide) {
    const radio = (v, text) =>
      `<label><input type="radio" name="${name}" id="${name}-${v ? 'back' : 'front'}" value="${v ? 'back' : 'front'}"${value === v ? ' checked' : ''}><span>${text}</span></label>`;
    const radios = portsSide ? radio(portsSide === 'rear', 'Front') + radio(portsSide === 'front', 'Rear') : radio(false, 'Front to front') + radio(true, 'Back to front');
    return (
      `<div class="field"><span class="label" id="${labelId}">${portsSide ? 'Ports at' : 'Mounted'}</span>` +
      `<div class="seg seg-fill" role="radiogroup" aria-labelledby="${labelId}">${radios}</div></div>`
    );
  }
  /** The side the ports of all `types` are on, or null when it differs or is unknown. */
  function commonPortsSide(types) {
    const sides = new Set(types.map((t) => M.portsSide(t)));
    return sides.size === 1 ? [...sides][0] : null;
  }

  function renderDeviceInspector(d) {
    const type = M.typeOf(project, d.type);
    const cluster = M.clusterOf(project, d, ui.clusterView);
    const hU = M.deviceHeight(project, d);
    const pos = M.locateRack(project, d.loc.rack);
    const slotOpts = M.validLocs(project, d.type, d.loc.rack, d.id, d.height)
      .map((l) => {
        const cur = l.kind === d.loc.kind && l.at === d.loc.at;
        const label = l.kind === 'side' ? `Side slot V${l.at + 1}` : M.formatPosition(project, l, d.type, d.height);
        return `<option value="${locKey(l)}"${cur ? ' selected' : ''}>${label}</option>`;
      })
      .join('');
    const hide = hiddenFn();
    const hidden = !!hide && hide(d);
    const canUp = !!M.nudgeTarget(project, d, -1);
    const canDown = !!M.nudgeTarget(project, d, 1);
    const typeOpts = M.placeableTypes(project)
      .map((t) => `<option value="${esc(t.id)}"${t.id === d.type ? ' selected' : ''}>${esc(t.label)} · ${t.variable ? 'any height' : `${t.height}U`}</option>`)
      .join('');
    const fields = M.FIELDS.map(
      (f) =>
        `<div class="field"><label for="insp-f-${f.key}">${esc(f.label)}</label>` +
        `<input id="insp-f-${f.key}" type="text" value="${esc(d[f.key] || '')}" spellcheck="false" autocomplete="off" maxlength="${M.FIELD_MAX}"${f.key === 'ip' || f.key === 'serial' || f.key === 'asset' ? ' class="mono"' : ''}></div>`
    ).join('');

    el.inspector.innerHTML =
      `<div class="insp-head">` +
      `<div class="kicker"><span class="sw" style="--c:${cluster ? cluster.color : 'var(--unassigned)'}"></span>${esc(type.label)} · ${hU}U</div>` +
      `<label for="insp-name" class="sr-only">Device name</label>` +
      `<input id="insp-name" class="name-input" type="text" value="${esc(d.name)}" spellcheck="false" autocomplete="off" maxlength="80">` +
      `<p class="warn-note name-clash" id="insp-name-dup" role="status" hidden></p>` +
      `<div class="insp-where">${esc(M.formatDeviceLoc(project, d))}</div>` +
      `<div class="insp-sub">${esc(`${pos.floor.name} · ${pos.row.name}`)}</div>` +
      `</div>` +
      `<section class="insp-sec"><h3 id="insp-cluster-label">${esc(clusterHeading())}</h3>` +
      `<div class="chips" role="radiogroup" aria-labelledby="insp-cluster-label">${clusterChips('insp-cluster', clusterIdOf(d), true)}</div>` +
      (hidden ? `<p class="sec-hint">${esc(cluster ? cluster.name : 'Unassigned')} is hidden in the racks. <button type="button" class="btn-link" id="insp-show-cluster">Show</button></p>` : '') +
      `</section>` +
      `<section class="insp-sec"><h3>Position</h3>` +
      `<div class="pos-grid">` +
      `<div class="field"><label for="insp-rack">Rack</label><select id="insp-rack">${rackOptions(d.loc.rack)}</select></div>` +
      `<div class="field"><label for="insp-slot">Slot</label><select id="insp-slot">${slotOpts}</select></div>` +
      (type.variable ? `<div class="field"><label for="insp-height">Height (U)</label><input id="insp-height" type="number" min="1" max="${M.rackUnits(project, d.loc.rack)}" step="1" value="${hU}" inputmode="numeric"></div>` : '') +
      `</div>` +
      (type.face === 'reserved' ? '' : mountRadios('insp-mount', !!d.reversed, 'insp-mount-label', M.portsSide(type))) +
      (d.loc.kind === 'u'
        ? `<div class="nudge"><button type="button" class="btn sm" id="insp-up"${canUp ? '' : ' disabled'} title="Next free position above (↑)">${icon('up')}Move up</button>` +
          `<button type="button" class="btn sm" id="insp-down"${canDown ? '' : ' disabled'} title="Next free position below (↓)">${icon('down')}Move down</button></div>`
        : '') +
      `<p class="sec-hint hint-touch">To move it in the drawing, tap it again, then tap a free slot.</p>` +
      `</section>` +
      `<section class="insp-sec"><h3>Details</h3><div class="field-grid">` +
      `<div class="field span2"><label for="insp-type">Type</label><select id="insp-type">${typeOpts}</select></div>${fields}` +
      `<div class="field"><label for="insp-power">Power (W)</label><input id="insp-power" type="number" min="0" step="10" inputmode="decimal" value="${d.powerW == null ? '' : d.powerW}" placeholder="${type.powerW} (type)"></div>` +
      `<div class="field"><label for="insp-weight">Weight (kg)</label><input id="insp-weight" type="number" min="0" step="0.5" inputmode="decimal" value="${d.weightKg == null ? '' : d.weightKg}" placeholder="${type.weightKg} (type)"></div>` +
      `</div><div class="warn-note" id="insp-repeats" role="status" hidden></div></section>` +
      `<section class="insp-sec"><h3><label for="insp-notes">Notes</label></h3>` +
      `<textarea id="insp-notes" rows="3" maxlength="${M.NOTES_MAX}" placeholder="Cabling, purchase order, plans …">${esc(d.notes || '')}</textarea></section>` +
      `<div class="insp-actions is-pinned">` +
      `<button type="button" class="btn" id="insp-dup" title="Duplicate (Ctrl+D)">${icon('copy')}Duplicate</button>` +
      `<button type="button" class="btn danger-text" id="insp-del" title="Delete (Del)">${icon('trash')}Delete</button>` +
      `</div>`;

    const id = d.id;
    bindText($('#insp-name'), 'name:' + id, (p, v) => (M.deviceById(p, id).name = v), () => M.suggestName(project, d.type));
    const nameDup = $('#insp-name-dup');
    const noteName = () => {
      const v = $('#insp-name').value.trim();
      nameDup.innerHTML = v ? clashNote([v], [id], 'insp-name-use') : '';
      nameDup.hidden = !nameDup.innerHTML;
    };
    noteName();
    $('#insp-name').addEventListener('input', noteName);
    nameDup.addEventListener('click', (e) => {
      const b = e.target.closest('#insp-name-use');
      if (b) commit((p) => void (M.deviceById(p, id).name = b.dataset.name), { label: `Rename ${d.name}` });
    });
    const view = ui.clusterView;
    $$('input[name="insp-cluster"]', el.inspector).forEach((r) =>
      r.addEventListener('change', () => {
        if (r.value === '__new') {
          openClusterDialog(null, (p, cid) => M.setClusterOf(p, M.deviceById(p, id), view, cid), () => renderInspector());
          return;
        }
        prefs.lastClusters[d.type] = r.value || null;
        savePrefs();
        commit((p) => M.setClusterOf(p, M.deviceById(p, id), view, r.value || null), { label: `Set the cluster of ${d.name}` });
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
      r.addEventListener('change', () => commit((p) => void (M.deviceById(p, id).reversed = r.value === 'back'), { label: `Turned ${d.name}` }))
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
        commit((p) => void (M.deviceById(p, id).height = h), { label: `Made ${d.name} ${h}U high` });
      });
    }
    $('#insp-type').addEventListener('change', (e) => changeDeviceType(id, e.target.value));
    const up = $('#insp-up');
    const down = $('#insp-down');
    if (up) up.addEventListener('click', () => nudge(id, -1));
    if (down) down.addEventListener('click', () => nudge(id, 1));
    for (const f of M.FIELDS) bindField($(`#insp-f-${f.key}`), id, f.key);
    // A serial number, asset tag or IP address another device has too, as it is typed.
    const repeats = $('#insp-repeats');
    const noteRepeats = () => {
      const cur = M.deviceById(project, id);
      repeats.innerHTML = cur ? M.repeatedFields(project, cur).map((r) => `<p>${esc(`${r.label} ${r.value} is on`)} ${deviceLinks(r.devices.filter((x) => x !== cur))} too.</p>`).join('') : '';
      repeats.hidden = !repeats.innerHTML;
    };
    noteRepeats();
    for (const f of M.FIELDS) if (f.instance) $(`#insp-f-${f.key}`).addEventListener('input', noteRepeats);
    bindField($('#insp-power'), id, 'powerW', parseOptNum(100000));
    bindField($('#insp-weight'), id, 'weightKg', parseOptNum(5000));
    bindField($('#insp-notes'), id, 'notes');
    $('#insp-dup').addEventListener('click', () => duplicateDevice(id));
    $('#insp-del').addEventListener('click', () => deleteDevices([id]));
    if (hidden) $('#insp-show-cluster').addEventListener('click', () => showCluster(clusterIdOf(d) || '__none'));
  }

  /**
   * Gives device `id` the type `typeId` where it is, in one undo step.
   * Asks first when cables would be unplugged; says why when the type
   * does not fit there.
   */
  async function changeDeviceType(id, typeId) {
    const d = M.deviceById(project, id);
    const to = M.typeOf(project, typeId);
    if (!d || !to) return;
    const lost = C.typeChangeImpact(project, id, typeId);
    if (lost.length) {
      const shown = lost.slice(0, 6).map((c) => c.label || 'one without a label');
      const ok = await confirmDialog({
        title: `Unplug ${plural(lost.length, 'cable')}?`,
        body:
          `${to.label} has no port in the place of the ${lost.length === 1 ? 'port' : 'ports'} of ${d.name} that ${lost.length === 1 ? 'this cable is' : 'these cables are'} plugged into: ` +
          `${shown.join(', ')}${lost.length > shown.length ? ` and ${lost.length - shown.length} more` : ''}. Undo plugs them back in.`,
        ok: lost.length === 1 ? 'Unplug the cable' : `Unplug ${lost.length} cables`,
      });
      if (!ok) return renderInspector();
    }
    const err = commitOrError((p) => M.setDeviceType(p, id, typeId), `Changed the type of ${d.name}`);
    if (err) {
      toast(`Can’t change the type: ${err}`, { warn: true });
      return renderInspector();
    }
    toast(`Changed ${d.name} to ${to.label}${lost.length ? `; unplugged ${plural(lost.length, 'cable')}` : ''}`, { action: 'Undo', onAction: undo });
  }

  /** Buttons that select devices `devs`: "cn-002, cn-003 and 4 more". */
  function deviceLinks(devs) {
    const shown = devs.slice(0, 3).map((d) => `<button type="button" class="btn-link" data-select="${esc(d.id)}">${esc(d.name)}</button>`);
    return listAnd(devs.length > shown.length ? shown.concat([`${devs.length - shown.length} more`]) : shown);
  }

  /** "2 serial numbers and 1 IP address are on more than one device", or '' when none is. */
  function repeatsText(repeats) {
    const parts = M.FIELDS.filter((f) => f.instance).map((f) => {
      const n = repeats.filter((r) => r.key === f.key).length;
      if (!n) return '';
      return n === 1 ? `1 ${/^[A-Z][a-z]/.test(f.label) ? f.label[0].toLowerCase() + f.label.slice(1) : f.label}` : `${n} ${M.pluralName(f.label)}`;
    });
    return repeats.length ? `${listAnd(parts)} ${repeats.length === 1 ? 'is' : 'are'} on more than one device.` : '';
  }

  function renderMultiInspector(devs) {
    const byType = new Map();
    for (const d of devs) byType.set(d.type, (byType.get(d.type) || 0) + 1);
    const summary = [...byType].map(([t, n]) => `${n} × ${M.typeOf(project, t).label}`).join(', ');
    const clusters = new Set(devs.map((d) => clusterIdOf(d)));
    const owners = new Set(devs.map((d) => d.owner || ''));
    const same = clusters.size === 1 ? [...clusters][0] : undefined;
    // Reserved space faces no way: only devices are mounted one way or the other.
    const mountable = devs.filter((d) => M.typeOf(project, d.type).face !== 'reserved');
    const mounts = new Set(mountable.map((d) => !!d.reversed));
    const sorted = M.sortedDevices(Object.assign({}, project, { devices: devs }));
    const power = devs.reduce((a, d) => a + M.powerOf(project, d), 0);
    const units = devs.filter((d) => d.loc.kind === 'u').reduce((a, d) => a + M.deviceHeight(project, d), 0);
    const hide = hiddenFn();
    const hidden = hide ? devs.filter(hide).length : 0;
    const rows = sorted
      .map((d) => {
        const c = M.clusterOf(project, d, ui.clusterView);
        return (
          `<li><button type="button" data-select="${esc(d.id)}" title="${esc(M.formatDeviceLoc(project, d))}">` +
          `<span class="u">${esc(shortRack(M.rackById(project, d.loc.rack).name))} ${M.formatPosition(project, d.loc, d.type, d.height)}</span>` +
          `<span class="sw" style="--c:${c ? c.color : 'var(--unassigned)'}"></span><span class="nm">${esc(d.name)}</span></button></li>`
        );
      })
      .join('');
    el.inspector.innerHTML =
      `<div class="insp-head"><div class="kicker">${icon('select', 'ic-sm')}Selection</div>` +
      `<div class="multi-title">${plural(devs.length, 'device')}${hidden ? ` (${hidden} hidden)` : ''}</div>` +
      `<div class="insp-where">${esc(summary)}</div>` +
      `<div class="insp-sub">${units} U · ${esc(fmtPower(power))}</div></div>` +
      `<section class="insp-sec"><h3 id="multi-cluster-label">${esc(clusterHeading())}</h3>` +
      `<div class="chips" role="radiogroup" aria-labelledby="multi-cluster-label">${clusterChips('multi-cluster', same === undefined ? undefined : same, true)}</div>` +
      (same === undefined ? `<p class="sec-hint">Mixed clusters; pick one to give it to all.</p>` : '') +
      `</section>` +
      `<section class="insp-sec"><h3>Move together</h3>` +
      `<div class="btn-grid"><button type="button" class="btn sm" data-group="up" title="Next room above (↑)">${icon('up')}Up</button><button type="button" class="btn sm" data-group="down" title="Next room below (↓)">${icon('down')}Down</button>` +
      `<button type="button" class="btn sm" data-group="left" title="Rack to the left (←)">${icon('left')}Left rack</button><button type="button" class="btn sm" data-group="right" title="Rack to the right (→)">Right rack${icon('right')}</button></div>` +
      `<p class="sec-hint">Or drag any of them; hold <kbd>Alt</kbd> to copy the group.</p></section>` +
      `<section class="insp-sec"><h3>Set for all</h3>` +
      (mountable.length ? mountRadios('multi-mount', mounts.size === 1 ? [...mounts][0] : undefined, 'multi-mount-label', commonPortsSide(mountable.map((d) => M.typeOf(project, d.type)))) : '') +
      `<div class="field-grid">` +
      `<div class="field span2"><label for="multi-owner">Owner</label><input id="multi-owner" type="text" value="${owners.size === 1 ? esc([...owners][0]) : ''}" placeholder="${owners.size > 1 ? 'Mixed' : ''}" autocomplete="off" maxlength="${M.FIELD_MAX}"></div>` +
      `<div class="field span2"><label for="multi-rename">Rename in series, top to bottom</label><div class="inline"><input id="multi-rename" class="mono" type="text" value="${esc(sorted[0].name)}" autocomplete="off" spellcheck="false" maxlength="80"><button type="button" class="btn sm" id="multi-rename-go">Rename</button></div>` +
      `<p class="warn-note name-clash" id="multi-rename-dup" role="status" hidden></p></div>` +
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
        const view = ui.clusterView;
        const apply = (p, cid) => ids.forEach((id) => M.setClusterOf(p, M.deviceById(p, id), view, cid));
        if (r.value === '__new') return openClusterDialog(null, apply, () => renderInspector());
        commit((p) => void apply(p, r.value || null), { label: `Set the cluster of ${plural(ids.length, 'device')}` });
      })
    );
    $$('input[name="multi-mount"]', el.inspector).forEach((r) =>
      r.addEventListener('change', () =>
        commit((p) => void mountable.forEach((d) => (M.deviceById(p, d.id).reversed = r.value === 'back')), { label: `Turned ${plural(mountable.length, 'device')}` })
      )
    );
    $('#multi-owner').addEventListener('change', (e) => {
      const v = e.target.value.trim();
      commit((p) => void ids.forEach((id) => (M.deviceById(p, id).owner = v)), { label: `Set the owner of ${plural(ids.length, 'device')}` });
    });
    const renameDup = $('#multi-rename-dup');
    const noteRename = () => {
      const first = $('#multi-rename').value.trim();
      renameDup.innerHTML = first ? clashNote(M.nameSequence(first, sorted.length), ids, 'multi-rename-use') : '';
      renameDup.hidden = !renameDup.innerHTML;
    };
    $('#multi-rename').addEventListener('input', noteRename);
    renameDup.addEventListener('click', (e) => {
      const b = e.target.closest('#multi-rename-use');
      if (!b) return;
      $('#multi-rename').value = b.dataset.name;
      noteRename();
      $('#multi-rename').focus();
    });
    $('#multi-rename-go').addEventListener('click', async () => {
      const first = $('#multi-rename').value.trim();
      if (!first) return;
      const names = M.nameSequence(first, sorted.length);
      const taken = M.takenNames(project, names, ids);
      if (taken.length && !(await confirmTaken(taken, 'Rename anyway'))) return;
      commit((p) => void sorted.forEach((d, i) => (M.deviceById(p, d.id).name = names[i])));
      toast(`Renamed ${names[0]} … ${names[names.length - 1]}`, { action: 'Undo', onAction: undo });
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
        const c = M.clusterOf(project, d, ui.clusterView);
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
    bindName($('#insp-rack-name'), 'rack:' + id, (p, v) => M.renameRack(p, id, v), () => M.rackById(project, id).name, () => M.defaultRackName(project, pos.row.id, pos.index), `rack in ${pos.row.name}`);
    $('#insp-rack-type').addEventListener('change', (e) => {
      const err = commitOrError((p) => M.setRackType(p, id, e.target.value), `Changed the type of ${rack.name}`);
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
        if (act === 'left' || act === 'right') commit((p) => void M.moveRack(p, id, pos.row.id, pos.index + (act === 'left' ? -1 : 1)), { label: `Moved ${rack.name}` });
        else addRackTo(pos.row.id, pos.index + (act === 'insert-right' ? 1 : 0));
      })
    );
    $('#insp-rack-row').addEventListener('change', (e) => {
      const target = e.target.value;
      if (!commit((p) => (M.moveRack(p, id, target) ? undefined : false), { label: `Moved ${rack.name}` })) return renderInspector();
      setRow(target);
      // A rack there with its name, in any case, gives it a number.
      const now = M.rackById(project, id).name;
      toast(`Moved ${rack.name} to ${M.formatWhere(project, target)}${now !== rack.name ? ` as ${now}, as a rack there has its name` : ''}`, { action: 'Undo', onAction: undo });
    });
    $('#insp-dup-rack').addEventListener('click', () => duplicateStructure('rack', id));
    $('#insp-rack-select').addEventListener('click', () => selectDevices(devs.map((d) => d.id)));
    $('#insp-clear-rack').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: `Empty ${rack.name}?`,
        body: `This removes all ${devicesAndCables(devs)} from ${rack.name}. Undo brings them back.`,
        ok: 'Remove devices',
      });
      if (ok) commit((p) => void M.removeDevicesIn(p, new Set([id])), { label: `Removed the devices of ${rack.name}` });
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
    bindName($('#insp-row-name'), 'row:' + id, (p, v) => M.renameRow(p, id, v), () => M.rowById(project, id).name, () => `Row ${M.letters(pos.rowIndex)}`, `row on ${pos.floor.name}`);
    $('#row-less').addEventListener('click', () => setRowRackCount(id, row.racks.length - 1));
    $('#row-more').addEventListener('click', () => setRowRackCount(id, row.racks.length + 1));
    $('#row-renumber').addEventListener('click', () => commit((p) => void M.renumberRacks(p, id), { label: `Renumbered the racks of ${row.name}` }));
    $('#insp-row-floor').addEventListener('change', (e) => {
      if (!commit((p) => (M.moveRow(p, id, e.target.value) ? undefined : false), { label: `Moved ${row.name}` })) return renderInspector();
      // A row there with its name, in any case, gives it a number.
      const now = M.rowById(project, id).name;
      if (now !== row.name) toast(`Moved ${row.name} to ${M.floorById(project, e.target.value).name} as ${now}, as a row there has its name`, { action: 'Undo', onAction: undo });
    });
    $$('[data-row-act]', el.inspector).forEach((b) =>
      b.addEventListener('click', () => commit((p) => void M.moveRow(p, id, pos.floor.id, pos.rowIndex + (b.dataset.rowAct === 'up' ? -1 : 1)), { label: `Moved ${row.name}` }))
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
    bindName($('#insp-floor-name'), 'floor:' + id, (p, v) => M.renameFloor(p, id, v), () => M.floorById(project, id).name, () => `Floor ${i + 1}`, 'floor');
    bindProp($('#floor-pitch'), (p) => M.floorById(p, id), 'rowPitchM', (v) => M.clampNum(String(v).trim() === '' ? null : v, 0.5, 50, M.DEFAULT_ROW_PITCH_M));
    $$('[data-open-row]', el.inspector).forEach((b) => b.addEventListener('click', () => setRow(b.dataset.openRow, { view: 'sheet' })));
    $$('[data-floor-act]', el.inspector).forEach((b) =>
      b.addEventListener('click', () => commit((p) => void M.moveFloor(p, id, i + Number(b.dataset.floorAct)), { label: `Moved ${floor.name}` }))
    );
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
    const repeats = M.repeatedFields(project);
    const info = project.info;
    const infoField = (k, label, ph) =>
      `<div class="field"><label for="info-${k}">${label}</label><input id="info-${k}" type="text" value="${esc(info[k] || '')}" placeholder="${ph}" autocomplete="off" maxlength="60"></div>`;

    el.inspector.innerHTML =
      `<div class="insp-head"><div class="kicker">Plan overview</div>` +
      `<p class="insp-note">Select a device, a rack’s yellow label, a row or a floor to edit it. <span class="hint-pointer">Shift-click or Shift-drag to select several devices.</span><span class="hint-touch">A cluster’s select button selects all its devices.</span></p></div>` +
      `<section class="insp-sec"><h3>Title block</h3><div class="field-grid">` +
      infoField('site', 'Site', 'Data center, hall') +
      infoField('author', 'Drawn by', 'Name') +
      infoField('revision', 'Revision', 'A') +
      `</div></section>` +
      `<section class="insp-sec"><dl class="stats">` +
      `<div><dt>Floors · rows</dt><dd>${project.floors.length} · ${M.allRows(project).length}</dd></div>` +
      `<div><dt>Racks</dt><dd>${t.racks}</dd></div>` +
      `<div><dt>Devices</dt><dd>${t.count}</dd></div>` +
      `<div><dt>Clusters</dt><dd>${viewClusters().length}</dd></div>` +
      `<div><dt>Units used</dt><dd>${t.used} <small>of ${t.units}</small></dd></div>` +
      `<div><dt>Reserved</dt><dd>${t.reserved} U</dd></div>` +
      `</dl>` +
      budgetMeters(t) +
      (t.overPower || t.overWeight ? `<p class="warn-note">${esc(`${plural(t.overPower, 'rack')} over the power budget, ${plural(t.overWeight, 'rack')} over the weight limit.`)}</p>` : '') +
      (repeats.length ? `<p class="warn-note" id="overview-repeats">${esc(repeatsText(repeats))} <button type="button" class="btn-link" id="overview-repeats-select">Select them</button></p>` : '') +
      `</section>` +
      `<section class="insp-sec"><h3>${esc(`${pos.floor.name} · ${pos.row.name}`)}</h3><div class="rack-bars">${rackBars(pos.row, stats)}</div></section>` +
      `<section class="insp-sec"><h3>By device type</h3>` +
      (typeRows
        ? `<table class="type-table"><thead><tr><th>Type</th><th>Count</th><th>U</th><th>kW</th></tr></thead><tbody>${typeRows}</tbody></table>`
        : `<p class="empty-note">No devices yet.</p>`) +
      `</section>` +
      `<section class="insp-sec keys-sec"><h3>Shortcuts</h3><dl class="keys">` +
      `<dt><kbd>?</kbd></dt><dd>Every shortcut, and help</dd>` +
      `<dt><kbd>/</kbd></dt><dd>Search</dd>` +
      `<dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous, next row</dd>` +
      `<dt><kbd>M</kbd></dt><dd>Floor map</dd>` +
      `<dt><kbd>C</kbd></dt><dd>Cabling</dd>` +
      (project.views.length > 1 ? `<dt><kbd>V</kbd></dt><dd>Next view</dd>` : '') +
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
    if (repeats.length) $('#overview-repeats-select').addEventListener('click', () => selectDevices([].concat(...repeats.map((r) => r.devices.map((d) => d.id))), { follow: true }));
  }

  el.inspector.addEventListener('click', (e) => {
    const sel = e.target.closest('[data-select]');
    if (sel) return selectDevices([sel.dataset.select], { follow: true, focus: true });
    const bar = e.target.closest('.rack-bar[data-rack]');
    if (!bar) return;
    selectThing('rack', bar.dataset.rack, { sheet: true, reveal: true });
    if (byKeyboard(e)) focusRackName();
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
    const changed = commit((p) => void (M.deviceById(p, id).loc = { rack: loc.rack, kind: loc.kind, at: loc.at }), { label: `Moved ${d.name}` });
    if (changed) announce(`Moved ${d.name} to ${M.formatLoc(project, loc, d.type, d.height)}`);
    else render();
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
    const label = `Moved ${plural(moves.length, 'device')}`;
    const changed = commit((p) => void moves.forEach((m) => (M.deviceById(p, m.id).loc = { rack: m.loc.rack, kind: m.loc.kind, at: m.loc.at })), { label });
    if (changed) announce(label);
    return changed;
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
      loc = freeSideSlot(d);
      if (!loc) return toast(`No side slot is free for a copy of ${d.name}`, { warn: true });
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
    commit(
      (p) => {
        p.devices.push(copy);
        M.copyCables(p, new Map([[id, copy.id]]));
      },
      { label: `Added ${copy.name}, a copy of ${d.name}` }
    );
    toast(`Added ${copy.name} at ${M.formatDeviceLoc(project, copy)}`);
  }

  /** A free side slot for a copy of side-slot device `d`: in its rack, then in the nearest racks of its row, then anywhere. */
  function freeSideSlot(d) {
    const pos = M.locateRack(project, d.loc.rack);
    // By distance, the rack to the right first.
    const away = (i) => Math.abs(i - pos.index) * 2 + (i < pos.index ? 1 : 0);
    const row = pos.row.racks.map((r, i) => [r, away(i)]).sort((a, b) => a[1] - b[1]).map(([r]) => r);
    for (const r of row.concat(M.allRacks(project).map((x) => x.rack))) {
      const loc = M.validLocs(project, d.type, r.id, null, d.height).find((l) => l.kind === 'side');
      if (loc) return loc;
    }
    return null;
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

  /** Deleting this many devices at once asks first, as deleting several that take cables does. */
  const ASK_TO_DELETE = 10;
  async function deleteDevices(ids) {
    const devs = ids.map((id) => M.deviceById(project, id)).filter(Boolean);
    if (!devs.length) return;
    const gone = idSet(devs);
    const cables = cablesGoingWith(gone);
    if (devs.length > 1 && (cables || devs.length >= ASK_TO_DELETE)) {
      const ok = await confirmDialog({
        title: `Delete ${plural(devs.length, 'device')}?`,
        body: `This deletes ${devicesAndCables(devs)}. Undo brings them back.`,
        ok: 'Delete',
        focusCancel: true,
      });
      if (!ok) return;
    }
    ui.selection = null;
    commit((p) => {
      p.devices = p.devices.filter((x) => !gone.has(x.id));
      M.pruneCables(p);
    });
    toast(`Deleted ${devs.length === 1 ? devs[0].name : plural(devs.length, 'device')}${andCables(cables)}`, { action: 'Undo', onAction: undo });
  }

  /**
   * Replaces the plan with `next`, as one undo step; false when that
   * changes nothing (a merge that adds nothing): no step is recorded then,
   * and the selection and the Cabling workspace's state stay as they are.
   */
  function replaceProject(next) {
    const after = M.clone(next);
    // Imports and a fresh start come checked, but no cable may point past the plan.
    M.pruneCables(after);
    if (JSON.stringify(after) === projectJSON) return false;
    ui.selection = null;
    ui.focusCluster = null;
    ui.hoverCluster = null;
    cab.reset();
    disarm();
    const ok = commit((p) => {
      Object.keys(p).forEach((k) => delete p[k]);
      Object.assign(p, after);
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

  /** Whether the stage shows a drawing that zooms: the Racks sheet, or a drawing of the Cabling workspace. */
  function zoomable() {
    return ui.workspace === 'cabling' ? cab.zoomable() : ui.view !== 'map';
  }

  function setZoom(z, anchor, remember) {
    if (!zoomable()) return;
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
    // The Racks sheet's zoom is remembered; the Cabling drawings open fitted to the stage.
    if (remember !== false && ui.workspace === 'racks') {
      prefs.zoom = nz;
      savePrefs();
    }
  }

  /**
   * The width inside the stage's padding, which drawings are fitted to.
   * Kept from the stage's ResizeObserver, which reads it once the browser
   * has laid the page out anyway; read now (a layout) only before the
   * first report, or while the observer has a change still to report.
   */
  const canvasBox = { width: null, padX: null, stale: true };
  function canvasWidth() {
    const cs = getComputedStyle(el.canvas);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    if (canvasBox.stale || canvasBox.width === null || padX !== canvasBox.padX) {
      canvasBox.width = el.canvas.clientWidth;
      canvasBox.padX = padX;
      canvasBox.stale = false;
    }
    return canvasBox.width - padX;
  }
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      // Called once layout is done: reading the size here costs nothing.
      canvasBox.width = el.canvas.clientWidth;
      const cs = getComputedStyle(el.canvas);
      canvasBox.padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      canvasBox.stale = false;
    }).observe(el.canvas);
    window.addEventListener('resize', () => (canvasBox.stale = true));
  }

  // Fit the sheet's width, but never so small that labels become unreadable,
  // and show it from the top left. The zoom is set without reading the
  // layout of the drawing just drawn (setZoom keeps a point in place, which
  // needs it), so the browser lays it out once, at the zoom it ends at.
  // On a touch screen, the racks start at 100%, where a unit is big enough to tap.
  const coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)') : { matches: false };
  function fitWidth() {
    if (!zoomable()) return;
    const cw = canvasWidth();
    const least = coarse.matches && (ui.workspace === 'racks' || ui.cabView === 'elevation') ? 1 : 0.5;
    ui.zoom = clamp(Math.round(clamp(Math.min(1, cw / ui.sceneW), least, 3) * 1000) / 1000, 0.1, 3);
    applyZoom();
    scrollToOrigin();
    // A Cabling drawing still too wide may show its middle instead (the fabric's switches).
    if (ui.workspace === 'cabling') cab.afterFit(cw);
  }

  function scrollToOrigin() {
    el.canvas.scrollTop = 0;
    el.canvas.scrollLeft = 0;
  }

  function fitZoom(mode, remember) {
    if (!zoomable()) return;
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

  /** Color of cluster `id` when it is one of the view shown. */
  function clusterColor(id) {
    const c = viewClusters().find((x) => x.id === id);
    return c ? c.color : null;
  }

  /**
   * The cluster a new device of `typeId` starts in, `hint` being its
   * suggestPlacement: the reference device's, else the one last given to
   * that type, else none.
   */
  function startCluster(typeId, hint) {
    if (hint.cluster !== undefined) return hint.cluster;
    const last = prefs.lastClusters[typeId];
    return last && clusterColor(last) ? last : null;
  }

  function drawGhost(typeId, loc, ok, device, height, warn) {
    if (!loc) return setGhosts('');
    const hint = device ? null : M.suggestPlacement(project, typeId, loc, 1, ui.clusterView);
    const clusterId = device ? clusterIdOf(device) : startCluster(typeId, hint);
    setGhosts(
      R.renderGhost(project, typeId, loc, ok, {
        theme: ui.theme,
        measure,
        layout: ui.layout,
        height: device ? device.height : height,
        color: clusterColor(clusterId),
        name: device ? device.name : hint.name,
        reversed: device ? !!device.reversed : M.mountsReversed(M.typeOf(project, typeId)),
        bare: prefs.detail === 'bare',
        warn,
      })
    );
  }

  /**
   * The rack that one device of `typeId` (`height` for reserved space) at
   * `loc` would put over a budget, as "Rack A01 at 12.1 kW of 12.0 kW";
   * '' when none. `device` is the one moved there (a copy when `copy`).
   */
  function overBudgetAt(typeId, loc, height, device, copy) {
    const add = device ? Object.assign({}, device, { id: 'new', loc }) : M.newDevice({ type: typeId, loc, height });
    const [over] = M.overBudgetWith(project, [add], device && !copy ? [device.id] : []);
    return over ? `${over.rack.name} at ${overText(over.stats)}` : '';
  }

  function drawGhosts(moves, ok) {
    const items = moves.map((m) => {
      const d = M.deviceById(project, m.id);
      return { typeId: d.type, loc: m.loc, height: d.height, name: d.name, color: clusterColor(clusterIdOf(d)), reversed: !!d.reversed };
    });
    setGhosts(R.renderGhosts(project, items, ok, { theme: ui.theme, measure, layout: ui.layout, rowId: ui.rowId, bare: prefs.detail === 'bare' }));
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
    // Into another rack, or a new device: say when it goes over the budgets.
    const over = d.ok && (!primary || d.copy || loc.rack !== primary.loc.rack) ? overBudgetAt(d.typeId, loc, d.height, primary, d.copy) : '';
    drawGhost(d.typeId, loc, d.ok, primary, d.height, !!over);
    const title = primary ? (d.copy ? `Copy of ${primary.name}` : primary.name) : M.typeOf(project, d.typeId).label;
    const detail = loc ? (over ? `${M.formatPosition(project, loc, d.typeId, primary ? primary.height : d.height)} · over budget: ${over}` : d.ok ? M.formatLoc(project, loc, d.typeId, primary ? primary.height : d.height) : d.reason) : 'Drop it on a rack';
    showChip(e, title, detail, loc ? (over ? 'warn' : d.ok ? 'ok' : 'bad') : '');
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
  /** The devices inside the selection rectangle `m`, but not those hidden. */
  function marqueeIds(m) {
    const x = Math.min(m.x0, m.x1);
    const y = Math.min(m.y0, m.y1);
    const w = Math.abs(m.x1 - m.x0);
    const h = Math.abs(m.y1 - m.y0);
    const ids = [];
    const hide = hiddenFn();
    for (const r of ui.layout.racks) {
      for (const d of M.devicesWithin(project, r.rack.id)) {
        if (hide && hide(d)) continue;
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
    if (byKeyboard(e)) return placeByKeyboard(card.dataset.type);
    if (ui.view === 'map') setView('sheet');
    toggleArm(card.dataset.type);
  });

  function toggleArm(typeId) {
    ui.armed = ui.armed === typeId ? null : typeId;
    if (ui.armed) ui.selection = null;
    hideDragFeedback();
    render();
    // The slots to tap, and the hint, are below the devices on a phone.
    if (ui.armed) showStage();
  }

  function disarm() {
    if (!ui.armed && !ui.moving) return;
    ui.armed = null;
    ui.moving = null;
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
    // The Cabling workspace's drawings have their own pointer handling.
    if (ui.workspace === 'cabling') return;
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
    // Moving a device by touch: a tap beside the devices is where it goes.
    if (ui.moving && !devEl) {
      ui.press = Object.assign(press, { kind: 'move' });
      return;
    }
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
    const over = check && check.ok ? overBudgetAt(type.id, loc, h) : '';
    drawGhost(type.id, loc, !!(check && check.ok), null, h, !!over);
    const detail = loc ? (over ? `${M.formatPosition(project, loc, type.id, h)} · over budget: ${over}` : check.ok ? M.formatLoc(project, loc, type.id, h) : check.reason) : 'Point at a rack';
    showChip(e, type.label, detail, loc ? (over ? 'warn' : check.ok ? 'ok' : 'bad') : '');
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

  /**
   * A tap on a device selects it; a tap on the device selected (alone)
   * starts moving it, where a touch screen cannot drag, and a tap on it
   * while it moves stops that.
   */
  function tapDevice(id) {
    const ids = selIds();
    if (ui.moving === id) return disarm();
    if (ids.length !== 1 || ids[0] !== id) return selectDevice(id, false);
    ui.moving = id;
    hideDragFeedback();
    renderChrome();
  }

  /** Moves the device being moved to the slot tapped; a tap off the racks stops moving it. */
  function moveTo(e) {
    const d = M.deviceById(project, ui.moving);
    const h = M.deviceHeight(project, d);
    const pt = toScene(e);
    const loc = R.locateDrop(project, ui.rowId, d.type, pt.x, pt.y, (h * G.U) / 2, d.height);
    if (!loc) return disarm();
    const check = M.canPlace(project, d.type, loc, d.id, d.height);
    if (!check.ok) return toast(check.reason, { warn: true });
    ui.moving = null;
    moveDevice(d.id, loc);
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
    else if (p.kind === 'move') moveTo(e);
    else if (p.kind === 'device') tapDevice(p.id);
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
    if ((e.key !== 'Enter' && e.key !== ' ') || ui.workspace === 'cabling' || !e.target.closest) return;
    const head = e.target.closest('.rack-head');
    if (e.target.closest('.add-rack')) {
      e.preventDefault();
      addRackTo(ui.rowId);
    } else if (head && !ui.armed) {
      e.preventDefault();
      selectThing('rack', head.dataset.rack);
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

  // Two fingers on a drawing zoom it around their midpoint, as Ctrl+scroll
  // does; one finger still scrolls it (touch-action in css/app.css).
  const touches = new Map();
  let pinch = null;
  function spread() {
    const [a, b] = [...touches.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 };
  }
  el.canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size !== 2 || !zoomable()) return;
    // Lifted, the fingers tap nothing.
    ui.press = null;
    cab.cancelPress();
    pinch = { d: spread().d, zoom: ui.zoom };
  });
  window.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!pinch || touches.size !== 2) return;
    const s = spread();
    if (pinch.d > 0) setZoom(pinch.zoom * (s.d / pinch.d), s);
  });
  const lift = (e) => {
    if (touches.delete(e.pointerId) && touches.size < 2) pinch = null;
  };
  window.addEventListener('pointerup', lift);
  window.addEventListener('pointercancel', lift);

  // ------------------------------------------------------ cluster sidebar

  el.clusters.addEventListener('click', (e) => {
    const rowEl = e.target.closest('.cl-row');
    if (!rowEl) return;
    const id = rowEl.dataset.cluster;
    if (e.target.closest('.cl-edit')) return openClusterDialog(id);
    if (e.target.closest('.cl-eye')) {
      const keys = $$('.cl-row', el.clusters).map((x) => x.dataset.cluster);
      toggleEye(hiddenClusters(), keys, id, e.altKey);
      // The inspector too: it says what of the selection is hidden.
      return render();
    }
    if (e.target.closest('.cl-select')) {
      const devs = project.devices.filter((d) => (id === '__none' ? !clusterIdOf(d) && d.type !== M.RESERVED.id : clusterIdOf(d) === id));
      const inRow = devs.filter((d) => rowOfRack(d.loc.rack) === ui.rowId);
      selectDevices((inRow.length ? inRow : devs).map((d) => d.id), { follow: !inRow.length });
      if (inRow.length < devs.length) toast(`Selected ${plural(inRow.length || devs.length, 'device')}${inRow.length ? ' in this row' : ''} of ${devs.length}`);
      return;
    }
    if (e.target.closest('.cl-main')) {
      ui.focusCluster = ui.focusCluster === id ? null : id;
      ui.hoverCluster = null;
      // A cluster put in focus is shown, if the racks hid it.
      if (ui.focusCluster) hiddenClusters().delete(id);
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
  $('#clusters-hidden').addEventListener('click', (e) => {
    if (!e.target.closest('[data-show-all]')) return;
    hiddenClusters().clear();
    render();
    // The button is gone: keyboard focus goes to the list.
    const first = el.clusters.querySelector('.cl-eye');
    if (first) first.focus();
  });

  // ---------------------------------------------------------------- search

  function renderSearchResults() {
    const q = ui.query.trim();
    const cabling = ui.workspace === 'cabling';
    const res = M.search(project, q, 6, ui.clusterView);
    const groups = [
      ['floors', 'Floors', 'map'],
      ['rows', 'Rows', 'map'],
      ['racks', 'Racks', 'rack'],
      ['devices', 'Devices', 'rack'],
      ['clusters', 'Clusters of other views', 'layers'],
    ];
    if (cabling) {
      const found = cab.searchCables(q, 8);
      res.cables = found.items;
      res.counts.cables = found.count;
      groups.push(['cables', 'Cables', 'cable']);
    }
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
          `<span class="sr-name">${esc(it.name)}</span><span class="sr-detail">${esc(it.detail)}${it.kind === 'cluster' ? ' · Show view' : ''}</span></div>`;
      }
      if (more > 0) html += `<div class="sr-more" role="presentation">and ${more} more${key === 'devices' && !cabling ? ' (highlighted in the racks)' : ''}</div>`;
    }
    // With views, say that the search is in the view shown.
    const where = project.views.length > 1 ? ` in view ${esc(M.viewOf(project, ui.clusterView).name)}` : '';
    if (!items.length) html = `<div class="sr-empty" role="presentation">Nothing${where} matches “${esc(q)}”.</div>`;
    else if (res.counts.devices && !cabling) html += `<div class="sr-foot" role="presentation">Matching devices stay highlighted; <kbd>Esc</kbd> clears the search.</div>`;
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

  /**
   * The drawing's highlight of what the search matches. In Cabling, on a
   * large plan, it follows typing once typing pauses, as the schedule's
   * filter does: each keystroke would draw the whole elevation or fabric
   * again. The list of results follows each keystroke.
   */
  let searchStageTimer = null;
  function flushSearchStage() {
    if (!searchStageTimer) return;
    clearTimeout(searchStageTimer);
    searchStageTimer = null;
    renderStage();
  }
  function setQuery(q) {
    ui.query = q;
    ui.searchActive = q.trim() ? 0 : -1;
    ui.searchOpen = !!q.trim();
    if (ui.searchOpen) renderSearchResults();
    else closeSearch();
    clearTimeout(searchStageTimer);
    searchStageTimer = null;
    if (q.trim() && ui.workspace === 'cabling' && project.cables.length > 400) {
      searchStageTimer = setTimeout(() => {
        searchStageTimer = null;
        renderStage();
      }, 150);
    } else renderStage();
  }

  function chooseResult(it) {
    flushSearchStage();
    closeSearch();
    // A cluster of another view: show that view; the search goes on in it.
    if (it.kind === 'cluster') {
      el.search.blur();
      setClusterView(it.view);
      toast(`Showing view ${M.viewOf(project, it.view).name}`);
      return;
    }
    if (ui.workspace === 'cabling') {
      el.search.blur();
      cab.chooseResult(it);
    } else if (it.kind === 'device') {
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
    showStage();
  }

  el.search.addEventListener('input', () => setQuery(el.search.value));
  el.search.addEventListener('focus', () => {
    if (ui.query.trim()) {
      ui.searchOpen = true;
      renderSearchResults();
    }
  });
  el.search.addEventListener('blur', () => {
    flushSearchStage();
    setTimeout(() => document.activeElement !== el.search && closeSearch(), 120);
  });
  el.search.addEventListener('keydown', (e) => {
    const n = ui.searchItems.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!ui.searchOpen && ui.query.trim()) ui.searchOpen = true;
      if (n) ui.searchActive = (ui.searchActive + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      renderSearchResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      flushSearchStage();
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

  /** A selector that finds an element again once its part of the page is drawn anew: its id, else its first data attribute. */
  function selectorOf(node) {
    if (!node || node === document.body || !node.getAttribute) return null;
    if (node.id) return `#${CSS.escape(node.id)}`;
    const attr = [...node.attributes].find((x) => x.name.startsWith('data-'));
    return attr ? `[${attr.name}="${CSS.escape(attr.value)}"]` : null;
  }

  /**
   * Opens a modal dialog. Closed, it gives keyboard focus back to what
   * opened it; when a change made in it drew that part of the page anew
   * (a network renamed, a cable connected), to the element that stands for
   * it now (found by its id or data attribute), else to the one the dialog
   * names in its data-return-focus.
   */
  function openDialog(dlg) {
    closeMenus();
    closeSearch();
    if (!dlg.open) {
      dlg.dataset.opener = selectorOf(document.activeElement) || '';
      delete dlg.dataset.returnFocus;
      dlg.showModal();
    }
    hostToasts();
  }
  $$('dialog').forEach((dlg) =>
    dlg.addEventListener('close', () => {
      // After the close handlers, which may draw the page again.
      setTimeout(() => {
        const a = document.activeElement;
        if ((a && a !== document.body) || $('dialog[open]')) return;
        for (const sel of [dlg.dataset.opener, dlg.dataset.returnFocus]) {
          const t = sel && document.querySelector(sel);
          if (t && !t.disabled && t.getClientRects().length) {
            t.focus({ preventScroll: true });
            return;
          }
        }
      });
    })
  );

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

  const place = { typeId: null, loc: null, nameTouched: false, clusterTouched: false, newColor: null, positions: [], valid: true, groups: {}, over: [] };

  function openPlaceDialog(typeId, loc) {
    const type = M.typeOf(project, typeId);
    Object.assign(place, { typeId, loc, nameTouched: false, clusterTouched: false, positions: [], valid: true });
    $('#place-title').textContent = type.label;
    $('#place-height-field').hidden = !type.variable;
    $('#place-mount').innerHTML = type.face === 'reserved' ? '' : mountRadios('place-mount', M.mountsReversed(type), 'place-mount-label', M.portsSide(type));
    $('#place-height').value = loc.kind === 'side' ? '1' : '2';
    $('#place-qty').value = '1';
    $('input[name="place-dir"][value="down"]').checked = true;
    $('#place-spread').checked = false;
    setPlaceLoc(loc);
    $('#place-cluster-label').textContent = clusterHeading();
    suggestPlaceCluster();
    place.newColor = M.nextClusterColor(project, ui.clusterView);
    $('#place-new-name').value = M.nextClusterName(project, ui.clusterView);
    renderSwatches($('#place-new-colors'), 'place-new-color', place.newColor, (c) => {
      place.newColor = c;
      drawPlaceGhosts();
    });
    showError('#place-error', '');
    openDialog($('#dlg-place'));
    updatePlacePreview();
    const name = $('#place-name');
    name.focus();
    name.select();
  }

  /**
   * Picks in the place dialog the cluster that the name suggestion follows,
   * for where it places the devices now, unless the user picked one: the
   * cluster of the reference device in every view.
   */
  function suggestPlaceCluster() {
    if (place.clusterTouched) return;
    const hint = M.suggestPlacement(project, place.typeId, place.loc, 1, ui.clusterView);
    const initial = startCluster(place.typeId, hint);
    // The other views take the clusters of the device the suggestion follows.
    place.groups = hint.groups;
    $('#place-clusters').innerHTML = clusterChips('place-cluster', initial, true);
    const others = project.views.filter((v) => v.id !== ui.clusterView);
    const inView = (v) => `${(M.clusterOf(project, { groups: hint.groups }, v.id) || { name: 'none' }).name} in ${v.name}`;
    $('#place-views').textContent = !others.length
      ? ''
      : hint.from
        ? `Like ${hint.from}: ${listAnd(others.map(inView))}`
        : `No cluster in ${listAnd(others.map((v) => v.name))}`;
    $('#place-views').hidden = !others.length;
    $('#place-new').hidden = initial !== '__new';
  }

  /** Sets where the dialog places the devices: its Rack and Position fields, and the racks of that row to spread over. */
  function setPlaceLoc(loc) {
    place.loc = loc;
    const row = M.locateRack(project, loc.rack).row;
    $('#place-rack').innerHTML = rackOptions(loc.rack);
    renderPlacePositions();
    $('#place-height').max = String(M.rackUnits(project, loc.rack));
    $('#place-dir-field').hidden = loc.kind !== 'u';
    const canSpread = row.racks.length > 1;
    $('#place-spread-wrap').hidden = !canSpread;
    $('#place-racks').hidden = true;
    const start = row.racks.findIndex((r) => r.id === loc.rack);
    $('#place-racks').innerHTML = row.racks
      .map(
        (r, i) =>
          `<label class="chip chip-check"><input type="checkbox" value="${esc(r.id)}"${i >= start ? ' checked' : ''}><span>${esc(shortRack(r.name))}</span></label>`
      )
      .join('');
  }

  /** Whether a device of the place dialog's type, `height` for reserved space, ends inside its rack at `loc`. */
  function placeFits(loc, height) {
    return loc.kind === 'side' || loc.at + M.heightOf(project, place.typeId, height) - 1 <= M.rackUnits(project, loc.rack);
  }

  /** The free positions of the rack in the Position field, and the one picked even when it no longer fits. */
  function renderPlacePositions() {
    const loc = place.loc;
    const height = placeHeight();
    const locs = M.validLocs(project, place.typeId, loc.rack, null, height);
    if (!locs.some((l) => l.kind === loc.kind && l.at === loc.at)) locs.unshift(loc);
    $('#place-pos').innerHTML = locs
      .map((l) => {
        const label = l.kind === 'side' ? `Side slot V${l.at + 1}` : placeFits(l, height) ? M.formatPosition(project, l, place.typeId, height) : `U${l.at} (does not fit)`;
        return `<option value="${locKey(l)}"${l.kind === loc.kind && l.at === loc.at ? ' selected' : ''}>${label}</option>`;
      })
      .join('');
  }

  function placeHeight() {
    const type = M.typeOf(project, place.typeId);
    return type.variable ? M.clampInt($('#place-height').value, 1, M.rackUnits(project, place.loc.rack), 1) : undefined;
  }

  /**
   * The keyboard's way to place a device of `typeId`: the place dialog at
   * the first free position, in `rackId` if given, else in the row shown,
   * else anywhere in the plan; a side slot first for a type that goes in
   * side slots. Its Rack and Position fields pick another.
   */
  function placeByKeyboard(typeId, rackId) {
    const type = M.typeOf(project, typeId);
    const rowRacks = currentRow().row.racks.map((r) => r.id);
    const all = M.allRows(project).flatMap(({ row }) => row.racks.map((r) => r.id));
    const order = [...new Set([].concat(rackId || [], rowRacks, all))];
    const loc = M.firstFreeLoc(project, typeId, order, startHeight(type), M.prefersSideSlot(project, typeId));
    if (!loc) return toast(`No rack has room for ${type.variable ? '' : 'a '}${type.label.toLowerCase()}`, { warn: true });
    disarm();
    if (ui.view === 'map') setView('sheet');
    openPlaceDialog(typeId, loc);
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
    // A reservation's span follows its height, as typed; one that runs out of the rack has none.
    const units = M.rackUnits(project, loc.rack);
    const typed = type.variable ? parseInt($('#place-height').value, 10) : 0;
    const tooTall = typed > units;
    const rackName = M.rackById(project, loc.rack).name;
    $('#place-where').textContent = tooTall
      ? `${rackName} · does not fit · ${M.formatTypeSpec(type, typed)}`
      : placeFits(loc, height)
        ? `${M.formatLoc(project, loc, type.id, height)} · ${M.formatTypeSpec(type, height)}`
        : `${rackName} · does not fit at U${loc.at} · ${M.formatTypeSpec(type, height)}`;
    const side = loc.kind === 'side';
    const spread = !$('#place-spread-wrap').hidden && $('#place-spread').checked;
    $('#place-racks').hidden = !spread;
    const racks = spread ? $$('#place-racks input:checked').map((i) => i.value) : [loc.rack];
    // Side-slot devices take the free side slots from the one picked on, in this rack or the racks to spread over.
    const plan = (n) =>
      side
        ? M.planSideSlots(project, type.id, racks, loc.at, n)
        : spread
          ? M.planSpread(project, type.id, racks, loc.at, n, dir, height)
          : M.planPositions(project, type.id, loc.rack, loc.at, n, dir, null, height).map((at) => ({ rack: loc.rack, at }));
    place.positions = plan(qty);
    const max = plan(Infinity).length;
    if (tooTall) {
      place.valid = false;
      line.classList.add('bad');
      line.textContent = `${rackName} has ${units} units: ${typed}U do not fit.`;
    } else if (spread && !racks.length) {
      place.valid = false;
      line.classList.add('bad');
      line.textContent = 'Pick the racks to spread over.';
    } else if (!spread) {
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
      const these = spread ? 'these racks' : 'this rack';
      line.textContent = side
        ? `Only ${plural(max, 'side slot')} ${max === 1 ? 'is' : 'are'} free in ${these}.`
        : `Only ${max} fit ${dir < 0 ? 'upward' : 'downward'} from U${loc.at} in ${these}.`;
    } else if (!place.positions.length) {
      place.valid = false;
      line.classList.add('bad');
      line.textContent = M.canPlace(project, type.id, loc, null, height).reason || 'It does not fit here.';
    } else if (qty > 1 || spread) {
      const names = placeNames();
      const per = new Map();
      for (const p of place.positions) per.set(p.rack, (per.get(p.rack) || 0) + 1);
      const where =
        per.size > 1
          ? [...per].map(([r, n]) => `${shortRack(M.rackById(project, r).name)} ×${n}`).join(', ')
          : side
            ? `Side slots ${place.positions.map((p) => `V${p.at + 1}`).join(', ')}`
            : blocksText(place.positions[0].rack, place.positions.map((p) => p.at), M.heightOf(project, type.id, height));
      line.textContent = `${names[0]}${qty > 1 ? ` … ${names[qty - 1]}` : ''} · ${where}`;
    }
    line.hidden = !line.textContent;
    submit.textContent = qty > 1 ? `Place ${qty}` : 'Place';
    submit.disabled = !place.valid;
    notePlaceClash();
    notePlaceBudget();
    drawPlaceGhosts();
  }

  /** "a", "a, b" or "a … z": names in a short line. */
  const nameRange = (names) => (names.length > 2 ? `${names[0]} … ${names[names.length - 1]}` : names.join(', '));

  /**
   * A note for when other devices than `ignore` (ids) already have the
   * names `names`: it names them and has a button (id `buttonId`, its
   * data-name the first name) to use the next free series instead. ''
   * when the names are free.
   */
  function clashNote(names, ignore, buttonId) {
    const taken = M.takenNames(project, names.filter(Boolean), ignore);
    if (!taken.length) return '';
    const free = M.nameSequence(M.nextInSeries(project, names[0], names.length, false, ignore), names.length);
    return (
      `<span>${taken.length > 1 ? 'Other devices are' : 'Another device is'} named ${esc(nameRange(taken))}.</span> ` +
      `<button type="button" class="btn sm" id="${buttonId}" data-name="${esc(free[0])}">Use ${esc(nameRange(free))}</button>`
    );
  }
  /** Asks before giving devices the names `taken` that others have; `ok` names the button that goes ahead. */
  function confirmTaken(taken, ok) {
    return confirmDialog({
      title: `Use ${nameRange(taken)} twice?`,
      body: `Other devices already have ${taken.length > 1 ? 'these names' : 'this name'}. Names are host names, cable ends and CSV keys, so two devices with one name are hard to tell apart.`,
      ok,
    });
  }

  /** Shows in the place dialog which of its names are taken. */
  function notePlaceClash() {
    const name = $('#place-name').value.trim();
    const html = name ? clashNote(place.positions.length ? placeNames() : [name], [], 'place-dup-use') : '';
    $('#place-dup').innerHTML = html;
    $('#place-dup').hidden = !html;
  }

  /**
   * The blocks devices `h` units tall at units `ats` of a rack take, and
   * what they go around: "U20–23, U36–39 · skips ceph-01 … ceph-03".
   */
  function blocksText(rackId, ats, h) {
    const runs = [];
    for (const at of ats.slice().sort((a, b) => a - b)) {
      const last = runs[runs.length - 1];
      if (last && last[1] + 1 === at) last[1] = at + h - 1;
      else runs.push([at, at + h - 1]);
    }
    const text = runs.map(([lo, hi]) => M.formatSpan(lo, hi)).join(', ');
    if (runs.length < 2) return text;
    const lo = runs[0][1];
    const hi = runs[runs.length - 1][0];
    const skipped = M.sortedDevices(project, rackId).filter((d) => {
      if (d.loc.kind !== 'u') return false;
      const [b, t] = M.deviceSpan(project, d);
      return t > lo && b < hi;
    });
    return skipped.length ? `${text} · skips ${nameRange(skipped.map((d) => d.name))}` : text;
  }

  /** Whether the place dialog mounts the devices back to front. */
  const placeReversed = () => !!$('input[name="place-mount"][value="back"]:checked');

  /** Ghosts of the devices the place dialog would add, in the row shown around the dialog. */
  function drawPlaceGhosts() {
    if (!$('#dlg-place').open) return;
    const picked = ($('input[name="place-cluster"]:checked') || { value: '' }).value;
    const color = picked === '__new' ? place.newColor : clusterColor(picked);
    const height = placeHeight();
    const names = placeNames();
    const items = placeLocs().map((loc, i) => ({
      typeId: place.typeId,
      loc,
      height,
      name: names[i],
      color,
      reversed: placeReversed(),
    }));
    const warn = place.over.length > 0;
    setGhosts(R.renderGhosts(project, items, place.valid, { theme: ui.theme, measure, layout: ui.layout, rowId: ui.rowId, bare: prefs.detail === 'bare', warn }));
    clearGhosts($('#dlg-place'));
  }

  /**
   * Moves dialog `dlg` sideways off the ghosts in view, to the side of them
   * with more room, when it covers them and that side has room for it.
   */
  function clearGhosts(dlg) {
    dlg.style.translate = '';
    const layer = el.svg.querySelector('#ghost-layer');
    if (!layer || !layer.childElementCount) return;
    const c = el.canvas.getBoundingClientRect();
    const g = layer.getBoundingClientRect();
    const left = Math.max(g.left, c.left);
    const right = Math.min(g.right, c.right);
    const d = dlg.getBoundingClientRect();
    const covers = left < right && left < d.right && right > d.left && Math.max(g.top, c.top) < d.bottom && Math.min(g.bottom, c.bottom) > d.top;
    if (!covers) return;
    const m = 16;
    const before = left - m;
    const after = document.documentElement.clientWidth - right - m;
    if (Math.max(before, after) < d.width) return;
    const x = after >= before ? right + m : before - d.width;
    dlg.style.translate = `${Math.round(x - d.left)}px 0`;
  }

  /** The names of the devices the place dialog adds, each with the code of its rack where the name holds one. */
  const placeNames = () => M.namesAt(project, $('#place-name').value, place.loc.rack, place.positions.map((pos) => pos.rack));
  /** Where the place dialog puts its devices: a loc for each of place.positions. */
  const placeLocs = () => place.positions.map((pos) => ({ rack: pos.rack, kind: place.loc.kind, at: pos.at }));
  /** "Rack A01 will be at 12.1 kW of 12.0 kW; …" for racks over a budget (`list` from M.overBudgetWith). */
  const overLine = (list, verb) => list.map((o) => `${o.rack.name} ${verb} ${overText(o.stats)}`).join('; ');

  /** Says in the place dialog which racks its devices would put over a budget. */
  function notePlaceBudget() {
    const height = placeHeight();
    place.over = place.valid ? M.overBudgetWith(project, placeLocs().map((loc) => M.newDevice({ type: place.typeId, loc, height }))) : [];
    $('#place-budget').textContent = place.over.length ? `Over budget: ${overLine(place.over, 'will be at')}` : '';
    $('#place-budget').hidden = !place.over.length;
  }

  $('#place-name').addEventListener('input', () => {
    place.nameTouched = true;
    showError('#place-error', '');
    updatePlacePreview();
  });
  $('#place-qty').addEventListener('input', updatePlacePreview);
  $('#place-height').addEventListener('input', () => {
    renderPlacePositions();
    updatePlacePreview();
  });
  $('#place-rack').addEventListener('change', (e) => {
    const rackId = e.target.value;
    const near = place.loc.kind === 'u' ? place.loc.at : 1;
    // The nearest free position there; in a full rack its top unit, which the preview says is taken.
    setPlaceLoc(M.nearestLoc(project, place.typeId, rackId, near, null, place.loc.kind === 'side', placeHeight()) || { rack: rackId, kind: 'u', at: 1 });
    suggestPlaceCluster();
    updatePlacePreview();
  });
  $('#place-pos').addEventListener('change', (e) => {
    setPlaceLoc(parseLocKey(place.loc.rack, e.target.value));
    suggestPlaceCluster();
    updatePlacePreview();
  });
  $('#place-spread').addEventListener('change', updatePlacePreview);
  $('#place-racks').addEventListener('change', updatePlacePreview);
  $$('input[name="place-dir"]').forEach((r) => r.addEventListener('change', updatePlacePreview));
  $('#place-clusters').addEventListener('change', (e) => {
    if (e.target.name !== 'place-cluster') return;
    place.clusterTouched = true;
    const isNew = e.target.value === '__new';
    $('#place-new').hidden = !isNew;
    if (isNew) $('#place-new-name').select();
    drawPlaceGhosts();
  });
  $('#dlg-place').addEventListener('close', (e) => {
    setGhosts('');
    e.currentTarget.style.translate = '';
  });
  $('#place-mount').addEventListener('change', drawPlaceGhosts);
  $('#place-dup').addEventListener('click', (e) => {
    const b = e.target.closest('#place-dup-use');
    if (!b) return;
    $('#place-name').value = b.dataset.name;
    place.nameTouched = true;
    updatePlacePreview();
    $('#place-name').focus();
  });

  $('#place-form').addEventListener('submit', async (e) => {
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
      if (!cname || M.nameTaken(M.clustersOf(project, ui.clusterView), cname)) {
        showError('#place-error', cname ? `A cluster is named ${cname} already: pick it, or give the new one another name.` : 'Name the new cluster, or pick another one.');
        $('#place-new-name').focus();
        return;
      }
      newCluster = { id: M.uid('c'), name: cname, color: place.newColor };
    }
    const clusterId = newCluster ? newCluster.id : picked || null;
    // The cluster picked is for the view shown; the others keep the suggestion's.
    const view = ui.clusterView;
    const groups = Object.assign({}, place.groups, { [view]: clusterId });
    if (!clusterId) delete groups[view];
    const count = place.positions.length;
    const names = placeNames();
    const taken = M.takenNames(project, names);
    if (taken.length && !(await confirmTaken(taken, count > 1 ? `Place ${count} anyway` : 'Place anyway'))) return;
    const height = placeHeight();
    const over = place.over;
    const devices = placeLocs().map((loc, i) =>
      M.newDevice(
        Object.assign(
          { type: type.id, name: names[i], groups: Object.assign({}, groups), reversed: placeReversed(), loc },
          type.variable ? { height } : {}
        )
      )
    );
    ui.selection = { kind: 'devices', ids: count > 1 ? devices.map((d) => d.id) : [devices[0].id] };
    const placed = count > 1 ? `Placed ${count} devices, ${names[0]} to ${names[count - 1]}` : `Placed ${names[0]}`;
    commit(
      (p) => {
        if (newCluster) M.addCluster(p, view, newCluster);
        p.devices.push(...devices);
      },
      { label: placed }
    );
    prefs.lastClusters[type.id] = clusterId;
    savePrefs();
    $('#dlg-place').close('ok');
    // Into a cluster the racks hide: say so, with a button that shows it.
    const key = clusterId || '__none';
    const hidden = hiddenClusters().has(key);
    const where = hidden ? ` in ${clusterId ? M.clusterById(project, clusterId).name : 'Unassigned'}, which is hidden` : '';
    // Reserved space is in no legend: only devices are missed in another view.
    const missing = type.variable ? [] : project.views.filter((v) => v.id !== view && !M.clusterOf(project, devices[0], v.id));
    const parts = [placed + where, over.length ? `over budget: ${overLine(over, 'is at')}` : '', missing.length ? `no cluster in ${listAnd(missing.map((v) => v.name))}` : ''];
    const opts = { warn: over.length > 0 };
    if (hidden) Object.assign(opts, { action: 'Show', onAction: () => showCluster(key) });
    else if (missing.length) Object.assign(opts, { action: 'Show', onAction: () => setClusterView(missing[0].id) });
    toast(parts.filter(Boolean).join(' · '), opts);
  });

  // Cluster dialog -----------------------------------------------------

  const clusterDlg = { id: null, color: null, onCreate: null, onCancel: null, saved: false };

  function openClusterDialog(id, onCreate, onCancel) {
    const c = id ? M.clusterById(project, id) : null;
    Object.assign(clusterDlg, {
      id: c ? c.id : null,
      color: c ? c.color : M.nextClusterColor(project, ui.clusterView),
      onCreate: onCreate || null,
      onCancel: onCancel || null,
      saved: false,
    });
    $('#cluster-kicker').textContent = c ? 'Edit cluster' : 'New cluster';
    $('#cluster-title').textContent = c ? c.name : project.views.length > 1 ? `Create a cluster in ${M.viewOf(project, ui.clusterView).name}` : 'Create a cluster';
    $('#cluster-name').value = c ? c.name : M.nextClusterName(project, ui.clusterView);
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
    // A color near another cluster's of the view: some eyes see the two as one.
    const near = viewClusters()
      .filter((c) => c.id !== clusterDlg.id)
      .map((c) => ({ c, d: M.colorDistance(c.color, clusterDlg.color) }))
      .filter((x) => x.d < M.COLOR_NEAR)
      .sort((a, b) => a.d - b.d)[0];
    const note = $('#cluster-near');
    note.textContent = !near
      ? ''
      : near.d < 1
        ? `${near.c.name} has this color too.`
        : `Close to the color of ${near.c.name}. Not everyone can tell the two apart.`;
    note.hidden = !near;
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
    // CSV files find a cluster by its name in its view.
    const view = clusterDlg.id ? M.viewOfCluster(project, clusterDlg.id) : M.viewOf(project, ui.clusterView);
    const old = clusterDlg.id ? M.clusterById(project, clusterDlg.id).name : null;
    if (name !== old && M.nameTaken(view.clusters, name, clusterDlg.id || undefined)) {
      showError('#cluster-error', `Another cluster in ${view.name} is named ${name}.`);
      return;
    }
    const color = clusterDlg.color;
    if (clusterDlg.id) {
      const id = clusterDlg.id;
      commit((p) => (M.updateCluster(p, id, { name, color }) ? false : undefined), { label: `Changed cluster ${name}` });
    } else {
      const nc = { id: M.uid('c'), name, color };
      const onCreate = clusterDlg.onCreate;
      commit(
        (p) => {
          M.addCluster(p, view.id, nc);
          if (onCreate) onCreate(p, nc.id);
        },
        { label: `Added cluster ${name}` }
      );
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
    const view = M.viewOfCluster(project, id);
    const count = project.devices.filter((d) => M.clusterIdOf(project, d, view.id) === id).length;
    $('#dlg-cluster').close('cancel');
    const ok =
      !count ||
      (await confirmDialog({
        title: `Delete ${c.name}?`,
        body: `Its ${plural(count, 'device')} stay in place but lose their cluster color. Undo brings the cluster back.`,
        ok: 'Delete cluster',
      }));
    if (!ok) return;
    commit((p) => void M.removeCluster(p, id));
    toast(`Deleted cluster ${c.name}`, { action: 'Undo', onAction: undo });
  });

  // Views dialog -------------------------------------------------------

  function renderViewList() {
    const views = project.views;
    keepFocus($('#view-list'), () => {
      $('#view-list').innerHTML = views
        .map((v, i) => {
          const current = v.id === ui.clusterView;
          return (
            `<li class="view-row${current ? ' is-current' : ''}" data-view-row="${esc(v.id)}">` +
            `<label class="sr-only" for="view-name-${esc(v.id)}">Name of view ${i + 1}</label>` +
            `<input id="view-name-${esc(v.id)}" type="text" value="${esc(v.name)}" maxlength="60" autocomplete="off" spellcheck="false" data-view-name="${esc(v.id)}">` +
            `<span class="vw-count">${esc(plural(v.clusters.length, 'cluster'))}</span>` +
            `<button type="button" class="btn sm" data-view-show="${esc(v.id)}"${current ? ' disabled aria-pressed="true"' : ''}>${current ? 'Shown' : 'Show'}</button>` +
            `<button type="button" class="btn icon sm subtle" data-view-delete="${esc(v.id)}"${views.length < 2 ? ' disabled' : ''} title="Delete this view" aria-label="${esc(`Delete view ${v.name}`)}">${icon('trash')}</button>` +
            `</li>`
          );
        })
        .join('');
    });
    const full = views.length >= M.LIMITS.views;
    $('#view-add').disabled = full;
    $('#view-copy').disabled = full;
    showError('#views-error', full ? `A plan holds ${M.LIMITS.views} views.` : '');
  }

  function openViewsDialog() {
    renderViewList();
    openDialog($('#dlg-views'));
  }
  $('#btn-views').addEventListener('click', openViewsDialog);

  /** Adds a view (a copy of the view shown with `copy`) and shows it. */
  function addClusterView(copy) {
    const from = copy ? ui.clusterView : null;
    const name = copy ? M.copyViewName(project, from) : '';
    const v = commitAdd((p) => M.addView(p, name, from), (made) => (copy ? `Copied view ${M.viewById(project, from).name} as ${made.name}` : `Added view ${made.name}`));
    if (!v) return;
    setClusterView(v.id);
    renderViewList();
    const input = $(`[data-view-name="${CSS.escape(v.id)}"]`);
    if (input) {
      input.focus();
      input.select();
    }
  }
  $('#view-add').addEventListener('click', () => addClusterView(false));
  $('#view-copy').addEventListener('click', () => addClusterView(true));

  $('#view-list').addEventListener('change', (e) => {
    const input = e.target.closest('[data-view-name]');
    if (!input) return;
    const id = input.dataset.viewName;
    const name = input.value.trim();
    const taken = project.views.some((v) => v.id !== id && v.name.toLowerCase() === name.toLowerCase());
    if (!name || taken) {
      showError('#views-error', !name ? 'Give the view a name.' : `Another view is named ${name}.`);
      input.value = M.viewById(project, id).name;
      return;
    }
    showError('#views-error', '');
    commit((p) => void M.renameView(p, id, name), { label: `Renamed view ${M.viewById(project, id).name} to ${name}` });
    renderViewList();
  });

  $('#view-list').addEventListener('click', async (e) => {
    const show = e.target.closest('[data-view-show]');
    if (show) return setClusterView(show.dataset.viewShow);
    const del = e.target.closest('[data-view-delete]');
    if (!del) return;
    const v = M.viewById(project, del.dataset.viewDelete);
    if (!v || project.views.length < 2) return;
    const ok =
      !v.clusters.length ||
      (await confirmDialog({
        title: `Delete view ${v.name}?`,
        body: `Its ${plural(v.clusters.length, 'cluster')} go with it. The devices, their places and the cables stay. Undo brings the view back.`,
        ok: 'Delete view',
      }));
    if (!ok) return;
    commit((p) => void M.removeView(p, v.id), { label: `Deleted view ${v.name}` });
    toast(`Deleted view ${v.name}`, { action: 'Undo', onAction: undo });
    if ($('#dlg-views').open) renderViewList();
  });

  // Confirm and report dialogs -----------------------------------------

  function confirmDialog(o) {
    return new Promise((resolve) => {
      const dlg = $('#dlg-confirm');
      $('#confirm-title').textContent = o.title;
      $('#confirm-body').textContent = o.body;
      $('#confirm-ok').textContent = o.ok || 'OK';
      $('#dlg-confirm button[value="cancel"]').textContent = o.cancel || 'Cancel';
      dlg.returnValue = '';
      // Esc closes it without an answer: that counts as Cancel, unless `o.dismissOk`.
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' || (!!o.dismissOk && dlg.returnValue !== 'cancel')), { once: true });
      openDialog(dlg);
      // After a key that asked (Delete), a second press of Enter or Space keeps everything.
      (o.focusCancel ? $('#dlg-confirm button[value="cancel"]') : $('#confirm-ok')).focus();
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
    // Keyboard focus starts on the tab shown, not on the first tab whatever it is.
    $(`#cat-tab-${cat.tab}`).focus();
    revealCatalogItem();
  }
  /** Scrolls the list to its selected item, when it is out of view. */
  function revealCatalogItem() {
    const item = $('#cat-list .cat-item[aria-selected="true"]');
    if (item) item.scrollIntoView({ block: 'nearest' });
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
      // One stop for Tab: arrow keys go from tab to tab.
      b.tabIndex = b.dataset.tab === cat.tab ? 0 : -1;
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
          `<span class="cat-count" title="${esc(tab.useText(n, t.id))}">${n}</span></button>`
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
      `<div class="cat-actions">${orderButtons(list, t.id)}<span class="sec-hint">${esc(catTab().useText(n, t.id))}</span><span class="spacer"></span>` +
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
      // Cables of the type, named or picked by Auto, as the Cables panel counts them; only those that name it keep it from being deleted.
      use: (id) => cab.useCounts().types.get(id) || 0,
      useText: (n, id) => {
        const named = C.cableTypeUse(project, id);
        if (!n && !named) return 'No cable uses this type';
        return `${plural(n, 'cable')} ${n === 1 ? 'uses' : 'use'} this type; ${named ? `${named} by name` : 'Auto picked it for all of them'}`;
      },
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
      // Cable ends with the transceiver, named or picked, as the order list counts them.
      use: (id) => cab.useCounts().transceivers.get(id) || 0,
      useText: (n, id) => {
        const named = C.transceiverUse(project, id);
        if (!n && !named) return 'No cable end uses this transceiver';
        return `${plural(n, 'cable end')} ${n === 1 ? 'uses' : 'use'} this transceiver; ${named ? `${named} by name` : 'picked for all of them'}`;
      },
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
  /** Shows another tab of the catalog: its list opens at the top, on its first item. */
  function setCatalogTab(tab) {
    const other = tab !== cat.tab;
    cat.tab = tab;
    selectCatalogItem(null);
    if (other) $('#cat-list').scrollTop = 0;
    revealCatalogItem();
  }
  $$('#dlg-catalog .dlg-head [role="tab"]').forEach((b) => b.addEventListener('click', () => setCatalogTab(b.dataset.tab)));
  // Arrow keys, Home and End move between the tabs, as a tab list's do.
  $('#dlg-catalog .dlg-head [role="tablist"]').addEventListener('keydown', (e) => {
    const tabs = $$('[role="tab"]', e.currentTarget);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    setCatalogTab(next.dataset.tab);
    next.focus();
  });
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
    revealCatalogItem();
    const first = $('#cat-form input');
    if (first) first.select();
  });
  $('#btn-catalog').addEventListener('click', () => openCatalog('devices'));

  // Help dialog --------------------------------------------------------

  // The keys and how-tos of each workspace that the help lists; `both` go first in either.
  const HELP_KEYS = {
    both: [
      ['<kbd>?</kbd>', 'This help'],
      ['<kbd>/</kbd> or <kbd>Ctrl</kbd> <kbd>K</kbd>', 'Search'],
      ['<kbd>[</kbd> <kbd>]</kbd>', 'Previous, next row'],
      ['<kbd>C</kbd>', 'Racks or Cabling'],
      ['<kbd>V</kbd>, <kbd>Shift</kbd> <kbd>V</kbd>', 'Next, previous view, in a plan with more than one'],
      ['<kbd>Ctrl</kbd> <kbd>Z</kbd>, <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Z</kbd>', 'Undo, redo'],
    ],
    racks: [
      ['<kbd>M</kbd>', 'Floor map on or off'],
      ['<kbd>B</kbd>', 'Bare devices: names only'],
      ['<kbd>Tab</kbd>', 'Walk through the rack labels and devices'],
      ['<kbd>Enter</kbd> on a device type', 'Place one: pick its rack and position in the dialog'],
      ['<kbd>Enter</kbd> or <kbd>F2</kbd>', 'Rename the selected device'],
      ['<kbd>↑</kbd> <kbd>↓</kbd>', 'Move the selected devices to the next free position'],
      ['<kbd>←</kbd> <kbd>→</kbd>', 'Move them to the neighbouring rack'],
      ['<kbd>Shift</kbd> + click, <kbd>Shift</kbd> + drag', 'Add to the selection, select an area'],
      ['<kbd>Ctrl</kbd> <kbd>A</kbd>', 'Select every device in the row'],
      ['<kbd>Ctrl</kbd> <kbd>D</kbd>', 'Duplicate the selected devices, rack, row or floor'],
      ['<kbd>Alt</kbd> + drop', 'Copy instead of move'],
      ['<kbd>Del</kbd>', 'Delete the selected devices'],
      ['<kbd>0</kbd> <kbd>1</kbd> <kbd>+</kbd> <kbd>−</kbd>', 'Fit the sheet, 100%, zoom in, out'],
      ['<kbd>Ctrl</kbd> + scroll', 'Zoom at the pointer'],
      ['<kbd>Esc</kbd>', 'Cancel placing or dragging, deselect, clear the search'],
    ],
    cabling: [
      ['<kbd>Shift</kbd> or <kbd>Ctrl</kbd> + click', 'Add or remove a cable; in the schedule, Shift selects a range'],
      ['<kbd>Ctrl</kbd> <kbd>A</kbd>', 'Select the cables shown'],
      ['<kbd>Enter</kbd> or <kbd>F2</kbd>', 'Edit the label of the selected cable'],
      ['<kbd>Enter</kbd> or <kbd>Esc</kbd>', 'Connect a breakout cable with the legs set so far'],
      ['<kbd>Del</kbd>', 'Delete the selected cables, or unplug the selected port'],
      ['<kbd>0</kbd> <kbd>1</kbd> <kbd>+</kbd> <kbd>−</kbd>', 'Fit, 100%, zoom in, out, in the elevation and the fabric'],
      ['<kbd>Esc</kbd>', 'Cancel connecting, deselect, show all networks'],
    ],
  };
  const HELP_HOWTO = {
    racks: [
      ['Place a device', 'Drag a device type onto a rack, or click it and then a free slot. With the keyboard, press Enter on it and pick the rack and position in the dialog.'],
      ['Place several', 'Set a quantity in the place dialog to stack them, or spread them evenly over the racks of the row.'],
      ['Edit', 'Select a device, a rack’s yellow label, a row or a floor tab: the panel on the right edits it.'],
      ['Move', 'Drag devices, or select them and use the arrow keys. Hold Alt while dropping to copy them.'],
      ['Color and group', 'Clusters color the devices. Views group the same devices in other ways, each with clusters of its own.'],
    ],
    cabling: [
      ['Connect', 'Pick a cable type on the left, then click two ports, or drag from one port to the other.'],
      ['Connect a breakout cable', 'Pick its type, click the port of its head and then a port for each leg.'],
      ['Connect many at once', 'Connect series, in the schedule, the port map or the inspector of a device, joins many devices to one.'],
      ['Order', 'The schedule lists every cable with its length, and what to order underneath.'],
    ],
  };

  /** Opens the help: how-tos and every shortcut of the workspace shown. */
  function openHelp() {
    const ws = ui.workspace === 'cabling' ? 'cabling' : 'racks';
    const name = ws === 'cabling' ? 'Cabling' : 'Racks';
    const list = (rows, cls) => `<dl class="${cls}">${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>`;
    $('#help-title').textContent = `${name}: how-tos and shortcuts`;
    $('#help-body').innerHTML =
      `<section><h3>How to</h3>${list(HELP_HOWTO[ws], 'howto')}</section>` +
      `<section><h3>Shortcuts</h3>${list(HELP_KEYS.both.concat(HELP_KEYS[ws]), 'keys')}<p class="sec-hint">On a Mac, use ⌘ for Ctrl.</p></section>`;
    openDialog($('#dlg-help'));
  }
  $('#btn-help').addEventListener('click', openHelp);

  // Plans dialog -------------------------------------------------------

  function renderPlans() {
    flushPersist();
    const list = lib.list();
    const use = lib.usage();
    $('#plan-list').innerHTML = list.length
      ? list
          .map((p) => {
            const cur = p.id === planId;
            return (
              `<li class="plan-item${cur ? ' is-current' : ''}" data-plan="${esc(p.id)}">` +
              `<div class="plan-meta"><span class="plan-name-l">${esc(p.name)}</span>` +
              `<span class="plan-sub">${esc(`${plural(p.floors || 1, 'floor')} · ${plural(p.racks || 0, 'rack')} · ${plural(p.devices || 0, 'device')}${p.updated ? ` · edited ${relTime(p.updated)}` : ''} · ${sizeText(use.plans[p.id] != null ? use.plans[p.id] : p.size || 0)}`)}</span></div>` +
              `<div class="plan-actions">` +
              (cur ? `<span class="plan-now">Open now</span>` : `<button type="button" class="btn sm primary" data-plan-act="open">Open</button>`) +
              `<button type="button" class="btn icon sm" data-plan-act="rename" title="Rename" aria-label="Rename ${esc(p.name)}">${icon('pencil')}</button>` +
              `<button type="button" class="btn icon sm" data-plan-act="dup" title="Duplicate" aria-label="Duplicate ${esc(p.name)}">${icon('copy')}</button>` +
              `<button type="button" class="btn icon sm danger-text" data-plan-act="del" title="Delete" aria-label="Delete ${esc(p.name)}">${icon('trash')}</button>` +
              `</div></li>`
            );
          })
          .join('')
      : `<li class="empty-note">No saved plans. Storage may be blocked in this browser.</li>`;
    const note = $('#plan-unsaved');
    note.hidden = !unsaved;
    note.textContent = lib.newer(planId)
      ? `The latest changes to ${project.name} are not saved: a newer version of Rackplanner saved this plan. Export this plan to keep your work, then reload the page.`
      : `The latest changes to ${project.name} are not saved: the browser storage is full or blocked. Delete plans you no longer need, or export this plan to keep your work.`;
    const full = use.total > STORAGE_CHARS * 0.8;
    const usage = $('#plan-usage');
    usage.textContent = `Rackplanner uses ${sizeText(use.total)} of the browser storage, which holds about 5 MB.` + (full ? ' Delete or export plans before it is full.' : '');
    usage.classList.toggle('budget-note', full);
  }

  function switchPlan(id, message) {
    if (id === planId || !flushPersist()) return;
    const loaded = lib.load(id);
    if (!loaded) return toast(lib.newer(id) ? IO.NEWER : 'That plan could not be read', { warn: true });
    openPlan(id, loaded.project, loaded.backup);
    render();
    fitWidth();
    toast(message || `Opened ${project.name}`);
    reportLoad(loaded.warnings, loaded.backup);
  }

  /** Adds `p` as a new plan, under a name no other plan has, and opens it. `source` marks a plan from a share link. */
  function createPlan(p, message, warnings, source) {
    if (!flushPersist()) return;
    const prev = planId;
    p.name = lib.uniqueName(p.name);
    const id = lib.add(p, { source });
    lib.setCurrent(id);
    // Opening a plan clears the toasts of the one before: the warning comes after.
    openPlan(id, p);
    render();
    fitWidth();
    if (!id) {
      toast('The browser storage is full, so this plan is not saved. Delete old plans or export this one.', { warn: true });
      // Said once: the first edit, which tries to save it again, does not say it twice.
      storageWarned = true;
      setUnsaved(true);
    }
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
    } else if (act === 'rename') {
      renamePlanInList(b.closest('[data-plan]'), id);
    } else if (act === 'dup') {
      flushPersist();
      const loaded = lib.load(id);
      if (!loaded) return;
      loaded.project.name = lib.uniqueName(`${loaded.project.name} (copy)`);
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
      const kept = project;
      if (wasOpen) {
        // Nothing may save the deleted plan back while switching away from it.
        clearTimeout(persistTimer);
        persistTimer = null;
        planId = null;
        project = null;
      }
      if (!lib.remove(id)) {
        if (wasOpen) [planId, project] = [id, kept];
        return toast(`${entry.name} was not deleted: a newer version of Rackplanner wrote the list of plans in this browser`, { warn: true });
      }
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
  /** Puts a field in place of the name of a plan in the list: Enter or leaving it renames the plan, Esc keeps the name. */
  function renamePlanInList(item, id) {
    const label = $('.plan-name-l', item);
    const entry = lib.list().find((p) => p.id === id);
    if (!label || !entry) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'plan-name-in';
    input.maxLength = 120;
    input.value = entry.name;
    input.setAttribute('aria-label', `Name of ${entry.name}`);
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const typed = input.value.trim();
      // A name another plan has takes a number, as new plans do.
      const name = typed && lib.uniqueName(typed, id);
      if (keep && name && name !== entry.name) {
        if (id === planId) commit((p) => void (p.name = name), { label: 'Renamed the plan' });
        else {
          const loaded = lib.load(id);
          if (loaded) {
            loaded.project.name = name;
            if (loaded.backup) lib.backup(id);
            lib.save(id, loaded.project);
          } else toast(lib.newer(id) ? IO.NEWER : 'That plan could not be read', { warn: true });
        }
        if (name !== typed) toast(`Named it ${name}: another plan is named ${typed}`);
      }
      renderPlans();
      const again = $(`[data-plan="${CSS.escape(id)}"] [data-plan-act="rename"]`);
      if (again && document.activeElement === document.body) again.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      // Esc leaves the field, not the dialog.
      e.preventDefault();
      e.stopPropagation();
      finish(e.key === 'Enter');
    });
    input.addEventListener('blur', () => finish(true));
  }

  $('#dlg-plans').addEventListener('click', (e) => {
    const b = e.target.closest('[data-plan-new]');
    if (!b) return;
    $('#dlg-plans').close();
    newPlan(b.dataset.planNew);
  });
  $('#btn-plans').addEventListener('click', () => {
    renderPlans();
    if (!$('#dlg-elsewhere').open) openDialog($('#dlg-plans'));
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
    // A cable schedule always adds its cables to the plan open.
    if (csv && IO.isCablesCSV(text)) {
      const err = cab.importCablesText(text);
      return err ? showError('#open-error', err) : undefined;
    }
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
      result = IO.importCSV(text, merge ? project : null, merge ? ui.clusterView : null);
    } catch (e) {
      return showError('#open-error', e.message);
    }
    $('#dlg-open').close('ok');
    const sub = `${plural(result.warnings.length, 'row')} or detail${result.warnings.length === 1 ? '' : 's'} needed attention:`;
    if (merge) {
      // A merge that adds nothing records no step: an Undo here would undo the step before it.
      if (replaceProject(result.project)) toast(`Added ${plural(result.added, 'device')} from the CSV`, { action: 'Undo', onAction: undo });
      else toast('No devices added from the CSV');
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
    else keepInViewport(menu);
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

  /** Moves an open menu sideways as far as it would run past an edge of the window. */
  function keepInViewport(menu) {
    menu.style.translate = '';
    const r = menu.getBoundingClientRect();
    const m = 8;
    // Not innerWidth: on a phone, a menu past the edge widens the layout viewport that it measures.
    const w = document.documentElement.clientWidth;
    const dx = r.right > w - m ? w - m - r.right : r.left < m ? m - r.left : 0;
    if (dx) menu.style.translate = `${Math.max(m - r.left, dx)}px 0`;
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
    ['#btn-export', '#menu-export', renderExportMenu],
    ['#btn-new', '#menu-new'],
    ['#btn-row', '#menu-row', renderRowMenu],
    ['#cat-new', '#menu-cat-new'],
    ['#btn-theme', '#menu-theme'],
    ['#btn-cluster-view', '#menu-views', renderViewMenu],
  ].forEach(([b, m, fill]) => {
    const btn = $(b);
    const menu = $(m);
    btn.addEventListener('click', () => {
      if (fill) fill();
      toggleMenu(btn, menu);
    });
    menu.addEventListener('keydown', (e) => menuKeydown(e, menu, btn));
    // Focus goes back to the menu's button before an item does its part, which may move it on (into a dialog, a field).
    menu.addEventListener('click', (e) => e.target.closest('button') && btn.focus({ preventScroll: true }), true);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.menu-wrap')) closeMenus();
  });

  /** The Export menu says what PNG, SVG and Print give from where it opens: the Racks sheet of the row, or the Cabling drawing shown. */
  function renderExportMenu() {
    const cabling = ui.workspace === 'cabling';
    const drawing = cabling ? cab.drawingName() : null;
    const what = drawing || (cabling ? 'This row’s Racks sheet' : 'This row');
    const hint = (kind, text) => ($(`#menu-export [data-export="${kind}"] small`).textContent = text);
    // Drawings hide what the screen hides, as they leave out the fronts in bare mode; the menu says so.
    const elevation = cabling && ui.cabView === 'elevation';
    const hidden = elevation ? cab.hiddenNetworkIds().length : drawing ? 0 : hiddenClusters().size;
    const note = hidden ? ` · ${plural(hidden, elevation ? 'network' : 'cluster')} hidden` : '';
    hint('png', `${what}, for docs, tickets and chat${note}`);
    hint('svg', `${what}, opens in vector editors${note}`);
    hint('print', (elevation ? `One sheet per row, its cabling from the ${prefs.cabSide}` : 'One sheet per row, with title blocks') + note);
  }

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
    const changed = replaceProject(M.createEmptyProject());
    fitWidth();
    toast('Started an empty plan', changed ? { action: 'Undo', onAction: undo } : {});
  }

  $('#btn-start-empty').addEventListener('click', startEmptyInPlace);
  $('#btn-keep-example').addEventListener('click', () => commit((p) => void delete p.meta.example, { label: 'Kept the example plan' }));

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
    return { rowId: ui.rowId, measure, date: todayISO(), sheet: sheetInfo(ui.rowId), bare: prefs.detail === 'bare', view: ui.clusterView, hidden: hiddenFn(), hiddenClusters: legendHidden() };
  }

  /** The drawing to export as PNG or SVG: the Racks sheet of the row, or the Cabling workspace's elevation or fabric when it shows one. */
  function exportDrawing() {
    const cabling = ui.workspace === 'cabling' && cab.exportDrawing();
    if (cabling) return cabling;
    return { svg: R.exportSVG(project, exportOpts()), file: fileBase(true) };
  }

  /** A PNG of an SVG drawing, at `scale` where the browser's canvas allows it, else smaller (but not below 1). */
  function renderPNG(svg, want) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = R.pngScale(img.naturalWidth, img.naturalHeight, want);
        if (!scale) return reject(new Error('the drawing is too large for a PNG; export it as SVG'));
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

  /** The toast of an order list that leaves out `n` cables, which have no type or no length to buy. */
  function orderLeftOut(name, n) {
    return `Exported ${name}. It leaves out ${plural(n, 'cable')} without a type or a length to buy.`;
  }

  async function doExport(kind) {
    try {
      if (kind === 'copy') return copyJSON();
      if (kind === 'share') return openShare();
      if (kind === 'print') return openPrint();
      let name;
      if (kind === 'json') download((name = `${fileBase()}.json`), new Blob([IO.serialize(project)], { type: 'application/json' }));
      else if (kind === 'csv') download((name = `${fileBase()}.csv`), new Blob(['﻿' + IO.toCSV(project)], { type: 'text/csv;charset=utf-8' }));
      else if (kind === 'cables-csv') download((name = `${fileBase()}-cables.csv`), new Blob(['﻿' + IO.exportCablesCSV(project)], { type: 'text/csv;charset=utf-8' }));
      else if (kind === 'order-csv') {
        download((name = `${fileBase()}-cable-order.csv`), new Blob(['﻿' + IO.exportOrderCSV(project)], { type: 'text/csv;charset=utf-8' }));
        const left = C.billOfMaterials(project).unresolved;
        if (left) return toast(orderLeftOut(name, left), { warn: true });
      } else if (kind === 'svg') {
        const d = exportDrawing();
        download((name = `${d.file}.svg`), new Blob([d.svg], { type: 'image/svg+xml' }));
      } else if (kind === 'png') {
        const d = exportDrawing();
        download((name = `${d.file}.png`), await renderPNG(d.svg, 2));
      }
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

  /** A short fingerprint of `text`: of the code of a share link, kept with the plans opened from it, or of a warning shown (see reportLoad). */
  function fingerprint(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`;
  }

  /** Opens a plan passed in the address (#plan=…) as a new plan, or the plan opened from the same link before. */
  async function openSharedFromHash() {
    const hash = location.hash;
    if (!hash.startsWith(SHARE_PREFIX)) return;
    window.history.replaceState(null, '', location.pathname + location.search);
    const code = hash.slice(SHARE_PREFIX.length);
    let result;
    try {
      result = IO.normalizeProject(await IO.decodeShare(code));
    } catch (e) {
      return toast(e.message, { warn: true });
    }
    delete result.project.meta.example;
    const source = fingerprint(code);
    const before = lib.list().find((p) => p.source === source && lib.load(p.id));
    if (before) {
      const existing = await confirmDialog({
        title: `Open ${before.name} again?`,
        body: `This browser has a plan from this link already, edited ${relTime(before.updated)}. Open that plan, or open the link as a new copy.`,
        ok: 'Open existing',
        cancel: 'Open as a copy',
        // Dismissed, it adds no plan.
        dismissOk: true,
      });
      if (existing) return before.id === planId ? toast(`${before.name} is open`) : switchPlan(before.id);
    }
    result.project.name = lib.uniqueName(result.project.name);
    createPlan(result.project, `Opened the shared plan ${result.project.name}`, result.warnings, source);
  }
  window.addEventListener('hashchange', openSharedFromHash);

  // The address --------------------------------------------------------

  /**
   * The address names the row shown, the floor map and the workspace, as
   * in #row=row3&view=map&ws=cabling: each change adds a step that Back
   * and Forward go through, and an address with them opens there. A share
   * link (#plan=…) in the address is read first.
   */
  function addressOf() {
    const q = new URLSearchParams({ row: ui.rowId });
    if (ui.view === 'map') q.set('view', 'map');
    if (ui.workspace === 'cabling') q.set('ws', 'cabling');
    return `#${q}`;
  }
  function writeAddress() {
    if (address.following || location.hash.startsWith(SHARE_PREFIX)) return;
    const hash = addressOf();
    if (hash === location.hash) return;
    const url = location.pathname + location.search + hash;
    try {
      if (address.replace || !location.hash) window.history.replaceState(null, '', url);
      else window.history.pushState(null, '', url);
    } catch (e) {
      /* some browsers refuse many changes in a short time; the next one catches up */
    }
    address.replace = false;
  }
  /** What the address asks for: { rowId, view, workspace }, or null. */
  function readAddress() {
    const hash = location.hash;
    if (hash.startsWith(SHARE_PREFIX)) return null;
    const q = new URLSearchParams(hash.slice(1));
    if (!q.get('row')) return null;
    return { rowId: q.get('row'), view: q.get('view') === 'map' ? 'map' : 'sheet', workspace: q.get('ws') === 'cabling' ? 'cabling' : 'racks' };
  }
  /** Before the first drawing: opens where the address says, in a row the plan has. */
  function takeAddress() {
    const a = readAddress();
    if (!a || !M.rowById(project, a.rowId)) return;
    ui.rowId = a.rowId;
    ui.view = a.view;
    ui.workspace = a.workspace;
  }
  /** After Back or Forward: goes where the address says. One with a row the plan does not have (of another plan) is put right. */
  function followAddress() {
    const a = readAddress();
    if (a && M.rowById(project, a.rowId)) {
      address.following = true;
      try {
        setWorkspace(a.workspace);
        setView(a.view);
        setRow(a.rowId);
      } finally {
        address.following = false;
      }
    }
    address.replace = true;
    writeAddress();
  }
  window.addEventListener('popstate', followAddress);

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
    // The drawing shown: the Racks sheet, or the Cabling elevation from its side.
    const drawing = ui.workspace === 'cabling' && ui.cabView === 'elevation' ? prefs.cabSide : 'racks';
    $(`input[name="print-drawing"][value="${drawing}"]`).checked = true;
    openDialog($('#dlg-print'));
  }

  $('#print-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const scope = $('input[name="print-scope"]:checked').value;
    const paper = $('#print-paper').value;
    const orient = $('input[name="print-orient"]:checked').value;
    const drawing = $('input[name="print-drawing"]:checked').value;
    prefs.paper = paper;
    savePrefs();
    $('#dlg-print').close('ok');
    printSheets(scope, paper, orient, drawing);
  });

  /** Prints the rows of `scope`, a sheet each: their racks (`drawing` 'racks') or their cabling seen from the 'front' or the 'rear'. */
  function printSheets(scope, paper, orient, drawing) {
    const pos = currentRow();
    const all = M.allRows(project);
    const rows = scope === 'row' ? [pos.row.id] : scope === 'floor' ? pos.floor.rows.map((r) => r.id) : all.map((r) => r.row.id);
    const date = todayISO();
    el.printRoot.innerHTML = rows
      .map((rowId) => {
        const sc =
          drawing === 'front' || drawing === 'rear'
            ? CR.elevation(project, { rowId, side: drawing, theme: 'light', measure, hiddenNetworks: cab.hiddenNetworkIds() })
            : R.renderScene(project, { rowId, theme: 'light', measure, date, sheet: sheetInfo(rowId), bare: prefs.detail === 'bare', view: ui.clusterView, hidden: hiddenFn(), hiddenClusters: legendHidden() });
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
    placeToastsSoon();
  }
  $$('dialog').forEach((dlg) => dlg.addEventListener('close', hostToasts));

  /**
   * In a dialog, the toasts keep clear of its footer: where they would
   * cover its buttons (a dialog as tall as a phone's screen), they sit just
   * above it. Placed once the dialog has its content, and again when it
   * changes size. In Cabling they keep off the drawing, whose ports take
   * the clicks, and off the inspector, whose fields the user goes on to:
   * at the foot of the left panel beside the drawing, or over the stage's
   * nav bar when the drawing takes the width of the screen.
   */
  function placeToasts() {
    const host = el.toasts.parentNode;
    const foot = host && host.tagName === 'DIALOG' && host.open ? $('.dlg-foot', host) : null;
    const style = el.toasts.style;
    style.top = style.bottom = style.left = style.width = '';
    el.toasts.classList.remove('is-docked', 'is-top');
    if (!el.toasts.children.length) return;
    if (!foot) {
      if (host === document.body && ui.workspace === 'cabling') dockToasts();
      return;
    }
    const f = foot.getBoundingClientRect();
    const t = el.toasts.getBoundingClientRect();
    if (t.bottom > f.top && t.top < f.bottom) style.bottom = `${Math.round(window.innerHeight - f.top + 8)}px`;
  }
  function dockToasts() {
    const style = el.toasts.style;
    const stage = el.stage.getBoundingClientRect();
    const bin = $('#bin').getBoundingClientRect();
    if (bin.width && bin.right <= stage.left) {
      el.toasts.classList.add('is-docked');
      style.left = `${Math.round(bin.left + 8)}px`;
      style.width = `${Math.round(bin.width - 16)}px`;
      style.bottom = `${Math.round(window.innerHeight - Math.min(bin.bottom, window.innerHeight) + 8)}px`;
      return;
    }
    // On a narrow screen the left panel is above the stage: over the nav bar, which stays at the top while the stage is in view.
    const nav = $('.nav', el.stage).getBoundingClientRect();
    if (stage.bottom < nav.height || stage.top > window.innerHeight - nav.height) return;
    el.toasts.classList.add('is-docked', 'is-top');
    style.left = `${Math.round(stage.left + 8)}px`;
    style.width = `${Math.round(stage.width - 16)}px`;
    style.top = `${Math.round(Math.max(nav.top, 0) + 4)}px`;
    style.bottom = 'auto';
  }
  let toastFrame = 0;
  function placeToastsSoon() {
    if (toastFrame) return;
    toastFrame = requestAnimationFrame(() => {
      toastFrame = 0;
      placeToasts();
    });
  }
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (el.toasts.parentNode && el.toasts.parentNode.tagName === 'DIALOG') placeToastsSoon();
    });
    $$('dialog').forEach((dlg) => ro.observe(dlg));
  }
  window.addEventListener('resize', placeToastsSoon);
  // On a narrow screen the nav bar that they sit over scrolls with the page until it sticks.
  window.addEventListener('scroll', () => el.toasts.children.length && placeToastsSoon(), { passive: true });

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
    // An Undo names the step just made: it undoes that step only (see
    // retireUndoToasts), and the message names it in undo and redo.
    if (o.onAction === undo && (t.undoStep = lastStep())) {
      if (!t.undoStep.label) t.undoStep.label = message;
      renderUndoButtons();
    }
    // A toast of the same kind (what undo did, the row shown) replaces the one before.
    if (o.kind) {
      t.dataset.kind = o.kind;
      for (const old of $$(`.toast[data-kind="${o.kind}"]`, el.toasts)) old.remove();
    }
    if (o.action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.action;
      b.addEventListener('click', () => {
        dismiss();
        if (!t.undoStep || t.undoStep === lastStep()) o.onAction();
      });
      t.appendChild(b);
    }
    hostToasts();
    el.toasts.appendChild(t);
    while (el.toasts.children.length > 3) el.toasts.firstElementChild.remove();
    placeToastsSoon();
    timer = setTimeout(dismiss, o.action ? 6000 : o.warn ? 5000 : 3200);
  }

  /** Says a short `message` to screen readers through the hidden status line: what a key or a click just did. */
  function announce(message) {
    el.status.textContent = message;
  }

  /**
   * A toast's Undo works while its step is the last one: a newer step takes
   * its button away, and undoing the step takes the toast away, with its
   * button or without.
   */
  function retireUndoToasts() {
    const last = lastStep();
    for (const t of [...el.toasts.children]) {
      if (!t.undoStep || t.undoStep === last) continue;
      const button = t.querySelector('button');
      if (!history.past.some((entry) => entry.step === t.undoStep)) t.remove();
      else if (button) button.remove();
    }
    placeToastsSoon();
  }

  // -------------------------------------------------------------- toolbar

  el.undo.addEventListener('click', undo);
  el.redo.addEventListener('click', redo);
  el.navUndo.addEventListener('click', undo);
  el.navRedo.addEventListener('click', redo);
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
    const cabling = ui.workspace === 'cabling';
    if (cabling && !(t.closest && t.closest('.menu')) && cab.onKeyDown(e, { formControl, textEntry, mod, key, letter })) return;
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
      } else if (cabling && cab.cancelPending()) return;
      else if (ui.armed || ui.moving) disarm();
      else if (!$$('.menu').every((m) => m.hidden)) closeMenus();
      else if (cabling ? cab.hasSelection() : ui.selection) {
        if (cabling) cab.clearSelection();
        else clearSelection();
      } else if (ui.query) {
        el.search.value = '';
        setQuery('');
      } else if (cabling) cab.clearFocus();
      else if (ui.focusCluster) {
        ui.focusCluster = null;
        render({ inspector: false });
      }
      return;
    }

    // With a type armed, Enter chooses where it goes: in the rack of the focused label or device, else the first free slot.
    if (ui.armed && key === 'Enter' && !mod && !(t.closest && t.closest('button, a[href], summary, .add-rack'))) {
      e.preventDefault();
      const rack = t.closest && t.closest('.scene .rack[data-rack]');
      return placeByKeyboard(ui.armed, rack ? rack.dataset.rack : null);
    }

    // The Racks workspace's selection only takes keys there.
    const ids = cabling ? [] : selIds();
    const d = cabling ? null : selectedDevice();
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
    if (mod && !e.shiftKey && !e.altKey && letter === 'd' && ui.selection && !cabling) {
      e.preventDefault();
      const s = ui.selection;
      return s.kind === 'devices' ? duplicateDevices(s.ids) : duplicateStructure(s.kind, s.id);
    }
    if (mod && letter === 'a' && ui.view === 'sheet' && !cabling) {
      e.preventDefault();
      // As on the sheet, what is hidden is left out; a cluster's select button takes its devices all the same.
      const hide = hiddenFn();
      return selectDevices(M.devicesWithin(project, ui.rowId).filter((x) => !hide || !hide(x)).map((x) => x.id));
    }
    // Many layouts type these with AltGr (Ctrl+Alt on Windows) or Option: the character typed counts.
    const typed = !e.metaKey && (e.altKey || !e.ctrlKey) ? key : '';
    if (typed === '[' || typed === ']') return stepRow(typed === '[' ? -1 : 1);
    if (typed === '?') return openHelp();
    if (mod || e.altKey) return;
    if (key === '/') {
      e.preventDefault();
      focusSearch();
    } else if (letter === 'c') {
      setWorkspace(cabling ? 'racks' : 'cabling');
      if (focusLost()) focusStage();
    }
    else if (letter === 'v') stepClusterView(e.shiftKey ? -1 : 1);
    else if (letter === 'b' && !cabling) setDetail(prefs.detail === 'bare' ? 'full' : 'bare');
    else if (letter === 'm' && !cabling) setView(ui.view === 'map' ? 'sheet' : 'map');
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
      // A drawing kept as it is while nothing it shows changes is drawn again with the new widths.
      delete el.svg.dataset.drawn;
      renderParts();
      renderStage();
    };
    const faces = Object.values(R.FONTS).map((f) => f.css);
    Promise.all(faces.map((f) => document.fonts.load(f).catch(() => null))).then(remeasure);
    if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', remeasure);
  }

  window.addEventListener('pagehide', flushPersist);
  // While saves fail, closing the tab would lose the latest changes: the browser asks first.
  window.addEventListener('beforeunload', (e) => {
    flushPersist();
    if (!unsaved) return;
    e.preventDefault();
    e.returnValue = '';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersist();
    else followOtherTab();
  });

  // Another tab may have changed the list of plans or this plan.
  window.addEventListener('storage', (e) => {
    if (e.key && !e.key.startsWith('rackplanner.')) return;
    followOtherTab();
    if ($('#dlg-plans').open) renderPlans();
  });
  // A page back from the browser's cache, or a tab that slept, may have missed saves of other tabs.
  window.addEventListener('pageshow', followOtherTab);

  // ----------------------------------------------------------------- boot

  applyTheme();
  ui.theme = detectTheme();
  bootPlan();
  takeAddress();
  render();
  // Opened in Cabling, its drawing fits the stage; the Racks sheet keeps its zoom for later.
  if (ui.workspace === 'cabling') {
    if (zoomable()) fitWidth();
  } else if (prefs.zoom) {
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
