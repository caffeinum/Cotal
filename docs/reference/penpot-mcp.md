# Reference: driving Penpot via the MCP plugin

How to build/edit Penpot designs programmatically from this repo's tooling. Practical
notes distilled from the Penpot MCP `high_level_overview`, the official plugin API, and
hands-on use. Not Cotal protocol — this is a workflow reference (hence `docs/reference/`).

## What it is

The **Penpot MCP server** bridges to a live Penpot file *through the Penpot MCP plugin*.
Precondition: the user must open the target file and connect it via the plugin — the MCP
can't open files on its own. Tools:

- **`execute_code`** — runs JavaScript in the Penpot **plugin context** (the main lever).
- **`penpot_api_info`** — fetch API docs for a `type` / `member`.
- **`export_shape`** — render a shape (or `selection` / `page`) to PNG/SVG so you can
  *see* what you built. Use it to verify, not guess.

Official docs: https://help.penpot.app/plugins/ · API: https://penpot.github.io/plugins-runtime/
· samples: https://github.com/penpot/penpot-plugins-samples

## The execution model (`execute_code`)

- Code runs as the **body of a function**: whatever you `return` comes back to you (any
  JS object — no `JSON.stringify`). Exceptions return as their message string.
- **`storage`** is a persistent object across calls. Stash intermediate results *and a
  helper library* (functions) on it — e.g. `storage.txt = function(...) {...}` — and reuse
  them in later calls. This is the key to building incrementally without re-pasting code.
- **`console.*`** output is returned separately. **Never log what you also return** (you'd
  get it twice). Log only when actually debugging.
- Globals available: **`penpot`** (the API), **`penpotUtils`** (helpers — prefer these),
  `storage`.
- Application of some operations (tokens, text auto-resize) is **async** — `await` a ~100ms
  sleep before reading back the result.

## Shape model

- Hierarchy: **Page → Board → Group → leaf shapes** (`Rectangle`, `Text`, `Ellipse`,
  `Path`, `Image`, `Boolean`, `SvgRaw`). `penpot.root` is the current page's root;
  `penpot.currentPage`; `penpotUtils.getPages()` / `getPageByName()` for others.
- **`width`/`height` are read-only** → use `shape.resize(w, h)`.
- **`x`/`y` are absolute** (page coords) and writable. **`parentX`/`parentY` are
  read-only** → position relative to parent with `penpotUtils.setParentXY(shape, px, py)`.
- **`fills`/`strokes`/`shadows` are replace-only arrays** — you can't mutate an element;
  reassign the whole array: `shape.fills = [{ fillColor:"#58A6FF", fillOpacity:1 }]`.
  No fill = `[]`.
- **Colors: uppercase hex** (`"#FF5533"`).
- Create via `penpot.createBoard()`, `createRectangle()`, `createText(str)`,
  `createEllipse()`, `createPath()`. New shapes land on the page root at 0,0 — then
  `parent.appendChild(shape)`.
- Z-order = order in `children`: add background first, foreground later; or
  `bringToFront()` / `setParentIndex(i)`.
- Reparent with `newParent.appendChild(shape)` (preserves absolute x/y). `remove()` is
  **delete**, not reparent.

## Layouts (use them — don't hand-place)

Boards can own a **flex** or **grid** layout; then child x/y are layout-controlled.

- Empty board: `const f = board.addFlexLayout()`. **Board that already has children:** use
  `penpotUtils.addFlexLayout(board, dir)` so existing visual order is preserved.
- Flex props: `f.dir` (`"row"|"column"|...`), `f.rowGap`/`f.columnGap`,
  `f.alignItems`, `f.justifyContent`, padding via `f.verticalPadding`/`f.horizontalPadding`
  (or per-side `topPadding` …).
- **Add children in visual order** with `board.appendChild(child)` (or `insertChild(i,…)`).
- **Container that hugs its content:** set `f.horizontalSizing="auto"` /
  `f.verticalSizing="auto"`. Default `"fix"` keeps the board's own size; `"fill"` stretches
  children to the container.
