# Multimine roadmap

Four features, in the order they should land. The first two are planned to the file; the last two
are shaped here and planned in detail when their turn comes, because the plugin API should be
designed against a core that has stopped moving.

| # | Feature | Status |
|---|---|---|
| 1 | Mini IDE + editor-agnostic change tracking | done |
| 2 | Fallback providers | done |
| 3 | Plugin system + Tools grid | done (`docs/plugins.md`) |
| 4 | UI sketcher (the first plugin) | done |
| 5 | Engine targets for the Sketcher, Asset Board, Data Tables | done: `docs/plans/engine-sketcher-assets-data.md` |

---

## 1. Mini IDE

### What it is

A window that slides in from the **left** (the chats come from the right), opened from a new rail
button. Three parts, nothing more:

- **Navigator**: a collapsible folder tree of the project and one search bar. Typing filters by file
  name (fuzzy, instant); a toggle switches to searching *inside* files (`path:line: match`, click to
  open at that line). Ignores `.git`, `node_modules`, build output and `.multimine/sessions`.
- **Editor**: Monaco in tabs. Syntax colouring, find/replace, Ctrl+S, an unsaved dot, and a "changed
  on disk" bar when an agent edits a file you have open (reload / keep mine). No language servers:
  this is for reading and quick fixes, and an **Open in IntelliJ / VS Code** button hands the file to
  your real IDE.
- **Terminal**: below the editor (resizable split), a real shell starting in the project root
  (PowerShell on Windows, the login shell elsewhere). Several terminal tabs. A **+ Claude Code** and
  **+ Codex** button open a terminal already running that CLI, wired to the team (see below).

### Change tracking (works whichever editor made the change)

The point of this feature is that the Context Handler hears about *every* change, not only the
ones agents make.

1. `ProjectWatcher` (main process, chokidar) watches the project, with the same ignores as the
   navigator.
