# Tools launcher, plugin system, UI Sketcher

> Historical: written for the multi-agent version (Mastermind, roles, the Map), kept for its
> reasoning. The tools now send their work to a chat; see `simplify.md`.

## Context

The left rail is filling up (Create agent, Inbox, Media, Context, Code, Repository, Mastermind,
Settings) and more tools are coming. The user wants a single **Tools** button that opens an
iPhone-style grid of app icons, the **plugin system** (third parties add their own tools without
forking), and the **UI Sketcher** as the first tool: draw a GUI wireframe, send it to Mastermind,
which has a UI Creator agent build it and return a real preview. Decision taken: nothing on the rail
moves; the rail gains one Tools button and the grid holds the Sketcher and plugins.

Order: (A) Tools launcher + plugin host, (B) UI Sketcher on top of the same API. Commit and push
after each, as before.

## A1. Tools launcher (iPhone-style grid)

- Rail: a **Tools** button (`LayoutGrid` icon) above Settings in `src/renderer/panels/LeftRail.tsx`.
- `src/renderer/tools/ToolsGrid.tsx`: a popover anchored to the button that springs open (scale +
  fade from the button's corner), backdrop blurred. A 4-column grid of rounded-square icons
  (gradient background, glyph, soft shadow and highlight) with the label under each, iOS-style.
  - Tiles: every enabled plugin (built-in UI Sketcher first), then **Install** (+) and **Manage**.
  - **Edit** mode (long press or the Edit button): tiles wiggle, user plugins get a remove badge,
    tiles can be dragged to reorder (order saved in settings). Built-in tiles cannot be removed.
  - Esc / click outside closes; arrow keys + Enter work.
- A tool opens its **tool window** (`src/renderer/tools/ToolWindow.tsx`): resizable, from the left
  like the code window (it shares the `data-left-drawer` band logic), with a maximise toggle for big
  canvases. The code window and drawers tuck away when a tool opens, as they already do for each
  other.

## A2. Plugin system

### What a plugin is
A folder with `plugin.json`:
```json
{
  "id": "hello", "name": "Hello", "version": "1.0.0", "api": 1,
  "description": "...",
  "icon": { "glyph": "Sparkles", "gradient": ["#f472b6", "#8b5cf6"] } | "icon.png",
  "entry": "index.html",
  "window": { "width": 900, "height": 640 },
  "permissions": ["project:read", "agents:message"],
  "mcp": { "command": "node", "args": ["server.js"], "env": {} }
}
```
Locations: built-in (shipped in the app), user (`<userData>/plugins/<id>`), and project
(`.multimine/plugins/<id>`, which never runs until the user enables it, since a cloned repo could
carry one).

### Isolation (the hard rule)
- A plugin page runs in an `<iframe sandbox="allow-scripts">` (no same-origin, so it cannot touch
  the app's memory, IPC or keys), served by a new privileged scheme `mmplugin://<id>/...` from the
  plugin's folder (`src/main/index.ts`, next to the existing `mm://` handler), with a strict CSP
  response header: scripts and styles only from its own folder, images also `data:`/`blob:`, and
  `connect-src 'none'` unless the plugin holds the `network` permission.
- It talks to Multimine only through `postMessage`. The renderer's host
  (`src/renderer/tools/PluginHost.tsx`) knows which plugin sent a message by the iframe's window,
  forwards `{plugin, method, args}` to main over one IPC method `pluginCall`, and posts the result
  back. Main (`src/main/plugins/api.ts`) checks the plugin's **granted** permissions on every call.
- An SDK script served at `mmplugin://sdk/multimine.js` gives plugin pages a promise API
  (`window.multimine`).

### API v1
| Call | Permission |
|---|---|
| `info()` (plugin id, API version, project name) | none |
| `storage.get/set(key, value)` (the plugin's own store) | none |
| `ui.toast(text)`, `ui.setTitle(t)`, `ui.close()` | none |
| `team.list()` | `team:read` |
| `send(to, text, {attachments})` to `mastermind` or an agent; drawn on the bus as a link | `agents:message` |
| `files.list(dir)`, `files.read(path)` (text or base64) | `project:read` |
| `files.write(path, data)` | `project:write` |
| `media.show(path or dataURL, title)`, `media.list()` | `media:write` / `media:read` |
| outgoing HTTP from the page | `network` |

Paths reuse `insideProject` (`src/main/orchestrator/workspace.ts`); sends reuse
`Engine.send`/`logBus`; media reuses `MediaStore` (`src/main/media/capture.ts`). Keys,
subscriptions and settings are never reachable.

### Custom agent tools
`mcp` in the manifest registers the plugin's MCP server as an `McpServerConfig` with id
`plugin-<id>`, so it appears on the MCP server cards and in the agent editor like any other server
(the existing `McpHub` and CLI wiring do the rest). It is removed when the plugin is disabled.

### Install, consent, manage
- **Install** tile: pick a folder (or a `.zip`); the manifest is validated (`src/main/plugins/manifest.ts`,
  pure) and copied to `<userData>/plugins/<id>`.
- First enable (and any new permission in an update) shows a **consent dialog** listing what the
  plugin asks for in plain words. Grants are stored per plugin in `AppSettings.plugins`
  (`{ enabled, granted[], order }`).
- **Manage** tile: list of plugins with version, source, permissions (revoke individually),
  enable/disable, uninstall (user plugins), "Open folder".
- `docs/plugins.md` (manifest, API, security model) and `examples/plugins/hello/` (a page that lists
  the team and messages Mastermind).

### Built-in plugins
The UI Sketcher ships with the app and is listed as a plugin, but renders as a first-party React
component (no iframe build pipeline). It still goes **only through the plugin API** (an in-process
adapter calling the same permission-checked handlers), with a manifest declaring its permissions.
That keeps the API honest: anything the Sketcher needs, a third-party plugin can have too.

## B. UI Sketcher

### Canvas
- `src/renderer/tools/sketcher/`: an SVG canvas with zoom/pan, a grid, and snapping to grid, to
  element edges and centres.
- Element types: window, panel, layer (group), button, label, text field, slot, slot grid, image,
  list, slider, checkbox, progress bar, tooltip.
- Tools: select, draw (one per type), move, resize handles, nest by dropping into a container,
  duplicate, copy/paste, arrow-key nudge, delete, **undo/redo** (command stack).
- **Layers panel**: the element tree (rename, reorder, show/hide, lock).
- **Properties panel**: name, text, x/y/w/h in target units, anchor, z-order, states
  (normal/hover/pressed/disabled, as notes), free notes.
- Sketches save to `.multimine/sketches/<name>/` (`sketch.json`, `sketch.png`, `mockup.png`); a
  sketch list to reopen them.

### Platform presets
- **Minecraft GUI**: GUI-pixel units shown at scale 3, a 176x166 container by default, an 18px slot
  snap, a "player inventory" stamp (3x9 + hotbar), and a screen frame of 427x240 (1280x720 at GUI
  scale 3) for HUD and full-screen menus.
- **Web**: 1440x900 / mobile 390x844, 8px grid.
- **Desktop**: 1280x800, 8px grid.

### Export and send
- **Export** writes `sketch.json`, a wireframe PNG and a styled **mockup PNG**:
  - `sketch.json`: schema version, preset, canvas size, and the element tree with exact geometry in
    target units, text, anchors, states and notes.
  - The mockup is drawn procedurally in the preset's style; for Minecraft that means bevelled grey
    panels, inset slots and bevelled buttons. No Mojang textures or fonts are shipped.
- **Send to Mastermind** (with a note): the message carries the paths and a compact summary of the
  JSON, and asks Mastermind to reuse or create a **UI Creator** agent with the brief the plugin
  provides. The brief covers three steps:
  1. Implement the GUI from `sketch.json` exactly, matching the project's existing screens.
  2. Run the project's own capture (found through `multimine.md` and the context map; for
     magical-mod, `-PautoScreenshot`).
  3. `show_media` the real screenshot, then report.

### Revisions
- The **Revisions** tab lists that sketch's screenshots from the gallery.
- Open one and mark it up (rectangles, arrows, text) on an overlay.
- **Send revision** goes to the UI Creator with the marked-up image and the notes.

## Files (main ones)

- `src/main/plugins/manifest.ts` (pure validation), `registry.ts` (discover/install/enable/grants),
  `api.ts` (permission-checked handlers), `protocol.ts` (`mmplugin://` + CSP), SDK at
  `src/main/plugins/sdk/multimine.js`.
- `src/shared/types.ts` / `api.ts`: `PluginManifest`, `PluginState`, `pluginList/pluginInstall/
  pluginSetEnabled/pluginGrant/pluginRemove/pluginCall`, `AppSettings.plugins`.
- `src/renderer/tools/ToolsGrid.tsx`, `ToolWindow.tsx`, `PluginHost.tsx`, `ConsentDialog.tsx`,
  `ManagePlugins.tsx`, `sketcher/*` (canvas, layers, properties, presets, export, mockup,
  revisions).
- `src/renderer/index.html`: CSP gains `frame-src mmplugin:`.
- `package.json` build: ship built-in plugin manifests and the SDK.

## Verification

- Unit: manifest validation (good, bad, newer API version refused), permission checks for every
  API method (granted / not granted / revoked), path escapes refused, MCP registration on
  enable/disable, sketch JSON (de)serialisation and the Minecraft preset geometry, mockup render
  dimensions.
- E2E (Playwright, mock agents):
  - Tools grid: open it, enter Edit mode, close it.
  - Install `examples/plugins/hello`: consent, then its page lists the team and its message reaches
    Mastermind (a link on the bus).
  - Revoke `agents:message`: the call is refused.
  - Sketcher: draw a window with a button and a slot grid, then export (files on disk), then send
    (Mastermind receives the paths).
  - Screenshots of the grid, the consent dialog, the Sketcher and the mockup.
- `npm run typecheck`, `npm test`, `npm run build`, `xvfb-run -a npx playwright test`.
