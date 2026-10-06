# Backups, export and restore

How Mission Control keeps copies of its database, how to put one back, and how to move the map to another data folder or machine (P8-03; `TECHNOLOGY.md` §6.4). Everything here works on the data folder: `~/.galactic`, or `$GALACTIC_HOME` (the database itself is `galactic.sqlite` there, or `$GALACTIC_DB`).

There are two tools, for two jobs:

| | Backup | Export |
| --- | --- | --- |
| What | A complete copy of the SQLite database | The map's history as one JSON file: the event log, the schema it was written under, the rows at that moment as a check, optionally the transcripts |
| Made | Daily by itself, or "Back up now" in the settings | `galactic export <file>`, or "Export the map" in the settings |
| Put back with | `galactic restore <file>` | `galactic import <file>` |
| For | Getting back to yesterday on this Mac | Moving the map to a new data folder or another machine; a readable, diffable record |

## 1. Backups

### What is backed up, when

- **Daily**, by itself, into `<data folder>/backups/`. The backup is due 24 h after the newest daily one (the time comes from the file names, so a restart does not reset the clock). It starts at the next check (every 15 minutes) once nothing has happened for 2 minutes, or regardless once it is 6 hours overdue. The copy is made while Mission Control keeps working; a few hundred MB take a second or two.
- **"Back up now"** in the settings page (Backups section) takes one at once.
- **Before an import or a restore** that replaces a database holding work, a copy of that database is taken first (`pre-import`).

Each backup is one file, `galactic-<UTC time>-<kind>.sqlite` (`auto`, `manual` or `pre-import`), readable only by you (mode 0600, folder 0700), and checked with SQLite's integrity check before it is kept. A failed or damaged copy is removed and the settings page says the last backup failed. A copy Mission Control was stopped or killed in the middle of (`….sqlite.partial`) is removed before the next backup; Mission Control waits for a backup under way before it exits on Ctrl-C.

**A full disk.** A backup is skipped, with one line in the log and a note in the settings, when the disk would keep less than 1 GiB free after the copy. A backup must never be what fills the disk under the live database.

### How many are kept

After each backup the folder is rotated: the newest daily backup of each of the last **7 days**, the newest of each of the last **4 weeks** (ISO weeks, UTC), and the newest **5** manual backups and **5** pre-import copies. Whatever the numbers, the newest backup of each kind is never deleted (so `"keepManual": 0` cannot delete the copy just taken, or the only pre-import copy of a database you replaced). Files in the folder that are not backups are left alone.

To change this, add to `config.json`:

```json
{
  "backups": { "enabled": true, "keepDaily": 7, "keepWeekly": 4, "keepManual": 5, "reserveMiB": 1024 }
}
```

`GALACTIC_BACKUPS=0` turns the daily backup off for one run (`=1` on). "Back up now" works either way. Restart Mission Control after editing the file.

### Restoring a backup

1. Stop Mission Control (Ctrl-C in its terminal, or quit the app). `galactic restore` refuses while Mission Control runs on this data folder — whatever port or address it listens on, even while it is still starting — and while another import or restore runs (see *The data lock* below).
2. Run:

   ```sh
   galactic restore galactic-20261006T031500000Z-auto.sqlite    # a name from the backups folder
   galactic restore /path/to/a/copy.sqlite                       # or any backup file
   ```

   The backup is checked first: its integrity, and that this build can run it — a backup taken by a newer build (one with a migration this build does not know) is refused; an older one is migrated when Mission Control starts. The current database, if it holds anything, is copied into `backups/` (`pre-import`), so a restore can itself be undone with another restore.
3. Start Mission Control. Agents that were running when the backup was taken are resumed as after any restart (`SPEC.md` decision 8). Those whose sessions or worktrees no longer exist show up as needing attention. Those whose sessions and worktrees do exist resume them as they are now, which is usually ahead of the backup (an open question, `SPEC.md` §8): check the work of agents resumed after a restore.

What is lost: everything that happened after the backup was taken. The restored database gets a new log identity, so every open panel reloads its state instead of resuming the old log.

**By hand**, should the command not be available: stop Mission Control, move `galactic.sqlite` and any `galactic.sqlite-wal` / `-shm` next to it aside, copy the backup file to `galactic.sqlite`, `chmod 600` it, and start. Close every panel tab first: a tab that saw events after the backup would try to resume (the new log identity `galactic restore` writes is what prevents that).

## 2. Export and import

### What an export holds

`galactic export <file>` (or "Export the map" in the settings) writes one JSON document, mode 0600:

