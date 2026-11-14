# P13-09 – P13-11 review (2026-11-14)

Independent review of branch `agent-waykeeper-approvals-fixes` against `main`.

## Fixed on the branch

1. **High:** a variable reassigned later in a loop body was placed with its first value (`X=a; while :; do rm -rf $X/y; X=/etc; done`). Now only a name set exactly once anywhere in the line keeps a value.
2. **High:** a value with whitespace is word-split by bash (`X="a /etc"; rm -rf $X/y`). Such a value is now unknown, and any assignment to `IFS` makes every name unknown.
3. **Medium:** a nameref (`declare -n`) or a `trap` could rewrite a variable. Both now make every name unknown.
4. **Medium:** a picked option counted even when it held back the action ("Hold — do not push…"), and any 15-character piece of it could be quoted. Now such an option never counts, and a picked option is quoted only whole.

Also fixed: the judge's prompt used a literal copy of `PICKED_OPTION_PREFIX`.

## Not fixed: already on `main` (P13-12)

- A bare-variable delete target the line never sets is not marked unplaceable.
- Paths are compared as text, so a symlink planted inside the worktree or scratch folder can point outside it.

## Known limits

- The card shows `rm -rf "$X/y"` with quotes the command did not have. The part is still flagged.
- The negation filter also drops real grants such as "Push only, no replies". These fail safe: they go to Cosmin.
- With Claude Code's sandbox on, its commands still use `/tmp/claude-<uid>`.
