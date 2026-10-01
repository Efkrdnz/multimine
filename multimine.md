# multimine.md

Guidance for agents working on Multimine itself.

## Project

Electron + electron-vite + TypeScript. Main process in `src/main` (no Electron imports outside
`index.ts`, so the engine runs under Vitest), renderer in `src/renderer` (React, Zustand, Tailwind 4,
PixiJS 8 for the space scene), shared types in `src/shared`.

## Commands

- `npm run typecheck`, `npm test`, `npm run build`, `xvfb-run -a npm run test:e2e`

## Conventions

- Everything that crosses IPC is typed in `src/shared/types.ts` / `src/shared/api.ts`; add a method
  to `Api` and `API_METHODS` together.
- A new coordination tool goes in `Engine.coordinationTools`; it reaches every provider from there.
- Zustand selectors must not return a fresh `[]`/`{}` (use `EMPTY_LIST`/`EMPTY_MAP`), or React loops.
