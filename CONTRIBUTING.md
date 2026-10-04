# Contributing to Multimine

Thanks for looking. Multimine is young and experimental, so small, focused changes land fastest.

## Getting it running

```bash
npm install
npm run dev        # the app with hot reload
```

You do not need any AI to work on it: new chats start on the **Mock** provider, an offline stand-in.
A line like `/tool ask_user {...}` or `/say hello` in a Mock chat drives the real tools, which is how
the tests work too (`src/main/providers/mock.ts`).

Before you open a pull request:

```bash
npm run typecheck
npm test                      # unit tests, a few seconds
xvfb-run -a npm run test:e2e  # builds, then drives the real app (drop xvfb-run on a desktop)
```

## Good first contributions

- **A plugin.** The easiest way in: a folder with a `plugin.json` and a page, talking to Multimine
  through `window.multimine`. Start from [`examples/plugins/hello`](examples/plugins/hello) and
  [`docs/plugins.md`](docs/plugins.md). A plugin does not need anything merged here to be useful.
- **An engine target.** The UI Sketcher, Logic Board and Asset Board know Godot, Unity, Unreal,
  Minecraft and web projects (`src/shared/sketch/targets.ts`, `src/shared/logic/targets.ts`,
  `src/shared/assets/board.ts`). Adding one (Bevy, GameMaker, Defold, a mobile stack) is mostly data:
  how it is detected, how it lays UI out, how it builds and captures a screen. Those modules are pure
  and unit tested.
- **Trying it on macOS or Windows** and reporting what breaks. The test suite runs on Linux.

## How the code is laid out

```
src/main/chat/      the engine: chats, turns, fallbacks, the loop guard, the tools every chat gets
src/main/providers/ Claude (Agent SDK), Codex (codex exec), API keys (AI SDK), Mock
src/main/plugins/   manifests, consent and grants, the permission-checked plugin API
src/renderer/       React: the shell, the chat, the side sheets, the tools
src/shared/         types, and the tools' pure logic (sketch/, logic/, assets/, data/)
```

`multimine.md` at the root has the conventions; the short version:

- Everything that crosses IPC is typed in `src/shared/types.ts` and `src/shared/api.ts`.
- The main process imports Electron only in `src/main/index.ts`, so the engine runs under Vitest.
- A built-in tool gets no privilege a plugin could not have: add a plugin API method instead.
- Match the surrounding code: its naming, its comments (they say why, in plain words), its tests.

## Pull requests

- One change per pull request, with a test that would have caught the bug or shows the feature.
- Say what you tested by hand, on which OS.
- Security-sensitive changes (permissions, the read-only command check in
  `src/main/providers/guard.ts`, the plugin sandbox) get extra scrutiny: describe how you tried to
  break them.

## Reporting a security problem

Please do not open a public issue for something that lets a chat or a plugin do more than the user
allowed. Open a GitHub security advisory on the repository instead.