- **Per-child** control via `child.layoutChild`: `horizontalSizing`/`verticalSizing`
  (`"fix"|"auto"|"fill"`), margins, min/max, `absolute:true` (opt a child out of layout —
  then x/y set *relative* position), `zIndex`.
- **Full-width divider trick** (no real border element): a 1px-tall `Rectangle` with
  `layoutChild.horizontalSizing="fill"` inside a column flex — renders as a divider line.
- Grid: `board.addGridLayout()`, then `board.grid.appendChild(shape, row, col)` (1-based).

## Text

- `const t = penpot.createText("hi")`; the rendered string is `t.characters`.
- **Size = `t.fontSize`** (NOT `resize`, which only changes the box and sets
  `growType="fixed"`). For auto-fit set `t.growType = "auto-width"` (or `"auto-height"`)
  *after* any resize. Auto-size isn't instant — sleep ~100ms before reading `textBounds`.
- Fonts: `penpot.fonts.findByName("Work Sans")`; apply all font props at once with
  `font.applyToText(t, variant)`. `fontFamily` IDs are lowercased internally (e.g.
  `sourcesanspro`) — prefer `findByName` + `applyToText` over setting `fontFamily` raw.
- Style a substring: `t.getRange(start, end)` → set props or `font.applyToRange(range)`.
- Other writable: `fontWeight` (string), `align`, `lineHeight`, `letterSpacing`,
  `textTransform`, `textDecoration`, `fills`.

## Inspecting & verifying

- Overview of a page/board: `penpotUtils.shapeStructure(penpot.root, 3)`.
- Find: `penpotUtils.findShape(pred)` / `findShapes(pred, root)` /
  `findShapeById(id)`. Selection: `penpot.selection` (copy into `storage` immediately —
  it can change).
- **Visually verify with the `export_shape` tool** (`shapeId:"selection"|"page"|<id>`).
  Build a section, export it, adjust — tight loop beats blind construction.
- Generate code from a design: `penpot.generateStyle(shapes,{type:"css"})` /
  `penpot.generateMarkup(...)`.

## Gotchas (learned the hard way)

- Array props are immutable in place — **reassign the whole array**.
- Adding flex to a populated board with `board.addFlexLayout()` (not the `penpotUtils`
  variant) **reshuffles children** by array order.
- Layout overrides manual x/y — if positioning "doesn't work," the parent has a layout;
  change gaps/padding/margins instead.
- `createComponent([shape])` needs shapes **freshly created in the same call and appended
  to `penpot.root` first**; passing existing/cloned/reparented boards yields a broken
  component. No cross-page reparent — main instances land on the active page.
- `penpot.context.deletePluginData()` doesn't exist — set `""` to clear.
- Don't add a text label that just repeats a shape's `name` (Penpot shows the name anyway).

## Minimal recipe — a card with a flex column

```js
const card = penpot.createBoard();
card.name = "Card";
card.resize(280, 120);
card.fills = [{ fillColor: "#161B22", fillOpacity: 1 }];
card.borderRadius = 10;
const f = card.addFlexLayout();
f.dir = "column"; f.rowGap = 6;
f.verticalPadding = 16; f.horizontalPadding = 16;
f.horizontalSizing = "fix"; f.verticalSizing = "auto"; // hug height

const title = penpot.createText("alice");
title.fontSize = 15; title.fontWeight = "600"; title.growType = "auto-width";
title.fills = [{ fillColor: "#E6EDF3", fillOpacity: 1 }];
card.appendChild(title);

const sub = penpot.createText("reviewing PR #42");
sub.fontSize = 12; sub.growType = "auto-width";
sub.fills = [{ fillColor: "#8B949E", fillOpacity: 1 }];
card.appendChild(sub);

penpot.root.appendChild(card);
```

## Suggested workflow

1. Inspect current page (`shapeStructure`) and check fonts.
2. Build a **helper library** in `storage` (text/rect/dot/flexBoard factories) once.
3. Assemble section by section; `export_shape` to verify each before moving on.
4. Keep colors/spacing in a single palette object in `storage` for consistency.
