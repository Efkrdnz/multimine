# Multimine

A desktop workstation for a team of AI agents. Every agent is a glowing chibi-faced orb in space;
**Mastermind** is the brain in the middle. Agents talk to each other over a shared bus (you see the
packets fly), ask you questions through Mastermind, and work on a real project folder.

![team](docs/team.png)

## What it does

- **Agents with their own brains.** Each agent picks a provider, model and effort:
  - **Claude subscription** - driven through the Claude Agent SDK on your logged-in Claude Code (`claude`).
  - **ChatGPT subscription** - driven through `codex exec` on your logged-in Codex CLI.
  - **API keys** - Anthropic, OpenAI, Gemini, Groq, xAI, OpenRouter, or any OpenAI-compatible
    server (Ollama, LM Studio). Keys are encrypted with the OS keychain and never touch the project.
  - **Mock** - an offline stand-in, so you can try everything with no AI at all.
- **Roles and purpose files.** Every agent is `.multimine/agents/<id>.md`: YAML frontmatter (provider,
  model, effort, permissions, MCP tools, gated, plan mode) plus a markdown brief that becomes its
  system prompt. Templates ship for Planner, Implementer, Designer, Brainstormer, Context Handler, Asset
  Creator and Critic; Custom starts blank.
- **`multimine.md`** at the project root is shared guidance injected into every agent, like
  `CLAUDE.md` / `AGENTS.md`.
- **Mastermind orchestrates.** It can create and reconfigure agents, delegate tasks, run a council,
  and ask for approval. The pipeline lives in its own purpose file (edit it to change the process);
  the hard gates live in code.
- **Questions come to you.** Any agent's `ask_user` call - and Claude's own plan-mode
  `AskUserQuestion` - lands in the **Mastermind inbox** as a structured card. The agent waits until
  you answer.
- **Automation mode.** Toggle it on and Mastermind answers questions and approves plans on your
  behalf, logging why. `git push`, recursive deletes and similar always still wait for you.
- **Approval gate.** A *gated* agent (Implementer by default) refuses work unless Mastermind passes
  the id of an approved plan.
- **Council.** `run_council` sends a plan to N cheap critics with different lenses. Round one is
  blind; in round two each sees the others and must rebut or escalate. An approval only counts with
  at least three objections and none of them high - agreeing is never free.
- **Live links.** While one agent works on something another handed it, or waits on you, the line
  between them pulses and glows until the exchange ends.
- **Context Handler.** Create one and it maps the project into `.multimine/context/` (index,
  registries, one file per system, changelog). Every other agent is then told to read the map first
  and code second, and whenever an agent with write access changes the project, the Context Handler
  is sent the report and `git status` to update the map.
- **MCP tools.** Add any MCP server (stdio or HTTP) - Higgsfield, Meshy, WaveSpeed or anything
  else - and tick it on the agents that should have it. Images, video, audio and 3D models agents
  produce are saved to `.multimine/media/` and previewed in the chat and the **Media gallery**
  (glb/gltf in a 3D viewer).
- **Permissions.** Each agent has *Auto-approve permissions*: on, it never stops to ask (Claude
  accepts edits and runs commands, Codex runs with full access); off, every command, edit or tool use
  asks. Either way pushing, publishing and destroying history ask - as a speech balloon over the
  agent's orb with **Allow / Deny**, so you answer from the space view without opening the chat.
- **Long tasks never time out.** A handoff waits up to 10 minutes (Settings -> Economy & handoffs),
  then gives the caller its turn back; the report arrives later as a message of its own.
- **Economy mode** (top bar): agents keep answers short, and Mastermind rates each handoff light,
  standard or heavy. Light and standard tasks run on a cheaper model for that task only (Haiku or
  Sonnet for Claude agents by default; the table is in Settings) - the agent shows it in amber with a
  ⚡ and goes back to its own model afterwards.
- **Repository panel** (left rail): branch switch/create, changed files with diffs, stage and commit,
  pull and push, history, and on GitHub the open pull requests and issues and a new-PR form (through
  your `gh` login, or a token you paste). `.multimine/sessions` and `media` are git-ignored.
