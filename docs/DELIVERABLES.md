# Deliverables

What a project or a task produced, one click away: a file, a folder of code, an application, an image, a run command or a web address. This guide is for using them; the product rules are `SPEC.md` §4.7 (decisions 118–134), the design is `TECHNOLOGY.md` §9.

A deliverable is a **pointer**. It says where the thing is; the thing stays in your project's folder. Removing a deliverable never deletes a file.

## 1. Where they come from

- **Agents declare them.** A Steward on Claude Code declares what you will want to open, usually when it finishes (`declare_deliverable`), and its "Done:" report names them. A Steward on another runtime (ACP, a terminal agent) lists them under "Deliverables:" in its "Done:" report, and its Waykeeper (or the Harmonizer, for a standalone task) declares them. A Waykeeper also removes what you will not want (a scratch log), with a reason. Agents may point only inside the project: never `.git/`, another task's worktree, the server's data folder or the rest of the Mac, and never a file whose name usually holds a secret (`.env`, keys, credentials).
- **Mission Control finds some.** Every project has its folder ("Project folder") and the run scripts in it: `package.json` scripts (with the package manager its lockfile names), `Makefile` and `justfile` targets, `pyproject.toml` scripts, Cargo, Docker Compose, `deno.json` tasks. They are read as text, never by running a tool, when the project's folder is prepared, after every merge, at startup and on **Rescan**. A script you removed is not added again; **Show removed** brings it back.
- **You add or remove them by hand** in the panel, on the Mac.

Declaring a deliverable notifies nobody. When a task or project finishes, its notification says how many it left: "Project finished · 3 deliverables". A count, never a title, so it may also show on a phone's lock screen that hides names.

## 2. Where they are

- **In the panel.** A project's Deliverables are the third view of its Waykeeper's dock ("Chat | Status | Deliverables"): the project's own first, then its tasks', newest first, then its sub-projects' (folded). A task's are a section of its Steward view. The navigation row's "⋯ → Deliverables" opens either. Closed and archived work keeps its deliverables in the history inspector.
- **In the scene.** A body whose work has deliverables declared by an agent or added by you shows **"◆ n"** on its label, and **"▶"** while one of its commands runs (its folder and detected commands do not count towards n). Click the mark to select the work and open its Deliverables.
- **On disk.** A deliverable inside the project stays where it is. What had to be **copied** goes into the project's own **`deliverables/` folder**, one subfolder per task, e.g. `~/GalacticProjects/my-app/deliverables/<task>/`:
  - a file an agent made in a temporary folder (copied when it is declared);
  - a file in a task's worktree that the merge does not carry, such as a build output or a screenshot (copied before the worktree is removed; a committed file is re-pointed into the project's folder instead);
  - a path you add from outside the project.

  That folder is yours. It is excluded from git **on this Mac only** (the repository's `.git/info/exclude`; nothing tracked changes), GalacticAgents never deletes anything in it, and there is no size limit other than the disk's free space. The project's Deliverables view shows it, once it exists, with Reveal in Finder. Back it up with your projects; GalacticAgents' backups and exports hold the list, not the files (`docs/BACKUP_RESTORE.md` §4).

A file moved or deleted after it was added shows as **missing** until it is back at its path. A copy that could not be made (the disk was too full) says so, and the Waykeeper is told.

## 3. What you can do

| Kind | On the Mac (browser or desktop app) | On the phone |
| --- | --- | --- |
| File | View (text and code highlighted, Markdown rendered, images), Open, Reveal in Finder, Download (browser only) | View, Download |
| Image | View, Open, Reveal in Finder, Download (browser only) | View, Download |
| Folder | Open in IDE, Reveal in Finder | its path |
| Application | Open, after a confirmation (it runs code) | "on the Mac" |
| Command | Run, Stop, Restart; output, state and ports | Follow its output and state; **Stop** |
| Web address | Open in the browser | Open in the browser |

The viewer never runs what it shows: HTML is shown as source, SVG only as a picture, Markdown without its raw HTML and without loading its images. Previews have limits (text over 2 MB shows its first 2 MB; no PDF preview), files do not: Open and Download work for any size. Inside the desktop app there is no Download (Open and Reveal in Finder do that job), and port links and web addresses open in your default browser (`docs/DESKTOP.md`).

The IDE is a setting ("Automatic" picks the first installed of WebStorm, IntelliJ IDEA, Cursor, VS Code and Zed). Only an IDE in `/Applications` or `~/Applications`, signed by its maker, is ever launched.

## 4. Running commands safely

A command runs only when you click **Run** on the Mac and confirm. Read the dialog before you do:

- **The exact command** and **the folder** it runs in (the project's folder or its `deliverables/` folder, never a task's worktree: a command only in a worktree says "available after the merge").
- **What a detected script runs**: the `package.json` script, the Makefile rule or the recipe, with **"changed since the last run"** when it did. A script a Steward edited is code you have not read yet.
- **The warnings** the permission engine reads in the command ("deletes files", "uses the network", "may push").
- **The environment** it gets: the same allow-listed variables agents get (PATH, HOME, locale, proxies), never the server's token or keys. And **who added it**.

Your confirmation is the gate: the project's permission table and trust level do not apply, and no agent can start, restart or stop a run. You may edit the line for one run; it is checked again before Run. If the command changed while the dialog was open, the run is refused and the dialog shows the new one.

While it runs, its output streams into the panel (secrets redacted, as agents' output is) and its ports show as links on the Mac. One run per command at a time, at most 4 at once (a setting). **Stop** ends it gracefully, then forcibly after five seconds, together with everything it started. A run is also stopped when its project is closed, cancelled or archived, when its standalone task finishes, when its deliverable is removed, and when Mission Control stops. After a restart it shows as stopped ("Mission Control restarted") and is never started again by itself. Output is kept for the last 5 runs of each command, at most 2 MB per run and 30 days (settings).

Prefer a declared dev command to a server a Steward left running: a run is tracked and stopped with its project.

## 5. From the phone

The phone looks, downloads and may stop a run; only the Mac opens, launches and starts (decision 131; `docs/REMOTE_ACCESS.md` §3):

- **Yes:** list deliverables, view text and images, download files (one-time links valid for a minute), follow a run's output, state and ports (as text: a dev server is not reachable through Tailscale Serve), stop a run after a confirmation.
- **Never**, even with `autoApproveRemote`: Open, Reveal in Finder, Open in IDE, opening an application, Run or Restart, and adding a path from outside the project (it would be copied in and become downloadable). The phone shows these as "on the Mac".
- **Only with `autoApproveRemote`:** adding, editing, removing or restoring deliverables inside the project, Rescan, and the deliverables settings.
