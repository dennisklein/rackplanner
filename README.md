# Rackplanner

A client-side single-page app for planning datacenter rack layouts. Racks stand
in rows, rows on floors, and each row is drawn in elevation view as a
schematic drawing sheet. You place switches, servers, storage and anything
else from a catalog you can extend, and track space, power and weight
against each rack's budget. Devices get their own names and belong to
color-coded clusters, so the equipment that works together stands out.

There is no server and no build step: plain HTML, CSS and JavaScript. Plans are
saved in the browser, work offline, and can be exported as files or shared as
links.

Live version: https://dennisklein.github.io/rackplanner/ (once GitHub Pages is
enabled, see [Deployment](#deployment)).

Public domain under CC0 1.0: use it for anything, no strings attached. See [License](#license).

## Running it

Open `index.html` in a browser. It also works from `file://`, except that
there is no offline cache and share links point at the file on your own disk.

Or serve the folder with any static web server:

```sh
npm start            # http://localhost:8080 via http-server
python3 -m http.server
```

It runs as is on any static host.

## What you can plan

| Level | Limits |
| --- | --- |
| Floors | 1 to 6 per plan |
| Rows | 1 to 8 per floor |
| Racks | 1 to 16 per row, 19″, 10U to 60U high, numbered from the top (U1) down |
| Side slots | 0 to 4 vertical 1U slots per rack, on the right, depending on its height |

Every rack has a **rack type**: its height, number of side slots, power budget
and maximum load. New plans come with a 47U rack (the default, 12 kW, 1200 kg),
a 42U rack and a 48U high-density rack.

**Device types** come from the plan's catalog. New plans start with these:

| Device | Height | Front |
| --- | --- | --- |
| 48-port switch | 1U | 48 × RJ45 |
| 24-port switch | 1U | 24 × QSFP |
| Compute node | 2U | server, drive bays |
| Storage node | 4U | server, 24 × 3.5″ bays |
| Storage enclosure | 4U | JBOD, 2 drawers |

The catalog editor adds more, from templates (1U server, GPU server, patch
panel, PDU, UPS, blanking panel, generic device) or from scratch: pick a
name, height (1U to 20U), a drawing style, typical power draw and weight.
**Reserved space** is always available too: a hatched placeholder of any height
that keeps units free for planned equipment and can carry the power it will draw.

The side slots take 1U devices only. Devices there are drawn rotated, which
makes a 1U PDU look like a vertical power strip.

## Using it

- **Move around**: the bar above the drawing has a tab per floor, the row
  picker with previous and next buttons, and a switch between the
  **Elevation** of the current row and the **Floor map**. The floor map shows
  every row of a floor with a small drawing of each rack and a meter for
  space, power or weight; click a rack to open it, a row name to see its
  elevation.
- **Search**: type in the search box (or press <kbd>/</kbd>) to find floors,
  rows, racks and devices. Devices are found by name, type, cluster, serial
  number, asset tag, IP address or owner. Pick a result to jump there. While
  the search is on, matching devices stay highlighted in the drawing and
  marked on the floor map.
- **Place**: drag a device from the left panel onto a rack, or click it and then
  click a free slot. A green outline means it fits; red explains the conflict.
- **Name and cluster**: the placement dialog asks for a name and a cluster
  (a named color). It suggests both from the nearest device of the same type,
  so dropping a node next to `cn-012` offers `cn-013` in the same cluster.
  You can create a new cluster with its own color right there.
- **Several at once**: set a quantity to stack devices downward or upward from
  the drop point. Occupied units are skipped and names count up (`cn-013 … cn-020`).
  Tick **Spread evenly across racks** to share them out over the racks of
  the row you pick; a rack that runs out of space leaves the rest to the others.
- **Edit a device**: select it to rename it, change its cluster, move it to any
  rack in the plan, and fill in its serial number, asset tag, IP address,
  owner and notes. Power and weight come from its type unless you enter
  its own values.
- **Select several**: <kbd>Shift</kbd>-click devices, <kbd>Shift</kbd>-drag
  across the empty sheet, press <kbd>Ctrl</kbd>+<kbd>A</kbd> for the whole row,
  or use the select buttons on a rack, row or cluster. Then move them
  together (drag, or the arrow keys), duplicate them, give them one cluster
  or owner, rename them in series or delete them.
- **Duplicate**: <kbd>Ctrl</kbd>+<kbd>D</kbd> (or the Duplicate button) copies
  whatever is selected. A device or a group of devices is copied into the
  nearest free space, below it first, then above, then in the neighbouring
  racks, keeping the group's layout; names continue each series (`cn-013`,
  `cn-014`). A rack, row or floor is copied with all its devices and
  inserted right after the original.
- **Racks, rows and floors**: click a rack's yellow label to rename it, change
  its type, move it left or right, insert a rack beside it, duplicate it,
  move it to another row or delete it. The dashed **Add rack** slot at the end of a row
  adds one. Row and floor settings (from the row picker, the pencil on the
  floor map, or a click on the active floor tab) rename, reorder, move and
  delete them, and show their totals.
- **Catalog**: the **Catalog** button above the devices edits device and
  rack types. Changes apply at once and are checked: a type can't grow if its
  devices would then overlap or stick out of their racks.
- **Power and weight**: rack labels show units and kW used; a second bar fills
  toward the power budget and turns red, with a “!”, when a rack is over its
  power or weight budget. The inspector shows the numbers for a rack, row,
  floor or the whole plan.
- **Clusters**: click one in the left panel to highlight its devices. Use the
  pencil icon to rename or recolor it.
- **Move**: drag devices between units, racks and side slots. Hold <kbd>Alt</kbd>
  while dropping to copy instead.
- **Undo** everything with <kbd>Ctrl</kbd>+<kbd>Z</kbd>, redo with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>.

| Shortcut | Action |
| --- | --- |
| <kbd>/</kbd> or <kbd>Ctrl</kbd>+<kbd>K</kbd> | Search |
| <kbd>[</kbd> <kbd>]</kbd> | Previous, next row |
| <kbd>M</kbd> | Floor map on or off |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move the selected devices to the next free position |
| <kbd>←</kbd> <kbd>→</kbd> | Move them to the neighbouring rack |
| <kbd>Shift</kbd>+click, <kbd>Shift</kbd>+drag | Add to the selection, select an area |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | Select every device in the row |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Duplicate the selected devices, rack, row or floor |
| <kbd>Del</kbd> | Delete |
| <kbd>Tab</kbd> | Walk through devices, top to bottom |
| <kbd>0</kbd> / <kbd>1</kbd> / <kbd>+</kbd> / <kbd>−</kbd> | Fit sheet / 100% / zoom |
| <kbd>Ctrl</kbd>+scroll | Zoom at the pointer |
| <kbd>Esc</kbd> | Cancel placing or dragging, deselect, clear the search |

Drag the empty sheet to pan.

## Saving, sharing and exporting

Plans are saved in the browser's `localStorage` as you work. **Plans** lists
every plan in this browser to open, duplicate or delete; **New** starts an
empty plan, one with the current layout but no devices, or the example.
Plans saved by earlier versions are moved into the list automatically.

**Export** offers:

- **PNG image** and **SVG drawing** of the current row, with cluster legend and
  title block, always in the light theme.
- **Print or PDF**: one sheet per row, for the current row, floor or the whole
  plan, on A4, A3, Letter, Legal or Tabloid. The title block names the site,
  floor and row, author, revision, date and sheet number; fill these in on the
  plan overview (click the empty sheet to see it).
- **CSV inventory** of every device with floor, row, rack, position, type,
  cluster, serial number, asset tag, IP address, owner, power, weight and notes.
- **Plan file (.json)**, which **Open** reads back as a new plan. You can also
  copy the plan as JSON and paste it into Open on another machine.
- **Share link**: the whole plan, compressed into the link itself. Whoever opens
  it gets their own copy in their browser; nothing is uploaded. Very large
  plans make long links, so send the file instead if a chat program cuts it off.

**Open** also imports a **CSV inventory**, into a new plan or added to the
current one. It needs Rack, Position (`U12`, `U12-13` or `Side V1`) and Name or
Type columns; Floor, Row, Height, Cluster and the other columns of the export
are used when present. Missing floors, rows, racks and clusters are created by
name, and unknown types become generic types of the given height. Comma,
semicolon and tab separators all work.

Imported files are checked: devices that overlap or don't fit are skipped, and
everything that needed fixing is listed after the import.

## Offline

The fonts are part of the app, and a service worker keeps a copy of all files,
so once the site has been opened it also works without a network. New
versions are picked up on the next visit while online.

## Project layout

```
index.html           page shell, icons and dialogs
css/app.css          styles, light and dark themes, print layout
css/fonts.css        the bundled web fonts
fonts/               Barlow, Barlow Condensed, IBM Plex Mono (SIL OFL 1.1)
js/model.js          data model: floors, rows, racks, catalogs, placement rules, stats, search
js/io.js             plan files (all versions), CSV export and import, share links
js/render.js         SVG drawing of a row, device fronts, sheet geometry, hit testing
js/library.js        plans saved in the browser
js/app.js            UI state, undo history, navigation, drag and drop, dialogs, export
sw.js                service worker for offline use
manifest.webmanifest, icon.svg   installable web app
test/                unit tests for model, io, library and renderer
e2e/                 browser tests (Playwright) and their static server
```

`model.js`, `io.js`, `render.js` and `library.js` have no DOM access and run in
Node as well as in the browser.

## Tests

```sh
npm test             # unit tests: placement, catalogs, import, CSV, drawing (no dependencies)
npm ci               # once, for the browser tests
npm run test:e2e     # browser tests: drive the app in Chromium via Playwright
```

The unit tests use Node's built-in test runner (Node 18 or later). The browser
tests in `e2e/` start a small static server and cover dragging, placing and
spreading, navigation and search, the floor map, the catalog editor, rack
types and budgets, selecting and moving several devices, reserved space, the
plan list, share links, CSV and plan file import, printing, exports, offline
caching and the phone layout. If Chromium is missing, install it with
`npx playwright install chromium`. The app itself has no dependencies;
Playwright is only needed to run these tests.

## Deployment

`.github/workflows/pages.yml` runs the unit and browser tests and publishes the
site to GitHub Pages on every push to `main`. Nothing is deployed if a test fails. You can also start it by hand from the Actions tab.

It needs a one-time setup in the repository settings:

1. **Settings → Pages → Build and deployment → Source**: choose **GitHub Actions**.
2. **Settings → General → Default branch** should be `main`. The `github-pages`
   environment only accepts deployments from the default branch unless you add
   other branches under **Settings → Environments → github-pages**.

GitHub Pages for a private repository needs a paid GitHub plan; on the free plan
the repository has to be public.

## License

[![CC0](https://licensebuttons.net/p/zero/1.0/88x31.png)](https://creativecommons.org/publicdomain/zero/1.0/)

Rackplanner is dedicated to the public domain under
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).
To the extent possible under law, the authors have waived all copyright and
related rights to this work. You can copy, modify, distribute and use it, even
commercially, without asking permission or giving credit. The full legal text
is in [LICENSE](LICENSE).

The bundled fonts in `fonts/` are not part of that dedication: Barlow, Barlow
Condensed and IBM Plex Mono are licensed under the SIL Open Font License 1.1,
see [fonts/OFL.txt](fonts/OFL.txt).
