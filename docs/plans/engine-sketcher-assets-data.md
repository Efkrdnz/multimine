# Engine-ready UI Sketcher, Asset Board, Game Data Tables

## Context

The UI Sketcher shipped Minecraft-first: its element set (slots, inventory stamp), starter and only
hand-drawn style assume a Minecraft GUI, and web/mobile/desktop are thin presets. The user wants a UI
tool for game development and apps generally, with **Godot, Unity and Unreal** as the targets that
matter now. They also chose two new tools: an **Asset Board** and **Game Data Tables**. Order:
(C) generalise the Sketcher, (D) Asset Board, (E) Data Tables; commit and push after each. All three
stay built-in "native plugins" that go only through the plugin API (`api().pluginCall`), like the
Sketcher today. Web/mobile/desktop/Minecraft keep working as targets; nothing existing is dropped.

## C. Sketcher: targets instead of presets

### Target model (`src/shared/sketch/targets.ts`, replaces `presets.ts`)
`Target { id, label, family: 'game' | 'app', engine, sizes: {label,w,h}[] (first = design size),
units, grid, scale, style, elements: ElementType[], starter(), build: string[], capture: string[] }`

| Target | Design size + previews | Build brief | Capture brief |
|---|---|---|---|
| Godot | 1920x1080; 1280x720, 2560x1440, 1080x1920 | Control scene `.tscn`: anchors + offsets map 1:1 from the sketch, a Theme resource, containers for lists | run the scene with a tiny capture script (`get_viewport().get_texture().get_image().save_png`) then quit; `show_media` |
| Unity | 1920x1080 (Canvas Scaler reference); same previews | UI Toolkit UXML + USS by default, UGUI prefab if the project already uses UGUI (agent checks) | play-mode/editor script with `ScreenCapture`; best effort, say why if not possible |
| Unreal | 1920x1080; same previews | C++ `UUserWidget` building its tree in code (UMG `.uasset` cannot be written as text), or Slate; marked least reliable | `-game` + `HighResShot` via automation; best effort |
| Minecraft | 427x240 (existing) | existing | existing |
| Web / Mobile / Desktop | existing sizes + breakpoints (1440, 1024, 390) | project's frontend stack | Playwright screenshot of the route |

- **Auto-detect** (pure `detectTarget(rootNames, readText)`): `project.godot` → Godot;
  `Assets/` + `ProjectSettings/` → Unity; `*.uproject` → Unreal; Gradle mentioning
  neoforge/fabric/forge → Minecraft; `package.json` → Web. New-sketch menu preselects it, user can
  change.
- **Schema 2**: `Sketch.target` replaces `preset`; `parseSketch` migrates schema 1 (`preset` ids
  are target ids). `exportJson` adds `engine`, `sizes` and per-element `stretch`.

### Elements
Add 12 types to `ELEMENT_TYPES`, each with sizes per family, wireframe + styled drawing in
`draw.ts`, an icon in `icons.tsx`, and a line in `summary`:
- Game: `bar` (health/mana/xp, colour + value), `icon`, `ability` (slot with key label + cooldown
  sweep), `minimap`, `dialogue` (portrait, speaker, text), `crosshair`, `joystick`, `toast`.
- App/common: `tabs`, `dropdown`, `toggle`, `modal`.
Palette shows the target's `elements` list (Minecraft keeps slots + inventory stamp; engines get the
game set + common).

### Anchors that mean something
- `SketchElement.stretch?: { x?: boolean; y?: boolean }` plus the existing 9 anchors.
- Pure `layoutAt(sk, w, h)`: re-lays every element at another screen size by keeping its offset from
  its anchor point in its parent (stretching where set). This is how Godot, Unity and Unreal all
  resolve anchors, so the brief maps directly.
- **Sizes strip** in the Mockup tab: the styled mockup at every target size side by side.
- **Safe-area overlay** for game targets (toggle, default 5%), drawn in the canvas only.
- Properties panel: anchor picker gains stretch toggles.

### Look
- New procedural `game` style in `draw.ts`: dark translucent rounded panels, a gold/teal accent,
  bars with a bevel, ability slots with key caps.
- The toolbar toggle reads the target's style name.
- `paint.ts` and `OpsSvg.tsx` are unchanged (ops-driven).

### Brief
- `sketchBrief` takes the target's `build`/`capture` lines.
- `multimine.md` may override them; the brief tells the agent to prefer it.
- `templates/agents/ui-creator.md` names the three engines and their anchor mapping.

Files: `src/shared/sketch/{targets,model,draw,brief}.ts`, `src/renderer/tools/sketcher/{Sketcher,Panels,Canvas,icons}.tsx`,
`templates/agents/ui-creator.md`, `tests/unit/sketch.test.ts`.

## D. Asset Board (built-in plugin `asset-board`)

