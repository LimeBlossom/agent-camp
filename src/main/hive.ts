import { DEFAULT_ENGINES, PROMPT_ENGINE_ORDER, getEngines, formatEnginePromptProse, type EngineConfig } from './engineChoice';
/**
 * The Hive — the on-disk multi-agent coordination layer.
 *
 * Lives under `<harnessHome>/hive/` as a single git repo that ONLY this main
 * process commits to (agents never call git — they just write files). See
 * HIVE.md for the full design. Responsibilities:
 *   - per-agent workspace (identity.md, memory.md, inbox/, outbox/, cursor.json)
 *   - hive identity (registry.json: id/role/cwd/session — what agents read),
 *     separate from the UI floor roster (`<harnessHome>/roster.json`)
 *   - shared blackboard (board.md), task ledger, and an append-only event log (log.jsonl)
 *   - a router that drains each agent's outbox into recipients' inboxes
 *
 * Human-in-the-loop is native to each agent's Claude Code session: permission
 * prompts surface in the agent's own terminal (and can be approved remotely via
 * `/remote-control`). The hive keeps no separate approval queue — a message aimed
 * at "human" is routed to the god/orchestrator, the human's proxy on the floor.
 *   - single-committer git with retry/backoff + stale-lock recovery
 *
 * Everything here runs in the Electron main process.
 */
import { capEffort, isEffortLevel, type EffortLevel } from '../shared/effort';
import type { Difficulty } from '../shared/difficulty';
import { VISUAL_CHECK_TIERS, WORK_KINDS, WORK_KIND_GUIDE, type WorkKind } from '../shared/workKind';
import { CARD_NEEDS, cardNeedsOf, type CardNeed } from '../shared/cardNeeds';
import { isCodexSandboxLevel, mergeHookTrust, trustOwnHooks, type ListedCodexHook, normalizeCodexSandbox, setSandboxWorkspaceWrite, setTomlTableKey, setTopLevelTomlKey, type CodexSandboxLevel } from '../shared/codexSandbox';
import { agentGitDirs, taskRepoRoots } from './gitDirs';
import { MEMORY_DIGEST_CAP, dormantWakeReason, humanAnswerBody, startPromptText, tasksOf } from '../shared/dormantWake';
import { openCards, type NudgeCard } from './todoNudge';
import { renderTaskView } from './taskViews';
import { cleanExtraDirs, extraDirsOf } from '../shared/workspace';
import { agentToolsLine, claudeMcpConfig, cleanAgentMcp, codexFeatureEnabled, codexMcpServerNames, codexWebSearchMode, enabledAgentMcp, setCodexMcpServers, type AgentMcp, type AgentMcpId } from '../shared/agentMcp';
import { unityPromptText, unityResultsBase } from './unityBroker';
import { hiveScratchRoot } from './workspacePaths';
import { BUNDLED_MESSAGE_TEMPLATES, loadMessageTemplate, renderMessageTemplate } from './messageTemplates';
import { CLAUDE_HOOK_ADAPTER, codexClaudeHookCommands } from './claudeHookAdapter';
import { isShutdownOrder } from './closingTime';

export const STALE_WRAPUP_MAX_AGE_MS = 2 * 60 * 60_000; // 2 hours
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  readdirSync, statSync, lstatSync, realpathSync, rmSync,
  symlinkSync, unlinkSync, copyFileSync, cpSync, chmodSync, readlinkSync,
  openSync, readSync, fstatSync, closeSync
} from 'node:fs';
import { join, dirname, basename, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync, spawn, execFile, type ChildProcess } from 'node:child_process';
import { resolveCommand } from './shellEnv';
import { inAgentScope } from './agentScope';
import { randomBytes, createHash } from 'node:crypto';
import type { AgentUsageSample } from './usage';
import { AppendQueue, LatestWriter } from './asyncFileWriter';
import { COMMAND_GROUPS } from '../shared/claudeCommands';
import {
  isClaudeProvider,
  isHiveAwareProvider,
  canReceiveInbox,
  providerPreset,
  bridgeOf,
  inferAgentProvider,
  type AgentProvider
} from '../shared/agentProvider';
import { RESTART_AGENT_ACT, validateRestartRequest } from './agentRestart';
import { RESTART_CAMP_ACT, validateCampRestart, type CampRestartRequest, type RestartResult } from './campRestart';
import { ARCHIVE_AGENT_ACT, openCardsFor, validateArchiveRequest } from '../shared/agentArchive';
import {
  AGENT_CONFIG_ACT,
  entryLabel,
  isAgentConfigAct,
  planAgentConfigMessage,
  type AgentBalancerPatch,
  type AgentBalancerState,
  type AgentModelEntry,
  type AgentPlacement
} from '../shared/modelBalance';
import { isTier, type ModelTiers } from '../shared/modelTiers';
import { RosterStore } from './roster';
import { catalogMcpServers, type McpStdioSpec } from '../shared/mcpCatalog';
import { McpProbeCache, type McpProbe } from './mcpProbe';
import { selectBroadcastTargets } from '../shared/broadcast';
import { preferredAgentRole } from '../shared/agentRole';
import { mergeTaskLedger, retireSupersededAsks } from '../shared/taskLedger';
import { DEFAULT_PRIORITY, priorityLevel, type TaskPriority } from '../shared/taskPriority';
import { APPROVAL_ANSWER, AWAITING_MERGE, isTaskAct, planTaskMessage, taskCardHowToBoss, taskPatchHowTo, unparkPlan, type TaskAct, type TaskPlan } from './taskPatch';
import { doneAutoBlockPatch } from './doneAutoBlock';
import { planAutoUnblock } from './autoUnblockDependents';
import { handleHarnessFfMerge, mentionsCardId, type HarnessFfMergeDeps } from './harnessFfMerge';
import { artPipelineProjects, loadMergeRepos } from './hiveProjects';
import { AMBIGUOUS_NOTE, APPROVED_REBASE_TIMEOUT_MS, MAX_REBASE_ROUNDS, attemptApprovedMerge, awaitingMergeNote, bossExceptionNote, classifyApproveAnswer, cleanupMergedWorktree, mergedWorkerBody, notesAwaitingMerge, rebaseRequestBody, rebaseTimeoutReason, type ApproveAction, type CleanupResult, type MergeAttempt } from './approvedMerge';
import { isBacklogged } from '../shared/backlog';
import { fileHandledInbox } from './inboxFiling';
import { answerNeedsBoss, assigneeAnswerBody, bossAnswerNote } from './answerRoute';
import { trimMemoryFile } from './memoryTrim';
import { expandTilde } from './fs';
import { resolveGodName } from '../shared/godIdentity';
import { isBlockedByDeps, type TaskLike } from '../shared/taskDeps';
import { HIVE_COMMIT_MAX_FILE_BYTES, HiveCommitMonitor, excludePathspecs, oversizedPaths, removeTmpObjects, type HiveCommitHealth } from './hiveCommitGuard';
import { newlyDismissedAsks, looseEnds, dismissMailBody, type LooseEnds } from './dismissAsk';
import { RESULT_LABELS, isCardResult, isResultLabel, quoteResult, type CardResult, type ResultLabel } from '../shared/resultsFeed';
import { DEFAULT_APP_TITLE } from '../shared/themePack';
import { brandTitle } from './themePacks';

export const RESULTS_MIGRATION_FILE = 'results-migration.json';

/** The subset of HarnessConfig the hive consumes for the default-MCP merge.
 *  Kept as a local shape so hive.ts never imports the foundation-owned config
 *  module just for a type. */
type McpDefaultsMap = { [id: string]: { enabled: boolean } } | undefined;

// ─── Types ──────────────────────────────────────────────────────────────────

export type MessageAct = 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';

export interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string;                 // an agentId, 'god', or 'broadcast'
  act: MessageAct;
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
  /** Broadcast only: also deliver to dormant agents, which a broadcast skips by default. */
  includeDormant?: boolean;
  /** Closing time generation during which this shutdown order was delivered. */
  closingGeneration?: number;
}

/** One hive message reshaped for the voice read-layer (`hive:messages`): the
 *  operator-briefing view of an inbox/outbox message. `subject` and `body` are
 *  REDACTED main-side (see {@link redactSecrets}) before this ever leaves the
 *  main process — the renderer/voice layer never sees a raw body, and never a
 *  secret. PII-free + secret-free by construction. */
export interface VoiceMessage {
  id: string;
  conversation: string;
  from: string;
  to: string;
  act: MessageAct;
  /** REDACTED subject line. */
  subject: string;
  /** REDACTED message body. */
  body: string;
  requires_reply: boolean;
  /** Which mailbox folder this copy was read from, relative to `owner`. */
  direction: 'inbox' | 'outbox';
  /** The agent whose mailbox this copy lives in. */
  owner: string;
  /** True when read from an archived/handled subfolder (inbox/.done, outbox/.sent). */
  archived: boolean;
  created_at: string;
}

/** One question→answer exchange with the human, recorded ON the task card so
 *  the decision trail stays with the work it unblocked. */
export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
  dismissedAt?: string;
  /** Set when a notice was moved off ASK ME to the card's results. */
  movedToResultsAt?: string;
  /** "camp-propose" when an outside Claude session relayed the answer (askRelay.ts); unset when the human typed it in Camp. */
  via?: string;
  /** Folder of the session that relayed it. */
  relayedFrom?: string;
}

export interface HiveTask {
  id: string;
  title: string;
  nickname?: string;
  description?: string;
  /** Hidden handoff brief shown to the assignee in its start message; holds what
   *  was done, branches/commits, decisions, how to verify, and what is left. */
  brief?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority?: TaskPriority;
  createdAt: string;
  /** First-class human feedback: the god appends {q} when a card can only
   *  proceed with the human's input (status goes blocked); the harness UI
   *  fills in {a}. The full history stays on the card forever. */
  humanQA?: HumanQA[];
  /** No-reply entries for the Results tab (answers, passed checks). */
  results?: CardResult[];
  /** The card whose result this one was filed from (Results tab, Make follow-up card). */
  followUpOf?: string;
  /** The status closing time parked this card from (todo/doing, now blocked) and when;
   *  the next app start puts it back to todo (taskPatch.unparkPlan). */
  parkedFrom?: 'todo' | 'doing';
  parkedAt?: string;
  /** Set while the human has the card shelved in the Backlog (shared/backlog.ts). */
  backloggedAt?: string;
  /** Outcome summary, surfaced by the Slack done-notifier when this card reaches
   *  'done'. Optional; the notifier falls back to description/title. */
  result?: string;
  /** Set to false on a Boss done patch when closing a card as dropped so its branch is not merged. */
  merge?: boolean;
  /** Set when this task originated from a Slack message — the thread the
   *  done-summary reply is posted back into. Consumed OUTBOUND only; populating
   *  it is the inbound/kanban side's job and does not affect routing. */
  slack?: { channel: string; thread_ts: string };
  /** Set when this task originated from a generic webhook POST. Stores the SHA-256
   *  of the capability token (never the raw token — that's returned to the caller
   *  once and never persisted), so a GET status lookup can match by hashing the
   *  presented token. Read-only capability: it never widens routing or exposure. */
  webhook?: { tokenHash: string };
  /** easy | normal | hard (shared/difficulty.ts): picks the model and effort of the
   *  assignee's next fresh session. Absent picks as if the field did not exist. */
  difficulty?: Difficulty;
  /** WORK_KINDS (shared/workKind.ts): which engines the
   *  camp's reservations keep for this card. Absent matches no reservation. */
  kind?: WorkKind;
  /** Override justification when kind is 'code' on a game card naming splat/felt/sprite/strip/export. */
  kindReason?: string;
  /** unity | network (shared/cardNeeds.ts): the assignee holds these while the card is not done. */
  needs?: CardNeed[];
  difficultyHistory?: Array<{ old: string | null; new: string | null; who: string; when: string; reason: string }>;
  sendBacks?: number;
  sendBackHistory?: Array<{ answer: string; when: string }>;
  /** Set by ask_human on_approve: the merge the harness runs when the human approves the
   *  question in `approveAction.q` (approvedMerge.ts). Cleared once spent. */
  approveAction?: ApproveAction;
  /** Harness-owned: a human answer held back because `for` was busy on another card; released when it is free. */
  heldAnswer?: { for: string; since: string };
  /** A worker's "red tests committed" signal (taskPatch.ts testsReady): the branch and head the failing tests sit on. */
  testsReady?: { branch: string; worktree: string; head: string; then: 'implement' | 'handoff'; uncovered?: string; declaredAt: string };
  /** Harness-owned: the tests-to-implementation checkpoint on this card (testsCheckpoint.ts). */
  testsCheckpoint?: { state: 'asked' | 'done'; askedAt: string; resolvedAt?: string };
  /** Short board project name ("Alpha", "Camp"); campTools VALID_PROJECTS. */
  project?: string;
  /** Files saved with the card, e.g. a hotkey snip's PNG, context and logs (snipCard.ts). */
  attachments?: Array<{ kind: string; path: string }>;
}

/** The card's notes as text ending in a newline, or empty. */
const priorNotes = (card: object): string => {
  const n = (card as { notes?: unknown }).notes;
  return typeof n === 'string' && n ? `${n}\n` : '';
};

export interface AgentMeta {
  id: string;
  name: string;
  /** Which CLI this agent runs on. Defaults to 'claude' when unset (legacy). */
  provider?: AgentProvider;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  /** Michael's prep assistant — enriches prompts and forwards them to Michael.
   *  Send-only: excluded from broadcast fan-out so it never drains an inbox. */
  isAssistant?: boolean;
}

export interface RegistryAgent extends AgentMeta {
  status: 'idle' | 'working' | 'blocked' | 'gone';
  lastSeen: number;
  /** True once the agent's terminal/PTY tab is closed. The record is retained
   *  (not deleted) so its history/memory survive; only agents with a live PTY
   *  are 'active'. Broadcast fan-out + roster reads skip archived agents. */
  archived?: boolean;
  /** On the roster and restorable, but not spawned: app launch starts only the
   *  Boss, and the renderer spawns a dormant agent once it has work. Never set
   *  together with `archived`. Direct mail and broadcasts still land in its inbox;
   *  fleet.json lists it marked dormant. */
  dormant?: boolean;
  /** The human has this agent 1:1 and Michael must leave it alone until they
   *  flip it back. Held agents stay ACTIVE and keep their terminal — this is
   *  "do not dispatch to them", not "they are gone", which is why it is its own
   *  flag rather than a reuse of `archived` or a breaker level. */
  onHold?: boolean;
  /** Most recent Claude Code session_id seen for this agent (Lane A #6.6a),
   *  captured from hook payloads. Doubles as the `--resume` key (idempotent
   *  resume after a crash/restart) AND the cost accounting/dedup key on every
   *  AgentUsageSample / cost-ledger row. */
  sessionId?: string;
  /** Whether `cwd` is actually usable for a (re)spawn — i.e. an ABSOLUTE path
   *  that exists as a directory. Computed + persisted at spawn so the roster
   *  reliably exposes each worker's environment validity. A non-absolute fragment
   *  (e.g. "ClaudeTerminalHarness") spawns into a nonexistent dir and fails; this
   *  flag makes that visible instead of letting it slip through silently. */
  cwdValid?: boolean;
  /** Codex agents only: how far the OS sandbox reaches (shared/codexSandbox.ts). Unset, or a
   *  retired 'hive'/'projects' value, reads as 'sandboxed'. */
  codexSandbox?: CodexSandboxLevel | 'hive' | 'projects';
  /** Extra folders the agent's sandbox may write, every provider (shared/workspace.ts). */
  extraDirs?: string[];
  /** Legacy spelling of extraDirs, read only when extraDirs is absent and never written. */
  codexExtraDirs?: string[];
  /** May file Unity batch runs with the harness broker (main/unityBroker.ts). Default off. */
  unity?: boolean;
  /** Codex agents, sandboxed level: network access inside the sandbox. Default off. */
  network?: boolean;
  /** MCP servers attached to this agent's CLI at spawn (shared/agentMcp.ts). Default none. */
  mcp?: AgentMcp;
}

export interface Registry {
  godId: string | null;
  agents: Record<string, RegistryAgent>;
}

/** Build env + extra spawn args that make an agent process hive-aware. */
export interface SpawnInjection {
  args: string[];
  env: Record<string, string>;
  /** The hive-protocol seed to TYPE into the TUI after boot rather than pass on
   *  argv — set only for `seedDelivery:'type-into-tui'` providers (Crush), whose
   *  bare TUI rejects a positional seed. The renderer types it through the same
   *  per-pty write-chain as the inbox-wake nudge. (ondev-b) */
  seedPrompt?: string;
  /** Set when the agent spawned in a DEGRADED posture the user should know about
   *  (today: the proxy-bridge sidecar never bound after retries, so a proxy-tier
   *  agent such as Crush runs without hive events). Human-readable, one line. */
  degraded?: string;
  /** The start prompt to type as the first message, for a CLI that waits to be typed
   *  to (Claude). Initial-prompt CLIs get it on argv instead and leave this unset. */
  kickoff?: string;
  /** The start prompt already rides in the spawn (argv or seedPrompt). */
  startDelivered?: boolean;
}

const HOP_CAP = 12;

/** Filesystem- and sort-safe timestamp, e.g. 2026-05-30T14-03-11-123Z. */
/** A number from an untyped writer (IPC, an old ledger entry) is stored as its level. */
function withPriorityLevel(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object' || typeof (entry as { priority?: unknown }).priority !== 'number') return entry;
  return { ...(entry as object), priority: priorityLevel((entry as { priority: number }).priority) };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function shortRand(): string {
  return randomBytes(3).toString('hex');
}

/** Non-memory files `mempalace mine` must not ingest (Claude Code hooks config,
 *  cursor, raw inbox/outbox JSON). `mempalace mine` honors .gitignore, so we drop
 *  one in each agent dir; written on birth here and refreshed by the mine loop.
 *
 *  `.codex/` is here for a second reason as well, and it is the load-bearing one:
 *  a Codex worker's CODEX_HOME lives INSIDE its agent dir (see installCodexHooks —
 *  Codex can only be given hooks through a config.toml in its own home, so it
 *  cannot share the user's ~/.codex). Codex then fills that folder with full
 *  session transcripts, an 80MB+ logs sqlite and a plugin cache, and the hive's
 *  git repo was faithfully versioning every revision of all of it. Twenty Codex
 *  agents took the hive's .git to 7.5GB, at which point git's own auto-gc tried to
 *  repack it and took 22GB of RAM doing so — the machine swapped, the app stopped
 *  responding. None of it was ever wanted in history: it is Codex's private
 *  scratch state, and it stays on disk (so resume still works) either way. */
/** What the hive commit stages: everything outside agents/, then each agent's own
 *  memory, memory archive and identity. An agent's folder is also its workspace, and art or capture
 *  output there runs to gigabytes, more than `git add` can hash inside its timeout;
 *  every commit then failed and froze the app for ~40s (2026-10-01). Other files in
 *  agent folders stay on disk, unversioned. Two adds, because an exclude pathspec
 *  removes a path even when another pathspec in the same call includes it. */
export const HIVE_COMMIT_PATHSPECS: string[][] = [
  ['.', ':(exclude)agents'],
  ['agents/*/memory.md', 'agents/*/memory-archive.md', 'agents/*/identity.md']
];

/** Hive commit coalescing: quiet time after the last change, and the longest a
 *  change waits during a continuous burst. */
export const HIVE_COMMIT_QUIET_MS = 3000;
export const HIVE_COMMIT_MAX_DELAY_MS = 30_000;
/** Off the main thread a slow add costs nothing but its own time, so it gets far
 *  longer than the 8 s the synchronous calls are held to. */
const HIVE_GIT_ASYNC_TIMEOUT_MS = 60_000;
const HIVE_GIT_MAX_BUFFER = 64 * 1024 * 1024;
const HIVE_COMMIT_SUMMARY_LINES = 30;
// `gc.autoDetach=false`: see git() below.
const HIVE_GIT_CONFIG = ['-c', 'commit.gpgsign=false', '-c', 'gc.autoDetach=false', '-c', 'user.name=Hive', '-c', 'user.email=hive@local'];

/** One commit message for a burst: the change itself when there was one, else a count
 *  and the distinct changes with their multiplicity. */
export function combinedCommitMessage(messages: string[]): string {
  if (messages.length === 1) return messages[0];
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m, (counts.get(m) ?? 0) + 1);
  const lines = [...counts].map(([m, n]) => (n > 1 ? `${m} x${n}` : m));
  const shown = lines.slice(0, HIVE_COMMIT_SUMMARY_LINES);
  if (lines.length > shown.length) shown.push(`... and ${lines.length - shown.length} more`);
  return `hive: ${messages.length} changes\n\n${shown.join('\n')}`;
}

/** `spec` minus the per-agent file globs (agents/<star>/<file>) that no agent has: git add fails outright on a
 *  pathspec that matches nothing, which used to sink every commit on a hive where no
 *  agent had written a memory archive yet. */
