'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');
const C = require('../js/cabling.js');
const R = require('../js/render.js');
const CR = require('../js/cabling-render.js');
const { assertWellFormed } = require('./xml.js');

const wrap = (out) => `<svg xmlns="http://www.w3.org/2000/svg" width="${out.width}" height="${out.height}">${out.body}</svg>`;
const count = (s, needle) => s.split(needle).length - 1;
const byName = (p, name) => p.devices.find((d) => d.name === name);
const flip = (s) => (s === 'front' ? 'rear' : 'front');

/** The port groups of a drawing in document order: { port, rects, shape (the first rect), hit }. */
function portGroups(body) {
  return [...body.matchAll(/<g class="port" data-port="([^"]+)">(.*?)<\/g>/g)].map(([, port, inner]) => {
    const rects = [...inner.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"([^>]*)\/>/g)].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], hit: m[5].includes('fill-opacity="0"') }));
    return { port, rects, shape: rects[0], hit: rects.find((r) => r.hit) };
  });
}
const inside = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const contains = (a, b) => a.x <= b.x + 0.05 && a.y <= b.y + 0.05 && a.x + a.w >= b.x + b.w - 0.05 && a.y + a.h >= b.y + b.h - 0.05;

/**
 * Ports whose drawn shape a click can miss: for points on a grid over each
 * port's shape, the last element in document order under the point (shape
 * or hit area of any port of the same device) must be that port's.
 */
function misclicks(body) {
  const byDev = new Map();
  for (const g of portGroups(body)) {
    const dev = g.port.split('|')[0];
    if (!byDev.has(dev)) byDev.set(dev, []);
    byDev.get(dev).push(g);
  }
  const bad = [];
  for (const list of byDev.values()) {
    for (const g of list) {
      const s = g.shape;
      for (let i = 0; i <= 10; i++) {
        for (let j = 0; j <= 10; j++) {
          const x = s.x + 0.05 + ((s.w - 0.1) * i) / 10;
          const y = s.y + 0.05 + ((s.h - 0.1) * j) / 10;
          let top = null;
          for (const o of list) if (o.rects.some((r) => inside(r, x, y))) top = o;
          if (top !== g) {
            bad.push(`${g.port} → ${top && top.port}`);
            i = j = 11;
          }
        }
      }
    }
  }
  return bad;
}

/** Absolute M/H/V paths as segments { x1, y1, x2, y2 }. */
function segments(d) {
  const out = [];
  let x = 0;
  let y = 0;
  for (const m of d.matchAll(/([MHV])(-?[\d.]+)(?:\s(-?[\d.]+))?/g)) {
    if (m[1] === 'M') (x = +m[2]), (y = +m[3]);
    else if (m[1] === 'H') out.push({ x1: x, y1: y, x2: (x = +m[2]), y2: y });
    else out.push({ x1: x, y1: y, x2: x, y2: (y = +m[2]) });
  }
  return out;
}

/** Cables with an end in `rowId` whose port faces `side` of the rack. */
function visibleCables(p, rowId, side) {
  const racks = new Set(M.locateRow(p, rowId).row.racks.map((r) => r.id));
  const ctx = C.context(p);
  return p.cables.filter((c) =>
    M.cableEnds(c).some((x) => {
      const d = ctx.devices.get(x.end.device);
      return d && racks.has(d.loc.rack) && C.portFace(p, x.end, ctx) === side;
    })
  );
}

test('the elevation draws every row from both sides in both themes', () => {
  const p = M.createExampleProject();
  // One switch faces the front, so both sides have cables with an end on the other side.
  byName(p, 'sw-mgmt-a01').reversed = false;
  for (const { row } of M.allRows(p)) {
    const racks = new Set(row.racks.map((r) => r.id));
    const touching = p.cables.filter((c) => M.cableEnds(c).some((x) => racks.has(M.deviceById(p, x.end.device).loc.rack)));
    const drawn = new Set();
    for (const side of ['front', 'rear']) {
      for (const theme of ['light', 'dark']) {
        const out = CR.elevation(p, { rowId: row.id, side, theme, interactive: true });
        const what = `${row.id} ${side} ${theme}`;
        assert.equal(out.side, side);
        assert.equal(out.rowId, row.id);
        assert.ok(!/NaN|undefined|Infinity/.test(out.body), what);
        assertWellFormed(wrap(out), what);
        assert.ok(out.body.includes(`${row.name} · ${side}`), 'titled with the row and side');
        if (side === 'rear') assert.ok(out.body.includes('the racks run right to left'));
        // Each cable with an end on this side once; none without.
        const visible = new Set(visibleCables(p, row.id, side).map((c) => c.id));
        for (const c of p.cables) assert.equal(count(out.body, `data-cable="${c.id}"`), visible.has(c.id) ? 1 : 0, `${what} ${c.label}`);
        visible.forEach((id) => drawn.add(id));
        // Every port on this side of every device in the row.
        for (const d of p.devices.filter((x) => racks.has(x.loc.rack))) {
          const own = d.reversed ? flip(side) : side;
          for (const pt of M.expandPorts(M.typeOf(p, d.type))) {
            assert.equal(count(out.body, `data-port="${d.id}|${pt.name}"`), pt.side === own ? 1 : 0, `${what} ${d.name} ${pt.name}`);
          }
          assert.equal(count(out.body, `data-dev="${d.id}"`), 1, `${what} ${d.name}`);
        }
      }
    }
    // Between the two sides, every cable with an end in the row is drawn.
    for (const c of touching) assert.ok(drawn.has(c.id), `${row.id}: ${c.label} is drawn from one side`);
  }
});

test('reversed switches show their ports at the rear of the rack', () => {
  const p = M.createExampleProject();
  const sw = byName(p, 'sw-mgmt-a01');
  assert.equal(sw.reversed, true);
  const rear = CR.elevation(p, { rowId: 'row1', side: 'rear' }).body;
  const front = CR.elevation(p, { rowId: 'row1', side: 'front' }).body;
  assert.ok(rear.includes(`data-port="${sw.id}|swp1"`));
  assert.ok(!front.includes(`data-port="${sw.id}|swp1"`));
  assert.ok(front.includes(`data-dev="${sw.id}"`), 'the switch is still drawn from the front');
  // Mounted the usual way round, its ports face the front.
  sw.reversed = false;
  assert.ok(CR.elevation(p, { rowId: 'row1', side: 'front' }).body.includes(`data-port="${sw.id}|swp1"`));
  assert.ok(!CR.elevation(p, { rowId: 'row1', side: 'rear' }).body.includes(`data-port="${sw.id}|swp1"`));
});

