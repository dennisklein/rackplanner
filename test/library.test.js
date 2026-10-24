'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');
const IO = require('../js/io.js');
const Library = require('../js/library.js');

function memoryStore(limit) {
  const map = new Map();
  return {
    map,
    get: (k) => (map.has(k) ? map.get(k) : null),
    set(k, v) {
      const size = [...map].reduce((a, [key, val]) => a + (key === k ? 0 : val.length), 0) + v.length;
      if (limit && size > limit) return false;
      map.set(k, v);
      return true;
    },
    remove: (k) => map.delete(k),
    keys: () => [...map.keys()],
  };
}

test('plans are saved, listed, loaded and removed', () => {
  const store = memoryStore();
  const lib = Library.create(store);
  const a = lib.add(M.createExampleProject());
  const empty = M.createEmptyProject();
  empty.name = 'Empty';
  const b = lib.add(empty);
  lib.setCurrent(b);
  assert.equal(lib.current(), b);
  assert.deepEqual(lib.list().map((p) => p.name).sort(), ['Empty', 'Hall 2 expansion']);
  const entry = lib.list().find((p) => p.id === a);
  assert.deepEqual([entry.floors, entry.racks, entry.devices], [2, 8, 65]);
  assert.deepEqual(lib.load(a).project, M.createExampleProject());

  empty.name = 'Renamed';
  lib.save(b, empty, { at: Date.now() + 1000 });
  assert.equal(lib.list()[0].name, 'Renamed', 'most recently edited first');
  lib.remove(b);
  assert.equal(lib.current(), null, 'the removed plan is no longer current');
  assert.equal(store.get(Library.planKey(b)), null);
  assert.equal(lib.load(b), null);
});

test('a plan saved by the single-plan version moves into the library', () => {
  const store = memoryStore();
  const old = { version: 2, name: 'Old hall', racks: [{ id: 'r1', name: 'A' }], devices: [{ id: 'x', type: 'compute-node', name: 'cn-1', loc: { rack: 'r1', kind: 'u', at: 3 } }] };
  store.set(Library.LEGACY_KEY, JSON.stringify(old));
  const lib = Library.create(store);
  const moved = lib.migrate();
  const id = moved.id;
  assert.ok(id);
  assert.deepEqual(moved.warnings, []);
  assert.equal(lib.current(), id);
  assert.equal(lib.load(id).project.name, 'Old hall');
  assert.equal(lib.load(id).project.devices[0].loc.at, 3);
  assert.equal(lib.load(id).backup, false, 'the plan is saved as this version writes it');
  assert.equal(store.get(Library.LEGACY_KEY), null, 'the old key is cleaned up');
  assert.equal(store.get(Library.backupKey(id)), JSON.stringify(old), 'the plan as the old version saved it is kept');
  assert.equal(lib.migrate(), null, 'only once');
  lib.remove(id);
  assert.equal(store.get(Library.backupKey(id)), null, 'the backup goes with its plan');
});

test('a single plan that needed fixing says what was fixed when it moves into the library', () => {
  const store = memoryStore();
  const old = { version: 3, name: 'Old hall', racks: [{ id: 'r1', name: 'A' }], devices: [{ id: 'x', type: 'nope', name: 'ghost', loc: { rack: 'r1', kind: 'u', at: 3 } }] };
  store.set(Library.LEGACY_KEY, JSON.stringify(old));
  const moved = Library.create(store).migrate();
  assert.deepEqual(moved.warnings, ['Skipped ghost: unknown device type “nope”.']);
  assert.equal(store.get(Library.backupKey(moved.id)), JSON.stringify(old));
});

test('a stored plan that needed fixing or has another version is kept as a backup before it is saved over', () => {
  const store = memoryStore();
  const lib = Library.create(store);
  const id = lib.add(M.createEmptyProject());
  const fresh = lib.load(id);
  assert.deepEqual([fresh.warnings, fresh.backup], [[], false], 'a plan this version saved needs no backup');

  const raw = JSON.parse(store.get(Library.planKey(id)));
  const rack = raw.floors[0].rows[0].racks[0].id;
  raw.devices.push({ id: 'x1', type: 'nope', name: 'ghost', loc: { rack, kind: 'u', at: 3 } });
  const broken = JSON.stringify(raw);
  store.set(Library.planKey(id), broken);
  const loaded = lib.load(id);
  assert.deepEqual(loaded.warnings, ['Skipped ghost: unknown device type “nope”.']);
  assert.equal(loaded.backup, true);
  assert.ok(lib.backup(id));
  assert.ok(lib.save(id, loaded.project));
  assert.equal(store.get(Library.backupKey(id)), broken);
  assert.deepEqual([lib.load(id).warnings, lib.load(id).backup], [[], false]);

  // A plan of an earlier version loads without warnings, but is kept all the same.
  const older = JSON.stringify(Object.assign(JSON.parse(store.get(Library.planKey(id))), { version: 4 }));
  store.set(Library.planKey(id), older);
  assert.equal(lib.load(id).backup, true);
  assert.ok(lib.backup(id));
  assert.equal(store.get(Library.backupKey(id)), older, 'one backup per plan, the latest');
  assert.equal(lib.backup('p-missing'), false);

  lib.remove(id);
  assert.equal(store.get(Library.backupKey(id)), null, 'the backup goes with its plan');
});

