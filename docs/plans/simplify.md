# Simplify: one agent per chat, the tools around it

## Context

Multimine grew into a team of agents around a Mastermind: roles, delegation, a council, an approval
gate, a Context Handler, an inbox and a space map. That layer is what costs the most usage, confuses
a first-time user and breaks in the oddest ways, and the last commits were spent routing around it
(a fast path past the Planner, one approval, batched context updates).

The decision: Multimine becomes a **chat-first desktop app for Claude Code, Codex and API models**,
in the spirit of T3 Code, with what nobody else has kept in: the **UI Sketcher, Asset Board, Logic
Board, Data Tables**, the **plugin system**, the **code window**, the **git panel**, and the
**usage savers**. The multi-agent version is kept, unchanged, on the `archive/multi-agent` branch
(commit `256774b`).

The one-line pitch after this plan: *a fast GUI for your coding agents, with game-dev tools built in
and plugins for more.*

## What stays, what goes

| Keep | Change | Remove |
|---|---|---|
| Providers: Claude (Agent SDK), Codex, API keys, Mock | Agents become **chats** (threads) | Mastermind and roles |
| Warm sessions, retry, fresh context | Economy mode loses Mastermind's ratings | Delegation, `message_agent`, `report`, handoffs |
| Fallback providers, paid-key consent | Plugin API v2 (v1 kept as aliases) | Council, approval gate, automation mode |
| Usage pill, plan gauge, loop guard, usage budget | Tools send to a chat, with their own brief | Context Handler, context batching |
| CLAUDE.md outline (`projectDoc`) | Questions and approvals live in the chat | Inbox panel, team wizard, agent editor |
| Plugins, Tools grid, the four tools | Sidebar = project, chats, tools | Space map (see Decisions) |
| Code window, git panel, media gallery | `multimine.md` stays as shared instructions | Role templates in `templates/agents/` |
| MCP servers (external and plugin-provided) | Bus server keeps two tools | |
| Desktop notifications, permission prompts | | |

Roughly 4,000 of the ~24,000 lines go outright (`space/`, council, inbox, wizard, editor,
templates), and `engine.ts` should drop from 1,335 lines to about 600.

## The new core model

- A **project** is a folder. A project has **chats**. A chat is one agent session: provider, model,
  effort, access (**Read only / Supervised / Full access**), optional plan mode, MCP servers and an
  optional fallback chain. Several chats can run at once, each with its own status in the sidebar.
- What `AgentSpec` keeps: `id, name, provider, model, effort, permissions, mcp, planMode,
  autoApprove, fallback, fallbackPaidOk`. It loses `role, gated, color` and the purpose-file brief.
- Chats live in `.multimine/chats/<id>.json` (settings + messages + resume ids), not as
  `.multimine/agents/<id>.md` purpose files. A project opened from the old version keeps its
  `.multimine/agents/` untouched; the first chat takes Mastermind's provider and model as its default.
- New-chat defaults (provider, model, effort, access) live in Settings → General.
- `multimine.md` is still injected into every chat, like `AGENTS.md`. Claude Code reads `CLAUDE.md`
  on its own; the 12 KB outline trick stays.

## Phases

Each phase ends with `npm run typecheck`, `npm test` and `xvfb-run -a npm run test:e2e` green, then
a commit and push. No phase leaves the app unusable. Phases 2 to 4 landed as one change: removing
the team from the engine breaks the team UI, so they could not be green apart.

### Phase 0 - Archive (done)

- `archive/multi-agent` branch at `256774b`, pushed.
- Last step of Phase 7: a line in the README pointing to it.

### Phase 1 - Fix before anything moves (done)

- `readOnlyCommand` (was in `src/main/providers/claudeCli.ts`) auto-approved anything that *started*
  like a read: `echo $(rm -rf ~)`, `find . -delete` and `find . -exec rm {} \;` all passed, and ran
  without asking even in Supervised mode. It now lives in `src/main/providers/guard.ts` and proves a
  command is a read instead of guessing: the line is split into its commands (`|`, `&&`, `||`, `;`),
  anything with substitution, redirection, backgrounding or a newline is refused, every command must
  be a known reader, and the flags that make a reader write or run something (`find -exec/-delete`,
  `rg --pre`, `git -c`, `git diff --output`, `tree -o`, `git branch <name>`...) are refused. What it
  cannot prove asks. `hardStop` also catches `git -C dir push`, `rm -r -f`, `rm --recursive` and
  `find -delete`. Tests in `tests/unit/core.test.ts`.

