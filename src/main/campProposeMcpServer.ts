/**
 * Stdio MCP server that lets ordinary Claude Code sessions propose Camp cards
 * (cardProposals.ts). Runs under plain node from the user MCP config, so it must not import
 * electron. HIVE_ROOT names the hive; the session's cwd is recorded as the proposal's source.
 * Newline-delimited JSON-RPC.
 */

import { createInterface } from 'node:readline';
import { getProposeMcpTools, handleProposeMcpCall } from './cardProposals';

const PROTOCOL_VERSION = '2024-11-05';
const hiveRoot = process.env.HIVE_ROOT ?? '';

type Rpc = { id?: string | number | null; method?: string; params?: Record<string, unknown> };

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
}

function handle(req: Rpc): void {
  const { id, method, params } = req;
  if (id === undefined || id === null) return;
  switch (method) {
    case 'initialize':
      send({ id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'camp-propose', version: '1.0.0' } } });
      return;
    case 'ping':
      send({ id, result: {} });
      return;
    case 'tools/list':
      send({ id, result: { tools: getProposeMcpTools(hiveRoot) } });
      return;
    case 'tools/call': {
      const name = typeof params?.name === 'string' ? params.name : '';
      const args = (params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      send({ id, result: handleProposeMcpCall(name, args, { hiveRoot, cwd: process.cwd() }) });
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
