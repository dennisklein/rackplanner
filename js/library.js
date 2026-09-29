/*
 * Rackplanner: plans saved in the browser.
 *
 * Keeps several plans in a key-value store (localStorage in the browser, a
 * Map in the tests): an index with one entry per plan, and each plan under
 * its own key. The plan in use is the index's `current`.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'), require('./io.js'));
  else (root.RP = root.RP || {}).library = factory(root.RP.model, root.RP.io);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M, IO) {
  'use strict';

  const INDEX_KEY = 'rackplanner.library.v1';
  const LEGACY_KEY = 'rackplanner.plan.v1';
  const planKey = (id) => `rackplanner.plan.${id}`;

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
   * when the store is full) and remove(key).
   */
  function create(store) {
    function readIndex() {
      try {
        const raw = JSON.parse(store.get(INDEX_KEY) || 'null');
        if (raw && Array.isArray(raw.plans)) {
          return { current: typeof raw.current === 'string' ? raw.current : null, plans: raw.plans.filter((p) => p && typeof p.id === 'string') };
        }
      } catch (e) {
        /* a broken index is rebuilt below */
      }
      return { current: null, plans: [] };
    }
    const writeIndex = (index) => store.set(INDEX_KEY, JSON.stringify(index));

    /** Plans, most recently edited first. */
    function list() {
      return readIndex().plans.slice().sort((a, b) => b.updated - a.updated);
    }

    function load(id) {
      const text = store.get(planKey(id));
      if (!text) return null;
      try {
        return IO.normalizeProject(JSON.parse(text));
      } catch (e) {
        return null;
      }
    }

    /** Saves a plan and updates its index entry. False when the store is full. */
    function save(id, project, opts) {
      if (!store.set(planKey(id), IO.serialize(project, { compact: true }))) return false;
      // Re-read the index so edits from another tab aren't lost.
      const index = readIndex();
      const entry = Object.assign({ id, created: Date.now() }, index.plans.find((p) => p.id === id), summary(project), { updated: (opts && opts.at) || Date.now() });
      index.plans = index.plans.filter((p) => p.id !== id).concat([entry]);
      return writeIndex(index);
    }

    /** Adds a plan and returns its id, or null when the store is full. */
    function add(project) {
      const id = M.uid('p');
      if (!save(id, project)) {
        store.remove(planKey(id));
        return null;
      }
      return id;
    }

    function remove(id) {
      const index = readIndex();
      index.plans = index.plans.filter((p) => p.id !== id);
      if (index.current === id) index.current = null;
      writeIndex(index);
      store.remove(planKey(id));
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

    /** Moves a plan saved by an earlier version (a single plan) into the library. */
    function migrate() {
      if (store.get(INDEX_KEY)) return null;
      const text = store.get(LEGACY_KEY);
      if (!text) return null;
      let project;
      try {
        project = IO.normalizeProject(JSON.parse(text)).project;
      } catch (e) {
        return null;
      }
      const id = add(project);
      if (id) {
        setCurrent(id);
        store.remove(LEGACY_KEY);
      }
      return id;
    }

    return { list, load, save, add, remove, current, setCurrent, migrate };
  }

  return { create, summary, INDEX_KEY, LEGACY_KEY, planKey };
});
