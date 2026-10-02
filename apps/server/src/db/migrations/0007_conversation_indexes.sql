-- P25-01: the conversation endpoint (`GET /api/agents/:id/conversation`) pages an agent's
-- `message.sent` events and its `text` transcript chunks by (`at`, `id` / `seq`). Two partial
-- indexes serve that order and the cursor ranges, so a page reads only its rows: no sort of the
-- agent's whole history and no JSON parse of every chunk to find the text ones.
CREATE INDEX events_message_agent_at ON events(json_extract(payload, '$.agentId'), at)
  WHERE type = 'message.sent';
-- `json_valid` first: a chunk that is not JSON is simply not indexed, never an insert error.
CREATE INDEX transcript_text_at ON transcript_chunks(agent_id, at, seq)
  WHERE json_valid(chunk) AND json_extract(chunk, '$.kind') = 'text';