- **Asset Creator.** A role for generated art: Meshy for 3D models, WaveSpeed for images and video.
  Settings -> MCP servers has presets for both (add your key), and each server card lists every agent
  so you can switch access on and off in one click.
- **Code window** (left rail, `</>`): a folder tree with file-name search and search inside files,
  Monaco editor tabs (Ctrl+S; tabs follow edits made elsewhere), **Open in IntelliJ / VS Code**, and
  terminals at the project root. **+ Claude Code** / **+ Codex** start the CLI there joined to the team:
  it appears as an orb and can message any agent or Mastermind; messages to it show as a banner.
- **Your edits keep the context true.** Any change nobody on the team made - in the code window,
  IntelliJ, VS Code, a terminal - is collected and sent with its diff to the Context Handler after 2
  quiet minutes, or at once with **Sync context**. (On Windows the terminal uses node-pty's bundled
  binary; `npm install-scripts approve node-pty` is recommended but not required.)
- **Fallback providers.** Each agent can have an ordered chain (agent editor), with a default chain in
  Settings. When its provider runs out of usage or its login stops working - never on an ordinary
  error - the task carries on in the same reply on the next provider, briefed with everything already
  done. Claude's own limit warnings move the next task over before anything is cut. Subscriptions
  switch silently; a paid API key asks first (with **Always**). The orb shows `↪ model (fallback)` in
  sky blue.
- **Tools** (left rail, the grid button): a home-screen grid of tools - the built-in UI Sketcher and
  any plugin you install - with Edit mode to reorder (drag) and remove them. Each tool opens in its own
  window from the left. **Plugins** are a folder with a `plugin.json`: a web page that runs walled off
  from the app (no keys, no settings, no Node) and reaches it only through `window.multimine`, each
  call checked against the permissions you granted when it was first enabled (revocable in
  **Manage**). A plugin can also bring an MCP server of agent tools. Project-folder plugins never run
  until you enable them. See `docs/plugins.md` and `examples/plugins/hello`.
