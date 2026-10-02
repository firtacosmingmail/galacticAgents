-- P2-18: one agent's events of one type without a scan of the whole log — the chat history
-- (`GET /api/agents/:id/messages`: the last `message.sent` to an agent) and the question
-- routing's last-lifecycle lookup both filter on `type` and the payload's `agentId`.
CREATE INDEX events_type_agent ON events(type, json_extract(payload, '$.agentId'));
