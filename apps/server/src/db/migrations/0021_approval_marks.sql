-- P13-13: Auto mode and approval marks. `approval_marks` holds a JSON array of `ApprovalMark`
-- validated by @galactic/protocol (NULL = none), a projection of `approval_mark.added` /
-- `approval_mark.removed`. Auto itself rides on `waykeeper_approvals`: 1 = on, 2 = on + Auto.
ALTER TABLE projects ADD COLUMN approval_marks TEXT;
