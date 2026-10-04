# multimine.md

Guidance for chats working on Multimine itself.

## Project

Electron + electron-vite + TypeScript. Main process in `src/main` (no Electron imports outside
`index.ts`, so the engine runs under Vitest), renderer in `src/renderer` (React, Zustand, Tailwind 4),
shared types in `src/shared`. A project has chats (`src/main/chat/engine.ts`); the built-in tools
live in `src/renderer/tools` and reach the app only through the plugin API.

## How to verify

- `npm run typecheck`, `npm test`
- `xvfb-run -a npm run test:e2e` (builds, then drives the real app on the mock provider)

## Conventions

- Everything that crosses IPC is typed in `src/shared/types.ts` / `src/shared/api.ts`; add a method
  to `Api` and `API_METHODS` together.
- A tool every chat should have goes in `Engine.coordinationTools`; it reaches every provider from there.
- A built-in tool gets no privileges a plugin could not have: add plugin API methods instead.
- Zustand selectors must not return a fresh `[]`/`{}` (use `EMPTY_LIST`/`EMPTY_MAP`), or React loops.
- Keep the system prompt small: `tests/unit/promptBudget.test.ts` holds it to a budget.