- the **event log**, whole: every project, task, body, card, question, answer, message to an agent, state change and control. It is the truth everything else is folded from (`TECHNOLOGY.md` §6.1), so the map, the history, the inspector and the timeline replay all come back from it;
- the **schema** it was written under (the applied migrations) and the app version;
- the **rows** at the moment of the export (projects, tasks, bodies including retired demo bodies, agents, questions, cards), which the import uses as a check;
- with `--transcripts` (or the checkbox), the **transcripts**: agents' output and the markers of what retention already removed.

Never in it: the access token, `config.json`, the push (VAPID) keys, the phones' push subscriptions, the process table, agents' runtime sessions (they live in each CLI's own store, e.g. `~/.claude`), and the transcripts unless asked for. Text you wrote yourself is in it as written: messages, answers, prompts. A key you pasted into a chat is in the export, so treat the file like the database.

The export reads the database without stopping anything, so it can run while Mission Control works. "Export the map" in the settings streams the file: the log is read and sent a page at a time, so a large export does not hold the server up.

### Importing

1. Stop Mission Control. `galactic import` refuses while Mission Control runs on this data folder, and while another import or restore runs (*The data lock* below).
2. Run `galactic import map.json`. It imports only into a data folder whose database holds no map (no folder, or one where Mission Control only started once). Into a database that holds work it refuses, unless you pass `--replace`. That flag first copies the current database into `backups/` (`pre-import`) and keeps the phones' push subscriptions.
3. Start Mission Control.

The import writes the events back exactly (same `seq`, time and content), then **rebuilds every table by replaying them** with the same fold the web client uses, and compares the result with the rows in the export. If they differ, it refuses and lists the differences, and nothing is written. That happens when the exported database's rows had drifted from its own log (rows changed by an early migration, a hand edit). `--prefer-rows` then writes the exported rows instead. The new database is built next to the old one and only renamed into place once it is complete and checked, so a failed import leaves things as they were.

An export can be imported by the build that made it or a later one. A build that lacks one of its migrations (an older build, or another branch's) refuses it.

### After an import

- The map, the history, the inspector and the timeline replay are as they were at the export.
- Agents that were running at the export are resumed on the next start, as after any restart. On another machine their sessions are missing, so they show up as needing attention. Restart that work from the panel.
- **Worktrees and repositories are not in the export.** Projects keep their workspace paths. On another machine, copy or clone the repositories to the same paths before resuming work, or edit the projects' paths.
- Without `--transcripts`, agents' replies in the chats and the Steward transcript views are empty. The messages you sent are kept.
- The budgets' spend is folded again from the log. Settings (`config.json`) are not part of the map: copy the file yourself if you want them, minus the token.
- The database gets a new log identity: open panels reload instead of resuming.

## The data lock

While Mission Control runs, it holds `galactic.sqlite.lock` next to the database (its pid, its process start time, the machine's boot time, and its port once it listens). `galactic import` and `galactic restore` hold the same lock while they replace the database. So:

- an import or restore refuses while Mission Control runs on the folder — started with `--port`, on another address, or still starting (before it listens) — naming its pid and port; as a second check it also refuses when a Mission Control answers `/health` on the configured port;
- Mission Control refuses to start while another Mission Control, an import or a restore holds the lock ("Cannot start: … Stop it first."): two servers on one database would corrupt each other's view of it;
- a clean exit removes the lock. One left by a process that was killed is **stale** — its pid is gone, belongs to a process started at another time, or was written before the last reboot — and the next start, import or restore takes it over by itself. There is nothing to delete by hand.

Both the server at its start and the import / restore also remove the temporary databases a killed import or restore left (`galactic.sqlite.import-<pid>`, `galactic.sqlite.restore-<pid>`, when that pid is no longer running) and, before a backup, the `*.partial` files of a killed backup.

## 3. What is and is not included

| | Backup | Export | Export `--transcripts` |
| --- | --- | --- | --- |
| Projects, tasks, bodies, cards, questions, agents | yes | yes | yes |
| History (the event log: states, messages, answers, controls) | yes | yes | yes |
| Agents' output (transcripts) | yes, what retention kept | no | yes, what retention kept |
| Spend and budget notices | yes | rebuilt from the log | rebuilt from the log |
| Push subscriptions | yes | no | no |
| Process table | yes (reconciled at start) | no | no |
| Token, `config.json`, VAPID keys | no (files beside the database) | no | no |
| Agents' runtime sessions (`~/.claude/…`) | no | no | no |
| Worktrees and repositories on disk | no | no | no |
| Transcript chunks retention removed (decision 97) | no | no | no (only the markers saying so) |

For a whole-machine backup, also copy `~/.galactic/config.json` and `vapid.json` (secrets: keep them private), and back up your repositories as usual.
