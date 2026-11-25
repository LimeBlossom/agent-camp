/**
 * Camp MCP tools for the Boss:
 * - ask_human / ask_human: Ask the human a question with embedded images and backticked video paths
 * - create_card: Create a task card (assignee and project required)
 * - patch_card: Patch card fields (project validated, assignee cannot be cleared)
 * - dispatch: Write contract into card description/brief with no direct message
 * - send: Send message to agent/broadcast (refuses scheduler and replies to inform/done)
 * - floor: Compact roster and open cards summary
 * - merge: Git fetch and merge from worktree (ff-only or cherry-pick, checks dirty target), then push target to its upstream
 * - unity_hold: Boss only, set or clear <hive>/unity-hold.json, which the Unity broker enforces
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RESTART_AGENT_ACT, validateRestartRequest } from './agentRestart';
import { RESTART_CAMP_ACT, validateCampRestart } from './campRestart';
import { beginCampActivity, campActivityInProgress } from './campActivity';
import { ARCHIVE_AGENT_ACT, openCardsFor, validateArchiveRequest } from '../shared/agentArchive';
import { stalledAgents } from './standupGate';
import { liveTimings } from './timings';
import { mergePreflight } from './mergePreflight';
import { swapScreenshots } from './screenshotSwap';
import { approveReplyLine, cleanupMergedWorktree, resolveBranchTip, validateApproveAction, type ApproveAction, type CleanupResult } from './approvedMerge';
import { UNITY_HOLD_FILE } from './unityBroker';
import { hiveScratchRoot } from './workspacePaths';
import { artPipelineProjects, readHiveProjects } from './hiveProjects';
import { ASK_KINDS, RESULT_LABELS, isResultLabel, questionShapedResult } from '../shared/resultsFeed';
import { CARD_NEEDS, isCardNeeds } from '../shared/cardNeeds';
import { WORK_KIND_GUIDE, artCodeKindError } from '../shared/workKind';

const YES_NO = 'yes_no';

const MAX_ASK_CHARS = 700;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg)$/i;

/** Used only when `<hive>/projects.json` is missing or invalid. */
export const VALID_PROJECTS = ['General'] as const;

export type ValidProject = typeof VALID_PROJECTS[number];

/** Project names from `<hive>/projects.json`, or the bundled list when the file is missing or invalid. */
export function getValidProjects(hiveRoot?: string): readonly string[] {
  const root = hiveRoot || process.env.HIVE_ROOT || '';
  if (!root) return VALID_PROJECTS;
  try {
    const projects = readHiveProjects(root);
    if (projects) return projects.map((p) => p.name);
  } catch {
    // unreadable: use the bundled list
  }
  return VALID_PROJECTS;
}

/** The tool list with each `project` enum read from `<hive>/projects.json`. */
export function getCampMcpTools(hiveRoot?: string): McpToolDefinition[] {
  const projects = [...getValidProjects(hiveRoot)];
  return CAMP_MCP_TOOLS.map((tool) => {
    const props = tool.inputSchema.properties;
    if (!props.project) return tool;
    return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...props, project: { ...(props.project as object), enum: projects } } } };
  });
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const ON_APPROVE_SCHEMA = {
  type: 'object',
  description: 'Merge sign-off only: when the human replies "good" the harness runs merge_preflight and fast-forwards branch into target in repo (never pushes), closes the card and mails the worker; other answers go to the worker or you',
  properties: {
    type: { type: 'string', enum: ['merge'] },
    repo: { type: 'string', description: 'Absolute path of the target repository (main tree)' },
    worktree: { type: 'string', description: 'Absolute path of the worker worktree' },
    branch: { type: 'string', description: 'Source branch name' },
    target: { type: 'string', description: 'Target branch name; must be checked out in repo' },
    head: { type: 'string', description: 'Sha the human is approving; defaults to the branch tip now. A branch that moves after the ask goes back to you' }
  },
  required: ['type', 'repo', 'worktree', 'branch', 'target']
};

const ASK_KIND_SCHEMA = {
  type: 'string',
  enum: [...ASK_KINDS],
  description: 'decision: blocks the card until the human answers (ASK ME). result: nothing to answer, listed on the Results tab, card status untouched'
};

const ANSWERS_SCHEMA = {
  description: 'Decision only: "yes_no", or the option labels (two or more) exactly as they appear in question_md, e.g. ["A","B"]. Not needed with on_approve',
  oneOf: [{ type: 'string', enum: [YES_NO] }, { type: 'array', items: { type: 'string' }, minItems: 2 }]
};

const RESULT_LABEL_SCHEMA = {
  type: 'string',
  enum: [...RESULT_LABELS],
  description: 'Result only: answer (replies to a question the human asked) or check (a final check that passed)'
};