export function livePathspecs(root: string, spec: string[]): string[] {
  return spec.filter((p) => {
    const m = /^agents\/\*\/([^/*]+)$/.exec(p);
    if (!m) return true;
    try {
      return readdirSync(join(root, 'agents')).some((id) => existsSync(join(root, 'agents', id, m[1])));
    } catch { return false; }
  });
}

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

const TAIL_CHUNK = 64 * 1024;

/** The end of a file holding at least its last `n` lines (or all of it), read
 *  backwards in chunks instead of loading the whole multi-MB log. */
export function readTailLines(path: string, n: number): string {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return ''; }
  try {
    const size = fstatSync(fd).size;
    const chunks: Buffer[] = [];
    let pos = size;
    let newlines = 0;
    while (pos > 0 && newlines <= n) {
      const len = Math.min(TAIL_CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      chunks.unshift(buf);
      for (let i = 0; i < len; i++) if (buf[i] === 10) newlines++;
    }
    const text = Buffer.concat(chunks).toString('utf8');
    // Drop a partial first line when the read stopped mid-file.
    return pos > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { closeSync(fd); }
}

/** Proxy-bridge sidecar bind attempts per spawn, and the pause before each retry. */
const PROXY_BIND_ATTEMPTS = 3;
/** How long a Boss spawn waits for its camp MCP server to check in before raising it. */
const CAMP_MCP_CHECK_DELAY_MS = 90_000;
const PROXY_BIND_BACKOFF_MS = [250, 750];

const MINE_IGNORE_LINES = ['settings.json', 'cursor.json', 'inbox/', 'outbox/', '.codex/', 'my-tasks.md'];

/** Idempotently ensure `<agentDir>/.gitignore` excludes the non-memory files.
 *  Append-only: writes only the missing lines, leaving any existing entries. */
function ensureMineIgnore(agentDir: string): void {
  const path = join(agentDir, '.gitignore');
  let existing = '';
  try { if (existsSync(path)) existing = readFileSync(path, 'utf8'); } catch { return; }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = MINE_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  try { writeFileSync(path, prefix + missing.join('\n') + '\n', 'utf8'); } catch { /* best-effort */ }
}

/** The handoff note a limit switch left in `agentDir` (main/handoff.ts), or null. It is
 *  renamed to handoff.consumed.md as it is read, so exactly one start prompt carries it
 *  and the last one stays on disk to look at. */
export function takeHandoff(agentDir: string): string | null {
  const path = join(agentDir, 'handoff.md');
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  try { renameSync(path, join(agentDir, 'handoff.consumed.md')); } catch { try { unlinkSync(path); } catch { /* read-only; it is shown again next start */ } }
  return text.trim() ? text : null;
}

/**
 * Strip secret-shaped substrings out of free text before it leaves the main
 * process toward the voice / renderer layer. This is the MAIN-SIDE privacy gate
 * for the voice read-layer's message-content path (`hive:messages`): a message
 * body can quote a key, paste a token, or echo a credential, so every body and
 * subject is run through this before it crosses IPC. The renderer holds ZERO
 * redaction policy — it only ever receives the already-cleaned string.
 *
 * Deliberately CONSERVATIVE: it matches known credential SHAPES (provider key
 * prefixes, JWTs, PEM private keys, bearer tokens) and sensitive key=value /
 * key: value assignments, then replaces the secret with `[redacted]`. It does
 * NOT blanket-redact on entropy, so operator-meaningful content the briefing
 * needs — git SHAs, agent ids, file paths, ordinary prose — survives intact.
 * Over-redaction (e.g. a non-secret `apikey:openai` ref) is acceptable; leaking
 * a real secret is not.
 *
 * LOCKSTEP: the regex battery below is mirrored character-identically in
 * test/voice-messages.test.cjs (a .cjs test cannot import this TS module). If
 * you change a pattern here, mirror it there — the test is what PROVES a
 * secret-shaped value is stripped.
 */
export function redactSecrets(text: unknown): string {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  let s = text;
  // 1. PEM private-key blocks (RSA/EC/OPENSSH/PGP — header through footer).
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted]');
  // 2. JSON Web Tokens — three base64url segments separated by dots.
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[redacted]');
  // 3. Known credential prefixes: OpenAI/Anthropic (sk-, sk-ant-), Slack
  //    (xoxb/xoxp/xoxa/xoxr/xoxs-, xapp-), GitHub (ghp_/gho_/ghu_/ghs_/ghr_,
  //    github_pat_), AWS access-key ids (AKIA…), Google API keys (AIza…).
  s = s.replace(
    /(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[bpaors]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})/g,
    '[redacted]'
  );
  // 4. Bearer tokens — keep the label, drop the credential.
  s = s.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
  // 5. Sensitive key = value / key: value — keep the key name, drop the value.
  //    An optional namespace prefix (aws_, gcp_, …) is folded into the captured
  //    key so a LABELED secret survives the \b boundary: `aws_secret_access_key`
  //    is all word chars, so a bare `\b(secret)\b` never sees it. Listing
  //    secret_access_key / private_key alone is not enough — the prefix run is
  //    what lets `aws_secret_access_key=…` (no AKIA shape on the value) redact.
  s = s.replace(
    /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|secret[_-]?access[_-]?key|secret|token|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|auth[_-]?token|bot[_-]?token|private[_-]?key))(\s*[:=]\s*)(["']?)[^\s"',}]{6,}\3/gi,
    (_m, k) => `${k}=[redacted]`
  );
  return s;
}

// ─── HiveManager ────────────────────────────────────────────────────────────

/**
 * Repair only literal CR/LF characters that occur inside JSON strings.
 *
 * Agents normally publish outbox messages through JSON.stringify, but a manual
 * shell write can put real line-break bytes in a multi-line body. JSON rejects
 * those bytes inside a string even though the intended value is unambiguous.
 * Keep this lexical and deliberately narrow: JSON.parse remains the acceptance
 * gate, and every other malformed shape is left for quarantine.
 */
function repairLiteralLineBreaksInJsonStrings(raw: string): { text: string; changed: boolean } {
  let text = '';
  let inString = false;
  let escaped = false;
  let changed = false;

  for (const ch of raw) {
    if (!inString) {
      text += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      text += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      text += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      text += ch;
      inString = false;
      continue;
    }

    if (ch === '\n') {
      text += '\\n';
      changed = true;
      continue;
    }

    if (ch === '\r') {
      text += '\\r';
      changed = true;
      continue;
    }

    text += ch;
  }

  return { text, changed };
}

export class HiveManager {
  /**
   * @param getHome  Lazily resolve harnessHome so the hive follows config changes.
   * @param emit     Optional sink for renderer-facing events (set by the main
   *                 process to `webContents.send`). Used to animate routed
   *                 messages on the office floor; a no-op in tests/headless.
   */
  constructor(
    private getHome: () => string | null,
    private emit?: (channel: string, payload: unknown) => boolean | void
  ) {}

  private routerTimer: NodeJS.Timeout | null = null;

  /** The home whose per-user agy and grok hook files this hive owns. Unset, those
   *  installers write nothing: one file serves every hive on the machine, so only the
   *  running app may claim it. */
  private userConfigHome: string | null = null;
  setUserConfigHome(home: string | null): void { this.userConfigHome = home; }

  private mcpProbes = new McpProbeCache(() => { const r = this.root(); return r ? join(r, 'mcp-probe.json') : null; });

  /** Replace the default-MCP startup check (tests). */
  setMcpProbe(probe: McpProbe): void { this.mcpProbes.setProbe(probe); }

  /** The embedded OTLP collector's loopback URL, set by the main process once the
   *  collector is bound (telemetry.ts). null = telemetry off → no OTel env is
   *  injected at spawn (the transcript reconciler remains the cost source). */
  private _otelEndpoint: string | null = null;
  /** Point newly-spawned agents at the live telemetry collector. Call after the
   *  collector starts; only affects spawns made afterwards. */
  setOtelEndpoint(url: string | null): void {
    this._otelEndpoint = url;
  }
  /** The collector URL agents are pointed at, or null when telemetry is off. */
  otelEndpoint(): string | null {
    return this._otelEndpoint;
  }

  /** What the app running this hive actually IS: its version, and whether it is a
   *  packaged build or a local dev run.
   *
   *  Agents could not see this before, and it cost real time. A multi-agent
   *  investigation into anomalous file modes ran for hours before the explanation
   *  turned out to be that the operator had quit a downloaded build and started a
   *  local one, which inherits the launching shell's umask instead of Finder's
   *  022. No agent could observe that, several published conclusions had to be
   *  withdrawn, and log.jsonl carried no app-start marker to notice the switch
   *  from either. */
  private _runtime: { version: string; packaged: boolean; appPath?: string } | null = null;
  setRuntimeInfo(info: { version: string; packaged: boolean; appPath?: string } | null): void {
    this._runtime = info;
  }
  runtimeInfo(): { version: string; packaged: boolean; appPath?: string } | null {
    return this._runtime;
  }

  private _engines: EngineConfig['engines'] | (() => EngineConfig['engines']) = undefined;
  setEngines(engines: EngineConfig['engines'] | (() => EngineConfig['engines'])): void {
    this._engines = engines;
  }
  private engines() {
    return getEngines({ engines: typeof this._engines === 'function' ? this._engines() : this._engines });
  }

  /** Whether config.orchestratorMaySpawn is on, mirrored here so the prompt
   *  builder can decide whether to tell god the spawn queue is available. Set at
   *  bootstrap and on every config write; hive.ts deliberately does not import
   *  the config module. */
  private _maySpawn = false;
  setOrchestratorMaySpawn(on: boolean): void {
    this._maySpawn = on;
  }
  orchestratorMaySpawn(): boolean {
    return this._maySpawn;
  }

  /** Outside script path for camp MCP server; unset falls back to bundled script. */
  private _campMcpServerPath: string | null = null;
  setCampMcpServerPath(path: string | null): void {
    this._campMcpServerPath = path;
  }
  campMcpServerPath(): string | null {
    return this._campMcpServerPath;
  }
  /** Resolve the camp MCP server script path. Falls back to bundled when missing or unset. */
  campMcpServerScript(customPath?: string): string {
    const candidate = customPath ?? process.env.CAMP_MCP_SERVER_PATH ?? this._campMcpServerPath;
    try {
      if (candidate && isAbsolute(candidate) && statSync(candidate).isFile()) return candidate;
    } catch { /* missing override uses the bundled server */ }
    return join(__dirname, 'campMcpServer.js');
  }

  /** The camp server's launch entry, without the session identity. */
  private campMcpEntry(root: string, opts: { campMcpServerPath?: string; campConfigPath?: string }): { command: string; args: string[]; env: Record<string, string> } {
    return {
      command: process.execPath,
      args: [this.campMcpServerScript(opts.campMcpServerPath)],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        HIVE_ROOT: root,
        CAMP_MERGE_CLEANUP: this.approvedMergeDeps.cleanup?.() ? '1' : '0',
        ...(opts.campConfigPath ? { CAMP_CONFIG_PATH: opts.campConfigPath } : {})
      }
    };
  }

  /** agy has no per-session MCP flag and reads servers only from the per-user
   *  mcp_config.json, so the Boss's camp server goes there. Every agy session then starts
   *  it; CAMP_BOSS_ID makes it serve only the session whose inherited AGENT_ID matches.
   *  Rewritten on each Boss spawn, since a packaged Camp's execPath moves per launch. */
  private installAgyCampMcp(bossId: string, root: string, opts: { campMcpServerPath?: string; campConfigPath?: string }): void {
    const home = this.userConfigHome;
    if (!home) return;
    const p = join(home, '.gemini', 'config', 'mcp_config.json');
    try {
      let existing: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
      if (existsSync(p)) {
        try { existing = JSON.parse(readFileSync(p, 'utf8')); } catch {
          // agy tolerates comments here; never overwrite a file we cannot parse.
          this.appendLog({ kind: 'camp-mcp-install-skipped', agentId: bossId, reason: 'unparseable mcp_config.json', path: p });
          return;
        }
      }
      const camp = this.campMcpEntry(root, opts);
      existing.mcpServers = { ...(existing.mcpServers ?? {}), camp: { ...camp, env: { ...camp.env, CAMP_BOSS_ID: bossId } } };
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(existing, null, 2), 'utf8');
    } catch (e) {
      this.appendLog({ kind: 'camp-mcp-install-failed', agentId: bossId, error: String(e) });
    }
  }

  private _campMcpCheckDelayMs = CAMP_MCP_CHECK_DELAY_MS;
  private readonly campMcpSpawnedAt = new Map<string, number>();
  private readonly campMcpTimers = new Map<string, ReturnType<typeof setTimeout>>();
  setCampMcpCheckDelayMs(ms: number): void { this._campMcpCheckDelayMs = ms; }
  cancelCampMcpChecks(): void {
    for (const t of this.campMcpTimers.values()) clearTimeout(t);
    this.campMcpTimers.clear();
  }

  /** Whether the Boss's camp server checked in (camp-mcp.json) since its latest spawn. */
  campMcpHealth(agentId: string): { ok: boolean; reason: string } {
    const root = this.root();
    const since = this.campMcpSpawnedAt.get(agentId);
    if (!root || since === undefined) return { ok: false, reason: 'no spawn recorded' };
    let rec: { at?: string } | null = null;
    try { rec = JSON.parse(readFileSync(join(root, 'agents', agentId, 'camp-mcp.json'), 'utf8')); } catch { /* none */ }
    if (!rec) return { ok: false, reason: 'the camp MCP server never checked in' };
    const at = Date.parse(rec.at ?? '');
    if (!(at >= since)) return { ok: false, reason: 'the last camp MCP check-in is from before this spawn (stale)' };
    return { ok: true, reason: 'checked in' };
  }

  private scheduleCampMcpCheck(meta: AgentMeta): void {
    this.campMcpSpawnedAt.set(meta.id, Date.now());
    const prev = this.campMcpTimers.get(meta.id);
    if (prev) clearTimeout(prev);
    const waitedMs = this._campMcpCheckDelayMs;
    const timer = setTimeout(() => {
      this.campMcpTimers.delete(meta.id);
      const health = this.campMcpHealth(meta.id);
      if (health.ok) return;
      const message = `${meta.name} has no camp tools: ${health.reason} within ${Math.round(waitedMs / 1000)}s of its spawn (provider ${meta.provider ?? 'claude'}). Respawn it to retry.`;
      this.appendLog({ kind: 'camp-mcp-missing', agentId: meta.id, provider: meta.provider ?? 'claude', reason: health.reason, waitedMs });
      this.emit?.('hive:degraded', { agentId: meta.id, name: meta.name, reason: 'camp-mcp', message });
      // No renderer listens for hive:degraded, and a Boss without camp still reads its inbox.
      try { this.send({ to: meta.id, act: 'inform', subject: 'camp MCP server missing: your camp tools are not attached', body: message }, 'harness'); } catch { /* the log line stands */ }
    }, waitedMs);
    timer.unref?.();
    this.campMcpTimers.set(meta.id, timer);
  }

  /** Load prompt template from <hive>/prompts/ if present, or null to use bundled template. */
  loadPromptTemplate(meta: AgentMeta): string | null {
    const root = this.root();
    if (!root) return null;
    try {
      return readFileSync(join(root, 'prompts', meta.isGod ? 'boss.md' : 'worker.md'), 'utf8');
    } catch { return null; }
  }

  /** Read a section afresh at spawn; null preserves its bundled text. */
  loadPromptSection(key: string, values: Record<string, string> = {}): string | null {
    const root = this.root();
    if (!root || !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) return null;
    try {
      const template = readFileSync(join(root, 'prompts', 'sections', `${key}.md`), 'utf8');
      return template.replace(/\{\{(name|id|dir|root|tools)\}\}/g, (match, name: string) => values[name] ?? match);
    } catch { return null; }
  }

  /** Read a message template from <hive>/prompts/messages/<key>.md afresh per send; null preserves bundled text. */
  loadMessageTemplate(key: string, values: Record<string, string | number | undefined | null> = {}): string | null {
    return loadMessageTemplate(this.root(), key, values);
  }


  // — paths —
  root(): string | null {
    const home = this.getHome();
    return home ? join(home, 'hive') : null;
  }
  enabled(): boolean {
    return this.root() !== null;
  }
  private agentDir(id: string): string {
    return join(this.root()!, 'agents', id);
  }
  /** IPC endpoint the cth-hook shim talks to (Phase 1 autonomy).
   *  On POSIX this is a Unix-domain socket file under the hive root. On Windows,
   *  Node's `net` IPC uses named pipes (a flat `\\.\pipe\` namespace, not the
   *  filesystem), so a raw file path fails to bind with EACCES — derive a stable,
   *  per-root pipe name instead. Both the server (`listen`) and the shim
   *  (`createConnection`) read this same value, so they stay in sync. */
  sockPath(): string | null {
    const root = this.root();
    if (!root) return null;
    if (process.platform === 'win32') {
      const id = createHash('sha1').update(root).digest('hex').slice(0, 12);
      return `\\\\.\\pipe\\munder-difflin-${id}`;
    }
    return join(root, 'hooks.sock');
  }
  private shimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'cth-hook.cjs') : null;
  }
  /** The proxy-bridge sidecar (qwen). Pure-Node loopback reverse-proxy that
   *  observes a hookless CLI's LLM traffic and synthesizes the same HIVE_SOCK
   *  payloads the hook shims emit. Written in ensureHive alongside cth-hook.cjs. */
  private proxyShimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'hive-proxy.cjs') : null;
  }

  /**
   * The BUNDLED-NODE launcher: `<root>/bin/hive-node` (POSIX) / `hive-node.cmd`
   * (Windows). Every `.cjs` shim in the hive is executed through it.
   *
   * Why it exists: hooks are run by the agent CLI through a plain
   * `/bin/sh -c` with a bare `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. A user whose
   * node comes from nvm (PATH set only by an interactive login shell) has NO node
   * there, so a hook written as `node "<shim>"` exits **127 — command not found**
   * and every payload is silently lost: no live status, no Stop→inbox drain, no
   * session ids. Electron's own binary IS a full Node runtime under
   * `ELECTRON_RUN_AS_NODE=1`, and it is guaranteed present (it is us).
   *
   * A wrapper SCRIPT rather than an inline `ELECTRON_RUN_AS_NODE=1 "<exe>" …`
   * prefix because that prefix is POSIX-sh syntax — it is a hard error under
   * cmd.exe, which is what runs hook commands on Windows. The wrapper also gives
   * agents a `$HIVE_NODE` they can invoke directly (running the Electron binary
   * WITHOUT the env var would launch a second app window, not a script).
   *
   * Rewritten on every bootstrap, so an app update/move re-bakes execPath.
   */
  private nodeLauncherPath(): string | null {
    const root = this.root();
    if (!root) return null;
    return join(root, 'bin', process.platform === 'win32' ? 'hive-node.cmd' : 'hive-node');
  }

  /** Write the launcher described above. Best-effort: on failure callers fall
   *  back to bare `node`, i.e. exactly the pre-fix behavior. */
  private writeNodeLauncher(): void {
    const p = this.nodeLauncherPath();
    if (!p) return;
    try {
      if (process.platform === 'win32') {
        writeFileSync(p, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`, 'utf8');
      } else {
        // The AppImage mount vanishes when the app quits, but agy's hooks live in the user's
        // global ~/.gemini config and keep calling this; exiting 0 then keeps the user's own
        // agy usable instead of failing every tool call on a 127.
        writeFileSync(p, `#!/bin/sh\nEXE="${process.execPath}"\n[ -x "$EXE" ] || exit 0\nELECTRON_RUN_AS_NODE=1 exec "$EXE" "$@"\n`, 'utf8');
        chmodSync(p, 0o755);
      }
    } catch (e) {
      console.error('[hive] writeNodeLauncher failed:', e);
    }
  }

  /** The launcher path if it is actually on disk, else null (→ callers fall back
   *  to bare `node`, i.e. exactly the pre-fix behavior — never worse than before). */
  private nodeLauncher(): string | null {
    const p = this.nodeLauncherPath();
    return p && existsSync(p) ? p : null;
  }

  /** The ABSOLUTE bundled-node command to BAKE into any text an agent is expected
   *  to run (`<launcher> <script> …`), falling back to bare `node`.
   *
   *  Exactly the value of the agent's `HIVE_NODE` env var — but agent-facing text
   *  must never spell it as `$HIVE_NODE`: that is POSIX shell syntax. A Windows
   *  agent runs its commands through cmd.exe/PowerShell, where `$HIVE_NODE`
   *  expands to NOTHING (cmd) or to an undefined variable (PowerShell), so every
   *  such instruction is dead on arrival there. The absolute path is correct on
   *  every platform and needs no expansion at all. */
  nodeCommand(): string {
    return this.nodeLauncher() ?? 'node';
  }

  /**
   * `<root>/bin/runtime` — the same bundled-node trick as `hive-node`, but the
   * wrapper is NAMED `node`, so anything that resolves `node` off PATH finds one.
   *
   * `hive-node` only covers commands WE generate. It does nothing for node that
   * the agent's own work needs at runtime: an MCP server declared as
   * `node ./server.js`, a provider CLI that shells out to node, a `.cjs` helper an
   * agent wrote itself. On a machine with no system node those all die with 127
   * exactly like the hooks did.
   *
   * This dir is APPENDED to the agent's PATH (see pty.spawn), never prepended: a
   * user who has their own node keeps their own version — we are strictly the
   * fallback. Prepending would silently swap every agent's node for Electron's
   * (20.18.1 as of Electron 32.3.3) underneath the user's own projects.
   *
   * NOTE: `node` only — deliberately no `npm`/`npx`. Electron bundles the Node
   * RUNTIME, not the npm CLI (which is ~12MB of JS we do not ship), so an `npm`
   * wrapper here could only be a stub that fails confusingly. A missing `npm` is
   * the honest signal; the install ladder (main/cliInstall.ts) detects it and
   * installs a REAL system Node — which brings npm with it. This shim is only the
   * last resort for when that install could not run (offline, or a platform with
   * no official installer).
   */
  runtimeBinDir(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'runtime') : null;
  }

  /** Write the `node` shim described above. Best-effort: on failure the dir is
   *  simply absent from PATH and behavior is exactly as before. */
  private writeRuntimeShims(): void {
    const dir = this.runtimeBinDir();
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      if (process.platform === 'win32') {
        writeFileSync(
          join(dir, 'node.cmd'),
          `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`,
          'utf8'
        );
      } else {
        const p = join(dir, 'node');
        writeFileSync(p, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`, 'utf8');
        chmodSync(p, 0o755);
        const blender = join(dir, 'hive-blender');
        writeFileSync(blender, HIVE_BLENDER_SH, 'utf8');
        chmodSync(blender, 0o755);
      }
    } catch (e) {
      console.error('[hive] writeRuntimeShims failed:', e);
    }
  }

  /** Build a hook command string that runs `script` under the guaranteed node,
   *  DOUBLE-QUOTED (safe for paths with spaces). */
  private nodeRun(script: string, ...args: string[]): string {
    const launcher = this.nodeLauncher();
    return [launcher ? `"${launcher}"` : 'node', `"${script}"`, ...args].join(' ');
  }

  /** Same, but UNQUOTED — only for configs or platforms that cannot preserve
   *  embedded quotes. POSIX JSON hook configs must use nodeRun() because the
   *  user-selected hive path may legitimately contain spaces. */
  private nodeRunUnquoted(script: string, ...args: string[]): string {
    return [this.nodeLauncher() ?? 'node', script, ...args].join(' ');
  }

  /** One proxy sidecar per live proxy-tier agent, keyed by agentId. Spawned in
   *  ensureAgent, killed on PTY exit / removeAgent / app quit (index.ts) — so a
   *  dead agent never leaks an orphan loopback listener. */
  private proxyChildren = new Map<string, ChildProcess>();

  // — bootstrap —

  /** Create the hive skeleton + git repo if missing. Idempotent. */
  ensureHive(): void {
    const root = this.root();
    if (!root) return;
    mkdirSync(join(root, 'agents'), { recursive: true });

    const hashPath = join(root, '.bundled-protocol-hashes.json');
    let previous: Record<string, string> = {};
    try { previous = JSON.parse(readFileSync(hashPath, 'utf8')); } catch { /* first upgrade */ }
    const hashes: Record<string, string> = {};
    for (const [name, bundled] of Object.entries({
      'PROTOCOL.md': PROTOCOL_MD, 'PROTOCOL-BOSS.md': protocolBossMarkdown(this.engines()), 'COMMANDS.md': COMMANDS_MD
    })) {
      const path = join(root, name);
      const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
      hashes[name] = hash(bundled);
      // Before hash tracking, every bootstrap replaced these with the bundle.
      if (!existsSync(path) || !previous?.[name] || hash(readFileSync(path, 'utf8')) === previous[name]) {
        writeFileSync(path, bundled, 'utf8');
      } else {
        this.appendLog({ kind: 'protocol-file-kept', file: name });
      }
    }
    writeFileSync(hashPath, JSON.stringify(hashes, null, 2), 'utf8');

    const registry = join(root, 'registry.json');
    if (!existsSync(registry)) {
      this.writeJson(registry, { godId: null, agents: {} } as Registry);
    }
    const userCodexHome = join(homedir(), '.codex');
    for (const [id, agent] of Object.entries(this.registry().agents)) {
      const codexHome = join(root, 'agents', id, '.codex');
      if (agent.provider === 'codex' && existsSync(codexHome)) {
        this.exposeCodexDataDirs(codexHome, userCodexHome, id);
      }
    }
    const board = join(root, 'board.md');
    if (!existsSync(board)) {
      writeFileSync(board, '# Hive board\n\n_Shared plans live here. The Boss is the scribe._\n', 'utf8');
    }
    const tasks = join(root, 'tasks.json');
    if (!existsSync(tasks)) this.writeJson(tasks, { tasks: [] });
    const log = join(root, 'log.jsonl');
    if (!existsSync(log)) writeFileSync(log, '', 'utf8');

    // Keep the churny/ephemeral live files out of the hive git repo.
    const gitignore = join(root, '.gitignore');
    // `crashes/` holds raw PTY output from abnormal agent exits. It is
    // DELIBERATELY ignored: that output is whatever the provider printed, which
    // can include tokens, paths and prompt fragments, and the hive repo is
    // committed on every change — a secret written there would be permanent.
    // log.jsonl gets the structured, non-sensitive fields; the dump stays local.
    const want = ['fleet.json', 'fleet.json.tmp', 'hooks.sock', 'cost-ledger.jsonl', 'crashes/', '.camp-activity/', '.DS_Store'];
    let lines: string[] = [];
    if (existsSync(gitignore)) { try { lines = readFileSync(gitignore, 'utf8').split('\n'); } catch { lines = []; } }
    const missing = want.filter((w) => !lines.includes(w));
    if (missing.length) writeFileSync(gitignore, [...lines.filter(Boolean), ...missing].join('\n') + '\n', 'utf8');

    // The hook shim: a dumb pipe between a `claude` hook and our UDS. Refreshed
    // on every bootstrap so it tracks code changes.
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(this.shimPath()!, HOOK_SHIM, 'utf8');
    // The proxy-bridge sidecar for hookless CLIs (qwen). Same refresh policy.
    writeFileSync(this.proxyShimPath()!, PROXY_BRIDGE_SHIM, 'utf8');
    // Runs the user's Claude hooks for Codex workers (installCodexHooks registers it).
    writeFileSync(join(root, 'bin', 'claude-hook-adapter.cjs'), CLAUDE_HOOK_ADAPTER, 'utf8');
    // The bundled-node launcher every shim above is invoked through — MUST be
    // written before any hook installer runs (they probe for it).
    this.writeNodeLauncher();
    // …and the PATH-visible `node` fallback for the agent's OWN subprocesses.
    this.writeRuntimeShims();

    if (!existsSync(join(root, '.git'))) {
      this.git(['init', '-q'], root);
      this.commit('hive: init');
    }
  }

  /** Validate an agent's cwd the way a spawn does — it must be an ABSOLUTE path
   *  that exists as a directory. Surfaced as `cwdValid` on the registry entry so
   *  the roster reliably exposes whether a worker's working directory is usable.
   *  Best-effort; never throws (a stat error degrades to invalid). */
  private cwdValidity(cwd: string | undefined): { valid: boolean; issue: string | null } {
    if (!cwd || typeof cwd !== 'string') return { valid: false, issue: 'missing' };
    // Defense-in-depth: a `~/…` cwd from an older registry entry (written before
    // ingestion-time expansion) would read as 'not-absolute' forever. Expand first
    // so the roster reports the truth about the directory the spawn would use.
    cwd = expandTilde(cwd);
    if (!isAbsolute(cwd)) return { valid: false, issue: 'not-absolute' };
    try {
      return statSync(cwd).isDirectory()
        ? { valid: true, issue: null }
        : { valid: false, issue: 'not-a-directory' };
    } catch {
      return { valid: false, issue: 'missing-dir' };
    }
  }

  /**
   * Ensure an agent's workspace + registry entry, returning the spawn injection
   * (provider-specific args + env) that makes the process hive-aware.
   */
  async ensureAgent(
    meta: AgentMeta,
    opts: {
      semanticMemory?: boolean;
      knowledgeGraph?: boolean;
      /** ABSOLUTE path to the Knowledge-Graph CLI (`knowledge.env().KG_CLI`), baked
       *  into the agent's prompt instead of a `$KG_CLI` shell reference — `$VAR` is
       *  POSIX-only and expands to nothing under cmd.exe/PowerShell, so the KG
       *  instructions were unusable on Windows. Optional: undefined degrades to the
       *  old env-var spelling. */
      kgCliPath?: string;
      theme?: 'light' | 'dark';
      /** Provider-specific reasoning effort; undefined leaves the CLI default. */
      effort?: EffortLevel;
      /** Consent state for the default-MCP bundle (W3). Threaded from the live
       *  HarnessConfig by the caller; undefined gives a Claude agent no catalog servers. */
      mcpDefaults?: { [id: string]: { enabled: boolean } };
      /** App-resources `skills/` source dir (W3). The bundled read-only skills are
       *  copied into the agent's `.claude/skills/` per spawn; undefined or missing
       *  is a no-op (tolerated until Kevin populates the resource dir). */
      skillsDir?: string;
      /** Extra directories the agent's sandbox may write (e.g. the shared
       *  MemPalace dir, which `mempalace` mutates). Absolute paths; ignored
       *  for providers without a sandbox. */
      extraWritableDirs?: string[];
      /** False drops the Claude sandbox block; the Edit/Write dirs stay. */
      sandbox?: boolean;
      /** True sets `disableBundledSkills` for a Claude worker (never the Boss, whose
       *  Chrome work leans on the bundled claude-in-chrome skill). User, project and
       *  plugin skills are unaffected. */
      disableBundledSkills?: boolean;
      /** Custom outside path for the camp MCP server script; unset falls back to bundled script. */
      campMcpServerPath?: string;
      /** Path to Camp's config.json so the MCP process can read live timings without Electron. */
      campConfigPath?: string;
    } = {}
  ): Promise<SpawnInjection> {
    const root = this.root();
    if (!root) return { args: [], env: {} };
    this.ensureHive();

    const dir = this.agentDir(meta.id);
    mkdirSync(join(dir, 'inbox', '.done'), { recursive: true });
    mkdirSync(join(dir, 'outbox', '.sent'), { recursive: true });
    if (this.capabilitiesOf(meta.id).unity) mkdirSync(join(dir, 'unity-requests'), { recursive: true });

    // Resolve role BEFORE writing identity.md. A restart passes the floor
    // roster's `description`, which can be a status caption ("on standby").
    // identity.md and registry.role are the durable job from the hire.
    const reg = this.registry();
    const prev = reg.agents[meta.id];
    if (meta.cwd) meta = { ...meta, cwd: expandTilde(meta.cwd) };
    const role = preferredAgentRole(meta.role, prev?.role, !!meta.isGod);
    meta = { ...meta, role };

    const identity = join(dir, 'identity.md');
    writeFileSync(identity, this.identityText(meta), 'utf8'); // refresh on each spawn

    // W3 — bundled read-only skills: refresh the agent's .claude/skills/ from the
    // app-resources skills/ dir on every spawn (same policy as identity.md), so an
    // agent always rides with the shipped safe skill set. Tolerant: a missing or
    // partial source dir is a no-op (Kevin populates the resource dir in lp-manifest).
    const skillsDest = join(dir, '.claude', 'skills');
    if (opts.skillsDir && (meta.isGod || opts.disableBundledSkills !== true)) {
      this.copyBundledSkills(opts.skillsDir, skillsDest);
    } else if (opts.disableBundledSkills === true && !meta.isGod) {
      try { rmSync(skillsDest, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    const memory = join(dir, 'memory.md');
    if (!existsSync(memory)) {
      writeFileSync(memory, `# Memory — ${meta.name} (${meta.isGod ? 'boss' : meta.id})\n\n_Append durable facts, decisions, and context below._\n`, 'utf8');
    }
    ensureMineIgnore(dir); // keep settings.json / cursor / messages / Codex homes out of the hive's git
    const cursor = join(dir, 'cursor.json');
    if (!existsSync(cursor)) this.writeJson(cursor, { lastProcessed: null });

    // upsert registry — spread the PRIOR entry first so a respawn preserves
    // fields the spawn `meta` doesn't carry, above all `sessionId`. Without this,
    // ensureAgent (which runs before the resume lookup in the pty:spawn handler)
    // would wipe the recorded session id, so `lastSession()` returns undefined and
    // `--resume` is never attached — i.e. every restart starts a fresh thread.
    // Validate the working directory at the source so a bad value is visible on
    // the roster (cwdValid) rather than silently spawning into a nonexistent dir.
    // Store the EXPANDED cwd, never the raw `~/…` the user typed — the registry is
    // read by hooks, the roster and the worker watcher, none of which run a shell.
    const cwd = this.cwdValidity(meta.cwd);
    reg.agents[meta.id] = {
      ...prev,
      ...meta,
      // A session belongs to the CLI that recorded it; after a provider switch it
      // would hand Restart & Continue an id the new CLI cannot resume.
      ...(prev?.provider && meta.provider && prev.provider !== meta.provider ? { sessionId: undefined } : {}),
      capabilities: meta.capabilities ?? prev?.capabilities ?? [],
      role,
      status: 'idle',
      cwdValid: cwd.valid,
      // A (re)spawn always means a live terminal — clear any prior archived flag.
      archived: false,
      dormant: false,
      lastSeen: Date.now()
    };
    if (meta.isGod) reg.godId = meta.id;
    this.atomicWriteJson(join(root, 'registry.json'), reg);

    this.appendLog({ kind: 'spawn', agentId: meta.id, name: meta.name, isGod: !!meta.isGod });
    if (meta.isGod) this.scheduleCampMcpCheck(meta);
    // Only logs on an invalid cwd (rare) — not a per-spawn line, so no log spam.
    if (!cwd.valid) {
      this.appendLog({ kind: 'cwd_invalid', agentId: meta.id, cwd: meta.cwd, issue: cwd.issue });
    }
    this.commit(`hive: register ${meta.id}`);
    this.refreshTaskViews(true);
    // Read before the spawn: a fresh session's first turn gets exactly this work.
    const start = this.startPrompt(meta, dir, root);

    const env: Record<string, string> = {
      AGENT_ID: meta.id,
      AGENT_NAME: meta.name,
      HIVE_ROOT: root,
      AGENT_DIR: dir,
      // Games that honour this flag send no telemetry, so a game an
      // agent launches from its shell never lands in the player data.
      LBS_NO_TELEMETRY: '1'
    };
    // The bundled-node launcher, so an agent can run the hive's .cjs helpers (KG
    // CLI, Slack reply helper) even when `node` is not on its PATH. Invoking the
    // Electron binary directly would open a second app window, so this must stay
    // the wrapper path and never process.execPath.
    //
    // Kept as an env var for agent CONVENIENCE and for anything that reads it
    // programmatically — but agent-facing TEXT no longer references it by name:
    // `$HIVE_NODE` is POSIX-only syntax and expands to nothing under cmd.exe /
    // PowerShell, so every such instruction was dead on a Windows floor. Commands
    // we write for an agent to run bake `nodeCommand()`'s absolute path instead.
    env.HIVE_NODE = this.nodeCommand();
    // Generic light/dark hint for TUIs that paint their own background. The app
    // defaults to light but every agent CLI assumed a dark terminal, so Crush and
    // OpenCode looked pasted into a light window. COLORFGBG is the classic
    // "fg;bg" convention (rxvt/konsole) that lipgloss/termenv fall back to when
    // an OSC 11 query gets no answer. Claude Code gets the same hint through its
    // per-session settings.json (hookSettings); Crush and OpenCode through their
    // per-agent config dirs below. A running TUI does not re-read this: new
    // agents pick up the current theme, running ones keep the one they started with.
    if (opts.theme) env.COLORFGBG = opts.theme === 'dark' ? '15;0' : '0;15';

    const claudeProvider = isClaudeProvider(meta.provider ?? 'claude');

    // Non-hive-aware providers (Antigravity's `agy`, OpenAI's `codex`, xAI's
    // `grok`) don't
    // understand Claude Code's flags (no `--append-system-prompt`, no telemetry,
    // no `--settings`). Instead: (1) the hive identity+protocol rides in as the
    // session's INITIAL prompt — the closest thing to `--append-system-prompt`
    // these CLIs offer (after the first turn the session continues normally); and
    // (2) lifecycle hooks are wired via the preset's `hookBridge` below. Together
    // that makes a Gemini/Codex worker a full hive citizen — live status +
    // Stop→inbox-drain — without Claude installed at all.
    //
    // How the prompt rides in differs by CLI:
    //  - agy takes it under a flag (`agy -i "<prompt>"`) → push [flag, prompt].
    //  - codex/grok take it POSITIONALLY (`codex|grok "<prompt>"`) → push the
    //    bare prompt as a trailing arg (node-pty passes argv literally, so it
    //    arrives as one positional argument after codex's own flags).
    if (!isHiveAwareProvider(meta.provider)) {
      const preset = providerPreset(meta.provider ?? 'claude');
      const flag = preset.initialPromptFlag;
      // agy, codex, and grok expose a Claude-style lifecycle-hook surface, so each
      // gets the SAME live status + Stop→inbox-drain Claude does — selected by the
      // preset's `hookBridge`. agy needs a translating shim (its hook stdin/stdout
      // shape differs from Claude's); codex reuses the Claude `cth-hook` shim
      // verbatim (its hook payload + response contract are already Claude-shaped)
      // and is isolated to a per-agent CODEX_HOME so the user's global Codex
      // configuration is never mutated. Both share the HIVE_SOCK wiring below.
      const preArgs: string[] = [];
      let degraded: string | undefined;
      // Dispatch on the structured bridge descriptor (the foundation's `bridgeOf`
      // derives {kind:'hooks'} from the legacy `hookBridge` for agy/codex, and
      // returns the explicit {kind:'proxy'} for qwen). Two ways a hookless CLI
      // becomes a hive citizen:
      //   - 'hooks' → install a config-file hook shim (agy translator / codex verbatim).
      //   - 'proxy' → spawn a loopback reverse-proxy sidecar that observes the CLI's
      //               LLM traffic and SYNTHESIZES the same HIVE_SOCK payloads.
      const desc = bridgeOf(meta.provider);
      const sock = this.sockPath();
      if (desc && sock) {
        env.HIVE_SOCK = sock;
        try {
          if (desc.kind === 'hooks') {
            if (desc.shim === 'agy') this.installAgyHooks();
            else if (desc.shim === 'codex') {
              const extraDirs = extraDirsOf(prev).map(expandTilde);
              const projectDirs = [meta.cwd, ...extraDirs].filter(Boolean).map(expandTilde);
              // workspace-write keeps every .git read-only, even under a writable root, so a
              // worker could not commit; the repos it works in get their git dir as a root.
              const gitDirs = agentGitDirs(meta.cwd ? expandTilde(meta.cwd) : undefined, extraDirs,
                this.taskRepos(meta.id, projectDirs), homedir());
              const writable = this.sandboxWritableDirs(meta, dir, root,
                [...(opts.extraWritableDirs ?? []), ...projectDirs, ...gitDirs]);
              const effort = capEffort('codex', opts.effort);
              env.CODEX_HOME = this.installCodexHooks(dir, meta.id, writable, this.capabilitiesOf(meta.id).network, enabledAgentMcp(prev?.mcp), effort);
              if (effort) preArgs.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
              await this.trustOwnCodexHooks(env.CODEX_HOME);
              // Codex refuses to run hooks from a config dir without persisted
              // "hook trust" (normally an interactive gate). Our hooks.json is
              // hive-authored inside an isolated CODEX_HOME, so we bypass that gate
              // for this automated spawn — the flag's documented use ("automation
              // that already vets hook sources"). Without it the hooks silently
              // never fire. Must precede the positional prompt.
              preArgs.push('--dangerously-bypass-hook-trust');
              // Auto mode keeps codex's OS sandbox (`-a never -s workspace-write`,
              // agentProvider.ts). workspace-write only covers cwd, so the agent
              // folder (inbox/.done, memory.md, outbox) and the shared hive root
              // (research deliverables, the board for god) are added as extra
              // writable roots. Harmless outside auto mode.
              for (const d of writable) preArgs.push('--add-dir', d);
              // workspace-write also makes the session cwd writable, so it must be the
              // agent's folder, never $HOME. --no-daemon keeps the TUI off any shared
              // app-server in this CODEX_HOME, where one TUI's model change reached all.
              if (meta.cwd) preArgs.push('-C', expandTilde(meta.cwd));
              preArgs.push('--no-daemon');
            }
            else if (desc.shim === 'pi') {
              // Pi (earendil-works) has a rich pi.on(event) lifecycle. We drop a
              // bundled extension into a PER-AGENT PI_CODING_AGENT_DIR (so the user's
              // global ~/.pi is never touched) that posts cth-hook-shaped payloads to
              // HIVE_SOCK on tool_call/agent_end and auto-approves tools when the floor
              // is in auto mode. HIVE_AUTO_APPROVE (set in spawnAgentCore from
              // config.autoMode) gates the auto-allow — Pam guardrail #5.
              // LIVE-UNVERIFIED: the exact extension API surface needs BYOK keys to
              // prove; the renderer idle inbox-wake nudge is the guaranteed drain.
              env.PI_CODING_AGENT_DIR = this.installPiHooks(dir);
            }
            else if (desc.shim === 'opencode') {
              // OpenCode (anomalyco/opencode) has no Claude-shaped Stop hook, but its
              // plugin API exposes a real session.idle event (god Decision 1). We drop
              // a bundled plugin into a PER-AGENT OPENCODE config dir that posts
              // HIVE_SOCK payloads on tool.execute.before/after + session.idle — the
              // same Stop→drain semantics, provider-agnostic, no traffic interception.
              // LIVE-UNVERIFIED (plugin auto-load + session.idle firing); the renderer
              // idle inbox-wake nudge is the guaranteed drain fallback.
              env.OPENCODE_CONFIG_DIR = this.installOpenCodePlugin(dir, opts.theme);
            }
            else if (desc.shim === 'gemini') {
              // Point only this worker at a per-agent system settings file so
              // the bridge is trusted and ~/.gemini/settings.json stays untouched.
              env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = this.installGeminiHooks(dir);
            }
            else if (desc.shim === 'grok') this.installGrokHooks();
          } else if (desc.kind === 'proxy') {
            // Stable per-spawn session id, stamped on every synthesized payload so
            // recordSession (registry resume key) and the cost ledger persist.
            const spawnTs = String(Date.now());
            const sessionId = `proxy-${meta.id}-${createHash('sha1').update(root + meta.id + spawnTs).digest('hex').slice(0, 12)}`;
            env.HIVE_PROXY_SESSION = sessionId;
            // The CLI normally reads its upstream base URL from `baseUrlEnv`; capture
            // the user's configured value as the sidecar's UPSTREAM, then point the
            // CLI at the loopback proxy instead. Fall back to the cloud default if
            // the user hasn't set one.
            const upstream = process.env[desc.baseUrlEnv]
              || (desc.api === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
            // A loopback bind on port 0 fails only transiently (a busy moment, a
            // slow sidecar start past the 4s ceiling), so try a few times before
            // giving up: without this ONE bad moment at spawn cost the agent its
            // hive events for the whole session.
            const port = await this.startProxyBridgeWithRetry(meta.id, { sock, sessionId, api: desc.api, upstream });
            // Only redirect the CLI through the proxy if the sidecar actually bound a
            // port. On failure leave routing untouched → the CLI talks to its real
            // upstream directly (degraded: no synthesized hive events, but it still
            // runs). Deliberate degradation is fine; SILENT degradation is not, so
            // the failure goes to log.jsonl, the renderer and the spawn result.
            if (port > 0) {
              const loopback = `http://127.0.0.1:${port}`;
              if (meta.provider === 'crush') {
                // Crush has NO base-URL env override, so the generic env-rewrite is a
                // no-op for it. Route it instead via a per-agent CRUSH_GLOBAL_CONFIG
                // whose chosen provider's base_url points at the loopback proxy
                // (installCrushConfig — sibling of installCodexHooks). `upstream`
                // (captured above from the inert sentinel env or cloud default) is the
                // proxy's real target. Per-agent CRUSH_GLOBAL_DATA isolates session
                // state from the user's global ~/.config/crush.
                const crush = this.installCrushConfig(dir, loopback, desc.api, opts.theme);
                env.CRUSH_GLOBAL_CONFIG = dir;
                env.CRUSH_GLOBAL_DATA = crush.data;
              } else {
                env[desc.baseUrlEnv] = loopback;
              }
            }
            else {
              degraded = `${meta.name} is running without hive events: its proxy bridge did not bind after ${PROXY_BIND_ATTEMPTS} attempts. Live status, cost and inbox wake will not work for this session. Respawn the agent to try again.`;
              console.error(`[hive] proxy bridge for ${meta.id} did not bind — spawning without hive events`);
              this.appendLog({ kind: 'proxy-degraded', agentId: meta.id, name: meta.name, provider: meta.provider, attempts: PROXY_BIND_ATTEMPTS });
              this.emit?.('hive:degraded', { agentId: meta.id, name: meta.name, reason: 'proxy-bind', message: degraded });
            }
          }
        } catch (e) { console.error(`[hive] install ${desc.kind} bridge failed:`, e); }
      }
      // These CLIs run a turn on the initial prompt, so it carries the work too. Built after
      // the bridge install because the tools line reads the CODEX_HOME config it wrote.
      if (meta.isGod && meta.provider === 'antigravity') this.installAgyCampMcp(meta.id, root, opts);
      const tools = await this.toolsLineFor(meta, env.CODEX_HOME);
      const prompt = `${this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.knowledgeGraph ?? false, opts.kgCliPath, tools)}\n\n${start.text}`;
      // Inject the protocol text whichever way the CLI accepts it.
      // type-into-tui (Crush): the bare TUI reads a positional as a Cobra subcommand
      // → `Unknown command`. So DROP the positional and hand the protocol back as
      // seedPrompt; the renderer types it into the TUI after boot (ondev-b).
      const deg = degraded ? { degraded } : {};
      if (preset.seedDelivery === 'type-into-tui') return { args: [...preArgs], env, seedPrompt: prompt, startDelivered: true, ...deg };
      // If a provider somehow exposes neither a flag nor a positional prompt, spawn bare.
      if (flag) return { args: [...preArgs, flag, prompt], env, startDelivered: true, ...deg };
      if (preset.positionalInitialPrompt) return { args: [...preArgs, prompt], env, startDelivered: true, ...deg };
      return { args: preArgs, env, ...deg };
    }

    // Stage 7A — first-party Claude Code telemetry → the embedded loopback OTLP
    // collector (telemetry.ts). Pure env, no --settings change. Only injected
    // for Claude Code once the collector is up (otelEndpoint set), so telemetry-
    // off installs and non-Claude providers spawn exactly as before.
    if (claudeProvider && this._otelEndpoint) {
      env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
      env.OTEL_METRICS_EXPORTER = 'otlp';
      env.OTEL_LOGS_EXPORTER = 'otlp';
      env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
      env.OTEL_EXPORTER_OTLP_ENDPOINT = this._otelEndpoint;
      env.OTEL_METRIC_EXPORT_INTERVAL = '5000'; // 5s — near-live without spamming
      env.OTEL_LOGS_EXPORT_INTERVAL = '2000';
      env.OTEL_RESOURCE_ATTRIBUTES = `agent.id=${meta.id},agent.name=${meta.name}`;
    }
    const args: string[] = [];
    if (!claudeProvider) return { args, env };

    // Claude Code ignores `mcpServers` in a --settings file (probed on 2.1.287: a server
    // listed there never launched, the same one under --mcp-config did), so the per-agent
    // switches and the default catalog servers ride in their own file. The `=` form keeps
    // the variadic flag from taking the next argument as a second config.
    const mcpPath = join(dir, 'mcp.json');
    const catalog = await this.startableCatalogMcp(meta, opts.mcpDefaults);
    // The Boss gets the camp tools (ask_human, create_card, dispatch); they write into its outbox.
    if (meta.isGod) {
      const camp = this.campMcpEntry(root, opts);
      catalog.camp = { ...camp, env: { ...camp.env, AGENT_ID: meta.id } };
    }
    const mcpCfg = claudeMcpConfig(enabledAgentMcp(prev?.mcp), catalog);
    if (mcpCfg) {
      this.writeJson(mcpPath, mcpCfg);
      args.push(`--mcp-config=${mcpPath}`);
    } else {
      try { unlinkSync(mcpPath); } catch { /* none was written */ }
    }
    // The Boss reloads its whole context every turn, and the user's own MCP servers
    // and claude.ai connectors (~4k tokens) are tools it never calls. Strict mode
    // keeps only the file above, and drops Chrome too unless `--chrome` is passed;
    // the Boss does drive Chrome.
    if (meta.isGod) {
      args.push('--strict-mcp-config', '--chrome');
    } else {
      // Headless workers: strict MCP config drops user global MCPs (blender,
      // claude-in-chrome, claude.ai connectors) while keeping explicitly configured
      // agent MCPs; disallow Artifact and unused interactive tools.
      if (!args.includes('--strict-mcp-config')) args.push('--strict-mcp-config');
      if (!args.includes('--disallowed-tools') && !args.includes('--disallowedTools')) {
        args.push('--disallowed-tools', 'Artifact,SendFeedback,AskUserQuestion,ScheduleWakeup,ReportFindings');
      }
    }
    args.push('--append-system-prompt', this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.knowledgeGraph ?? false, opts.kgCliPath, await this.toolsLineFor(meta, undefined, Object.keys(catalog))));
    // Claude sits idle until typed to. Mail alone needs no kickoff (the inbox nudge
    // delivers it); cards, a Boss wake, the archive step and the Boss's boot do.
    const kickoff = start.typeIt ? start.text : undefined;

    // Phase 1 — autonomy: attach lifecycle hooks via --settings (no edits to the
    // user's repo) so the agent reports activity and drains its inbox on Stop.
    const sock = this.sockPath();
    const shim = this.shimPath();
    if (sock && shim) {
      env.HIVE_SOCK = sock;
      const settingsPath = join(dir, 'settings.json');
      const writable = this.sandboxWritableDirs(meta, dir, root, [...(opts.extraWritableDirs ?? []), ...extraDirsOf(prev).map(expandTilde)]);
      this.writeJson(settingsPath, this.hookSettings(shim, opts.theme, writable, opts.effort, opts.sandbox !== false, opts.disableBundledSkills === true && !meta.isGod));
      args.push('--settings', settingsPath);
    }
    return { args, env, ...(kickoff ? { kickoff } : {}) };
  }

  /** Update the durable job string (hire role) without respawning. Refreshes
   *  registry.json + identity.md so the floor editor and the hive stay aligned. */
  patchAgentRole(id: string, role: string): { ok: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled' };
    const next = role.trim();
    if (!next) return { ok: false, error: 'empty role' };
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: 'unknown agent' };
      if (agent.role === next) return { ok: true };
      agent.role = next;
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      writeFileSync(join(this.agentDir(id), 'identity.md'), this.identityText(agent), 'utf8');
      this.appendLog({ kind: 'role', agentId: id, role: next });
      this.commit(`hive: role ${id}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Flip an agent's archived flag and persist the registry. Closing a terminal
   * tab archives the agent (retained + flagged, NOT deleted); a (re)spawn clears
   * it. No-op if the agent isn't registered or the flag is already set the way
   * asked. Best-effort — never throws, so a dying PTY/kill handler can't crash.
   */
  setArchived(id: string, archived: boolean): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent || (agent.archived === archived && !(archived && agent.dormant))) return;
      agent.archived = archived;
      if (archived) agent.dormant = false;
      agent.lastSeen = Date.now();
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'archive', agentId: id, archived });
      this.commit(`hive: ${archived ? 'archive' : 'unarchive'} ${id}`);
    } catch { /* best-effort — never crash a lifecycle handler */ }
  }

  /**
   * Set PTY-less agents dormant or archived in ONE registry write and commit (a
   * hive commit is synchronous git on the main thread). Unknown ids and ones
   * already in the asked state are skipped. Best-effort, never throws.
   */
  setDormancy(changes: { dormant: string[]; archived: string[] }): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registry();
      const changed: string[] = [];
      for (const id of changes.dormant) {
        this.expireAgentShutdownOrders(id);
        const agent = reg.agents[id];
        if (!agent || (agent.dormant && !agent.archived)) continue;
        agent.dormant = true;
        agent.archived = false;
        changed.push(id);
        this.appendLog({ kind: 'dormant', agentId: id });
      }
      for (const id of changes.archived) {
        const agent = reg.agents[id];
        if (!agent || (agent.archived && !agent.dormant)) continue;
        agent.archived = true;
        agent.dormant = false;
        agent.lastSeen = Date.now();
        changed.push(id);
        this.appendLog({ kind: 'archive', agentId: id, archived: true });
      }
      if (!changed.length) return;
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.commit(`hive: dormancy ${changed.join(', ')}`);
      for (const id of changes.dormant) if (changed.includes(id)) this.releaseHeldAnswer(id);
    } catch { /* best-effort */ }
  }

  /**
   * Change an agent's display name without changing its durable identity.
   * The registry key, agent directory, session id, and every mailbox path remain
   * keyed by `id`; only the human-facing name is updated.
   *
   * `fleet.json` is patched in the same operation so god's next prompt receives
   * the new name immediately rather than waiting for the periodic fleet refresh.
   */
  /**
   * Put an agent on hold, or take it off, and tell Michael immediately.
   *
   * `fleet.json` is patched in the same operation for the same reason
   * `renameAgent` does it: god's roster is injected from that file on its next
   * prompt, and waiting up to 8s for the periodic refresh means one more
   * dispatch can still land on someone the human has just claimed.
   */
  setAgentHold(id: string, hold: boolean): { ok: boolean; onHold?: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: 'Agent not found' };
      if (!!agent.onHold === hold) return { ok: true, onHold: hold };

      agent.onHold = hold;
      this.writeJson(join(root, 'registry.json'), reg);

      const fleetPath = join(root, 'fleet.json');
      if (this.snapshots.latest(fleetPath) !== undefined || existsSync(fleetPath)) {
        try {
          const fleet = this.readFleet<{ agents?: Array<{ id?: string; onHold?: boolean }> }>(root);
          if (Array.isArray(fleet.agents)) {
            const row = fleet.agents.find((candidate) => candidate.id === id);
            if (row) { row.onHold = hold; this.writeFleetSnapshot(fleet); }
          }
        } catch { /* fleet is a cache — the registry above is the record */ }
      }
      this.appendLog({ kind: 'agent-hold', id, onHold: hold });
      return { ok: true, onHold: hold };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The agent's Codex sandbox level and its extra folders, from the registry entry.
   *  `stored` is false when no level was ever set (the level is then the default). */
  codexSandboxOf(id: string): { level: CodexSandboxLevel; extraDirs: string[]; stored: boolean } {
    const agent = this.root() ? this.registry().agents[id] : undefined;
    return { level: normalizeCodexSandbox(agent?.codexSandbox), extraDirs: extraDirsOf(agent), stored: agent?.codexSandbox !== undefined };
  }

  /** Stores the Codex sandbox level on the registry entry. Applies on the next spawn or resume. */
  setCodexSandbox(id: string, level: unknown): { ok: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };
    if (!isCodexSandboxLevel(level)) return { ok: false, error: 'Unknown sandbox level' };
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: 'Agent not found' };
      agent.codexSandbox = level;
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The agent's main folder, extra folders and Unity flag, from the registry entry. */
  workspaceOf(id: string): { cwd: string; extraDirs: string[]; unity: boolean; network: boolean; mcp: AgentMcp } | null {
    const agent = this.root() ? this.registry().agents[id] : undefined;
    if (!agent) return null;
    return { cwd: agent.cwd, extraDirs: extraDirsOf(agent), unity: agent.unity === true, network: agent.network === true, mcp: cleanAgentMcp(agent.mcp) };
  }

  /** What the agent may use this session: its registry override flag, or the needs of any
   *  of its cards that is not done. `from` says which granted each. */
  capabilitiesOf(id: string): Record<CardNeed, boolean> & { from: Record<CardNeed, string[]> } {
    const agent = this.root() ? this.registry().agents[id] : undefined;
    const ledger = this.root() ? this.readLedger() ?? [] : [];
    const cards = cardNeedsOf(ledger, id).cards;
    const out = { from: {} } as Record<CardNeed, boolean> & { from: Record<CardNeed, string[]> };
    for (const n of CARD_NEEDS) {
      const from = [...(agent?.[n] === true ? ['agent override'] : []), ...cards[n].map((c) => `card ${c}`)];
      out[n] = from.length > 0;
      out.from[n] = from;
    }
    return out;
  }

  /** The broker's view of an agent: its workspace with Unity as granted by capabilitiesOf. */
  brokerAgent(id: string): { cwd: string; extraDirs: string[]; unity: boolean } | null {
    const ws = this.workspaceOf(id);
    return ws ? { cwd: ws.cwd, extraDirs: ws.extraDirs, unity: this.capabilitiesOf(id).unity } : null;
  }

  /** Stores a workspace edit on the registry entry: a new main folder (when `cwd` is given;
   *  it must exist), the extra folders and the Unity flag. Applies on the next spawn. The
   *  renderer roster holds the cwd a spawn actually uses, so the caller updates it too. */
  setWorkspace(id: string, patch: { cwd?: unknown; extraDirs?: unknown; unity?: unknown; network?: unknown; mcp?: unknown }): { ok: boolean; cwd?: string; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };
    let cwd: string | undefined;
    if (patch.cwd !== undefined) {
      if (typeof patch.cwd !== 'string' || !patch.cwd.trim()) return { ok: false, error: 'Folder is required' };
      cwd = expandTilde(patch.cwd.trim());
      const v = this.cwdValidity(cwd);
      if (!v.valid) return { ok: false, error: `Folder ${v.issue === 'not-absolute' ? 'must be an absolute path' : 'does not exist'}: ${cwd}` };
    }
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: 'Agent not found' };
      if (cwd !== undefined) { agent.cwd = cwd; agent.cwdValid = true; }
      if (patch.extraDirs !== undefined) {
        agent.extraDirs = cleanExtraDirs(patch.extraDirs).map(expandTilde);
        delete agent.codexExtraDirs;
      }
      if (typeof patch.unity === 'boolean') {
        agent.unity = patch.unity;
        if (patch.unity) mkdirSync(join(this.agentDir(id), 'unity-requests'), { recursive: true });
      }
      if (typeof patch.network === 'boolean') agent.network = patch.network;
      if (patch.mcp !== undefined) agent.mcp = { ...cleanAgentMcp(agent.mcp), ...cleanAgentMcp(patch.mcp) };
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'workspace', agentId: id, cwd: agent.cwd, extraDirs: agent.extraDirs ?? [], unity: agent.unity === true, network: agent.network === true, mcp: enabledAgentMcp(agent.mcp) });
      this.commit(`hive: workspace ${id}`);
      return { ok: true, cwd: agent.cwd };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  renameAgent(id: string, name: string): { ok: boolean; name?: string; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };

    const nextName = name.trim();
    if (!nextName) return { ok: false, error: 'Name is required' };

    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: 'Agent not found' };
      if (agent.name === nextName) return { ok: true, name: nextName };

      const previousName = agent.name;
      agent.name = nextName;
      this.writeJson(join(root, 'registry.json'), reg);

      // fleet.json is ephemeral and may not exist yet. When it does, keep its
      // display name in lockstep with the registry so rosterContext() is fresh.
      const fleetPath = join(root, 'fleet.json');
      if (this.snapshots.latest(fleetPath) !== undefined || existsSync(fleetPath)) {
        try {
          const fleet = this.readFleet<{ agents?: Array<{ id?: string; name?: string }> }>(root);
          if (Array.isArray(fleet.agents)) {
            const row = fleet.agents.find((candidate) => candidate.id === id);
            if (row) {
              row.name = nextName;
              this.writeFleetSnapshot(fleet);
            }
          }
        } catch { /* periodic snapshot will repair a malformed/stale fleet file */ }
      }

      this.appendLog({ kind: 'rename', agentId: id, previousName, name: nextName });
      this.commit(`hive: rename ${id}`);
      return { ok: true, name: nextName };
    } catch {
      return { ok: false, error: 'Could not rename agent' };
    }
  }

  /**
   * Persist the agent's Claude Code session_id (Lane A #6.6a). Captured from hook
   * payloads; written only when it actually changes (a new session), so this is a
   * no-op on the vast majority of hook events. The id is the `--resume` key for
   * idempotent resume after a crash/restart AND the accounting/dedup key for cost
   * samples. Best-effort — never throws into a hook handler.
   */
  recordSession(agentId: string, sessionId: string): void {
    const root = this.root();
    if (!root || !sessionId) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[agentId];
      if (!agent || agent.sessionId === sessionId) return; // unknown agent or unchanged → no write
      agent.sessionId = sessionId;
      agent.lastSeen = Date.now();
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'session', agentId, sessionId });
      this.commit(`hive: session ${agentId}`);
    } catch { /* best-effort — never crash a hook handler */ }
  }

  /** The last known session_id for an agent, or undefined. Used to build a
   *  `claude --resume <id>` spawn so a restarted agent resumes its thread. */
  lastSession(agentId: string): string | undefined {
    return this.registry().agents[agentId]?.sessionId;
  }

  /** Claude Code settings that route every relevant hook through the shim, plus
   *  (W3) the default MCP bundle merged into this PER-SESSION settings file. cwd
   *  scopes the filesystem/git servers; cfg (the consent map) gates which servers
   *  are written. Claude-only — this is invoked solely on the Claude spawn path. */
  /**
   * Directories a sandboxed agent may write BESIDES its cwd: its own agent
   * folder (hive housekeeping) and the hive root (research deliverables; the
   * board and tasks.json for god; outbox delivery is done by main, not the agent).
   * This is what lets auto mode keep the OS sandbox on — the old full-bypass
   * posture existed only because these paths sit outside the project cwd.
   */
  private sandboxWritableDirs(meta: AgentMeta, dir: string, root: string, extra?: string[]): string[] {
    const out = [dir, root, ...(extra ?? [])].filter((d) => typeof d === 'string' && d.length > 0);
    return Array.from(new Set(out));
  }

  private hookSettings(shim: string, theme?: 'light' | 'dark', writableDirs: string[] = [], effort?: EffortLevel, sandbox = true, disableBundledSkills = false): unknown {
    // Bundled node, NOT bare `node` — see nodeLauncherPath(). Claude runs each of
    // these through `sh -c` with a stripped PATH, where `node` is often absent.
    const cmd = this.nodeRun(shim);
    const entry = (matcher?: string) => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: cmd }]
    });
    return {
      // Match the TUI's truecolor palette to the harness terminal theme —
      // PER SESSION, so the user's global Claude theme (their own terminals
      // outside the app) is never touched.
      //
      // 'auto', not the literal light/dark. Pinning the value matched the theme at
      // SPAWN and then ignored every change: Claude Code supports DEC 2031 theme
      // notifications, but a pinned theme has nothing to reconsider, so flipping
      // the app left a running agent painting its message blocks in the old
      // palette (black highlight on a cream terminal). 'auto' is the value that
      // listens. The terminal reports the current theme the moment the CLI enables
      // 2031, so startup still matches without pinning anything.
      ...(theme ? { theme: 'auto' } : {}),
      // Per-agent effort, set from the agent's options. Per session like the
      // theme, so the user's global effortLevel stays the default for the rest.
      ...(effort ? { effortLevel: effort } : {}),
      ...(disableBundledSkills ? { disableBundledSkills: true } : {}),
      // The status line gets the session status JSON after every response —
      // including context_window.{total_input_tokens,context_window_size},
      // the only clean programmatic source for the session's REAL context
      // window. The shim prints a compact in-terminal gauge and forwards the
      // payload to the harness (agent-card context gauge, exact limit).
      statusLine: { type: 'command', command: `${cmd} --status`, padding: 0 },
      // Native OS sandbox for Bash subprocesses (macOS Seatbelt / Linux bubblewrap).
      // Auto mode spawns with `--permission-mode bypassPermissions`, which only
      // silences PROMPTS; the sandbox is a separate, opt-in layer that was never
      // switched on. Verified live (claude 2.1.239): with this block, bypass mode
      // still writes cwd and the listed dirs but `touch $HOME/x` fails with
      // "Operation not permitted". Two layers are needed: `sandbox.filesystem`
      // governs Bash children, `permissions.additionalDirectories` governs the
      // Edit/Write tools; with only one the agent deadlocks on its own inbox.
      // failIfUnavailable stays false: a platform without a sandbox (Windows)
      // runs as before rather than refusing to spawn.
      ...(writableDirs.length
        ? {
            ...(sandbox ? { sandbox: { enabled: true, filesystem: { allowWrite: writableDirs } } } : {}),
            permissions: { additionalDirectories: writableDirs }
          }
        : {}),
      hooks: {
        Stop: [entry()],
        SubagentStop: [entry()],
        PreToolUse: [entry('*')],
        PostToolUse: [entry('*')],
        UserPromptSubmit: [entry()],
        Notification: [entry()],
        SessionStart: [entry()],
        // #5C: surface mid-`/compact` so an agent boxing up its context reads as
        // 'compacting' on the floor instead of looking frozen.
        PreCompact: [entry()],
        PostCompact: [entry()]
      }
    };
  }

  /** The enabled catalog servers that answer a stdio handshake, for this agent's cwd.
   *  One that is unconfigured or cannot start is left out and logged (`mcp-drop`), so a
   *  broken server never holds the agent's startup. */
  private async startableCatalogMcp(meta: AgentMeta, consent: McpDefaultsMap): Promise<Record<string, McpStdioSpec>> {
    const { servers, dropped } = catalogMcpServers(meta.cwd, consent, process.env);
    const checked = await Promise.all(Object.entries(servers).map(async ([name, spec]) => [name, spec, await this.mcpProbes.check(spec)] as const));
    const out: Record<string, McpStdioSpec> = {};
    for (const [name, spec, r] of checked) {
      if (r.ok) out[name] = spec;
      else dropped.push({ id: name.replace(/^munder-/, ''), reason: r.reason ?? 'did not start' });
    }
    for (const d of dropped) {
      console.warn(`[hive] MCP ${d.id} left out for ${meta.id}: ${d.reason}`);
      this.appendLog({ kind: 'mcp-drop', agentId: meta.id, server: d.id, reason: d.reason });
    }
    return out;
  }

  /**
   * W3 — refresh an agent's bundled skills from the app-resources `skills/` dir.
   * Mirrors `identity.md`: overwritten every spawn so the shipped safe set tracks
   * the app. Best-effort and fully tolerant — a missing/empty source dir is a no-op
   * (Kevin populates the resource dir in lp-manifest), and any IO error is swallowed
   * so skill provisioning can never block a spawn.
   */
  private copyBundledSkills(srcDir: string, destDir: string): void {
    try {
      if (!existsSync(srcDir)) return;
      const copyTree = (from: string, to: string): void => {
        const entries = readdirSync(from, { withFileTypes: true });
        if (!entries.length) return;
        mkdirSync(to, { recursive: true });
        for (const ent of entries) {
          const s = join(from, ent.name);
          const d = join(to, ent.name);
          if (ent.isDirectory()) copyTree(s, d);
          else if (ent.isFile()) copyFileSync(s, d);
        }
      };
      copyTree(srcDir, destDir);
    } catch (e) { console.error('[hive] copyBundledSkills failed:', e); }
  }

  /**
   * W1 — start a proxy-bridge sidecar for a hookless proxy-tier agent (qwen).
   * Spawns `<root>/bin/hive-proxy.cjs` under Node, which binds a loopback port and
   * reports it back as a one-line `{"port":N}` on stdout. Resolves the bound port
   * (or 0 on failure, so the caller degrades gracefully without redirecting the
   * CLI). Idempotent: any prior sidecar for the agent is killed first, so a respawn
   * never leaks a listener. Tracked in `proxyChildren` for teardown.
   */
  /** startProxyBridge with a short retry ladder. Every attempt kills the previous
   *  sidecar first (startProxyBridge is idempotent), so a retry never leaks a
   *  listener. Resolves the bound port, or 0 once every attempt has failed. */
  private async startProxyBridgeWithRetry(
    agentId: string,
    cfg: { sock: string; sessionId: string; api: 'openai' | 'anthropic'; upstream: string }
  ): Promise<number> {
    for (let attempt = 1; attempt <= PROXY_BIND_ATTEMPTS; attempt++) {
      const port = await this.startProxyBridge(agentId, cfg);
      if (port > 0) return port;
      if (attempt < PROXY_BIND_ATTEMPTS) {
        console.warn(`[hive] proxy bridge for ${agentId} did not bind (attempt ${attempt}/${PROXY_BIND_ATTEMPTS}), retrying`);
        await new Promise((r) => setTimeout(r, PROXY_BIND_BACKOFF_MS[attempt - 1] ?? 1000));
      }
    }
    return 0;
  }

  private startProxyBridge(
    agentId: string,
    cfg: { sock: string; sessionId: string; api: 'openai' | 'anthropic'; upstream: string }
  ): Promise<number> {
    this.stopProxyBridge(agentId);
    const script = this.proxyShimPath();
    if (!script) return Promise.resolve(0);
    return new Promise<number>((resolve) => {
      let settled = false;
      const settle = (port: number): void => { if (!settled) { settled = true; resolve(port); } };
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [script], {
          env: {
            ...process.env,
            // Run the .cjs under Electron's bundled Node, not as a second app window.
            ELECTRON_RUN_AS_NODE: '1',
            HIVE_SOCK: cfg.sock,
            AGENT_ID: agentId,
            UPSTREAM_BASE_URL: cfg.upstream,
            HIVE_PROXY_SESSION: cfg.sessionId,
            HIVE_PROXY_API: cfg.api
          },
          // Read the port line from stdout; never inherit stdio (the sidecar must
          // never write into the agent's terminal or leak request bodies to a log).
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } catch (e) {
        console.error(`[hive] startProxyBridge spawn failed for ${agentId}:`, e);
        return settle(0);
      }
      this.proxyChildren.set(agentId, child);
      let buf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        if (settled) return;
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        try {
          const msg = JSON.parse(buf.slice(0, nl));
          if (typeof msg.port === 'number' && msg.port > 0) settle(msg.port);
          else settle(0);
        } catch { settle(0); }
      });
      child.on('error', () => settle(0));
      child.on('exit', () => {
        if (this.proxyChildren.get(agentId) === child) this.proxyChildren.delete(agentId);
        settle(0); // never hang the spawn if the sidecar dies before reporting
      });
      // Hard ceiling: if the sidecar never reports a port, degrade rather than hang.
      setTimeout(() => settle(0), 4000).unref?.();
    });
  }

  /** Kill the proxy sidecar for an agent, if any. Idempotent; never throws. */
  stopProxyBridge(agentId: string): void {
    const child = this.proxyChildren.get(agentId);
    if (!child) return;
    this.proxyChildren.delete(agentId);
    try { child.kill(); } catch { /* already gone */ }
  }

  /** Kill every live proxy sidecar (app quit). Best-effort. */
  stopAllProxyBridges(): void {
    for (const id of [...this.proxyChildren.keys()]) this.stopProxyBridge(id);
  }

  /**
   * Drain an agent's inbox for the Stop hook. Returns whether to block-to-continue
   * and the message text to feed back. Uses the per-agent cursor so a message is
   * surfaced exactly once (no infinite loop).
   */
  drainForStop(agentId: string): { block: boolean; reason?: string } {
    const dir = this.agentDir(agentId);
    if (!existsSync(dir)) return { block: false };
    const cursorPath = join(dir, 'cursor.json');
    const cursor = this.readJson<{ lastProcessed: string | null }>(cursorPath, { lastProcessed: null });
    const fresh = this.inbox(agentId)
      .filter((m) => !cursor.lastProcessed || m.id > cursor.lastProcessed)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (fresh.length === 0) return { block: false };

    cursor.lastProcessed = fresh[fresh.length - 1].id;
    this.atomicWriteJson(cursorPath, cursor);
    this.appendLog({ kind: 'drain', agentId, count: fresh.length });

    const lines = fresh.map((m) => `- [from ${m.from}, ${m.act}] ${m.subject}: ${m.body}`).join('\n');
    // Native separators (join, not string-concatenated `/`) so a Windows agent is
    // handed a path its own shell/tools accept, not `C:\…\agents\god/inbox/`.
    const reason = renderMessageTemplate(this.root(), 'drainForStop', {
      count: fresh.length,
      lines,
      inboxDir: join(dir, 'inbox'),
      doneDir: join(dir, 'inbox', '.done')
    }, BUNDLED_MESSAGE_TEMPLATES.drainForStop);
    return { block: true, reason };
  }

  // — agent-facing text —

  private identityText(meta: AgentMeta): string {
    const caps = (meta.capabilities ?? []).join(', ') || '—';
    return [
      `# ${meta.name} (${meta.isGod ? 'boss' : meta.id})`,
      '',
      `- Role: ${meta.role ?? (meta.isGod ? 'orchestrator (boss)' : 'agent')}`,
      `- Capabilities: ${caps}`,
      `- Working directory: ${meta.cwd}`,
      meta.isGod ? '- You are the **Boss / orchestrator**. You run the floor — keep awareness of the whole team, delegate execution, and personally own only the important calls (decomposition, sign-offs, conflicts, integration), not the grunt work.' : '',
      meta.isGod ? '- Monitor the team with the `floor` camp tool; full command reference in `COMMANDS.md`. `claude agents` does NOT list your hive siblings.' : '',
      meta.isGod ? '- Workers marked `dormant` in `fleet.json` are asleep until they have work (an assigned todo/doing task or direct mail starts them); `wake-requests/<agentId>.json` wakes one by id. Dormant is not stalled.' : '',
      ''
    ].filter(Boolean).join('\n');
  }

  /** The identity prompt's "tools you have" lines, read from what this spawn configured:
   *  the CLI's MCP servers (the agent's CODEX_HOME config for Codex, the user and per-agent
   *  configs for Claude, agy's global config), Codex's native tools, the Unity broker and
   *  the skills the CLI can see. Best-effort: anything unreadable is left out. */
  private async toolsLineFor(meta: AgentMeta, codexHome?: string, claudeCatalog: string[] = []): Promise<string> {
    const provider = meta.provider ?? 'claude';
    const entry = this.registry().agents[meta.id];
    const readText = (p: string): string => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
    const skillNames = (base: string): string[] => {
      try { return readdirSync(base).filter((n) => !n.startsWith('.') && existsSync(join(base, n, 'SKILL.md'))); } catch { return []; }
    };
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    let mcpServers: string[] = [];
    let skills: string[] = [];
    let imageGeneration = false;
    let webSearch: string | null = null;
    if (provider === 'codex' && codexHome) {
      const cfg = readText(join(codexHome, 'config.toml'));
      mcpServers = codexMcpServerNames(cfg);
      webSearch = codexWebSearchMode(cfg);
      imageGeneration = codexFeatureEnabled(await codexFeatureListing(), 'image_generation');
      skills = skillNames(join(codexHome, 'skills'));
    } else if (isClaudeProvider(provider)) {
      // The user's ~/.claude.json carries user-scope servers at the top and local-scope
      // ones per project path; both reach an agent run in that cwd.
      let user: { mcpServers?: object; projects?: Record<string, { mcpServers?: object }> } = {};
      try { user = JSON.parse(readText(process.env.CLAUDE_CONFIG_DIR ? join(claudeDir, '.claude.json') : join(homedir(), '.claude.json')) || '{}'); } catch { /* unreadable */ }
      mcpServers = [...new Set([
        ...Object.keys(user.mcpServers ?? {}),
        ...Object.keys((meta.cwd && user.projects?.[expandTilde(meta.cwd)]?.mcpServers) || {}),
        ...enabledAgentMcp(entry?.mcp),
        ...claudeCatalog
      ])];
      skills = skillNames(join(claudeDir, 'skills'));
    } else if (provider === 'antigravity') {
      try { mcpServers = Object.keys(JSON.parse(readText(join(homedir(), '.gemini', 'config', 'mcp_config.json')) || '{}').mcpServers ?? {}); } catch { /* unreadable */ }
      // The per-user file holds the Boss's camp entry, which serves no other session.
      if (!meta.isGod) mcpServers = mcpServers.filter((n) => n !== 'camp');
    }
    return agentToolsLine({ provider, imageGeneration, webSearch, mcpServers, unity: this.capabilitiesOf(meta.id).unity, skills });
  }

  /**
   * The system-prompt prefix injected into every spawn via --append-system-prompt.
   *
   * 🔒 PROMPT-CACHE INVARIANT — keep this prefix VOLATILE-FREE. It interpolates
   * only values stable for an agent's whole lifetime (name, id, dir, root,
   * semanticMemory). Do NOT add dates, UUIDs, counters, board/registry state, or
   * any `Date.now()`-derived text here: a prefix that changes per spawn defeats
   * Anthropic's prompt cache (re-priming the whole system prompt every turn).
   * Volatile context belongs on the live channels — the inbox (hive messages) and
   * the PTY — never baked into this prefix. (Lane A #6.1.)
   *
   * 🪟 NO SHELL SYNTAX. Every path and command here is written the way the AGENT
   * will actually type it, on the platform it is running on. That rules out two
   * habits that were silently Windows-only breakage:
   *  - `$VAR` — POSIX-only. Under cmd.exe `$HIVE_NODE`/`$KG_CLI` expand to nothing
   *    and under PowerShell to an undefined variable, so those instructions were
   *    dead on every Windows floor. Bake the ABSOLUTE resolved path instead: it is
   *    platform-independent, needs no expansion, and stays prompt-cache-stable.
   *  - `'…' + '/inbox/'` — string-concatenating separators told a Windows agent to
   *    read `C:\Users\x\hive\agents\god/inbox/`. Use join() so the agent's own
   *    tooling gets a path it can pass straight to its shell.
   */
  private injectedPrompt(
    meta: AgentMeta,
    dir: string,
    root: string,
    semanticMemory: boolean,
    knowledgeGraph: boolean,
    kgCliPath?: string,
    toolsLine = ''
  ): string {
    const customTemplate = this.loadPromptTemplate(meta);
    if (customTemplate !== null) {
      const values: Record<string, string> = { name: meta.name, id: meta.id, dir, root, tools: toolsLine };
      return customTemplate.replace(/\{\{(name|id|dir|root|tools)\}\}/g, (_, key: string) => values[key]);
    }

    // Native-separator path helpers — see the 🪟 note above.
    const inDir = (...parts: string[]): string => join(dir, ...parts);
    const inRoot = (...parts: string[]): string => join(root, ...parts);
    // Resolved ONCE here, at THIS agent's own spawn — same prompt-cache-stable
    // shape as name/id/dir/root above it, not a live re-read on every turn.
    // Needed only for the PREP ASSISTANT persona below, which refers to god by
    // name in prose; god's own prompt already gets its name via `meta.name`.
    const godRegistry = meta.isAssistant ? this.registry() : null;
    const godNameForPrompt = godRegistry
      ? resolveGodName(godRegistry.agents[godRegistry.godId ?? 'god']?.name)
      : '';
    const ctxLine = 'LIVE CONTEXT: each agent row in the LIVE ROSTER carries a `ctx NN%` tag — its live context-window occupancy. Treat it as the real headroom signal when routing: prefer an agent with a LOW `ctx` for a big task; treat a HIGH `ctx` (near 100%) as busy rather than idle, even if the cumulative token count looks modest.';

    const memoryLine = semanticMemory
      // The palace location is named, not spelled as `$MEMPALACE_PALACE_PATH`:
      // `mempalace` reads that env var itself, and the POSIX `$` form was noise
      // (or an empty expansion) for a Windows agent that tried to use it literally.
      ? 'Semantic memory: the whole hive shares a searchable MemPalace at the path in your MEMPALACE_PALACE_PATH environment variable. To recall relevant past knowledge across the team, run `mempalace search "<query>"` when a task needs past context (`mempalace wake-up` prints a broad digest; only run it when you are lost). memory.md, memory-archive.md and your other top-level, research/ and reviews/ .md notes are mined into the palace automatically, so write durable facts there.'
      : '';
    // Enterprise Knowledge Graph (opt-in). Volatile-free: the bundled-node launcher
    // and the KG CLI are both fixed absolute paths for an install, so baking them
    // keeps the prefix prompt-cache-stable while making the command runnable in
    // cmd.exe/PowerShell as well as a POSIX shell.
    const hiveNode = this.nodeCommand();
    const kgCli = kgCliPath || (process.platform === 'win32' ? '%KG_CLI%' : '$KG_CLI');
    const knowledgeLine = knowledgeGraph
      ? `Enterprise knowledge: this organisation has a private Knowledge Graph of its own documents, policies, and business context. When a task needs that context — company-specific facts, house style, internal processes — query it instead of guessing: run \`"${hiveNode}" "${kgCli}" search "<query>"\` for ranked passages, \`"${hiveNode}" "${kgCli}" list\` to see what is available, and \`"${hiveNode}" "${kgCli}" get <id>\` for a full document. (That first path is the harness's bundled Node — use it instead of bare \`node\`, which may not be on your PATH.)`
      : '';
    // Opt-in by presence of the folder. memory.md is private to one agent and one
    // machine, so knowledge written only there never reaches the shared vault.
    const vaultLine = existsSync(inRoot('vault-inbox'))
      ? 'VAULT INBOX: File shared knowledge when you learn it; read the Vault inbox section in PROTOCOL.md for the rules.'
      : '';
    // Item 13: state the build. Agents had no way to tell which version, or even
    // which KIND of build, they were running inside, so anything that varies
    // between a packaged app and a local dev run (umask being the one that bit
    // us) was invisible to every investigation.
    const rt = this.runtimeInfo();
    const runtimeLine = rt
      ? `RUNNING BUILD: ${brandTitle() === DEFAULT_APP_TITLE ? DEFAULT_APP_TITLE : `${brandTitle()} (a fork of ${DEFAULT_APP_TITLE})`} v${rt.version}, ${rt.packaged ? 'packaged app' : 'local dev build'}${rt.appPath ? `, from ${rt.appPath}` : ''}. Say this version if asked which one is running, and do not assume behaviour from an older one. A local dev build inherits the launching shell's environment (umask included) where a packaged app does not, so file modes and inherited env can legitimately differ between the two. \`log.jsonl\` records an \`app-start\` event on every launch, which is how you spot a restart or a build switch.`
      : '';
    const engines = this.engines();
    const spawnQueueLine = meta.isGod && this.orchestratorMaySpawn()
      ? 'SPAWNING A WORKER: Read the Spawning a worker section in PROTOCOL-BOSS.md for the spawn request schema and rules; reuse an existing agent first.'
        + (JSON.stringify(engines) === JSON.stringify(DEFAULT_ENGINES) ? '' : `\n${formatEnginePromptProse(engines)}`)
      : '';
    const unityLine = this.capabilitiesOf(meta.id).unity ? unityPromptText(inDir('unity-requests'), unityResultsBase(dir, meta.id, hiveScratchRoot(), false), this.root()) : '';
    const godLine = meta.isGod
      ? `You are the BOSS / ORCHESTRATOR of this hive - your job is to ORCHESTRATE, not to implement: maintain live situational awareness and delegate the work. (1) AWARENESS - use the \`floor\` camp tool for a live compact view of the fleet and open cards, or inspect ${inRoot('fleet.json')} and ${inRoot('registry.json')} when needed; drain your inbox continually and triage requests so the team runs autonomously. (2) DELEGATE - use \`dispatch\` to assign tasks with a 4-part contract (objective, output, tools, boundaries); prefer routing to existing agents over spawning duplicates. Use \`send\` to communicate (never reply to scheduler, inform or done). (3) OWN ONLY THE IMPORTANT - decomposition, sign-offs, branch integration (\`merge_preflight\` then \`merge\` camp tools), and final QA. Remain sole scribe of board.md. (4) HUMAN DECISIONS - use \`ask_human\` kind "decision" (with \`answers\`: "yes_no" or the option labels) only when work waits on the human's answer; an answer to their own question or a passed final check is kind "result" (label answer|check), which goes to the Results tab and never blocks. Embed screenshots or videos (\`ask_human\` validates formatting). For a merge sign-off pass \`on_approve\` {type:'merge', repo, worktree, branch, target} (it pins the branch tip as head): a bare "good" then makes the harness preflight and fast-forward it (never a push), close the card and mail the worker; you hear back only on a failed check, a changed rebase or a hedged answer. Use \`create_card\` and \`patch_card\` for ledger updates (both enforce valid projects and assignees). ASK RULES the tools cannot check: show visual decisions as embedded images or videos, never describe them; never point at something without putting it on the card; when the ask comes from another agent's report, rewrite it into the decision, never paste the report; no HumanQuestion.md files, and never wait on the human in your session. patch_card fields: status, title, description, assignee, priority, project, dependsOn, notes, notesAppend, brief, briefAppend, result, merge (false when closing a card as dropped without merging its branch), humanQAAppend {q} (a decision), resultsAppend {text, label: answer|check} (Results tab), difficulty (easy|normal|hard: the assignee's model and effort at its next fresh session), needs (a list of unity|network, null clears; tag every card whose work needs Unity batch runs with [\"unity\"] and every card that needs network with [\"network\"]: its assignee gets the Unity broker or Codex network only while such a card is open, so an untagged Unity card's requests are refused). TESTS FIRST: a new card starts with its failing tests. A tests-only writer hands off with \`testsReady\` then "handoff" (branch, head), and you reassign the card to a separate implementer. When a senior worker takes the tests step, leave the card with that senior: it implements the same card after declaring \`testsReady\` then "implement", and the harness runs the checkpoint (handoff written, the human asked on the phone whether to keep the model or switch, fresh session either way); do not reassign it or restart the agent yourself. CLOSING A CARD: before you set any card done, list each numbered Work step of its original proposal or brief and name the shipped commit and the test or evidence that covers it (the Closing a card section of PROTOCOL-BOSS.md); a step with no coverage sends the card back (status doing) or gets its own visible follow-up card, never a silent close. When closing a card as dropped / not-a-bug / wontfix so its branch must stay unmerged, pass \`merge: false\` on the done patch so the harness skips auto-merge and autobuild. A tests-first handoff states its uncovered steps (testsReady \`uncovered\`, or a \"Steps not covered by these tests\" section in a done message); the harness refuses done on a card whose uncovered steps have no follow-up card and no \"Coverage:\" line in your result or notesAppend (unless \`merge: false\`). WORKER RULES: workers never set done, only you do; a worker that finishes sends you a done message, writes its brief and sets the card blocked with notesAppend "awaiting boss merge" (no brief, no handoff). Dormant agents wake automatically when assigned work or mailed.`
      : meta.isAssistant
      ? `You are ${godNameForPrompt}'s PREP ASSISTANT. You will be handed short, possibly vague instructions (each begins with "ENRICH TASK:"). For each one: (1) figure out which project it concerns and cd into the most relevant repo — you start in ${godNameForPrompt}'s home directory; (2) gather concrete context READ-ONLY (exact file paths, current state, relevant code, conventions, active branch, gotchas) — NEVER modify, create, or delete files; (3) rewrite the instruction into ONE clear, self-contained prompt that ${godNameForPrompt} can execute autonomously, preserving the user's original intent without inventing scope. Then deliver it: write ONE message JSON into your outbox with "to":"boss", "act":"request", a short subject, and the finished prompt as the body. Do NOT perform the task yourself — your only output is the improved prompt sent to ${godNameForPrompt}.`
      : 'For anything ambiguous, cross-cutting, or needing sign-off, address a message to "boss".';
    const guardrailsLine = 'Guardrails: a circuit breaker watches the floor — a "Circuit breaker: steer/constrain" message means you are looping or overspending, so STOP repeating, summarize what you tried, and follow it. Be token-frugal (a floor-wide or per-agent token budget can pause you). The shared plan has two parts: board.md (freeform; the Boss is the sole scribe) and tasks.json (structured kanban — todo/doing/blocked/done).';
    const visualChecksLine = meta.isGod || meta.isAssistant
      ? ''
      : VISUAL_CHECK_TIERS;
    const slackLine = meta.isGod
      ? 'SLACK REPLIES: When composing a Slack reply (or writing the `result` field of a Slack-origin kanban card), you MUST: (1) directly address what the user asked — never a bare "done"; (2) include the relevant specifics, outcome, and details; (3) format for Slack mrkdwn — open with a short *bold* headline, use bullet points for multiple items, wrap code/paths in `backtick` blocks, keep it concise (no walls of text). When finishing a Slack-origin task, always write a complete, user-facing, well-formatted `result` on the kanban card — the system posts it verbatim to Slack as the done reply.'
      : `SLACK REPLIES: If the Boss dispatches you a task that came from Slack, it will include an exact \`"${hiveNode}" "<helper>" --channel … --thread … --text "…"\` reply command — when you finish, run it VERBATIM to post your result back to that thread yourself. The reply must be SUBSTANTIVE Slack mrkdwn (a short *bold* headline + the actual outcome/specifics/links), NEVER a bare "done".`;
    const ledgerLine = meta.isGod
      ? `5. Never read the whole ${inRoot('tasks.json')} or ${inRoot('board.md')} (both run to hundreds of KB): ${inDir('my-tasks.md')} lists every open card in a few lines, \`jq '.tasks[] | select(.id=="<id>")' "${inRoot('tasks.json')}"\` reads one card, and grep or tail finds the board section you need. ${taskCardHowToBoss(inDir('outbox'))}`
      : `5. Never read the whole ${inRoot('tasks.json')} or ${inRoot('board.md')} (both run to hundreds of KB). Your open cards are in ${inDir('my-tasks.md')}, which the harness keeps current; read one card with \`jq '.tasks[] | select(.id=="<id>")' "${inRoot('tasks.json')}"\`. ${taskPatchHowTo(inDir('outbox'))} board.md is the Boss's: propose edits to the Boss.`;
    const values = { name: meta.name, id: meta.id, dir, root, tools: toolsLine };
    const section = (key: string, bundled: string, enabled = true): string =>
      enabled ? this.loadPromptSection(key, values) ?? bundled : '';
    return [
      `You are "${meta.name}" (${meta.id}), an autonomous agent in a collaborating hive of Claude agents.`,
      meta.isGod
        ? `Your private workspace is ${dir}. The shared hive is ${root}. Boss reference sections (fleet, dormant agents, spawning, ASK ME cards) are in ${inRoot('PROTOCOL-BOSS.md')}; open the one you need, not the whole file.`
        : `Your private workspace is ${dir}. The shared hive is ${root}. ${inRoot('PROTOCOL.md')} restates the rules below at length; you do not need to read it.`,
      '',
      'HIVE PROTOCOL: follow it every task.',
      `1. At the START of a task, read ${inDir('memory.md')} and the work you are handed: the start message, an inbox nudge or a Stop-hook notice names the inbox files and task ids. Pending files in ${inDir('inbox')} are work; never reread ${inDir('inbox', '.done')}. After handling an inbox message, move its file into ${inDir('inbox', '.done')}.`,
      `2. ${inDir('memory.md')} is a short CURRENT digest, under ${MEMORY_DIGEST_CAP} chars: durable facts, decisions, open threads. When it outgrows that, APPEND the older or superseded material to ${inDir('memory-archive.md')} (never delete it) and keep memory.md a digest. Both are searchable memory.`,
      `3. To ask another agent for something or share information, write ONE message JSON into ${inDir('outbox')}: {"to":"<agent-id>|boss|broadcast","act":"request|inform|propose|query|agree|refuse|done","subject":"...","body":"..."}, optionally "conversation" and "in_reply_to". Only request, query and propose expect a reply; never reply to inform or done. NEVER write into another agent's folder: the orchestrator delivers your outbox.`,
      meta.isGod
        ? '4. At the END of a task, update memory.md so future-you remembers.'
        : '4. At the END of a task, update memory.md so future-you remembers. Each card starts in a fresh session: when you end a turn with a todo card to start next (and none "doing"), the harness closes this session and starts a new one on that card, and nothing in this conversation carries over. Never set your next card to "doing" in the turn that finished the last one: that edit is refused, so end the turn instead. Before you end a turn after finishing or blocking a card, make sure its status (a task-patch, see 5), any open question for the human (sent to boss for the ASK ME card) and memory.md say where things stand. After a done report, a written card brief and an updated memory.md, the harness also closes a finished last card; later mail wakes you fresh to answer from that handoff.',
      section('ledgerLine', ledgerLine),
      section('guardrailsLine', guardrailsLine),
      section('visualChecksLine', visualChecksLine, Boolean(visualChecksLine)),
      section('memoryLine', memoryLine, Boolean(memoryLine)),
      section('knowledgeLine', knowledgeLine, Boolean(knowledgeLine)),
      section('vaultLine', vaultLine, Boolean(vaultLine)),
      meta.isGod ? section('godLine', godLine) : godLine,
      section('spawnQueueLine', spawnQueueLine, Boolean(spawnQueueLine)),
      section('unityLine', unityLine, Boolean(unityLine)),
      section('toolsLine', toolsLine, Boolean(toolsLine)),
      section('runtimeLine', runtimeLine, Boolean(runtimeLine)),
      section('slackLine', slackLine),
      section('ctxLine', ctxLine),
      `Env vars available to you: AGENT_ID, AGENT_NAME, HIVE_ROOT, AGENT_DIR.`
    ].filter(Boolean).join('\n');
  }

  /** The Boss's wake-request reasons, consumed by the next spawn of that agent. */
  private wakeReasons = new Map<string, string>();
  /** tasks.json mtime the my-tasks.md views were last built from. */
  private taskViewsMtime = -1;

  /** Remember why the Boss woke `agentId`, for that agent's start prompt. */
  noteWakeReason(agentId: string, reason: string | undefined): void {
    if (reason) this.wakeReasons.set(agentId, reason);
  }

  /** Cards in tasks.json, tolerant of a missing or hand-broken file. */
  private ledgerTasks(): Array<Partial<HiveTask> & { notes?: string; project?: string }> {
    return tasksOf(this.tasks()) as Array<Partial<HiveTask> & { notes?: string; project?: string }>;
  }

  /** The start prompt for a fresh spawn: the agent's work by id (open cards, pending
   *  mail, the Boss's wake reason) and the memory.md archive step when it is over the
   *  cap. `typeIt` says whether an idle-until-typed CLI (Claude) needs it typed: not for
   *  mail alone, which the inbox nudge already delivers. */
  private startPrompt(meta: AgentMeta, dir: string, root: string): { text: string; typeIt: boolean } {
    const tasks = this.ledgerTasks();
    const inbox = this.inbox(meta.id);
    const why = dormantWakeReason(meta.id, tasks, []);
    // In the order the next-card nudge uses, so the first one listed is the one to start.
    const open = why ? openCards(meta.id, tasks as NudgeCard[]).filter((t) => why.taskIds.includes(String(t.id ?? '?'))) : [];
    try {
      const moved = trimMemoryFile(dir, new Date().toISOString().slice(0, 10));
      if (moved) this.appendLog({ kind: 'memory-trimmed', agentId: meta.id, chars: moved });
    } catch (e) { console.error('[memory-trim]', meta.id, e); }
    let memoryChars = 0;
    try { memoryChars = readFileSync(join(dir, 'memory.md'), 'utf8').length; } catch { /* seeded below on first spawn */ }
    const bossReason = this.wakeReasons.get(meta.id);
    this.wakeReasons.delete(meta.id);
    const handoff = takeHandoff(dir);
    const text = startPromptText({
      isGod: !!meta.isGod,
      memoryPath: join(dir, 'memory.md'),
      archivePath: join(dir, 'memory-archive.md'),
      memoryChars,
      myTasksPath: join(dir, 'my-tasks.md'),
      tasksPath: join(root, 'tasks.json'),
      inboxDir: join(dir, 'inbox'),
      tasks: open.map((t) => ({
        id: String(t.id),
        title: t.title,
        status: t.status,
        description: t.description,
        brief: t.brief
      })),
      messages: inbox.map((m) => ({ id: m.id, from: m.from, subject: m.subject })),
      hiveRoot: root,
      bossReason,
      handoff: handoff ?? undefined
    });
    return { text, typeIt: !!meta.isGod || open.length > 0 || !!bossReason || !!handoff || memoryChars > MEMORY_DIGEST_CAP };
  }

  /** Repo roots named by the agent's todo/doing cards, inside its project dirs. */
  private taskRepos(agentId: string, projectDirs: string[]): string[] {
    const open = this.ledgerTasks().filter((t) => t.assignee === agentId && (t.status === 'todo' || t.status === 'doing'));
    return taskRepoRoots(open.map((t) => ({ text: `${t.title ?? ''}\n${t.description ?? ''}\n${t.notes ?? ''}`, project: t.project })), projectDirs);
  }

  /**
   * Rewrite each agent's `my-tasks.md`, a few-line view of its open cards, so no agent
   * has to read tasks.json (hundreds of KB) to find its own work. The Boss's view lists
   * every open card on the floor. Cheap to call often: it does nothing until tasks.json
   * changes, and only writes a file whose content changed.
   */
  refreshTaskViews(force = false): void {
    const root = this.root();
    if (!root) return;
    let mtime = 0;
    try { mtime = statSync(join(root, 'tasks.json')).mtimeMs; } catch { return; }
    if (!force && mtime === this.taskViewsMtime) return;
    this.taskViewsMtime = mtime;
    const tasks = this.ledgerTasks();
    const reg = this.registry();
    for (const [id, a] of Object.entries(reg.agents)) {
      const dir = this.agentDir(id);
      if (!existsSync(dir)) continue;
      const body = renderTaskView({ tasks, agentId: id, isBoss: !!a.isGod, tasksPath: join(root, 'tasks.json') });
      const path = join(dir, 'my-tasks.md');
      try {
        if (existsSync(path) && readFileSync(path, 'utf8') === body) continue;
        writeFileSync(path, body, 'utf8');
      } catch { /* best-effort; the next change retries */ }
    }
  }

  // — messaging —

  /** Normalize a partial message into a full HiveMessage. */
  private normalize(partial: Partial<HiveMessage>, from: string): HiveMessage {
    const act = (partial.act ?? 'inform') as MessageAct;
    return {
      id: partial.id ?? `${stamp()}-${shortRand()}`,
      conversation: partial.conversation ?? `conv-${shortRand()}`,
      in_reply_to: partial.in_reply_to ?? null,
      from: partial.from ?? from,
      to: partial.to ?? 'god',
      act,
      subject: partial.subject ?? '',
      body: partial.body ?? '',
      hops: typeof partial.hops === 'number' ? partial.hops : 0,
      requires_reply: partial.requires_reply ?? ['request', 'query', 'propose'].includes(act),
      needs_human: partial.needs_human ?? false,
      created_at: partial.created_at ?? new Date().toISOString(),
      ...(partial.includeDormant === true ? { includeDormant: true } : {})
    };
  }

  /** Atomically deliver a message into a recipient agent's inbox.
   *  Returns false when the recipient has no inbox, so the caller can bounce and
   *  log the drop rather than let the message vanish. */
  private deliver(msg: HiveMessage, toId: string): boolean {
    const inbox = join(this.agentDir(toId), 'inbox');
    if (!existsSync(inbox)) return false; // unknown recipient — the caller reports it
    if (this.isClosingActive() && isShutdownOrder(msg) && msg.closingGeneration === undefined) {
      msg.closingGeneration = this.getClosingGeneration();
    }
    this.atomicWriteJson(join(inbox, `${msg.id}.json`), msg);
    return true;
  }

  /** Inject a message directly (used by the orchestrator / UI / tests). */
  send(partial: Partial<HiveMessage>, from = 'system'): HiveMessage {
    const msg = this.normalize(partial, from);
    this.routeMessage(msg);
    this.commit(`hive: msg ${msg.from}→${msg.to} (${msg.act})`);
    return msg;
  }

  private routeMessage(msg: HiveMessage): void {
    if (msg.hops > HOP_CAP) {
      // loop guard — drop a runaway message rather than let agents ping-pong.
      // There's no human queue to fall back on; the god agent owns conflicts.
      this.appendLog({ kind: 'drop', reason: 'hop-cap', from: msg.from, to: msg.to, id: msg.id });
      return;
    }
    const reg = this.registry();
    const godId = reg.godId ?? 'god';
    // The hive has no separate human-approval queue — approvals are native to
    // each agent's Claude Code session (and approvable remotely). A message aimed
    // at "human" is handled by the god/orchestrator, the human's proxy here.
    const resolveTo = (to: string): string => (to === 'human' || to === 'god' || to === 'boss' ? godId : to);
    const live = this.liveAgentSource?.();
    const targets = msg.to === 'broadcast'
      // Fan-out reaches agents with a live session only, plus dormant ones when the
      // message opts in. Hookless providers are NOT skipped: the per-target path
      // below serves them a terminal work order. See selectBroadcastTargets.
      ? selectBroadcastTargets(reg.agents, msg.from, live ? new Set(live) : null, msg.includeDormant === true)
      // Never deliver to self — guards a god → "human" message looping back to god.
      : [resolveTo(msg.to)].filter((t) => t !== msg.from);
    // Targets that actually took delivery. The log below reports these instead of
    // intent, so a bounced or dropped message can never read as delivered.
    const delivered: string[] = [];
    for (const t of targets) {
      // The send-only prep assistant must never be a delivery target: it doesn't
      // drain an inbox, so direct mail to it would rot unread (observed live: a
      // task brief plus the follow-up reprimand about the unread inbox, both
      // unread for hours). Bounce such mail to god instead, so the sender's intent
      // surfaces immediately and nothing is silently lost.
      if (reg.agents[t]?.isAssistant) {
        this.deliver({
          ...msg,
          to: godId,
          subject: `[bounced — "${t}" is the send-only prep assistant; route work to a real agent] ${msg.subject}`
        }, godId);
        continue;
      }
      // A provider without safe-idle lifecycle state (a hookless custom command)
      // would let direct mail rot unread. Claude and bridged Antigravity/Codex
      // receive directly into inbox/ for guarded renderer delivery. Otherwise try
      // a terminal work-order handoff to its REPL (#53);
      // if the renderer is unavailable, bounce to god to relay. God is exempt
      // (the bounce target).
      if (t !== godId && !canReceiveInbox(reg.agents[t]?.provider)) {
        if (!this.emitTerminalHandoff(msg, t)) {
          this.deliver({
            ...msg,
            to: godId,
            subject: `[undeliverable — "${t}" runs ${reg.agents[t]?.provider ?? 'a hookless CLI'} and the terminal handoff failed (renderer unavailable); relay this to it] ${msg.subject}`
          }, godId);
        } else delivered.push(t);
        continue;
      }
      // 1d — proxy-tier providers (qwen) CAN receive inbox, but only via a
      // SYNTHESIZED Stop, which just advances the cursor — the sidecar observes the
      // CLI's stream and can't inject a drain reason back into its turn. So the real
      // mail rides the terminal work-order path verbatim, exactly like a hookless
      // provider; the synthesized Stop→drain keeps the cursor in step.
      const proxyDesc = bridgeOf(reg.agents[t]?.provider);
      if (t !== godId && proxyDesc?.kind === 'proxy' && proxyDesc.inboxDelivery === 'terminal') {
        if (!this.emitTerminalHandoff(msg, t)) {
          this.deliver({
            ...msg,
            to: godId,
            subject: `[undeliverable — "${t}" runs ${reg.agents[t]?.provider ?? 'a proxy-tier CLI'} and the terminal handoff failed (renderer unavailable); relay this to it] ${msg.subject}`
          }, godId);
        } else delivered.push(t);
        continue;
      }
      if (this.deliver(msg, t)) { delivered.push(t); continue; }
      // No agents/<t>/inbox — an id that isn't on the floor. This was the one
      // delivery failure with neither bounce nor log, so the sender saw a routed
      // message and the mail simply ceased to exist. Record the drop beside the
      // hop-cap one and bounce to god, mirroring the undeliverable bounces above.
      this.appendLog({ kind: 'drop', reason: 'no-inbox', from: msg.from, to: t, id: msg.id });
      if (t !== godId) {
        this.deliver({
          ...msg,
          to: godId,
          subject: `[undeliverable — no agent "${t}" on this floor; check the id against the roster] ${msg.subject}`
        }, godId);
      }
    }
    this.appendLog({ kind: 'message', from: msg.from, to: msg.to, act: msg.act, subject: msg.subject, id: msg.id, delivered });
    this.emitMessage(msg, targets);
    // Main-process observer (e.g. the closing-time controller watching for the
    // team's ACKs and the god's COMPLETE). Best-effort, never breaks routing.
    try { this.routedObserver?.(msg, targets); } catch { /* observer error */ }
  }

  /** Observer invoked for EVERY routed message with its resolved targets.
   *  Used by main-process features that react to hive traffic (closing time). */
  private routedObserver: ((msg: HiveMessage, targets: string[]) => void) | null = null;
  setRoutedObserver(cb: ((msg: HiveMessage, targets: string[]) => void) | null): void {
    this.routedObserver = cb;
  }

  /** Ids of agents with a live PTY, which broadcast fan-out is limited to. Main
   *  supplies it; unset, the registry `dormant` flag decides who is asleep. */
  private liveAgentSource: (() => string[]) | null = null;
  private closingTimeSource: (() => boolean) | null = null;
  private closingSessionInfo: { active: boolean; startedAt: number; generation: number } = {
    active: false,
    startedAt: 0,
    generation: 0
  };
  private closingSessionSource: (() => { active: boolean; startedAt: number; generation: number }) | null = null;
  private testsReadyObserver: ((sender: string, cardId: string, ready: NonNullable<HiveTask['testsReady']>) => void) | null = null;
  private restartAgentHook: Parameters<HiveManager['setRestartAgentHook']>[0] = null;
  private restartCampHook: Parameters<HiveManager['setRestartCampHook']>[0] = null;
  private archiveAgentGuard: ((id: string) => string | null) | null = null;
  private freshStartHook: ((agentId: string, cardId: string) => void) | null = null;
  private cardPatchGate: ((sender: string, cardId: string, patch: Record<string, unknown>, ledger: readonly unknown[]) => string | null) | null = null;
  /** Called when a card is delivered to an agent whose session is live and idle: main ends it through the handoff path and starts a fresh one. */
  /** Main's restart of a hung agent; called with the authenticated sender after the Boss-only checks pass. */
  setRestartAgentHook(cb: ((sender: string, body: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; warnings?: string[] }> | { ok: boolean; error?: string }) | null): void {
    this.restartAgentHook = cb;
  }
  setRestartCampHook(cb: ((sender: string, request: CampRestartRequest) => RestartResult | Promise<RestartResult>) | null): void {
    this.restartCampHook = cb;
  }
  /** Main's veto on a Boss archive request: a reason string refuses it (e.g. a live session). */
  setArchiveAgentGuard(cb: ((id: string) => string | null) | null): void {
    this.archiveAgentGuard = cb;
  }
  setFreshStartHook(cb: ((agentId: string, cardId: string) => void) | null): void {
    this.freshStartHook = cb;
  }
  setLiveAgentSource(cb: (() => string[]) | null): void {
    this.liveAgentSource = cb;
  }

  /** Main's ClosingTimeController.isActive, which outbox card edits are checked against. */
  private modelTiersSource: (() => ModelTiers) | null = null;
  /** The camp tier lists (config.json modelTiers), for the walk agent-config reports. */
  setModelTiersSource(cb: (() => ModelTiers) | null): void {
    this.modelTiersSource = cb;
  }

  setClosingTimeSource(cb: (() => boolean) | null): void {
    this.closingTimeSource = cb;
  }

  setClosingSessionSource(cb: (() => { active: boolean; startedAt: number; generation: number }) | null): void {
    this.closingSessionSource = cb;
  }

  setClosingSessionInfo(info: Partial<{ active: boolean; startedAt: number; generation: number }>): void {
    this.closingSessionInfo = { ...this.closingSessionInfo, ...info };
  }

  isClosingActive(): boolean {
    if (this.closingTimeSource) {
      try { return !!this.closingTimeSource(); } catch { return false; }
    }
    if (this.closingSessionSource) {
      try { return !!this.closingSessionSource().active; } catch { return false; }
    }
    return this.closingSessionInfo.active;
  }

  getClosingSessionStartedAt(): number {
    if (this.closingSessionSource) {
      try { return this.closingSessionSource().startedAt; } catch { return 0; }
    }
    return this.closingSessionInfo.startedAt;
  }

  getClosingGeneration(): number {
    if (this.closingSessionSource) {
      try { return this.closingSessionSource().generation; } catch { return 0; }
    }
    return this.closingSessionInfo.generation;
  }

  /** A worker's card patch, checked against the pre-edit ledger: a refusal reason, or
   *  null to apply it. Main refuses a card the worker's session was not started for. */
  /** Called after a worker's testsReady lands on its card. */
  setTestsReadyObserver(cb: ((sender: string, cardId: string, ready: NonNullable<HiveTask['testsReady']>) => void) | null): void {
    this.testsReadyObserver = cb;
  }

  /** Record the checkpoint on the card as done, note the outcome, hand a blocked card back to its assignee as todo and tell them to implement. */
  settleTestsCheckpoint(cardId: string, note: string): void {
    const card = (this.readLedger() ?? []).find((t) => !!t && typeof t === 'object' && (t as HiveTask).id === cardId) as HiveTask | undefined;
    if (!card) return;
    const now = new Date().toISOString();
    this.patchTask(cardId, {
      ...(card.status === 'blocked' ? { status: 'todo' as const } : {}),
      testsCheckpoint: { state: 'done', askedAt: now, resolvedAt: now },
      notes: `${priorNotes(card)}${note}`,
      updatedAt: now
    } as Partial<Omit<HiveTask, 'id'>>);
    if (card.assignee) {
      this.send({ to: card.assignee, act: 'inform', subject: `CHECKPOINT passed on ${cardId}: implement now`, body: `${note}\nYour handoff note holds the context. The failing tests are on ${card.testsReady?.branch ?? 'your branch'} @ ${card.testsReady?.head?.slice(0, 8) ?? '?'}. Implement ${cardId} now, in this fresh session; set it doing first.` }, 'harness');
    }
    this.appendLog({ kind: 'tests-checkpoint-settled', id: cardId });
  }

  setCardPatchGate(cb: ((sender: string, cardId: string, patch: Record<string, unknown>, ledger: readonly unknown[]) => string | null) | null): void {
    this.cardPatchGate = cb;
  }

  private ffMergeDeps?: HarnessFfMergeDeps;
  setFfMergeDeps(deps?: HarnessFfMergeDeps): void {
    this.ffMergeDeps = deps;
  }

  private agentBalancerAdapter: {
    readAgents?: () => Record<string, AgentBalancerState>;
    apply: (patches: AgentBalancerPatch[]) => { ok: boolean; reason?: string };
  } | null = null;

  /** Wire the main-process balancer store (RosterStore + config.json for the Boss +
   *  renderer IPC sync). When unset (unit tests), HiveManager falls back to
   *  RosterStore(getHome) + registry.json directly. */
  setAgentBalancerAdapter(
    adapter: {
      readAgents?: () => Record<string, AgentBalancerState>;
      apply: (patches: AgentBalancerPatch[]) => { ok: boolean; reason?: string };
    } | null
  ): void {
    this.agentBalancerAdapter = adapter;
  }

  /** Tell the renderer a message was routed, with its resolved recipients, so
   *  the floor can fly an envelope from the sender to each one. Best-effort. */
  private emitMessage(msg: HiveMessage, targets: string[]): void {
    this.emit?.('hive:message', {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      act: msg.act,
      subject: msg.subject,
      targets,
      // Coral-tints the floor envelope for a message the agent flagged for the
      // human (now routed to the god proxy). Cosmetic only — no queue behind it.
      needsHuman: msg.to === 'human'
    });
  }

  /** Non-Claude providers cannot drain hive inbox; hand direct mail to the
   *  renderer so it can queue a terminal work order for the target PTY. */
  private emitTerminalHandoff(msg: HiveMessage, targetId: string): boolean {
    const delivered = this.emit?.('hive:terminalHandoff', {
      id: msg.id,
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      body: msg.body,
      requiresReply: msg.requires_reply,
      createdAt: msg.created_at
    }) === true;
    this.appendLog({
      kind: 'terminal-handoff',
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      id: msg.id,
      delivered
    });
    return delivered;
  }

  // — router: drain outboxes → inboxes —

  /** Poll-based router. Cheap and robust vs fs.watch quirks on macOS. */
  startRouter(intervalMs = 1500): void {
    if (this.routerTimer || !this.enabled()) return;
    try { this.autoUnblockDependents(); } catch { /* best-effort at startup */ }
    try { this.resumeApprovedRebaseTimers(); } catch { /* best-effort at startup */ }
    this.routerTimer = setInterval(() => {
      try { this.routeOnce(); } catch { /* keep the loop alive */ }
    }, intervalMs);
  }
  stopRouter(): void {
    if (this.routerTimer) { clearInterval(this.routerTimer); this.routerTimer = null; }
    for (const timer of this.rebaseTimers.values()) clearTimeout(timer);
    this.rebaseTimers.clear();
  }

  /** While routeOnce drains outboxes, card edits apply to this in-memory ledger and
   *  tasks.json is written once at the end: one parse and one write per tick, not per
   *  patch (a 172-card retag rewrote the 1.2 MB file 172 times on the main thread). */
  private ledgerBatch: { tasks: unknown[]; dirty: boolean } | null = null;

  /** log.jsonl and cost-ledger.jsonl appends and the fleet.json snapshot run off the
   *  main thread: see asyncFileWriter.ts. */
  private readonly appends = new AppendQueue();
  private readonly snapshots = new LatestWriter();

  routeOnce(): number {
    const root = this.root();
    if (!root) return 0;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return 0;
    let routed = 0;
    try {
      routed = this.drainOutboxes(agentsDir);
    } finally {
      const batch = this.ledgerBatch;
      this.ledgerBatch = null;
      if (batch?.dirty) {
        this.atomicWriteJson(join(root, 'tasks.json'), { tasks: batch.tasks });
        this.appendLog({ kind: 'tasks', count: batch.tasks.length });
      }
    }
    if (routed > 0) this.commit(`hive: routed ${routed} message(s)`);
    return routed;
  }

  private drainOutboxes(agentsDir: string): number {
    let routed = 0;
    for (const id of readdirSync(agentsDir)) {
      const outbox = join(agentsDir, id, 'outbox');
      if (!existsSync(outbox)) continue;
      const doneMsgs: HiveMessage[] = [];
      for (const f of readdirSync(outbox)) {
        if (!f.endsWith('.json')) continue;
        const full = join(outbox, f);
        try {
          const raw = readFileSync(full, 'utf8');
          let writtenAtMs = Date.now();
          try { writtenAtMs = statSync(full).mtimeMs; } catch { /* now */ }
          let partial: Partial<HiveMessage>;
          try {
            partial = JSON.parse(raw) as Partial<HiveMessage>;
          } catch {
            const repaired = repairLiteralLineBreaksInJsonStrings(raw);
            if (!repaired.changed) {
              this.appendLog({ kind: 'drop', reason: 'malformed-json', from: id, file: f });
              try { renameSync(full, join(outbox, '.sent', `bad-${f}`)); } catch { /* noop */ }
              continue;
            }
            try {
              partial = JSON.parse(repaired.text) as Partial<HiveMessage>;
            } catch {
              this.appendLog({ kind: 'drop', reason: 'malformed-json', from: id, file: f });
              try { renameSync(full, join(outbox, '.sent', `bad-${f}`)); } catch { /* noop */ }
              continue;
            }
            this.appendLog({
              kind: 'outbox-repair',
              from: id,
              file: f,
              repair: 'literal-line-break'
            });
          }
          if (isTaskAct(partial.act)) {
            if (!this.ledgerBatch) {
              const ledger = this.readLedger();
              if (ledger) this.ledgerBatch = { tasks: ledger, dirty: false };
            }
            this.applyTaskMessage(id, partial.act, partial.body);
            renameSync(full, join(outbox, '.sent', f));
            routed++;
            continue;
          }
          if ((partial.act as string | undefined) === ARCHIVE_AGENT_ACT) {
            this.applyArchiveAgentMessage(id, partial.body);
            renameSync(full, join(outbox, '.sent', f));
            routed++;
            continue;
          }
          if ((partial.act as string | undefined) === RESTART_AGENT_ACT) {
            this.applyRestartAgentMessage(id, partial.body);
            renameSync(full, join(outbox, '.sent', f));
            routed++;
            continue;
          }
          if ((partial.act as string | undefined) === RESTART_CAMP_ACT) {
            renameSync(full, join(outbox, '.sent', f));
            this.applyRestartCampMessage(id, partial.body);
            routed++;
            continue;
          }
          if (isAgentConfigAct(partial.act)) {
            this.applyAgentConfigMessage(id, partial.body);
            renameSync(full, join(outbox, '.sent', f));
            routed++;
            continue;
          }
          const msg = this.normalize(partial, id);
          msg.from = id; // sender is authoritative — the owning directory
          this.routeMessage(msg);
          renameSync(full, join(outbox, '.sent', f)); // archive, don't reprocess
          routed++;
          if (msg.act === 'done') doneMsgs.push(msg);
          this.fileRepliedInbox(id, partial, msg.to, writtenAtMs);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.appendLog({ kind: 'drop', reason, from: id, file: f });
          try { renameSync(full, join(outbox, '.sent', `bad-${f}`)); } catch { /* noop */ }
          try {
            this.deliver(this.normalize({
              to: id,
              act: 'inform',
              subject: `outbox message refused (${f}): ${reason}`,
              body: `Quarantined outbox/${f} to outbox/.sent/bad-${f}: ${reason}`,
              requires_reply: false
            }, 'harness'), id);
          } catch { /* best-effort refusal */ }
        }
      }
      // After the whole outbox, so a brief patch sent beside the done message has landed.
      for (const msg of doneMsgs) {
        this.autoBlockOnDone(id, msg);
        this.autoFfMergeOnDone(id, msg);
        this.retryApprovedMergeOnDone(id, msg);
      }
    }
    this.autoUnblockDependents();
    return routed;
  }

  // — read helpers (for IPC / UI) —

  registry(): Registry {
    const root = this.root();
    if (!root) return { godId: null, agents: {} };
    return this.readJson<Registry>(join(root, 'registry.json'), { godId: null, agents: {} });
  }
  board(): string {
    const root = this.root();
    return root && existsSync(join(root, 'board.md')) ? readFileSync(join(root, 'board.md'), 'utf8') : '';
  }
  tasks(): unknown {
    if (this.ledgerBatch) return { tasks: this.ledgerBatch.tasks };
    const root = this.root();
    return root ? this.readJson(join(root, 'tasks.json'), { tasks: [] }) : { tasks: [] };
  }

  /** Persist the task ledger to hive/tasks.json and commit it. Mirrors the
   *  board/message persist pattern: write JSON (tmp + rename, so a reader never
   *  parses half a file), log the change, single-commit. Writes nothing while the
   *  on-disk ledger does not parse.
   *
   *  MERGES by card id instead of clobbering. Callers hold PARTIAL models of a
   *  card — the renderer's kanban parser knows nine fields, the god writes as
   *  many as the work needs (`result`, the verbatim Slack reply posted back to
   *  the user; `repo`; `scope`; `origin`; `commit`; …). A wholesale write meant
   *  one small edit through the UI deleted every unmodelled field on EVERY card
   *  on the board. Now an unmentioned field keeps its on-disk value.
   *
   *  Deleting a card still works: the incoming list IS the membership, so a card
   *  dropped from it (TasksKanban dismiss, the voice delete_task action) is
   *  gone. Merging protects fields, never card membership. */
  writeTasks(tasks: HiveTask[]): boolean {
    const root = this.root();
    if (!root) return false;
    this.ensureHive();
    const path = join(root, 'tasks.json');
    const current = this.readLedger();
    if (!current) {
      this.appendLog({ kind: 'tasks-unreadable', count: tasks.length });
      return false;
    }
    const now = new Date().toISOString();
    const merged = mergeTaskLedger(current, tasks).map((t) => withPriorityLevel(retireSupersededAsks(t, now).card));
    if (this.ledgerBatch) {
      this.ledgerBatch.tasks = merged;
      this.ledgerBatch.dirty = true;
      return true;
    }
    this.atomicWriteJson(path, { tasks: merged });
    this.appendLog({ kind: 'tasks', count: merged.length });
    this.commit(`hive: tasks (${merged.length})`);
    return true;
  }

  /** Route a human answer already recorded on card `taskId`: a blocked worker card goes
   *  to todo and its assignee gets the answer. The Boss is mailed only when the answer
   *  reads like a scope or model change, is an approval (the Boss merges), or when the
   *  harness cannot route it (no live worker assignee, or the ledger refused the unblock).
   *  A card whose open question carries an approve action (ask_human on_approve) is merged
   *  by the harness itself on a bare approve; see approvedMerge.ts. Returns who was mailed. */
  routeHumanAnswer(taskId: string, q: string, a: string): { assignee: string | null; boss: boolean } {
    const ledger = this.readLedger() ?? [];
    const task = ledger.find((t) => !!t && typeof t === 'object' && (t as { id?: unknown }).id === taskId) as HiveTask | undefined;
    const reg = this.registry();
    const godId = reg.godId ?? 'god';
    const toBoss = (extra?: string, workerMailed = !!extra): { assignee: string | null; boss: boolean } => {
      this.mailBossAnswer(task ?? { id: taskId }, q, a, extra);
      return { assignee: workerMailed ? (task?.assignee ?? null) : null, boss: true };
    };
    const assignee = typeof task?.assignee === 'string' ? task.assignee : '';
    const agent = assignee ? reg.agents[assignee] : undefined;
    if (!task || !agent || agent.archived || agent.isGod || assignee === godId) return toBoss();
    const action = task.approveAction && task.approveAction.q === q && !task.approveAction.pendingRebase ? task.approveAction : undefined;
    if (action) {
      const kind = classifyApproveAnswer(a);
      if (kind === 'ambiguous') return toBoss(AMBIGUOUS_NOTE, false);
      if (kind === 'approve') {
        if (task.status !== 'blocked' || isBacklogged(task)) return toBoss(bossExceptionNote(action, `the card is ${isBacklogged(task) ? 'backlogged' : task.status}, not blocked`), false);
        return this.settleApprovedMerge(task, action, a, attemptApprovedMerge(action));
      }
    }
    const awaitingMerge = !action && notesAwaitingMerge((task as { notes?: unknown }).notes);
    // An approval is the Boss's cue to merge, never a reason to reopen the work.
    if (APPROVAL_ANSWER.test(a) || (awaitingMerge && classifyApproveAnswer(a) === 'approve')) return toBoss();
    const spent: Partial<HiveTask> = action ? { approveAction: undefined } : {};
    const busyOn = task.status === 'blocked' ? this.busyCardOf(assignee, taskId, ledger as HiveTask[]) : null;
    if (busyOn) {
      const now = new Date().toISOString();
      const note = `answer held: ${assignee} busy on ${busyOn}`;
      const plan = planTaskMessage({ act: 'task-patch', sender: 'harness', isBoss: true, tasks: ledger, now, body: { id: taskId, notesAppend: note } });
      if (plan.ok && plan.kind === 'patch' && this.patchTask(taskId, { ...(plan.patch as Partial<Omit<HiveTask, 'id'>>), ...spent, heldAnswer: { for: assignee, since: now } })) {
        this.appendLog({ kind: 'human-answer-held', id: taskId, assignee, busyOn });
        return toBoss(`${note}; the harness delivers it to a fresh session when ${assignee} is free (task-patch status todo releases it early).`, false);
      }
      return toBoss();
    }
    let unblocked = false;
    if (task.status === 'blocked') {
      const now = new Date().toISOString();
      if (!isBlockedByDeps(task as TaskLike, ledger as TaskLike[])) {
        const plan = planTaskMessage({
          act: 'task-patch', sender: 'harness', isBoss: true, tasks: ledger, now,
          closingTime: this.closingTimeSource?.() ?? false,
          body: { id: taskId, status: 'todo', notesAppend: `Human answered the ASK; harness unblocked and mailed ${assignee}` }
        });
        if (!plan.ok || plan.kind !== 'patch' || !this.patchTask(taskId, { ...(plan.patch as Partial<Omit<HiveTask, 'id'>>), ...spent })) return toBoss();
        unblocked = true;
      } else {
        const plan = planTaskMessage({
          act: 'task-patch', sender: 'harness', isBoss: true, tasks: ledger, now,
          closingTime: this.closingTimeSource?.() ?? false,
          body: { id: taskId, notesAppend: `Human answered the ASK; dependencies incomplete; mailed ${assignee}` }
        });
        if (!plan.ok || plan.kind !== 'patch') return toBoss();
        const patch = { ...(plan.patch as Partial<Omit<HiveTask, 'id'>>), ...spent };
        const latest = Array.isArray(task.humanQA) ? [...task.humanQA].reverse().find((item) => item && typeof item === 'object' && (item as { a?: unknown }).a && !(item as { dismissedAt?: unknown }).dismissedAt) : undefined;
        if (latest && !APPROVAL_ANSWER.test(String((latest as { a: unknown }).a))) {
          patch.sendBacks = (typeof task.sendBacks === 'number' ? task.sendBacks : 0) + 1;
          patch.sendBackHistory = [...(Array.isArray(task.sendBackHistory) ? task.sendBackHistory : []), { answer: (latest as { a: unknown }).a as string, when: (latest as { answeredAt?: string }).answeredAt ?? now }];
        }
        if (!this.patchTask(taskId, patch)) return toBoss();
      }
    } else if (task.status === 'done') return toBoss();
    this.send({ to: assignee, act: 'inform', subject: `HUMAN ANSWER on ${taskId}`, body: assigneeAnswerBody(task, q, a, unblocked) }, 'human');
    const boss = answerNeedsBoss(a);
    this.appendLog({ kind: 'human-answer-routed', id: taskId, assignee, unblocked, boss: boss || awaitingMerge });
    if (unblocked && this.isLive(assignee)) this.startFresh(assignee, taskId);
    const notes = [boss ? bossAnswerNote(task, unblocked) : '', awaitingMerge ? awaitingMergeNote(assignee, unblocked) : ''].filter(Boolean);
    if (notes.length) return toBoss(notes.join('\n'));
    return { assignee, boss: false };
  }

  private isLive(agentId: string): boolean {
    return !!this.liveAgentSource?.().includes(agentId);
  }

  private startFresh(agentId: string, cardId: string): void {
    try { this.freshStartHook?.(agentId, cardId); } catch (e) { console.error('[answer-hold] fresh start failed:', e); }
  }

  /** The id of another card of `agentId` in doing while its session is live, else null. */
  private busyCardOf(agentId: string, exceptId: string, ledger: HiveTask[]): string | null {
    if (!this.isLive(agentId)) return null;
    return ledger.find((t) => !!t && t.id !== exceptId && t.assignee === agentId && t.status === 'doing')?.id ?? null;
  }

  /** Deliver the oldest answer held for `agentId` if it is free now: card to todo, answer mailed, and a live idle session handed to the fresh-start hook. */
  private releaseHeldAnswer(agentId: string): void {
    const ledger = (this.readLedger() ?? []) as HiveTask[];
    const held = ledger
      .filter((t) => !!t && t.heldAnswer?.for === agentId && t.status === 'blocked')
      .sort((x, y) => String(x.heldAnswer?.since).localeCompare(String(y.heldAnswer?.since)))[0];
    if (!held || this.busyCardOf(agentId, held.id, ledger)) return;
    const latest = Array.isArray(held.humanQA) ? [...held.humanQA].reverse().find((i) => i && typeof i === 'object' && (i as { a?: unknown }).a && !(i as { dismissedAt?: unknown }).dismissedAt) as { q?: string; a?: string } | undefined : undefined;
    const depsOpen = isBlockedByDeps(held as TaskLike, ledger as TaskLike[]);
    const plan = planTaskMessage({
      act: 'task-patch', sender: 'harness', isBoss: true, tasks: ledger, now: new Date().toISOString(),
      closingTime: this.closingTimeSource?.() ?? false,
      body: { id: held.id, ...(depsOpen ? {} : { status: 'todo' }), notesAppend: `Held answer released: ${agentId} is free; harness mailed it` }
    });
    if (!plan.ok || plan.kind !== 'patch' || !this.patchTask(held.id, { ...(plan.patch as Partial<Omit<HiveTask, 'id'>>), heldAnswer: undefined })) return;
    this.send({ to: agentId, act: 'inform', subject: `HUMAN ANSWER on ${held.id}`, body: assigneeAnswerBody(held, latest?.q ?? '', latest?.a ?? '', !depsOpen) }, 'human');
    this.appendLog({ kind: 'human-answer-released', id: held.id, assignee: agentId });
    if (!depsOpen && this.isLive(agentId)) this.startFresh(agentId, held.id);
  }

  /** Every desktop and phone dismissal lands in patchTask, so the Boss mail lives here. */
  private mailDismissedAsks(before: HiveTask, after: HiveTask): void {
    for (const ask of newlyDismissedAsks(before, after)) {
      let ends: LooseEnds = { branches: [], worktrees: [], folders: [] };
      try { ends = looseEnds(after, { repos: this.ffMergeDeps?.repos, git: this.ffMergeDeps?.git, hiveRoot: this.root() }); } catch { /* the mail still goes, without the list */ }
      this.send({ to: 'god', act: 'inform', subject: `ASK DISMISSED on card ${after.id}: "${after.title ?? after.id}"`, body: dismissMailBody(after, ask, ends) }, 'human');
    }
  }

  /** The card `cardId` and its result stamped `resultAt`, from the on-disk ledger. */
  private findResult(cardId: string, resultAt: string): { task: HiveTask; result: CardResult } | null {
    const task = (this.readLedger() ?? []).find((t) => !!t && typeof t === 'object' && (t as { id?: unknown }).id === cardId) as HiveTask | undefined;
    const result = Array.isArray(task?.results) ? task.results.find((r) => isCardResult(r) && r.at === resultAt) : undefined;
    return task && result ? { task, result } : null;
  }

  /** the human's reply to a result: mailed to the card's worker (when it has one) and the Boss with the
   *  result quoted, and recorded in the card notes. The card's status is left alone. */
  replyToResult(cardId: string, resultAt: string, reply: string): { ok: boolean; assignee: string | null; boss: boolean; error?: string } {
    const text = reply.trim();
    if (!text) return { ok: false, assignee: null, boss: false, error: 'empty reply' };
    const found = this.findResult(cardId, resultAt);
    if (!found) return { ok: false, assignee: null, boss: false, error: `no result ${resultAt} on card ${cardId}` };
    const { task, result } = found;
    const reg = this.registry();
    const godId = reg.godId ?? 'god';
    const assignee = typeof task.assignee === 'string' ? task.assignee : '';
    const agent = assignee ? reg.agents[assignee] : undefined;
    const worker = agent && !agent.archived && !agent.isGod && assignee !== godId ? assignee : null;
    const body = `The human replied to a result on ${cardId} ("${task.title ?? cardId}").\n\nResult (${result.at}):\n${quoteResult(result.text)}\n\nThe human's reply:\n${text}`;
    const subject = `HUMAN REPLY to result on ${cardId}`;
    this.appendCardNote(cardId, `The human replied to result ${result.at}: ${text.replace(/\s+/g, ' ')}`);
    if (worker) this.send({ to: worker, act: 'inform', subject, body }, 'human');
    this.send({ to: godId, act: 'inform', subject, body: worker ? `${body}\n\n(also mailed ${worker})` : body }, 'human');
    this.appendLog({ kind: 'result-reply', id: cardId, at: result.at, assignee: worker });
    return { ok: true, assignee: worker, boss: true };
  }

  /** File a todo card for the Boss to route, linked to `cardId` by followUpOf, with the result quoted. */
  followUpFromResult(cardId: string, resultAt: string, note: string): { ok: boolean; cardId?: string; error?: string } {
    const found = this.findResult(cardId, resultAt);
    if (!found) return { ok: false, error: `no result ${resultAt} on card ${cardId}` };
    const { task, result } = found;
    const godId = this.registry().godId ?? 'god';
    const taken = new Set((this.readLedger() ?? []).map((t) => (t as { id?: unknown })?.id));
    let id = `followup-${cardId}`;
    for (let n = 2; taken.has(id); n++) id = `followup-${cardId}-${n}`;
    const extra = note.trim();
    const title = `Follow-up to ${task.title ?? cardId}`;
    const description = [
      `Follow-up to ${cardId}, filed by the human from its result of ${result.at}.`,
      quoteResult(result.text),
      ...(extra ? [`The human: ${extra}`] : [])
    ].join('\n\n');
    const card = {
      id, title, description, followUpOf: cardId,
      assignee: godId,
      project: task.project,
      status: 'todo',
      dependsOn: [],
      priority: DEFAULT_PRIORITY,
      createdAt: new Date().toISOString()
    } as HiveTask;
    if (!this.addTask(card)) return { ok: false, error: `could not add card ${id} to tasks.json` };
    this.appendCardNote(cardId, `The human filed follow-up ${id} from result ${result.at}`);
    this.send({ to: godId, act: 'inform', subject: `Follow-up filed as ${id}: ${title}`, body: `The human filed ${id} from a result on ${cardId}. It is yours for now: set its assignee and priority, then route it.\n\n${description}` }, 'human');
    this.appendLog({ kind: 'result-follow-up', id, from: cardId });
    return { ok: true, cardId: id };
  }

  private mailBossAnswer(card: { id: string; title?: string; assignee?: string }, q: string, a: string, extra?: string): void {
    const body = humanAnswerBody(card, q, a);
    this.send({ to: 'god', act: 'inform', subject: `HUMAN ANSWER on task "${card.title ?? card.id}"`, body: extra ? `${body}\n${extra}` : body }, 'human');
  }

  private approvedMergeDeps: { scratchRoot?: string; cleanup?: () => boolean; rebaseTimeoutMs?: number } = {};
  /** `cleanup` turns on the post-merge worktree removal (config harnessMergeCleanup, on by default). */
  setApprovedMergeDeps(deps?: { scratchRoot?: string; cleanup?: () => boolean; rebaseTimeoutMs?: number }): void {
    this.approvedMergeDeps = deps ?? {};
  }

  /** Card id -> the timer that hands a held approved merge to the Boss when no done follows. */
  private readonly rebaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private armRebaseTimeout(cardId: string, requestedAt: string): void {
    this.clearRebaseTimeout(cardId);
    const wait = this.approvedMergeDeps.rebaseTimeoutMs ?? APPROVED_REBASE_TIMEOUT_MS;
    const since = Date.parse(requestedAt);
    const left = Number.isFinite(since) ? Math.max(0, since + wait - Date.now()) : wait;
    const timer = setTimeout(() => {
      this.rebaseTimers.delete(cardId);
      try { this.expireApprovedRebase(cardId, requestedAt, wait); } catch { /* keep the process alive */ }
    }, left);
    timer.unref?.();
    this.rebaseTimers.set(cardId, timer);
  }

  private clearRebaseTimeout(cardId: string): void {
    const timer = this.rebaseTimers.get(cardId);
    if (timer) clearTimeout(timer);
    this.rebaseTimers.delete(cardId);
  }

  /** Re-arms the rebase timeouts of held approved merges recorded in the ledger, from
   *  their request time, so an app restart does not leave one waiting forever. */
  resumeApprovedRebaseTimers(): void {
    for (const t of this.readLedger() ?? []) {
      const card = t as HiveTask;
      const held = card && typeof card === 'object' && card.status === 'blocked' ? card.approveAction?.pendingRebase : undefined;
      if (held) this.armRebaseTimeout(card.id, held.requestedAt ?? held.approvedAt);
    }
  }

  /** The wait for the worker's rebase done ran out: the Boss takes the merge over. A
   *  request made since (a later round) or a settled card leaves it alone. */
  private expireApprovedRebase(cardId: string, requestedAt: string, waitedMs: number): void {
    const card = (this.readLedger() ?? []).find((t) => !!t && typeof t === 'object' && (t as HiveTask).id === cardId) as HiveTask | undefined;
    const action = card?.approveAction;
    const held = action?.pendingRebase;
    if (!card || !action || !held || card.status !== 'blocked' || (held.requestedAt ?? held.approvedAt) !== requestedAt) return;
    this.settleApprovedMerge(card, action, held.answer, { kind: 'exception', reason: rebaseTimeoutReason(card.assignee ?? '', waitedMs) });
  }

  /** Writes the outcome of one approved-merge attempt to the card and mails whoever it
   *  concerns: the worker on a merge or a rebase request, the Boss on anything else. */
  private settleApprovedMerge(task: HiveTask, action: ApproveAction, answer: string, attempt: MergeAttempt): { assignee: string | null; boss: boolean } {
    const assignee = task.assignee ?? '';
    const q = action.q ?? '';
    const now = new Date().toISOString();
    const ledger = this.ledgerBatch?.tasks ?? this.readLedger() ?? [];
    const plan = (body: Record<string, unknown>): Partial<Omit<HiveTask, 'id'>> | null => {
      const p = planTaskMessage({ act: 'task-patch', sender: 'harness', isBoss: true, tasks: ledger, now, body: { id: task.id, ...body } });
      return p.ok && p.kind === 'patch' ? (p.patch as Partial<Omit<HiveTask, 'id'>>) : null;
    };
    this.clearRebaseTimeout(task.id);
    const exception = (reason: string): { assignee: string | null; boss: boolean } => {
      this.appendLog({ kind: 'approved-merge-exception', id: task.id, branch: action.branch, target: action.target, reason });
      const p = plan({ notesAppend: `The human approved; harness did not merge: ${reason}` });
      if (p) this.patchTask(task.id, { ...p, approveAction: undefined });
      this.mailBossAnswer(task, q, answer, bossExceptionNote(action, reason));
      return { assignee: null, boss: true };
    };

    if (attempt.kind === 'exception') return exception(attempt.reason);
    if (attempt.kind === 'needs-rebase') {
      const attempts = (action.pendingRebase?.attempts ?? 0) + 1;
      if (attempts > MAX_REBASE_ROUNDS) return exception(`${action.branch} still does not fast-forward onto ${action.target} after ${MAX_REBASE_ROUNDS} rebase request(s)`);
      const pendingRebase = { approvedAt: action.pendingRebase?.approvedAt ?? now, requestedAt: now, answer, approvedHead: action.pendingRebase?.approvedHead ?? attempt.approvedHead, patchIds: attempt.patchIds, attempts };
      const p = plan({ notesAppend: `The human approved; ${action.target} moved, so the harness asked ${assignee} to rebase and will retry the merge on their done` });
      if (!p || !this.patchTask(task.id, { ...p, approveAction: { ...action, pendingRebase } })) return exception('the ledger refused the rebase bookkeeping');
      this.armRebaseTimeout(task.id, now);
      this.appendLog({ kind: 'approved-merge-rebase', id: task.id, branch: action.branch, target: action.target, attempts });
      this.send({ to: assignee, act: 'request', subject: `Rebase ${action.branch} onto ${action.target} for ${task.id}; the harness merges on your done`, body: rebaseRequestBody(task, action) }, 'harness');
      return { assignee, boss: false };
    }

    const sha = attempt.head.slice(0, 8);
    const verb = attempt.kind === 'merged' ? `fast-forwarded ${action.target} to ${sha}` : `found ${action.branch} already in ${action.target} (${sha})`;
    const result = `The human approved ("${answer}"); harness ${verb} from ${action.branch}. Nothing pushed.`;
    const p = plan({ status: 'done', result, notesAppend: result });
    if (!p || !this.patchTask(task.id, { ...p, approveAction: undefined })) {
      this.appendLog({ kind: 'approved-merge-exception', id: task.id, branch: action.branch, target: action.target, reason: 'merged, but the ledger refused to close the card' });
      this.mailBossAnswer(task, q, answer, `The harness ${verb} on the human's approve, but the ledger refused to close the card; close it yourself.`);
      return { assignee: null, boss: true };
    }
    this.appendLog({ kind: 'approved-merge', id: task.id, branch: action.branch, target: action.target, head: attempt.head, mode: attempt.kind });
    const cleanup = this.postMergeCloseout({
      repo: action.repo, worktree: action.worktree, branch: action.branch, target: action.target,
      head: attempt.kind === 'merged' ? attempt.head : attempt.tip, workerId: assignee
    }, 'approved-merge-cleanup', task.id);
    this.send({ to: assignee, act: 'inform', subject: `MERGED ${task.id}: ${action.branch} into ${action.target} (${sha})`, body: mergedWorkerBody(task, action, answer, attempt.head, cleanup) }, 'harness');
    return { assignee, boss: false };
  }

  /** The shared post-merge closeout with this floor's flag, ledger and agents; the outcome
   *  (removed, refused or switched off) is always logged under `kind`. */
  private postMergeCloseout(o: { repo: string; worktree: string; branch: string; target: string; head: string; workerId: string }, kind: string, id: string | null): CleanupResult {
    const ledger = this.ledgerBatch?.tasks ?? (this.tasks() as { tasks?: unknown[] })?.tasks ?? [];
    const agents = Object.entries(this.registry().agents ?? {}).map(([aid, a]) => ({ id: aid, cwd: a.cwd }));
    const cleanup = cleanupMergedWorktree({
      ...o, enabled: this.approvedMergeDeps.cleanup?.() === true,
      scratchRoot: this.approvedMergeDeps.scratchRoot ?? hiveScratchRoot(), tasks: ledger, agents
    });
    this.appendLog({ kind, id, worktree: o.worktree, removed: cleanup.removed, reason: cleanup.reason });
    return cleanup;
  }

  /** A worker's done after the harness asked it to rebase an approved branch: retry the
   *  held merge for the card the done names (or the worker's only held card). */
  private retryApprovedMergeOnDone(sender: string, msg: HiveMessage): void {
    const reg = this.registry();
    if (sender === reg.godId || reg.agents[sender]?.isGod) return;
    if (!this.ledgerBatch) {
      const ledger = this.readLedger();
      if (ledger) this.ledgerBatch = { tasks: ledger, dirty: false };
    }
    const held = (this.ledgerBatch?.tasks ?? []).filter((t): t is HiveTask =>
      !!t && typeof t === 'object' && (t as HiveTask).assignee === sender && (t as HiveTask).status === 'blocked' && !!(t as HiveTask).approveAction?.pendingRebase);
    if (!held.length) return;
    const text = `${msg.subject ?? ''}\n${msg.body ?? ''}`;
    const named = held.filter((t) => mentionsCardId(text, t.id));
    const card = named.length === 1 ? named[0] : held.length === 1 ? held[0] : undefined;
    const action = card?.approveAction;
    if (!card || !action?.pendingRebase) return;
    this.settleApprovedMerge(card, action, action.pendingRebase.answer, attemptApprovedMerge(action, action.pendingRebase.patchIds));
  }

  /** File the inbox mail `sender` just answered into inbox/.done. */
  private fileRepliedInbox(sender: string, partial: Partial<HiveMessage>, to: string, atMs: number): void {
    const godId = this.registry().godId ?? 'god';
    const target = to === 'god' || to === 'boss' || to === 'human' ? godId : to;
    const moved = fileHandledInbox(this.agentDir(sender), { in_reply_to: partial.in_reply_to, conversation: partial.conversation, to: target, atMs });
    if (moved.length) this.appendLog({ kind: 'inbox-auto-filed', agentId: sender, files: moved });
  }

  /** A worker's done message to the Boss parks its card blocked "awaiting boss merge"
   *  through the same task-patch path the worker would have used. */
  private autoBlockOnDone(sender: string, msg: HiveMessage): void {
    const reg = this.registry();
    if (sender === reg.godId || reg.agents[sender]?.isGod) return;
    if (!this.ledgerBatch) {
      const ledger = this.readLedger();
      if (ledger) this.ledgerBatch = { tasks: ledger, dirty: false };
    }
    const tasks = this.ledgerBatch?.tasks ?? [];
    const godId = reg.godId ?? 'god';
    const body = doneAutoBlockPatch(sender, msg, tasks, (to) => to === 'god' || to === 'boss' || to === 'human' || to === godId);
    if (!body) return;
    this.appendLog({ kind: 'done-auto-block', from: sender, id: body.id });
    this.applyTaskMessage(sender, 'task-patch', body);
  }

  /** A worker's done message naming a branch head in a merge repo (projects.json) is
   *  fast-forward merged into its integration branch if all gates hold, or declined and
   *  mailed back to the worker to rebuild on top of that branch. */
  private autoFfMergeOnDone(sender: string, msg: HiveMessage, tasksOverride?: readonly unknown[], closing = false): void {
    const reg = this.registry();
    if (sender === reg.godId || reg.agents[sender]?.isGod) return;
    const godId = reg.godId ?? 'god';
    const isBossTarget = msg.to === 'god' || msg.to === 'boss' || msg.to === 'human' || msg.to === godId;
    if (!isBossTarget || msg.act !== 'done') return;

    if (!tasksOverride && !this.ledgerBatch) {
      const ledger = this.readLedger();
      if (ledger) this.ledgerBatch = { tasks: ledger, dirty: false };
    }
    const tasks = tasksOverride ?? this.ledgerBatch?.tasks ?? [];

    const roster = Object.entries(this.registry().agents).map(([id, a]) => ({ id, name: a.name }));
    const result = handleHarnessFfMerge(sender, msg, tasks, this.ffMergeDeps ?? { repos: loadMergeRepos(this.root()) }, roster, closing);
    if (!result) return;

    if (result.ok) {
      this.appendLog({
        kind: 'auto-merge',
        ok: true,
        from: sender,
        repo: result.repo,
        branch: result.branch,
        head: result.head,
        target: result.target,
        id: result.cardId ?? null
      });
      if (result.cardId) this.markCardMerged(result.cardId, result.head, result.target);
      if (result.worktree) {
        const cleanup = this.postMergeCloseout({ repo: result.repo, worktree: result.worktree, branch: result.branch, target: result.target, head: result.head, workerId: sender }, 'auto-merge-closeout', result.cardId ?? null);
        if (!cleanup.disabled) {
          this.send({
            to: sender,
            act: 'inform',
            subject: `AUTO-MERGED ${result.branch} into ${result.target}${result.cardId ? ` for ${result.cardId}` : ''}: worktree ${cleanup.removed ? 'removed' : 'kept'}`,
            body: cleanup.removed
              ? `The harness fast-forwarded ${result.target} to ${result.head.slice(0, 8)} and removed your worktree ${result.worktree} (${cleanup.reason}); the branch ref is kept.`
              : `The harness fast-forwarded ${result.target} to ${result.head.slice(0, 8)} and kept your worktree ${result.worktree}: ${cleanup.reason}.`
          }, 'harness');
        }
      }
    } else if ('refused' in result) {
      this.appendLog({
        kind: 'auto-merge-refuse',
        ok: false,
        from: sender,
        repo: result.repo,
        branch: result.branch,
        target: result.target,
        reason: result.reason,
        id: result.cardId ?? null
      });
      this.send({
        to: godId,
        act: 'inform',
        subject: `AUTO-MERGE REFUSED ${result.branch}${result.cardId ? ` for ${result.cardId}` : ''}: ${result.target} not advanced`,
        body: `${sender}'s done picked ${result.branch}, but ${result.reason}. Merge the worker's branch by hand, or ask ${sender} to name it in a fresh done.`
      }, 'harness');
    } else if ('skipped' in result) {
      this.appendLog({
        kind: 'auto-merge-skip',
        ok: false,
        from: sender,
        repo: result.repo,
        branch: result.branch,
        target: result.target,
        reason: result.reason,
        id: result.cardId ?? null
      });
      if ('reviewGate' in result && result.reviewGate) {
        this.send({
          to: godId,
          act: 'inform',
          subject: `AUTO-MERGE HELD ${result.branch}${result.cardId ? ` for ${result.cardId}` : ''}: review pending`,
          body: `${sender}'s done on ${result.branch} was not merged into ${result.target}: ${result.reason}. Merge it after the review (ask_human on_approve or a Boss merge).`
        }, 'harness');
      } else if (closing && !('alreadyMerged' in result && result.alreadyMerged)) {
        this.send({
          to: godId,
          act: 'inform',
          subject: `AUTO-MERGE AT CLOSE skipped ${result.branch}${result.cardId ? ` for ${result.cardId}` : ''}: ${result.target} not advanced`,
          body: `Closing ${result.cardId ?? 'the card'} did not merge ${result.branch} into ${result.target}: ${result.reason}. The card is done with that work unmerged: merge it by hand, or reopen the card.`
        }, 'harness');
      }
    } else {
      this.appendLog({
        kind: 'auto-merge-decline',
        ok: false,
        from: sender,
        repo: result.repo,
        branch: result.branch,
        target: result.target,
        reason: result.reason,
        id: result.cardId ?? null
      });
      // A closed card has no worker turn left to rebuild in; whoever closed it merges it.
      if (closing) {
        this.send({
          to: godId,
          act: 'inform',
          subject: `AUTO-MERGE AT CLOSE declined ${result.branch}${result.cardId ? ` for ${result.cardId}` : ''}: ${result.target} not advanced`,
          body: `Closing ${result.cardId ?? 'the card'} re-ran the merge gates on ${result.branch}, which could not be fast-forward merged into ${result.target}: ${result.reason}. Merge it by hand; ${sender} was not mailed.`
        }, 'harness');
        return;
      }
      this.send({
        to: sender,
        act: 'request',
        subject: `Rebuild on top of ${result.target} and report again${result.cardId ? ` for ${result.cardId}` : ''}`,
        body: `Branch ${result.branch} could not be fast-forward merged into ${result.target}: ${result.reason}. Please rebuild on top of ${result.target} and report again.`
      }, 'harness');
    }
  }

  /** Rewrites a card's "awaiting boss merge" note to "merged <sha> into <target>" once the
   *  harness has fast-forwarded its branch, so the card stops counting as merge backlog. */
  private markCardMerged(cardId: string, head: string, target: string): void {
    const card = ((this.tasks() as { tasks?: HiveTask[] }).tasks ?? []).find((t) => t?.id === cardId) as (HiveTask & { notes?: unknown }) | undefined;
    if (!card || card.status !== 'blocked') return;
    const prior = typeof card.notes === 'string' ? card.notes : Array.isArray(card.notes) ? (card.notes as string[]).join('\n') : '';
    if (!AWAITING_MERGE.test(prior)) return;
    const merged = `merged ${head.slice(0, 8)} into ${target}`;
    const notes = prior.split('\n').map((line) => (AWAITING_MERGE.test(line)
      ? line.replace(/awaiting\b.*?\bmerge(?:\s*\(auto: done message\))?/i, merged) : line)).join('\n');
    this.patchTask(cardId, { notes } as Partial<Omit<HiveTask, 'id'>>);
  }

  /** A task-patch or task-create from `sender`'s outbox. A refusal is logged and
   *  mailed back to the sender, since its edit did not land. */
  private applyTaskMessage(sender: string, act: TaskAct, body: unknown): void {
    const reg = this.registry();
    const isBoss = sender === reg.godId || !!reg.agents[sender]?.isGod;
    const closingTime = this.closingTimeSource?.() ?? false;
    const ledger = this.readLedger();
    let plan: TaskPlan = ledger
      ? planTaskMessage({ act, body, sender, isBoss, tasks: ledger, now: new Date().toISOString(), closingTime, artProjects: artPipelineProjects(this.root()) })
      : { ok: false, reason: 'tasks.json is unreadable right now; send the same message again in a minute' };
    if (plan.ok && plan.kind === 'patch' && !isBoss && ledger) {
      const gated = this.cardPatchGate?.(sender, plan.id, plan.patch, ledger);
      if (gated) plan = { ok: false, id: plan.id, reason: gated };
    }
    const before = plan.ok && plan.kind === 'patch' && ledger ? (ledger as HiveTask[]).find((t) => t?.id === plan.id) : undefined;
    if (plan.ok && plan.kind === 'patch' && before?.heldAnswer) {
      if (isBoss && plan.patch.status === 'todo') (plan.patch as Partial<HiveTask>).heldAnswer = undefined;
      else if (!isBoss && plan.patch.status !== undefined) plan = { ok: false, id: plan.id, reason: 'a human answer is held for this card; the Boss or the harness releases it' };
    }
    let applied = false;
    if (plan.ok) {
      applied = plan.kind === 'create'
        ? this.addTask(plan.card as unknown as HiveTask)
        : this.patchTask(plan.id, plan.patch as Partial<Omit<HiveTask, 'id'>>);
    }
    const reason = plan.ok ? (applied ? undefined : 'the ledger changed under the edit; send it again') : plan.reason;
    if (plan.ok && plan.kind === 'patch' && applied && before?.status === 'doing' && plan.patch.status && plan.patch.status !== 'doing' && before.assignee) {
      this.releaseHeldAnswer(before.assignee);
    }
    if (plan.ok && plan.kind === 'patch' && applied && plan.patch.testsReady) {
      try { this.testsReadyObserver?.(sender, plan.id, plan.patch.testsReady as NonNullable<HiveTask['testsReady']>); } catch (e) { console.error('[checkpoint] observer failed:', e); }
    }
    if (isBoss && plan.ok && plan.kind === 'patch' && applied && before?.status !== 'done' && plan.patch.status === 'done' && plan.patch.merge !== false && before?.merge !== false && before?.assignee) {
      const mergedCard = { ...before, ...(plan.patch as Partial<HiveTask>), status: 'blocked' as const };
      const notes = (mergedCard as { notes?: unknown }).notes;
      const bodyText = [mergedCard.brief, notes, mergedCard.result].filter((v): v is string => typeof v === 'string' && v.trim().length > 0).join('\n');
      this.autoFfMergeOnDone(before.assignee, this.normalize({
        to: 'boss',
        act: 'done',
        subject: `${plan.id} closed by Boss`,
        body: bodyText
      }, before.assignee), [mergedCard], true);
    }
    this.appendLog({
      kind: 'task-patch', act, from: sender, id: plan.id ?? null, ok: !reason,
      ...(plan.ok ? { fields: plan.fields } : {}), ...(reason ? { reason } : {}), ...(closingTime ? { closingTime } : {})
    });
    if (reason && closingTime && reason.startsWith('wrap-up')) console.log(`[closing-time] refused ${act} from ${sender}${plan.id ? ` for ${plan.id}` : ''}: ${reason}`);
    if (!reason) return;
    this.deliver(this.normalize({
      to: sender,
      act: 'inform',
      subject: `${act} refused${plan.id ? ` for ${plan.id}` : ''}: ${reason}`,
      body: typeof body === 'string' ? body : JSON.stringify(body ?? null),
      requires_reply: false
    }, 'harness'), sender);
  }

  /** Build the current per-agent balancer state map from RosterStore + registry.json
   *  (merged with any custom adapter supplied by main). */
  private currentAgentBalancerStates(): Record<string, AgentBalancerState> {
    const reg = this.registry();
    const out: Record<string, AgentBalancerState> = {};
    const placementFor = (id: string, isGod: boolean): AgentPlacement => {
      const ws = this.workspaceOf(id);
      const sb = this.codexSandboxOf(id);
      return {
        unity: ws?.unity === true,
        network: ws?.network === true,
        extraDirs: ws?.extraDirs.length ?? 0,
        codexSandbox: sb.stored ? sb.level : undefined,
        isGod
      };
    };
    const roster = new RosterStore(() => this.getHome()).read();
    const hasRosterFile = roster !== null;
    for (const list of [roster?.agents ?? [], roster?.restorable ?? []]) {
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const a = raw as {
          id?: unknown;
          provider?: unknown;
          command?: unknown;
          model?: unknown;
          tier?: unknown;
          isGod?: unknown;
          isAssistant?: unknown;
        };
        if (typeof a.id !== 'string' || !a.id || out[a.id]) continue;
        const regEntry = reg.agents[a.id];
        const provider = inferAgentProvider(
          typeof a.command === 'string' ? a.command : undefined,
          typeof a.provider === 'string' ? (a.provider as AgentProvider) : undefined
        );
        const model =
          typeof a.model === 'string' && a.model.trim()
            ? a.model.trim()
            : undefined;
        const isGod = a.isGod === true || reg.godId === a.id || regEntry?.isGod === true;
        out[a.id] = {
          id: a.id,
          provider,
          ...(model ? { model } : {}),
          ...(isTier(a.tier) ? { tier: a.tier } : {}),
          isGod,
          isAssistant: a.isAssistant === true || regEntry?.isAssistant === true,
          archived: regEntry?.archived === true,
          onRoster: true,
          placement: placementFor(a.id, isGod)
        };
      }
    }
    for (const [id, a] of Object.entries(reg.agents)) {
      if (out[id]) continue;
      const provider = a.provider ?? 'claude';
      const isGod = a.isGod === true || reg.godId === id;
      out[id] = {
        id,
        provider,
        isGod,
        isAssistant: a.isAssistant === true,
        archived: a.archived === true,
        onRoster: isGod || (!hasRosterFile && !a.archived && !a.isAssistant),
        placement: placementFor(id, isGod)
      };
    }
    if (this.agentBalancerAdapter?.readAgents) {
      for (const [id, st] of Object.entries(this.agentBalancerAdapter.readAgents())) {
        const prev = out[id];
        const isGod = st.isGod ?? prev?.isGod ?? (reg.godId === id || reg.agents[id]?.isGod === true);
        out[id] = {
          ...prev,
          ...st,
          id,
          isGod,
          onRoster: st.onRoster ?? prev?.onRoster ?? true,
          placement: st.placement ?? prev?.placement ?? placementFor(id, isGod)
        };
      }
    }
    return out;
  }

  /** An `archive-agent` message from `sender`'s outbox: re-checked against the registry and
   *  ledger (and main's live-session guard), then archived; the outcome is mailed to `sender`. */
  private applyArchiveAgentMessage(sender: string, body: unknown): void {
    const reg = this.registry();
    const tasks = (this.ledgerBatch?.tasks ?? this.readLedger() ?? []) as Array<Record<string, unknown>>;
    const check = validateArchiveRequest(sender, body, {
      godId: reg.godId ?? null,
      known: (id) => Object.prototype.hasOwnProperty.call(reg.agents, id),
      isGod: (id) => reg.agents[id]?.isGod === true,
      isArchived: (id) => reg.agents[id]?.archived === true,
      openCards: (id) => openCardsFor(id, tasks)
    });
    const tell = (subject: string, text: string): void => {
      try {
        this.deliver(this.normalize({ to: sender, act: 'inform', subject, body: text, requires_reply: false }, 'harness'), sender);
      } catch { /* sender folder gone */ }
    };
    const veto = check.ok ? this.archiveAgentGuard?.(check.request.agentId) ?? null : null;
    if (!check.ok || veto) {
      const error = check.ok ? `${check.request.agentId}: ${veto}` : check.error;
      this.appendLog({ kind: ARCHIVE_AGENT_ACT, from: sender, ok: false, reason: error });
      tell(`${ARCHIVE_AGENT_ACT} refused: ${error}`, typeof body === 'string' ? body : JSON.stringify(body ?? null));
      return;
    }
    const { agentId, reason } = check.request;
    this.setArchived(agentId, true);
    this.appendLog({ kind: ARCHIVE_AGENT_ACT, from: sender, agentId, ok: true, ...(reason ? { reason } : {}) });
    try { this.emit?.('hive:agentArchived', { id: agentId }); } catch { /* window torn down */ }
    tell(`${ARCHIVE_AGENT_ACT}: ${agentId} archived`, 'Kept on disk and in the registry; the human can reopen it from the Archived list.');
  }

  private applyRestartCampMessage(sender: string, body: unknown): void {
    const check = validateCampRestart(sender, this.registry().godId, body);
    const report = (result: RestartResult): void => {
      this.appendLog({ kind: RESTART_CAMP_ACT, from: sender, ...result });
      if (!result.ok) this.send({ to: sender, act: 'inform', subject: 'Camp restart refused', body: result.error }, 'harness');
    };
    if (!check.ok) { report(check); return; }
    try {
      const result = this.restartCampHook?.(sender, check.request) ?? { ok: false as const, error: 'Camp restart is unavailable.' };
      if (result instanceof Promise) void result.then(report, (error) => report({ ok: false, error: String(error) }));
      else report(result);
    } catch (error) { report({ ok: false, error: String(error) }); }
  }

  /** The sender is the owning outbox folder. Main restarts the agent after Boss authorization. */
  private applyRestartAgentMessage(sender: string, body: unknown): void {
    const reg = this.registry();
    const check = validateRestartRequest(sender, body, {
      godId: reg.godId ?? null,
      known: (id) => Object.prototype.hasOwnProperty.call(reg.agents, id),
      isGod: (id) => reg.agents[id]?.isGod === true
    });
    const tell = (subject: string, text: string): void => {
      try {
        this.deliver(this.normalize({ to: sender, act: 'inform', subject, body: text, requires_reply: false }, 'harness'), sender);
      } catch { /* sender folder gone */ }
    };
    if (!check.ok) {
      this.appendLog({ kind: RESTART_AGENT_ACT, from: sender, ok: false, reason: check.error });
      tell(`${RESTART_AGENT_ACT} refused: ${check.error}`, typeof body === 'string' ? body : JSON.stringify(body ?? null));
      return;
    }
    const { agentId } = check.request;
    const hook = this.restartAgentHook;
    if (!hook) {
      tell(`${RESTART_AGENT_ACT} refused for ${agentId}: the app cannot restart sessions right now`, JSON.stringify(check.request));
      return;
    }
    void (async () => {
      let res: { ok: boolean; error?: string; warnings?: string[] };
      try { res = await hook(sender, check.request as unknown as Record<string, unknown>); } catch (e) { res = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      if (!res.ok) this.appendLog({ kind: RESTART_AGENT_ACT, from: sender, agentId, ok: false, reason: res.error });
      tell(
        res.ok ? `${RESTART_AGENT_ACT}: ${agentId} restarted` : `${RESTART_AGENT_ACT} refused for ${agentId}: ${res.error ?? 'failed'}`,
        res.ok ? `Fresh session started on its card.${res.warnings?.length ? ` Warnings: ${res.warnings.join('; ')}` : ''}` : (res.error ?? 'failed')
      );
    })();
  }

  /** An `agent-config` message from `sender`'s outbox. Boss-only: updates one or more
   *  agents' balancer ladders (and/or primary provider/model) on the same store the UI
   *  uses, refreshes fleet.json immediately, and mails a refusal with the reason back
   *  to `sender` on any bad input or non-Boss sender. */
  private applyAgentConfigMessage(sender: string, body: unknown): void {
    const root = this.root();
    const reg = this.registry();
    const isBoss = sender === reg.godId || !!reg.agents[sender]?.isGod;
    const closingTime = this.closingTimeSource?.() ?? false;
    const agents = this.currentAgentBalancerStates();
    const tiers = this.modelTiersSource?.();
    const plan = planAgentConfigMessage({ body, sender, isBoss, godId: reg.godId, agents, closingTime, ...(tiers ? { tiers } : {}) });
    let reason = plan.ok ? undefined : plan.reason;

    if (plan.ok) {
      if (this.agentBalancerAdapter) {
        const res = this.agentBalancerAdapter.apply(plan.patches);
        if (!res.ok) reason = res.reason ?? 'could not persist balancer update';
      } else {
        new RosterStore(() => this.getHome()).patchAgents(
          plan.patches.map((p) => ({
            id: p.id,
            patch: {
              ...(p.tier ? { tier: p.tier } : {}),
              ...(p.engineChanged ? { provider: p.provider, model: p.model, command: p.command } : {})
            }
          }))
        );
      }
    }

    if (plan.ok && !reason && root) {
      // Keep registry.json provider in step when the base engine changed.
      let regDirty = false;
      for (const p of plan.patches) {
        const entry = reg.agents[p.id];
        if (entry && p.engineChanged && entry.provider !== p.provider) {
          entry.provider = p.provider;
          regDirty = true;
        }
      }
      if (regDirty) this.atomicWriteJson(join(root, 'registry.json'), reg);

      // Patch fleet.json immediately so Boss reads the new ladder without waiting for the 8s tick.
      const fleetPath = join(root, 'fleet.json');
      if (this.snapshots.latest(fleetPath) !== undefined || existsSync(fleetPath)) {
        try {
          const fleet = this.readFleet<{
            agents?: Array<{ id?: string; model?: string; ladder?: AgentModelEntry[]; tier?: string }>;
          }>(root);
          if (Array.isArray(fleet.agents)) {
            const byId = new Map(plan.patches.map((p) => [p.id, p]));
            let changed = false;
            for (const row of fleet.agents) {
              const p = row.id ? byId.get(row.id) : undefined;
              if (!p) continue;
              row.ladder = p.effectiveLadder;
              if (p.tier) row.tier = p.tier;
              if (p.engineChanged) row.model = entryLabel({ provider: p.provider, model: p.model });
              changed = true;
            }
            if (changed) this.writeFleetSnapshot(fleet);
          }
        } catch { /* fleet.json is a best-effort cache */ }
      }

      this.emit?.('hive:agentConfigChanged', { patches: plan.patches });
    }

    const targetIds = plan.ok ? plan.patches.map((p) => p.id) : (plan.id ? [plan.id] : []);
    this.appendLog({
      kind: AGENT_CONFIG_ACT,
      from: sender,
      id: targetIds.length === 1 ? targetIds[0] : null,
      ...(targetIds.length > 1 ? { ids: targetIds } : {}),
      ok: !reason,
      ...(plan.ok && !reason
        ? {
            patches: plan.patches.map((p) => ({
              id: p.id,
              provider: p.provider,
              model: p.model,
              ...(p.tier ? { tier: p.tier } : {}),
              ladder: p.effectiveLadder
            }))
          }
        : {}),
      ...(reason ? { reason } : {}),
      ...(closingTime ? { closingTime } : {})
    });

    if (!reason) return;
    const refusedFor = targetIds.length ? ` for ${targetIds.join(', ')}` : '';
    this.deliver(this.normalize({
      to: sender,
      act: 'inform',
      subject: `${AGENT_CONFIG_ACT} refused${refusedFor}: ${reason}`,
      body: typeof body === 'string' ? body : JSON.stringify(body ?? null),
      requires_reply: false
    }, 'harness'), sender);
  }

  /** The ledger's cards, or null when tasks.json exists but does not parse: a write
   *  merged against that would replace every card with the few being written. */
  private readLedger(): unknown[] | null {
    if (this.ledgerBatch) return this.ledgerBatch.tasks;
    const root = this.root();
    if (!root) return null;
    const path = join(root, 'tasks.json');
    if (!existsSync(path)) return [];
    try {
      const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return tasksOf(v);
    } catch { return null; }
  }

  /** Append one card against the latest on-disk ledger. Renderer callers must
   *  use this instead of re-writing a collection they read before another
   *  source (webhook, Slack, god, voice) added work. Idempotent by task id. */
  addTask(task: HiveTask): boolean {
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    if (tasks.some((current) => current?.id === task.id)) return false;
    return this.writeTasks([...tasks, task]);
  }

  /** Patch one card against the latest on-disk ledger, preserving unrelated
   *  cards and fields (notably webhook.tokenHash and Slack thread metadata). */
  patchTask(id: string, patch: Partial<Omit<HiveTask, 'id'>>): boolean {
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const index = tasks.findIndex((task) => task?.id === id);
    if (index < 0) return false;
    const oldStatus = tasks[index]?.status;
    const next = tasks.slice();
    next[index] = { ...tasks[index], ...patch, id };
    const ok = this.writeTasks(next);
    if (ok && oldStatus !== 'done' && patch.status === 'done') {
      this.autoUnblockDependents();
    }
    if (ok && patch.humanQA && tasks[index]?.status !== 'done') this.mailDismissedAsks(tasks[index], next[index]);
    return ok;
  }

  /** One timestamped line appended to a card's notes. Throws when the card is missing or the ledger cannot be written. */
  appendCardNote(id: string, note: string): void {
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const card = (Array.isArray(ledger?.tasks) ? ledger.tasks : []).find((t) => t?.id === id) as (HiveTask & { notes?: string | string[] }) | undefined;
    if (!card) throw new Error(`no card ${id}`);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const prior = typeof card.notes === 'string' ? card.notes : Array.isArray(card.notes) ? (card.notes as string[]).join('\n') : '';
    if (!this.patchTask(id, { notes: `${prior ? `${prior}\n` : ''}${stamp} ${note}` } as Partial<Omit<HiveTask, 'id'>>)) throw new Error(`card ${id} not written`);
  }

  /** Closing time parks a worker that cannot answer: its open cards go blocked with
   *  parkedFrom, so a cancel puts them back. Returns the parked card ids. */
  parkAgentCards(agentId: string, note: string): string[] {
    const ledger = (this.ledgerBatch?.tasks ?? this.readLedger()) as HiveTask[] | null;
    if (!ledger) return [];
    const nowIso = new Date().toISOString();
    const stamp = nowIso.slice(0, 16).replace('T', ' ');
    const parked: string[] = [];
    const next = ledger.map((t) => {
      if (!t || t.assignee !== agentId || (t.status !== 'doing' && t.status !== 'todo') || isBacklogged(t)) return t;
      parked.push(t.id);
      const raw = (t as HiveTask & { notes?: string | string[] }).notes;
      const prior = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join('\n') : '';
      return { ...t, status: 'blocked', parkedFrom: t.status, parkedAt: nowIso, notes: `${prior ? `${prior}\n` : ''}${stamp} ${note}` } as HiveTask;
    });
    if (!parked.length || !this.writeTasks(next)) return [];
    this.appendLog({ kind: 'closing-park', agentId, cards: parked });
    return parked;
  }

  /** Put the cards closing time parked back to todo; returns the restored ids. */
  unparkClosingTimeCards(): string[] {
    const ledger = this.readLedger();
    if (!ledger) return [];
    const plan = unparkPlan(ledger);
    if (!plan.length) return [];
    const byId = new Map(plan.map((p) => [p.id, p.patch]));
    const next = (ledger as HiveTask[]).map((t) => (byId.has(t?.id) ? { ...t, ...byId.get(t.id) } as HiveTask : t));
    if (!this.writeTasks(next)) return [];
    const restored = plan.filter((p) => p.restored).map((p) => p.id);
    this.appendLog({ kind: 'unpark', restored, kept: plan.filter((p) => !p.restored).map((p) => p.id) });
    return restored;
  }

  /** Blocked cards whose dependsOn dependencies are all done and which are not held
   *  by humanQA, awaiting merge, or a the human ask are automatically moved to todo.
   *  Returns the ids of unblocked cards. */
  autoUnblockDependents(): string[] {
    const ledger = (this.ledgerBatch ? this.ledgerBatch.tasks : this.readLedger()) as HiveTask[] | null;
    if (!ledger) return [];
    const plan = planAutoUnblock(ledger);
    if (!plan.length) return [];
    const byId = new Map(plan.map((p) => [p.id, p.patch]));
    const next = ledger.map((t) => (byId.has(t?.id) ? { ...t, ...byId.get(t.id) } as HiveTask : t));
    if (!this.writeTasks(next)) return [];
    for (const item of plan) {
      this.appendLog({
        kind: 'auto-unblock',
        id: item.id,
        assignee: item.assignee ?? null,
        dependsOn: item.dependsOn
      });
    }
    return plan.map((p) => p.id);
  }

  /** One-time cleanup for cards that piled up open asks before writeTasks retired
   *  them: copies tasks.json aside first, then rewrites it. Writes nothing (and no
   *  backup) when every card already has at most one open ask. */
  retireSupersededAsks(): { retired: { id: string; count: number }[]; backup?: string } {
    const root = this.root();
    const ledger = this.readLedger() as HiveTask[] | null;
    if (!root || !ledger) return { retired: [] };
    const now = new Date().toISOString();
    const retired = ledger
      .map((t) => ({ id: String(t?.id ?? ''), count: retireSupersededAsks(t, now).retired }))
      .filter((r) => r.count > 0);
    if (!retired.length) return { retired };
    const backup = join(root, `tasks.json.bak-supersede-${now.replace(/[:.]/g, '-')}`);
    copyFileSync(join(root, 'tasks.json'), backup);
    if (!this.writeTasks(ledger)) return { retired: [], backup };
    this.appendLog({ kind: 'retire-superseded-asks', retired, backup });
    return { retired, backup };
  }

  /** Stamps seenAt on every result the human has not seen yet; returns how many. */
  markResultsSeen(now: string = new Date().toISOString()): number {
    const ledger = this.readLedger() as HiveTask[] | null;
    if (!ledger) return 0;
    let count = 0;
    const next = ledger.map((t) => {
      const results = t.results;
      if (!Array.isArray(results) || !results.some((r) => isCardResult(r) && !r.seenAt)) return t;
      return { ...t, results: results.map((r) => (isCardResult(r) && !r.seenAt ? (count++, { ...r, seenAt: now }) : r)) };
    });
    if (!count) return 0;
    return this.writeTasks(next) ? count : 0;
  }

  /** One-time move of notices out of ASK ME. The boss names them in
   *  results-migration.json {"cards":[{"id","label":"answer|check"}]}; each listed
   *  card's open ask becomes a result. Nothing is guessed from wording. Backs up
   *  tasks.json first and consumes the list so it cannot move a later decision. */
  moveNoticesToResults(): { moved: string[]; skipped: string[]; backup?: string; error?: string } {
    const root = this.root();
    const listPath = root ? join(root, RESULTS_MIGRATION_FILE) : '';
    if (!root || !existsSync(listPath)) return { moved: [], skipped: [] };
    let entries: { id: string; label: ResultLabel }[];
    try {
      const raw = JSON.parse(readFileSync(listPath, 'utf8')) as { cards?: unknown };
      if (!Array.isArray(raw.cards)) return { moved: [], skipped: [], error: `${RESULTS_MIGRATION_FILE} must be {"cards":[{"id","label"}]}` };
      const bad = raw.cards.find((c) => !c || typeof (c as { id?: unknown }).id !== 'string' || !isResultLabel((c as { label?: unknown }).label));
      if (bad !== undefined) return { moved: [], skipped: [], error: `every ${RESULTS_MIGRATION_FILE} entry needs an id and a label (${RESULT_LABELS.join(' or ')}): ${JSON.stringify(bad)}` };
      entries = raw.cards as { id: string; label: ResultLabel }[];
    } catch (e) {
      return { moved: [], skipped: [], error: `${RESULTS_MIGRATION_FILE} unreadable: ${e instanceof Error ? e.message : String(e)}` };
    }
    const ledger = this.readLedger() as HiveTask[] | null;
    if (!ledger) return { moved: [], skipped: entries.map((e) => e.id), error: 'tasks.json unreadable' };
    const now = new Date().toISOString();
    const labels = new Map(entries.map((e) => [e.id, e.label]));
    const moved: string[] = [];
    const next = ledger.map((t): HiveTask => {
      const label = labels.get(String(t?.id ?? ''));
      const qa = Array.isArray(t?.humanQA) ? t.humanQA : [];
      const open = label ? qa.filter((e) => e && typeof e.q === 'string' && !e.a && !e.dismissedAt) : [];
      if (!label || !open.length) return t;
      moved.push(String(t.id));
      const prior = Array.isArray(t.results) ? t.results : [];
      const added: CardResult[] = open.map((e) => ({ text: e.q, label, at: typeof e.askedAt === 'string' ? e.askedAt : now }));
      return {
        ...t,
        humanQA: qa.map((e) => (open.includes(e) ? { ...e, dismissedAt: now, movedToResultsAt: now } : e)),
        results: [...prior, ...added]
      };
    });
    const order = entries.map((e) => e.id);
    moved.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const skipped = order.filter((id) => !moved.includes(id));
    let backup: string | undefined;
    if (moved.length) {
      backup = join(root, `tasks.json.bak-results-${now.replace(/[:.]/g, '-')}`);
      copyFileSync(join(root, 'tasks.json'), backup);
      if (!this.writeTasks(next)) return { moved: [], skipped: order, backup, error: 'tasks.json write failed' };
    }
    renameSync(listPath, join(root, `${RESULTS_MIGRATION_FILE}.done-${now.replace(/[:.]/g, '-')}`));
    this.appendLog({ kind: 'move-notices-to-results', moved, skipped, backup: backup ?? null });
    return { moved, skipped, ...(backup ? { backup } : {}) };
  }

  /** Delete only the named card from the latest on-disk ledger. */
  deleteTask(id: string): boolean {
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const next = tasks.filter((task) => task?.id !== id);
    if (next.length === tasks.length) return false;
    return this.writeTasks(next);
  }
  memory(id: string): string {
    const p = join(this.agentDir(id), 'memory.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  /** Whether an agent has recorded NON-TRIVIAL memory — i.e. has appended real
   *  notes beyond the boilerplate header ensureAgent seeds. Lets the voice
   *  read-layer answer "what has the team remembered" and enumerate who has
   *  anything worth reading (every registered agent technically has a memory.md,
   *  but most of the floor's history lives in a handful of them). Cheap: reads a
   *  small markdown file; never throws. Works for ANY id, active OR archived. */
  hasMemory(id: string): boolean {
    const p = join(this.agentDir(id), 'memory.md');
    if (!existsSync(p)) return false;
    try {
      // A fresh seed is ~90 chars (one header line + the prompt). Anything
      // meaningfully longer means the agent appended durable facts.
      return readFileSync(p, 'utf8').trim().length > 200;
    } catch { return false; }
  }
  inbox(id: string): HiveMessage[] {
    this.expireAgentShutdownOrders(id);
    return this.listMessages(join(this.agentDir(id), 'inbox'));
  }

  /**
   * Auto-file stale unread wrap-up orders for an agent to inbox/.done/.
   * Emits an `inbox-auto-filed` log event if any files were moved.
   */
  expireAgentShutdownOrders(agentId: string, forceAll = false): string[] {
    const root = this.root();
    if (!root) return [];
    const inboxDir = join(root, 'agents', agentId, 'inbox');
    if (!existsSync(inboxDir)) return [];
    const doneDir = join(inboxDir, '.done');

    let files: string[];
    try {
      files = readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }

    const filed: string[] = [];
    const now = Date.now();
    const isClosing = this.isClosingActive();
    const sessionStart = this.getClosingSessionStartedAt();
    const sessionGen = this.getClosingGeneration();

    for (const f of files) {
      const p = join(inboxDir, f);
      let msg: HiveMessage | null = null;
      try {
        msg = JSON.parse(readFileSync(p, 'utf8')) as HiveMessage;
      } catch {
        continue;
      }
      if (!isShutdownOrder(msg)) continue;

      let isStale = forceAll;
      if (!isStale) {
        if (!isClosing) {
          isStale = true;
        } else {
          const created = typeof msg.created_at === 'string' ? Date.parse(msg.created_at) : NaN;
          if (isNaN(created) || (now - created) >= STALE_WRAPUP_MAX_AGE_MS) {
            isStale = true;
          } else if (msg.closingGeneration !== undefined && msg.closingGeneration !== null) {
            if (msg.closingGeneration !== sessionGen) isStale = true;
          } else if (sessionStart > 0 && created < sessionStart) {
            isStale = true;
          }
        }
      }

      if (isStale) {
        try {
          if (!existsSync(doneDir)) mkdirSync(doneDir, { recursive: true });
          renameSync(p, join(doneDir, f));
          filed.push(f);
        } catch (e) {
          console.warn(`[hive] failed to auto-file stale wrap-up ${f}:`, e);
        }
      }
    }

    if (filed.length > 0) {
      this.appendLog({ kind: 'inbox-auto-filed', agentId, files: filed });
    }

    return filed;
  }

  sweepAllInboxesStaleWrapup(): string[] {
    const root = this.root();
    if (!root) return [];
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return [];
    const filed: string[] = [];
    try {
      const agentIds = readdirSync(agentsDir).filter((id) => !id.startsWith('.') && existsSync(join(agentsDir, id, 'inbox')));
      for (const id of agentIds) {
        filed.push(...this.expireAgentShutdownOrders(id));
      }
    } catch (e) {
      console.warn('[hive] sweepAllInboxesStaleWrapup failed:', e);
    }
    return filed;
  }
  /** Read an agent's OUTBOX (messages it has authored/sent). Symmetric with
   *  inbox(); the router drains live outbox files into recipients' inboxes and
   *  archives the original under outbox/.sent, so a sent message survives there. */
  outbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), 'outbox'));
  }

  /**
   * Voice read-layer: recent message CONTENT (inbox + outbox bodies) for the
   * operator briefing, REDACTED main-side. This is the message-content half of
   * the voice query surface (the activity half is logTail()).
   *
   * Modes:
   *   - { id }                → the single message with that id, wherever it lives.
   *   - { agentId }           → recent messages in that agent's mailbox only.
   *   - {}                    → recent messages across the whole floor, newest first.
   * `limit` caps the list (default 12, max 40); `includeArchived` (default true)
   * also reads the handled subfolders (inbox/.done, outbox/.sent).
   *
   * SECURITY: every subject + body is passed through redactSecrets() here, in
   * main, so no secret and no raw body ever crosses IPC. Delivered messages exist
   * in both the sender's outbox/.sent and the recipient's inbox/.done; we dedup
   * by message id so each appears once.
   */
  voiceMessages(opts: { agentId?: string; id?: string; limit?: number; includeArchived?: boolean } = {}): VoiceMessage[] {
    const root = this.root();
    if (!root) return [];
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return [];

    const wantId = typeof opts.id === 'string' ? opts.id.trim() : '';
    const onlyAgent = typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
    const includeArchived = opts.includeArchived !== false; // default true

    let owners: string[];
    try {
      owners = onlyAgent
        ? [onlyAgent]
        : readdirSync(agentsDir).filter((id) => !id.startsWith('.') && existsSync(this.agentDir(id)));
    } catch {
      return [];
    }

    const seen = new Set<string>();
    const out: VoiceMessage[] = [];
    for (const owner of owners) {
      const base = this.agentDir(owner);
      const folders: Array<{ dir: string; direction: 'inbox' | 'outbox'; archived: boolean }> = [
        { dir: join(base, 'inbox'), direction: 'inbox', archived: false },
        { dir: join(base, 'outbox'), direction: 'outbox', archived: false }
      ];
      if (includeArchived) {
        folders.push({ dir: join(base, 'inbox', '.done'), direction: 'inbox', archived: true });
        folders.push({ dir: join(base, 'outbox', '.sent'), direction: 'outbox', archived: true });
      }
      for (const f of folders) {
        for (const m of this.listMessages(f.dir)) {
          if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue;
          seen.add(m.id);
          if (wantId && m.id !== wantId) continue;
          out.push({
            id: m.id,
            conversation: m.conversation,
            from: m.from,
            to: m.to,
            act: m.act,
            subject: redactSecrets(m.subject),
            body: redactSecrets(m.body),
            requires_reply: !!m.requires_reply,
            direction: f.direction,
            owner,
            archived: f.archived,
            created_at: m.created_at
          });
        }
      }
    }

    // Newest first by ISO created_at (lexicographic == chronological for ISO-8601).
    out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    if (wantId) return out.slice(0, 1);
    const lim = typeof opts.limit === 'number' && isFinite(opts.limit)
      ? Math.max(1, Math.min(40, Math.round(opts.limit)))
      : 12;
    return out.slice(0, lim);
  }
  /** Count undrained inbox messages for an agent (cheap — for the fleet snapshot). */
  inboxBacklog(id: string): number {
    const dir = join(this.agentDir(id), 'inbox');
    if (!existsSync(dir)) return 0;
    try { return readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
  }
  /** Install the Antigravity (`agy`) lifecycle-hook bridge: write the normalizer
   *  shim and merge a `munder-hive` hook group into agy's global hooks.json so a
   *  Gemini worker reports PreToolUse/PostToolUse/Stop/PreInvocation/PostInvocation
   *  to this HookServer (live status + guarded idle delivery), reusing the Claude pipeline.
   *
   *  Two agy-isms handled: (1) antigravity-cli#49 — agy LOADS hooks from
   *  `~/.gemini/antigravity-cli/hooks.json` but TRIGGERS from `~/.gemini/config/
   *  hooks.json`, so we write BOTH; (2) on Windows commands go to cmd.exe and
   *  agy mangles embedded quotes, so that platform retains the legacy form.
   *  Runtime-scoped by AGENT_ID (the shim no-ops for non-hive agy sessions), so
   *  this global config never disturbs the user's own `agy` usage. Best-effort,
   *  idempotent (only our own group is overwritten). */
  private installAgyHooks(): void {
    const root = this.root();
    const home = this.userConfigHome;
    if (!root || !home) return;
    const shim = join(root, 'bin', 'agy-hook.cjs');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(shim, AGY_HOOK_SHIM, 'utf8');
    // Bundled node, not bare `node` — agy's hooks run with a stripped PATH too.
    const command = (event: string) => process.platform === 'win32'
      ? this.nodeRunUnquoted(shim, event)
      : this.nodeRun(shim, event);
    // agy's PreInvocation/PostInvocation/Stop take handlers flat, not in Claude's
    // `{ hooks: [...] }` group; agy 1.2 rejects the whole file otherwise
    // ("command hook must specify 'command'") and no hook fires at all. No
    // `timeout`: agy documents only its 30s default, not what 0 means.
    const handler = (event: string) => ({ type: 'command', command: command(event) });
    const tool = (event: string) => ({ matcher: '*', hooks: [handler(event)] });
    const plain = handler;
    const group = {
      PreToolUse: [tool('PreToolUse')],
      PostToolUse: [tool('PostToolUse')],
      PreInvocation: [plain('PreInvocation')],
      PostInvocation: [plain('PostInvocation')],
      Stop: [plain('Stop')]
    };
    const gem = join(home, '.gemini');
    for (const p of [join(gem, 'config', 'hooks.json'), join(gem, 'antigravity-cli', 'hooks.json')]) {
      try {
        mkdirSync(dirname(p), { recursive: true });
        let existing: Record<string, unknown> = {};
        if (existsSync(p)) {
          try { existing = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { existing = {}; }
        }
        existing['munder-hive'] = group;
        writeFileSync(p, JSON.stringify(existing, null, 2), 'utf8');
      } catch { /* best-effort per file */ }
    }
  }

  /** Official Google Gemini CLI lifecycle bridge. Gemini's hook payload is
   *  already snake_case; the shim maps event names into HookServer's common
   *  vocabulary and translates deny/steering replies back to Gemini.
   *
   *  The system settings path is per agent. Gemini merges object and array
   *  settings across layers, so auth and user settings remain in their normal
   *  GEMINI_CLI_HOME while this trusted bridge stays isolated. */
  private installGeminiHooks(dir: string): string {
    const home = join(dir, '.gemini-hive');
    const settingsPath = join(home, 'system-settings.json');
    try {
      mkdirSync(home, { recursive: true });
      const shim = join(home, 'gemini-hook.cjs');
      writeFileSync(shim, GEMINI_HOOK_SHIM, 'utf8');
      const hook = (name: string, matcher?: string) => ({
        ...(matcher ? { matcher } : {}),
        sequential: true,
        hooks: [{
          name: `munder-hive-${name}`,
          type: 'command',
          command: process.platform === 'win32'
            ? this.nodeRunUnquoted(shim)
            : this.nodeRun(shim),
          timeout: 30000
        }]
      });
      const settings = {
        hooksConfig: { enabled: true, notifications: false },
        hooks: {
          SessionStart: [hook('session-start')],
          BeforeAgent: [hook('before-agent')],
          BeforeTool: [hook('before-tool', '.*')],
          AfterTool: [hook('after-tool', '.*')],
          AfterAgent: [hook('after-agent')]
        }
      };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    } catch (e) { console.error('[hive] installGeminiHooks failed:', e); }
    return settingsPath;
  }

  /** Codex lifecycle-hook bridge → full hive parity for a `codex` worker (live
   *  status + Stop→inbox-drain), the codex counterpart of installAgyHooks().
   *
   *  Codex's hook contract is already Claude-shaped: snake_case stdin
   *  (hook_event_name/tool_name/tool_input/session_id/cwd) and a matching response
   *  contract, where `Stop` honoring {decision:'block',reason} means "continue,
   *  using reason as the next prompt" — exactly what drainForStop() returns. So we
   *  reuse the Claude `cth-hook` shim VERBATIM (no translator, unlike agy) and let
   *  HookServer handle everything unchanged.
   *
   *  ISOLATION: rather than mutate the user's global Codex configuration (which
   *  also holds their login), we point this worker at a PER-AGENT CODEX_HOME
   *  (`<dir>/.codex`, alongside Claude's settings.json) holding our own config.toml
   *  with `[hooks]` tables — so the hooks fire ONLY for hive workers and a personal
   *  `codex` run is untouched. Rollout directories are linked into that isolated
   *  home from namespaced paths under the standard global scan roots. The user's
   *  ~/.codex/auth.json is linked in and their config.toml is copied + extended
   *  (login + model/provider/trust settings still apply).
   *  Returns the CODEX_HOME path for the caller to put in the worker's env. */
  private installCodexHooks(dir: string, agentId: string, writableRoots: string[] = [], network = false, mcp: AgentMcpId[] = [], effort?: EffortLevel): string {
    const home = join(dir, '.codex');
    try {
      mkdirSync(home, { recursive: true });
      const userHome = join(homedir(), '.codex');
      // Symlink the user's login so the isolated home authenticates as them.
      // (config.toml is NOT symlinked — we write our own below, seeded from theirs,
      // because it must carry our [hooks] tables.) Fall back to copy where symlinks
      // need privilege (Windows). Idempotent — skip if already linked.
      const authSrc = join(userHome, 'auth.json');
      const authDest = join(home, 'auth.json');
      if (existsSync(authSrc) && !existsSync(authDest)) {
        try { symlinkSync(authSrc, authDest); }
        catch { try { copyFileSync(authSrc, authDest); } catch { /* best-effort */ } }
      }
      // Codex reads global instructions from $CODEX_HOME/AGENTS.md, so without this
      // link a worker never sees the user's own ~/.codex/AGENTS.md.
      const agentsSrc = join(userHome, 'AGENTS.md');
      const agentsDest = join(home, 'AGENTS.md');
      if (existsSync(agentsSrc) && !existsSync(agentsDest)) {
        try { symlinkSync(agentsSrc, agentsDest); }
        catch { try { copyFileSync(agentsSrc, agentsDest); } catch { /* best-effort */ } }
      }
      // Wire lifecycle hooks via config.toml `[hooks]` tables — the user-layer
      // discovery surface Codex actually scans. (A bare $CODEX_HOME/hooks.json is
      // plugin-scoped — referenced FROM a plugin manifest — and is NOT discovered
      // for a plain config dir; verified empirically that it never fires.) We seed
      // this config.toml from the user's (their model/provider/trust settings carry
      // over) and append a `[[hooks.<Event>]]` group per event, each pointing at the
      // SAME cth-hook shim — reused verbatim (Codex's hook payload + response are
      // already Claude-shaped, so HookServer/drainForStop run unchanged). Regenerated
      // each spawn (idempotent). Serialize the generated command as a TOML basic
      // string; JSON string escaping is compatible here and, on POSIX, preserves
      // the embedded quotes required when a user-selected hive path has spaces.
      // NOTE: hooks fire in INTERACTIVE codex sessions (how hive workers run),
      // not in headless `codex exec`.
      //
      // `timeout` IS SECONDS HERE — do NOT copy Claude's `timeout: 0` sentinel into
      // this file. Codex parses the key as `timeout_sec` and normalizes it with
      // `timeout_sec.unwrap_or(600).max(1)`, so 0 does not mean "no timeout": it is
      // floored to ONE SECOND, the shortest budget there is. That shipped through
      // v0.3.7 and made every codex worker log `SessionStart hook (failed) — hook
      // timed out after 1s` (same for UserPromptSubmit), because each hook cold-starts
      // the Electron binary via hive-node and then waits on hooks.sock — measured
      // 0.08-0.16s idle but 0.6-0.7s under 8 concurrent spawns, which is exactly what
      // session start and prompt dispatch look like. 30s clears that by two orders of
      // magnitude while still capping a wedged shim well before its own 5s internal
      // cap stops mattering; bare omission (600s) would leave a hang looking like a
      // freeze. Verify any change with codex's own resolver, no model spend:
      // `codex app-server` → initialize → `hooks/list` reports the normalized
      // timeoutSec per event.
      const shim = this.shimPath();
      let config = existsSync(join(userHome, 'config.toml'))
        ? readFileSync(join(userHome, 'config.toml'), 'utf8') : '';
      if (shim) {
        const events = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop',
          'SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact'];
        // Preserve the existing Windows .cmd shape: nested command quotes pass
        // through a different shell stack there (#350). The reported Codex bug
        // is POSIX, where ordinary shell quoting is both necessary and verified.
        const command = process.platform === 'win32'
          ? this.nodeRunUnquoted(shim)
          : this.nodeRun(shim);
        config += '\n# --- munder-hive lifecycle hooks (auto-generated; do not edit) ---\n';
        for (const ev of events) {
          config += `\n[[hooks.${ev}]]\n[[hooks.${ev}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ntimeout = 30\n`;
        }
      }
      // The user's Claude setup, read from ~/.claude at spawn and never written: the
      // context SessionStart hooks and the enforcing PreToolUse guards, through the adapter.
      if (process.platform !== 'win32') {
        for (const h of this.claudeHooksForCodex()) {
          config += `\n[[hooks.${h.event}]]\n[[hooks.${h.event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(h.command)}\ntimeout = 60\n`;
        }
        this.linkSkillsForCodex(join(home, 'skills'), userHome);
      }
      // A wake-up Enter on Codex's update screen would run "Update now" (a global npm
      // install), so workers never show it.
      config = setTopLevelTomlKey(config, 'check_for_update_on_startup', false);
      // Likewise its "switch to a cheaper model?" prompt after a usage limit: the Enter of
      // the next typed message picks "Switch", moving the worker off its allowed models.
      config = setTomlTableKey(config, 'notice', 'hide_rate_limit_model_nudge', true);
      // Unset keeps the user's own level, but never one above the Codex cap.
      const inherited = /^model_reasoning_effort\s*=\s*"([a-z]+)"/m.exec(config.split(/^\[/m)[0])?.[1];
      const ownEffort = capEffort('codex', effort ?? (isEffortLevel(inherited) ? inherited : undefined));
      if (ownEffort && ownEffort !== inherited) config = setTopLevelTomlKey(config, 'model_reasoning_effort', ownEffort);
      // The agent's network switch must override a network_access inherited from the
      // user's config.toml; the roots repeat the `--add-dir` flags.
      config = setSandboxWorkspaceWrite(config, writableRoots, network);
      config = setCodexMcpServers(config, mcp);
      const configPath = join(home, 'config.toml');
      config = mergeHookTrust(this.codexHookTrustSources(dirname(dir)), join(realpathSync(home), 'config.toml'), config);
      writeFileSync(configPath, config, 'utf8');

      // Keep each worker's CODEX_HOME isolated while putting its rollout data
      // below Codex's standard scan roots. External usage tools can then discover
      // the sessions without understanding the hive's private directory layout.
      this.exposeCodexDataDirs(home, userHome, agentId);
    } catch (e) { console.error('[hive] installCodexHooks failed:', e); }
    return home;
  }

  /** Marks the hooks this hive wrote into a worker's config.toml as trusted, so Codex never
   *  stops a worker at its hook-review prompt for them. Codex fingerprints a hook from its
   *  definition and reports the fingerprint in `hooks/list`, so we ask it rather than
   *  computing one. Only commands under the hive's bin folder count as ours. Best-effort: a
   *  failed listing leaves the worker to Codex's normal prompt. */
  private async trustOwnCodexHooks(home: string): Promise<void> {
    const root = this.root();
    if (!root || process.platform === 'win32') return;
    const bin = join(root, 'bin');
    try {
      const hooks = await listCodexHooks(home);
      if (!hooks.length) return;
      const configPath = join(home, 'config.toml');
      const cfg = readFileSync(configPath, 'utf8');
      const next = trustOwnHooks(cfg, hooks, (command) => command.includes(bin));
      if (next !== cfg) writeFileSync(configPath, next, 'utf8');
    } catch (e) { console.error('[hive] trusting codex hooks failed:', e); }
  }

  /** Every Codex agent's config.toml in the hive, as hook-trust sources for mergeHookTrust. */
  private codexHookTrustSources(agentsDir: string): Array<{ text: string; mtimeMs: number }> {
    const out: Array<{ text: string; mtimeMs: number }> = [];
    let names: string[] = [];
    try { names = readdirSync(agentsDir); } catch { return out; }
    for (const n of names) {
      const p = join(agentsDir, n, '.codex', 'config.toml');
      try { out.push({ text: readFileSync(p, 'utf8'), mtimeMs: statSync(p).mtimeMs }); } catch { /* not a codex agent */ }
    }
    return out;
  }

  /** Codex hook entries for the user's Claude hooks, from ~/.claude/settings.json. */
  private claudeHooksForCodex(): Array<{ event: string; command: string }> {
    const root = this.root();
    const adapter = root ? join(root, 'bin', 'claude-hook-adapter.cjs') : null;
    if (!adapter || !existsSync(adapter)) return [];
    let settings: unknown;
    try {
      settings = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'), 'utf8'));
    } catch { return []; }
    return codexClaudeHookCommands(settings, this.nodeRun(adapter));
  }

  /** Links the user's skills into a worker's CODEX_HOME/skills, the folder Codex scans:
   *  each ~/.claude/skills/<name>/ with a SKILL.md, then ~/.codex/skills/<name>/ for names
   *  not already taken. Symlinks, so edits in ~/.claude flow through. Codex's own .system
   *  folder and anything that is not our symlink are left alone; links whose source is
   *  gone are removed. */
  private linkSkillsForCodex(dest: string, userCodexHome: string): void {
    try {
      mkdirSync(dest, { recursive: true });
      const sources = new Map<string, string>();
      const claudeSkills = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills');
      const bases = [claudeSkills, join(userCodexHome, 'skills')];
      for (const base of bases) {
        let names: string[] = [];
        try { names = readdirSync(base); } catch { continue; }
        for (const n of names) {
          if (n.startsWith('.') || sources.has(n)) continue;
          if (existsSync(join(base, n, 'SKILL.md'))) sources.set(n, join(base, n));
        }
      }
      for (const n of readdirSync(dest)) {
        const p = join(dest, n);
        let st: ReturnType<typeof lstatSync>;
        try { st = lstatSync(p); } catch { continue; }
        if (!st.isSymbolicLink()) continue;
        const target = readlinkSync(p);
        const ours = bases.some((b) => dirname(target) === b);
        if (ours && sources.get(n) !== target) unlinkSync(p);
      }
      for (const [n, src] of sources) {
        const p = join(dest, n);
        let present = true;
        try { lstatSync(p); } catch { present = false; }
        if (!present) symlinkSync(src, p, 'dir');
      }
    } catch (e) { console.error('[hive] linking skills for codex failed:', e); }
  }

  private exposeCodexDataDirs(home: string, userHome: string, agentId: string): void {
    for (const kind of ['sessions', 'archived_sessions'] as const) {
      try { this.exposeCodexDataDir(home, userHome, agentId, kind); }
      catch (e) { console.error(`[hive] exposeCodexDataDir(${kind}) failed:`, e); }
    }
  }

  private moveCodexDataDir(from: string, to: string): void {
    try {
      renameSync(from, to);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
      rmSync(from, { recursive: true, force: true });
    }
  }

  private exposeCodexDataDir(
    home: string,
    userHome: string,
    agentId: string,
    kind: 'sessions' | 'archived_sessions'
  ): void {
    const root = this.root();
    if (!root) return;
    if (!agentId || basename(agentId) !== agentId || agentId === '.' || agentId === '..') {
      throw new Error(`invalid agent id: ${agentId}`);
    }
    const source = join(home, kind);
    const scanRoot = join(userHome, kind, 'munder-difflin');
    const hiveId = createHash('sha1').update(root).digest('hex').slice(0, 12);
    const target = join(scanRoot, hiveId, agentId);

    let sourceStat: ReturnType<typeof lstatSync> | null = null;
    try { sourceStat = lstatSync(source); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }

    if (sourceStat?.isSymbolicLink()) {
      let current: string | null = null;
      try { current = realpathSync(source); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        unlinkSync(source);
        sourceStat = null;
      }
      if (current) {
        const rel = relative(realpathSync(scanRoot), current);
        const scope = dirname(rel);
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)
          && dirname(scope) === '.' && basename(rel) === agentId) return;
        throw new Error(`${source} points outside ${scanRoot}`);
      }
    }
    if (sourceStat && !sourceStat.isDirectory()) throw new Error(`${source} is not a directory`);

    mkdirSync(dirname(target), { recursive: true });
    if (sourceStat) {
      if (existsSync(target)) {
        if (readdirSync(target).length > 0) throw new Error(`${source} and ${target} both contain data`);
        rmSync(target, { recursive: true, force: true });
      }
      this.moveCodexDataDir(source, target);
    } else if (!existsSync(target)) {
      mkdirSync(target, { recursive: true });
    }

    try {
      symlinkSync(target, source, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      if (!existsSync(source) && existsSync(target)) {
        try { this.moveCodexDataDir(target, source); } catch { /* data remains at target */ }
      }
      throw e;
    }
  }

  /** Remove rollout directories moved under the user's standard Codex scan
   *  roots before a full hive reset removes the isolated CODEX_HOME links. */
  removeExposedCodexData(): void {
    const root = this.root();
    if (!root) return;
    const agents = join(root, 'agents');
    if (!existsSync(agents)) return;
    const userHome = join(homedir(), '.codex');

    for (const entry of readdirSync(agents, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const kind of ['sessions', 'archived_sessions'] as const) {
        const source = join(agents, entry.name, '.codex', kind);
        try {
          if (!lstatSync(source).isSymbolicLink()) continue;
          const target = realpathSync(source);
          const scanRoot = realpathSync(join(userHome, kind, 'munder-difflin'));
          const rel = relative(scanRoot, target);
          const scope = dirname(rel);
          if (!rel || rel.startsWith('..') || isAbsolute(rel)
            || dirname(scope) !== '.' || basename(rel) !== entry.name) continue;
          rmSync(target, { recursive: true, force: true });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('[hive] removeExposedCodexData failed:', e);
          }
        }
      }
    }
  }

  /** Pi (earendil-works) bridge. Pi has a rich `pi.on(event, …)` lifecycle but no
   *  Claude-shaped hook file; instead we drop a bundled EXTENSION into a PER-AGENT
   *  PI_CODING_AGENT_DIR (so the user's global ~/.pi is never mutated) that, when Pi
   *  loads it, posts cth-hook-shaped payloads to HIVE_SOCK on tool_call/agent_end and
   *  auto-approves tool calls when the floor is in auto mode (HIVE_AUTO_APPROVE).
   *  Emitting an `agent_end`→`Stop` keeps the harness status in step (→ idle), which
   *  lets the renderer idle inbox-wake nudge deliver mail. Returns the per-agent dir
   *  for PI_CODING_AGENT_DIR.
   *
   *  LIVE-UNVERIFIED: Pi's exact extension-discovery path + event API need BYOK keys
   *  to confirm; this is written best-effort and wrapped so a wrong guess can never
   *  break the spawn. The renderer nudge is the guaranteed drain regardless. */
  private installPiHooks(dir: string): string {
    const home = join(dir, '.pi-agent');
    try {
      // Pi discovers extensions under its agent dir; we write to the documented
      // `extensions/` location (and keep it isolated per agent).
      const extDir = join(home, 'extensions');
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, 'hive-bridge.js'), PI_EXTENSION, 'utf8');
      // A manifest so Pi auto-loads the extension on start (best-effort; harmless if
      // Pi ignores it). Kept minimal and hive-authored.
      const manifest = { name: 'munder-hive-bridge', version: '0.3.1', main: 'extensions/hive-bridge.js', auto: true };
      writeFileSync(join(home, 'extensions.json'), JSON.stringify(manifest, null, 2), 'utf8');

      const userPiDir = join(homedir(), '.pi', 'agent');
      for (const fileName of ['models.json', 'models-store.json'] as const) {
        try {
          const data = readFileSync(join(userPiDir, fileName), 'utf8');
          writeFileSync(join(home, fileName), data, 'utf8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[hive] installPiHooks copy ${fileName} failed:`, e);
        }
      }
    } catch (e) { console.error('[hive] installPiHooks failed:', e); }
    return home;
  }

  /** OpenCode (anomalyco/opencode) bridge — god Decision 1 (native plugin, not proxy).
   *  OpenCode has no Claude-shaped Stop hook, but its plugin API exposes a real
   *  `session.idle` lifecycle event. We drop a bundled PLUGIN into a PER-AGENT config
   *  dir's `plugin/` folder (OpenCode auto-loads `*.js` plugins from there) that posts
   *  HIVE_SOCK payloads on tool.execute.before/after + session.idle — the same
   *  Stop→drain semantics as codex's hooks, provider-agnostic, no traffic interception.
   *  Returns the config dir for OPENCODE_CONFIG_DIR (isolates from ~/.config/opencode).
   *
   *  LIVE-UNVERIFIED: plugin auto-load + session.idle firing + the inject path need
   *  BYOK keys to confirm; written best-effort, wrapped so it can't break the spawn.
   *  The renderer idle inbox-wake nudge is the guaranteed drain fallback. */
  private installOpenCodePlugin(dir: string, theme?: 'light' | 'dark'): string {
    const home = join(dir, '.opencode');
    try {
      // Theme: OpenCode's `system` theme keeps the terminal's own fg/bg (xterm's,
      // which already follows the app theme) and builds its greys from the
      // detected background, so it reads right on light AND dark. Written to
      // tui.json (current builds) and opencode.json (older builds read `theme`
      // there and migrate it; the migration skips when tui.json already exists).
      // Per-agent dir only, the user's ~/.config/opencode is never touched.
      if (theme) {
        mkdirSync(home, { recursive: true });
        const choice = { theme: 'system' };
        writeFileSync(join(home, 'tui.json'), JSON.stringify({ $schema: 'https://opencode.ai/tui.json', ...choice }, null, 2), 'utf8');
        writeFileSync(join(home, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...choice }, null, 2), 'utf8');
      }
      // BOTH `plugin/` and `plugins/`. OpenCode's current docs specify `plugins/`
      // (plural); older builds — and the shape this bridge was originally written
      // against — auto-load from `plugin/` (singular). Since the whole bridge is
      // LIVE-UNVERIFIED (no BYOK keys to prove which the installed version reads),
      // guessing one of them is a coin flip whose losing side is silent: the plugin
      // simply never loads and the agent's only inbox drain becomes the renderer
      // nudge. Writing the same ~2KB file twice costs nothing, is idempotent, and
      // is correct whichever directory the installed OpenCode actually scans.
      for (const name of ['plugin', 'plugins']) {
        const pluginDir = join(home, name);
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(join(pluginDir, 'hive-bridge.js'), OPENCODE_PLUGIN, 'utf8');
      }
    } catch (e) { console.error('[hive] installOpenCodePlugin failed:', e); }
    return home;
  }

  /** Crush (charmbracelet/crush) proxy routing. Crush has NO base-URL env override, so
   *  the generic proxy env-rewrite is a no-op for it; instead we write a per-agent
   *  CRUSH_GLOBAL_CONFIG whose standard providers' `base_url` all point at the loopback
   *  proxy (so whatever model the worker picks, its LLM traffic routes through the
   *  sidecar → synthesized Status/Stop/cost → status goes idle → the terminal
   *  work-order + renderer nudge deliver mail). A per-agent CRUSH_GLOBAL_DATA isolates
   *  session state from the user's global ~/.config/crush. Keys ride BYOK env vars
   *  (Crush reads ANTHROPIC_API_KEY/OPENAI_API_KEY/… directly), so none are written
   *  here. `api` follows the proxy's wire shape (advisory). Returns the config + data
   *  paths for the spawn env.
   *
   *  LIVE-UNVERIFIED: the single-upstream proxy serves one provider/endpoint shape at a
   *  time — for full synthesized events pick a model whose provider matches the
   *  configured upstream (or a local OpenAI-compatible endpoint). Cross-provider mixing
   *  is humanQA; the renderer nudge still delivers mail regardless. */
  private installCrushConfig(dir: string, loopbackUrl: string, api: 'openai' | 'anthropic', theme?: 'light' | 'dark'): { config: string; data: string } {
    const config = join(dir, 'crush.json');
    const data = join(dir, '.crush-data');
    try {
      mkdirSync(data, { recursive: true });
      // Override base_url → loopback for ONLY the provider whose wire-shape matches
      // the proxy (`api`): the single-upstream sidecar forwards bytes unchanged, so
      // routing a different-wire/host provider (e.g. anthropic when api='openai', or
      // openrouter/groq which are openai-wire but different hosts) through it would
      // hit the wrong endpoint and the call would fail. Those are left to their real
      // upstreams (working calls, un-proxied — no synthesized events, but mail still
      // drains via the renderer nudge + the pty-quiescence idle fallback). For the
      // default god (openai-wire) and a local OpenAI-compatible endpoint this routes
      // through the proxy cleanly. Cross-provider Crush-via-proxy is on-device
      // live-verify (Dwight verify-crush MF1; the default god model is openai-wire to
      // match). Literal loopback (Dwight's b1 — no ${VAR} expansion edge cases);
      // Crush merges config so only base_url is rewritten.
      const wireProvider = api === 'anthropic' ? 'anthropic' : 'openai';
      const providers: Record<string, { base_url: string }> = { [wireProvider]: { base_url: loopbackUrl } };
      // Theme: Crush ships one (dark) palette and no light theme, but
      // `options.tui.transparent` stops it painting its own background, so it
      // sits on xterm's, which follows the app theme. Set whenever the app
      // passes a theme, dark included, so both modes look the same way.
      const options = theme ? { tui: { transparent: true } } : undefined;
      writeFileSync(config, JSON.stringify(options ? { providers, options } : { providers }, null, 2), 'utf8');
    } catch (e) { console.error('[hive] installCrushConfig failed:', e); }
    return { config, data };
  }

  /** Grok lifecycle-hook bridge → live hive status, session capture, guarded
   *  inbox delivery, and operator gates for `grok` workers.
   *
   *  Grok supports the same hook events and decision vocabulary as Claude Code,
   *  but its stdin payload uses camelCase keys. A small adapter normalizes those
   *  keys to HookServer's Claude-shaped contract. The hook is installed in the
   *  user's global Grok hook directory because global hooks are trusted and
   *  Grok sessions/resume stay in the user's normal GROK_HOME. The adapter is
   *  strictly scoped by AGENT_ID, so ordinary Grok sessions exit without doing
   *  anything. Best-effort and idempotent. */
  private installGrokHooks(): void {
    const root = this.root();
    const home = this.userConfigHome;
    if (!root || !home) return;
    try {
      const shim = join(root, 'bin', 'grok-hook.cjs');
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(shim, GROK_HOOK_SHIM, 'utf8');
      const tool = (matcher?: string) => ({
        ...(matcher ? { matcher } : {}),
        // Let Grok apply its event-aware defaults (5s normally, 600s for Stop).
        // Grok is a HOOK bridge (not a proxy sidecar), so it is hit by the same
        // `node: command not found` 127 — bundled node here too.
        hooks: [{ type: 'command', command: this.nodeRun(shim) }]
      });
      const hooks = {
        PreToolUse: [tool('.*')],
        PostToolUse: [tool('.*')],
        Stop: [tool()],
        SubagentStop: [tool('.*')],
        SessionStart: [tool('.*')],
        UserPromptSubmit: [tool()],
        PreCompact: [tool('.*')],
        PostCompact: [tool('.*')]
      };
      const hookDir = join(home, '.grok', 'hooks');
      mkdirSync(hookDir, { recursive: true });
      writeFileSync(
        join(hookDir, 'munder-hive.json'),
        JSON.stringify({ hooks }, null, 2),
        'utf8'
      );
    } catch (e) { console.error('[hive] installGrokHooks failed:', e); }
  }

  /** Write the live fleet snapshot Michael reads (`fleet.json`, gitignored).
   *  Best-effort — called from a timer, must never throw. */
  /** fleet.json as this process last wrote it, even while that write is still queued. */
  private readFleet<T>(root: string): T {
    const p = join(root, 'fleet.json');
    const queued = this.snapshots.latest(p);
    if (queued === undefined) return this.readJson<T>(p, {} as T);
    try { return JSON.parse(queued) as T; } catch { return {} as T; }
  }

  /** fleet.json as last written (or queued). */
  fleet(): unknown {
    const root = this.root();
    return root ? this.readFleet<unknown>(root) : {};
  }

  /** Write a message straight into `toId`'s inbox/.done: on record, never woken for. */
  fileHandled(partial: Partial<HiveMessage>, toId: string, from: string): HiveMessage | null {
    const msg = this.normalize(partial, from);
    const done = join(this.agentDir(toId), 'inbox', '.done');
    if (!existsSync(join(this.agentDir(toId), 'inbox'))) return null;
    mkdirSync(done, { recursive: true });
    this.atomicWriteJson(join(done, `${msg.id}.json`), msg);
    this.appendLog({ kind: 'filed-handled', from: msg.from, to: toId, id: msg.id, subject: msg.subject });
    return msg;
  }

  writeFleetSnapshot(snapshot: unknown): void {
    const root = this.root();
    if (!root) return;
    this.snapshots.write(join(root, 'fleet.json'), JSON.stringify(snapshot, null, 2));
  }

  /** Is this agent the hive's god/orchestrator? */
  isGod(agentId: string): boolean {
    try {
      const reg = this.registry();
      return reg.godId === agentId || !!reg.agents[agentId]?.isGod;
    } catch { return false; }
  }

  /**
   * A compact, one-shot LIVE ROSTER line built from `fleet.json` — injected into
   * god's context as `additionalContext` on SessionStart and every
   * UserPromptSubmit (see HookServer).
   *
   * Why: fleet.json/registry.json are always fresh on disk (8s snapshot +
   * syncDormancyWithRoster on boot + PTY-exit archiving), but god's CONTEXT is not.
   * After an app restart god resumes a session whose transcript still describes
   * the OLD floor, and it will happily message agents that no longer exist. It is
   * told to read fleet.json, but "told to" is not "always knows" — so we push the
   * truth in on every turn instead. One line, so the cost is negligible.
   *
   * `ctxOf` (optional, supplied by HookServer) lets the caller layer the LIVE
   * context-window occupancy on top of the disk snapshot — each agent gets a
   * `ctx NN%` so god can see at a glance whose context is nearly full when it
   * routes work. fleet.json only carries cumulative `tokens`, which is a spend
   * figure, not how full the CURRENT window is; the real occupancy lives in
   * HookServer.contextById (from the statusLine shim). Omitted when the callback
   * is absent or an agent has no Status tick yet.
   *
   * Returns null when there is nothing to say (no hive, no snapshot, no agents),
   * so the hook stays a no-op rather than injecting noise.
   */
  rosterContext(
    ctxOf?: (agentId: string) => { tokens: number; limit: number } | undefined
  ): string | null {
    const root = this.root();
    if (!root) return null;
    try {
      const fleetPath = join(root, 'fleet.json');
      const raw = this.snapshots.latest(fleetPath) ?? readFileSync(fleetPath, 'utf8');
      const snap = JSON.parse(raw) as {
        ts?: number;
        agents?: Array<{
          id: string; name?: string; role?: string; isGod?: boolean;
          breaker?: string; tokens?: number; usd?: number;
          lastTool?: string | null; lastActiveSecAgo?: number | null; activityUnknown?: boolean; inboxBacklog?: number;
          onHold?: boolean; dormant?: boolean;
        }>;
      };
      const agents = Array.isArray(snap.agents) ? snap.agents : [];
      if (!agents.length) return null;

      const ago = (s: number | null | undefined): string =>
        typeof s !== 'number' ? 'unknown'
          : s < 90 ? `${s}s ago`
            : s < 5400 ? `${Math.round(s / 60)}m ago`
              : `${Math.round(s / 3600)}h ago`;

      // Cap the list so a big floor can't crowd out the actual prompt. The
      // remainder is still counted, and fleet.json is one Read away.
      const MAX = 24;
      const shown = agents.slice(0, MAX);
      let anyCtx = false;
      let anyHold = false;
      let anyDormant = false;
      const rows = shown.map((a) => {
        if (a.dormant) {
          anyDormant = true;
          return `${a.id}${a.name ? ` "${a.name}"` : ''} (${a.role ?? 'agent'}, DORMANT${a.inboxBacklog ? `, inbox ${a.inboxBacklog}` : ''})`;
        }
        const bits = [a.role ?? 'agent',
          typeof a.lastActiveSecAgo === 'number' ? `active ${ago(a.lastActiveSecAgo)}` : a.activityUnknown ? 'activity unknown' : 'no activity yet'];
        if (a.tokens) bits.push(`${Math.round(a.tokens / 1000)}k tok`);
        if (a.usd) bits.push(`$${a.usd.toFixed(2)}`);
        if (a.inboxBacklog) bits.push(`inbox ${a.inboxBacklog}`);
        if (a.breaker && a.breaker !== 'ok' && a.breaker !== 'none') bits.push(`breaker ${a.breaker}`);
        if (a.isGod) bits.push('you');
        // First in the row after the role would be louder, but this reads in
        // the same scan as `breaker` and `inbox`, and god already treats those
        // as routing signals.
        if (a.onHold) { bits.push('ON HOLD — 1:1 with the human'); anyHold = true; }
        // Live context-window occupancy from the statusLine shim — lets god see
        // which agents are near-full when routing, instead of guessing from the
        // cumulative token count. Clamp to 0-100; a fresh meter can briefly
        // report more than 100% before a window rotation.
        const cw = ctxOf?.(a.id);
        if (cw && cw.limit > 0) {
          const pct = Math.max(0, Math.min(100, Math.round((cw.tokens / cw.limit) * 100)));
          bits.push(`ctx ${pct}%`);
          anyCtx = true;
        }
        return `${a.id}${a.name ? ` "${a.name}"` : ''} (${bits.join(', ')})`;
      });
      const more = agents.length > shown.length ? ` +${agents.length - shown.length} more` : '';
      const age = typeof snap.ts === 'number' ? ago(Math.round((Date.now() - snap.ts) / 1000)) : 'unknown';

      return `[LIVE ROSTER — auto-injected from ${join(root, 'fleet.json')}, snapshot ${age}] `
        + `${agents.length} agent(s) on the floor: ${rows.join('; ')}.${more} `
        + 'This is the CURRENT floor and it SUPERSEDES any roster earlier in this conversation — '
        + 'agents you remember that are absent here have been archived or killed, so do not message them. '
        + (anyCtx
          ? '`ctx NN%` = live window occupancy; absent = not yet reported (unknown, not empty). '
          : '')
        + (anyHold
          ? 'An agent marked `ON HOLD — 1:1 with the human` is UNAVAILABLE: the human is working '
            + 'with them directly. Do NOT message them, do NOT dispatch to them, and do NOT count '
            + 'them when picking an owner. Route to someone else, or say the work is waiting. They '
            + 'are still running and their terminal is alive, so this is not a reason to archive '
            + 'them or spawn a replacement. The human flips it off when they are done. '
          : '')
        + (anyDormant
          ? 'A `DORMANT` agent is asleep by design, not stalled: it has no session until it has work, and '
            + 'the harness starts it within seconds of a todo/doing task assigned to it or a direct message '
            + 'to it (blocked tasks do not wake it; broadcasts skip it unless they set `"includeDormant": true`). '
            + 'Route work to it like any other agent. '
            + `To wake one with neither, write ${join(root, 'wake-requests')}/<agentId>.json. `
          : '')
        + 'Route work to someone on this list before spawning anyone new.';
    } catch { return null; }
  }
  logTail(n = 200): unknown[] {
    const root = this.root();
    if (!root) return [];
    const p = join(root, 'log.jsonl');
    const text = (existsSync(p) ? readTailLines(p, n) : '') + this.appends.unwritten(p);
    const lines = text.trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  }

  /** Resolves once every queued log, ledger and snapshot write is on disk. */
  async flushWrites(): Promise<void> {
    await Promise.all([this.appends.flush(), this.snapshots.flush()]);
  }

  /** Process exit: write whatever is still queued, synchronously. */
  flushWritesSync(): void {
    this.appends.flushSync();
    this.snapshots.flushSync();
  }

  private listMessages(dir: string): HiveMessage[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as HiveMessage; } catch { return null; } })
      .filter((m): m is HiveMessage => m !== null);
  }

  /**
   * Record an agent's process exit so a death has a durable cause.
   *
   * Before this, an agent killed by its provider crashing was archived with
   * `{kind:'archive', agentId, archived:true}` and NOTHING else — no exit code,
   * no signal, no output. A two-second SIGILL death and a completed agent were
   * indistinguishable in the only record the hive keeps, and the crash banner
   * lived solely in a UI terminal pane. Observed live 2026-08-24: Michael's
   * `claude` CLI panicked 923ms into startup and left no trace on disk.
   *
   * Split by design:
   *   - log.jsonl  gets structured, non-sensitive fields (code, signal, path).
   *   - crashes/   gets the raw tail, and is gitignored — see ensureHive.
   * A normal exit writes nothing at all; this is a diagnostic, not an audit log.
   */
  recordAgentExit(
    agentId: string,
    info: { exitCode?: number; signal?: number; tail?: string; command?: string }
  ): boolean {
    const root = this.root();
    if (!root) return false;
    const { exitCode, signal, tail, command } = info;
    // A signal means killed (SIGILL/SIGSEGV/SIGKILL); node-pty reports exitCode 0
    // in that case, so signal must be checked independently of the code.
    const abnormal = (typeof signal === 'number' && signal !== 0) || (typeof exitCode === 'number' && exitCode !== 0);
    if (!abnormal) return false;

    let tailPath: string | null = null;
    if (tail && tail.length) {
      try {
        const dir = join(root, 'crashes');
        mkdirSync(dir, { recursive: true });
        // Colons are illegal in filenames on Windows and awkward everywhere.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeId = agentId.replace(/[^A-Za-z0-9._-]/g, '_');
        const p = join(dir, `${stamp}-${safeId}.log`);
        const header = [
          `agent:    ${agentId}`,
          `exitCode: ${String(exitCode)}`,
          `signal:   ${String(signal)}`,
          command ? `command:  ${command}` : null,
          `captured: ${new Date().toISOString()}`,
          `--- last ${tail.length} bytes of pty output ---`,
          ''
        ].filter(Boolean).join('\n');
        writeFileSync(p, header + tail, 'utf8');
        tailPath = p;
      } catch { /* a diagnostic must never break teardown */ }
    }

    this.appendLog({
      kind: 'agent-exit',
      agentId,
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      abnormal: true,
      tailPath
    });
    return true;
  }

  /** Refile a wake request main already filed under .done/ to .failed/ with `error`: the
   *  floor could not start the worker, and a .done that started nothing reads as success. */
  failWakeRequest(id: string, error: string): boolean {
    const root = this.root();
    if (!root || !/^[A-Za-z0-9._-]+$/.test(id)) return false;
    const dir = join(root, 'wake-requests');
    const done = join(dir, '.done', `${id}.json`);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(readFileSync(done, 'utf8')) as Record<string, unknown>; } catch { /* filed without a body */ }
    try {
      mkdirSync(join(dir, '.failed'), { recursive: true });
      writeFileSync(join(dir, '.failed', `${id}.json`), JSON.stringify({ ...body, error: error.slice(0, 300), failedAt: new Date().toISOString() }, null, 2));
      if (existsSync(done)) unlinkSync(done);
    } catch (e) {
      console.error('[wake] could not refile request', id, e);
      return false;
    }
    this.appendLog({ kind: 'wake-request', agentId: id, error });
    return true;
  }

  // — log —
  appendLog(event: Record<string, unknown>): void {
    const root = this.root();
    if (!root) return;
    this.appends.append(join(root, 'log.jsonl'), JSON.stringify({ ts: Date.now(), ...event }) + '\n');
    if (event.kind === 'app-start') {
      try { this.sweepAllInboxesStaleWrapup(); } catch { /* best-effort */ }
    }
  }

  /**
   * Append one cost sample to the durable, append-only ledger at
   * `<root>/cost-ledger.jsonl` (Lane A #6.6d). This is the SOLE durable cost
   * store; its row is exactly the shape Kevin (#4) reserves for the cost_ledger
   * SQLite table, so migration is a mechanical INSERT…SELECT.
   *
   * 🔒 PII: persist ONLY the allowlisted AgentUsageSample — NEVER a raw OTel
   * record (those carry user.email / account / org / hashed-user-id). The sample
   * is PII-free by construction upstream (the provider's normalize step), so we
   * add no redaction here; we just must not widen what we write. The file lives
   * at the hive ROOT, so `mempalace mine` (which only scans per-agent dirs) never
   * ingests it — no palace noise, no MINE_IGNORE entry needed.
   *
   * Like appendLog: append to disk now (durable immediately), let it ride the
   * next natural commit. Best-effort — never throws into the beat.
   */
  appendCostLedger(sample: AgentUsageSample): void {
    const root = this.root();
    if (!root) return;
    // Fully snake_case so the row maps 1:1 onto Kevin's (#4) cost_ledger SQLite
    // columns (agent_id, session_id, ts, input, output, cache_read,
    // cache_creation, model, usd) — migration is a straight INSERT…SELECT.
    const row = {
      agent_id: sample.agentId,
      session_id: sample.sessionId,
      ts: sample.ts,
      input: sample.input,
      output: sample.output,
      cache_read: sample.cacheRead,
      cache_creation: sample.cacheCreation,
      model: sample.model,
      usd: sample.usd
    };
    this.appends.append(join(root, 'cost-ledger.jsonl'), JSON.stringify(row) + '\n');
  }

  // — json + atomic io —
  private readJson<T>(p: string, fallback: T): T {
    try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fallback; }
  }
  private writeJson(p: string, data: unknown): void {
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  }
  private atomicWriteJson(p: string, data: unknown): void {
    const tmp = `${p}.tmp-${shortRand()}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, p);
  }

  // — git (single committer, retry + stale-lock recovery) —
  //
  // `gc.autoDetach=false` is what makes this call actually synchronous.
  //
  // A commit runs `gc --auto`, and git detaches that into a BACKGROUND process
  // by default. `spawnSync` returns when `git commit` exits, so the caller
  // believes the hive is quiescent while a gc it cannot see is still writing
  // into `.git/objects/`. Anything that touches the hive directory right after
  // a commit races that process: removing a hive home throws ENOTEMPTY, and a
  // read can catch a half-written pack.
  //
  // It reproduces on its own — create a HiveManager on a fresh temp home, call
  // ensureAgent, then remove the home: ~3.5% of iterations throw ENOTEMPTY,
  // and the leftover is always `.git/objects/`, sometimes still holding a
  // `bitmap-ref-tips_*` temp file that vanishes a fraction of a second later.
  // With this flag, gc runs inline and 200 iterations pass clean.
  //
  // The gc still happens — this only stops it from outliving the command that
  // triggered it, which is what "single committer" was supposed to mean.
  private git(args: string[], cwd: string): { ok: boolean; out: string; err: string; timedOut: boolean } {
    const res = spawnSync('git', [...HIVE_GIT_CONFIG, ...args], {
      cwd, encoding: 'utf8', timeout: 8000
    });
    const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return { ok: res.status === 0, out: res.stdout ?? '', err: res.stderr ?? '', timedOut };
  }

  /** git() without blocking the main thread; same config. A timed-out run is killed. */
  private gitAsync(args: string[], cwd: string, stdin?: string): Promise<{ ok: boolean; out: string; err: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = execFile('git', [...HIVE_GIT_CONFIG, ...args], {
        cwd, encoding: 'utf8', timeout: HIVE_GIT_ASYNC_TIMEOUT_MS, maxBuffer: HIVE_GIT_MAX_BUFFER
      }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        resolve({ ok: !e, out: stdout ?? '', err: stderr ?? (e ? String(e.message) : ''), timedOut: !!e?.killed && !!e.signal });
      });
      if (stdin !== undefined) child.stdin?.end(stdin); else child.stdin?.end();
    });
  }

  /** Has the one-time cost-ledger untrack pass run in this process yet? */
  private untrackedCostLedger = false;

  /**
   * Stop versioning the cost ledger.
   *
   * `cost-ledger.jsonl` is append-only and gains a row per usage sample, so a
   * repo that tracks it stores a fresh copy of the WHOLE file on every hive
   * commit — and the hive commits constantly. A quarter-gigabyte ledger with a
   * few thousand commits behind it is several hundred gigabytes of blob that
   * git has to walk, which is what turns a routine `gc` into a multi-gigabyte
   * `pack-objects` run. The ignore line in ensureHive keeps new copies out;
   * this drops the one already in the index, because git keeps recording a
   * file it is already tracking no matter what .gitignore says — so the ignore
   * line alone reads as a fix while the repo goes on growing. The ledger stays
   * on disk, so the cost history the app reads is untouched.
   */
  private untrackCostLedger(root: string): void {
    if (this.untrackedCostLedger) return;
    this.untrackedCostLedger = true;
    // Probe before mutating: `rm --cached` on a repo that never tracked it
    // would still rewrite the index on every launch, inside the retry path.
    const tracked = this.git(['ls-files', '--', 'cost-ledger.jsonl'], root);
    if (!tracked.ok || !tracked.out.trim()) return;
    this.git(['rm', '--cached', '-q', '--ignore-unmatch', '--', 'cost-ledger.jsonl'], root);
    console.warn('[hive] untracked the cost ledger from the hive repo');
  }

  /** Has the one-time Codex-home untrack pass run in this process yet? */
  private untrackedCodexHomes = false;

  /**
   * Stop versioning Codex worker homes that are ALREADY in the index.
   *
   * Adding `.codex/` to each agent's .gitignore only keeps NEW paths out; git
   * happily keeps recording a file it is already tracking, so a hive that
   * predates that ignore line goes on committing every SQLite and transcript
   * revision exactly as before — the .gitignore reads as a fix while the repo
   * keeps growing. This closes that: once per process, refresh every agent's
   * ignore file (agents that are not running never pass through spawn, and the
   * mine loop only reaches them if mempalace is installed) and drop any tracked
   * `.codex` path from the index. The files stay on disk, so `codex --resume`
   * is unaffected; only their history stops.
   */
  private untrackCodexHomes(root: string): void {
    if (this.untrackedCodexHomes) return;
    this.untrackedCodexHomes = true;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return;
    try {
      for (const id of readdirSync(agentsDir)) ensureMineIgnore(join(agentsDir, id));
    } catch { /* best-effort */ }
    // Probe before mutating: `rm --cached` on a clean repo would still rewrite
    // the index on every launch, and this runs inside the commit retry path.
    const tracked = this.git(['ls-files', '--', 'agents/*/.codex'], root);
    if (!tracked.ok || !tracked.out.trim()) return;
    this.git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', 'agents/*/.codex'], root);
    console.warn('[hive] untracked previously-committed Codex homes from the hive repo');
  }

  private readonly commitMonitor = new HiveCommitMonitor();
  private readonly loggedOversized = new Set<string>();
  private sweptOrphanTmpObjects = false;

  /** Whether the hive commit is working, for fleet.json. */
  commitHealth(): HiveCommitHealth { return this.commitMonitor.snapshot(); }

  private pendingCommits: string[] = [];
  private firstPendingAt = 0;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private committing: Promise<void> | null = null;

  /** Queue a hive commit. A burst of changes becomes one commit, run off the main
   *  thread HIVE_COMMIT_QUIET_MS after the last change (at most HIVE_COMMIT_MAX_DELAY_MS
   *  after the first): every git call used to be a spawnSync here, and a 172-patch
   *  retag froze the UI for its whole length. */
  commit(message: string): void {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git'))) return;
    const now = Date.now();
    if (this.pendingCommits.length === 0) this.firstPendingAt = now;
    this.pendingCommits.push(message);
    if (this.commitTimer) clearTimeout(this.commitTimer);
    const wait = Math.max(0, Math.min(HIVE_COMMIT_QUIET_MS, this.firstPendingAt + HIVE_COMMIT_MAX_DELAY_MS - now));
    this.commitTimer = setTimeout(() => { this.commitTimer = null; void this.flushCommits(); }, wait);
    this.commitTimer.unref?.();
  }

  /** Commit whatever is queued now. Resolves once no commit is running, so it is also
   *  the way to wait for the hive to be quiescent (quit, tests). One committer at a time. */
  async flushCommits(): Promise<void> {
    await this.flushWrites();
    if (this.commitTimer) { clearTimeout(this.commitTimer); this.commitTimer = null; }
    while (this.committing) await this.committing;
    if (this.pendingCommits.length === 0) return;
    const messages = this.pendingCommits.splice(0);
    this.committing = this.commitQueued(messages).finally(() => { this.committing = null; });
    await this.committing;
  }

  private async commitQueued(messages: string[]): Promise<void> {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git'))) return;
    this.untrackCostLedger(root);
    this.untrackCodexHomes(root);
    if (!this.sweptOrphanTmpObjects) {
      this.sweptOrphanTmpObjects = true;
      const freed = removeTmpObjects(join(root, '.git'));
      if (freed) console.warn(`[hive] removed ${freed} bytes of orphaned git tmp objects`);
    }
    const error = await this.tryCommit(root, combinedCommitMessage(messages));
    if (error === null) { this.commitMonitor.ok(); return; }
    const last = Number((await this.gitAsync(['log', '-1', '--format=%ct'], root)).out.trim());
    this.commitMonitor.fail(error, Date.now(), last > 0 ? last * 1000 : null);
    const warning = this.commitMonitor.warning();
    if (!warning) return;
    const godId = this.registry().godId ?? 'god';
    this.appendLog({ kind: 'hive-commit-failing', health: this.commitMonitor.snapshot() });
    this.deliver(this.normalize({ to: godId, act: 'inform', subject: 'Hive auto-commit is failing', body: warning, requires_reply: false }, 'harness'), godId);
  }

  /** One commit attempt with lock retries: null on success or nothing to commit, else why it failed. */
  private async tryCommit(root: string, message: string): Promise<string | null> {
    const git = (args: string[], stdin?: string) => this.gitAsync(args, root, stdin);
    for (let attempt = 0; attempt < 5; attempt++) {
      this.clearStaleLock(root);
      let added = true;
      for (const full of HIVE_COMMIT_PATHSPECS) {
        const spec = livePathspecs(root, full);
        if (spec.length === 0) continue;
        const big = await oversizedPaths(root, git, spec);
        const fresh = big.filter((p) => !this.loggedOversized.has(p));
        if (fresh.length) {
          for (const p of fresh) this.loggedOversized.add(p);
          console.warn(`[hive] not committing ${fresh.length} file(s) over ${HIVE_COMMIT_MAX_FILE_BYTES} bytes:`, fresh.join(', '));
        }
        const startedAt = Date.now();
        const add = await git(['add', '-A', '--', ...spec, ...excludePathspecs(big)]);
        if (add.ok) continue;
        added = false;
        if (add.timedOut) removeTmpObjects(join(root, '.git'), startedAt);
        if (!/index\.lock/i.test(add.err)) {
          const why = add.err.trim() || 'git add timed out';
          console.warn('[hive] commit skipped, git add failed:', why);
          return why;
        }
      }
      if (!added) { await delay(50 * (attempt + 1)); continue; }
      const startedAt = Date.now();
      const commit = await git(['commit', '-q', '-F', '-'], message);
      if (commit.ok) return null;
      if (/nothing to commit/i.test(commit.out + commit.err)) return null;
      if (commit.timedOut) removeTmpObjects(join(root, '.git'), startedAt);
      if (/index\.lock/i.test(commit.err)) { await delay(50 * (attempt + 1)); continue; }
      const why = (commit.err || commit.out).trim() || (commit.timedOut ? 'git commit timed out' : 'git commit failed');
      console.warn(`[hive] commit gave up after ${attempt + 1} attempts:`, why);
      return why;
    }
    console.warn('[hive] commit gave up after 5 attempts');
    return 'index.lock held through 5 attempts';
  }

  private clearStaleLock(root: string): void {
    const STALE_THRESHOLD_MS = 10_000;
    try {
      for (const lock of ['index.lock', 'HEAD.lock']) {
        const path = join(root, '.git', lock);
        if (existsSync(path) && Date.now() - statSync(path).mtimeMs > STALE_THRESHOLD_MS) rmSync(path);
      }
    } catch { /* noop */ }
  }
}

/** `<hive>/bin/runtime/hive-blender`: headless Blender for agents. `flatpak run` cannot start
 *  inside the agent jail (main/blenderGuard.ts refuses it there), so this runs the flatpak's own
 *  binary, which does. */
const HIVE_BLENDER_SH = `#!/bin/sh
app=org.blender.Blender
loc=$(flatpak info --show-location "$app" 2>/dev/null)
for d in "$loc" "$HOME/.local/share/flatpak/app/$app/current/active" "/var/lib/flatpak/app/$app/current/active"; do
  if [ -n "$d" ] && [ -x "$d/files/blender/blender" ]; then exec "$d/files/blender/blender" "$@"; fi
done
echo "hive-blender: the $app flatpak is not installed (flatpak install flathub $app)" >&2
exit 127
`;

// ─── PROTOCOL.md (every agent) and PROTOCOL-BOSS.md (the Boss) ─────────────

/** The Claude Code command reference written to <hive>/COMMANDS.md, rendered from
 *  the SAME source as the UI "commands" tab so they never drift. Leads with the
 *  orchestrator note: slash = own session only, cli = shell/fleet; monitor
 *  siblings via fleet.json (claude agents does NOT see them). */
function renderCommandsMd(): string {
  const lines: string[] = [
    '# Claude Code commands',
    '',
    'Reference of the Claude Code commands available to you. Two kinds:',
    '- **slash** commands act ONLY on your own session — you CANNOT run them on another agent\'s terminal.',
    '- **cli** commands run in your shell (Bash) and can target the fleet, spawn, or query.',
    '',
    'To MONITOR the other agents in this hive, read `fleet.json` in the hive root (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) plus `registry.json` — `claude agents` does NOT list your hive siblings. Use `claude -p "..." --output-format json` for a one-off headless query.',
    ''
  ];
  for (const g of COMMAND_GROUPS) {
    lines.push(`## ${g.title}`, '');
    for (const it of g.items) {
      lines.push(`- \`${it.cmd.trim()}\` _(${it.kind})_ — ${it.desc}${it.usage ? ` e.g. \`${it.usage}\`` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
const COMMANDS_MD = renderCommandsMd();

const PROTOCOL_MD = `# Hive protocol

You are one of several Claude agents sharing this hive. Coordination is entirely
file-based; the harness (main process) is the only thing that runs git and the
only thing that moves messages between agents.

## Your workspace — \`agents/<your-id>/\`
- \`identity.md\`: who you are (read-only; the harness writes it).
- \`memory.md\`: a short CURRENT digest (under 8000 chars). Read it at the start of a task; update it as you learn.
- \`memory-archive.md\`: older or superseded memory, moved out of memory.md by appending (never deleted).
- \`my-tasks.md\`: your open cards from tasks.json (the harness rewrites it; read-only).
- \`inbox/\`: messages addressed to you. Read the ones you are handed (by id) or that are pending.
- \`inbox/.done/\`: move a message here once you've handled it.
- \`outbox/\`: drop messages here to send them. The harness delivers them.

Each card starts in a fresh session. When you end a turn with a \`todo\` card to start next and none
\`doing\`, the harness closes your session and starts a new one on that card; it remembers nothing of
this one. So before you end a turn after finishing or blocking a card, keep its status (a
\`task-patch\`, below), any question for the human (sent to \`boss\` for the ASK ME card) and
\`memory.md\` current. After a done report, a written card brief and an updated memory.md, the harness also closes a finished last card; later mail wakes you fresh to answer from that handoff.

**Never write into another agent's folder.** Write to your own \`outbox/\`; the
orchestrator routes it. This keeps every file single-writer.

## Vault inbox (when \`vault-inbox/\` exists in the hive root)
\`memory.md\` is private to you and to this machine. Anything another session would need later
(a human ruling or preference, a lesson or gotcha, a project/tool/machine fact, a sourced research
finding) ALSO goes into \`vault-inbox/\` as one new markdown file named
\`<UTC yyyymmddThhmmssZ>-<your-id>-<slug>.md\`, shaped as \`vault-inbox/README.md\`
shows. File it when you learn it; do not check whether the vault already has it. The vault keeper
drains the folder, sorts new from known and writes the vault. Never edit or move another entry. Open to-dos stay on cards.

## Sending a message
Write one JSON file into \`outbox/\` (any filename ending in \`.json\`):

\`\`\`json
{
  "to": "<agent-id> | boss | broadcast",
  "act": "request | inform | propose | query | agree | refuse | done",
  "subject": "one-line summary",
  "body": "the details",
  "conversation": "carry this across a thread (optional)",
  "in_reply_to": "<message id you're replying to> (optional)"
}
\`\`\`

The Boss's messages carry its internal id in \`"from"\`. Address it as \`boss\` and
call it the Boss; never repeat that id in anything you write.

The harness fills in \`id\`, \`from\`, \`hops\`, and timestamps.

## Rules of the road
- Only \`request\`, \`query\`, and \`propose\` expect a reply. \`inform\` and \`done\` are terminal —
  don't reply to them, or two agents will loop forever.
- For anything ambiguous, cross-cutting, or needing sign-off, message \`boss\` — the
  Boss clarifies answers for you so you rarely need the human directly.
- There is NO separate human-approval queue. Human-in-the-loop is native to Claude
  Code: a tool you run that needs permission prompts in your own session (the human
  can approve it remotely from their phone via \`/remote-control\`). If you genuinely
  need a human decision, raise it with \`boss\` (a message \`"to": "human"\` is routed to
  the Boss, the human's proxy on the floor).
- \`board.md\` is the shared plan. Don't edit it directly — \`propose\` changes to \`boss\`,
  who is its sole scribe.
- Re-reading a message you already moved to \`.done/\` is a no-op. Don't reprocess.
- Headless Blender: run \`hive-blender -b ...\` (on your PATH). It runs the Blender flatpak's own
  binary; the flatpak launcher cannot start inside the agent jail, and the guard refuses it there.

## The work: board.md vs tasks.json
There are two shared surfaces, both in the hive root:
- \`board.md\` — the freeform narrative plan. The Boss is its sole scribe; others \`propose\` edits.
- \`tasks.json\` — the structured task ledger (a kanban: \`todo / doing / blocked / done\`, with title,
  assignee, priority, deps). Keep the task you're working reflected in its status.

Both files run to hundreds of KB, so never read either one whole. Your open cards are in
\`agents/<your-id>/my-tasks.md\`; read one card with \`jq '.tasks[] | select(.id=="<id>")' tasks.json\`.

## Changing a card
\`tasks.json\` is read-only for agents: the harness is its only writer, so two agents can never
overwrite each other's edit. To change one of YOUR cards, write one JSON file into \`outbox/\`:

\`\`\`json
{
  "to": "harness",
  "act": "task-patch",
  "body": { "id": "<card-id>", "status": "blocked", "notesAppend": "BLOCKED: <one-line reason>" }
}
\`\`\`

Send only the fields you change: \`status\` (\`todo\`, \`doing\` or \`blocked\`), \`notesAppend\`
(one line added to the card's notes), \`brief\` (replaces), \`briefAppend\` (appends) and \`result\` (the outcome summary). The harness applies it
within a couple of seconds and mails you back only when it refuses (not your card, a field you may
not set, a bad status). Anything else about a card, ask \`boss\`.

Only the Boss closes a card. When your work is finished, send \`boss\` a \`done\` message (sha,
verbatim test result, evidence), write your handoff \`brief\` (what was done, files/branches/commits, gotchas, decisions, how to verify, what is left), and set the card \`blocked\` with \`notesAppend\` "awaiting boss merge"
(never leave it \`doing\`: a doing card is handed back to you every turn; moving to awaiting boss merge without a written \`brief\` is refused). The Boss sets \`done\` after
reviewing and merging; a worker's \`"status": "done"\` is refused. The \`brief\` is never cleared on status changes, and the Boss closing a card keeps the brief.

Each card runs in its own fresh session. Once you hand a card on (blocked, or awaiting merge), end
your turn rather than setting your next card to \`doing\`: that edit is refused, and the harness
closes this session and starts you fresh on the next card. The fresh session's start message provides
the card description, its handoff brief and the memory.md pointer. Rework on a card this session already
worked stays here.

## Unity runs
The harness runs at most 2 agent Unity runs at once, inside Unity Personal's 3 instances with the human's
editor, and starts one run per agent every 5 minutes; a request over that waits in your queue and you
are told once. So batch every test for a change into one run, and never send a repeat run to re-check
a passing result: the result.json you already have is the answer.

## Asking the human
If you genuinely need a human decision or an action only the human can take, message \`boss\` with
the decision in one or two sentences. The Boss writes the ASK ME card and routes the answer back.

## Guardrails: circuit breaker & token budgets
A circuit breaker watches every agent for runaway behavior (looping on the same tool, error storms,
overspending). It escalates gently: \`steer\` → \`constrain\` → \`stop\`. If a \`Circuit breaker: steer\`
or \`Circuit breaker: constrain\` message lands in your inbox, you ARE the problem it caught: stop
repeating, summarize what you've tried, and do exactly what the message says (constrain = go read-only
and get the Boss's sign-off before more tool calls). Be **token-frugal**: the floor has a token budget and
each agent can have its own token limit; crossing it trips the breaker. Prefer references over pasted
content, and \`/compact\` your own session when context gets heavy.

## Semantic memory (optional, when \`mempalace\` is installed)
When \`MEMPALACE_PALACE_PATH\` is set in your environment, the hive shares a
searchable MemPalace and you have the \`mempalace\` CLI:
- \`mempalace search "<query>"\`: recall relevant past knowledge across the whole
  team by meaning (not just keywords). Add \`--wing <agent-id>\` to scope to one
  agent, \`--results N\` to widen.
- \`mempalace wake-up\`: a broad digest of what matters, for when you are lost.

Your \`memory.md\` and \`memory-archive.md\` are mined into the palace automatically, so the
durable facts you write there become searchable by every agent. You don't run \`mine\` yourself.
`;

/** Boss-only sections, kept out of PROTOCOL.md so workers do not pay for them. */
function protocolBossMarkdown(engines: ReturnType<typeof getEngines>): string {
  const PROTOCOL_BOSS_MD = `# Hive protocol: Boss sections

Read a section here when you need it. The worker rules every agent follows are in \`PROTOCOL.md\`.

## Tests-first routing
A new card starts with its failing tests, written by a tests-only writer or by a senior worker.
- A tests-only writer commits the tests and hands off (\`testsReady\` with \`then\` "handoff", or a done message naming branch and head). Either way the handoff must state the proposal steps its tests do not cover (\`uncovered\`, or a "Steps not covered by these tests" section, "none" if every step has a test); send back one that omits it. You reassign the card to a separate implementer, as before.
- A senior worker implements the same card. After committing the tests it sends \`testsReady\` with \`then\` "implement". The harness then writes its handoff and restarts it in a fresh session on the card, on its current model; it asks the human nothing, and the engine changes only when its tier walk finds that one out of quota. Do not reassign the card or restart the agent; the checkpoint owns that step.

## Closing a card
Tests-first pairs drop proposal scope when nobody compares the result to the original ask. Before you set a card (or the last card of a tests-first/implement pair) done:
1. Open the original proposal or brief, not the tests. List each numbered Work step.
2. For every step, name the shipped commit and the test or other evidence that covers it. Passing tests only prove the steps the tests were written for.
3. Read the handoff's \`uncovered\` field (\`testsReady\`) or its "Steps not covered by these tests" section (a done message). A handoff without that statement goes back to the worker to add it.
4. A step with no coverage sends the card back (status doing), or is split into a new card the human can see. Never close over it.
5. Record the map in the closing patch as a line starting \`Coverage:\` in \`result\` or \`notesAppend\` (for example "Coverage: 1 abc123 test t1; 2 def456 evidence ...; 3 ..."). The harness refuses done on a card whose tests-first handoff declared uncovered steps unless a follow-up card depends on the card or names its id in its description, or the patch carries a Coverage line. It cannot check that your map is true; that is your job.
6. **Dropping a card without merging (\`merge: false\`)**: setting \`status: "done"\` normally auto-merges the card's branch if it is not yet integrated. When closing a card as dropped (not-a-bug, wontfix, superseded, or duplicate) so its branch must stay unmerged and trigger no autobuild, pass \`merge: false\` on the done patch (\`patch_card({ id, status: "done", merge: false, result: "..." })\`). \`merge: false\` disables auto-merge on the card (including any in-flight or late worker \`done\` report), clears any pending \`approveAction\`, and skips the uncovered-steps check.

## Restarting a hung agent
A session that sits silent while it has an open doing or todo card is flagged \`STALLED\` in the hourly standup and in the \`floor\` roster row (default 45 minutes with no session activity; \`timings.stallAfterMs\`). Wake requests and mail do not reach a hung live session, so restart it with the \`restart_agent\` camp tool: \`restart_agent({ agentId, reason, force?, model? })\`. Only you may call it, never on yourself.
- The harness writes the agent's handoff first (your reason, its card and brief, its last activity), ends the session's whole process tree, and starts a fresh session on its current card (its doing card, else its first todo). Without \`model\` the fresh session uses the next entry on the agent's tier walk (\`ladder\` in \`fleet.json\`), or the same entry again when it is the last or no later one can launch; \`model\` is \`{ provider, model }\` and must be one the agent can launch.
- An agent with session activity in the last \`timings.restartRecentActivityMs\` (default 10 minutes), or with no activity reading at all, is refused unless you pass \`force: true\`. A restart is also refused during closing time, while a model switch for the agent is in flight, and (without force) while the agent is held at a usage limit.
- The outcome comes back as an inform; a refusal names the reason and nothing was touched. Success is logged to \`log.jsonl\` as \`agent-restart\` (who, agentId, reason, oldModel, newModel) and noted on the card.

## Holding Unity
To stop all Unity launches, call the \`unity_hold\` camp tool: \`unity_hold({ action: 'set', reason, allow? })\`, and \`unity_hold({ action: 'clear' })\` to lift it. The broker reads \`unity-hold.json\` in the hive root at every request, so it takes effect at once with no restart. While it is set every run request fails before Unity starts (logged as \`unity-run\` ok:false, reason \`unity-hold: <reason>\`) and the requester is told; \`allow\` lists agent ids that may still run. A broadcast alone does not stop runs.

## Retiring an agent
Archive an old temp worker you no longer need with the \`archive_agent\` camp tool: \`archive_agent({ agentId, reason? })\`. Only you may call it, never on yourself. Archiving keeps the agent's folder, history and registry entry; it leaves the floor, \`fleet.json\` and the live roster, and mail no longer wakes it. The human can reopen it from the Archived list.
- Refused for an agent with an open todo or doing card (reassign or finish those first), for one already archived, and for one with a live terminal session (The human closes its tab instead).
- The outcome comes back as an inform; a refusal names the reason and nothing was touched. Logged to \`log.jsonl\` as \`archive-agent\`.

## Creating and changing cards
Use the \`create_card\` and \`patch_card\` camp MCP tools to manage cards. They enforce valid project names (the list is \`<hive>/projects.json\`; the tool schemas show it) and prevent clearing assignees.

To assign work to an agent, use the \`dispatch\` camp tool with a 4-part contract (objective, output, tools, boundaries). It writes the contract to the card and respawns the worker fresh on the card without sending duplicate direct messages.

**Set \`difficulty\` (\`easy\` | \`normal\` | \`hard\`) on a card when it is clearly not normal work**, or
\`null\` to clear it. It picks the assignee's model and effort at its next fresh session, never mid-session:
hard starts its tier walk on the strong tier at xhigh effort (Codex stays at medium), easy on the light tier at medium
effort, and normal or absent on the agent's own tier. Usage headroom still overrides it, and with several open cards the
hardest one wins. A spawn-request takes the same field (hard tries its \`engines\` from the strongest end).

**Set \`kind\` on a card** (${WORK_KIND_GUIDE}) so the camp can keep an engine's quota for the work the human reserved it for (config \`reservations\`). A reserved engine is dropped for cards of any other kind, and for cards with no kind; a spawn-request takes \`kind\` too.
A tier entry may carry a cap (\`maxPercent\`, set by the human): it is skipped once its meter reaches that percent, in place of
the global cutoff. A spawn-request's \`engines\` item takes a cap as \`"codex@50"\`.

## Asking the human (the ASK ME card)
\`ask_human\` takes a required \`kind\`, and ASK ME holds only decisions:
- \`kind: "decision"\`: work waits on the human's answer (a choice, a sign-off, an action only they can do). It blocks the card and appends to \`humanQA\`. Pass \`answers\`: \`"yes_no"\` or the option labels as written in the question (\`["A","B"]\`). A merge sign-off with \`on_approve\` is always a decision.
- \`kind: "result"\`, \`label: "answer"\` or \`"check"\`: nothing to reply to. The answer to a question the human asked you (label answer), or a final check that passed, e.g. "merged, try it in the editor" (label check). It lands on the Results tab, leaves the card status alone and never supersedes an open decision.
If you could not name the options the human would pick between, it is a result. Both kinds validate length (~700 chars) and bold first sentence, and embed images (\`shots/\`) and videos (backticked absolute paths) so they render on desktop and phone.

To move existing notices off ASK ME once, write \`results-migration.json\` in the hive root: \`{"cards":[{"id":"<card>","label":"answer|check"}]}\`, naming only cards whose open ask is a notice. The next Camp start backs up tasks.json, moves each listed card's open ask to its results, logs the count and renames the file.

When the ask originates in another agent's report, rewrite it to focus on the decision. Never sit idle waiting for a reply — move on to other work and pick the answer up when it arrives.

## Integrating branches
Use the \`merge\` camp tool (\`merge(repo, worktree, branch, target)\`) to merge completed agent worktrees into the target branch. It fetches from the worktree, verifies no dirty target files conflict with incoming changes, and performs a fast-forward (or cherry-picks if target moved), then pushes the target to its upstream, returning the new head and \`push\` (\`pushed\`, \`no-upstream\` or \`failed\`). A \`failed\` push leaves the merge in place: never force-push, and tell the human on the ASK ME card with the \`pushError\` text instead of closing the card as if it were published.

## The Backlog (cards shelved for later)
When the human shelves a card (\`BACKLOG:\` mail, or they ask you to), set \`backloggedAt\` to the current ISO
time with \`"status": "blocked"\`. The card leaves ASK ME and shows in the Backlog tab, grouped by project.
Never work, assign or reopen a backlogged card; the human brings it back from the Backlog tab, which clears
\`backloggedAt\` and mails you, and then you re-plan it. Send \`"backloggedAt": null\` to bring one back
yourself only when the human asks.

\`\`\`json
{ "to": "harness", "act": "task-patch",
  "body": { "id": "<card-id>", "status": "blocked", "backloggedAt": "<iso time>", "notesAppend": "BACKLOG (The human): <why>" } }
\`\`\`

## Fleet monitoring (orchestrator)
You (the boss) are responsible for situational awareness. Use the \`floor\` camp tool for a compact, live overview of fleet tokens, status, breakers, and open cards in a single quick call. You can also inspect \`fleet.json\`, \`registry.json\`, or an individual agent's \`memory.md\` when deeper investigation is needed. A full Claude Code command reference (slash = your own session only; CLI = your shell, can target the fleet) is in \`COMMANDS.md\`.

## Changing an agent's model tier (orchestrator)
The human keeps three camp-wide model lists, strong, medium and light (config \`modelTiers\`, set in Settings > AI Engines;
you cannot edit them). Each agent has a \`tier\`. A fresh session starts on the agent's tier (a hard card on strong, an
easy card on light), balances inside that tier by usage headroom, and moves to the next tier down only when no entry in
it has room; it climbs back up only as far as the agent's own tier. When every entry on the walk is capped, spent or
refused, the agent waits and its card says why. Each agent row in \`fleet.json\` carries \`tier\` and \`ladder\`: its
normal-card walk, in order. To move one agent to another tier, or several at once with \`"ids": ["<id1>", "<id2>"]\`,
write ONE JSON file in your \`outbox/\` addressed to \`harness\`:

\`\`\`json
{ "to": "harness", "act": "agent-config", "body": { "id": "<agent-id>", "tier": "light" } }
\`\`\`

Include \`"provider"\` / \`"model"\` to change its current engine as well. \`ladder\` and \`models\` are refused: per-agent
ladders were replaced by the tiers. The harness validates with the same rules as the Edit Agent modal (such as sandbox
compatibility and Boss inbox capability), updates the UI store and \`fleet.json\` immediately, and logs \`agent-config\`
in \`log.jsonl\`. Bad input or a non-Boss sender is refused with the reason delivered to the sender's \`inbox/\`. Changes
apply at the agent's next fresh session, never mid-session.

## Dormant agents (orchestrator)
At app launch only the Boss starts. Every other roster agent is **dormant**: it stays in \`fleet.json\`
with \`"dormant": true\`, has no session, and costs nothing. Dormant is not stalled, so a standup
does not re-engage it. A worker that reports done and saves its brief and memory is parked after its turn ends, even on its last card. Later mail wakes it fresh. When a live worker is about
to start a new card, the harness closes its session and wakes it fresh on that card (\`card-close\`
then \`spawn\` in \`log.jsonl\`), so each card runs in a new session on the engine the balancer picks.

The harness starts a dormant agent by itself, within seconds, when it has work:
- a card in \`tasks.json\` with \`"assignee"\` set to its id and \`"status"\` \`todo\` or \`doing\`; or
- unread mail addressed to it directly in its \`inbox/\`.

A \`blocked\` card (waiting on the human) does not wake it. A broadcast skips it entirely: only agents
with a live session receive one, and nothing is written to a sleeper's inbox. When a notice must reach
the sleepers too, add \`"includeDormant": true\` to the broadcast message; each dormant agent then finds
it in its inbox when it next starts, and the broadcast still does not wake it. So dispatch to a dormant
agent exactly as to a live one. To wake one with neither, write ONE JSON file \`wake-requests/<agentId>.json\` in the hive root, optionally
\`{ "reason": "why" }\`; the harness moves it to \`wake-requests/.done/\` (or \`.failed/\` with a reason
for an unknown id) and the agent starts fresh, handed your reason and its work by id.

## Spawning a worker (orchestrator)
You can start an ephemeral worker yourself. Write ONE JSON file into \`spawn-requests/<id>.json\` in
the hive root:

\`\`\`json
{
  "objective": "what the worker must do (required)",
  "cwd": "/absolute/path/to/the/repo (required)",
  "name": "display name (optional)",
  "command": "engine CLI (optional; defaults to the configured one)",
  "provider": "claude | codex | cursor | antigravity | … (optional)",
  "engines": ${JSON.stringify(PROMPT_ENGINE_ORDER)},
  "model": "model override (optional)",
  "isolate": true,
  "tokenCap": 0,
  "difficulty": "easy | normal | hard (optional)",
  "kind": "${WORK_KINDS.join(' | ')} (optional)",
  "slack": { "channel": "C…", "thread_ts": "…" },
  "character": "meredith",
  "accent": "coral"
}
\`\`\`

${formatEnginePromptProse(engines, true)}

The harness polls that directory, spawns \`worker-<id>\`, and moves the request to
\`spawn-requests/.done/\` once it starts or to \`spawn-requests/.failed/\` with a reason. \`isolate\`
defaults to true, giving the worker its own git worktree. \`slack\` routes its failures back to a
thread. This is the ONLY spawn route you can complete on your own: a hire manifest under
\`research/hires/\` needs the human to confirm it in the UI.

\`character\` and \`accent\` set how the worker looks on the office floor, and both are optional.
Naming a worker after a cast member already gets you that avatar, so you only need \`character\` when
the name and the face should differ. An unrecognised value falls back rather than failing the spawn.

**It can be switched off.** The operator controls this under Settings → Autonomy & Budgets, and it is
OFF by default, because every worker you start spends tokens nobody approved. While it is off your
request is NOT failed or deleted, it waits in \`spawn-requests/\` and runs if the operator turns it on.
If a request of yours has sat there without moving, that is why, and it is a decision to raise with the
human rather than retry. Route work to an agent already on the floor first either way.
`;
  return PROTOCOL_BOSS_MD;
}

// ─── cth-hook shim (written to <hive>/bin/cth-hook.cjs) ──────────────────────
// A minimal pipe: read the hook payload on stdin, tag it with this agent's id,
// forward it to the hive's UDS, and relay the response back to `claude`. All the
// real logic lives in the main process (HookServer). Never blocks a stop on error.
const HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const isStatus = process.argv.includes('--status');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  if (!payload.agent_id) payload.agent_id = process.env.AGENT_ID || null;
  const sock = process.env.HIVE_SOCK;
  if (isStatus) {
    // Status-line mode: Claude Code pipes the session status JSON (incl.
    // context_window.total_input_tokens / .context_window_size) after every
    // response. Print the in-terminal gauge IMMEDIATELY (the TUI is waiting),
    // then forward the payload to the harness fire-and-forget so the agent
    // card's context gauge updates push-based, with the EXACT window size.
    payload.hook_event_name = 'Status';
    const cw = payload.context_window || {};
    const used = cw.total_input_tokens, size = cw.context_window_size;
    if (typeof used === 'number' && typeof size === 'number' && size > 0) {
      const pct = Math.round((used / size) * 100);
      process.stdout.write('ctx ' + Math.round(used / 1000) + 'k/' + Math.round(size / 1000) + 'k (' + pct + '%)');
    }
    if (sock) {
      try {
        const c = net.createConnection(sock, () => { c.end(JSON.stringify(payload) + '\\n'); });
        c.on('error', () => {});
        c.on('close', () => process.exit(0));
      } catch (_) { process.exit(0); }
    } else {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 1500).unref();
    return;
  }
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
`;

// ─── agy-hook shim (written to <hive>/bin/agy-hook.cjs) ──────────────────────
// Antigravity's `agy` CLI fires lifecycle hooks (PreToolUse/PostToolUse/Stop/
// PreInvocation/PostInvocation) but with a DIFFERENT stdin shape than Claude
// (conversationId / toolCall{name,args} / workspacePaths, and no hook_event_name
// — the event arrives as argv from the hooks.json command). This shim normalizes
// that into the same HookPayload the HookServer already consumes, so status,
// inbox-drain-on-Stop, and tool gating are reused UNCHANGED, then translates the
// server's Claude-shaped response back into agy's stdout contract (decision:
// allow|deny|block + a message). Scoped by AGENT_ID: a personal agy session
// (no AGENT_ID in env) is a no-op, so the global hooks.json never disturbs the
// user's own agy usage — only hive workers (spawned with AGENT_ID set) bridge.
// NOTE (agy bug, antigravity-cli#49): the loader reads ~/.gemini/antigravity-cli/
// hooks.json but the trigger reads ~/.gemini/config/hooks.json — we write BOTH.
const AGY_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const event = process.argv[2] || 'Unknown';
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); } // not a hive worker → ignore
  let agy = {};
  try { agy = JSON.parse(data || '{}'); } catch (_) {}
  const tc = agy.toolCall || {};
  const payload = {
    hook_event_name: event,
    agent_id: agentId,
    session_id: agy.conversationId,
    transcript_path: agy.transcriptPath,
    cwd: Array.isArray(agy.workspacePaths) ? agy.workspacePaths[0] : undefined,
    tool_name: tc.name,
    tool_input: tc.args
  };
  let resp = '';
  const done = () => {
    // Translate the HookServer's Claude-shaped reply into agy's contract. CRITICAL:
    // agy treats ANY object written to stdout as a decision and FAIL-CLOSES (an
    // empty/decision-less object = DENY). So emit JSON ONLY when there's a real
    // directive (deny/block/steer); otherwise write NOTHING — no output = allow.
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.decision === 'block') out = { decision: 'block', reason: r.reason, stopReason: r.reason, systemMessage: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      else if (r.continue === false) out = { decision: 'block', stopReason: r.stopReason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) out = { systemMessage: r.hookSpecificOutput.additionalContext };
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;

// ─── pi bridge extension (written to <agentDir>/.pi-agent/extensions/) ───────
// A bundled extension for Pi (earendil-works). Pi exposes a pi.on(event,…)
// lifecycle; this posts cth-hook-shaped payloads to HIVE_SOCK on tool_call /
// tool_result / agent_end and AUTO-APPROVES tool calls when the floor is in auto
// mode (HIVE_AUTO_APPROVE, gated by config.autoMode — Pam guardrail #5). The
// agent_end→Stop keeps the harness status in step (→ idle) so the renderer idle
// inbox-wake nudge can deliver mail. Fully wrapped so a wrong API guess can never
// break the spawn. LIVE-UNVERIFIED (Pi's exact extension surface needs BYOK keys).
const PI_EXTENSION = `'use strict';
var net = require('node:net');
var SOCK = process.env.HIVE_SOCK;
var AGENT = process.env.AGENT_ID || null;
var AUTO = process.env.HIVE_AUTO_APPROVE === '1';
function post(payload) {
  try {
    if (!SOCK) return;
    payload.agent_id = payload.agent_id || AGENT;
    var c = net.createConnection(SOCK, function () { try { c.end(JSON.stringify(payload) + '\\n'); } catch (e) {} });
    c.on('error', function () {});
  } catch (e) {}
}
function register(pi) {
  if (!pi || typeof pi.on !== 'function') return false;
  try {
    pi.on('tool_call', function (ev) {
      post({ hook_event_name: 'PreToolUse', tool_name: ev && (ev.name || (ev.tool && ev.tool.name)), tool_input: ev && (ev.args || ev.input) });
      if (AUTO) { try { if (ev && typeof ev.approve === 'function') ev.approve(); } catch (e) {} return { approve: true }; }
      return undefined;
    });
    pi.on('tool_result', function (ev) { post({ hook_event_name: 'PostToolUse', tool_name: ev && (ev.name || (ev.tool && ev.tool.name)) }); });
    pi.on('agent_end', function () { post({ hook_event_name: 'Stop' }); });
    return true;
  } catch (e) { return false; }
}
try { if (typeof globalThis !== 'undefined' && globalThis.pi) register(globalThis.pi); } catch (e) {}
module.exports = function (pi) { return register(pi); };
module.exports.activate = function (pi) { return register(pi); };
module.exports.default = module.exports;
`;

// ─── opencode bridge plugin (written to <agentDir>/.opencode/plugin/) ────────
// A bundled plugin for OpenCode (anomalyco/opencode) — god Decision 1. OpenCode
// has no Claude-shaped Stop hook but its plugin API exposes a real session.idle
// event; this posts cth-hook-shaped payloads to HIVE_SOCK on tool.execute.before/
// after + session.idle. The session.idle→Stop keeps status in step (→ idle) so the
// renderer idle inbox-wake nudge delivers mail. ESM (OpenCode runs on Bun). Fully
// wrapped. LIVE-UNVERIFIED (plugin auto-load + session.idle firing need BYOK keys).
const OPENCODE_PLUGIN = `import { createConnection } from 'node:net';
const SOCK = process.env.HIVE_SOCK;
const AGENT = process.env.AGENT_ID || null;
function post(payload) {
  try {
    if (!SOCK) return;
    payload.agent_id = payload.agent_id || AGENT;
    const c = createConnection(SOCK, () => { try { c.end(JSON.stringify(payload) + '\\n'); } catch (e) {} });
    c.on('error', () => {});
  } catch (e) {}
}
export const HiveBridge = async () => {
  return {
    event: async (input) => {
      try { if (input && input.event && input.event.type === 'session.idle') post({ hook_event_name: 'Stop' }); } catch (e) {}
    },
    'tool.execute.before': async (input) => {
      try { post({ hook_event_name: 'PreToolUse', tool_name: input && (input.tool || input.name) }); } catch (e) {}
    },
    'tool.execute.after': async (input) => {
      try { post({ hook_event_name: 'PostToolUse', tool_name: input && (input.tool || input.name) }); } catch (e) {}
    }
  };
};
export default HiveBridge;
`;

// ─── proxy-bridge sidecar (written to <hive>/bin/hive-proxy.cjs) ─────────────
// One per proxy-tier agent (qwen). A dependency-free, loopback-only reverse
// proxy: the agent's CLI is pointed at this (via ANTHROPIC_BASE_URL/OPENAI_BASE_URL),
// and it forwards every request to the user's real upstream UNCHANGED (headers,
// body, streaming). It TEES each response to synthesize the same HIVE_SOCK payloads
// the hook shims emit — Status (context gauge), PostToolUse (breaker), Stop (idle
// drain), and the new CostSample (cost ledger) — so a hookless CLI becomes a hive
// citizen. NEVER logs bodies or keys; the captured body is parsed in-memory and
// dropped. Idle is heuristic: a turn that ends with no tool call and no new request
// within an ~800ms debounce → Stop (a new request cancels it).
const PROXY_BRIDGE_SHIM = `#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

const SOCK = process.env.HIVE_SOCK;
const AGENT_ID = process.env.AGENT_ID || null;
const UPSTREAM = process.env.UPSTREAM_BASE_URL || '';
const SESSION = process.env.HIVE_PROXY_SESSION || null;
const API = process.env.HIVE_PROXY_API === 'anthropic' ? 'anthropic' : 'openai';

function trimSlash(s) { while (s.length && s.charAt(s.length - 1) === '/') s = s.slice(0, -1); return s; }

// Per-model context-window size for the Status gauge; fallback 200k.
function ctxSize(model) {
  const m = String(model || '').toLowerCase();
  if (m.indexOf('[1m]') !== -1 || m.indexOf('-1m') !== -1) return 1000000;
  if (m.indexOf('claude') !== -1) return 200000;
  if (m.indexOf('gpt-4o') !== -1 || m.indexOf('gpt-4.1') !== -1 || m.indexOf('o1') !== -1 || m.indexOf('o3') !== -1) return 128000;
  if (m.indexOf('qwen') !== -1) return 262144;
  return 200000;
}

// Fire-and-forget emit of a shim-shaped payload to the hive socket. Never throws.
function emit(payload) {
  if (!SOCK) return;
  try {
    const c = net.createConnection(SOCK, function () { c.end(JSON.stringify(payload) + '\\n'); });
    c.on('error', function () {});
  } catch (e) {}
}

let stopTimer = null;
function armStop() {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(function () {
    stopTimer = null;
    emit({ hook_event_name: 'Stop', agent_id: AGENT_ID, session_id: SESSION });
  }, 800);
  if (stopTimer.unref) stopTimer.unref();
}
function cancelStop() { if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; } }

function safeArgs(s) {
  if (s == null) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return { _raw: String(s).slice(0, 500) }; }
}

// Parse a completed response (single JSON or an SSE stream) and synthesize events.
function parseAndEmit(bodyStr, isSse) {
  const objs = [];
  if (isSse) {
    const lines = bodyStr.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const idx = ln.indexOf('data:');
      if (idx === -1) continue;
      const data = ln.slice(idx + 5).trim();
      if (!data || data === '[DONE]') continue;
      try { objs.push(JSON.parse(data)); } catch (e) {}
    }
  } else {
    try { objs.push(JSON.parse(bodyStr)); } catch (e) {}
  }
  if (!objs.length) { armStop(); return; }

  let model = null, input = 0, output = 0, cacheRead = 0, cacheCreation = 0, sawUsage = false;
  const toolCalls = [];
  const oaiTools = {}; // accumulate streaming openai tool_calls by index

  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (!o || typeof o !== 'object') continue;
    if (o.model) model = o.model;
    if (API === 'anthropic') {
      if (o.type === 'message_start' && o.message) {
        if (o.message.model) model = o.message.model;
        const u = o.message.usage || {};
        input += u.input_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'message_delta' && o.usage) {
        output += o.usage.output_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'content_block_start' && o.content_block && o.content_block.type === 'tool_use') {
        toolCalls.push({ name: o.content_block.name, input: o.content_block.input || {} });
      } else if (o.usage && !o.type) {
        // non-streaming full message body
        const u = o.usage;
        input += u.input_tokens || 0;
        output += u.output_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      }
      if (Array.isArray(o.content)) {
        for (let j = 0; j < o.content.length; j++) {
          const blk = o.content[j];
          if (blk && blk.type === 'tool_use') toolCalls.push({ name: blk.name, input: blk.input || {} });
        }
      }
    } else {
      if (o.usage) {
        const u = o.usage;
        input += u.prompt_tokens || 0;
        output += u.completion_tokens || 0;
        if (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) cacheRead += u.prompt_tokens_details.cached_tokens;
        sawUsage = true;
      }
      const choices = o.choices || [];
      for (let c = 0; c < choices.length; c++) {
        const ch = choices[c];
        if (!ch) continue;
        if (ch.message && Array.isArray(ch.message.tool_calls)) {
          for (let t = 0; t < ch.message.tool_calls.length; t++) {
            const tc = ch.message.tool_calls[t];
            if (tc && tc.function) toolCalls.push({ name: tc.function.name, input: safeArgs(tc.function.arguments) });
          }
        }
        if (ch.delta && Array.isArray(ch.delta.tool_calls)) {
          for (let t = 0; t < ch.delta.tool_calls.length; t++) {
            const tc = ch.delta.tool_calls[t];
            if (!tc) continue;
            const k = (tc.index != null ? tc.index : t);
            if (!oaiTools[k]) oaiTools[k] = { name: null, args: '' };
            if (tc.function) {
              if (tc.function.name) oaiTools[k].name = tc.function.name;
              if (tc.function.arguments) oaiTools[k].args += tc.function.arguments;
            }
          }
        }
      }
    }
  }
  const keys = Object.keys(oaiTools);
  for (let i = 0; i < keys.length; i++) {
    const t = oaiTools[keys[i]];
    if (t.name) toolCalls.push({ name: t.name, input: safeArgs(t.args) });
  }

  if (sawUsage) {
    emit({ hook_event_name: 'Status', agent_id: AGENT_ID, context_window: { total_input_tokens: input + cacheRead + cacheCreation, context_window_size: ctxSize(model) } });
    emit({ hook_event_name: 'CostSample', agent_id: AGENT_ID, session_id: SESSION, model: model, input: input, output: output, cache_read: cacheRead, cache_creation: cacheCreation });
  }
  if (toolCalls.length) {
    cancelStop(); // a tool call means the turn continues
    for (let i = 0; i < toolCalls.length; i++) {
      emit({ hook_event_name: 'PostToolUse', agent_id: AGENT_ID, session_id: SESSION, tool_name: toolCalls[i].name, tool_input: toolCalls[i].input });
    }
  } else {
    armStop();
  }
}

