# GalacticAgents

Mission Control for the AI coding agents running on your computer, through a solar-system interface: Earth is the headquarters, planets, moons and asteroids host projects and tasks by size, and agents are satellites doing visible work.

Read `docs/SPEC.md` (what), `docs/TECHNOLOGY.md` (with what) and `docs/IMPLEMENTATION_PLAN.md` (in which order). Work is tracked in `docs/tasks/`; the ticket flow is in `CLAUDE.md`. Phone access over Tailscale Serve: `docs/REMOTE_ACCESS.md`.

## Quickstart

Requirements: Node 22 LTS (22.12 or newer; `jsdom` prints a warning below 22.22, which is harmless) and pnpm 10 (`corepack enable` or `npm i -g pnpm`). No native toolchain is needed: `better-sqlite3` ships prebuilt binaries (its install script is intentionally not run).

```sh
pnpm install          # workspace: packages/protocol, apps/server, apps/web, e2e (npm/yarn are refused)
pnpm build            # protocol → server → web (also copies SQL migrations)
pnpm test             # builds protocol + server first, then every package's Vitest suite, incl. the resume/gap test
pnpm e2e              # builds, then the Playwright browser smoke tests (once: pnpm e2e:install); docs/tasks/notes/P8-05-smoke.md
pnpm start            # = galactic start: serves the built web app, prints URL + token, opens the browser
```

Workspace packages are consumed from their `dist/` (`@galactic/protocol` by everything, `@galactic/server` by the web tests), so `pnpm dev` and `pnpm test` build what they need first; `pnpm -r test` alone assumes a prior `pnpm build`.

`galactic start` flags: `--no-open`, `--port <n>`, `--dev` (enables the `/dev/*` demo routes behind the page's **Emit fake event** / **Seed demo project** buttons; `pnpm dev` enables them by itself). The server binds `127.0.0.1:4321` by default and keeps its config, token and SQLite database in `~/.galactic/` (`GALACTIC_HOME` overrides the folder; `GALACTIC_PORT`, `GALACTIC_TOKEN`, `GALACTIC_ALLOWED_HOSTS` override single settings).

The token is generated on first start and printed by `galactic start`. The page opened on the same machine picks it up from `/health` automatically; on another device (Phase 7) you paste it.

## Development

```sh
pnpm dev              # builds the protocol once, then protocol (tsc --watch) + server (tsx watch, GALACTIC_DEV=1) + web (vite) with hot reload
```

Open <http://localhost:5173>. Vite proxies `/ws`, `/health` and `/dev` to the server on `127.0.0.1:4321`, so the browser talks to a single origin. Press **Emit fake event** on the page to append an event through `POST /dev/events` and watch it arrive over the stream; **Seed demo project** creates a planet with a project on it through a proper command, so reloading the page (which always takes a fresh snapshot) shows it again.

Other scripts: `pnpm lint`, `pnpm format`, `pnpm typecheck` (includes the tests), `pnpm -r test:watch`.

## Layout

```
apps/server/      Fastify + ws + SQLite + agent runtime — see apps/server/README.md
apps/web/         Vite + React 19 (+ React Three Fiber from Phase 3)
packages/protocol zod schemas, event model, AgentAdapter + DomainCommands interfaces (the single vocabulary)
docs/             SPEC, TECHNOLOGY, IMPLEMENTATION_PLAN, tasks/
```