export const CAMP_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'ask_human',
    description: 'Put something in front of the human. kind "decision": work waits on their answer; it blocks the card and shows on ASK ME, and needs answers (option labels or "yes_no") or on_approve. kind "result": an answer to their own question or a final check that passed; it goes to the Results tab, needs no reply and never blocks the card',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', description: 'ID of the card to ask question on' },
        kind: ASK_KIND_SCHEMA,
        question_md: { type: 'string', description: 'Markdown (starts with bold sentence, under ~700 chars): the question for a decision, the report for a result' },
        answers: ANSWERS_SCHEMA,
        label: RESULT_LABEL_SCHEMA,
        images: { type: 'array', items: { type: 'string' }, description: 'Image file paths to copy and embed' },
        videos: { type: 'array', items: { type: 'string' }, description: 'Video file paths to copy and embed as backticked paths' },
        on_approve: ON_APPROVE_SCHEMA
      },
      required: ['card_id', 'kind', 'question_md']
    }
  },

  {
    name: 'create_card',
    description: 'Create a new task card on the Camp kanban board',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short summary of the task' },
        description: { type: 'string', description: 'Task description / specification' },
        project: { type: 'string', enum: VALID_PROJECTS as unknown as string[], description: 'Project name' },
        priority: { type: 'string', description: 'Priority: high, medium, or low' },
        assignee: { type: 'string', description: 'Agent ID to assign (required)' },
        difficulty: { type: 'string', description: 'easy, normal, or hard' },
        kind: { type: 'string', description: WORK_KIND_GUIDE },
        kindReason: { type: 'string', description: 'Required to override kind "code" on art-pipeline project cards naming splat, felt, sprite, strip or export' },
        needs: { type: ['array', 'null'], items: { type: 'string', enum: ['unity', 'network'] }, description: 'Capabilities the work needs: "unity" (Unity batch runs through the broker), "network" (Codex sandbox network). The assignee gets them while the card is open; null clears' },
        id: { type: 'string', description: 'Custom task ID' },
        fence: { type: 'array', items: { type: 'string' }, description: 'Path globs the work may touch; merge refuses changes outside them' }
      },
      required: ['title', 'assignee', 'project']
    }
  },
  {
    name: 'patch_card',
    description: 'Patch fields on an existing task card',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task card ID' },
        status: { type: 'string', description: 'todo, doing, blocked, or done' },
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        project: { type: 'string', enum: VALID_PROJECTS as unknown as string[], description: 'Project name' },
        priority: { type: 'string', description: 'Priority: high, medium, or low' },
        assignee: { type: 'string', description: 'Agent ID (cannot be cleared)' },
        difficulty: { type: 'string', description: 'easy, normal, or hard' },
        kind: { type: 'string', description: WORK_KIND_GUIDE },
        kindReason: { type: 'string', description: 'Required to override kind "code" on art-pipeline project cards naming splat, felt, sprite, strip or export' },
        needs: { type: ['array', 'null'], items: { type: 'string', enum: ['unity', 'network'] }, description: 'Capabilities the work needs: "unity" (Unity batch runs through the broker), "network" (Codex sandbox network). The assignee gets them while the card is open; null clears' },
        notes: { type: 'string', description: 'Replace notes' },
        notesAppend: { type: 'string', description: 'Append note line' },
        brief: { type: 'string', description: 'Handoff brief' },
        briefAppend: { type: 'string', description: 'Append brief line' },
        result: { type: 'string', description: 'Outcome summary' },
        merge: { type: 'boolean', description: 'Set to false when closing a card as dropped (status: "done", merge: false) so its branch is not merged and triggers no autobuild' },
        humanQAAppend: { type: 'object', description: 'Add human QA entry' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Card dependencies' },
        backloggedAt: { type: ['string', 'null'], description: 'ISO time or null to un-backlog' },
        fence: { type: 'array', items: { type: 'string' }, description: 'Path globs the work may touch; merge refuses changes outside them' }
      },
      required: ['id']
    }
  },
  {
    name: 'dispatch',
    description: 'Assign card and record work contract without sending a direct message',
    inputSchema: {
      type: 'object',
      properties: {
        card: { description: 'Card ID string or card creation object' },
        assignee: { type: 'string', description: 'Agent ID to dispatch to' },
        contract: { description: '4-part contract string or {objective, output, tools, boundaries} object' },
        project: { type: 'string', enum: VALID_PROJECTS as unknown as string[], description: 'Project name' }
      },
      required: ['card', 'assignee', 'contract']
    }
  },
  {
    name: 'send',
    description: 'Send a message to an agent or broadcast',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient agent ID, boss, or broadcast' },
        act: { type: 'string', description: 'request, inform, propose, query, agree, refuse, done' },
        subject: { type: 'string', description: 'Short subject line' },
        body: { type: 'string', description: 'Message body' },
        in_reply_to: { type: 'string', description: 'Message ID being replied to' }
      },
      required: ['to', 'act', 'subject', 'body']
    }
  },
  {
    name: 'floor',
    description: 'Get compact roster and open cards summary in a few hundred tokens',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'merge',
    description: 'Fetch and merge worktree branch into target (ff-only or cherry-pick, checks dirty paths), then push target to its upstream (never forced)',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Target repository path' },
        worktree: { type: 'string', description: 'Source worktree path' },
        branch: { type: 'string', description: 'Source branch name' },
        target: { type: 'string', description: 'Target branch name (e.g. main, master)' },
        cardId: { type: 'string', description: 'Card whose fence (from tasks.json) limits the changed paths' },
        fence: { type: 'array', items: { type: 'string' }, description: 'Path globs the merge may touch; overrides the card fence' },
        allowOutsideFence: { type: 'boolean', description: 'Merge even when changed paths fall outside the fence' }
      },
      required: ['repo', 'worktree', 'branch', 'target']
    }
  },
  {
    name: 'restart_agent',
    description: 'Boss only: end a hung agent session (whole process tree), write its handoff from the card brief and last activity, and start a fresh session on its current card with the next model on its tier walk or the named one. Refused for the Boss itself, and for an agent active in the last minutes unless force is true. Logged as agent-restart and noted on the card.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id to restart' },
        reason: { type: 'string', description: 'Why: goes in the handoff, the log and the card note' },
        force: { type: 'boolean', description: 'Restart even when the session was active recently' },
        model: {
          type: 'object',
          description: 'Optional model to start on instead of the next one on its tier walk',
          properties: { provider: { type: 'string' }, model: { type: 'string' } },
          required: ['provider']
        }
      },
      required: ['agentId', 'reason']
    }
  },
  {
    name: 'restart_camp',
    description: 'Boss only. Wrap up and restart the packaged Linux Camp on current.AppImage. Camp mails the outcome to the Boss. Active workers, merges and autobuilds block the request unless force is true.',
    inputSchema: {
      type: 'object',
      properties: { force: { type: 'boolean', description: 'Allow restart while work is active.' } }
    }
  },
  {
    name: 'archive_agent',
    description: 'Boss only: retire an agent (archive it). Its folder, history and registry entry are kept; it leaves the floor and the live roster, mail no longer wakes it, and the human can reopen it from the Archived list. Refused for the Boss itself, for an agent with an open todo or doing card, and for an agent with a live terminal session.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id to archive' },
        reason: { type: 'string', description: 'Why, for the log' }
      },
      required: ['agentId']
    }
  },
  {
    name: 'unity_hold',
    description: 'Boss only: set or clear a hold on Unity runs. While a hold is set the Unity broker refuses every run request (no Unity starts) except from agents in allow, and tells the requester. Takes effect on the next request; no restart.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'clear'] },
        reason: { type: 'string', description: 'Required for set: shown to every refused agent' },
        allow: { type: 'array', items: { type: 'string' }, description: 'Agent ids still allowed to run Unity during the hold' }
      },
      required: ['action']
    }
  },
  {
    name: 'who',
    description: 'One line on one agent: provider, model, state, open card (by id, name or prefix)',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'Agent id or name' } },
      required: ['agent']
    }
  },
  {
    name: 'merge_preflight',
    description: 'Read-only pass/fail before merge: clean trees, target fast-forwards, tests pass in the worktree, no stray files added',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Target repository path' },
        worktree: { type: 'string', description: 'Source worktree path' },
        branch: { type: 'string', description: 'Source branch name' },
        target: { type: 'string', description: 'Target branch name' },
        testCommand: { type: 'string', description: 'Shell command run in the worktree, exit 0 passes (e.g. node --test test/foo.test.cjs)' },
        skipTests: { type: 'boolean', description: 'Report tests as skipped instead of failed when no testCommand is given' },
        testTimeoutSec: { type: 'number', description: 'Test timeout in seconds (default 900)' }
      },
      required: ['repo', 'worktree', 'branch', 'target']
    }
  },
  {
    name: 'swap_screenshots',
    description: "Replace the images in a card's open ASK question: copies new files over the embedded ones (old kept as .prev-<stamp>), then checks every image link resolves",
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', description: 'Card whose question embeds the images' },
        images: { type: 'array', items: { type: 'string' }, description: 'New image paths, in the order of the links they replace' }
      },
      required: ['card_id', 'images']
    }
  }
];

export interface ValidateQuestionResult {
  valid: boolean;
  error?: string;
}

const MEDIA_WORD = /\b(?:stills?|screenshots?|images?|pictures?|videos?|clips?|frames?|recordings?|reels?|mock-?ups?)\b/i;
const POINTS_ELSEWHERE = /\b(?:(?:previous|earlier|prior|last|first|other)\s+(?:question|ask|message|card)s?|(?:question|ask)s?\s+(?:above|before)|above|see\s+the\s+last)\b/i;
const OWN_EMBED = /!\[[^\]]*\]\([^)]+\)|`\/[^`]+\.(?:mp4|webm|mov|mkv)`/i;

/** An ask opens with one **bold** sentence and stays a short paragraph plus its options. The human sees only the newest question, so media must travel with it. */
export function validateAskHumanQuestion(questionMd: string, hasMedia = false): ValidateQuestionResult {
  const q = (questionMd ?? '').trim();
  if (!q) return { valid: false, error: 'The question is empty.' };
  if (!/^\*\*[^*\n]+\*\*/.test(q)) return { valid: false, error: 'The first sentence must be bold: start with **what you need from the human**.' };
  if (q.length > MAX_ASK_CHARS) return { valid: false, error: `The ask is too long (${q.length} chars, limit ~${MAX_ASK_CHARS}); it is a report, not a question. Cut it to the decision and its options.` };
  if (!hasMedia && !OWN_EMBED.test(q) && MEDIA_WORD.test(q) && POINTS_ELSEWHERE.test(q)) {
    return { valid: false, error: 'The question points at media in another question; the human sees only this one. Embed the images or video in this ask again (images / videos, or ![alt](path)).' };
  }
  return { valid: true };
}

export interface CopyAndEmbedOptions {
  hiveRoot: string;
  agentId: string;
  questionMd: string;
  images?: string[];
  videos?: string[];
  copyFn?: (src: string, dest: string) => void;
  mkdirFn?: (dir: string) => void;
}

export interface CopyAndEmbedResult {
  formattedMd: string;
  copiedPaths: string[];
}

/** Copies images/videos to hive/agents/<id>/shots, embeds images as ![alt](dest) and videos as backticked absolute paths. */
export function copyAndEmbedImages(opts: CopyAndEmbedOptions): CopyAndEmbedResult {
  const copyFn = opts.copyFn ?? ((s, d) => fs.copyFileSync(s, d));
  const mkdirFn = opts.mkdirFn ?? ((d) => { fs.mkdirSync(d, { recursive: true }); });
  const images = opts.images ?? [];
  const videos = opts.videos ?? [];
  if (!images.length && !videos.length) return { formattedMd: opts.questionMd, copiedPaths: [] };

  const shotsDir = path.join(opts.hiveRoot, 'agents', opts.agentId, 'shots');
  mkdirFn(shotsDir);

  const copiedPaths: string[] = [];
  const embeds: string[] = [];

  for (const src of images) {
    if (!IMAGE_EXT.test(src)) throw new Error(`Not an image file: ${src}`);
    const dest = path.join(shotsDir, path.basename(src));
    copyFn(src, dest);
    copiedPaths.push(dest);
    embeds.push(`![${path.basename(src, path.extname(src))}](${dest})`);
  }

  for (const src of videos) {
    const dest = path.join(shotsDir, path.basename(src));
    copyFn(src, dest);
    copiedPaths.push(dest);
    embeds.push(`\`${dest}\``);
  }

  return { formattedMd: `${opts.questionMd.trimEnd()}\n\n${embeds.join('\n\n')}`, copiedPaths };
}

