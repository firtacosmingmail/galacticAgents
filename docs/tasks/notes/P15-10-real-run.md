# P15-10 — real run of the project dashboard (manual, Cosmin)

**Status:** not run. This needs a real browser, a real phone and real Claude runs; only Cosmin runs it. Phase 15 is not done until the result is recorded at the bottom.

## Before you start

- A throwaway GalacticAgents data folder with the branch `agent-project-dashboard` built: `pnpm build`, then start the server and the panel as usual. The phone connected over Tailscale.
- A **long-term** project with at least one recurring job that has run a few times (reporting numbers), and a job that is easy to run by hand. Turn the system's reduce-motion setting off (step 8 turns it on).

## Procedure

1. **Ask for tiles and charts.** On the long-term project, ask the Waykeeper:
   - for a tile from a value an existing job already reports. Expect a **use** card (a panel only, no job change); approve it and see the tile appear at the end of the grid;
   - for a chart that needs a value no job reports yet. Expect a **job-change** card (the job's new data map and the panel together, one card); approve it. If the change widens what the job may do unattended, the card must be confirmable only on the Mac (or from the phone with `autoApproveRemote` on). The card is never half-applied: reject one and check that neither the job nor the panel changed.
2. **Refresh.** Press Refresh on a tile. A `refresh` run starts, the value updates, and the job's next scheduled time does not move. Then:
   - press Refresh again while that run is going: there must be exactly one run;
   - pause the job: Refresh is refused and the panel offers "Job paused — Fix & retry".
3. **Arrange.** Open Arrange mode. Drag a panel to another place, resize one, hide one, press "Done arranging". The order, sizes and hidden panel persist after a reload and on the phone (a hidden panel is hidden there too). Cancel throws the draft away. Everything works with the keyboard handles too.
4. **Job map.** Open the job map of a job. Connector lines run from sources to collected values to steps to panels, hovering or focusing an item highlights its connections and dims the rest, Escape or Close closes it and focus returns. Anything declared but unused, used but undeclared, or a source problem carries a word, not only a colour.
5. **Clear history.** Clear one panel's history: it ignores earlier runs from now on. Then, from the job, "Clear stored values": it lists the affected panels first, and afterwards the panels are empty until the next run. Neither can be undone.
6. **Phone.** Open the dashboard on the phone. It follows the Mac's order; tiles are a swipeable strip, other panels are full-width cards, the first 3 open and the rest folded to a title line you can tap open. Refresh works from the phone.
7. **Stop a job and remove its panels.** Ask the Waykeeper to stop a job that has panels. On the card, "Also remove these panels" lists the panels (unticked by default); tick it and approve. The job stops and the listed panels go; unticked, the panels stay as "job stopped" and are never coloured.

## Only a real browser can confirm

8. **Fireworks.** A tile (or a chart's latest value) that turns very good plays the fireworks **once** for that run result, not again on reload or when another panel changes. With the system's reduce-motion setting on, no fireworks: the panel gets a steady green glow instead. A very bad value shows the words "very bad" and an arrow, not only colour. A stale value, a stopped job's panel and a "no longer reported" panel are never coloured.
9. **Drag and resize in Arrange mode** feel right with a real mouse and a trackpad: the panel follows the pointer, swapping does not flicker, resizing snaps to the grid, and nothing is left dragging after releasing outside the window.
10. **Phone tile strip.** Swiping the tile strip scrolls it sideways **without moving the page** up or down, and a vertical swipe elsewhere scrolls the page.
11. **Job map connectors.** The SVG connector lines end exactly on their boxes after a window resize and on a narrow window; on the phone it falls back to text links.
12. **Refresh while a run is going** shows one run only (also with two browser windows open), and **a refresh run does not move the next scheduled run** shown in the Jobs view.

## What to record below

Date, model used, and for each step: passed or what happened. Also: anything that looked wrong in a real browser (spacing, clipped text, a connector off its box), any card whose wording confused you, and any panel the Waykeeper proposed that you would not have wanted.

## Result

(Left for Cosmin.)