let upstreamUrl = null;
try { upstreamUrl = new URL(UPSTREAM); } catch (e) {}

const server = http.createServer(function (req, res) {
  cancelStop(); // a new request means the turn is still going
  if (!upstreamUrl) { res.statusCode = 502; res.end('proxy: no upstream'); return; }
  let target;
  try { target = new URL(trimSlash(UPSTREAM) + req.url); } catch (e) { res.statusCode = 502; res.end('proxy: bad url'); return; }
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  const headers = Object.assign({}, req.headers);
  headers.host = target.host;
  // Ask upstream for plaintext so the tee can parse SSE/JSON reliably; the client
  // gets uncompressed bytes (loopback — negligible) and no content-encoding to undo.
  delete headers['accept-encoding'];
  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    method: req.method,
    path: target.pathname + target.search,
    headers: headers
  };
  const upReq = lib.request(opts, function (upRes) {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    const ct = String((upRes.headers['content-type'] || ''));
    const wantParse = ct.indexOf('json') !== -1 || ct.indexOf('event-stream') !== -1;
    const isSse = ct.indexOf('event-stream') !== -1;
    const chunks = [];
    let total = 0;
    upRes.on('data', function (chunk) {
      res.write(chunk); // stream straight through to the CLI
      if (wantParse && total < 4194304) { chunks.push(chunk); total += chunk.length; }
    });
    upRes.on('end', function () {
      res.end();
      if (wantParse && chunks.length) {
        try { parseAndEmit(Buffer.concat(chunks).toString('utf8'), isSse); } catch (e) {}
      }
    });
    upRes.on('error', function () { try { res.end(); } catch (e) {} });
  });
  upReq.on('error', function () { try { res.statusCode = 502; res.end('proxy: upstream error'); } catch (e) {} });
  req.pipe(upReq);
});

