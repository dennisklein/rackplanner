/*
 * Rackplanner: plans saved in the browser.
 *
 * Keeps several plans in a key-value store (localStorage in the browser, a
 * Map in the tests): an index with one entry per plan, and each plan under
 * its own key. The plan in use is the index's `current`. Each entry counts
 * the saves of its plan in `rev`, so that a browser tab can tell when
 * another one saved the plan it has open. An index that is lost or cannot
 * be read is made again from the plans in the store. A plan that reading
 * changed, or that an earlier version saved, keeps the text it had under a
 * backup key when it is first saved over.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'), require('./io.js'));
  else (root.RP = root.RP || {}).library = factory(root.RP.model, root.RP.io);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M, IO) {
  'use strict';

  const INDEX_KEY = 'rackplanner.library.v1';
  // The shape of the index; one without a version is version 1. An index of a later version is never written over.
  const INDEX_VERSION = 1;
  const LEGACY_KEY = 'rackplanner.plan.v1';
  const PLAN_PREFIX = 'rackplanner.plan.';
  const planKey = (id) => PLAN_PREFIX + id;
  // One backup per plan, removed with it.
  const backupKey = (id) => `rackplanner.backup.${id}`;
  // A plan whose index entry is lost gets this name when the plan itself cannot be read.
  const RECOVERED_NAME = 'Recovered plan';

  /** Summary shown in the plan list. */
  function summary(project) {
    return {
      name: project.name,
      floors: project.floors.length,
      racks: M.allRacks(project).length,
      devices: project.devices.length,
    };
  }

  /**
   * `store` needs get(key) → string|null, set(key, value) → boolean (false
   * when the store is full), remove(key) and keys() → every key it holds
   * (without keys() a lost index cannot be made again).
   */
  function create(store) {
    const keys = () => (typeof store.keys === 'function' ? store.keys() : []);

    function storedIndex() {
      try {
        return JSON.parse(store.get(INDEX_KEY) || 'null');
      } catch (e) {
        return null;
      }
    }
    function readIndex() {
      const raw = storedIndex();
      if (raw && Array.isArray(raw.plans)) {
        return { current: typeof raw.current === 'string' ? raw.current : null, plans: raw.plans.filter((p) => p && typeof p.id === 'string') };
      }
      return rebuildIndex();
    }
    /**
     * An index made from the plans in the store, for one that is lost or
     * cannot be read. It is written back when it found plans; their times
     * are unknown, so they count as edited at 0.
     */
    function rebuildIndex() {
      const plans = [];
      for (const key of keys()) {
        if (!key.startsWith(PLAN_PREFIX) || key === LEGACY_KEY) continue;
        const id = key.slice(PLAN_PREFIX.length);
        const loaded = load(id);
        plans.push(Object.assign({ id, created: 0, updated: 0, rev: 1 }, loaded ? summary(loaded.project) : { name: RECOVERED_NAME }));
      }
      const index = { current: null, plans };
      if (plans.length) writeIndex(index);
      return index;
    }
    /** True when the store holds an index of a later version, which this version leaves alone. */
    function newerIndex() {
      const raw = storedIndex();
      return !!raw && Number(raw.version) > INDEX_VERSION;
    }
    const writeIndex = (index) => !newerIndex() && store.set(INDEX_KEY, JSON.stringify(Object.assign({ version: INDEX_VERSION }, index)));

    /** Plans, most recently edited first. */
    function list() {
      return readIndex().plans.slice().sort((a, b) => b.updated - a.updated);
    }

    /**
     * Reads plan `id`: { project, warnings, backup }, or null when it cannot
     * be read. `backup` is true when reading changed the plan or it has
     * another version than this one writes: saving over it may lose what it
     * had, so backup() keeps it first. Warnings that change nothing, such as
     * two rows of one name, need no backup.
     */
    function load(id) {
      const text = store.get(planKey(id));
      if (!text) return null;
      try {
        const raw = JSON.parse(text);
        const loaded = IO.normalizeProject(raw);
        return Object.assign(loaded, { backup: needsBackup(raw, text, loaded.project) });
      } catch (e) {
        return null;
      }
    }
    // Saved again, a plan this version wrote and read without a change gives the same text.
    const needsBackup = (raw, text, project) => Number(raw.version) !== M.SCHEMA_VERSION || IO.serialize(project, { compact: true }) !== text;

    /** Keeps plan `id` as it is stored under its backup key, in place of an older backup. False when the store is full. */
    function backup(id) {
      const text = store.get(planKey(id));
      return !!text && store.set(backupKey(id), text);
    }

    /**
     * Saves a plan and updates its index entry, counting up its revision.
     * `opts.source` marks where it came from (a share link). False when the
     * store is full.
     */
    function save(id, project, opts) {
      if (newerIndex()) return false;
      // Re-read the index so edits from another tab aren't lost. Read before the plan is written, so a lost index made again does not list it yet.
      const index = readIndex();
      if (!store.set(planKey(id), IO.serialize(project, { compact: true }))) return false;
      const old = index.plans.find((p) => p.id === id);
      const o = opts || {};
      const entry = Object.assign({ id, created: Date.now() }, old, summary(project), { updated: o.at || Date.now(), rev: ((old && old.rev) || 0) + 1 }, o.source ? { source: o.source } : null);
      index.plans = index.plans.filter((p) => p.id !== id).concat([entry]);
      return writeIndex(index);
    }

    /** The revision of plan `id`: how many times it was saved, by any tab. 0 for a plan not in the list. */
    function rev(id) {
      const entry = readIndex().plans.find((p) => p.id === id);
      return (entry && entry.rev) || 0;
    }

    /** `name`, or with the first free number, as in 'Hall 2 (2)', when another plan than `except` has it. */
    function uniqueName(name, except) {
      const taken = new Set(readIndex().plans.filter((p) => p.id !== except).map((p) => p.name));
      if (!taken.has(name)) return name;
      const base = name.replace(/ \(\d+\)$/, '');
      for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
    }

    /** Adds a plan (with `opts` as for save) and returns its id, or null when the store is full. */
    function add(project, opts) {
      const id = M.uid('p');
      if (!save(id, project, opts)) {
        store.remove(planKey(id));
        return null;
      }
      return id;
    }

    /** Removes a plan. False when the index could not be written, and the plan stays. */
    function remove(id) {
      const index = readIndex();
      index.plans = index.plans.filter((p) => p.id !== id);
      if (index.current === id) index.current = null;
      if (!writeIndex(index)) return false;
      store.remove(planKey(id));
      store.remove(backupKey(id));
      return true;
    }

    function current() {
      const index = readIndex();
      return index.plans.some((p) => p.id === index.current) ? index.current : null;
    }
    function setCurrent(id) {
      const index = readIndex();
      index.current = id;
      writeIndex(index);
    }

    /**
     * Moves a plan saved by an earlier version (a single plan) into the
     * library: { id, warnings, backup } with what needed fixing, or null.
     * The plan as it was saved becomes its backup (`backup` true) when
     * reading changed it or it has another version.
     */
    function migrate() {
      if (store.get(INDEX_KEY)) return null;
      const text = store.get(LEGACY_KEY);
      if (!text) return null;
      let raw, loaded;
      try {
        raw = JSON.parse(text);
        loaded = IO.normalizeProject(raw);
      } catch (e) {
        return null;
      }
      const id = add(loaded.project);
      if (!id) return null;
      setCurrent(id);
      const backup = needsBackup(raw, text, loaded.project);
      if (backup) store.set(backupKey(id), text);
      store.remove(LEGACY_KEY);
      return { id, warnings: loaded.warnings, backup };
    }

    return { list, load, backup, save, rev, uniqueName, add, remove, current, setCurrent, migrate };
  }

  return { create, summary, INDEX_KEY, INDEX_VERSION, LEGACY_KEY, planKey, backupKey };
});