2. Changes made **during an agent's turn** are attributed to that agent and already reach the
   Context Handler through the existing post-turn hook; the watcher skips them (an "agent is
   writing" window per turn).
3. Every other change is a **manual change**. They are collected and, after 2 quiet minutes (or when
   you press **Sync context**), sent to the Context Handler as one batch: the list of files and
   `git diff` for them, kind `context`, from `you`. A badge on the rail button shows how many manual
   changes are waiting.
4. Debounce and batching mean a save-heavy editing session costs one Context Handler turn, not fifty.

### Terminal CLI agents joining the team

- **+ Claude Code** opens `claude` in a new terminal with `--mcp-config` pointing at a fresh bus
  endpoint for a *terminal agent* (`provider: terminal`, created on the fly, shown as an orb with a
  terminal glyph). **+ Codex** does the same through `-c mcp_servers.multimine.url=...`.
- From inside, the CLI has every coordination tool: message or delegate to agents, ask Mastermind,
  report, request permission. Its traffic draws links in space like anyone else's.
- The other direction is deliberately limited: a message *to* a terminal agent is shown as a banner
  in its terminal tab (and in its chat log), not typed into the CLI, because injecting keystrokes
  into a full-screen TUI is fragile. Mastermind therefore does not delegate to terminal agents; it
  is told they are human-driven.
- Closing the terminal removes the terminal agent's orb.

### Files

- `src/main/ide/fs.ts`: `tree(dir)`, `read(path)`, `write(path, text)`, `search(query, inFiles)`
  (reuses `insideProject` and the walker from `orchestrator/workspace.ts`).
- `src/main/ide/terminals.ts`: node-pty sessions keyed by id; `open(kind, cols, rows)`,
  `write`, `resize`, `close`; output streamed to the renderer as `terminal-data` events.
- `src/main/ide/watcher.ts`: `ProjectWatcher` + the manual-change batcher; engine gets
  `notifyAgentWriting(agentId, on)` around each write-capable turn.
- `src/shared/api.ts` / `types.ts`: `ide*` and `terminal*` methods, `terminal-data`,
  `manual-changes` events, `ProviderKind` gains `terminal` (not selectable in the editor).
- `src/renderer/ide/`: `IdeWindow.tsx` (the left window, split layout), `Navigator.tsx`,
  `EditorTabs.tsx` (Monaco, loaded locally - no CDN, the CSP forbids it), `TerminalTabs.tsx`
  (xterm.js + fit addon).
- `LeftRail.tsx`: Code button with the manual-change badge.

### Dependencies

`monaco-editor` (+ `@monaco-editor/react` configured to the bundled copy), `@xterm/xterm`,
`@xterm/addon-fit`, `node-pty` 1.1, `chokidar` 4.

node-pty 1.1 ships N-API prebuilt binaries for Windows (x64/arm64) and macOS, loaded straight from
its `prebuilds/` folder, so it works in Electron without compiling and even with its install script
blocked (on Windows that script only moves an optional `conpty.dll`; the system ConPTY is used by
default). `npm install-scripts approve node-pty` is still recommended. Linux has no prebuild and
compiles with node-gyp. If node-pty fails to load, the IDE opens without the terminal and says why.

### Tests

- Unit: `fs.search` (names and contents, ignores), path escape refused, the batcher (agent window
  excluded, debounce, one batch), terminal session lifecycle (spawn `echo`, read output, close).
- E2E: open the IDE, search a file, open it, edit + Ctrl+S, see the manual-change badge, press Sync
  context and see the Context Handler receive one batch; open a terminal, run `echo hi`, see `hi`.

---

## 2. Fallback providers

### What it is

Each agent gets an ordered **fallback chain** (agent editor; plus a default chain in Settings for
agents without one), e.g. Claude subscription (Opus 5.5) -> Codex subscription (GPT 6 Astra) ->
OpenAI API key. When the active provider is out of usage, the agent continues on the next one.

### When it switches

- **Before the wall (Claude):** the Agent SDK emits `rate_limit_event` with
  `status: allowed | allowed_warning | rejected`, `utilization`, `resetsAt` and `rateLimitType`.
  `allowed_warning` marks the provider as *near limit*; the **next** task an agent starts uses its
  fallback, so most switches happen between tasks and nothing is cut.
- **At the wall (any provider):** a turn ending in a usage error - Claude `rate_limit` /
  `billing_error` / usage-limit text, Codex usage or quota messages, HTTP 429 / 402 / quota /
  insufficient-credit from API vendors, a revoked key (401) - triggers a switch. Ordinary errors
  never do; a real bug must not be retried on a paid key.
- A provider marked exhausted stays skipped until its `resetsAt` (or 1 hour if unknown), then is
  tried again at the next new task. Exhaustion is per provider kind, so every agent on the same
  Claude login switches together.

### Continuing a cut task

When a turn is cut mid-task:

1. The engine builds a **continuation brief** from what it already records: the original task,
   the conversation so far, every tool call with a short result, files changed (`git diff --stat`
   plus the live diff, capped), and the last text written.
2. The fallback continues **in the same reply bubble** after a divider ("↪ switched to GPT 6 Astra
   - Claude usage limit, resets 18:00"), with the brief as its prompt and the instruction to continue
   from there without redoing finished steps.
3. The caller (Mastermind's handoff) is still waiting on the same promise and gets a normal report:
   nothing upstream sees an error.

### The money guardrail

- Subscription -> subscription switches are automatic.
- Switching onto a **pay-per-use API key** asks first, as a balloon over the agent ("Claude limit
  reached. Continue on your OpenAI key?" Allow / Deny / **Always for this agent**). "Always" is
  stored on the agent (`fallbackPaidOk: true`) and makes later switches silent.

### What you see

The orb's subtitle and the chat header show the fallback in sky blue with a ↪ ("↪ GPT 6 Astra
(fallback)"), the same way economy mode shows ⚡ in amber. A toast says when a provider runs out and
when it is back. Settings shows each provider's state (ok / near limit / exhausted until HH:MM).

### Files

- `src/shared/types.ts`: `AgentSpec.fallback: { provider, model, effort }[]`,
  `AgentSpec.fallbackPaidOk`, `AppSettings.defaultFallback`; status event gains `fallback`.
- `src/shared/agentFile.ts`: read/write the chain in frontmatter.
- `src/main/providers/limits.ts` (pure): `isUsageError(provider, message)` per provider, and a
  `ProviderHealth` map (near / exhausted / until) fed by errors and rate-limit events.
- `src/main/providers/claudeCli.ts`: forward `rate_limit_event` as a new `limit` agent event.
- `src/main/orchestrator/continuation.ts` (pure): `buildBrief(task, history, tools, diff, partial)`.
- `src/main/orchestrator/engine.ts`: `runTurn` picks the first healthy provider in
  `[own, ...fallback]`; on a usage error it records exhaustion, asks the money question when the
  next hop is paid, and loops into the next provider with the brief, appending to the same reply.
- UI: chain editor in `AgentEditor` (add/reorder/remove hops with provider/model/effort), default
  chain + provider health in Settings, sky-blue ↪ in `SpaceStage`/`ChatDock`.

### Tests

- Unit: `isUsageError` on real error strings from each provider (and a normal error rejected),
  health expiry, `buildBrief` contents and caps, `runTurn` with a mock that fails with a usage error
  mid-turn: the same reply continues on the fallback, the caller gets one report, the paid hop asks
  once and "always" stops it asking.
- E2E: an agent whose mock primary reports a usage limit shows the ↪ label and finishes the task.

---

## 3. Plugin system (shaped)

- A plugin is a folder (`~/.multimine/plugins/<id>/` or per project `.multimine/plugins/`): a
  `plugin.json` manifest (name, version, icon, rail button, requested permissions, API version), a
  panel (an HTML page) and optionally an MCP server for custom agent tools.
- Panels run **isolated** (sandboxed iframe / separate web contents, no Node, no access to the app's
  memory) and talk to Multimine only through a small versioned message API: open a window, send to
  Mastermind or an agent, read/write project files, show media, read the team - each gated by a
  permission the user approved at install.
- Custom tools ride the existing MCP machinery: the plugin's server is registered like any MCP
  server and assigned to agents.
- Keys and subscriptions are never reachable from a plugin.

## 4. UI sketcher (shaped, built as the first plugin)

- A wireframe editor in its own window: typed boxes (window, panel, layer, button, label, slot,
  image, list, slider, text field) you drag, resize and nest, a properties panel, a grid, undo.
- Platform presets: **Minecraft GUI** (GUI-pixel grid, 176x166 containers, 18px slots, scale),
  web, desktop.
- **Send** exports both a PNG of the sketch and a structured JSON (tree, sizes, positions, anchors,
  text, states) to Mastermind, which creates or reuses a **UI Creator** agent and delegates.
- Previews: an instant mockup rendered by the sketcher from the JSON in the target style, then the
  real thing - the UI Creator runs the project's own capture (magical-mod's `-PautoScreenshot`)
  after implementing, and the screenshot lands in the gallery, where it can be marked up and sent
  back as a revision.