const MEDIA_PATH_EXT = /\.(?:png|jpe?g|gif|webp|svg|mp4|m4v|webm|mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
const MEDIA_REFS = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)|`([^`\s]+)`/g;

export interface RelocateMediaOptions {
  hiveRoot: string;
  agentId: string;
  cardId: string;
  questionMd: string;
  existsFn?: (p: string) => boolean;
  copyFn?: (src: string, dest: string) => void;
  mkdirFn?: (dir: string) => void;
}

/** the human's views serve media from card-attachments/<card>/ and agents/<id>/shots/. Any other local picture, video or sound the question names is copied into card-attachments/<card>/ and relinked; one that does not exist is an error. */
export function relocateQuestionMedia(opts: RelocateMediaOptions): { questionMd: string; error?: string } {
  const exists = opts.existsFn ?? ((p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const copyFn = opts.copyFn ?? ((s: string, d: string) => fs.copyFileSync(s, d));
  const mkdirFn = opts.mkdirFn ?? ((d: string) => { fs.mkdirSync(d, { recursive: true }); });
  const hive = opts.hiveRoot.replace(/\/+$/, '');
  const attachDir = path.join(hive, 'card-attachments', opts.cardId.trim());
  const served = [path.join(hive, 'card-attachments') + path.sep, path.join(hive, 'agents', opts.agentId, 'shots') + path.sep];
  const moved = new Map<string, string>();
  const taken = new Set<string>();
  let error: string | undefined;
  const out = opts.questionMd.replace(MEDIA_REFS, (whole: string, a?: string, b?: string, c?: string) => {
    const ref = (a ?? b ?? c ?? '').trim();
    if (error || !ref || !MEDIA_PATH_EXT.test(ref) || /^[a-z][a-z0-9+.-]*:/i.test(ref)) return whole;
    const abs = ref.startsWith('/') ? path.normalize(ref) : path.join(hive, ref);
    if (served.some((r) => abs.startsWith(r))) return whole;
    let dest = moved.get(abs);
    if (!dest) {
      if (!exists(abs)) {
        error = `${ref} is not a file that exists. The human can only see media under card-attachments/${opts.cardId.trim()}/ (or the images / videos arguments); put the file there or pass it as images / videos.`;
        return whole;
      }
      const ext = path.extname(abs);
      const stem = path.basename(abs, ext);
      let n = 1;
      dest = path.join(attachDir, `${stem}${ext}`);
      while (taken.has(dest) || (exists(dest) && dest !== abs)) dest = path.join(attachDir, `${stem}-${++n}${ext}`);
      taken.add(dest);
      mkdirFn(attachDir);
      copyFn(abs, dest);
      moved.set(abs, dest);
    }
    return whole.split(ref).join(dest);
  });
  return error ? { questionMd: opts.questionMd, error } : { questionMd: out };
}

export interface AskHumanOptions {
  hiveRoot: string;
  agentId: string;
  cardId: string;
  /** Required; anything but 'decision' or 'result' is refused. */
  kind: unknown;
  questionMd: string;
  /** Decision: 'yes_no' or two or more option labels found in questionMd. */
  answers?: unknown;
  /** Result: answer or check. */
  label?: unknown;
  images?: string[];
  videos?: string[];
  /** A merge the harness runs itself when the human answers with a bare approve. */
  onApprove?: unknown;
  /** Reads the branch tip to pin; tests inject it. */
  resolveHeadFn?: (worktree: string, branch: string) => string | null;
  outboxDir?: string;
  copyFn?: (src: string, dest: string) => void;
  mkdirFn?: (dir: string) => void;
  existsFn?: (p: string) => boolean;
  writeFileFn?: (path: string, content: string) => void;
}

export interface AskHumanResult {
  ok: boolean;
  patchPayload?: Record<string, unknown>;
  outboxPath?: string;
  formattedQuestion?: string;
  error?: string;
}

let outboxSeq = 0;

/** A name that sorts after every earlier outbox file this process wrote, so the router sees them in call order. */
function nextOutboxName(slug: string): string {
  outboxSeq = (outboxSeq + 1) % 1_000_000;
  return `${Date.now()}-${String(outboxSeq).padStart(6, '0')}-${slug.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
}

function writeOutbox(
  outboxDir: string,
  slug: string,
  payload: Record<string, unknown>,
  writeFileFn?: (path: string, content: string) => void
): string {
  const write = writeFileFn ?? ((p: string, c: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c, 'utf8');
  });
  const file = path.join(outboxDir, nextOutboxName(slug));
  write(file, JSON.stringify(payload, null, 2));
  return file;
}

function defaultOutbox(hiveRoot: string, agentId: string): string {
  return path.join(hiveRoot, 'agents', agentId, 'outbox');
}

/** Why a decision's answers do not make it answerable, or null when they do. */
function badAnswers(answers: unknown, questionMd: string): string | null {
  if (answers === YES_NO) return null;
  if (!Array.isArray(answers) || answers.length < 2 || !answers.every((a) => typeof a === 'string' && a.trim())) {
    return `a decision needs answers: "${YES_NO}", or two or more option labels from the question (e.g. ["A","B"]). With nothing to choose it is a result.`;
  }
  const missing = (answers as string[]).filter((a) => !questionMd.includes(a.trim()));
  return missing.length ? `answers ${missing.join(', ')} do not appear in question_md; name each option in the question.` : null;
}

