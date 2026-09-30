# GalacticAgents

Mission Control for the AI coding agents running on your computer, through a solar-system interface: Earth is the headquarters, planets, moons and asteroids host projects and tasks by size, and agents are satellites doing visible work.

Read `docs/SPEC.md` (what), `docs/TECHNOLOGY.md` (with what) and `docs/IMPLEMENTATION_PLAN.md` (in which order). Work is tracked in `docs/tasks/`; the ticket flow is in `CLAUDE.md`.

## Quickstart

Requirements: Node 22 LTS and pnpm 10 (`corepack enable` or `npm i -g pnpm`). No native toolchain is needed: `better-sqlite3` ships prebuilt binaries (its install script is intentionally not run).

```sh
pnpm install          # workspace: packages/protocol, apps/server, apps/web
pnpm build            # protocol → server → web (also copies SQL migrations)
pnpm test             # every package's Vitest suite, incl. the resume/gap test
pnpm start            # = galactic start: serves the built web app, prints URL + token, opens the browser
```

`galactic start` flags: `--no-open`, `--port <n>`. The server binds `127.0.0.1:4321` by default and keeps its config, token and SQLite database in `~/.galactic/` (`GALACTIC_HOME` overrides the folder; `GALACTIC_PORT`, `GALACTIC_TOKEN`, `GALACTIC_ALLOWED_HOSTS` override single settings).

The token is generated on first start and printed by `galactic start`. The page opened on the same machine picks it up from `/health` automatically; on another device (Phase 7) you paste it.

## Development

```sh
pnpm dev              # protocol (tsc --watch) + server (tsx watch) + web (vite) with hot reload
```

Open <http://localhost:5173>. Vite proxies `/ws`, `/health` and `/dev` to the server on `127.0.0.1:4321`, so the browser talks to a single origin. Press **Emit fake event** on the page to append an event through `POST /dev/events` and watch it arrive over the stream.

Other scripts: `pnpm lint`, `pnpm format`, `pnpm typecheck` (includes the tests), `pnpm -r test:watch`.

## Layout

```
apps/server/      Fastify + ws + SQLite + agent runtime — see apps/server/README.md
apps/web/         Vite + React 19 (+ React Three Fiber from Phase 3)
packages/protocol zod schemas, event model, AgentAdapter + DomainCommands interfaces (the single vocabulary)
docs/             SPEC, TECHNOLOGY, IMPLEMENTATION_PLAN, tasks/
```
