/**
 * Card proposals from Claude sessions outside the hive. A session calls propose_card on the
 * camp-propose MCP (campProposeMcpServer.ts), which drops one JSON file into
 * <hive>/card-proposals/. Main drains that folder into Boss mail; the Boss decides whether
 * a card exists. Outside sessions never get create_card. The same server lists open ASK MEs
 * and relays the human's answer to one (askRelay.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { VALID_PROJECTS, getValidProjects, type McpToolDefinition, type McpToolResponse } from './campTools';
import type { HiveMessage } from './hive';
import { DEFAULT_DROP_FOLDERS, processDropFolder } from './dropFolders';
import { listOpenAsks, writeAskAnswer } from './askRelay';

export const CARD_PROPOSALS_DIR = 'card-proposals';

export interface CardProposal {
  title: string;
  description: string;
  project: string;
  priority?: string;
  source: string;
  proposedAt: string;
}

export const PROPOSE_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'propose_card',
    description: 'Propose a Camp card for work too large to do now, such as a structural fix for recurring friction. The Boss decides whether it becomes a card and who takes it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short summary of the work' },
        description: { type: 'string', description: 'Objective, what it would remove or fix, and the evidence' },
        project: { type: 'string', enum: VALID_PROJECTS as unknown as string[], description: 'Project name' },
        priority: { type: 'string', description: 'Suggested priority: high, medium, or low' }
      },
      required: ['title', 'description', 'project']
    }
  },
  {
    name: 'list_open_asks',
    description: 'List Camp cards with an open ASK ME question for the human: card id, title, status, assignee and the question. Read-only.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'answer_ask',
    description: "Record the human's answer to a card's open ASK ME, as if they typed it in Camp. Use only to relay what the human said or did in this session. Camp applies it within seconds and routes it to the card's assignee; it never changes card status or closes a card. Returns the card id and the question answered so you can confirm it was the right one.",
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'Card id, from list_open_asks' },
        answer: { type: 'string', description: "The human's answer, in their words where possible" }
      },
      required: ['cardId', 'answer']
    }
  }
];

/** The propose tool with its `project` enum read from `<hive>/projects.json`. */
export function getProposeMcpTools(hiveRoot?: string): McpToolDefinition[] {
  const projects = [...getValidProjects(hiveRoot)];
  return PROPOSE_MCP_TOOLS.map((tool) => ({
    ...tool,
    ...(tool.name === 'propose_card'
      ? { inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, project: { ...(tool.inputSchema.properties.project as object), enum: projects } } } }
      : {})
  }));
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

let proposalSeq = 0;

export function writeProposal(
  hiveRoot: string,
  args: Record<string, unknown>,
  source: string,
  now = new Date()
): { ok: boolean; path?: string; error?: string } {
  const title = str(args.title);
  const description = str(args.description);
  const project = str(args.project);
  const priority = str(args.priority);
  if (!title) return { ok: false, error: 'title is required' };
  if (!description) return { ok: false, error: 'description is required' };
  if (!getValidProjects(hiveRoot).includes(project)) {
    return { ok: false, error: `project must be one of: ${getValidProjects(hiveRoot).join(', ')}` };
  }
  if (!hiveRoot || !fs.existsSync(hiveRoot)) return { ok: false, error: `hive root not found: ${hiveRoot || '(HIVE_ROOT unset)'}` };
  const proposal: CardProposal = { title, description, project, ...(priority ? { priority } : {}), source, proposedAt: now.toISOString() };
  const dir = path.join(hiveRoot, CARD_PROPOSALS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  proposalSeq = (proposalSeq + 1) % 1_000_000;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const file = path.join(dir, `${now.getTime()}-${process.pid}-${proposalSeq}-${slug}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(proposal, null, 2), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
  return { ok: true, path: file };
}

/** Sends each pending proposal to the Boss and moves it to .done; a proposal that fails to send stays for the next tick. */
export function drainProposals(hiveRoot: string, deliver: (msg: Partial<HiveMessage>) => void): number {
  const lane = DEFAULT_DROP_FOLDERS.find((f) => f.dir === CARD_PROPOSALS_DIR)!;
  return processDropFolder({ hiveRoot, folder: lane, deliver }).messagesSent ?? 0;
}

export function handleProposeMcpCall(
  toolName: string,
  args: Record<string, unknown>,
  context: { hiveRoot: string; cwd: string }
): McpToolResponse {
  const text = (t: string, isError = false): McpToolResponse => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: t }] });
  try {
    if (toolName === 'propose_card') {
      const r = writeProposal(context.hiveRoot, args, context.cwd);
      return r.ok ? text(`Proposed. The Boss will see it within a minute while Camp runs (${r.path}).`) : text(r.error ?? 'failed', true);
    }
    if (toolName === 'list_open_asks') {
      const asks = listOpenAsks(context.hiveRoot);
      if (!asks.length) return text('No card has an open ASK ME.');
      return text(asks.map((a) => `${a.cardId} [${a.status}${a.assignee ? `, ${a.assignee}` : ''}] ${a.title}\n  Q: ${a.question}`).join('\n'));
    }
    if (toolName === 'answer_ask') {
      const r = writeAskAnswer(context.hiveRoot, args, context.cwd);
      return r.ok
        ? text(`Answer queued for card ${r.cardId}. Question answered: ${r.question}\nCamp records it on the card and routes it to the assignee within seconds while it runs.`)
        : text(r.error ?? 'failed', true);
    }
    return text(`Unknown tool: ${toolName}`, true);
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e), true);
  }
}