test('ends on the other side of the rack get a dashed stub and a tag', () => {
  const p = M.createExampleProject();
  const sw = byName(p, 'sw-mgmt-a01');
  sw.reversed = false;
  const cn = byName(p, 'cn-002');
  const out = CR.elevation(p, { rowId: 'row1', side: 'rear', selected: { kind: 'device', id: cn.id } });
  const cable = p.cables.find((c) => c.a.device === cn.id && c.a.port === 'eth0');
  const g = new RegExp(`<g class="cable is-selected" data-cable="${cable.id}"[^>]*>(.*?)</g>`).exec(out.body);
  assert.ok(g, 'the cable is drawn and selected');
  assert.ok(g[1].includes('stroke-dasharray'), 'with a dashed stub');
  assert.ok(g[1].includes('>front</text>'), 'tagged with the side it ends on');
  assert.ok(out.body.includes('sw-mgmt-a01 · swp2 (front)'), 'the far end is named');
});

test('interactive elements have data attributes and hit areas', () => {
  const p = M.createExampleProject();
  const out = CR.elevation(p, { rowId: 'row1', side: 'rear', interactive: true });
  const ports = portGroups(out.body);
  assert.ok(ports.length > 300);
  for (const pt of ports) {
    assert.ok(pt.hit, 'a hit area');
    assert.ok(contains(pt.hit, pt.shape), 'that covers the drawn port');
  }
  // Ports with room around them get at least 10 × 10.
  const server = byName(p, 'cn-004');
  for (const pt of ports.filter((x) => x.port.startsWith(`${server.id}|`))) assert.ok(pt.hit.w >= 10 && pt.hit.h >= 10, pt.port);
  const cables = [...out.body.matchAll(/<g class="cable[^"]*" data-cable="[^"]+"[^>]*>(.*?)<\/g>/g)];
  assert.equal(cables.length, visibleCables(p, 'row1', 'rear').length);
  for (const [, inner] of cables) {
    assert.ok(/<path d="[^"]+" fill="none" stroke="#[0-9a-f]{6}" stroke-width="[\d.]+"/.test(inner), 'a visible path');
    const hit = /stroke-opacity="0" stroke-width="([\d.]+)"/.exec(inner);
    assert.ok(hit && Number(hit[1]) >= 8, 'a wide transparent path to hit');
  }
  assert.ok(!CR.elevation(p, { rowId: 'row1' }).body.includes('stroke-opacity="0"'), 'no hit paths when not interactive');
  // The layout says where things are.
  const cn = byName(p, 'cn-004');
  assert.ok(out.layout.devices.get(cn.id).w > 0);
  assert.ok(out.layout.ports.has(`${cn.id}|ib0`));
  assert.equal(out.layout.cables.size, cables.length);
});

test('exits at the end of the tray name the row and count cables per network', () => {
  const p = M.createExampleProject();
  const out = CR.elevation(p, { rowId: 'row1', side: 'rear' });
  assert.equal(count(out.body, 'data-row="row2"'), 1, 'one exit to Row B');
  assert.ok(out.body.includes('>To Row B<'));
  assert.ok(out.body.includes('>3 Management<'), 'the management uplinks over fiber');
  assert.ok(out.body.includes('>12 InfiniBand<'), 'the leaves to the core');
  const b = CR.elevation(p, { rowId: 'row2', side: 'rear' }).body;
  assert.ok(b.includes('>To Row A<') && b.includes('>To First floor<'), 'other floors are named by floor');
  assert.ok(b.includes('data-floor="f2"'));
  // A selected cable to another row lists its far end at the exit.
  const up = p.cables.find((c) => c.a.device === byName(p, 'ib-leaf-a01').id && c.a.port === 'p21');
  const sel = CR.elevation(p, { rowId: 'row1', side: 'rear', selected: { kind: 'cable', id: up.id } }).body;
  assert.ok(sel.includes(`${M.deviceById(p, up.b.device).name} · ${up.b.port}`));
});

test('a selection draws its cables bold and names the far ends', () => {
  const p = M.createExampleProject();
  const cn = byName(p, 'cn-004');
  const out = CR.elevation(p, { rowId: 'row1', side: 'rear', selected: { kind: 'device', id: cn.id } }).body;
  assert.equal(count(out, 'class="cable is-selected"'), 3);
  for (const name of ['sw-mgmt-a01 · swp4', 'ib-leaf-a01 · p4', 'sw-bmc-a01 · swp4']) assert.ok(out.includes(`>${name}<`), name);
  assert.ok(count(out, ' opacity="0.35"') > 50, 'other cables are dimmed');
  // A port picks its cable.
  const port = CR.elevation(p, { rowId: 'row1', side: 'rear', selected: { kind: 'port', deviceId: cn.id, port: 'ib0' } }).body;
  assert.equal(count(port, 'class="cable is-selected"'), 1);
  assert.ok(port.includes('>ib-leaf-a01 · p4<') && !port.includes('>sw-mgmt-a01 · swp4<'));
  // Several cables, and the network focus.
  const rowA = new Set(visibleCables(p, 'row1', 'rear').map((c) => c.id));
  const ids = p.cables.filter((c) => c.network === 'n-sas' && rowA.has(c.id)).map((c) => c.id);
  assert.equal(ids.length, 8);
  assert.equal(count(CR.elevation(p, { rowId: 'row1', selected: { kind: 'cables', ids } }).body, 'class="cable is-selected"'), ids.length);
  const focus = CR.elevation(p, { rowId: 'row1', focusNetwork: 'n-sas' }).body;
  assert.equal(count(focus, ' opacity="0.12"') >= visibleCables(p, 'row1', 'rear').length - ids.length, true, 'other networks fade');
  // The first end of a connection being made is ringed.
  const pending = CR.elevation(p, { rowId: 'row1', pending: { device: cn.id, port: 'eth0' } }).body;
  assert.ok(pending.includes('stroke-dasharray="3 2" pointer-events="none"'));
});

test('a breakout is one cable drawn as its legs', () => {
  const p = M.createExampleProject();
  const out = CR.elevation(p, { rowId: 'row2', side: 'rear' }).body;
  const bo = p.cables.filter((c) => Array.isArray(c.b));
  assert.ok(bo.length >= 12);
  for (const c of bo) {
    assert.equal(count(out, `data-cable="${c.id}"`), 1, c.label);
    const g = new RegExp(`data-cable="${c.id}">(.*?)</g>`).exec(out)[1];
    const d = /<path d="([^"]+)"/.exec(g)[1];
    assert.equal((d.match(/M/g) || []).length, 2, `${c.label}: one run per leg`);
  }
});