- **UI Sketcher** (in Tools): draw a game HUD, a menu or an app screen - 26 element types, from
  windows, buttons and lists to health bars, ability slots, minimaps, dialogue boxes, crosshairs and
  joysticks - with nesting, snapping, layers, properties, undo, and **anchors** (picked from where you
  draw, editable, with stretch). Targets: **Godot**, **Unity**, **Unreal**, **Minecraft**, web, mobile
  and desktop, detected from the project. The **Mockup** tab lays the sketch out on every screen the
  target runs on (1080p to ultrawide, Steam Deck, a phone) the way that engine resolves anchors, in a
  procedural game, Minecraft or app style; game targets show the title-safe area. **Send** saves
  `.multimine/sketches/<name>/` and asks Mastermind to have a **UI Creator** build it the way that
  engine does (a Godot Control scene, UI Toolkit or UGUI, a C++ `UUserWidget`, a Minecraft screen, the
  project's web stack), capture the real thing and show it in the gallery; **Revisions** marks the
  screenshot up and sends it back.
- **Asset Board** (in Tools): the art and sound the project needs, as cards (Wanted, In progress,
  Review, Done) in `.multimine/assets/board.json`. Each asset has a spec and a path suggested for the
  engine; **Request** briefs the Asset Creator with it and the board's style guide. Results come back
  through the gallery and become candidates; **Approve** copies the chosen one into place (images
  resized to the spec, nearest neighbour for pixel art), or send it back with a note.
- **Data Tables** (in Tools): the project's JSON and CSV data (items, enemies, loot, levels) as a
  spreadsheet with typed columns, validation, min/max/mean, a chart, sort and filter. A save patches
  the file in its own format - only the edited lines change. **Ask an agent** sends the selected rows
  and a request to anyone on the team; the table reloads when they edit the file.
- Every built-in tool holds no privileges of its own: it goes through the same permission-checked
  plugin API a third-party plugin gets.
- **See what agents are doing.** Every busy agent shows a live line - "Running gradlew runClient ·
  4:12", "Editing Ability.java" - in its chat and over its orb; tool cards show how long each step
  took, and a Claude sub-agent's steps appear nested under the task that started it. An agent that
  has been silent for a while turns amber ("quiet") with a Stop button.
- **Loop guard.** An agent that relaunches the same app with nothing changed, repeats a step, cycles
  through the same few steps, or runs past its time budget is paused, and a balloon over its orb asks
  you: **Tell it...** (your instruction replaces the step), **Continue**, or **Stop**. Thresholds are
  in Settings. Agents are also told to launch a game at most once per change and to report a missing
  world or binary instead of retrying; fill in the "How to verify" section of `multimine.md` with your
  project's exact commands.
- **Sessions.** Agents belong to the project; conversations belong to a session. Create, rename,
  duplicate, switch. Claude and Codex threads resume per session.

## Running it

```bash
npm install
npm run dev        # the app with hot reload
npm run build      # production bundle in out/
npm start          # run the production bundle
npm run dist       # installer for your OS (electron-builder)
```

If your npm asks about install scripts, approve esbuild once (`npm install-scripts approve esbuild`);
it is the only package that needs one. The first `npm run dev` (or `npm start`) downloads the
Electron binary (`scripts/ensure-electron.mjs`); behind a proxy, set `HTTPS_PROXY` or
`ELECTRON_MIRROR`.

Open a project folder (your Minecraft mod, say). The first time, Multimine creates `multimine.md`,
`.multimine/` and a Mastermind, and offers a starting team.

### Subscriptions

- Claude: install Claude Code (`npm i -g @anthropic-ai/claude-code`), run `claude` once and log in.
- ChatGPT: install Codex (`npm i -g @openai/codex`) and run `codex login`.

Settings -> Providers shows whether each is found and logged in, and takes an explicit executable
path if they are not on `PATH`.

### Models

The model lists are presets (Fable 5.1, Opus 5.5, Sonnet 5.5, GPT 5.6 Sol, GPT 6 Astra, ...). Any id
can be typed in the agent editor, the lists are editable in Settings -> Models, and API providers
have **Refresh from vendor** to pull their live list.

## In the space view

- Click an orb to open its chat; double-click to edit it; drag to move it (positions are saved).
- Drag the sky to pan, scroll to zoom, double-click the sky to fit the whole team again.
- Faces follow state: thinking looks up, working squints, waiting shows a `?`, an error goes `> <`,
  and the mouth moves while text streams. The brain storms with sparks while Mastermind thinks and
  pulses amber while something waits on you.
- Link colours: delegate violet, report green, question amber, approval orange, critique red,
  context cyan, message blue.

## How it is built

```
src/shared/        types, agent-file format, effort mapping, model presets, role templates
src/main/
  app.ts           the API the window calls (projects, agents, sessions, settings)
  store/           project folder, sessions on disk, app settings + encrypted keys
  providers/       aiSdk (API keys), claudeCli (Agent SDK), codexCli (codex exec), mock
  orchestrator/    engine (turn queues, bus, inbox, gate, automation), council, prompts, workspace tools
  mcp/             busServer (local MCP server CLI agents call back into), hub (external MCP servers)
  media/           saving generated media
  plugins/         manifest validation, registry and grants, the permission-checked API, mmplugin://
src/shared/sketch/ the UI Sketcher's model, targets, layout, drawing ops and briefs (pure, unit tested)
src/shared/assets/ the Asset Board's board, paths, matching and briefs (pure, unit tested)
src/shared/data/   Data Tables' parse, type inference, patching writer and diff (pure, unit tested)
src/renderer/      React panels + a PixiJS space scene (space/)
templates/         multimine.md and the role templates
```

Every agent gets the same coordination tools (`message_agent`, `report`, `ask_user`, `list_agents`,
`read_context`, `show_media`; Mastermind adds `create_agent`, `update_agent`, `delegate`,
`request_approval`, `run_council`; the Context Handler adds `update_context`). API agents get them
in-process; Claude and Codex agents reach them over a loopback MCP server with a per-agent URL, so
every tool call knows who made it.

## Tests

```bash
npm test           # unit tests + a scripted end-to-end pipeline on mock agents
npm run test:e2e   # drives the real Electron app with Playwright and saves screenshots
```

On a machine without a display: `xvfb-run -a npm run test:e2e`.