- **Data**: `.multimine/assets/board.json` (committable).
  - `style` (palette, style text, reference media)
  - `assets[]`: `{ id, name, kind (sprite, texture, icon, model, sound, music, ui, vfx), spec
    (size, format, poly budget, duration, notes), targetPath, status (wanted → requested → review →
    approved / rejected), candidates[], chosen, history[] }`
- **Pure core** `src/shared/assets/board.ts`:
  - parse/validate and status transitions
  - `suggestPath(engine, kind, name)`: Godot `assets/...`, Unity `Assets/Art/...`, Unreal
    `Content/...` (raw source for import), Minecraft `src/main/resources/assets/<modid>/textures/...`
  - the request/revision briefs
  - `matchCandidates(media)`: gallery items titled `asset:<id> ...` attach to that asset.
- **UI** `src/renderer/tools/assets/`:
  - columns Wanted / In progress / Review / Done
  - cards with thumbnails (read through `files.read` base64; models/audio get a typed placeholder
    and an "open in gallery" hint)
  - a detail drawer for spec, path and style
  - Add / Duplicate / Delete.
- **Request** sends the Asset Creator (by role, else Mastermind is asked to create one) the spec plus
  the style guide. It tells it to `show_media` each result titled `asset:<id>` and **not** write into
  the project.
  - While open, the board polls `media.list` every 3 s and moves assets with new candidates to
    Review.
- **Approve** copies the chosen candidate into `targetPath` (`files.read` base64 → `files.write`).
  - Optional "fit to spec" resize for images: nearest-neighbour for pixel art.
- **Reject with a note** sends a revision brief.
- Manifest permissions: team:read, agents:message, project:read, project:write, media:read.

## E. Game Data Tables (built-in plugin `data-tables`)

- **Find files**: walk with `files.list` (depth 6, 2000 entries) for `.json`, `.csv` and `.tsv`.
  - JSON qualifies as an array of objects, an object of objects keyed by id, or an object with one
    such array.
  - Searchable file list.
  - Godot `.tres` and Unity `.asset` are out of scope for v1, and the tool says so.
- **Pure core** `src/shared/data/table.ts`:
  - shape detection → rows, and an exact serialiser back to the same shape
  - keeps key order, indentation (2, 4 or tab) and the trailing newline
  - CSV/TSV per RFC 4180 (quotes, delimiter kept)
  - column type inference: int, number, bool, enum (≤12 distinct values), string, list/object as JSON
  - validation: type mismatches, duplicate ids
  - a changed-cells summary.
- **UI** `src/renderer/tools/data/`:
  - grid with sticky header, sort, filter
  - typed cell editors; add/duplicate/delete rows; undo
  - a min/max/mean strip per numeric column
  - an SVG chart panel: bar chart of one column by row label, or a scatter of two columns
  - save; on focus and every 3 s it re-reads the file: reload when there are no local edits, else a
    "changed on disk" bar (as in the IDE).
- **Ask an agent**: selected rows/columns plus a prompt go to a chosen agent. The message carries
  the path, column types and selected rows, and asks it to edit the file directly and report. The
  table reloads when the file changes.
- Manifest permissions: project:read, project:write, team:read, agents:message.

## Shared changes

- `src/main/plugins/registry.ts` `BUILTIN`: add the two manifests (glyphs `Boxes` / `Table2`,
  gradients).
- `ToolWindow.tsx` `NATIVE`: map both ids to lazy components.
- README, `docs/roadmap.md`, `docs/plugins.md` (built-in list).

## Verification

- **Unit** (Vitest):
  - Sketcher:
    - schema 1 → 2 migration
    - `detectTarget` on Godot/Unity/Unreal/Minecraft/web roots
    - `layoutAt` at each anchor, with and without stretch
    - every new element drawn in every look
    - briefs carry the engine lines
  - Asset Board:
    - status transitions
    - `matchCandidates`
    - `suggestPath` per engine
    - brief contents
  - Data Tables:
    - round-trip byte-identical for untouched JSON (array, keyed object, wrapped) and CSV with quotes
    - type inference and validation
    - changed-cells summary
- **E2E** (Playwright, mock agents, temp project):
  - Sketcher:
    - a temp Godot project (`project.godot`) is detected
    - draw a health bar, an ability bar and a dialogue box
    - the Sizes strip shows each resolution
    - send, then the brief on the bus names Godot
  - Asset Board:
    - add a sprite, request it, then simulate the Asset Creator with
      `mm.api` media + an `asset:<id>` title
    - the card moves to Review
    - approve writes the file at its target path
  - Data Tables:
    - open `data/items.json` and edit a number
    - save keeps the formatting
    - ask an agent, then a message on the bus
  - Screenshots of each.
- `npm run typecheck`, `npm test`, `npm run build`, `xvfb-run -a npx playwright test`.