export function askHuman(opts: AskHumanOptions): AskHumanResult {
  if (!opts.cardId?.trim()) return { ok: false, error: 'card_id is required.' };
  const check = validateAskHumanQuestion(opts.questionMd, !!(opts.images?.length || opts.videos?.length));
  if (!check.valid) return { ok: false, error: check.error };
  if (opts.kind !== 'decision' && opts.kind !== 'result') return { ok: false, error: `kind is required: "decision" (blocks the card until the human answers) or "result" (Results tab, nothing to answer); got ${JSON.stringify(opts.kind ?? null)}.` };
  if (opts.kind === 'result') {
    if (opts.onApprove !== undefined) return { ok: false, error: 'on_approve is a merge sign-off, which is always a decision; send it with kind "decision".' };
    if (!isResultLabel(opts.label)) return { ok: false, error: `a result needs label ${RESULT_LABELS.map((l) => `"${l}"`).join(' or ')}: answer replies to a question the human asked, check reports a final check that passed.` };
    const asks = questionShapedResult(opts.questionMd);
    if (asks) return { ok: false, error: `this result asks for the human's call ("${asks}"); send it with kind "decision" and answers, or drop the question from the result.` };
  } else if (opts.onApprove === undefined) {
    const bad = badAnswers(opts.answers, opts.questionMd);
    if (bad) return { ok: false, error: bad };
  }
  let action: ApproveAction | undefined;
  if (opts.onApprove !== undefined) {
    const bad = validateApproveAction(opts.onApprove, 'input');
    if (bad) return { ok: false, error: bad };
    const given = Object.fromEntries(Object.entries(opts.onApprove as Record<string, unknown>).filter(([, v]) => v !== undefined)) as Record<string, string>;
    const tip = (opts.resolveHeadFn ?? resolveBranchTip)(given.worktree, given.branch);
    if (!tip) return { ok: false, error: `on_approve: could not read the tip of ${given.branch} in ${given.worktree}` };
    if (given.head && !tip.toLowerCase().startsWith(given.head.toLowerCase())) {
      return { ok: false, error: `on_approve head ${given.head} is not the tip of ${given.branch} (${tip.slice(0, 8)}); ask about the current tip` };
    }
    action = { ...given, head: tip } as unknown as ApproveAction;
  }
  let embedded: CopyAndEmbedResult;
  try {
    const relocated = relocateQuestionMedia({ hiveRoot: opts.hiveRoot, agentId: opts.agentId, cardId: opts.cardId, questionMd: opts.questionMd, existsFn: opts.existsFn, copyFn: opts.copyFn, mkdirFn: opts.mkdirFn });
    if (relocated.error) return { ok: false, error: relocated.error };
    embedded = copyAndEmbedImages({
      hiveRoot: opts.hiveRoot,
      agentId: opts.agentId,
      questionMd: relocated.questionMd,
      images: opts.images,
      videos: opts.videos,
      copyFn: opts.copyFn,
      mkdirFn: opts.mkdirFn
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (opts.kind === 'result') {
    const patchPayload = { to: 'harness', act: 'task-patch', body: { id: opts.cardId.trim(), resultsAppend: { text: embedded.formattedMd, label: opts.label } } };
    const outboxPath = writeOutbox(opts.outboxDir ?? defaultOutbox(opts.hiveRoot, opts.agentId), `result-${opts.cardId}`, patchPayload, opts.writeFileFn);
    return { ok: true, patchPayload, outboxPath, formattedQuestion: embedded.formattedMd };
  }
  const q = action ? `${embedded.formattedMd}\n\n${approveReplyLine(action)}` : embedded.formattedMd;
  const patchPayload = {
    to: 'harness',
    act: 'task-patch',
    body: { id: opts.cardId.trim(), status: 'blocked', humanQAAppend: { q }, ...(action ? { approveAction: action } : {}) }
  };
  const outboxPath = writeOutbox(opts.outboxDir ?? defaultOutbox(opts.hiveRoot, opts.agentId), `ask-${opts.cardId}`, patchPayload, opts.writeFileFn);
  return { ok: true, patchPayload, outboxPath, formattedQuestion: q };
}

export interface CreateCardOptions {
  hiveRoot?: string;
  title: string;
  description?: string;
  project?: string;
  priority?: string;
  assignee?: string;
  difficulty?: string;
  kind?: string;
  kindReason?: string;
  id?: string;
  dependsOn?: string[];
  fence?: unknown;
  needs?: unknown;
  outboxDir?: string;
  writeFileFn?: (path: string, content: string) => void;
}

export interface CreateCardResult {
  ok: boolean;
  cardId?: string;
  createPayload?: Record<string, unknown>;
  outboxPath?: string;
  error?: string;
}

const FENCE_ERROR = 'fence must be a list of non-empty strings.';
const NEEDS_ERROR = `needs must be a list of ${CARD_NEEDS.join(', ')}, or null to clear it.`;

function isFence(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((g) => typeof g === 'string' && g.trim().length > 0);
}

function createBody(c: { id?: string; title: string; description?: string; project?: string; priority?: string; assignee?: string; difficulty?: string; kind?: string; kindReason?: string; fence?: unknown; needs?: unknown; dependsOn?: string[] }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of ['id', 'title', 'description', 'project', 'priority', 'assignee', 'difficulty', 'kind', 'kindReason'] as const) {
    const v = c[k];
    if (typeof v === 'string' && v.trim()) body[k] = v.trim();
  }
  if (Array.isArray(c.dependsOn)) body.dependsOn = c.dependsOn;
  if (isFence(c.fence)) body.fence = c.fence.map((g) => g.trim());
  if (isCardNeeds(c.needs)) body.needs = c.needs;
  return body;
}

export function createCard(opts: CreateCardOptions): CreateCardResult {
  const projects = getValidProjects(opts.hiveRoot);
  if (!opts.title?.trim()) return { ok: false, error: 'A new card needs a title.' };
  if (opts.fence !== undefined && !isFence(opts.fence)) return { ok: false, error: FENCE_ERROR };
  if (opts.needs !== undefined && !isCardNeeds(opts.needs)) return { ok: false, error: NEEDS_ERROR };
  if (!opts.assignee?.trim()) return { ok: false, error: 'assignee is required when creating a card.' };
  if (!opts.project?.trim()) return { ok: false, error: `project is required and must be one of: ${projects.join(', ')}` };
  if (!projects.includes(opts.project.trim())) {
    return { ok: false, error: `Invalid project "${opts.project}". Must be one of: ${projects.join(', ')}` };
  }
  const artKindErr = artCodeKindError({ project: opts.project, title: opts.title, description: opts.description, kind: opts.kind, kindReason: opts.kindReason }, artPipelineProjects(opts.hiveRoot));
  if (artKindErr) return { ok: false, error: artKindErr };
  const body = createBody(opts);
  const createPayload = { to: 'harness', act: 'task-create', body };
  const outboxPath = writeOutbox(opts.outboxDir ?? '', `create-${body.id ?? 'card'}`, createPayload, opts.writeFileFn);
  return { ok: true, cardId: body.id as string | undefined, createPayload, outboxPath };
}

export const create_card = createCard;

export interface PatchCardOptions {
  hiveRoot?: string;
  id: string;
  status?: string;
  title?: string;
  description?: string;
  project?: string;
  priority?: string;
  assignee?: string | null;
  difficulty?: string;
  kind?: string;
  kindReason?: string;
  notes?: string;
  notesAppend?: string;
  brief?: string;
  briefAppend?: string;
  result?: string;
  merge?: unknown;
  humanQAAppend?: Record<string, unknown>;
  dependsOn?: string[];
  backloggedAt?: string | null;
  fence?: unknown;
  needs?: unknown;
  outboxDir?: string;
  writeFileFn?: (path: string, content: string) => void;
}

export interface PatchCardResult {
  ok: boolean;
  cardId?: string;
  patchPayload?: Record<string, unknown>;
  outboxPath?: string;
  error?: string;
}

export function patchCard(opts: PatchCardOptions): PatchCardResult {
  const projects = getValidProjects(opts.hiveRoot);
  if (!opts.id?.trim()) return { ok: false, error: 'id is required when patching a card.' };
  if ('assignee' in opts && opts.assignee !== undefined) {
    if (opts.assignee === null || !String(opts.assignee).trim()) {
      return { ok: false, error: 'Assignee can never be cleared.' };
    }
  }
  if (opts.project !== undefined) {
    if (!opts.project || !projects.includes(opts.project)) {
      return { ok: false, error: `Invalid project "${opts.project}". Must be one of: ${projects.join(', ')}` };
    }
  }
  if (opts.fence !== undefined && !isFence(opts.fence)) return { ok: false, error: FENCE_ERROR };
  if (opts.needs !== undefined && opts.needs !== null && !isCardNeeds(opts.needs)) return { ok: false, error: NEEDS_ERROR };
  if (opts.merge !== undefined && typeof opts.merge !== 'boolean') {
    return { ok: false, error: 'merge must be a boolean.' };
  }

  const artKindErr = artCodeKindError({ project: opts.project, title: opts.title, description: opts.description, kind: opts.kind, kindReason: opts.kindReason }, artPipelineProjects(opts.hiveRoot));
  if (artKindErr) return { ok: false, error: artKindErr };

  const body: Record<string, unknown> = { id: opts.id.trim() };
  for (const k of ['status', 'title', 'description', 'project', 'priority', 'assignee', 'difficulty', 'kind', 'kindReason', 'notes', 'notesAppend', 'brief', 'briefAppend', 'result'] as const) {
    const v = opts[k];
    if (typeof v === 'string' && v.trim()) body[k] = v.trim();
  }
  if (typeof opts.merge === 'boolean') body.merge = opts.merge;
  if (opts.humanQAAppend && typeof opts.humanQAAppend === 'object') body.humanQAAppend = opts.humanQAAppend;
  if (Array.isArray(opts.dependsOn)) body.dependsOn = opts.dependsOn;
  if ('backloggedAt' in opts) body.backloggedAt = opts.backloggedAt ?? null;
  if (isFence(opts.fence)) body.fence = opts.fence.map((g) => g.trim());
  if (opts.needs === null || isCardNeeds(opts.needs)) body.needs = opts.needs;

  const patchPayload = { to: 'harness', act: 'task-patch', body };
  const outboxPath = writeOutbox(opts.outboxDir ?? '', `patch-${body.id}`, patchPayload, opts.writeFileFn);
  return { ok: true, cardId: opts.id.trim(), patchPayload, outboxPath };
}

export const patch_card = patchCard;

export interface WorkContract {
  objective?: string;
  output?: string;
  tools?: string;
  boundaries?: string;
}

export interface DispatchOptions {
  hiveRoot?: string;
  card: string | { id?: string; title: string; project?: string; description?: string; priority?: string; difficulty?: string; kind?: string; kindReason?: string };
  assignee: string;
  contract: string | WorkContract;
  project?: string;
  outboxDir?: string;
  writeFileFn?: (path: string, content: string) => void;
}

export interface DispatchResult {
  ok: boolean;
  cardId?: string;
  actions?: Array<{ kind: 'create' | 'patch'; path?: string; payload: Record<string, unknown> }>;
  error?: string;
}

function formatContract(c: string | WorkContract): string {
  if (typeof c === 'string') return c.trim();
  return [
    '## Contract',
    `- **OBJECTIVE**: ${c.objective ?? ''}`,
    `- **OUTPUT**: ${c.output ?? ''}`,
    `- **TOOLS**: ${c.tools ?? ''}`,
    `- **BOUNDARIES**: ${c.boundaries ?? ''}`
  ].join('\n');
}

/** Writes the contract into the card description/brief with NO direct message (harness respawns fresh on the card). */
export function dispatchTask(opts: DispatchOptions): DispatchResult {
  const projects = getValidProjects(opts.hiveRoot);
  if (!opts.assignee?.trim()) return { ok: false, error: 'assignee is required.' };
  if (!opts.contract) return { ok: false, error: 'contract is required.' };
  const assignee = opts.assignee.trim();
  const contractText = formatContract(opts.contract);
  if (!contractText) return { ok: false, error: 'contract cannot be empty.' };

  const outboxDir = opts.outboxDir ?? '';
  const actions: NonNullable<DispatchResult['actions']> = [];
  let cardId: string;

  if (typeof opts.card === 'string') {
    cardId = opts.card.trim();
    if (!cardId) return { ok: false, error: 'card id is empty.' };
    const patchBody: Record<string, unknown> = { id: cardId, assignee, brief: contractText };
    const proj = opts.project?.trim();
    if (proj) {
      if (!projects.includes(proj)) {
        return { ok: false, error: `Invalid project "${proj}". Must be one of: ${projects.join(', ')}` };
      }
      patchBody.project = proj;
    }
    actions.push({ kind: 'patch', payload: { to: 'harness', act: 'task-patch', body: patchBody } });
  } else {
    if (!opts.card?.title?.trim()) return { ok: false, error: 'A new card needs a title.' };
    const proj = (opts.card.project ?? opts.project)?.trim();
    if (!proj || !projects.includes(proj)) {
      return { ok: false, error: `Invalid project "${proj}". Must be one of: ${projects.join(', ')}` };
    }
    const cardDesc = opts.card.description?.trim();
    const fullDesc = cardDesc ? `${cardDesc}\n\n${contractText}` : contractText;
    const artKindErr = artCodeKindError({ project: proj, title: opts.card.title, description: fullDesc, kind: opts.card.kind, kindReason: opts.card.kindReason }, artPipelineProjects(opts.hiveRoot));
    if (artKindErr) return { ok: false, error: artKindErr };
    const body = createBody({
      ...opts.card,
      assignee,
      project: proj,
      description: fullDesc
    });
    cardId = typeof body.id === 'string' ? body.id : '';
    if (!cardId) return { ok: false, error: 'A dispatched new card needs an id so it can be tracked.' };
    body.brief = contractText;
    actions.push({ kind: 'create', payload: { to: 'harness', act: 'task-create', body } });
  }

  for (const a of actions) a.path = writeOutbox(outboxDir, `${a.kind}-${cardId}`, a.payload, opts.writeFileFn);
  return { ok: true, cardId, actions };
}

export const dispatch = dispatchTask;

export interface SendMessageOptions {
  to: string;
  act: string;
  subject: string;
  body: string;
  in_reply_to?: string;
  hiveRoot?: string;
  agentId?: string;
  outboxDir?: string;
  inboxDir?: string;
  writeFileFn?: (path: string, content: string) => void;
}

export interface SendMessageResult {
  ok: boolean;
  outboxPath?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

/** Check if a message in inbox or inbox/.done has act 'inform' or 'done'. */
function checkReplyTarget(inboxDir: string, replyId: string): { ok: boolean; error?: string } {
  const candidates = [
    path.join(inboxDir, `${replyId}.json`),
    path.join(inboxDir, replyId),
    path.join(inboxDir, '.done', `${replyId}.json`),
    path.join(inboxDir, '.done', replyId)
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const msg = JSON.parse(fs.readFileSync(c, 'utf8'));
        if (msg.act === 'inform' || msg.act === 'done') {
          return { ok: false, error: `Refusing reply: message ${replyId} has act "${msg.act}". Only request, query and propose expect a reply.` };
        }
        return { ok: true };
      } catch { /* unreadable */ }
    }
  }

  // Scan .done directory if file name doesn't match ID directly
  const doneDir = path.join(inboxDir, '.done');
  if (fs.existsSync(doneDir)) {
    try {
      const files = fs.readdirSync(doneDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const msg = JSON.parse(fs.readFileSync(path.join(doneDir, f), 'utf8'));
          if (msg.id === replyId) {
            if (msg.act === 'inform' || msg.act === 'done') {
              return { ok: false, error: `Refusing reply: message ${replyId} has act "${msg.act}". Only request, query and propose expect a reply.` };
            }
            return { ok: true };
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return { ok: true };
}

export function sendMsg(opts: SendMessageOptions): SendMessageResult {
  if (!opts.to?.trim()) return { ok: false, error: 'to is required.' };
  if (!opts.act?.trim()) return { ok: false, error: 'act is required.' };
  if (!opts.subject?.trim()) return { ok: false, error: 'subject is required.' };
  if (!opts.body?.trim()) return { ok: false, error: 'body is required.' };

  const to = opts.to.trim();
  if (to.toLowerCase() === 'scheduler') {
    return { ok: false, error: 'Cannot send messages to "scheduler": standups are handled and archived, never replied to.' };
  }

  const inReplyTo = opts.in_reply_to?.trim();
  if (inReplyTo) {
    const inboxDir = opts.inboxDir ?? (opts.hiveRoot && opts.agentId ? path.join(opts.hiveRoot, 'agents', opts.agentId, 'inbox') : '');
    if (inboxDir && fs.existsSync(inboxDir)) {
      const replyCheck = checkReplyTarget(inboxDir, inReplyTo);
      if (!replyCheck.ok) return { ok: false, error: replyCheck.error };
    }
  }

  const payload: Record<string, unknown> = {
    to,
    act: opts.act.trim(),
    subject: opts.subject.trim(),
    body: opts.body.trim()
  };
  if (inReplyTo) payload.in_reply_to = inReplyTo;

  const outboxDir = opts.outboxDir ?? (opts.hiveRoot && opts.agentId ? defaultOutbox(opts.hiveRoot, opts.agentId) : '');
  const outboxPath = writeOutbox(outboxDir, `msg-${to}-${payload.act}`, payload, opts.writeFileFn);
  return { ok: true, outboxPath, payload };
}

export const send = sendMsg;

export interface FloorOptions {
  hiveRoot?: string;
}

export interface FloorResult {
  ok: boolean;
  summary: string;
  rosterCount: number;
  openCardCount: number;
  error?: string;
}

export interface WhoResult {
  ok: boolean;
  line?: string;
  error?: string;
}

const readJsonFile = (p: string): Record<string, unknown> | null => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return null; }
};

/** One agent in one line: name, id, provider, model, state, and its open card. `agent`
 *  matches an id, a name (any case) or a unique id or name prefix. */
export function whoLookup(opts: { hiveRoot?: string; agent: string }): WhoResult {
  const hiveRoot = opts.hiveRoot || process.env.HIVE_ROOT || '';
  const q = (opts.agent ?? '').trim().toLowerCase();
  if (!q) return { ok: false, error: 'agent is required (id or name).' };
  const reg = (readJsonFile(path.join(hiveRoot, 'registry.json'))?.agents ?? {}) as Record<string, Record<string, unknown>>;
  const fleetList = readJsonFile(path.join(hiveRoot, 'fleet.json'))?.agents;
  const fleet = new Map((Array.isArray(fleetList) ? fleetList : []).filter((a) => a && typeof a.id === 'string').map((a) => [a.id as string, a as Record<string, unknown>]));
  const ids = [...new Set([...Object.keys(reg), ...fleet.keys()])];
  const nameOf = (id: string): string => String(fleet.get(id)?.name ?? reg[id]?.name ?? id);
  const exact = ids.filter((id) => id.toLowerCase() === q || nameOf(id).toLowerCase() === q);
  const hits = exact.length ? exact : ids.filter((id) => id.toLowerCase().startsWith(q) || nameOf(id).toLowerCase().startsWith(q));
  if (hits.length !== 1) return { ok: false, error: hits.length ? `"${opts.agent}" matches ${hits.map(nameOf).join(', ')}` : `no agent "${opts.agent}"` };
  const id = hits[0];
  const r = reg[id] ?? {};
  const f = fleet.get(id) ?? {};
  const state = r.archived ? 'archived' : f.dormant || r.dormant ? 'dormant' : f.onHold || r.onHold ? 'on hold' : f.quotaBlocked ? 'quota-blocked' : f.jailRefused ? 'down (sandbox refused spawn)' : String(r.status ?? 'active');
  const parts = [`${nameOf(id)} [${id}]`, String(r.provider ?? f.engine ?? 'claude'), String(f.model ?? 'model unknown'), state];
  if (typeof f.breaker === 'string' && f.breaker !== 'healthy') parts.push(`breaker ${f.breaker}`);
  if (typeof f.lastActiveSecAgo === 'number') parts.push(`active ${Math.round(f.lastActiveSecAgo / 60)}m ago`);
  if (typeof f.inboxBacklog === 'number' && f.inboxBacklog > 0) parts.push(`inbox ${f.inboxBacklog}`);
  const tasks = readJsonFile(path.join(hiveRoot, 'tasks.json'))?.tasks;
  const open = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.assignee === id && (t.status === 'doing' || t.status === 'todo'));
  const doing = open.find((t) => t.status === 'doing');
  if (doing) parts.push(`doing ${doing.id}`);
  else if (open.length) parts.push(`${open.length} todo`);
  return { ok: true, line: parts.join(' | ') };
}

export function floorSummary(opts: FloorOptions): FloorResult {
  const hiveRoot = opts.hiveRoot || process.env.HIVE_ROOT || '';
  let fleetAgents: Array<Record<string, unknown>> = [];
  let regAgents: Record<string, Record<string, unknown>> = {};
  let openTasks: Array<Record<string, unknown>> = [];

  const fleetPath = path.join(hiveRoot, 'fleet.json');
  if (fs.existsSync(fleetPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(fleetPath, 'utf8'));
      if (Array.isArray(parsed.agents)) fleetAgents = parsed.agents;
    } catch { /* unreadable */ }
  }

  const regPath = path.join(hiveRoot, 'registry.json');
  if (fs.existsSync(regPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      if (parsed.agents && typeof parsed.agents === 'object') regAgents = parsed.agents;
    } catch { /* unreadable */ }
  }

  const tasksPath = path.join(hiveRoot, 'tasks.json');
  if (fs.existsSync(tasksPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
      if (Array.isArray(parsed.tasks)) {
        openTasks = parsed.tasks.filter((t: any) => t && t.status !== 'done' && t.status !== 'closed');
      }
    } catch { /* unreadable */ }
  }

  const stalled = stalledAgents({ agents: fleetAgents }, { tasks: openTasks }, liveTimings().stallAfterMs / 1000);
  const lines: string[] = ['ROSTER:'];
  if (fleetAgents.length > 0) {
    for (const a of fleetAgents) {
      const id = String(a.id ?? '');
      const name = String(a.name ?? regAgents[id]?.name ?? id);
      const role = String(a.role ?? regAgents[id]?.role ?? 'agent');
      const state = a.dormant ? 'dormant' : String(a.status ?? 'active');
      const model = a.model ? String(a.model) : '';
      const breaker = a.breaker ? `breaker: ${a.breaker}` : '';
      const inbox = a.inboxBacklog !== undefined ? `inbox: ${a.inboxBacklog}` : '';
      const stallCard = stalled.get(id);
      const stall = stallCard ? `STALLED on ${stallCard} (restart_agent)` : '';
      const jail = a.jailRefused && typeof a.jailRefused === 'object' ? `DOWN: sandbox refused spawn: ${String((a.jailRefused as { error?: unknown }).error)}` : '';
      const details = [state, model, breaker, inbox, stall, jail].filter(Boolean).join(' | ');
      lines.push(`- ${name} [${id}] (${role}) | ${details}`);
    }
  } else {
    for (const [id, a] of Object.entries(regAgents)) {
      lines.push(`- ${a.name ?? id} [${id}] (${a.role ?? 'agent'}) | ${a.dormant ? 'dormant' : 'active'}`);
    }
  }

  lines.push('', `OPEN CARDS (${openTasks.length}):`);
  for (const t of openTasks) {
    const id = String(t.id ?? '');
    const status = String(t.status ?? 'todo');
    const project = String(t.project ?? 'NoProject');
    const assignee = String(t.assignee ?? 'unassigned');
    const title = String(t.title ?? '');
    lines.push(`- [${id}] ${status} (${assignee}) [${project}] ${title}`);
  }

  return {
    ok: true,
    summary: lines.join('\n'),
    rosterCount: fleetAgents.length || Object.keys(regAgents).length,
    openCardCount: openTasks.length
  };
}

/** Boss-only: write or remove `<hive>/unity-hold.json`. The broker reads it at every request. */
export function setUnityHold(opts: { hiveRoot: string; agentId: string; args: Record<string, unknown> }): { ok: boolean; error?: string; file?: string; cleared?: boolean } {
  const boss = readJsonFile(path.join(opts.hiveRoot, 'registry.json'))?.godId;
  if (typeof boss !== 'string' || opts.agentId !== boss) return { ok: false, error: 'unity_hold is for the Boss only' };
  const file = path.join(opts.hiveRoot, UNITY_HOLD_FILE);
  const action = opts.args.action;
  if (action === 'clear') {
    fs.rmSync(file, { force: true });
    return { ok: true, file, cleared: true };
  }
  if (action !== 'set') return { ok: false, error: 'action must be "set" or "clear"' };
  const reason = typeof opts.args.reason === 'string' ? opts.args.reason.trim() : '';
  if (!reason) return { ok: false, error: 'a hold needs a reason' };
  const allow = Array.isArray(opts.args.allow) ? opts.args.allow.filter((a): a is string => typeof a === 'string' && !!a.trim()) : [];
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ reason, since: new Date().toISOString(), ...(allow.length ? { allow } : {}) }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { ok: true, file };
}

