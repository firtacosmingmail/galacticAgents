-- P2-01: the per-project permission policy (TECHNOLOGY §6.2, decided with P0-18) and the pin of
-- decision 11b. `permission_policy` holds a `PermissionPolicy` validated by @galactic/protocol
-- (NULL = the global default); `pinned` is 1 for work the retention timer must not archive.
ALTER TABLE projects ADD COLUMN permission_policy TEXT;
ALTER TABLE projects ADD COLUMN pinned INTEGER;
ALTER TABLE tasks ADD COLUMN pinned INTEGER;
