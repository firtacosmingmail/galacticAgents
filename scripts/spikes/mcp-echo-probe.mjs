// Minimal stdio MCP server with one tool, `request_publish`, for the agy MCP probe.
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (l) => {
  let m;
  try {
    m = JSON.parse(l);
  } catch {
    return;
  }
  if (m.method === 'initialize')
    out({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'galactic-probe', version: '0.0.0' },
      },
    });
  else if (m.method === 'tools/list')
    out({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        tools: [
          {
            name: 'request_publish',
            description: 'Ask the user to approve publishing text. Returns the verdict.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      },
    });
  else if (m.method === 'tools/call')
    out({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, echoed: m.params.arguments }) }],
      },
    });
  else if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, result: {} });
});
