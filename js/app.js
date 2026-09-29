/*
 * Rackplanner: browser UI.
 *
 * Owns the editable state (project + undo history), renders it through
 * RP.render, and wires up drag and drop, click-to-place, dialogs, the
 * inspector, keyboard shortcuts, persistence and export.
 */
(function () {
  'use strict';

  const M = window.RP.model;
  const R = window.RP.render;
  const G = R.geometry;

  const STORAGE_KEY = 'rackplanner.plan.v1';
  const PREFS_KEY = 'rackplanner.prefs.v1';
  const HISTORY_LIMIT = 200;
  const COLOR_NAMES = ['Cobalt', 'Orange', 'Teal', 'Violet', 'Amber', 'Red', 'Green', 'Cyan', 'Rose', 'Indigo', 'Olive', 'Brown'];

  // ------------------------------------------------------------ utilities

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  const icon = (id, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

  // Browser storage can be missing or throw (private windows, sandboxes).
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
      } catch (e) {
        /* not persisted; the app keeps working in memory */
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
      measureCache.set(key, w);
    }
    return w;
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function detectTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // ---------------------------------------------------------------- state

  const prefs = Object.assign({ zoom: null, lastCluster: null }, readJSON(PREFS_KEY) || {});
  let project = loadProject();
  const history = { past: [], future: [], key: null, at: 0 };
  const ui = {
    selection: null, // { kind: 'device' | 'rack', id }
    focusCluster: null, // cluster id, '__none' for unassigned, or null
    hoverCluster: null,
    armed: null, // device type id while click-to-place is active
    drag: null,
    press: null,
    pan: null,
    zoom: 1,
    theme: detectTheme(),
    sceneW: G.SHEET_W,
    sceneH: 1200,
  };
  let lastDragEnd = 0;

  function loadProject() {
    const saved = readJSON(STORAGE_KEY);
    if (saved) {
      try {
        return M.normalizeProject(saved).project;
      } catch (e) {
        /* unreadable saved state: start from the example */
      }
    }
    return M.createExampleProject();
  }

  let persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(flushPersist, 200);
  }
  function flushPersist() {
    clearTimeout(persistTimer);
    storage.set(STORAGE_KEY, M.serialize(project));
  }
  function savePrefs() {
    storage.set(PREFS_KEY, JSON.stringify(prefs));
  }

  /**
   * Applies `mutate` to a copy of the project and records an undo step.
   * Edits sharing `opts.key` within two seconds (typing) share one step.
   */
  function commit(mutate, opts) {
    const o = opts || {};
    const before = JSON.stringify(project);
    const draft = JSON.parse(before);
    if (mutate(draft) === false) return false;
    const after = JSON.stringify(draft);
    if (after === before) return false;
    const now = Date.now();
    const coalesce = o.key && history.key === o.key && now - history.at < 2000;
    if (!coalesce) {
      history.past.push(before);
      if (history.past.length > HISTORY_LIMIT) history.past.shift();
    }
    history.key = o.key || null;
    history.at = now;
    history.future.length = 0;
    project = draft;
    persist();
    render(o);
    return true;
  }

  function undo() {
    if (!history.past.length) return;
    history.future.push(JSON.stringify(project));
    project = JSON.parse(history.past.pop());
    history.key = null;
    persist();
    render();
  }

  function redo() {
    if (!history.future.length) return;
    history.past.push(JSON.stringify(project));
    project = JSON.parse(history.future.pop());
    history.key = null;
    persist();
    render();
  }

  // ------------------------------------------------------------- elements

  const el = {
    svg: $('#scene'),
    canvas: $('#canvas'),
    stage: $('#stage'),
    parts: $('#parts'),
    clusters: $('#clusters'),
    clustersHint: $('#clusters-hint'),
    inspector: $('#inspector'),
    planName: $('#plan-name'),
    undo: $('#btn-undo'),
    redo: $('#btn-redo'),
    zoomLevel: $('#btn-zoom-reset'),
    notice: $('#example-notice'),
    armedHint: $('#armed-hint'),
    chip: $('#drag-chip'),
    toasts: $('#toasts'),
    fileInput: $('#file-input'),
  };

  // ------------------------------------------------------------ rendering

  function render(opts) {
    const o = opts || {};
    pruneUiState();
    renderScene();
    renderParts();
    renderClusters();
    if (o.inspector !== false) renderInspector();
    renderChrome();
  }

  function pruneUiState() {
    const s = ui.selection;
    if (s && s.kind === 'device' && !M.deviceById(project, s.id)) ui.selection = null;
    if (s && s.kind === 'rack' && !M.rackById(project, s.id)) ui.selection = null;
    const valid = (c) => !c || (c === '__none' ? project.devices.some((d) => !d.cluster) : !!M.clusterById(project, c));
    if (!valid(ui.focusCluster)) ui.focusCluster = null;
    if (!valid(ui.hoverCluster)) ui.hoverCluster = null;
  }

  function findDevEl(id) {
    return el.svg.querySelector(`.dev[data-id="${CSS.escape(id)}"]`);
  }
  function ghostLayer() {
    return el.svg.querySelector('#ghost-layer');
  }

  function renderScene() {
    const active = document.activeElement;
    const focusedId = active && active !== el.svg && el.svg.contains(active) && active.dataset ? active.dataset.id : null;
    const sel = ui.selection;
    const d = ui.drag;
    const out = R.renderScene(project, {
      theme: ui.theme,
      interactive: true,
      measure,
      date: todayISO(),
      selectedDevice: sel && sel.kind === 'device' ? sel.id : null,
      selectedRack: sel && sel.kind === 'rack' ? sel.id : null,
      focusCluster: ui.hoverCluster || ui.focusCluster,
      draggingId: d && d.active && d.source === 'device' && !d.copy ? d.deviceId : null,
    });
    ui.sceneW = out.width;
    ui.sceneH = out.height;
    el.svg.setAttribute('viewBox', `0 0 ${out.width} ${out.height}`);
    el.svg.innerHTML = out.body + '<g id="ghost-layer"></g>';
    applyZoom();
    if (focusedId) {
      const g = findDevEl(focusedId);
      if (g) g.focus({ preventScroll: true });
    }
  }

  let partsTheme = null;
  function renderParts() {
    if (partsTheme !== ui.theme) {
      el.parts.innerHTML = M.DEVICE_TYPES.map((t) => {
        const pv = R.renderPreview(t.id, ui.theme, null, t.defaultName, measure);
        const w = 150;
        const h = Math.round((pv.height * w) / pv.width);
        return (
          `<button type="button" class="part" data-type="${t.id}" aria-pressed="false">` +
          `<span class="part-art"><svg viewBox="0 0 ${pv.width} ${pv.height}" width="${w}" height="${h}" aria-hidden="true">${pv.body}</svg></span>` +
          `<span class="part-meta"><span class="part-name">${esc(t.label)}</span><span class="part-spec">${esc(t.spec)}</span></span>` +
          `<span class="part-count" data-count></span></button>`
        );
      }).join('');
      partsTheme = ui.theme;
    }
    for (const t of M.DEVICE_TYPES) {
      const card = el.parts.querySelector(`[data-type="${t.id}"]`);
      const n = project.devices.filter((d) => d.type === t.id).length;
      const count = card.querySelector('[data-count]');
      count.textContent = n;
      count.title = `${n} placed`;
      count.classList.toggle('is-zero', !n);
      card.classList.toggle('is-armed', ui.armed === t.id);
      card.setAttribute('aria-pressed', String(ui.armed === t.id));
      card.setAttribute('aria-label', `${t.label}, ${t.spec}, ${n} placed. Click, then click a free slot to place it.`);
    }
  }

  function renderClusters() {
    const counts = new Map();
    let unassigned = 0;
    for (const d of project.devices) {
      if (d.cluster) counts.set(d.cluster, (counts.get(d.cluster) || 0) + 1);
      else unassigned++;
    }
    const row = (id, name, color, count, editable) =>
      `<li class="cl-row" data-cluster="${esc(id)}">` +
      `<button type="button" class="cl-main" aria-pressed="${ui.focusCluster === id}">` +
      `<span class="sw" style="--c:${color || 'var(--unassigned)'}"></span>` +
      `<span class="cl-name">${esc(name)}</span><span class="cl-count" title="${count} devices">${count}</span></button>` +
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
      const t = M.typeById(ui.armed);
      el.armedHint.innerHTML =
        `<span>Click a free slot to place a <strong>${esc(t.label.toLowerCase())}</strong></span><kbd>Esc</kbd>` +
        `<button type="button" data-disarm aria-label="Stop placing">${icon('x', 'ic-sm')}</button>`;
    }
    el.armedHint.hidden = !ui.armed;
  }

  // ------------------------------------------------------------ inspector

  function clusterChips(name, selected, withNew) {
    const chip = (value, label, color, checked, cls) =>
      `<label class="chip${cls || ''}"><input type="radio" name="${name}" value="${esc(value)}"${checked ? ' checked' : ''}>` +
      `<span>${color !== undefined ? `<i class="sw" style="--c:${color || 'var(--unassigned)'}"></i>` : ''}${esc(label)}</span></label>`;
    let s = chip('', 'None', null, !selected);
    for (const c of project.clusters) s += chip(c.id, c.name, c.color, selected === c.id);
    if (withNew) s += chip('__new', '+ New cluster', undefined, selected === '__new', ' chip-new');
    return s;
  }

  const locKey = (l) => `${l.kind}:${l.at}`;
  function parseLocKey(rack, key) {
    const [kind, at] = key.split(':');
    return { rack, kind, at: parseInt(at, 10) };
  }

  function renderInspector() {
    const s = ui.selection;
    if (s && s.kind === 'device') renderDeviceInspector(M.deviceById(project, s.id));
    else if (s && s.kind === 'rack') renderRackInspector(M.rackById(project, s.id));
    else renderOverview();
  }

  function renderDeviceInspector(d) {
    const type = M.typeById(d.type);
    const cluster = M.clusterById(project, d.cluster);
    const rackOpts = project.racks
      .map((r) => `<option value="${esc(r.id)}"${r.id === d.loc.rack ? ' selected' : ''}>${esc(r.name)}</option>`)
      .join('');
    const slotOpts = M.validLocs(project, d.type, d.loc.rack, d.id)
      .map((l) => {
        const cur = l.kind === d.loc.kind && l.at === d.loc.at;
        const label = l.kind === 'side' ? `Side slot V${l.at + 1}` : M.formatPosition(l, d.type);
        return `<option value="${locKey(l)}"${cur ? ' selected' : ''}>${label}</option>`;
      })
      .join('');
    const canUp = !!M.nudgeTarget(project, d, 1);
    const canDown = !!M.nudgeTarget(project, d, -1);

    el.inspector.innerHTML =
      `<div class="insp-head">` +
      `<div class="kicker"><span class="sw" style="--c:${cluster ? cluster.color : 'var(--unassigned)'}"></span>${esc(type.label)} · ${type.height}U</div>` +
      `<label for="insp-name" class="sr-only">Device name</label>` +
      `<input id="insp-name" class="name-input" type="text" value="${esc(d.name)}" spellcheck="false" autocomplete="off" maxlength="80">` +
      `<div class="insp-where">${esc(M.formatLoc(project, d.loc, d.type))}</div>` +
      `</div>` +
      `<section class="insp-sec"><h3 id="insp-cluster-label">Cluster</h3>` +
      `<div class="chips" role="radiogroup" aria-labelledby="insp-cluster-label">${clusterChips('insp-cluster', d.cluster, true)}</div></section>` +
      `<section class="insp-sec"><h3>Position</h3>` +
      `<div class="pos-grid">` +
      `<div class="field"><label for="insp-rack">Rack</label><select id="insp-rack">${rackOpts}</select></div>` +
      `<div class="field"><label for="insp-slot">Slot</label><select id="insp-slot">${slotOpts}</select></div>` +
      `</div>` +
      (d.loc.kind === 'u'
        ? `<div class="nudge"><button type="button" class="btn sm" id="insp-up"${canUp ? '' : ' disabled'} title="Next free position above (↑)">${icon('up')}Move up</button>` +
          `<button type="button" class="btn sm" id="insp-down"${canDown ? '' : ' disabled'} title="Next free position below (↓)">${icon('down')}Move down</button></div>`
        : '') +
      `</section>` +
      `<section class="insp-sec"><h3><label for="insp-notes">Notes</label></h3>` +
      `<textarea id="insp-notes" rows="3" placeholder="Serial number, owner, cabling …">${esc(d.notes || '')}</textarea></section>` +
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
      const loc = M.nearestLoc(project, cur.type, rackId, cur.loc.kind === 'u' ? cur.loc.at : 24, id, cur.loc.kind === 'side');
      if (!loc) {
        toast(`${M.rackById(project, rackId).name} has no free space for ${cur.name}`, { warn: true });
        renderInspector();
        return;
      }
      moveDevice(id, loc);
    });
    $('#insp-slot').addEventListener('change', (e) => moveDevice(id, parseLocKey(d.loc.rack, e.target.value)));
    const up = $('#insp-up');
    const down = $('#insp-down');
    if (up) up.addEventListener('click', () => nudge(id, 1));
    if (down) down.addEventListener('click', () => nudge(id, -1));
    const notes = $('#insp-notes');
    notes.addEventListener('input', () => {
      const v = notes.value;
      commit((p) => void (M.deviceById(p, id).notes = v), { key: 'notes:' + id, inspector: false });
    });
    $('#insp-dup').addEventListener('click', () => duplicateDevice(id));
    $('#insp-del').addEventListener('click', () => deleteDevice(id));
  }

  function renderRackInspector(rack) {
    const st = M.rackStats(project, rack.id);
    const devs = M.sortedDevices(project, rack.id);
    const pct = Math.round((st.used / M.RACK_UNITS) * 100);
    const rows = devs
      .map((d) => {
        const c = M.clusterById(project, d.cluster);
        return (
          `<li><button type="button" data-select="${esc(d.id)}" title="${esc(M.typeById(d.type).label)}">` +
          `<span class="u">${M.formatPosition(d.loc, d.type)}</span>` +
          `<span class="sw" style="--c:${c ? c.color : 'var(--unassigned)'}"></span>` +
          `<span class="nm">${esc(d.name)}</span></button></li>`
        );
      })
      .join('');
    el.inspector.innerHTML =
      `<div class="insp-head">` +
      `<div class="kicker">Rack · 19″ · ${M.RACK_UNITS}U + ${M.SIDE_SLOTS} side slots</div>` +
      `<label for="insp-rack-name" class="sr-only">Rack name</label>` +
      `<input id="insp-rack-name" class="name-input" type="text" value="${esc(rack.name)}" spellcheck="false" autocomplete="off" maxlength="60">` +
      `</div>` +
      `<section class="insp-sec"><dl class="stats">` +
      `<div><dt>Used</dt><dd>${st.used} U <small>${pct}%</small></dd></div>` +
      `<div><dt>Free</dt><dd>${st.free} U</dd></div>` +
      `<div><dt>Largest free block</dt><dd>${st.largestFree} U</dd></div>` +
      `<div><dt>Side slots used</dt><dd>${st.sideUsed} / ${M.SIDE_SLOTS}</dd></div>` +
      `</dl></section>` +
      `<section class="insp-sec"><h3>Contents · top to bottom</h3>` +
      (rows ? `<ol class="contents">${rows}</ol>` : `<p class="empty-note">Empty. Drag devices from the left onto this rack.</p>`) +
      `</section>` +
      `<div class="insp-actions"><button type="button" class="btn danger-text" id="insp-clear-rack"${devs.length ? '' : ' disabled'}>${icon('trash')}Remove all devices</button></div>`;

    const input = $('#insp-rack-name');
    input.addEventListener('input', () => {
      const v = input.value;
      commit((p) => void (M.rackById(p, rack.id).name = v), { key: 'rack:' + rack.id, inspector: false });
    });
    input.addEventListener('change', () => {
      if (input.value.trim()) return;
      const i = M.rackIndex(project, rack.id);
      commit((p) => void (M.rackById(p, rack.id).name = `Rack A0${i + 1}`), { key: 'rack:' + rack.id });
    });
    $('#insp-clear-rack').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: `Empty ${rack.name}?`,
        body: `This removes all ${devs.length} devices from ${rack.name}. Undo brings them back.`,
        ok: 'Remove devices',
      });
      if (ok) commit((p) => void (p.devices = p.devices.filter((d) => d.loc.rack !== rack.id)));
    });
  }

  function renderOverview() {
    const total = project.devices.length;
    let used = 0;
    let side = 0;
    const bars = project.racks
      .map((r) => {
        const st = M.rackStats(project, r.id);
        used += st.used;
        side += st.sideUsed;
        const pct = (st.used / M.RACK_UNITS) * 100;
        return (
          `<button type="button" class="rack-bar" data-rack="${esc(r.id)}">` +
          `<span class="rb-name">${esc(r.name)}</span><span class="rb-val">${st.used}/${M.RACK_UNITS} U</span>` +
          `<span class="rb-track"><span class="rb-fill" style="width:${pct.toFixed(1)}%"></span></span></button>`
        );
      })
      .join('');
    const capacity = M.RACK_UNITS * project.racks.length;
    const typeRows = M.DEVICE_TYPES.map((t) => {
      const n = project.devices.filter((d) => d.type === t.id).length;
      return `<tr><td>${esc(t.label)}</td><td>${n}</td><td>${n * t.height}</td></tr>`;
    }).join('');

    el.inspector.innerHTML =
      `<div class="insp-head"><div class="kicker">Plan overview</div>` +
      `<p class="insp-note">Select a device, or a rack's yellow label, to edit it.</p></div>` +
      `<section class="insp-sec"><dl class="stats">` +
      `<div><dt>Devices</dt><dd>${total}</dd></div>` +
      `<div><dt>Clusters</dt><dd>${project.clusters.length}</dd></div>` +
      `<div><dt>Units used</dt><dd>${used} <small>of ${capacity}</small></dd></div>` +
      `<div><dt>Side slots</dt><dd>${side} <small>of ${M.SIDE_SLOTS * project.racks.length}</small></dd></div>` +
      `</dl></section>` +
      `<section class="insp-sec"><h3>Racks</h3><div class="rack-bars">${bars}</div></section>` +
      `<section class="insp-sec"><h3>By device type</h3>` +
      `<table class="type-table"><thead><tr><th>Type</th><th>Count</th><th>U</th></tr></thead><tbody>${typeRows}</tbody></table></section>` +
      `<section class="insp-sec keys-sec"><h3>Shortcuts</h3><dl class="keys">` +
      `<dt><kbd>Alt</kbd> + drop</dt><dd>Copy instead of move</dd>` +
      `<dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Next free position</dd>` +
      `<dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Neighbouring rack</dd>` +
      `<dt><kbd>Ctrl</kbd> <kbd>D</kbd></dt><dd>Duplicate</dd>` +
      `<dt><kbd>Del</kbd></dt><dd>Delete</dd>` +
      `<dt><kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo; add <kbd>Shift</kbd> to redo</dd>` +
      `<dt><kbd>0</kbd> <kbd>1</kbd></dt><dd>Fit sheet, 100%</dd>` +
      `<dt><kbd>Ctrl</kbd> + scroll</dt><dd>Zoom at pointer</dd>` +
      `<dt><kbd>Esc</kbd></dt><dd>Cancel or deselect</dd>` +
      `</dl></section>`;
  }

  el.inspector.addEventListener('click', (e) => {
    const sel = e.target.closest('[data-select]');
    if (sel) return selectDevice(sel.dataset.select, true);
    const bar = e.target.closest('.rack-bar');
    if (bar) selectRack(bar.dataset.rack);
  });

  // -------------------------------------------------------------- actions

  function selectDevice(id, focus) {
    ui.selection = { kind: 'device', id };
    render();
    if (focus) {
      const g = findDevEl(id);
      if (g) {
        g.focus({ preventScroll: true });
        ensureVisible(g);
      }
    }
  }

  function selectRack(id) {
    ui.selection = { kind: 'rack', id };
    render();
  }

  function clearSelection() {
    if (!ui.selection) return;
    ui.selection = null;
    render();
  }

  function selectedDevice() {
    const s = ui.selection;
    return s && s.kind === 'device' ? M.deviceById(project, s.id) : null;
  }

  function moveDevice(id, loc, opts) {
    const d = M.deviceById(project, id);
    if (!d) return false;
    const check = M.canPlace(project, d.type, loc, id);
    if (!check.ok) {
      toast(check.reason, { warn: true });
      render();
      return false;
    }
    ui.selection = { kind: 'device', id };
    const changed = commit((p) => void (M.deviceById(p, id).loc = { rack: loc.rack, kind: loc.kind, at: loc.at }));
    if (!changed) render();
    if (opts && opts.reveal) {
      const g = findDevEl(id);
      if (g) {
        g.focus({ preventScroll: true });
        ensureVisible(g);
      }
    }
    return changed;
  }

  function nudge(id, dir, reveal) {
    const d = M.deviceById(project, id);
    if (!d || d.loc.kind !== 'u') return;
    const loc = M.nudgeTarget(project, d, dir);
    if (!loc) return toast(dir > 0 ? `No free space above ${d.name}` : `No free space below ${d.name}`, { warn: true });
    moveDevice(id, loc, { reveal });
  }

  function moveToRack(id, dir) {
    const d = M.deviceById(project, id);
    if (!d) return;
    const i = M.rackIndex(project, d.loc.rack) + dir;
    if (i < 0 || i >= project.racks.length) return;
    const rack = project.racks[i];
    const same = { rack: rack.id, kind: d.loc.kind, at: d.loc.at };
    const loc = M.canPlace(project, d.type, same, id).ok
      ? same
      : M.nearestLoc(project, d.type, rack.id, d.loc.kind === 'u' ? d.loc.at : 24, id, d.loc.kind === 'side');
    if (!loc) return toast(`${rack.name} has no free space for ${d.name}`, { warn: true });
    moveDevice(id, loc, { reveal: true });
  }

  function duplicateDevice(id, at) {
    const d = M.deviceById(project, id);
    if (!d) return;
    const h = M.typeById(d.type).height;
    let loc = at || null;
    if (!loc && d.loc.kind === 'u') {
      const above = M.planPositions(project, d.type, d.loc.rack, d.loc.at + h, 1, 1);
      const below = M.planPositions(project, d.type, d.loc.rack, d.loc.at - h, 1, -1);
      const u = above.length ? above[0] : below[0];
      if (u) loc = { rack: d.loc.rack, kind: 'u', at: u };
    } else if (!loc) {
      loc = M.nearestLoc(project, d.type, d.loc.rack, M.RACK_UNITS, null, true);
    }
    if (!loc) {
      for (const r of project.racks) {
        loc = M.nearestLoc(project, d.type, r.id, d.loc.kind === 'u' ? d.loc.at : 24, null, false);
        if (loc) break;
      }
    }
    if (!loc) return toast(`No free space left for a copy of ${d.name}`, { warn: true });
    const check = M.canPlace(project, d.type, loc);
    if (!check.ok) return toast(check.reason, { warn: true });
    const copy = {
      id: M.uid('d'),
      type: d.type,
      name: M.nextFreeName(project, d.name),
      cluster: d.cluster,
      notes: d.notes || '',
      loc: { rack: loc.rack, kind: loc.kind, at: loc.at },
    };
    ui.selection = { kind: 'device', id: copy.id };
    commit((p) => void p.devices.push(copy));
    toast(`Added ${copy.name} at ${M.formatLoc(project, copy.loc, copy.type)}`);
  }

  function deleteDevice(id) {
    const d = M.deviceById(project, id);
    if (!d) return;
    ui.selection = null;
    commit((p) => void (p.devices = p.devices.filter((x) => x.id !== id)));
    toast(`Deleted ${d.name}`, { action: 'Undo', onAction: undo });
  }

  function replaceProject(next) {
    ui.selection = null;
    ui.focusCluster = null;
    ui.hoverCluster = null;
    disarm();
    return commit((p) => {
      Object.keys(p).forEach((k) => delete p[k]);
      Object.assign(p, JSON.parse(JSON.stringify(next)));
    });
  }

  function ensureVisible(node) {
    const r = node.getBoundingClientRect();
    const c = el.canvas.getBoundingClientRect();
    const m = 32;
    if (r.top < c.top + m) el.canvas.scrollTop -= c.top + m - r.top;
    else if (r.bottom > c.bottom - m) el.canvas.scrollTop += r.bottom - (c.bottom - m);
    if (r.left < c.left + m) el.canvas.scrollLeft -= c.left + m - r.left;
    else if (r.right > c.right - m) el.canvas.scrollLeft += r.right - (c.right - m);
  }

  // ------------------------------------------------------------------ zoom

  function applyZoom() {
    el.svg.setAttribute('width', Math.round(ui.sceneW * ui.zoom));
    el.svg.setAttribute('height', Math.round(ui.sceneH * ui.zoom));
    el.zoomLevel.textContent = Math.round(ui.zoom * 100) + '%';
  }

  function setZoom(z, anchor, remember) {
    const nz = clamp(Math.round(z * 1000) / 1000, 0.2, 3);
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

  function fitZoom(mode, remember) {
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

  function drawGhost(typeId, loc, ok, device) {
    const layer = ghostLayer();
    if (!layer) return;
    if (!loc) {
      layer.innerHTML = '';
      return;
    }
    const hint = device ? null : M.suggestPlacement(project, typeId, loc, 1);
    const clusterId = device ? device.cluster : hint.cluster !== undefined ? hint.cluster : prefs.lastCluster;
    const cluster = M.clusterById(project, clusterId);
    layer.innerHTML = R.renderGhost(project, typeId, loc, ok, {
      theme: ui.theme,
      measure,
      color: cluster ? cluster.color : null,
      name: device ? device.name : hint.name,
    });
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
    ui.drag = Object.assign({ pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, loc: null, ok: false, copy: false }, d);
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
      const src = findDevEl(d.deviceId);
      if (src) src.classList.toggle('is-dragging', !copy);
    }
    const c = el.canvas.getBoundingClientRect();
    const inside = e.clientX >= c.left && e.clientX <= c.right && e.clientY >= c.top && e.clientY <= c.bottom;
    if (inside) autoScroll(e);
    const pt = toScene(e);
    const loc = inside ? R.locateDrop(project, d.typeId, pt.x, pt.y, d.grab) : null;
    const check = loc ? M.canPlace(project, d.typeId, loc, d.source === 'device' && !d.copy ? d.deviceId : null) : null;
    d.loc = loc;
    d.ok = !!(check && check.ok);
    d.reason = check && !check.ok ? check.reason : '';
    const device = d.source === 'device' ? M.deviceById(project, d.deviceId) : null;
    drawGhost(d.typeId, loc, d.ok, device);
    const title = device ? (d.copy ? `Copy of ${device.name}` : device.name) : M.typeById(d.typeId).label;
    const detail = loc ? (d.ok ? M.formatLoc(project, loc, d.typeId) : d.reason) : 'Drop it on a rack';
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
    lastDragEnd = performance.now();
    if (!d.loc || !d.ok) {
      render();
      if (d.loc && d.reason) toast(d.reason, { warn: true });
      return;
    }
    if (d.source === 'palette') {
      render();
      openPlaceDialog(d.typeId, d.loc);
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

  // Parts bin: drag a part onto a rack, or click it to arm click-to-place.
  el.parts.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.part');
    if (!card || e.button !== 0 || e.pointerType === 'touch') return;
    e.preventDefault();
    const type = M.typeById(card.dataset.type);
    startDrag(e, { source: 'palette', typeId: type.id, grab: (type.height * G.U) / 2, captureEl: card });
  });
  el.parts.addEventListener('click', (e) => {
    const card = e.target.closest('.part');
    if (!card || performance.now() - lastDragEnd < 400) return;
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
    if (ui.armed) {
      if (e.pointerType === 'mouse') e.preventDefault();
      ui.press = Object.assign(press, { kind: 'armed' });
      return;
    }
    const devEl = e.target.closest('.dev');
    if (devEl) {
      const dev = M.deviceById(project, devEl.dataset.id);
      if (!dev) return;
      if (e.pointerType === 'touch') {
        ui.press = Object.assign(press, { kind: 'device', id: dev.id });
        return;
      }
      e.preventDefault();
      const pt = toScene(e);
      const r = R.locRect(project, dev.type, dev.loc);
      const h = M.typeById(dev.type).height * G.U;
      const grab = r.rotated ? h / 2 : clamp(pt.y - r.y, 0, h);
      startDrag(e, { source: 'device', deviceId: dev.id, typeId: dev.type, grab, captureEl: el.svg });
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
      startPan(e);
    } else {
      ui.press = Object.assign(press, { kind: 'bg' });
    }
  });

  el.svg.addEventListener('pointermove', (e) => {
    if (!ui.armed || ui.drag || e.pointerType === 'touch') return;
    const type = M.typeById(ui.armed);
    const pt = toScene(e);
    const loc = R.locateDrop(project, type.id, pt.x, pt.y, (type.height * G.U) / 2);
    const check = loc ? M.canPlace(project, type.id, loc) : null;
    drawGhost(type.id, loc, !!(check && check.ok), null);
    showChip(e, type.label, loc ? (check.ok ? M.formatLoc(project, loc, type.id) : check.reason) : 'Point at a rack', loc ? (check.ok ? 'ok' : 'bad') : '');
  });
  el.svg.addEventListener('pointerleave', () => {
    if (ui.armed && !ui.drag) hideDragFeedback();
  });

  function placeArmedAt(e) {
    const type = M.typeById(ui.armed);
    const pt = toScene(e);
    const loc = R.locateDrop(project, type.id, pt.x, pt.y, (type.height * G.U) / 2);
    if (!loc) return;
    const check = M.canPlace(project, type.id, loc);
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
        ui.selection = { kind: 'device', id: d.deviceId };
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
    if (ui.drag && e.pointerId === ui.drag.pointerId) return endDrag();
    const p = ui.press;
    ui.press = null;
    if (!p || p.pointerId !== e.pointerId || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) return;
    if (p.kind === 'armed') placeArmedAt(e);
    else if (p.kind === 'device') selectDevice(p.id, false);
    else if (p.kind === 'rack') selectRack(p.id);
    else if (p.kind === 'bg') clearSelection();
  });

  window.addEventListener('pointercancel', (e) => {
    if (ui.drag && e.pointerId === ui.drag.pointerId) cancelDrag();
    if (ui.pan && e.pointerId === ui.pan.pointerId) {
      ui.pan = null;
      el.canvas.classList.remove('is-panning');
    }
    ui.press = null;
  });

  // Keyboard focus on a device selects it, so Tab walks through the racks.
  el.svg.addEventListener('focusin', (e) => {
    const g = e.target.closest && e.target.closest('.dev');
    if (!g || ui.drag) return;
    const s = ui.selection;
    if (s && s.kind === 'device' && s.id === g.dataset.id) return;
    ui.selection = { kind: 'device', id: g.dataset.id };
    render();
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
    renderScene();
  });
  el.clusters.addEventListener('pointerleave', () => {
    if (!ui.hoverCluster) return;
    ui.hoverCluster = null;
    renderScene();
  });
  $('#btn-add-cluster').addEventListener('click', () => openClusterDialog(null));

  // --------------------------------------------------------------- dialogs

  function openDialog(dlg) {
    closeMenus();
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
    const type = M.typeById(typeId);
    Object.assign(place, { typeId, loc, nameTouched: false, positions: [], valid: true });
    $('#place-title').textContent = type.label;
    $('#place-where').textContent = `${M.formatLoc(project, loc, typeId)} · ${type.spec}`;
    $('#place-multi').hidden = loc.kind !== 'u';
    $('#place-qty').value = '1';
    $('input[name="place-dir"][value="up"]').checked = true;
    const hint = M.suggestPlacement(project, typeId, loc, 1);
    const last = prefs.lastCluster && M.clusterById(project, prefs.lastCluster) ? prefs.lastCluster : null;
    const initial = hint.cluster !== undefined ? hint.cluster : last || (project.clusters.length ? null : '__new');
    $('#place-clusters').innerHTML = clusterChips('place-cluster', initial, true);
    place.newColor = M.nextClusterColor(project);
    $('#place-new-name').value = M.nextClusterName(project);
    renderSwatches($('#place-new-colors'), 'place-new-color', place.newColor, (c) => (place.newColor = c));
    $('#place-new').hidden = initial !== '__new';
    showError('#place-error', '');
    updatePlacePreview();
    openDialog($('#dlg-place'));
    const name = $('#place-name');
    name.focus();
    name.select();
  }

  function updatePlacePreview() {
    const type = M.typeById(place.typeId);
    const qtyInput = $('#place-qty');
    let qty = parseInt(qtyInput.value, 10);
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    const dir = $('input[name="place-dir"]:checked').value === 'down' ? -1 : 1;
    const nameInput = $('#place-name');
    if (!place.nameTouched) nameInput.value = M.suggestPlacement(project, type.id, place.loc, qty).name;
    const line = $('#place-preview');
    const submit = $('#place-submit');
    line.classList.remove('bad');
    line.textContent = '';
    place.valid = true;
    if (place.loc.kind !== 'u') {
      line.hidden = true;
      place.positions = [place.loc.at];
      submit.textContent = 'Place';
      submit.disabled = false;
      return;
    }
    const max = M.planPositions(project, type.id, place.loc.rack, place.loc.at, Infinity, dir).length;
    qtyInput.max = String(Math.max(1, max));
    place.positions = M.planPositions(project, type.id, place.loc.rack, place.loc.at, qty, dir);
    if (place.positions.length < qty) {
      place.valid = false;
      line.classList.add('bad');
      line.textContent = `Only ${max} fit ${dir > 0 ? 'upward' : 'downward'} from U${place.loc.at} in this rack.`;
    } else if (qty > 1) {
      const names = M.nameSequence(nameInput.value.trim(), qty);
      const lo = Math.min(...place.positions);
      const hi = Math.max(...place.positions) + type.height - 1;
      line.textContent = `${names[0]} … ${names[qty - 1]} · ${M.formatSpan(lo, hi)}`;
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
    const type = M.typeById(place.typeId);
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
    const ids = names.map(() => M.uid('d'));
    const loc = place.loc;
    ui.selection = { kind: 'device', id: ids[0] };
    commit((p) => {
      if (newCluster) p.clusters.push(newCluster);
      place.positions.forEach((at, i) =>
        p.devices.push({
          id: ids[i],
          type: type.id,
          name: names[i],
          cluster: clusterId,
          notes: '',
          loc: loc.kind === 'u' ? { rack: loc.rack, kind: 'u', at } : { rack: loc.rack, kind: loc.kind, at: loc.at },
        })
      );
    });
    prefs.lastCluster = clusterId;
    savePrefs();
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
    const count = c ? project.devices.filter((d) => d.cluster === c.id).length : 0;
    $('#cluster-kicker').textContent = c ? 'Edit cluster' : 'New cluster';
    $('#cluster-title').textContent = c ? c.name : 'Create a cluster';
    $('#cluster-name').value = c ? c.name : M.nextClusterName(project);
    $('#cluster-delete').hidden = !c;
    $('#cluster-submit').textContent = c ? 'Save' : 'Create';
    $('#cluster-delete').dataset.count = String(count);
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
    const pv = R.renderPreview('compute-node', ui.theme, clusterDlg.color, `${sample}-01`);
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
        body: `Its ${count} device${count === 1 ? '' : 's'} stay in place but lose their cluster color. Undo brings the cluster back.`,
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

  // Confirm dialog -----------------------------------------------------

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

  // Open dialog --------------------------------------------------------

  $('#btn-open').addEventListener('click', () => {
    $('#open-text').value = '';
    showError('#open-error', '');
    openDialog($('#dlg-open'));
  });
  $('#open-file').addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', async () => {
    const file = el.fileInput.files && el.fileInput.files[0];
    el.fileInput.value = '';
    if (!file) return;
    try {
      openPlanText(await file.text());
    } catch (err) {
      showError('#open-error', `Could not read ${file.name}.`);
    }
  });
  $('#open-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#open-text').value.trim();
    if (!text) return showError('#open-error', 'Paste a plan first, or choose a file.');
    openPlanText(text);
  });

  function openPlanText(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return showError('#open-error', 'That is not valid JSON. Check that the whole plan was copied.');
    }
    let result;
    try {
      result = M.normalizeProject(raw);
    } catch (e) {
      return showError('#open-error', e.message);
    }
    replaceProject(result.project);
    $('#dlg-open').close('ok');
    const skipped = result.warnings.length;
    if (skipped) console.warn('Rackplanner import:', result.warnings);
    toast(
      `Opened ${result.project.name}: ${result.project.devices.length} devices` + (skipped ? `, ${skipped} skipped (see console)` : ''),
      { warn: skipped > 0, action: 'Undo', onAction: undo }
    );
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
    const first = menu.querySelector('button');
    if (first) first.focus();
  }

  [
    ['#btn-export', '#menu-export'],
    ['#btn-new', '#menu-new'],
  ].forEach(([b, m]) => {
    const btn = $(b);
    const menu = $(m);
    btn.addEventListener('click', () => toggleMenu(btn, menu));
    menu.addEventListener('keydown', (e) => {
      const items = $$('button', menu);
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
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

  $('#menu-new').addEventListener('click', async (e) => {
    const item = e.target.closest('[data-new]');
    if (!item) return;
    closeMenus();
    const example = item.dataset.new === 'example';
    if (project.devices.length && !(project.meta && project.meta.example)) {
      const ok = await confirmDialog({
        title: example ? 'Load the example plan?' : 'Start with empty racks?',
        body: `This replaces “${project.name}”. Undo brings it back, or export it first to keep a copy.`,
        ok: example ? 'Load example' : 'Start empty',
      });
      if (!ok) return;
    }
    startNew(example);
  });

  function startNew(example) {
    const next = example ? M.createExampleProject() : M.createEmptyProject();
    if (!example) next.name = 'Untitled rack plan';
    replaceProject(next);
    toast(example ? 'Loaded the example plan' : 'Started an empty plan', { action: 'Undo', onAction: undo });
  }

  $('#btn-start-empty').addEventListener('click', () => startNew(false));
  $('#btn-keep-example').addEventListener('click', () => {
    delete project.meta.example;
    persist();
    renderChrome();
  });

  // --------------------------------------------------------------- export

  function fileBase() {
    const slug = (project.name || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .slice(0, 60);
    return slug || 'rack-plan';
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

  function renderPNG(scale) {
    const svg = R.exportSVG(project, { measure, date: todayISO() });
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

  function copyJSON() {
    const text = M.serialize(project);
    const fallback = () => {
      const ta = $('#copy-text');
      ta.value = text;
      openDialog($('#dlg-copy'));
      ta.focus();
      ta.select();
    };
    try {
      navigator.clipboard.writeText(text).then(() => toast('Plan copied as JSON'), fallback);
    } catch (e) {
      fallback();
    }
  }

  async function doExport(kind) {
    const base = fileBase();
    try {
      if (kind === 'copy') return copyJSON();
      if (kind === 'json') download(`${base}.json`, new Blob([M.serialize(project)], { type: 'application/json' }));
      else if (kind === 'csv') download(`${base}.csv`, new Blob(['﻿' + M.toCSV(project)], { type: 'text/csv;charset=utf-8' }));
      else if (kind === 'svg') download(`${base}.svg`, new Blob([R.exportSVG(project, { measure, date: todayISO() })], { type: 'image/svg+xml' }));
      else if (kind === 'png') download(`${base}.png`, await renderPNG(2));
      toast(`Exported ${base}.${kind}`);
    } catch (err) {
      toast(`Export failed: ${err.message}`, { warn: true });
    }
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
    timer = setTimeout(dismiss, o.action ? 6000 : 3200);
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
    commit((p) => void (p.name = v), { key: 'plan-name' });
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
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;

    if (mod && !e.altKey && (key === 'z' || key === 'Z')) {
      if (typing) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && (key === 'y' || key === 'Y')) {
      if (typing) return;
      e.preventDefault();
      redo();
      return;
    }
    if (typing) {
      if (key === 'Escape' || (key === 'Enter' && t.tagName === 'INPUT')) t.blur();
      return;
    }
    if (t.closest && t.closest('.menu')) return;

    if (key === 'Escape') {
      if (ui.drag) cancelDrag();
      else if (ui.armed) disarm();
      else if (!$$('.menu').every((m) => m.hidden)) closeMenus();
      else if (ui.selection) clearSelection();
      else if (ui.focusCluster) {
        ui.focusCluster = null;
        render({ inspector: false });
      }
      return;
    }

    const d = selectedDevice();
    if (d && !mod) {
      if (key === 'Delete' || key === 'Backspace') {
        e.preventDefault();
        return deleteDevice(d.id);
      }
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        e.preventDefault();
        return nudge(d.id, key === 'ArrowUp' ? 1 : -1, true);
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        e.preventDefault();
        return moveToRack(d.id, key === 'ArrowLeft' ? -1 : 1);
      }
      if (key === 'Enter' || key === 'F2') {
        e.preventDefault();
        const input = $('#insp-name');
        if (input) {
          input.focus();
          input.select();
        }
        return;
      }
    }
    if (d && mod && (key === 'd' || key === 'D')) {
      e.preventDefault();
      return duplicateDevice(d.id);
    }
    if (mod || e.altKey) return;
    if (key === '+' || key === '=') setZoom(ui.zoom * 1.2);
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
      renderScene();
    };
    const faces = Object.values(R.FONTS).map((f) => f.css);
    Promise.all(faces.map((f) => document.fonts.load(f).catch(() => null))).then(remeasure);
    if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', remeasure);
  }

  window.addEventListener('pagehide', flushPersist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersist();
  });

  // ----------------------------------------------------------------- boot

  render();
  if (prefs.zoom) setZoom(prefs.zoom, null, false);
  else {
    fitZoom('width', false);
    if (ui.zoom < 0.5) setZoom(0.5, null, false);
  }
  el.canvas.scrollTop = 0;
  el.canvas.scrollLeft = 0;
})();