test('a stored plan with warnings that change nothing needs no backup', () => {
  const store = memoryStore();
  const lib = Library.create(store);
  const p = M.createExampleProject();
  p.floors[0].rows[1].name = 'row a';
  const id = lib.add(p);
  const loaded = lib.load(id);
  assert.deepEqual(loaded.warnings, ['Two rows on Ground floor are named row a: rename one, as CSV files tell them apart by name.']);
  assert.equal(loaded.backup, false, 'saving it gives the text it has');
});

test('a full store refuses the save instead of losing the index', () => {
  const store = memoryStore(12000);
  const lib = Library.create(store);
  const small = M.createEmptyProject(1);
  // An empty plan fits the store with room to spare; the example does not.
  assert.ok(IO.serialize(small, { compact: true }).length < 6000);
  assert.ok(IO.serialize(M.createExampleProject(), { compact: true }).length > 12000);
  const id = lib.add(small);
  assert.ok(id);
  assert.equal(lib.add(M.createExampleProject()), null, 'too big for the store');
  assert.deepEqual(lib.list().map((p) => p.id), [id]);
  assert.ok(IO.normalizeProject(JSON.parse(store.get(Library.planKey(id)))).project);
});

test('each save counts up the revision of its plan', () => {
  const lib = Library.create(memoryStore());
  const id = lib.add(M.createEmptyProject());
  assert.equal(lib.rev(id), 1);
  const p = lib.load(id).project;
  p.name = 'Hall 3';
  assert.ok(lib.save(id, p));
  assert.equal(lib.rev(id), 2);
  assert.equal(lib.list()[0].name, 'Hall 3');
  assert.equal(lib.rev('p-missing'), 0);
  lib.remove(id);
  assert.equal(lib.rev(id), 0);
});

test('a plan name taken by another plan gets the first free number', () => {
  const lib = Library.create(memoryStore());
  const p = M.createEmptyProject();
  p.name = 'Hall 2';
  assert.equal(lib.uniqueName('Hall 2'), 'Hall 2');
  const a = lib.add(p);
  assert.equal(lib.uniqueName('Hall 2'), 'Hall 2 (2)');
  assert.equal(lib.uniqueName('Hall 2', a), 'Hall 2', 'its own name is free');
  p.name = 'Hall 2 (2)';
  lib.add(p);
  assert.equal(lib.uniqueName('Hall 2'), 'Hall 2 (3)');
  assert.equal(lib.uniqueName('Hall 2 (2)'), 'Hall 2 (3)');
});

test('a plan added from a share link keeps its source through later saves', () => {
  const lib = Library.create(memoryStore());
  const p = M.createEmptyProject();
  const id = lib.add(p, { source: 'abc123' });
  p.name = 'Renamed';
  lib.save(id, p);
  assert.equal(lib.list().find((x) => x.id === id).source, 'abc123');
  const other = lib.add(p);
  assert.equal(lib.list().find((x) => x.id === other).source, undefined);
});

test('a lost or unreadable index is made again from the plans in the store', () => {
  const store = memoryStore();
  const lib = Library.create(store);
  const a = lib.add(M.createExampleProject());
  const empty = M.createEmptyProject();
  empty.name = 'Empty';
  const b = lib.add(empty);
  store.set(Library.planKey('p-broken'), '{"name": "Cut');
  store.set(Library.LEGACY_KEY, JSON.stringify(M.createEmptyProject()));

  for (const broken of ['{"plans": [', JSON.stringify({ current: a, plans: 'all' }), null]) {
    if (broken === null) store.remove(Library.INDEX_KEY);
    else store.set(Library.INDEX_KEY, broken);
    const plans = lib.list();
    assert.deepEqual(plans.map((p) => p.id).sort(), [a, b, 'p-broken'].sort(), 'the old single plan is not one of them');
    const byId = Object.fromEntries(plans.map((p) => [p.id, p]));
    assert.equal(byId[a].name, 'Hall 2 expansion');
    assert.deepEqual([byId[a].floors, byId[a].racks, byId[a].devices], [2, 8, 65]);
    assert.equal(byId[b].name, 'Empty');
    assert.equal(byId['p-broken'].name, 'Recovered plan', 'a plan that cannot be read gets a name all the same');
    assert.equal(lib.current(), null);
    const index = JSON.parse(store.get(Library.INDEX_KEY));
    assert.equal(index.version, Library.INDEX_VERSION, 'the index made again is written back');
    assert.equal(index.plans.length, 3);
  }
  assert.ok(lib.save(b, empty));
  assert.equal(lib.rev(b), 2);
  assert.ok(lib.remove('p-broken'));
  assert.deepEqual(lib.list().map((p) => p.id).sort(), [a, b].sort());
});