test('the port map draws faceplates with what each port connects to', () => {
  const p = M.createExampleProject();
  const leaf = byName(p, 'ib-leaf-a01');
  const [card] = CR.portMap(p, [leaf.id], { width: 800, selected: { deviceId: leaf.id, port: 'p4' } });
  assert.equal(card.deviceId, leaf.id);
  assert.equal(card.width, 800);
  assertWellFormed(wrap(card), 'port map');
  assert.equal(count(card.body, 'data-port="'), 24);
  assert.equal(count(card.body, 'rotate(-90)'), 16, 'the far device of each of the 16 cabled ports');
  assert.equal(count(card.body, '>cn-004</text>'), 1);
  assert.ok(card.body.includes('font-weight="700"'), 'the selected port names its far end in bold');
  assert.equal(count(card.body, `stroke="${R.THEMES.light.handle}" stroke-width="2.5"`), 1, 'the selected port is ringed');
  assert.equal(count(card.body, '<circle'), 4, 'a dot for each far end in another rack (the core switches)');
  // Several ports selected (the ends of the cables selected): each ringed, the ends at other devices ignored.
  const [two] = CR.portMap(p, [leaf.id], {
    selected: [{ deviceId: byName(p, 'cn-004').id, port: 'ib0' }, { deviceId: leaf.id, port: 'p4' }, { deviceId: leaf.id, port: 'p5' }],
  });
  assert.equal(count(two.body, `stroke="${R.THEMES.light.handle}" stroke-width="2.5"`), 2, 'both selected ports of the leaf are ringed');
  assert.equal(count(two.body, 'font-weight="700"'), 2, 'and both far ends are bold');
  assert.equal(count(CR.portMap(p, [leaf.id], { selected: [] })[0].body, 'stroke-width="2.5"'), 0);
  // Breakout heads name both far devices; a device with ports on both sides shows both.
  const b02 = byName(p, 'ib-leaf-b02');
  assert.ok(CR.portMap(p, [b02.id], {})[0].body.includes('core-sw-01/02'));
  const t = M.addDeviceType(p, { label: 'Two-sided', face: 'generic', height: 1, ports: [{ name: 'f', first: 1, count: 2, connector: 'rj45', speedGbps: 1, side: 'front' }, { name: 'mgmt', connector: 'rj45', speedGbps: 1, side: 'rear' }] });
  p.devices.push(M.newDevice({ id: 'two', type: t.id, name: 'two', loc: { rack: 'r3', kind: 'u', at: 40 } }));
  p.devices.push(M.newDevice({ id: 'none', type: 'patch-panel', name: 'pp', loc: { rack: 'r3', kind: 'u', at: 42 } }));
  const cards = CR.portMap(p, ['two', 'none', 'missing'], { theme: 'dark', pending: { device: 'two', port: 'mgmt' } });
  assert.equal(cards.length, 2, 'unknown devices are skipped');
  assert.ok(cards[0].body.includes('>FRONT<') && cards[0].body.includes('>REAR<'));
  assert.equal(count(cards[0].body, 'data-port="'), 3);
  assert.ok(cards[0].body.includes('stroke-dasharray="3 2"'), 'the pending port is ringed');
  assert.ok(cards[1].body.includes('has no ports'));
});

test('the fabric shows cores, leaves and node groups with oversubscription', () => {
  const p = M.createExampleProject();
  const out = CR.fabric(p, 'n-ib', { width: 900 });
  assertWellFormed(wrap(out), 'fabric');
  assert.equal(out.cores.length, 2);
  assert.equal(out.leaves.length, 5);
  assert.equal(count(out.body, 'data-leaf="'), 5);
  assert.equal(count(out.body, 'data-core="'), 2);
  assert.equal(count(out.body, 'data-group="'), out.groups.length);
  assert.ok(out.groups.length >= 6 && out.groups.length < 31, 'nodes are grouped');
  assert.ok(out.body.includes('>cn-001 … 012<'));
  const leaf = byName(p, 'ib-leaf-a01');
  const leafBox = (body) => new RegExp(`data-leaf="${leaf.id}">(.*?)</g>`).exec(body)[1];
  assert.ok(leafBox(out.body).includes('>3:1<'));
  assert.ok(!leafBox(out.body).includes(R.THEMES.light.bad), '3 : 1 is not flagged');
  // Unplug one uplink of ib-leaf-a01: 12 × 200G down, 3 × 200G up.
  const up = p.cables.find((c) => c.a.device === leaf.id && c.a.port === 'p24');
  C.disconnect(p, up.id);
  const after = CR.fabric(p, 'n-ib', {});
  assert.ok(leafBox(after.body).includes('>4:1<'));
  assert.ok(leafBox(after.body).includes(`fill="${R.THEMES.light.bad}"`), 'the badge turns red above 3 : 1');
  // Every device on its own, selection, other networks.
  const every = CR.fabric(p, 'n-ib', { grouped: false, selected: { ids: [leaf.id] } });
  assert.equal(every.groups.length, C.fabric(p, 'n-ib').nodes.length);
  assert.ok(every.width > out.width, 'the sheet grows to fit');
  assert.ok(every.body.includes(`stroke="${R.THEMES.light.select}" stroke-width="2"`), 'the selected leaf is outlined');
  const sas = CR.fabric(p, 'n-sas', { theme: 'dark' });
  assert.equal(sas.leaves.length, 0);
  assert.ok(sas.groups.length >= 2);
  assert.ok(!/NaN|undefined/.test(sas.body));
  const empty = CR.fabric(p, C.addNetwork(p, { name: 'Empty' }).id, {});
  assert.ok(empty.body.includes('No cables in Empty'));
});

