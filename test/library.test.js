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
  const id = lib.migrate();
  assert.ok(id);
  assert.equal(lib.current(), id);
  assert.equal(lib.load(id).project.name, 'Old hall');
  assert.equal(lib.load(id).project.devices[0].loc.at, 3);
  assert.equal(store.get(Library.LEGACY_KEY), null, 'the old key is cleaned up');
  assert.equal(lib.migrate(), null, 'only once');
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
