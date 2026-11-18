-- P13-23: send grants and standalone approvals. `projects.send_grants` holds a JSON array of
-- `SendGrant` validated by @galactic/protocol (NULL = none), a projection of `send_grant.added` /
-- `send_grant.removed`. `standalone_approvals` is the one row (id 'standalone') holding the same
-- for standalone work, which has no project: marks, grants and recorded approvals as JSON arrays.
ALTER TABLE projects ADD COLUMN send_grants TEXT;

CREATE TABLE standalone_approvals (
  id TEXT PRIMARY KEY CHECK (id = 'standalone'),
  approval_marks TEXT,
  send_grants TEXT,
  recorded_approvals TEXT
);
