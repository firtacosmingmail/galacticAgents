-- P9-17: a project's "Allow similar" rules (SPEC decision 138; TECHNOLOGY §8). `permission_rules`
-- holds a JSON array of `PermissionRule` validated by @galactic/protocol (NULL = no rules). It is
-- a projection of `permission.rule_added` / `permission.rule_removed`, written in the transaction
-- of the event, like every other row field.
ALTER TABLE projects ADD COLUMN permission_rules TEXT;