### Phase 2 - Slim the engine (main process) (done)

- `src/main/orchestrator/engine.ts` keeps: turn queues per chat, `send`, `runTurn`, `runHop`,
  fallback hops, warm sessions, `freshStart`, `retry`, `stop`, the watchdog hooks, usage totals,
  media capture, `askUser` / `approveAction` (now answered in the chat), `systemPrompt`.
- It loses: `relay`, `deliverLate`, `wouldDeadlock`, `requestApproval`, `autoAnswer`, `council`,
  `createAgent`, `bootstrapContext`, `updateContext`, `flushContext`, `queueContext`,
  `manualChanges`, `channels` / bus logging, `fromOutside` / `taskFromOutside` (terminal agents).
- `coordinationTools` shrinks to **`show_media`** (media into the gallery) and **`ask_user`** (for
  Codex and API models; Claude keeps its own `AskUserQuestion`).
- Delete `orchestrator/council.ts`, the Mastermind parts of `orchestrator/prompts.ts` and
  `orchestrator/inbox.ts`. Keep `orchestrator/continuation.ts` (the brief a fallback provider gets),
  `orchestrator/workspace.ts` (API models' file tools) and `orchestrator/watchdog.ts`.
- `src/main/orchestrator/` is now `src/main/chat/`.
- `src/main/mcp/busServer.ts` stays (CLI agents still need `show_media`), per chat instead of per agent.
- `src/main/ide/watcher.ts` keeps only "file changed on disk" for open editor tabs; the manual-change
  batch for the Context Handler goes.
- `store/project.ts`: chats instead of agent files; migration as above. `store/sessions.ts` became
  `store/chats.ts` (a "session" was a set of conversations - a chat already is one). The engine
  stops its turns and waits for them when a project closes, so nothing writes into it afterwards.

Tests: delete `council`, `handoff`, `contextBatch`; rewrite `pipeline` as one chat on the Mock
provider doing a task end to end; adapt `core`, `permissions`, `retry`, `fallback`, `warm`,
`freshContext`, `economy`, `usage`, `watchdog`.

### Phase 3 - The window (renderer) (done)

- `FocusShell` becomes the only layout. Sidebar, top to bottom: project switcher, **chats** (status
  dot, live activity line, "waiting for you" badge), **Tools** (the grid's tiles), then Code, Git,
  Media and Settings.
- Composer: model, effort, access, plan mode (Claude), and a **⚡ Quick** toggle (Phase 5). Chat settings that do not fit the composer (MCP servers, fallback chain) open from the
  chat's header menu, replacing `AgentEditor`.
- Questions, plan approvals and permission prompts render inline in the chat (they mostly already
  do) and raise a desktop notification in the background.
- Delete: `src/renderer/space/` (unless kept, see Decisions), `panels/TeamWizard.tsx`,
  `panels/AgentEditor.tsx`, `panels/InboxPanel.tsx`, `panels/ContextPanel.tsx`,
  `panels/LeftRail.tsx`, the Map parts of `panels/TopBar.tsx` and `panels/ChatDock.tsx`, `LayoutSwitch`.
  `OrbAvatar` can stay as a small chat avatar.
- `Welcome.tsx`: open a folder → a first chat with the defaults. No team offer.
- Drop `pixi.js` from `package.json` if the map goes.

### Phase 4 - Tools talk to a chat (done)

Every tool's send button gets a chat picker (`src/renderer/tools/ChatTarget.tsx`): **A new chat** or
any existing one, the one on screen marked. Builds default to a new chat so a long job does not
clutter the conversation you are in; follow-ups go back to the chat that did the first one (a
sketch's revisions, a board's updates, the Asset Board's next request). A chat a tool starts is
named after its message ("UI Sketcher: Build the UI sketch \"Mana Furnace\"").

- **Briefs carry the role.** What `templates/agents/ui-creator.md` and `asset-creator.md` told an
  agent moves into the brief the tool sends (`src/shared/sketch/brief.ts`, the Asset Board's brief in
  `src/shared/assets/`), so any chat can do the job. Remove the "no UI Creator yet: create one with
  `create_agent`" branches.
- **UI Sketcher** (`tools/sketcher/Sketcher.tsx`, `Revisions.tsx`): Send and revisions go to the
  chosen chat; the brief asks it to build, capture with `show_media`, and stop.
- **Asset Board** (`tools/assets/AssetBoard.tsx`): requests go to one chat. A chat it starts begins
  with the generator MCP servers (meshy, wavespeed, higgsfield) on - only those the user has set up
  in Settings. An existing chat without one gets a warning on the board.
- **Logic Board** (`tools/logic/LogicBoard.tsx`, `src/shared/logic/brief.ts`): drop
  `viaMastermind` and the approval id. Build sends the outline as the task; a "plan first" checkbox
  starts the chat in plan mode.
- **Data Tables** (`tools/data/DataTables.tsx`): "Ask a chat" defaults to the chat on screen: a
  question about the data usually belongs in the conversation that has the context.

### Phase 5 - Usage savers without a Mastermind (done)

- **Economy mode** keeps the concise rules (`CONCISE_RULES`) and the tier table in Settings.
- Downshifting was driven by Mastermind's `difficulty` rating. Now **⚡ Quick** in the composer runs
  one message on the provider's light tier (Haiku for Claude; a lower effort where no light model is
  set) and the chat goes back to its own model after. Optional, off by default: economy rates each
  message with one tiny call on the light tier (`RATE_SYSTEM`) and downshifts easy ones; anything
  unclear counts as heavy. The header shows a cheaper turn in amber with a ⚡.
- Kept: warm sessions, fresh context, CLAUDE.md outline, usage pill (now per chat), plan gauge and
  90% warning, loop guard and its usage budget.
- Measured: the prompt Multimine adds to every model call, with the template multimine.md, went from
  4,923 characters for the old Implementer (5,444 for Mastermind) to 2,647 for a chat that can write
  and 1,334 for a read-only one. `tests/unit/promptBudget.test.ts` keeps it under budget. The bigger
  savings are structural and were not benchmarked here (no model logins in this environment): one
  turn instead of a Mastermind turn plus a delegated one, no council of critics, no Context Handler
  turns after each task. Benchmark with real logins before putting percentages in the README.

### Phase 6 - Plugin API v2

- `src/main/plugins/api.ts`: `chats.list` (id, name, provider, model, status, active), `send(to,
  text)` and `task(to, title, text)` where `to` is a chat id, `'active'` or `'new'`.
- v1 compatibility: `team.list` returns the chats with `role: 'custom'`; `send('mastermind', …)`
  goes to the active chat. `apiVersion` reports 2; manifests with `"api": 1` keep working.
- `team:read` keeps its name as a permission (a rename would re-prompt every installed plugin).
- Update `docs/plugins.md`, `src/main/plugins/sdk/multimine.js`, `examples/plugins/hello`, and
  `plugins.test.ts` / `logicApi.test.ts`.

### Phase 7 - Open-source ready

- README rewritten around the pitch: what it is in one paragraph, a 30-second GIF, install, the four
  tools, plugins, usage savers with the measured numbers. A line pointing to `archive/multi-agent`.
- `LICENSE` (MIT, as `package.json` already says), `CONTRIBUTING.md` (plugins and engine targets
  as first contributions), issue templates.
- Mark it **experimental**; say which OSes are tested.
- Check a clean `npm install && npm run dev` on Windows, macOS and Linux with the Mock provider.
- New screenshots in `docs/`; remove the ones of removed features (`team.png`, `inbox.png`,
  `balloon.png`, `economy-link.png`).

## Decisions (taken)

1. **The space map** is deleted in Phase 3. An optional view drawing the open chats and a Claude
   chat's own sub-agents as orbs can come back later, plugin-sized.
2. **The Context Handler** is dropped: `CLAUDE.md` / `AGENTS.md` do most of its job for free.
3. **Terminal agents**: the `+ Claude Code` / `+ Codex` buttons stay as plain terminals running the
   CLI; the bus wiring that made them team members goes.

## Order and size

| Phase | Size | Risk |
|---|---|---|
| 1 Security fix | small | low |
| 2 Engine | large | high - most tests move here |
| 3 Window | large | medium |
| 4 Tools | medium | low |
| 5 Usage savers | small | low |
| 6 Plugin API v2 | small | low |
| 7 Open-source ready | medium | low |

Phases 4 to 6 can go in any order after 3.
