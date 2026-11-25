/**
 * Stdio MCP server for the Boss's camp tools (campTools.ts). Launched by the Claude CLI
 * from the Boss's mcp.json as `electron campMcpServer.js` with ELECTRON_RUN_AS_NODE=1;
 * HIVE_ROOT and AGENT_ID say whose outbox the tools write into. Newline-delimited JSON-RPC.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getCampMcpTools, handleCampMcpCall } from './campTools';

const PROTOCOL_VERSION = '2024-11-05';
const hiveRoot = process.env.HIVE_ROOT ?? '';
const agentId = process.env.AGENT_ID ?? '';
// agy reads MCP servers from one per-user file, so every agy session on the machine starts
// this server. CAMP_BOSS_ID names the one session (by its own inherited AGENT_ID) that owns it.
const bossId = process.env.CAMP_BOSS_ID;
const isOwner = bossId === undefined || (agentId !== '' && agentId === bossId);

/** Camp's health check reads this to tell a Boss whose camp server never started. */
function checkIn(): void {
  if (!hiveRoot || !agentId) return;
  try {
    const dir = join(hiveRoot, 'agents', agentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'camp-mcp.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), agentId }));
  } catch { /* the health check reports the missing check-in */ }
}

type Rpc = { id?: string | number | null; method?: string; params?: Record<string, unknown> };

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
}

function handle(req: Rpc): void {
  const { id, method, params } = req;
  if (id === undefined || id === null) return;
  switch (method) {
    case 'initialize':
      if (isOwner) checkIn();
      send({ id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'camp', version: '1.0.0' } } });
      return;
    case 'ping':
      send({ id, result: {} });
      return;
    case 'tools/list':
      send({ id, result: { tools: isOwner ? getCampMcpTools(hiveRoot) : [] } });
      return;
    case 'tools/call': {
      const name = typeof params?.name === 'string' ? params.name : '';
      const args = (params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      if (!isOwner) {
        send({ id, result: { isError: true, content: [{ type: 'text', text: 'camp tools belong to the Boss session only.' }] } });
        return;
      }
      send({ id, result: handleCampMcpCall(name, args, { hiveRoot, agentId }) });
      return;
    }
    default:
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  try { handle(JSON.parse(line) as Rpc); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
});