test('exported cabling drawings are standalone, light and well formed', () => {
  const p = M.createExampleProject();
  p.name = 'Plan <A&B>';
  byName(p, 'cn-001').name = 'cn-<1>&';
  const seen = [];
  const measure = (t, css) => (seen.push(css), t.length * 6);
  for (const [kind, opts] of [['elevation', { rowId: 'row1', side: 'rear' }], ['elevation', { rowId: 'row3', side: 'front' }], ['fabric', { networkId: 'n-ib' }], ['fabric', { networkId: 'n-mgmt', grouped: false }]]) {
    const svg = CR.exportSVG(kind, p, Object.assign({ measure, theme: 'dark', interactive: true, selected: { kind: 'device', id: 'ex-1' } }, opts));
    assert.ok(svg.startsWith('<?xml'));
    assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
    assertWellFormed(svg, `${kind} export`);
    assert.ok(svg.includes('<title>Plan &lt;A&amp;B&gt; · '));
    assert.ok(!/Plex|Barlow/.test(svg), 'drawn without web fonts');
    assert.ok(svg.includes(R.THEMES.light.paper) && !svg.includes(R.THEMES.dark.paper), 'light theme');
    assert.ok(!svg.includes('stroke-opacity="0"') && !svg.includes('is-selected'), 'no hit areas or selection');
    assert.ok(!/var\(--/.test(svg));
  }
  assert.ok(CR.exportSVG('elevation', p, { rowId: 'row1' }).includes('cn-&lt;1&gt;&amp;'));
  assert.ok(seen.length && seen.every((css) => !/Plex|Barlow/.test(css)), 'measured without web fonts');
});

test('cabling drawings cope with empty rows and plans without cables', () => {
  const p = M.createEmptyProject(2);
  const out = CR.elevation(p, { side: 'front', interactive: true });
  assert.ok(out.body.includes('No cables on the front of this row'));
  assertWellFormed(wrap(out), 'empty row');
  assert.ok(!/NaN|undefined|Infinity/.test(out.body));
  assert.equal(CR.portMap(p, [], {}).length, 0);
  assert.ok(CR.fabric(p, null, {}).body.includes('No cables in this network'));
});

test('a click on a drawn port always lands on that port', () => {
  const p = M.createExampleProject();
  for (const side of ['front', 'rear']) {
    for (const { row } of M.allRows(p)) {
      const out = CR.elevation(p, { rowId: row.id, side, interactive: true });
      assert.deepEqual(misclicks(out.body), [], `${row.id} ${side}`);
    }
  }
  // Dense switches facing the front, the side switches among them.
  for (const name of ['sw-bmc-a01', 'sw-bmc-a03', 'sw-mgmt-a01']) byName(p, name).reversed = !byName(p, name).reversed;
  for (const side of ['front', 'rear']) assert.deepEqual(misclicks(CR.elevation(p, { rowId: 'row1', side, interactive: true }).body), [], side);
  // Faceplates of the port map too, at their smallest scale.
  const r = p.floors[0].rows[0].racks[0].id;
  const t = M.addDeviceType(p, { label: '128 OSFP', face: 'qsfp', height: 1, ports: [{ name: 'p', first: 1, count: 128, connector: 'osfp', speedGbps: 800, side: 'front' }] });
  p.devices.push(M.newDevice({ id: 'big', type: t.id, name: 'big', loc: { rack: r, kind: 'u', at: 30 } }));
  for (const card of CR.portMap(p, ['big', byName(p, 'sw-mgmt-a01').id, byName(p, 'ceph-01').id], {})) assert.deepEqual(misclicks(card.body), [], card.deviceId);
});

test('selected cables let clicks through to the ports under them', () => {
  const p = M.createExampleProject();
  const leaf = byName(p, 'ib-leaf-a01');
  const out = CR.elevation(p, { rowId: 'row1', side: 'rear', interactive: true, selected: { kind: 'device', id: leaf.id } }).body;
  const firstPort = out.indexOf('class="port"');
  assert.ok(firstPort > 0);
  // Every hit path lies under the ports; the bold strokes on top take no clicks.
  assert.ok(out.lastIndexOf('stroke-opacity="0"') < firstPort, 'hit paths under the ports');
  const hot = [...out.matchAll(/<g class="cable is-selected" data-cable="([^"]+)"([^>]*)>/g)];
  assert.ok(hot.length > 10);
  for (const [, id, attrs] of hot) {
    assert.ok(attrs.includes('pointer-events="none"'), id);
    assert.equal(count(out.slice(0, firstPort), `<g class="cable-hit" data-cable="${id}">`), 1, `${id} is hit below the ports`);
  }
});

test('cables of side devices stay out of the bay', () => {
  // A horizontal run may only cross the devices the cable ends at.
  const crossings = (p, rowId, side) => {
    const out = CR.elevation(p, { rowId, side });
    const bay = [...out.layout.devices].filter(([, r]) => r.w === CR.geometry.BAY);
    const bad = [];
    for (const c of p.cables) {
      const g = new RegExp(`data-cable="${c.id}"[^>]*>(?:<path d="[^"]+" fill="none" stroke="[^"]+" stroke-width="6"[^>]*/>)?<path d="([^"]+)"`).exec(out.body);
      if (!g) continue;
      const own = new Set(M.cableEnds(c).map((x) => x.end.device));
      for (const sg of segments(g[1])) {
        if (sg.y1 !== sg.y2) continue;
        for (const [id, r] of bay) {
          if (own.has(id) || sg.y1 <= r.y + 0.5 || sg.y1 >= r.y + r.h - 0.5) continue;
          if (Math.min(Math.max(sg.x1, sg.x2), r.x + r.w) - Math.max(Math.min(sg.x1, sg.x2), r.x) > 1) bad.push(`${c.label} over ${M.deviceById(p, id).name}`);
        }
      }
    }
    return bad;
  };
  const p = M.createExampleProject();
  for (const { row } of M.allRows(p)) for (const side of ['front', 'rear']) assert.deepEqual(crossings(p, row.id, side), [], `${row.id} ${side}`);
  // A side BMC switch facing the front: its copper lane is in the other manager.
  byName(p, 'sw-bmc-a01').reversed = false;
  assert.deepEqual(crossings(p, 'row1', 'front'), []);
  // Seen from the rear, a fiber cable to a side switch.
  const q = M.createExampleProject();
  const bmc = byName(q, 'sw-bmc-a03');
  bmc.type = 'switch-qsfp';
  const oss = byName(q, 'oss-01');
  const ib = q.cables.find((c) => c.a.device === oss.id && c.a.port === 'ib0');
  ib.b = { device: bmc.id, port: 'p1' };
  q.cables = q.cables.filter((c) => c === ib || !M.cableEnds(c).some((x) => x.end.device === bmc.id));
  assert.equal(C.portFace(q, ib.b), 'rear');
  assert.deepEqual(crossings(q, 'row1', 'rear'), []);
});

test('the tag of an end on the other side keeps clear of device names', () => {
  const p = M.createExampleProject();
  byName(p, 'sw-mgmt-a01').reversed = false;
  const { LABEL_X } = R.geometry;
  for (const side of ['front', 'rear']) {
    const out = CR.elevation(p, { rowId: 'row1', side });
    const tags = [...out.body.matchAll(/<rect class="side-tag" x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
    assert.ok(tags.length > 3, side);
    for (const [id, r] of out.layout.devices) {
      if (r.w !== CR.geometry.BAY) continue;
      const d = M.deviceById(p, id);
      const name = { x: r.x + LABEL_X, y: r.y + 3, w: R.approxMeasure(d.name, R.FONTS.name.css), h: 18 };
      for (const tg of tags) {
        const overlap = tg.x < name.x + name.w && name.x < tg.x + tg.w && tg.y < name.y + name.h && name.y < tg.y + tg.h;
        assert.ok(!overlap, `${side}: a tag covers ${d.name}`);
      }
    }
  }
});

test('port tiles tell every port of a faceplate apart', () => {
  const p = M.createExampleProject();
  const tiles = (id) => [...CR.portMap(p, [id], {})[0].body.matchAll(/<g class="port" data-port="[^"]+">.*?<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  for (const name of ['ceph-01', 'gpu-srv-01', 'oss-01']) {
    const labels = tiles(byName(p, name).id);
    assert.equal(new Set(labels).size, labels.length, `${name}: ${labels.join(' ')}`);
  }
  assert.ok(tiles(byName(p, 'ceph-01').id).includes('sas3'));
  // A switch's one numbered group reads as numbers.
  const sw = tiles(byName(p, 'sw-mgmt-a01').id);
  assert.equal(sw[0], '1');
  assert.ok(sw.includes('52'));
});

test('exits list far ends with their ports and fit on the sheet', () => {
  const p = M.createExampleProject();
  const sw = byName(p, 'sw-mgmt-b01');
  const b = CR.elevation(p, { rowId: 'row2', side: 'rear', selected: { kind: 'device', id: sw.id } }).body;
  for (const name of ['sw-mgmt-a01', 'sw-mgmt-a02', 'sw-mgmt-a03']) assert.ok(b.includes(`>${name} · swp52<`), name);
  // A long name is shortened, not the port.
  byName(p, 'sw-mgmt-a01').name = 'sw-mgmt-a01-hall-west-cage-12-row-a';
  const long = CR.elevation(p, { rowId: 'row2', side: 'rear', selected: { kind: 'device', id: sw.id } }).body;
  assert.ok(/>sw-mgmt-a01-hall[^<]*… · swp52</.test(long));
  // The sheet keeps the same width whatever is selected.
  assert.equal(CR.elevation(p, { rowId: 'row2', side: 'rear' }).width, CR.elevation(p, { rowId: 'row2', side: 'rear', selected: { kind: 'device', id: sw.id } }).width);

  // One small rack with cables to seven other rows and five floors.
  const q = M.createEmptyProject(1);
  const f1 = q.floors[0];
  q.floors[0].rows[0].racks[0].type = M.addRackType(q, { name: '24U', units: 24, sideSlots: 0 }).id;
  for (let i = 0; i < 7; i++) M.addRow(q, f1.id, { racks: 1 });
  for (let i = 0; i < 5; i++) M.addFloor(q, { racks: 1 });
  const srv = M.addDeviceType(q, { label: 'S', tag: 'S', face: 'compute', height: 1, ports: [{ name: 'p', first: 1, count: 12, connector: 'rj45', speedGbps: 1, side: 'rear' }] });
  const nets = [];
  for (let i = 0; i < 6; i++) nets.push(C.addNetwork(q, { name: `Network number ${i}` }).id);
  const rows = M.allRows(q);
  const home = rows[0].row.racks[0].id;
  for (let k = 0; k < 3; k++) q.devices.push(M.newDevice({ id: `h${k}`, type: srv.id, name: `home${k}`, loc: { rack: home, kind: 'u', at: k + 1 } }));
  let n = 0;
  rows.slice(1).forEach((r, i) => {
    q.devices.push(M.newDevice({ id: `o${i}`, type: srv.id, name: `other-${i}`, loc: { rack: r.row.racks[0].id, kind: 'u', at: 1 } }));
    for (let k = 0; k < 3; k++, n++) assert.ok(!C.connect(q, { a: { device: `h${Math.floor(n / 12)}`, port: `p${(n % 12) + 1}` }, b: { device: `o${i}`, port: `p${k + 1}` }, network: nets[(i + k) % 6] }).error);
  });
  for (const selected of [null, { kind: 'device', id: 'h0' }]) {
    const out = CR.elevation(q, { rowId: rows[0].row.id, side: 'rear', selected });
    assert.equal(out.layout.exits.length, 12);
    for (const e of out.layout.exits) assert.ok(e.y + e.h <= out.height - 10, `${e.key} on the sheet`);
    // The legend keeps left of the exits and names every network.
    const exitX = Math.min(...out.layout.exits.map((e) => e.x));
    for (const m of out.body.matchAll(/<text x="([\d.]+)" y="[\d.]+" font-family="[^"]+" font-size="12" font-weight="500" fill="[^"]+">([^<]+)<tspan/g)) {
      assert.ok(+m[1] + R.approxMeasure(m[2], R.FONTS.legend.css) < exitX, `${m[2]} left of the exits`);
    }
    for (let i = 0; i < 6; i++) assert.ok(out.body.includes(`>Network number ${i}<tspan`), `network ${i} in the legend`);
  }
});

test('the networks legend wraps rather than leaving networks out', () => {
  const p = M.createEmptyProject(1);
  const r = p.floors[0].rows[0].racks[0].id;
  const t = M.addDeviceType(p, { label: 'S', tag: 'S', face: 'compute', height: 1, ports: [{ name: 'p', first: 1, count: 12, connector: 'rj45', speedGbps: 1, side: 'rear' }] });
  p.devices.push(M.newDevice({ id: 'a', type: t.id, name: 'a', loc: { rack: r, kind: 'u', at: 1 } }), M.newDevice({ id: 'b', type: t.id, name: 'b', loc: { rack: r, kind: 'u', at: 2 } }));
  const names = ['Frontend 100G', 'Backup 10G', 'IPMI', 'Console', 'Management', 'Storage 25G', 'InfiniBand', 'Out of band', 'Tenant VLAN 40'];
  names.forEach((name, i) => assert.ok(!C.connect(p, { a: { device: 'a', port: `p${i + 1}` }, b: { device: 'b', port: `p${i + 1}` }, network: C.addNetwork(p, { name }).id }).error));
  const plain = CR.elevation(M.createEmptyProject(1), { side: 'rear' });
  const out = CR.elevation(p, { side: 'rear' });
  for (const name of names) assert.ok(out.body.includes(`>${name}<tspan`), name);
  assert.ok(out.height > plain.height, 'the sheet grows for the extra lines');
  assertWellFormed(wrap(out), 'legend');
});

test('second-row band labels have leaders that cross no other label', () => {
  const p = M.createExampleProject();
  for (const name of ['ceph-01', 'ceph-02', 'ceph-03', 'oss-01']) {
    const out = CR.elevation(p, { rowId: 'row1', side: 'rear', selected: { kind: 'device', id: byName(p, name).id } }).body;
    const group = /<g class="far-ends" pointer-events="none">(.*?)<\/g>/.exec(out)[1];
    const items = [...group.matchAll(/<path d="([^"]+)"[^>]*\/>|<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="16"/g)];
    const pills = [];
    const leaders = [];
    items.forEach((m, i) => {
      if (m[1]) leaders.push({ d: m[1], own: i + 1 });
      else pills.push({ i, x: +m[2], y: +m[3], w: +m[4] });
    });
    assert.ok(leaders.length >= 2, name);
    const bars = new Set();
    for (const l of leaders) {
      for (const sg of segments(l.d)) {
        if (sg.y1 === sg.y2) bars.add(sg.y1);
        else for (const pl of pills) {
          if (pl.i === l.own) continue;
          const crosses = sg.x1 > pl.x && sg.x1 < pl.x + pl.w && Math.min(sg.y1, sg.y2) < pl.y + 16 && Math.max(sg.y1, sg.y2) > pl.y;
          assert.ok(!crosses, `${name}: a leader crosses another label`);
        }
      }
    }
    if (name.startsWith('ceph')) assert.ok(bars.size >= 2, `${name}: each band row has its own leader bar`);
  }
});

test('the port map widens for long faceplates and keeps its dots on the card', () => {
  const p = M.createExampleProject();
  const r = p.floors[0].rows[0].racks[0].id;
  const t = M.addDeviceType(p, { label: '144 OSFP', face: 'qsfp', height: 4, ports: [{ name: 'p', first: 1, count: 144, connector: 'osfp', speedGbps: 800, side: 'front' }] });
  p.devices.push(M.newDevice({ id: 'xdr', type: t.id, name: 'xdr', loc: { rack: r, kind: 'u', at: 30 } }));
  const [card] = CR.portMap(p, ['xdr'], { width: 760 });
  assert.ok(card.width > 760);
  const ports = portGroups(card.body);
  assert.equal(ports.length, 144);
  for (const pt of ports) assert.ok(pt.shape.x >= 0 && pt.shape.x + pt.shape.w <= card.width, `${pt.port} on the card`);
  // Far ends in other racks get a dot past their name, inside the card.
  for (const name of ['core-sw-01', 'core-sw-02']) byName(p, name).name = name.replace('core-sw', 'core-switch-hall-a');
  for (const id of ['ib-leaf-a01', 'ib-leaf-b02'].map((n) => byName(p, n).id)) {
    const [c] = CR.portMap(p, [id], {});
    const dots = [...c.body.matchAll(/<circle cx="[\d.-]+" cy="(-?[\d.]+)" r="2.2"/g)].map((m) => +m[1]);
    assert.ok(dots.length >= 1);
    for (const cy of dots) assert.ok(cy >= 2.2 && cy <= c.height - 2.2, `dot at ${cy} in a card ${c.height} high`);
  }
});

test('the port map keeps every port numbered on a narrow card, with more room for a finger', () => {
  const p = M.createExampleProject();
  const sw = byName(p, 'sw-mgmt-a01');
  const tiles = (card) => [...card.body.matchAll(/<g class="port" data-port="[^"]+">.*?<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  /** The least distance from a port to the next in its row. */
  const pitch = (card) => {
    const shapes = portGroups(card.body).map((g) => g.shape);
    let least = Infinity;
    for (const a of shapes) for (const b of shapes) if (b.x > a.x && b.y < a.y + a.h && a.y < b.y + b.h) least = Math.min(least, b.x - a.x);
    return least;
  };
  const measure = (t, css) => t.length * (parseFloat(/([\d.]+)px/.exec(css)[1]) * 0.6);
  // A card drawn for a phone (300 px) widens till its 52 ports are numbered; the page scrolls it sideways.
  const [narrow] = CR.portMap(p, [sw.id], { width: 300, measure });
  assert.ok(narrow.width > 300);
  assert.ok(pitch(narrow) >= 15.9, `ports ${pitch(narrow)} apart`);
  const labels = tiles(narrow);
  assert.equal(labels.length, 52);
  assert.ok(!labels.some((x) => x.includes('…')), labels.join(' '));
  assert.ok(labels.includes('52'));
  // A wide card is not made wider.
  assert.equal(CR.portMap(p, [sw.id], { width: 900, measure })[0].width, 900);
  // For a finger: a wider pitch, up to the largest scale.
  const [touch] = CR.portMap(p, [sw.id], { width: 300, measure, minPitch: 28 });
  assert.ok(touch.width > narrow.width);
  assert.ok(pitch(touch) >= 24.7, `ports ${pitch(touch)} apart`);
  const leaf = byName(p, 'ib-leaf-a01');
  assert.ok(pitch(CR.portMap(p, [leaf.id], { width: 300, measure, minPitch: 28 })[0]) >= 27.9);
});

test('the port map brings the network in focus and the cables searched for forward', () => {
  const p = M.createExampleProject();
  const ids = ['sw-mgmt-a01', 'sw-bmc-a01', 'ib-leaf-a01'].map((n) => byName(p, n).id);
  const idx = C.cableIndex(p);
  /** Each port: { key, net (null when free), faded opacity or null }. */
  const ports = (cards) =>
    cards.flatMap((card) =>
      [...card.body.matchAll(/<g class="port" data-port="([^"]+)"( opacity="([\d.]+)")?>/g)].map((m) => {
        const hit = idx.get(m[1]);
        return { key: m[1], cable: hit ? hit.cable.id : null, net: hit ? hit.cable.network || '' : null, op: m[3] ? +m[3] : null };
      })
    );
  const plain = ports(CR.portMap(p, ids, {}));
  assert.ok(plain.every((x) => x.op === null), 'nothing fades without a focus or a search');
  // Management in focus: ports cabled in other networks fade; free ones and its own stay.
  const focused = ports(CR.portMap(p, ids, { focusNetwork: 'n-mgmt' }));
  assert.ok(focused.some((x) => x.net === 'n-mgmt') && focused.some((x) => x.net && x.net !== 'n-mgmt'));
  for (const x of focused) assert.equal(x.op, x.net !== null && x.net !== 'n-mgmt' ? 0.2 : null, x.key);
  // A search match: its port ringed, the other cabled ports fade.
  const hit = idx.get(`${ids[2]}|p4`).cable.id;
  const cards = CR.portMap(p, ids, { highlight: new Set([hit]) });
  assert.equal(cards.reduce((n, c) => n + count(c.body, 'class="lit-ring"'), 0), 1);
  for (const x of ports(cards)) assert.equal(x.op, x.cable && x.cable !== hit ? 0.35 : null, x.key);
  // A match on none of the ports shown fades nothing.
  const elsewhere = p.cables.find((c) => !M.cableEnds(c).some((e) => ids.includes(e.end.device))).id;
  assert.ok(ports(CR.portMap(p, ids, { highlight: new Set([elsewhere]) })).every((x) => x.op === null));
});

test('the fabric takes the graph it is given, outlines the devices searched for and says where its switches are', () => {
  const p = M.createExampleProject();
  const graph = C.fabric(p, 'n-ib');
  const out = CR.fabric(p, 'n-ib', { grouped: false });
  assert.equal(CR.fabric(p, 'n-ib', { grouped: false, fabric: graph }).body, out.body);
  // The switches' box holds every leaf and core box; with every node drawn they sit over the middle of the sheet.
  const b = out.switchBox;
  let boxes = 0;
  for (const m of out.body.matchAll(/<g class="fb-box" data-dev="[^"]+" data-(?:leaf|core)="[^"]+"><rect x="([\d.]+)" y="([\d.]+)" width="(\d+)" height="(\d+)"/g)) {
    assert.ok(+m[1] >= b.x - 0.05 && +m[1] + +m[3] <= b.x + b.w + 0.05 && +m[2] >= b.y - 0.05 && +m[2] + +m[4] <= b.y + b.h + 0.05);
    boxes++;
  }
  assert.equal(boxes, 7, '5 leaves and 2 cores');
  assert.ok(b.x > 1000 && b.x + b.w < out.width - 1000, 'the switches are far from the left edge');
  assert.equal(CR.fabric(p, 'n-sas', {}).switchBox, null, 'no switches');
  // Highlighted devices are outlined, unless selected.
  const leaf = byName(p, 'ib-leaf-a02').id;
  const node = byName(p, 'cn-004').id;
  const lit = CR.fabric(p, 'n-ib', { grouped: false, highlight: [leaf, node], selected: [node] });
  assert.equal(count(lit.body, `stroke="${R.THEMES.light.handle}" stroke-width="2"`), 1);
  assert.equal(count(lit.body, `stroke="${R.THEMES.light.select}" stroke-width="2"`), 1);
});

/** The far-end labels of an elevation: { x, y, w, h, label, i } in drawing order, and the leaders before them. */
function farPills(body) {
  const group = /<g class="far-ends" pointer-events="none">(.*?)<\/g>/.exec(body);
  if (!group) return [];
  return [...group[1].matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="16"[^>]*\/><text[^>]*>([^<]*)<\/text>/g)].map((m) => ({
    x: +m[1],
    y: +m[2],
    w: +m[3],
    h: 16,
    label: m[4].replace(/&amp;/g, '&'),
  }));
}
const overlaps = (a, b, slack) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > slack && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > slack;

test('far-end labels stay on the sheet, by their ports, and cover no port', () => {
  const variants = [
    { what: 'example', rows: ['row1', 'row2', 'row3'], edit: () => {} },
    // Side switches and the management switch facing the front.
    { what: 'unreversed', rows: ['row1'], edit: (p) => ['sw-bmc-a01', 'sw-bmc-a03', 'sw-mgmt-a01'].forEach((n) => (byName(p, n).reversed = false)) },
  ];
  for (const v of variants) {
    const p = M.createExampleProject();
    v.edit(p);
    for (const rowId of v.rows) {
      const racks = new Set(M.locateRow(p, rowId).row.racks.map((r) => r.id));
      for (const side of ['rear', 'front']) {
        for (const sel of p.devices.filter((d) => racks.has(d.loc.rack))) {
          const out = CR.elevation(p, { rowId, side, selected: { kind: 'device', id: sel.id } });
          const what = `${v.what} ${rowId} ${side} ${sel.name}`;
          const pills = farPills(out.body);
          const tops = Math.min(...[...out.layout.devices.values()].map((r) => r.y));
          pills.forEach((pl, i) => {
            assert.ok(pl.x >= 10.5 && pl.x + pl.w <= out.width - 10.5, `${what}: "${pl.label}" on the sheet`);
            for (const other of pills.slice(i + 1)) assert.ok(!overlaps(pl, other, 0), `${what}: "${pl.label}" over "${other.label}"`);
            for (const [k, a] of out.layout.ports) {
              const port = { x: a.x - a.w / 2, y: a.y - a.h / 2, w: a.w, h: a.h };
              assert.ok(!overlaps(pl, port, 0), `${what}: "${pl.label}" covers ${k}`);
            }
            // A label of ports in the bay sits in or just above their device.
            const [name, rest] = pl.label.split(' · ');
            const d = byName(p, name);
            const r = d && out.layout.devices.get(d.id);
            if (!r || pl.y < tops - 2 || /\((front|rear)\)$/.test(rest) || r.w !== CR.geometry.BAY) return;
            assert.ok(pl.y + pl.h > r.y - 18 && pl.y < r.y + r.h, `${what}: "${pl.label}" at ${pl.y}, its device at ${r.y}…${r.y + r.h}`);
          });
        }
      }
    }
  }
});

test('the label of a top-of-rack switch goes no higher than the device it names', () => {
  // The side switch's label used to push cn-004's five units up, onto cn-001.
  const p = M.createExampleProject();
  const out = CR.elevation(p, { rowId: 'row1', side: 'rear', selected: { kind: 'device', id: byName(p, 'sw-mgmt-a01').id } });
  const cn = byName(p, 'cn-004');
  const pill = farPills(out.body).find((x) => x.label === 'cn-004 · eth0');
  const port = out.layout.ports.get(`${cn.id}|eth0`);
  const r = out.layout.devices.get(cn.id);
  assert.ok(pill.y >= r.y - 2 && pill.y + pill.h <= port.y - port.h / 2, `above its port, in cn-004: ${pill.y}`);
  // The side switch's label finds another place, clear of the ports.
  assert.ok(farPills(out.body).some((x) => x.label === 'sw-bmc-a01 · swp48'));
});

test('a side device’s label beside its slot, with a leader when moved along it', () => {
  const p = M.createExampleProject();
  const bmc = byName(p, 'sw-bmc-a01');
  const out = CR.elevation(p, { rowId: 'row1', side: 'rear', selected: { kind: 'device', id: byName(p, 'cn-006').id } });
  const slot = out.layout.devices.get(bmc.id);
  const pill = farPills(out.body).find((x) => x.label === 'sw-bmc-a01 · swp6');
  assert.ok(pill.x >= slot.x + slot.w && pill.x <= slot.x + slot.w + 20, 'towards the bay');
  assert.ok(pill.y >= slot.y - 8 && pill.y <= slot.y + slot.h, 'along the slot');
  const port = out.layout.ports.get(`${bmc.id}|swp6`);
  if (Math.abs(port.y - (pill.y + 8)) >= 5) {
    const group = /<g class="far-ends" pointer-events="none">(.*?)<\/g>/.exec(out.body)[1];
    const lead = new RegExp(`<path d="([^"]+)"[^>]*/><rect x="${pill.x}" y="${pill.y}"`).exec(group);
    assert.ok(lead, 'a leader');
    const segs = segments(lead[1]);
    assert.ok(segs.some((sg) => sg.y1 === sg.y2 && Math.abs(sg.y1 - port.y) < 0.1), 'from the port');
    assert.ok(segs.some((sg) => sg.y1 === sg.y2 && Math.abs(sg.y1 - (pill.y + 8)) < 0.1 && Math.max(sg.x1, sg.x2) === pill.x), 'to the label');
  }
});

test('an end on the other side of a side device is named beside the slot', () => {
  // A side switch facing the front, cabled to servers whose ports face the rear.
  for (const [name, server] of [
    ['sw-bmc-a03', 'ceph-01'],
    ['sw-bmc-a01', 'cn-001'],
  ]) {
    const p = M.createExampleProject();
    const bmc = byName(p, name);
    bmc.reversed = false;
    const out = CR.elevation(p, { rowId: 'row1', side: 'rear', selected: { kind: 'device', id: byName(p, server).id } });
    const slot = out.layout.devices.get(bmc.id);
    const pill = farPills(out.body).find((x) => x.label.startsWith(`${name} · `) && x.label.endsWith('(front)'));
    assert.ok(pill, name);
    assert.ok(pill.x >= slot.x + slot.w && pill.x <= slot.x + slot.w + 20, `${name}: beside the slot at ${pill.x}, the slot at ${slot.x}`);
    assert.ok(pill.x >= 10.5 && pill.y >= slot.y - 8 && pill.y <= slot.y + slot.h, `${name}: on the sheet, along the slot`);
  }
});

test('a selected switch keeps its ports in sight', () => {
  const p = M.createExampleProject();
  const handle = R.THEMES.light.handle;
  for (const [rowId, name] of [
    ['row2', 'sw-mgmt-b01'],
    ['row1', 'ib-leaf-a01'],
    ['row2', 'core-sw-01'],
    ['row1', 'sw-bmc-a01'],
  ]) {
    const d = byName(p, name);
    const out = CR.elevation(p, { rowId, side: 'rear', selected: { kind: 'device', id: d.id } }).body;
    // The bold cables go under the ports.
    const firstPort = out.indexOf('class="port"');
    assert.ok(out.lastIndexOf('class="cable is-selected"') < firstPort, `${name}: selected cables under the ports`);
    // Its rings: one around each run of ports in a row, crossing no other ring or port.
    const rings = [...out.matchAll(new RegExp(`<rect x="(-?[\\d.]+)" y="(-?[\\d.]+)" width="([\\d.]+)" height="([\\d.]+)" rx="[\\d.]+" fill="none" stroke="${handle}" stroke-width="([\\d.]+)"`, 'g'))].map((m) => {
      const sw = +m[5];
      return { inner: { x: +m[1] + sw / 2, y: +m[2] + sw / 2, w: +m[3] - sw, h: +m[4] - sw }, outer: { x: +m[1] - sw / 2, y: +m[2] - sw / 2, w: +m[3] + sw, h: +m[4] + sw } };
    });
    const ports = portGroups(out).filter((g) => g.port.startsWith(`${d.id}|`));
    assert.ok(rings.length > 0 && rings.length < ports.length, `${name}: ${rings.length} rings`);
    rings.forEach((rg, i) => {
      for (const other of rings.slice(i + 1)) assert.ok(!overlaps(rg.outer, other.outer, 0.05), `${name}: rings overlap`);
      for (const pt of ports) if (!contains(rg.inner, pt.shape)) assert.ok(!overlaps(rg.outer, pt.shape, 0.05), `${name}: a ring crosses ${pt.port}`);
    });
  }
});

test('tags of ends on the other side keep off the unit numbers and above the selection', () => {
  const p = M.createExampleProject();
  for (const n of ['sw-mgmt-a01', 'sw-bmc-a01']) byName(p, n).reversed = false;
  for (const [side, name] of [
    ['front', 'cn-001'],
    ['rear', 'sw-mgmt-a01'],
  ]) {
    const out = CR.elevation(p, { rowId: 'row1', side, selected: { kind: 'device', id: byName(p, name).id } }).body;
    const tags = [...out.matchAll(/<rect class="side-tag" x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
    assert.ok(tags.length > 3, side);
    const F = R.FONTS.unit;
    const nums = [...out.matchAll(new RegExp(`<text x="([\\d.]+)" y="([\\d.]+)" font-family="[^"]+" font-size="${F.size}"[^>]*text-anchor="middle">(\\d+)</text>`, 'g'))].map((m) => {
      const w = R.approxMeasure(m[3], F.css);
      return { x: +m[1] - w / 2, y: +m[2] - 5.5, w, h: 5.5, n: m[3] };
    });
    assert.ok(nums.length > 40);
    for (const tg of tags) for (const nm of nums) assert.ok(!overlaps(tg, nm, 0), `${side}: a tag at ${tg.y} covers unit ${nm.n}`);
    // The selected device's outline goes under every tag.
    const outline = out.indexOf(`rx="3" fill="none" stroke="${R.THEMES.light.select}" stroke-width="2"`);
    assert.ok(outline > 0 && outline < out.indexOf('class="side-tag"'), `${side}: the outline under the tags`);
  }
});

test('dense ports of a device of several units run along the unit that holds them', () => {
  const p = M.createExampleProject();
  const t = M.addDeviceType(p, { label: 'Core 2U', tag: 'SWITCH', face: 'rj45', height: 2, ports: [{ name: 'swp', first: 1, count: 48, connector: 'rj45', speedGbps: 1, side: 'rear' }] });
  const sw = byName(p, 'sw-mgmt-a01');
  sw.type = t.id;
  sw.reversed = false;
  byName(p, 'ib-leaf-a01').loc.at = 34;
  p.cables = p.cables.filter((c) => !M.cableEnds(c).some((x) => x.end.device === sw.id && !/^swp([1-9]|[1-3]\d|4[0-8])$/.test(x.end.port)));
  const out = CR.elevation(p, { rowId: 'row1', side: 'rear', selected: { kind: 'device', id: sw.id } });
  const r = out.layout.devices.get(sw.id);
  const mine = p.cables.filter((c) => M.cableEnds(c).some((x) => x.end.device === sw.id));
  assert.ok(mine.length >= 12);
  for (const c of mine) {
    const d = new RegExp(`data-cable="${c.id}"[^>]*>(?:<path d="[^"]+" fill="none" stroke="[^"]+" stroke-width="6"[^>]*/>)?<path d="([^"]+)"`).exec(out.body)[1];
    for (const sg of segments(d)) {
      const x1 = Math.min(sg.x1, sg.x2);
      const x2 = Math.max(sg.x1, sg.x2);
      if (x2 <= r.x + 0.5 || x1 >= r.x + r.w - 0.5) continue;
      assert.ok(Math.min(sg.y1, sg.y2) >= r.y + CR.geometry.U, `${c.label}: a run in the switch's top unit, ${d}`);
    }
  }
});

test('the cables of a 1U server rise no higher than its top edge', () => {
  const p = M.createEmptyProject(1);
  const rack = p.floors[0].rows[0].racks[0].id;
  const t = M.addDeviceType(p, { label: 'S1', tag: 'S1', face: 'compute', height: 1, ports: [{ name: 'p', first: 1, count: 11, connector: 'rj45', speedGbps: 1, side: 'rear' }] });
  p.devices.push(M.newDevice({ id: 'sw', type: 'switch-rj45', name: 'sw', reversed: true, loc: { rack, kind: 'u', at: 1 } }));
  for (const [id, at] of [
    ['s3', 3],
    ['s4', 4],
  ])
    p.devices.push(M.newDevice({ id, type: t.id, name: `srv-${at}`, loc: { rack, kind: 'u', at } }));
  const net = C.addNetwork(p, { name: 'Mgmt' }).id;
  let k = 1;
  for (const s of ['s3', 's4']) for (let i = 1; i <= 11; i++) assert.ok(!C.connect(p, { a: { device: s, port: `p${i}` }, b: { device: 'sw', port: `swp${k++}` }, network: net }).error);
  const out = CR.elevation(p, { side: 'rear' });
  for (const id of ['s3', 's4']) {
    const r = out.layout.devices.get(id);
    for (const c of p.cables.filter((x) => x.a.device === id)) {
      const d = new RegExp(`data-cable="${c.id}"[^>]*>(?:<path[^>]*stroke-width="6"[^>]*/>)?<path d="([^"]+)"`).exec(out.body)[1];
      const run = segments(d).find((sg) => sg.y1 === sg.y2);
      assert.ok(run.y1 > r.y && run.y1 < r.y + r.h, `${c.label}: its run at ${run.y1} inside ${r.y}…${r.y + r.h}`);
    }
  }
});
