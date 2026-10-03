# multimine.md

Project guidance shared by every agent on this team. Edit it freely: it is injected into every
agent's system prompt, the way CLAUDE.md or AGENTS.md is.

## Project

Describe the project here: what it is, the stack, how to build and test it.

## How to verify

How agents check their work. Keep it short and exact; agents follow it over their defaults.

- Build and unit tests: `<the command>`
- See it running (at most once per change, with an automatic exit): `<the command>`
- What that needs first: `<e.g. a world named "New World" in run/saves, a dev server on :5173>`

## Conventions

- Keep changes small and focused; match the surrounding code.
- Before reading the codebase, read `.multimine/context/index.md` if it exists.
- After changing code, report what changed and where so the context files stay current.
