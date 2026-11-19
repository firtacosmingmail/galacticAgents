-- P13-32: a job approved on its card to publish (decision 165). In Auto its runs' publishes go out
-- without a publish card each time; existing jobs read as not publishing.
ALTER TABLE jobs ADD COLUMN publishes INTEGER NOT NULL DEFAULT 0;