/** Boss-only: queue a `restart-agent` for the harness, which re-checks the sender and does the restart. */
export function restartAgent(opts: { hiveRoot: string; agentId: string; args: Record<string, unknown>; outboxDir: string }): { ok: boolean; error?: string; queued?: string } {
  const reg = (readJsonFile(path.join(opts.hiveRoot, 'registry.json')) ?? {}) as { godId?: string; agents?: Record<string, Record<string, unknown>> };
  const agents = reg.agents ?? {};
  const check = validateRestartRequest(opts.agentId, opts.args, {
    godId: typeof reg.godId === 'string' ? reg.godId : null,
    known: (id) => Object.prototype.hasOwnProperty.call(agents, id),
    isGod: (id) => agents[id]?.isGod === true
  });
  if (!check.ok) return { ok: false, error: check.error };
  const { agentId, reason, force, model } = check.request;
  const body = { agentId, reason, ...(force ? { force: true } : {}), ...(model ? { model } : {}) };
  const file = writeOutbox(opts.outboxDir, `restart-${agentId}`, { to: 'harness', act: RESTART_AGENT_ACT, body });
  return { ok: true, queued: file };
}

/** Boss-only: queue an `archive-agent` for the harness, which re-checks it and archives. */
export function archiveAgent(opts: { hiveRoot: string; agentId: string; args: Record<string, unknown>; outboxDir: string }): { ok: boolean; error?: string; queued?: string } {
  const reg = (readJsonFile(path.join(opts.hiveRoot, 'registry.json')) ?? {}) as { godId?: string; agents?: Record<string, Record<string, unknown>> };
  const agents = reg.agents ?? {};
  const tasks = (readJsonFile(path.join(opts.hiveRoot, 'tasks.json'))?.tasks ?? []) as Array<Record<string, unknown>>;
  const check = validateArchiveRequest(opts.agentId, opts.args, {
    godId: typeof reg.godId === 'string' ? reg.godId : null,
    known: (id) => Object.prototype.hasOwnProperty.call(agents, id),
    isGod: (id) => agents[id]?.isGod === true,
    isArchived: (id) => agents[id]?.archived === true,
    openCards: (id) => openCardsFor(id, tasks)
  });
  if (!check.ok) return { ok: false, error: check.error };
  const file = writeOutbox(opts.outboxDir, `archive-${check.request.agentId}`, { to: 'harness', act: ARCHIVE_AGENT_ACT, body: check.request });
  return { ok: true, queued: file };
}

