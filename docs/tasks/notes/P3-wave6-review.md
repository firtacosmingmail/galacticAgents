# Phase 3, batch 6 (wave 6: P3-10, P3-11, P3-12) — review

Branch `p3-wave6-device-fixes` against `phase-3`, 2026-10-03. Three fixes from Cosmin's first look at the scene, built by three parallel agents:

- **P3-10, planet-sized shadows.** Root cause, proven before any fix: the Sun was a point light with a cube shadow, so in the readable layout (enlarged bodies, compressed distances, one orbital plane) inner planets threw shadows wider than Jupiter and Saturn (Venus → Jupiter 6.0 vs 4.5), each giant shadowed ≈ 13 % of the time; switching off the caster alone restored the frame. Fix: per-system eclipse shading in the body shaders (casters from the planet's own system only, ≤ 6, soft-edged), no shadow map; over one Saturn year's 49 alignments the worst darkening fell from 72–100 % to 5.2 % (a moon spot), and "high" gained 15 draws a frame of headroom. SPEC 63 amended. The agent was cut off by a session restart after committing; the coordinator merged it (one TECHNOLOGY conflict with the fps rename).
- **P3-11, the fps meter.** Root cause: the panel's canonical URL rewrite dropped the query ≈ 10 ms after load, before the scene (mounted after the settings read) looked for it. Fix: replace-navigations keep search and hash, and the flag is captured at app start. Cosmin then asked for a clearer name: `?show_fps=true` / `?show_fps=false` (also 1/0); the old `?fps=` no longer works.
- **P3-12, the top bar on phones.** Root cause of the overlap: the top-bar links inherited the navigation rows' `flex: 1; min-width: 0` and shrank to nothing. Fix: below 760 px one row (app name, connection dot, "N waiting", a 44 px menu button) and a disclosure menu with every other action; safe areas; desktop unchanged. SPEC 67.

Found by the coordinator while running the gates: `git.ts` wrote to a child's stdin with no error listener, so a git that exited first raised an uncaught EPIPE that could take the server down (fixed, regression test fails without it); the web suite got the 20 s test timeout the server already had. Failures of real-git tests during this wave came from machine load (a P3-10 headless Chrome pushed the load average to 120); with the machine quiet the full gates are green.

An independent review found no blocker. Fixed after it: a shader patch that cannot find three's anchor chunks now draws the body without eclipses instead of throwing in the frame loop every frame (test); the compact menu's height accounts for the notch inset; a comment on the waiting-count button under the first-run wizard.

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 67, server 845 (+1 skipped), web 549.

Open: P3-08's device run on Cosmin's Mac (≈ 60 fps at "high", `?show_fps=true`) and iPhone (≥ 30 fps at "mobile" over the LAN; the new top bar on the real phone).
