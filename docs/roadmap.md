# Multimine roadmap

What is next, roughly in order. The simplification that turned the multi-agent workstation into
one agent per chat is in [`plans/simplify.md`](plans/simplify.md); the plans for the tools that came
before it are kept in `plans/` for their reasoning (they describe the multi-agent version).

| # | What | Why |
|---|---|---|
| 1 | Benchmark the usage savers with real logins | Put measured numbers next to Quick, economy's rating and warm sessions, or drop what does not pay |
| 2 | Test and fix on macOS and Windows | The test suite runs on Linux only |
| 3 | Signed builds and auto-update | Unsigned installers scare people off; updates should not need a rebuild |
| 4 | A map view of chats and their sub-agents, as a plugin | The orbs-in-space view was the most shareable picture the project had |
| 5 | More engine targets (Bevy, GameMaker, Defold) | Mostly data in `src/shared/*/targets.ts`; a good first contribution |
| 6 | A "map this project" plugin | What the Context Handler did, as an opt-in plugin instead of a running cost |