export const floor = floorSummary;

export interface MergeOptions {
  repo: string;
  worktree: string;
  branch: string;
  target: string;
  /** Path globs the merge may touch; wins over the card's fence. */
  fence?: string[];
  /** Card whose `fence` is read from `<hiveRoot>/tasks.json` when no fence is passed. */
  cardId?: string;
  hiveRoot?: string;
  allowOutsideFence?: boolean;
  /** Post-merge closeout of the worker's scratch worktree; unset runs none. */
  closeout?: MergeCloseout;
}

export interface MergeCloseout {
  enabled: boolean;
  /** The worker whose `<scratchRoot>/<workerId>/` must hold the tree; unset refuses. */
  workerId?: string;
  scratchRoot: string;
  tasks: readonly unknown[];
  liveAgentCwds: Array<{ id: string; cwd?: string }>;
}

export interface MergeResult {
  ok: boolean;
  offendingPaths?: string[];
  newHead?: string;
  mode?: 'fast-forward' | 'cherry-pick';
  error?: string;
  /** A failed push leaves the merge in place; the Boss reports pushError instead of retrying with force. */
  push?: 'pushed' | 'no-upstream' | 'failed';
  pushError?: string;
  /** What the closeout did with the worktree; absent when none was asked for. */
  cleanup?: CleanupResult;
}

