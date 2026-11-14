# P13-13 – P13-18 review (2026-11-14)

Per-task reviews of Waykeeper auto mode and a final review of the whole branch `agent-waykeeper-approvals-fixes`. Governing principle: a mark may only make the Waykeeper ask more; it must never silently miss what Cosmin marked.

## Fixed during the per-task reviews

- A mark made in one Steward's worktree bound only that worktree. Folder paths inside the worktree or scratch folder are now stored as `{worktree}/…` / `{scratch}/…` and expanded with the requesting Steward's roots (P13-16).
- Deriving a mark ignored the approved command's own `cd`; a `cd` it cannot follow now gives a prefix mark.
- A delete mark missed a delete of a parent folder (`rm -rf .`, `git clean -fdx`). A delete mark now covers any folder containing the marked one.
- Non-file commands (`git branch -D feat`) became folder marks, and a fallback prefix kept wrappers and assignments. Only file-argument commands now read plain words as targets, and a prefix starts at the command name (P13-14).
- The adapter's send/spend quote check now applies in Auto only (P13-15/16).

## Fixed after the final review

1. **Critical:** a site mark never caught a POST or upload to the marked host, nor `user@host` or a trailing-dot host, because it read only the classifier's hosts, which writing requests do not carry. Hosts are now read from the part's own words with `new URL`.
2. Folder marks were case-sensitive (`rm -rf NODE_MODULES` missed a `node_modules` mark). They now also compare ignoring case.
3. Folder marks missed the same action by another command: `git rm -r node_modules`, and shell edits of a marked file (`sed -i`, `>`, `tee`, `cp`/`mv` onto it). Both are covered now. A part in the mark's category with no known target has every plain argument read as one.
4. Marks from approvals logged without a `cwd` resolved against the project workspace and never matched. They now use the task's worktree as the cwd and worktree root. The scratch root comes from the cwd.
5. Minor: the Auto judge reused the task-fit parts wording. It now has its own send-or-spend wording. Prefix marks now ignore `/usr/bin/` and git's global options. The marks list shows who added a mark. The route test now covers a fresh approval that is not the Waykeeper's.

## Known limits

- Shell edits are recognised for redirects, `sed -i`, `tee`, `truncate`, `dd of=` and `cp`/`mv`/`install` destinations only. `perl -i`, `awk -i inplace`, `patch` and editors run from the shell are not. An edit by a script or inline code is not seen either.
- Host-looking words include file names such as `out.json`. Matching then asks more, never less. A derived site prefers a URL with a scheme.
- With the any-argument fallback, a mark can also ask about requests that merely name the marked folder in a part of the same category.
- Some marks are broad: `rm -rf $X` gives the prefix mark `rm …`, and `git clean -fdx` gives a delete mark on the whole worktree. Both ask more, never less. A warning on broad marks is left for Cosmin.
- A request forwarded by the mark re-check after the judge still offers a standing approval.
- Left for Cosmin: refreshing the log, a "show more" option, and the Auto label's wording "outside the project".