test('an index without a version is read, and one of a later version is never written over', () => {
  const store = memoryStore();
  const lib = Library.create(store);
  const id = lib.add(M.createEmptyProject());
  const index = JSON.parse(store.get(Library.INDEX_KEY));
  assert.equal(index.version, 1);
  delete index.version;
  store.set(Library.INDEX_KEY, JSON.stringify(index));
  assert.deepEqual(lib.list().map((p) => p.id), [id]);
  assert.ok(lib.save(id, M.createEmptyProject()));
  assert.equal(JSON.parse(store.get(Library.INDEX_KEY)).version, 1);

  const newer = JSON.stringify(Object.assign(JSON.parse(store.get(Library.INDEX_KEY)), { version: 2 }));
  store.set(Library.INDEX_KEY, newer);
  const planText = store.get(Library.planKey(id));
  assert.deepEqual(lib.list().map((p) => p.id), [id], 'its list is still shown');
  const p = M.createEmptyProject();
  p.name = 'Changed';
  assert.equal(lib.save(id, p), false);
  assert.equal(lib.add(p), null);
  assert.equal(lib.remove(id), false);
  lib.setCurrent(null);
  assert.equal(store.get(Library.INDEX_KEY), newer);
  assert.equal(store.get(Library.planKey(id)), planText);
  assert.equal(store.map.size, 2, 'no plan is added');

  // Nor is a later index that this version cannot read.
  store.set(Library.INDEX_KEY, JSON.stringify({ version: 2, plans: { [id]: {} } }));
  assert.deepEqual(lib.list().map((x) => x.id), [id]);
  assert.equal(JSON.parse(store.get(Library.INDEX_KEY)).version, 2);
});

test('each save notes the size of its plan, and usage counts what the app keeps in the store', () => {
  const store = memoryStore();
  const lib = Library.create(store);
  const p = M.createExampleProject();
  const id = lib.add(p);
  const size = IO.serialize(p, { compact: true }).length;
  assert.equal(lib.list()[0].size, size);
  store.set('other.app', 'x'.repeat(1000));
  store.set(Library.LEGACY_KEY, 'x'.repeat(10));
  const use = lib.usage();
  assert.deepEqual(use.plans, { [id]: size }, 'the old single plan is not one of them');
  const keys = [Library.planKey(id), Library.INDEX_KEY, Library.LEGACY_KEY];
  assert.equal(use.total, keys.reduce((a, k) => a + k.length + store.get(k).length, 0), 'keys of other apps do not count');
  // An older version deletes a plan but not its backup: the backup goes too.
  store.set(Library.backupKey(id), 'x'.repeat(10));
  store.set(Library.backupKey('p-gone'), 'x'.repeat(10));
  lib.usage();
  assert.equal(store.get(Library.backupKey('p-gone')), null);
  assert.equal(store.get(Library.backupKey(id)), 'x'.repeat(10), 'a backup of a plan that is there stays');
});

test('a plan a newer version saved is never saved over', () => {
  const store = memoryStore();
  const lib = Library.create(store);
  const id = lib.add(M.createEmptyProject());
  assert.equal(lib.list()[0].version, M.SCHEMA_VERSION, 'each entry keeps the version its plan was saved in');
  assert.equal(lib.newer(id), false);
  // A newer Rackplanner saves the plan, in another tab.
  const key = Library.planKey(id);
  const text = store.get(key).replace(`"version":${M.SCHEMA_VERSION},`, `"version":${M.SCHEMA_VERSION + 1},"pdus":[],`);
  store.set(key, text);
  const index = JSON.parse(store.get(Library.INDEX_KEY));
  index.plans[0].version = M.SCHEMA_VERSION + 1;
  store.set(Library.INDEX_KEY, JSON.stringify(index));
  assert.equal(lib.newer(id), true);
  assert.equal(lib.save(id, M.createExampleProject()), false);
  assert.equal(store.get(key), text, 'the newer plan stays as it was');
  // An entry from before entries kept the version: the plan says it.
  delete index.plans[0].version;
  store.set(Library.INDEX_KEY, JSON.stringify(index));
  assert.equal(lib.newer(id), true);
  assert.equal(lib.save(id, M.createExampleProject()), false);
  assert.equal(store.get(key), text);
  // An index a newer version wrote refuses every save, and says so.
  const other = lib.add(M.createEmptyProject());
  assert.equal(lib.newer(other), false);
  store.set(Library.INDEX_KEY, JSON.stringify(Object.assign(JSON.parse(store.get(Library.INDEX_KEY)), { version: Library.INDEX_VERSION + 1 })));
  assert.equal(lib.newer(other), true);
  assert.equal(lib.save(other, M.createExampleProject()), false);
});