server.on('error', function () {
  try { process.stdout.write(JSON.stringify({ port: 0 }) + '\\n'); } catch (e) {}
  process.exit(0);
});
server.listen(0, '127.0.0.1', function () {
  const addr = server.address();
  const port = (addr && typeof addr === 'object') ? addr.port : 0;
  try { process.stdout.write(JSON.stringify({ port: port }) + '\\n'); } catch (e) {}
});
`;

// Official Gemini CLI bridge. Gemini already sends snake_case payload fields;
// normalize its event names, then translate HookServer decisions back into
// Gemini's documented hook output contract.
const GEMINI_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); }
  let gemini = {};
  try { gemini = JSON.parse(data || '{}'); } catch (_) {}
  const names = {
    SessionStart: 'SessionStart',
    BeforeAgent: 'UserPromptSubmit',
    BeforeTool: 'PreToolUse',
    AfterTool: 'PostToolUse',
    AfterAgent: 'Stop'
  };
  const payload = {
    ...gemini,
    hook_event_name: names[gemini.hook_event_name] || gemini.hook_event_name || 'Unknown',
    agent_id: agentId
  };
  let resp = '';
  const done = () => {
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.continue === false) out = { continue: false, stopReason: r.stopReason };
      else if (r.decision === 'block') out = { decision: 'deny', reason: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') {
        out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      } else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) {
        out = { hookSpecificOutput: { additionalContext: r.hookSpecificOutput.additionalContext } };
      }
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;

// ─── grok-hook shim (written to <hive>/bin/grok-hook.cjs) ───────────────────
// Grok's lifecycle events and decisions are Claude-compatible, but the wire
// payload is camelCase and uses snake_case event values. Normalize the input for
// HookServer and translate its Claude-style permission denial into Grok's direct
// decision form. Scoped by AGENT_ID so the trusted global hook is inert outside
// Munder-spawned workers.
const GROK_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); }
  let grok = {};
  try { grok = JSON.parse(data || '{}'); } catch (_) {}
  const names = {
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    post_tool_use_failure: 'PostToolUseFailure',
    permission_denied: 'PermissionDenied',
    stop: 'Stop',
    stop_failure: 'StopFailure',
    session_start: 'SessionStart',
    session_end: 'SessionEnd',
    user_prompt_submit: 'UserPromptSubmit',
    notification: 'Notification',
    subagent_start: 'SubagentStart',
    subagent_stop: 'SubagentStop',
    pre_compact: 'PreCompact',
    post_compact: 'PostCompact'
  };
  const payload = {
    hook_event_name: names[grok.hookEventName] || grok.hookEventName || 'Unknown',
    agent_id: agentId,
    session_id: grok.sessionId,
    cwd: grok.cwd || grok.workspaceRoot,
    tool_name: grok.toolName,
    tool_input: grok.toolInput,
    stop_hook_active: grok.stopHookActive,
    prompt: grok.prompt,
    source: grok.source,
    notification_type: grok.notificationType,
    message: grok.message
  };
  let resp = '';
  const done = () => {
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.continue === false) out = { continue: false, stopReason: r.stopReason };
      else if (r.decision === 'block') out = { decision: 'block', reason: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') {
        out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      } else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) {
        out = r;
      }
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;

let codexFeatures: Promise<string> | null = null;

/** `codex features list` output, run once per app run and shared by every Codex spawn;
 *  '' when it fails, which leaves the native tools out of the prompt. */
function codexFeatureListing(): Promise<string> {
  codexFeatures ??= new Promise((done) => {
    execFile(resolveCommand('codex'), ['features', 'list'], { timeout: 10_000 }, (err, stdout) => done(err ? '' : String(stdout)));
  });
  return codexFeatures;
}

/** Codex's own view of a home's hooks, from a short-lived `codex app-server` over stdio
 *  (no model call). The server answers asynchronously and exits on EOF, so stdin stays
 *  open until the reply lands. [] on any failure or after the timeout. */
function listCodexHooks(home: string, timeoutMs = 15_000): Promise<ListedCodexHook[]> {
  return new Promise((done) => {
    let settled = false;
    let buf = '';
    const run = inAgentScope(resolveCommand('codex'), ['app-server']);
    const child = spawn(run.file, run.args, {
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const finish = (hooks: ListedCodexHook[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      done(hooks);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    child.on('error', () => finish([]));
    child.on('exit', () => finish([]));
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { id?: number; result?: { data?: Array<{ hooks?: ListedCodexHook[] }> } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin?.write(JSON.stringify({ method: 'initialized' }) + '\n');
          child.stdin?.write(JSON.stringify({ id: 2, method: 'hooks/list', params: { cwds: [home] } }) + '\n');
        } else if (msg.id === 2) {
          finish((msg.result?.data ?? []).flatMap((d) => d.hooks ?? []));
        }
      }
    });
    child.stdin?.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'munder-difflin', version: '0' } } }) + '\n');
  });
}