function closeoutAfterMerge(opts: MergeOptions, head: string): Pick<MergeResult, 'cleanup'> {
  const c = opts.closeout;
  if (!c) return {};
  if (c.enabled && !c.workerId) return { cleanup: { removed: false, reason: 'no owning worker is known (pass cardId so its assignee owns the tree)' } };
  return { cleanup: cleanupMergedWorktree({
    repo: opts.repo, worktree: opts.worktree, branch: opts.branch, target: opts.target, head,
    workerId: c.workerId ?? '', scratchRoot: c.scratchRoot, enabled: c.enabled, tasks: c.tasks, agents: c.liveAgentCwds
  }) };
}

/** The closeout the Boss's merge tool runs: flag from CAMP_MERGE_CLEANUP (set by the app
 *  from config harnessMergeCleanup when it writes the Boss's mcp.json), owner from the
 *  card's assignee, ledger and agents from the hive files. */
export function mcpMergeCloseout(hiveRoot: string, cardId: string | undefined): MergeCloseout {
  const read = (f: string): unknown => { try { return JSON.parse(fs.readFileSync(path.join(hiveRoot, f), 'utf8')); } catch { return null; } };
  const ledger = read('tasks.json') as { tasks?: unknown[] } | null;
  const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  const card = cardId ? tasks.find((t) => (t as { id?: unknown })?.id === cardId) as { assignee?: unknown } | undefined : undefined;
  const reg = read('registry.json') as { agents?: Record<string, { cwd?: string }> } | null;
  return {
    enabled: process.env.CAMP_MERGE_CLEANUP === '1',
    workerId: typeof card?.assignee === 'string' && card.assignee ? card.assignee : undefined,
    scratchRoot: hiveScratchRoot(),
    tasks,
    liveAgentCwds: Object.entries(reg?.agents ?? {}).map(([id, a]) => ({ id, cwd: a?.cwd }))
  };
}

function pushTarget(repo: string, target: string): Pick<MergeResult, 'push' | 'pushError'> {
  const remote = spawnSync('git', ['-C', repo, 'config', `branch.${target}.remote`], { encoding: 'utf8' }).stdout.trim();
  const mergeRef = spawnSync('git', ['-C', repo, 'config', `branch.${target}.merge`], { encoding: 'utf8' }).stdout.trim();
  if (!remote || !mergeRef) return { push: 'no-upstream' };
  const pushRes = spawnSync('git', ['-C', repo, 'push', remote, `refs/heads/${target}:${mergeRef}`], { encoding: 'utf8' });
  if (pushRes.status !== 0) return { push: 'failed', pushError: (pushRes.stderr || pushRes.stdout).trim() };
  return { push: 'pushed' };
}

/** Glob to RegExp: `**` crosses directories, `*` and `?` stay inside one path segment. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function fenceFromCard(hiveRoot: string, cardId: string): string[] | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(hiveRoot, 'tasks.json'), 'utf8')) as { tasks?: Array<{ id?: string; fence?: unknown }> };
    const card = raw.tasks?.find((t) => t.id === cardId);
    return isFence(card?.fence) ? card.fence : undefined;
  } catch {
    return undefined;
  }
}

/** Changed paths (renames and copies count both names) that match no fence glob. */
function pathsOutsideFence(repo: string, target: string, fence: string[]): { paths: string[] } | { error: string } {
  const diff = spawnSync('git', ['-C', repo, 'diff', '--name-status', '-M', '-z', `${target}...FETCH_HEAD`], { encoding: 'utf8' });
  if (diff.status !== 0) return { error: `git diff for fence check failed: ${diff.stderr || diff.stdout}` };
  const fields = diff.stdout.split('\0');
  const changed: string[] = [];
  for (let i = 0; i < fields.length && fields[i]; i++) {
    const take = /^[RC]/.test(fields[i]) ? 2 : 1;
    changed.push(...fields.slice(i + 1, i + 1 + take));
    i += take;
  }
  const globs = fence.map((g) => globToRegExp(g.trim()));
  return { paths: [...new Set(changed)].filter((p) => !globs.some((g) => g.test(p))) };
}

