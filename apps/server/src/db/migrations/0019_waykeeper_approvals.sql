-- P13-01: Waykeeper approvals (SPEC decision 154). `waykeeper_approvals` is 1 when the user turned
-- them on for the project (NULL = off); `standing_approvals` and `recorded_approvals` hold JSON
-- arrays of `StandingApproval` / `RecordedApproval` validated by @galactic/protocol (NULL = none).
-- They are projections of `waykeeper_approvals.set`, `standing_approval.added` /
-- `standing_approval.removed` and `approval.recorded`, written in the transaction of the event,
-- like every other row field.
ALTER TABLE projects ADD COLUMN waykeeper_approvals INTEGER;
ALTER TABLE projects ADD COLUMN standing_approvals TEXT;
ALTER TABLE projects ADD COLUMN recorded_approvals TEXT;
