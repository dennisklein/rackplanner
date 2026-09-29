# Rackplanner

A client-side single-page app for planning datacenter rack layouts. It draws
one to five 19″ racks in elevation view as a schematic drawing sheet, and you place
switches, compute nodes and storage onto them. Devices get their own names and
belong to color-coded clusters, so the equipment that works together stands out.

There is no server and no build step: plain HTML, CSS and JavaScript. Plans are
saved in the browser and can be exported as files.

Live version: https://dennisklein.github.io/rackplanner/ (once GitHub Pages is
enabled, see [Deployment](#deployment)).

Public domain under CC0 1.0: use it for anything, no strings attached. See [License](#license).

## Running it

Open `index.html` in a browser. It also works from `file://`.

Or serve the folder with any static web server:

```sh
npm start            # http://localhost:8080 via http-server
python3 -m http.server
```

It runs as is on any static host.

## What you can plan

| Rack | Units |
| --- | --- |
| 1 to 5 racks, 19″ (3 by default) | 47 height units each, numbered from the top (U1) to the bottom (U47) |
| Side slots | 2 vertical 1U slots per rack, on the right, one above the other |

| Device | Height | Front |
| --- | --- | --- |
| 48-port switch | 1U | 48 × RJ45 |
| 24-port switch | 1U | 24 × QSFP |
| Compute node | 2U | server, drive bays |
| Storage node | 4U | server, 24 × 3.5″ bays |
| Storage enclosure | 4U | JBOD, 2 drawers |

The side slots take 1U devices only, which means the two switch types. Devices
there are drawn rotated.

## Using it

- **Racks**: pick 1 to 5 in the toolbar. New racks are added on the right;
  lowering the number removes racks from the right, together with their
  devices (you're asked first, and Undo brings them back).
- **Place**: drag a device from the left panel onto a rack, or click it and then
  click a free slot. A green outline means it fits; red explains the conflict.
- **Name and cluster**: the placement dialog asks for a name and a cluster
  (a named color). It suggests both from the nearest device of the same type,
  so dropping a node next to `cn-012` offers `cn-013` in the same cluster.
  You can create a new cluster with its own color right there.
- **Several at once**: set a quantity to stack devices downward or upward from
  the drop point. Occupied units are skipped and names count up (`cn-013 … cn-020`).
- **Edit**: select a device to rename it, change its cluster, move it to
  another rack or slot, add notes, duplicate or delete it. Click a rack's
  yellow label to rename it and see its free space.
- **Clusters**: click one in the left panel to highlight its devices. Use the
  pencil icon to rename or recolor it.
- **Move**: drag devices between units, racks and side slots. Hold <kbd>Alt</kbd>
  while dropping to copy instead.
- **Undo** everything with <kbd>Ctrl</kbd>+<kbd>Z</kbd>, redo with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>.

| Shortcut | Action |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move the selected device to the next free position |
| <kbd>←</kbd> <kbd>→</kbd> | Move it to the neighbouring rack |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Duplicate |
| <kbd>Del</kbd> | Delete |
| <kbd>Tab</kbd> | Walk through devices, top to bottom |
| <kbd>0</kbd> / <kbd>1</kbd> / <kbd>+</kbd> / <kbd>−</kbd> | Fit sheet / 100% / zoom |
| <kbd>Ctrl</kbd>+scroll | Zoom at the pointer |
| <kbd>Esc</kbd> | Cancel placing or dragging, or deselect |

Drag the empty sheet to pan.

## Saving and exporting

The current plan is stored in the browser's `localStorage` automatically.
**Export** offers:

- **PNG image** and **SVG drawing** of the whole sheet, with cluster legend and
  title block, always in the light theme.
- **CSV inventory** of every device with rack, position, type, cluster and notes.
- **Plan file (.json)**, which **Open** reads back. You can also copy the plan as
  JSON and paste it into Open on another machine.

Imported files are checked: devices that overlap or don't fit are skipped and
listed in the browser console.

## Project layout

```
index.html        page shell, icons and dialogs
css/app.css       styles, light and dark themes
js/model.js       data model and placement rules (no DOM, shared with tests)
js/render.js      SVG drawing of racks and devices, sheet geometry, hit testing
js/app.js         UI state, undo history, drag and drop, dialogs, export
test/             Node tests for model and renderer
```

## Tests

```sh
npm test
```

This uses Node's built-in test runner (Node 18 or later) and needs no dependencies.

## Deployment

`.github/workflows/pages.yml` runs the tests and publishes the site to GitHub
Pages on every push to `main`. You can also start it by hand from the Actions tab.

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