export function mergeBranch(opts: MergeOptions): MergeResult {
  if (!opts.repo || !opts.worktree || !opts.branch || !opts.target) {
    return { ok: false, error: 'repo, worktree, branch, and target are all required.' };
  }

  // 1. Check dirty paths in target repo
  const statusRes = spawnSync('git', ['-C', opts.repo, 'status', '--porcelain'], { encoding: 'utf8' });
  if (statusRes.status !== 0) {
    return { ok: false, error: `git status in ${opts.repo} failed: ${statusRes.stderr || statusRes.stdout}` };
  }
  const dirtyPaths = statusRes.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim());

  // 2. Fetch from worktree
  const fetchRes = spawnSync('git', ['-C', opts.repo, 'fetch', opts.worktree, opts.branch], { encoding: 'utf8' });
  if (fetchRes.status !== 0) {
    return { ok: false, error: `git fetch failed: ${fetchRes.stderr || fetchRes.stdout}` };
  }

  // 3. Check which paths are touched by incoming commits
  const logRes = spawnSync('git', ['-C', opts.repo, 'log', `${opts.target}..FETCH_HEAD`, '--name-only', '--format='], { encoding: 'utf8' });
  if (logRes.status === 0) {
    const touchedPaths = logRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const conflicting = touchedPaths.filter((p) => dirtyPaths.includes(p));
    if (conflicting.length > 0) {
      return { ok: false, error: `Cannot merge: incoming commits touch dirty files in target tree: ${conflicting.join(', ')}` };
    }
  }

  // 3b. Fence: refuse changes outside the allowed globs
  const fence = opts.fence ?? (opts.cardId && opts.hiveRoot ? fenceFromCard(opts.hiveRoot, opts.cardId) : undefined);
  if (fence && !opts.allowOutsideFence) {
    const outside = pathsOutsideFence(opts.repo, opts.target, fence);
    if ('error' in outside) return { ok: false, error: outside.error };
    if (outside.paths.length > 0) {
      return { ok: false, error: `Cannot merge: changed paths outside fence: ${outside.paths.join(', ')}`, offendingPaths: outside.paths };
    }
  }

  const tip = spawnSync('git', ['-C', opts.repo, 'rev-parse', 'FETCH_HEAD^{commit}'], { encoding: 'utf8' }).stdout.trim();

  // 4. Check if target can be fast-forwarded
  const ffCheck = spawnSync('git', ['-C', opts.repo, 'merge-base', '--is-ancestor', opts.target, 'FETCH_HEAD']);
  if (ffCheck.status === 0) {
    // Fast-forward
    spawnSync('git', ['-C', opts.repo, 'checkout', opts.target], { encoding: 'utf8' });
    const mergeRes = spawnSync('git', ['-C', opts.repo, 'merge', '--ff-only', 'FETCH_HEAD'], { encoding: 'utf8' });
    if (mergeRes.status !== 0) {
      return { ok: false, error: `Fast-forward merge failed: ${mergeRes.stderr || mergeRes.stdout}` };
    }
    const headRes = spawnSync('git', ['-C', opts.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    return { ok: true, newHead: headRes.stdout.trim(), mode: 'fast-forward', ...pushTarget(opts.repo, opts.target), ...closeoutAfterMerge(opts, tip) };
  }

  // 5. Target moved: cherry-pick commits onto target
  spawnSync('git', ['-C', opts.repo, 'checkout', opts.target], { encoding: 'utf8' });
  const revsRes = spawnSync('git', ['-C', opts.repo, 'log', '--reverse', '--format=%H', `${opts.target}..FETCH_HEAD`], { encoding: 'utf8' });
  const commits = revsRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  for (const sha of commits) {
    const cpRes = spawnSync('git', ['-C', opts.repo, 'cherry-pick', sha], { encoding: 'utf8' });
    if (cpRes.status !== 0) {
      spawnSync('git', ['-C', opts.repo, 'cherry-pick', '--abort'], { encoding: 'utf8' });
      return { ok: false, error: `Cherry-pick failed on ${sha}: ${cpRes.stderr || cpRes.stdout}` };
    }
  }

  const headRes = spawnSync('git', ['-C', opts.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return { ok: true, newHead: headRes.stdout.trim(), mode: 'cherry-pick', ...pushTarget(opts.repo, opts.target), ...closeoutAfterMerge(opts, tip) };
}

export const merge = mergeBranch;

export interface CampMcpContext {
  hiveRoot: string;
  agentId: string;
  outboxDir?: string;
  inboxDir?: string;
}

export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function reply(result: { ok: boolean; error?: string }): McpToolResponse {
  const text = JSON.stringify(result);
  return result.ok ? { content: [{ type: 'text', text }] } : { isError: true, content: [{ type: 'text', text: result.error ?? 'failed' }] };
}

export function handleCampMcpCall(
  toolName: string,
  args: Record<string, unknown>,
  context: CampMcpContext
): McpToolResponse {
  const outboxDir = context.outboxDir ?? defaultOutbox(context.hiveRoot, context.agentId);
  try {
    switch (toolName) {
      case 'ask_human':
        return reply(askHuman({
          hiveRoot: context.hiveRoot,
          agentId: context.agentId,
          cardId: str(args.card_id) ?? '',
          kind: args.kind,
          answers: args.answers,
          label: args.label,
          questionMd: str(args.question_md) ?? '',
          images: Array.isArray(args.images) ? args.images.filter((i): i is string => typeof i === 'string') : undefined,
          videos: Array.isArray(args.videos) ? args.videos.filter((i): i is string => typeof i === 'string') : undefined,
          onApprove: args.on_approve === null ? undefined : args.on_approve,
          outboxDir
        }));
      case 'create_card':
        return reply(createCard({
          hiveRoot: context.hiveRoot,
          title: str(args.title) ?? '',
          description: str(args.description),
          project: str(args.project),
          priority: str(args.priority),
          assignee: str(args.assignee),
          difficulty: str(args.difficulty),
          kind: str(args.kind),
          kindReason: str(args.kindReason),
          id: str(args.id),
          fence: args.fence,
          needs: args.needs,
          outboxDir
        }));
      case 'patch_card':
        return reply(patchCard({
          hiveRoot: context.hiveRoot,
          id: str(args.id) ?? '',
          status: str(args.status),
          title: str(args.title),
          description: str(args.description),
          project: str(args.project),
          priority: str(args.priority),
          assignee: args.assignee === null ? null : str(args.assignee),
          difficulty: str(args.difficulty),
          kind: str(args.kind),
          kindReason: str(args.kindReason),
          notes: str(args.notes),
          notesAppend: str(args.notesAppend),
          brief: str(args.brief),
          briefAppend: str(args.briefAppend),
          result: str(args.result),
          merge: args.merge,
          humanQAAppend: typeof args.humanQAAppend === 'object' && args.humanQAAppend !== null ? args.humanQAAppend as Record<string, unknown> : undefined,
          dependsOn: Array.isArray(args.dependsOn) ? args.dependsOn.filter((d): d is string => typeof d === 'string') : undefined,
          backloggedAt: args.backloggedAt === null ? null : str(args.backloggedAt),
          fence: args.fence,
          needs: args.needs,
          outboxDir
        }));
      case 'dispatch':
        return reply(dispatchTask({
          hiveRoot: context.hiveRoot,
          card: (typeof args.card === 'object' && args.card !== null ? args.card : str(args.card) ?? '') as DispatchOptions['card'],
          assignee: str(args.assignee) ?? '',
          contract: (typeof args.contract === 'object' && args.contract !== null ? args.contract : str(args.contract) ?? '') as DispatchOptions['contract'],
          project: str(args.project),
          outboxDir
        }));
      case 'send':
        return reply(sendMsg({
          to: str(args.to) ?? '',
          act: str(args.act) ?? '',
          subject: str(args.subject) ?? '',
          body: str(args.body) ?? '',
          in_reply_to: str(args.in_reply_to),
          hiveRoot: context.hiveRoot,
          agentId: context.agentId,
          outboxDir,
          inboxDir: context.inboxDir
        }));
      case 'floor':
        return reply(floorSummary({ hiveRoot: context.hiveRoot }));
      case 'merge': {
        const finish = beginCampActivity(context.hiveRoot, 'merge');
        try {
          if (campActivityInProgress(context.hiveRoot, 'restart')) return reply({ ok: false, error: 'Camp is preparing to restart.' });
          return reply(mergeBranch({
            repo: str(args.repo) ?? '',
            worktree: str(args.worktree) ?? '',
            branch: str(args.branch) ?? '',
            target: str(args.target) ?? '',
            fence: isFence(args.fence) ? args.fence : undefined,
            cardId: str(args.cardId),
            hiveRoot: context.hiveRoot,
            allowOutsideFence: args.allowOutsideFence === true,
            closeout: mcpMergeCloseout(context.hiveRoot, str(args.cardId))
          }));
        } finally { finish(); }
      }
      case 'restart_camp': {
        const boss = readJsonFile(path.join(context.hiveRoot, 'registry.json'))?.godId;
        const check = validateCampRestart(context.agentId, typeof boss === 'string' ? boss : null, args);
        if (!check.ok) return reply(check);
        const queued = writeOutbox(outboxDir, RESTART_CAMP_ACT, { to: 'harness', act: RESTART_CAMP_ACT, body: check.request });
        const result = { ok: true, queued };
        return reply(result);
      }
      case 'restart_agent':
        return reply(restartAgent({ hiveRoot: context.hiveRoot, agentId: context.agentId, args, outboxDir }));
      case 'archive_agent':
        return reply(archiveAgent({ hiveRoot: context.hiveRoot, agentId: context.agentId, args, outboxDir }));
      case 'unity_hold':
        return reply(setUnityHold({ hiveRoot: context.hiveRoot, agentId: context.agentId, args }));
      case 'who': {
        const r = whoLookup({ hiveRoot: context.hiveRoot, agent: str(args.agent) ?? '' });
        return r.ok ? { content: [{ type: 'text', text: r.line ?? '' }] } : reply(r);
      }
      case 'swap_screenshots':
        return reply(swapScreenshots({
          hiveRoot: context.hiveRoot,
          cardId: str(args.card_id) ?? '',
          images: Array.isArray(args.images) ? args.images.filter((i): i is string => typeof i === 'string') : []
        }));
      case 'merge_preflight': {
        const r = mergePreflight({
          repo: str(args.repo) ?? '',
          worktree: str(args.worktree) ?? '',
          branch: str(args.branch) ?? '',
          target: str(args.target) ?? '',
          testCommand: str(args.testCommand),
          skipTests: args.skipTests === true,
          testTimeoutSec: typeof args.testTimeoutSec === 'number' ? args.testTimeoutSec : undefined
        });
        // A fail verdict is an answer, not a tool error, so the checks always come back.
        return { ...(r.error ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(r) }] };
      }
      default:
        return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${toolName}` }] };
    }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] };
  }
}
