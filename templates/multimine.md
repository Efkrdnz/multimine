# multimine.md

Project guidance for every chat in this project, whichever model runs it. Edit it freely: it is
added to every chat's system prompt, the way CLAUDE.md or AGENTS.md is.

## Project

Describe the project here: what it is, the stack, how to build and test it.

## How to verify

How a chat checks its work. Keep it short and exact; chats follow it over their defaults.

- Build and unit tests: `<the command>`
- See it running (at most once per change, with an automatic exit): `<the command>`
- What that needs first: `<e.g. a world named "New World" in run/saves, a dev server on :5173>`

## Conventions

- Keep changes small and focused; match the surrounding code.
- When you finish, say what changed and where.
