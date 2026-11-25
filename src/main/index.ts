import { setStallSink } from './stallProbeInstall';
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, powerSaveBlocker, screen, shell, Notification } from 'electron';
import { SNIP_DEFAULTS_VERSION, migratedSnipHotkey, snipHotkeyOf } from '../shared/snip';
import { keepRendererConsoleLine } from '../shared/rendererLog';
import { readCinnamonBindings } from './cinnamonKeys';
import { createSnipHotkey } from './snipHotkey';
import { createSnipSession, type SnipOutcome } from './snipSession';
import { createSnipWindows, snipContextDeps, snipSessionDeps } from './snip';
import { fileSnipCard } from './snipCard';
import { enqueueToPrimary, isDesktopSender, publishedState, registerDesktopMode } from './desktop';
import { brandTitle, installedThemePacks, readThemePackAsset, scanThemePacks, setInstalledThemePacks, themePacksDir, type InstalledThemePack } from './themePacks';
import { loadRendererView } from './campRenderer';
import { attachRendererRecovery } from './rendererRecovery';
import { CampBuildQueue } from './campBuildQueue';
import { CampRestartController, readCampBuildSha, readCampRestartArgs, recordCampRestartStartup, type PreparedWatchdog, type RestartResult, type WatchdogRequest } from './campRestart';
import { beginCampActivity, campActivityInProgress, campBuildLocked } from './campActivity';
import { newPhoneToken, startPhoneServer } from './phone';
import { actionSince } from './agentActionClock';
import { createFeedbackCardPayload, dismissFeedbackReport, listFeedbackReports, saveFeedbackNote, type FeedbackReport } from '../shared/feedbackBoard';
import { createPromptSubmitWatch, pressEnterUntilSubmitted, SUBMIT_CONFIRM_MS } from '../shared/promptSubmit';
import { isEffortLevel, type EffortLevel } from '../shared/effort';
import { difficultyEffort, ledgerEffort, engineOrderFor, isDifficulty, DIFFICULTIES, type Difficulty } from '../shared/difficulty';
import { applyCodexNetwork, applyCodexSandbox, codexSandboxLevelFor } from '../shared/codexSandbox';
import { exportWorkspaceRoot, hiveScratchRoot, strayWatchDirs } from './workspacePaths';
import { loadMergeRepos } from './hiveProjects';
import { exportHumanName } from './humanName';
import { UnityBroker, earlyoomJournalArgs, stopAllUnityDisplays } from './unityBroker';
import { isJailed, jailAvailable, jailSupports, JAIL_PROVIDERS, jailPlan, installJailNet, jailLoopbackPorts, JAIL_NET_SOCK, JAIL_PROXY_PORT, PROVIDER_NET_HOSTS, reportJailDeny } from './agentJail';
import { JailRefusals, jailRefusalNotice } from './jailRefusals';
import { startJailProxy } from './jailProxy';
import { DropFolderWatcher, getDropFolders } from './dropFolders';
import { applyAskAnswers } from './askRelay';
import { UNITY_RESULTS_PRUNE_EVERY_MS, pruneUnityResults, unityResultsDirs } from './unityResultsPrune';
import { CrashTracker, crashNotice } from './crashRevive';
import { execFile, spawn } from 'node:child_process';
import {
  rmSync, existsSync, readFileSync, readdirSync, statSync, cpSync, writeFileSync, appendFileSync,
  unlinkSync, mkdirSync, renameSync, createWriteStream, copyFileSync, openSync, readSync, closeSync, realpathSync
} from 'node:fs';
import { open as openAsync, realpath, stat as statAsync } from 'node:fs/promises';
import { fileOpenRoute } from '../shared/fileOpenRoute';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { join, resolve, sep, basename, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { PtyManager, type SpawnOptions } from './pty';
import { resolveCommand as resolveCliCommand, isSafeCommandName, userShellPath } from './shellEnv';
import { initAutoUpdater, abortPendingRestart } from './updater';
import { initClaudeLimits, readClaudeLimits, readClaudeResetGrants, ClaudeResetGrantNotices } from './claudeLimits';
import { initCodexLimits, recentDateDirs, CodexResetCreditNotices, type CodexLimits } from './codexLimits';
import { initAgyQuota, readLastAgyQuota } from './agyQuota';
import { formatAllLimits } from '../shared/engineLimits';
import { AgyRefusalStore, noticeKey } from './agyRefusals';
import { readAgyRefusals } from './agyRefusalDb';
import { NoProgressWatch, noProgressReason } from './quotaWatch';
import { AgyRefusalTerminal } from './agyRefusalTerminal';
import { agyPoolWindows, bindingRemaining, type AgyQuota } from './agyQuotaParse';
import { escalationLedger, pickAgentEntry, pickByTier } from './tierPick';
import { TIERS, TIER_LABEL, agentTierOf, cardEscalation, isTier, needsTierMigration, parseModelTiers, planTierMigration, resolveAgentWalk, validateModelTiers, withTopTier, type AgentWalk, type Escalation, type Tier } from '../shared/modelTiers';
import { isWorkKind, workKindError, type WorkKind } from '../shared/workKind';
import { applyReservations, parseReservations } from '../shared/reservations';
import { ReservationExpiryNotices } from './reservationExpiry';
import { isWeakModel } from '../shared/modelStrength';
import { modelCatalogWarnings, resolveNamedModel } from '../shared/modelCatalogCheck';
import { chooseEngine, getEngines, getEngineThresholds, engineFor, FIVE_HOURS_MS, limitSwitchPick, lockoutText, engineRefId, parseEngineList, readEngine, SEVEN_DAYS_MS, type EngineId, type EngineReadings, type EngineUsage, type UsageWindow } from './engineChoice';
import { cleanModelList, entryExclusion, entryLabel, sameEntry, type AgentBalancerPatch, type AgentBalancerState, type AgentModelEntry, type AgentPlacement } from '../shared/modelBalance';
import { gatherUsageLedger, userUsageHomes } from './usageLedger';
import { createModelSwitcher } from './modelSwitch';
import { createTestsCheckpoint } from './testsCheckpoint';
import modelCatalogData from '../shared/modelCatalog.json';
import { formatAgentUsage7d } from '../shared/usageFormat';
import { liveModelAllowed, liveModelFromLog, sessionModel } from '../shared/liveModel';
import { applyExhaustion, claudeLimitHit, clearExhaustion, codexLimitHit, createCapacityRestoredEvent, hitUntil, isCapacityRestored, isExhausted, limitDecision, LimitLockNotices, noteExhaustion, spentUntil, RESUME_GRACE_MS, type Exhaustion, type ExhaustionMap, type LimitHit } from './providerLimits';
import { buildHandoff, claudeDigest, codexDigest, repoHints, type BoardCard } from './handoff';
import { gatherHandoff, logGapReason } from './handoffGather';
import { advanceHoldClock, canResumeLimitWait, idleOutsideHold, limitResumeText, type HoldClock, type LimitWait, type LimitWaits } from '../shared/limitHold';
import { ledgerSummaryMarkdown, summarizeLedger } from './engineLedger';
import { RealtimeFloorWatcher } from './realtimeFloorWatcher';
import {
  configPath, readConfig, writeConfig, setAgentTokenCap, resetConfig, onConfigWritten, startConfigWatcher, ensureHarnessHome, ensureClaudePermissionsAccepted,
  modelForRole, OPS_STANDUP_MISSION, HEARTBEAT_MISSION, ENGINE_LEDGER_REVIEW_MISSION, COMPACT_MAINTENANCE_MISSION, type HarnessConfig, type ScheduledMission
} from './config';
import { listDir, readFileText, readFileBinary, writeFileText, statAbs, expandTilde } from './fs';
import { normalizeWeekly, weeklyDelayMs } from '../shared/weeklySchedule';
import {
  getBranch, getStatus, getLog, getBranches, getAheadBehind, isRepo, getDiff, mainRepoRoot,
  addWorktree, removeWorktree, worktreeHasUnintegratedWork, worktreeIsGcSafe,
  getLogGraph, getCommitFiles, getFileAtRev, compareRefs, listWorktrees, checkoutRef
} from './git';
import { linkWorktreeDeps, unlinkWorktreeDeps } from './worktreeDeps';
import { worktreeRoot } from './worktreeRoot';
import { createAgentRestarter } from './agentRestart';
import { isAlive, hardKillTree, KILL_GRACE_MS } from './procKill';
import { HiveManager, redactSecrets, type AgentMeta, type HiveMessage, type HiveTask } from './hive';
import { HookServer } from './hooks';
import { CircuitBreaker, type BreakerInput } from './breaker';
import { armLive, liveTimings, stopLive, syncTimers, type ActiveTimers } from './timings';
import type { UsageProvider } from './usage';
import { MemoryManager } from './memory';
import { KnowledgeManager } from './knowledge';
import { MemoryReflector, type ReflectSettings } from './reflect';
import { PersistStore } from './db';
import { projectDir, readAgentUsage, readContextTokens, readContextReadSince, seedSessionTranscript, resolveSessionCwd } from './transcript';
import { listIssues, listCIRuns } from './github';
import { SlackWebhookServer, SlackReplyServer, postSlackReply, type SlackEventFile } from './slack';
import {
  WebhookServer,
  type WebhookDispatch, type WebhookEndpointRef, type WebhookInbound, type WebhookTaskStatus
} from './webhook';
import {
  classifyInboundKind, isAutoAllowed,
  DEFAULT_CONTEXT_TRIGGER, DEFAULT_ORG_TRIGGER, DEFAULT_TRIGGER_MODE, DEFAULT_WEBHOOK_SCHEMA,
  type ContextRule, type ContextTriggerConfig, type InboundKind, type OrgTriggerConfig,
  type TriggerHistoryEntry, type TriggerMode, type WebhookTrigger
} from '../shared/triggers';
import {
  appendTriggerHistory, clearTriggerHistory, listTriggerHistory, updateTriggerHistory
} from './triggerHistory';
import { transcribeWithGroq, DEFAULT_GROQ_MODEL } from './freeflow';
import { registerRealtimeIpc } from './realtime';
import { registerRealtimeActionIpc } from './realtimeActions';
import { initCompletionWatcher } from './realtimeCompletionWatcher';
import type { TaskCard, InboxMessage } from './realtimeCompletionWatcher';
import { TelemetryCollector } from './telemetry';
import { CostLedgerTotals } from './costLifetime';
import { analytics, isRendererMessageSurface } from './analytics';
import type { SpawnFailReason } from './analytics';
import { IntegrationBroker } from './integrationBroker';
import * as integrations from './integrations';
import { validateBaseUrl, buildAuthHeaders, resolveUpstreamUrl, secretRefFor, INTEGRATION_TEMPLATES } from '../shared/integrations';
import { RosterStore, rosterBackupDir, startRosterWatcher } from './roster';
import { buildWorkerLaunch, workerContextEnv } from './workerLaunch';
import { ControlRegistry } from './control';
import { WorkerWakeWatchdog, WORKER_WAKE_IDLE_MS, type WorkerWakeFacts } from './workerWake';
import { TodoNudger, closingTimeParkable, openCards, todoNudgeEligible, todoNudgeText, ignoredTodoNudgeBody, type NudgeCard, type TodoNudgeFacts } from './todoNudge';
import { bossCompactResumeText, inboxNudgeText } from '../shared/hiveNudge';
import { getMessageRoute } from './messageRoutes';
import { BUNDLED_MESSAGE_TEMPLATES, renderMessageTemplate } from './messageTemplates';
import { dormantWakeReason, planDormancy, rosterIdsOf, tasksOf } from '../shared/dormantWake';
import { resolveGodName } from '../shared/godIdentity';
import { fetchHireManifest, readHireManifestFiles } from './hire';
import { parseHireDeepLink, type HireManifest } from '../shared/hire';
import { ClosingTimeController, type WorkerStatus } from './closingTime';
import { agyUsageSample } from './agyUsage';
import { codexUsageSample } from './codexUsage';
import {
  argsWithAutoModeFlag,
  buildSpawnCommand,
  inferAgentProvider,
  isClaudeProvider,
  nonInteractiveEnvForProvider,
  providerPreset,
  installInfoForProvider,
  type AgentProvider
} from '../shared/agentProvider';
import { buildMissingCliScript, chooseInstallRung } from './cliInstall';
import { detectNodeVersion, nodeIsUsable, resolveNodeInstaller } from './nodeInstall';
import { toolCatalog, type ToolStatus } from '../shared/toolCatalog';
import { listLocalSkills, loadCatalog, installSkill, uninstallSkill, type LocalSkill } from './skills';
import { loadHero } from './hero';
import { loadRuntimeModelCatalog, loadRuntimeModelCatalogWithAgy } from './runtimeModelCatalog';
import { runOpsStandup, stalledAgents, standupProblems, type StandupMark } from './standupGate';
import { scanLeftovers, formatLeftovers, triageLeftovers } from './leftovers';
import { scanStrayFiles, formatStrayFiles } from './strayFiles';
import { DEFAULT_PRIORITY } from '../shared/taskPriority';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

registerDesktopMode({ rendererUrl: isDev ? process.env.ELECTRON_RENDERER_URL : undefined });

// Keep the main process alive on an unexpected throw/rejection. The harness is a
// multi-agent supervisor — a single stray throw (e.g. node-pty's ConPTY console
// helper choking when a fast-exiting agent CLI's console is already gone) must
// NOT take the whole app and every running agent down with it. Log and continue
// rather than letting the default handler exit the process.
// (Restored during the #71 merge — the PR's rebase dropped these handlers.)
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException (kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection (kept alive):', reason);
});
// A launcher's pipe can close under a running app. Without a listener every log line's
// EPIPE becomes an uncaughtException, whose own log line fails again: a loop that pins main.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') stream.write = () => true; });
}

const ptyManager = new PtyManager();

/** Live PTY id → its hive agent id, recorded at spawn. The pty:kill handler only
 *  gets the PTY id, so this lets a closed tab archive the right registry agent. */
const ptyToAgent = new Map<string, string>();
/** PTY id → the spawn it should auto restart-and-continue into once a first-time
 *  CLI install finishes. The missing-CLI short-circuit runs the engine's installer
 *  in this PTY; when it exits cleanly the exit handler re-runs the SAME spawn (with
 *  install disabled) so the freshly-installed CLI launches in the SAME pty/window —
 *  no user click. Cleared the moment it's consumed, so it can never loop installs. */
const pendingInstallRelaunch = new Map<string, { opts: AgentSpawnOptions; owner: Electron.WebContents | null; bin: string; rung: string }>();
const hive = new HiveManager(
  () => readConfig().harnessHome,
  (channel, payload) => {
    const wc = liveWebContents();
    if (!wc) return false;
    try { wc.send(channel, payload); return true; } catch { return false; }
  }
);
hive.setUserConfigHome(homedir());
hive.setEngines(() => readConfig().engines);
// #7C — operator control state (pause/gate/steer/halt), read by the HookServer
// when deciding hook returns.
const control = new ControlRegistry();
control.onChange((agentId, s) => {
  try { mainWindow?.webContents.send('control:changed', { agentId, paused: s.paused, halted: s.halted }); } catch { /* window tore down */ }
});
// Stage 7A — the live observability tap. Receives Claude Code's first-party OTel
// over loopback OTLP/JSON and exposes the locked usage-provider seam. resolveCwd
// lets the transcript fallback find an agent's cwd from the hive registry.
const telemetry = new TelemetryCollector({
  emit: (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* window tore down */ } },
  resolveCwd: (agentId) => hive.registry().agents[agentId]?.cwd ?? null,
  // D11: scopes the transcript fallback to this agent's own session instead of
  // summing every transcript in a (routinely shared) cwd.
  resolveSessionId: (agentId) => hive.lastSession(agentId)
});
// Usage provider (Seam 1) — the INTEGRATION swap: Oscar's telemetry collector (#7)
// IS the provider, replacing Lane A's interim StubUsageProvider. Same
// getAgentUsage(agentId) pull seam, so the breaker + cost ledger consumers are
// untouched; telemetry has a transcript fallback built in, so it works before any
// live OTel arrives.
const usageProvider: UsageProvider = telemetry;
// Circuit breaker (Lane A #6.6b) — the REAL policy (replaces Lane C's interim
// glue). POLICY only; the heartbeat beat feeds it signals (via usageProvider) +
// enforces its decisions. Config read live so a settings change applies next beat.
const breaker = new CircuitBreaker(() => {
  const c = readConfig();
  return { ...(c.circuitBreaker ?? {}), costCapUsd: c.costCapUsd, costCapTokens: c.costCapTokens, agentTokenCaps: c.agentTokenCaps };
});
// Always-on beats (decoupled from the optional heartbeat): the live fleet snapshot
// Michael reads + the breaker beat, so guardrails + monitoring work even when the
// heartbeat mission is disabled (it ships off).
/** Every config-tunable interval handle; syncTimers re-arms them when config.json changes. */
const liveTimers: ActiveTimers = {};
// Feed the breaker's api_error-storm trip from Oscar's OTel api_error spans —
// Jim's one breaker input with no on-branch source (telemetry.onApiError seam).
telemetry.onApiError((agentId) => breaker.recordError(agentId));
// Shared roster on disk — created early so HookServer can re-read standing goals
// on every UserPromptSubmit (Edit Agent saves land here via persistAgents).
const roster = new RosterStore(() => readConfig().harnessHome);
let configWatcher: { close: () => void } | null = null;
let rosterWatcher: { close: () => void } | null = null;
let watchedRosterHome: string | null = null;
function watchRosterHome(): void {
  const home = readConfig().harnessHome;
  if (home === watchedRosterHome && rosterWatcher) return;
  rosterWatcher?.close();
  watchedRosterHome = home;
  rosterWatcher = home ? startRosterWatcher(home, (event) => {
    for (const w of allWindows) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('roster:changed', event);
    }
  }) : null;
}
function standingGoalFromRoster(agentId: string): string | null {
  const snap = roster.read();
  if (!snap || !Array.isArray(snap.agents)) return null;
  for (const entry of snap.agents) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as { id?: unknown; goal?: unknown };
    if (a.id !== agentId) continue;
    return typeof a.goal === 'string' && a.goal.trim() ? a.goal.trim() : null;
  }
  return null;
}
// Worker inbox-wake watchdog (#151): finds idle workers with undrained inbox mail
// and types the same guarded nudge the renderer would have (so a throttled
// background window can't leave a worker parked on an unread inbox forever).
// HookServer feeds it the hook stream so a permission/HITL prompt blocks nudges.
const workerWake = new WorkerWakeWatchdog();
const todoNudger = new TodoNudger({
  facts: (agentId) => {
    try { return todoNudgeFacts(agentId); } catch (e) { console.error('[todo-nudge] facts failed:', e); return { eligible: false, hasMail: false, cards: [] }; }
  },
  nudge: (agentId, cards) => sendTodoNudge(agentId, cards),
  ignored: (agentId, cards) => reportIgnoredTodoNudge(agentId, cards),
  close: (agentId, cards) => proposeCardClose(agentId, cards),
  refused: (agentId, reason) => recordCardCloseRefusal(agentId, reason)
});
// HookServer needs BOTH: Oscar's control registry (HITL pause/gate/steer/halt via
// hook returns) AND Jim's breaker (feed recordToolUse on each PostToolUse).
/** Hook-confirmed submits for main-process typing (nudgeWorker); the renderer keeps its own. */
const promptSubmits = createPromptSubmitWatch();
const hookServer = new HookServer(
  hive,
  () => liveWebContents(),
  () => readConfig(),
  control,
  breaker,
  standingGoalFromRoster,
  (agentId, event, message, source) => {
    if (event === 'UserPromptSubmit' && agentId) promptSubmits.notify(agentId);
    workerWake.noteHook(agentId, event, message);
    todoNudger.noteHook(agentId, event, message, source);
    if (event === 'Stop') scheduleLimitBeat();
    if (event === 'PostCompact' && agentId && hive.isGod(agentId)) sendBossCompactResume(agentId);
  }
);
const memory = new MemoryManager(
  () => readConfig().harnessHome,
  () => { const c = readConfig(); return { enabled: c.semanticMemory !== false, model: c.embeddingModel ?? 'minilm' }; }
);
// Enterprise Knowledge Graph — file-backed store + agent CLI (default OFF).
const knowledge = new KnowledgeManager();
/** Reads the reflect tunables from config each tick (defaults baked in here so a
 *  pre-existing config.json without the keys still gets sane values). */
function reflectSettings(): ReflectSettings {
  const c = readConfig();
  return {
    enabled: c.reflectEnabled !== false,
    intervalMs: c.reflectIntervalMs ?? 1_800_000,
    byteTriggerPct: c.reflectByteTriggerPct ?? 50,
    sectionTrigger: c.reflectSectionTrigger ?? 50,
    recentKeep: c.reflectRecentKeep ?? 12,
    minBytes: c.reflectMinBytes ?? 16_384
  };
}
// Finishes the janitor's missing condense half: bounds each agent's memory.md
// (Haiku tail-summary, backup→verify→atomic-swap) so it never grows unbounded.
const reflector = new MemoryReflector(
  () => readConfig().harnessHome,
  () => readConfig().defaultCommand ?? 'claude',
  () => memory.env(),
  reflectSettings,
  (event) => { try { hive.appendLog(event); } catch { /* best-effort */ } }
);
// Durable harness state (SQLite, main process). Phase A: window bounds (kv) +
// net-new command history. Opened in whenReady, closed in the teardown blocks.
const persist = new PersistStore();
/** The PRIMARY window — the one running the hive/god orchestration and the sink
 *  for process-global timer events (missions, breaker, Slack ingestion). It is
 *  the most-recently-focused live window, so global events follow the user.
 *  Additional "floor" windows are tracked in `allWindows` below. */
let mainWindow: BrowserWindow | null = null;
/** Every open window (primary + floors). A registry, not a single handle, so
 *  multi-window lifecycle (focus tracking, quit fan-out) is correct. */
const allWindows = new Set<BrowserWindow>();
/** Monotonic floor counter → a stable, unique session partition per floor so
 *  each floor's renderer state (localStorage: agents, queues, selection) is
 *  isolated from every other window's. */
let floorSeq = 0;

/** When true, skip the quit interceptor (user already confirmed). */
let allowQuit = false;

/** Agents spawned with `isolate: true` get a dedicated git worktree; this maps
 *  the agent/pty id → the worktree path so we can tear it down on kill. */
const worktreePaths = new Map<string, string>();
/** id → the original repo cwd the worktree was created from (needed to run
 *  `git worktree remove` from the parent tree, not the worktree itself). */
const worktreeOrigins = new Map<string, string>();

/** A live god-triggered ephemeral worker, tracked from spawn to teardown. */
interface WorkerRec {
  workerId: string;       // == the PTY id == hive agent id (`worker-<reqId>`)
  reqId: string;          // the spawn-request id
  name?: string;          // display name (for the worker tab)
  slack?: { channel: string; thread_ts: string };
  baseBranch: string;     // the branch its worktree was cut from (for ahead-of-base)
  spawnedAt: number;      // epoch ms
  releasing?: boolean;    // kill issued; awaiting teardownPty (skip re-processing)
  /** Per-worker TOTAL-token cap from the spawn-request (overrides the config
   *  default). 0/undefined = no per-request cap. P4 plumbing — unlimited today. */
  tokenCap?: number;
  /** How the worker ended, set where it is released; teardownPty records it in the
   *  engine ledger. Unset means it exited on its own (crash, manual stop). */
  outcome?: 'done' | 'reaped-idle' | 'reaped-token-cap';
  /** The spawn-request's difficulty, repeated on the ledger's end row. */
  difficulty?: Difficulty;
  /** The effort level the worker's session launched at, repeated on the ledger's end row. */
  effort?: string;
  /** Limit-hold time inside the current quiet stretch; the idle reaper skips it. */
  holdClock?: HoldClock;
}
/** Live ephemeral workers by id. Populated by the spawn-request watcher; consulted
 *  by teardownPty so a finished/crashed/reaped worker's worktree is PRESERVED (not
 *  force-removed) when it holds unintegrated work — god is the sole integrator. */
const liveWorkers = new Map<string, WorkerRec>();

/** The loopback secret broker (Phase 2). Workers reach registered integrations through
 *  it without ever seeing a credential. getRecord/getSecret are injected so the broker
 *  stays electron-free + unit-testable. Started in bootstrapHiveServices; each worker is
 *  granted a per-worker capability token at spawn (revoked in teardownPty). */
const integrationBroker = new IntegrationBroker({
  getRecord: integrations.getRecord,
  getSecret: integrations.getSecret
});

/** BYOK backend model-providers whose API keys the non-Claude CLI engines
 *  (OpenCode/Crush/pi/qwen) read from standard env vars. Keys are stored
 *  WRITE-ONLY in the same encrypted secret broker as integrations, under
 *  `apikey:<backend>`, and materialized MAIN-ONLY at spawn (never over IPC). */
const BACKEND_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY'
};
const providerKeyRef = (backend: string): string => `apikey:${backend}`;

/** A worker worktree that teardown PRESERVED because it held unintegrated work.
 *  Tracked so the GC sweep can reclaim it (+ its scratch dir) once the work lands
 *  in base or the worktree is removed by hand — see gcPreservedWorktrees(). */
interface PreservedWorktree {
  workerId: string;
  wtPath: string;
  origCwd: string;        // the parent repo to run `git worktree remove` from
  baseBranch: string;     // re-checked against this for "integrated yet?"
  scratchDir: string | null; // HIVE_ROOT/agents/<workerId> — removed alongside the worktree
  slack?: { channel: string; thread_ts: string };
  preservedAt: number;    // epoch ms
}
/** Preserved worker worktrees awaiting integration, keyed by worktree path. The GC
 *  sweep drains this: an entry is removed (worktree + scratch GC'd) only when the
 *  work is provably integrated, or when the worktree is already gone from disk. */
const preservedWorktrees = new Map<string, PreservedWorktree>();

/**
 * Tear down everything tied to a PTY id: archive its hive agent, remove its
 * isolated git worktree, and drop the bookkeeping-map entries. Runs on BOTH an
 * explicit `pty:kill` AND a natural PTY exit (the child finished, crashed, or
 * was killed externally) — without this the agent stays "active" (broadcasts
 * keep mailing a dead inbox), the worktree orphans (plus a dangling `git
 * worktree` registration in the user's real repo), and the maps leak an entry
 * per dead PTY.
 *
 * Idempotent: guarded on map presence and the already-idempotent
 * `hive.setArchived`, so a double call is a harmless no-op. NOTE: an explicit
 * `ptyManager.kill()` does NOT reach here via onExit — kill() deletes the
 * session synchronously, so node-pty's later async exit callback fails the
 * session-identity guard and is swallowed. Every kill site must therefore call
 * teardownPty itself right after the kill (all of them do). Best-effort — every
 * step is wrapped so a teardown error can never crash the caller (an IPC
 * handler or node-pty's onExit).
 *
 * `dormant` (a close for a new card, a limit switch) marks the agent dormant instead of archived and leaves
 * its worktree on disk, the state an agent is in after an app quit.
 */
function teardownPty(id: string, opts: { dormant?: boolean } = {}): void {
  // Ephemeral-worker flag, read BEFORE the cleanup below deletes the entry. All
  // worker deaths (done-release, idle/token reap, manual stop, crash) funnel
  // through here, so this is the one place their floor card gets archived
  // (workers card via the hive:agentSpawned broadcast in processSpawnRequest).
  // pty id == worker id == agent id for workers.
  const wasWorker = liveWorkers.has(id);
  // 0) Revoke this id's broker capability (if any). Idempotent + harmless for a
  //    non-worker PTY; ensures a dead worker's token can never reach an integration.
  try { integrationBroker.revoke(id); } catch { /* best-effort */ }
  // 1) Archive the agent — retained + flagged; only live-PTY agents are active.
  const agentId = ptyToAgent.get(id);
  if (agentId) {
    ptyToAgent.delete(id);
    // Drop watchdog state so a dead agent can't get nudged or leak its grace.
    try { workerWake.forget(agentId, id); } catch { /* best-effort */ }
    // Drop breaker state so a dead agent can't leak/zombie a tripped level.
    try { breaker.forget(agentId); } catch { /* best-effort */ }
    // A replacement using this id needs a new usage counter, not the dead PTY's.
    try { telemetry.forgetAgent(agentId); } catch { /* best-effort */ }
    // W1 — kill this agent's proxy-bridge sidecar (qwen), if any, so a dead
    // PTY never leaves an orphan loopback listener. No-op for non-proxy agents.
    try { hive.stopProxyBridge(agentId); } catch (e) { console.error('[hive] stopProxyBridge failed:', e); }
    try { stopAgentJailProxy(agentId, id); } catch (e) { console.error('[agentJail] stopping the jail proxy failed:', e); }
    todoNudger.forget(agentId);
    liveSessions.delete(agentId);
    refusalTerminals.get(id)?.dispose();
    refusalTerminals.delete(id);
    if (hive.enabled()) {
      if (opts.dormant) hive.setDormancy({ dormant: [agentId], archived: [] });
      else try { hive.setArchived(agentId, true); } catch (e) { console.error('[hive] setArchived failed:', e); }
    }
  }
  // 2) Remove the isolated worktree, if any. Non-blocking; errors are logged.
  //    A dormant agent keeps it on disk, as across an app quit: its wake re-enters it.
  const wtPath = worktreePaths.get(id);
  if (wtPath && opts.dormant) {
    worktreePaths.delete(id);
    worktreeOrigins.delete(id);
  } else if (wtPath) {
    const origCwd = worktreeOrigins.get(id) ?? wtPath;
    worktreePaths.delete(id);
    worktreeOrigins.delete(id);
    // Ephemeral workers get a SAFETY-GATED teardown: never auto-remove a worktree
    // that holds unintegrated work. This sits INSIDE teardownPty so it covers ALL
    // teardown routes — a worker that finished (controller kill), crashed, or was
    // idle-reaped all land here. Normal agents keep the immediate force-remove.
    const worker = liveWorkers.get(id);
    if (worker) {
      recordWorkerEnd(worker);
      liveWorkers.delete(id);
      void finalizeWorkerWorktree(wtPath, origCwd, worker);
    } else {
      void removeWorktree(origCwd, wtPath)
        .then(r => { if (!r.ok) console.error('[worktree] removeWorktree failed:', r.error); })
        .catch(e => console.error('[worktree] removeWorktree threw:', e));
    }
  }
  // A worker whose isolation failed (non-repo cwd) has no worktree to gate above —
  // still clear its tracking entry so the controller stops watching a dead PTY.
  const unisolated = liveWorkers.get(id);
  if (unisolated) { recordWorkerEnd(unisolated); liveWorkers.delete(id); }
  // Archive the dead worker's floor card (mirrors killAgent's voice-kill path;
  // the renderer's archiveAgent is a no-op if the card is already gone). NOT
  // done for regular agents: their kill flows already manage their own card.
  if (wasWorker) {
    try { liveWebContents()?.send('hive:agentArchived', { id }); } catch { /* window torn down */ }
  }
  syncKeepAwake();
}

/** Send an inform to the god agent (the human's proxy). The ephemeral-worker
 *  controller uses this to surface every terminal failure AND to carry the Slack
 *  {channel,thread_ts} so god can post a 'couldn't complete' reply — closing the
 *  Slack loop (the success path is the worker replying in-thread itself). */
/** True for an agent id on the floor; a route naming anything else falls back to god. */
function isKnownAgent(id: string): boolean { return !!hive.registry().agents[id]; }

function informGod(subject: string, body: string, slack?: { channel: string; thread_ts: string }): void {
  try {
    const slackLine = slack
      // The bundled-node launcher, spelled as an ABSOLUTE PATH — NOT bare `node`
      // (absent from the PATH of any machine whose node comes from nvm) and NOT
      // `$HIVE_NODE` (POSIX-only: cmd.exe/PowerShell expand it to nothing, so the
      // whole reply command was dead on Windows).
      ? `\n\n[SLACK] Close the loop — post a reply to channel ${slack.channel} thread ${slack.thread_ts} via:\n  "${hive.nodeCommand()}" "${slackReplyScriptPath()}" --channel ${slack.channel} --thread ${slack.thread_ts} --text "<your message>"`
      : '';
    hive.send({ to: getMessageRoute('workerLifecycle', readConfig(), isKnownAgent), act: 'inform', subject, body: body + slackLine }, 'ephemeral-worker');
  } catch (e) {
    console.error('[worker] informGod failed:', e);
  }
}

/** Gated worktree teardown for an ephemeral worker: remove it ONLY when it holds no
 *  unintegrated work; otherwise leave it (and its branch) in place and ping god, the
 *  sole integrator. Async + best-effort; on any uncertainty it KEEPS the worktree
 *  (fail-safe — never auto-discard possibly-valuable work). */
async function finalizeWorkerWorktree(wtPath: string, origCwd: string, worker: WorkerRec): Promise<void> {
  try {
    const deps = await unlinkWorktreeDeps(origCwd, wtPath);
    if (!deps.ok) console.error('[worktree] dependency unlink failed:', deps.error);
    const work = await worktreeHasUnintegratedWork(wtPath, worker.baseBranch);
    if (work.keep) {
      console.warn(`[worker] PRESERVING worktree with unintegrated work: ${wtPath} (${work.detail})`);
      // Track it so the GC sweep can reclaim it (+ scratch dir) once integrated —
      // the worker is gone from liveWorkers by now, so its identity lives here.
      preservedWorktrees.set(wtPath, {
        workerId: worker.workerId, wtPath, origCwd, baseBranch: worker.baseBranch,
        scratchDir: workerScratchDir(worker.workerId), slack: worker.slack, preservedAt: Date.now()
      });
      informGod(
        `[worker worktree preserved] ${worker.workerId}`,
        `Ephemeral worker ${worker.workerId} ended but its worktree holds unintegrated work, so it was NOT auto-removed (you are the sole integrator).\n`
        + `Worktree: ${wtPath}\nBranch: ${work.branch}\nState: ${work.detail}\n`
        + `Review/merge it — it will be auto-reclaimed once its work lands in ${worker.baseBranch}, or remove it now with: git -C "${origCwd}" worktree remove "${wtPath}"`,
        worker.slack
      );
      return;
    }
    const r = await removeWorktree(origCwd, wtPath);
    if (!r.ok) { console.error('[worker] removeWorktree failed:', r.error); return; }
    // Worktree is gone (clean/integrated at teardown), but DEFER its scratch-dir
    // cleanup to the throttled GC sweep rather than deleting it synchronously here:
    // HIVE_ROOT/agents/<id> holds the worker's memory.md and the MemPalace miner
    // ingests it asynchronously, so an immediate delete can beat the miner and
    // permanently lose the worker's durable notes from the shared palace. Register
    // it (its worktree path is now absent) so the sweep's path-gone branch reclaims
    // the scratch after a window — same throttled path the preserved case uses.
    preservedWorktrees.set(wtPath, {
      workerId: worker.workerId, wtPath, origCwd, baseBranch: worker.baseBranch,
      scratchDir: workerScratchDir(worker.workerId), slack: worker.slack, preservedAt: Date.now()
    });
  } catch (e) {
    console.error('[worker] finalizeWorkerWorktree threw (worktree left in place):', e);
  }
}

/** The hive scratch dir for a worker (its inbox/outbox/memory): HIVE_ROOT/agents/<id>.
 *  Null when there's no hive root. */
function workerScratchDir(workerId: string): string | null {
  const root = hive.root();
  return root ? join(root, 'agents', workerId) : null;
}

/** Best-effort removal of a worker's scratch (hive agent) dir. Guarded to ONLY ever
 *  delete a path that resolves to exactly HIVE_ROOT/agents/<workerId> and never a
 *  still-live worker — so a crafted/mismatched id can't escape the agents root. */
function removeWorkerScratch(workerId: string): void {
  if (liveWorkers.has(workerId)) return; // never wipe a live worker's mailbox
  const dir = workerScratchDir(workerId);
  const root = hive.root();
  if (!dir || !root) return;
  const agentsRoot = join(root, 'agents');
  // Path-safety: the resolved dir must sit directly under agents/ with basename == id.
  if (resolve(dir) !== join(resolve(agentsRoot), basename(dir)) || basename(dir) !== workerId) return;
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (e) { console.error('[worker] removeWorkerScratch failed:', e); }
}
// A natural PTY exit must run the same teardown as an explicit kill — EXCEPT when
// the PTY was the missing-CLI installer: a clean exit there means the engine CLI was
// just installed, so auto restart-and-continue by re-running the SAME spawn into the
// SAME pty/window (no user click). Provider-agnostic. Idempotent by construction: the
// relaunch carries `noAutoInstall`, so the installer can never fire (let alone loop) a
// second time — a binary that's somehow still missing just spawns and exits normally.
ptyManager.setExitHandler((id, exitCode, info) => {
  // Record an ABNORMAL death before teardown — teardownPty drops the
  // pty->agent mapping, so after it runs we can no longer say WHOSE process
  // died. Only abnormal exits are recorded (recordAgentExit returns early on a
  // clean one), so this adds no noise to a normal archive.
  try {
    const dyingAgent = ptyToAgent.get(id);
    if (dyingAgent) {
      const abnormal = hive.recordAgentExit(dyingAgent, {
        exitCode,
        signal: info?.signal,
        tail: info?.tail,
        command: info?.command
      });
      if (abnormal) reviveCrashedWorker(dyingAgent, id, exitCode, info?.signal);
    }
  } catch (e) { console.error('[pty] recordAgentExit failed:', e); }

  const pending = pendingInstallRelaunch.get(id);
  if (pending) {
    pendingInstallRelaunch.delete(id);
    // Activation funnel: did the auto-installer actually complete? A non-zero exit
    // is the Linux-installer-cannot-finish-unattended signal that used to be silent.
    const provider = pending.opts.provider ?? inferAgentProvider(pending.opts.command, undefined);
    if (exitCode === 0) {
      analytics.track('agent_install_finished', { provider, rung: pending.rung, outcome: 'agent_launched' });
      // Re-arm the renderer's pooled terminal (clear the "process exited" line +
      // re-enable input) so the freshly-spawned CLI paints onto a clean, typeable
      // grid, then re-run the normal spawn — which now finds the installed binary.
      const wc = (pending.owner && !pending.owner.isDestroyed()) ? pending.owner : liveWebContents();
      try { wc?.send(`pty:relaunch:${id}`); } catch { /* window gone */ }
      void spawnAgentCore({ ...pending.opts, noAutoInstall: true }, pending.owner);
      return; // an install PTY has no agent/worktree to tear down
    }
    // Non-zero exit = install failed; leave its honest manual-fix message on screen.
    analytics.track('agent_install_finished', { provider, rung: pending.rung, outcome: 'install_failed' });
  }
  teardownPty(id);
});

/** Keep the system from suspending the harness while agents are running.
 *  Windows Modern Standby suspends desktop apps (and their child `claude`
 *  processes!) shortly after the display sleeps/locks — the whole hive froze
 *  mid-turn until unlock. `prevent-app-suspension` blocks exactly that while
 *  still letting the display turn off and the session lock. Held only while at
 *  least one PTY is alive, so an idle harness doesn't pin a laptop awake.
 *
 *  Opt-in `config.strongKeepalive` escalates to `prevent-display-sleep`, which on
 *  macOS ALSO blocks true system sleep (lid-close/idle) so timers & PTYs keep
 *  firing on time while away — at a battery cost. The default ('prevent-app-
 *  suspension') still lets the Mac truly sleep; we survive that and catch up once
 *  on resume (see onSystemResume). Re-evaluated on every call so toggling the
 *  flag while agents run swaps the blocker mode live. */
type KeepAwakeMode = 'prevent-app-suspension' | 'prevent-display-sleep';
let keepAwakeId: number | null = null;
let keepAwakeMode: KeepAwakeMode | null = null;
function syncKeepAwake(): void {
  const live = ptyManager.list().length > 0;
  const desired: KeepAwakeMode | null = live
    ? (readConfig().strongKeepalive ? 'prevent-display-sleep' : 'prevent-app-suspension')
    : null;
  if (desired === keepAwakeMode) return; // no change — avoid stop/start churn + log spam
  // Tear down the current blocker (mode change, or going idle with no agents).
  if (keepAwakeId !== null) {
    try { if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId); } catch { /* noop */ }
    keepAwakeId = null;
  }
  keepAwakeMode = desired;
  if (desired) {
    keepAwakeId = powerSaveBlocker.start(desired);
    console.log(`[power] keep-awake ON (${desired}) — agents running`);
  } else {
    console.log('[power] keep-awake off — no agents');
  }
}

/** A mission's live scheduler handles: the initial `setTimeout` that waits out
 *  the time remaining until its next due fire, and the steady `setInterval`
 *  armed once it has fired. Both are tracked so shutdown can clear whichever is
 *  pending. */
interface MissionTimer {
  timeout?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
}

/** Active scheduler timers keyed by mission id. */
const missionTimers = new Map<string, MissionTimer>();

/** Clear and forget every armed mission timer (both the setTimeout and the
 *  setInterval handle). Safe to call from syncMissions and from shutdown
 *  teardown so a tick never fires into half-torn-down services. */
function clearMissionTimers(): void {
  for (const t of missionTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  missionTimers.clear();
}

/** Rebuild the scheduler from persisted config: clear every existing timer,
 *  then arm each enabled mission honoring its lastFiredAt — a setTimeout for the
 *  time remaining until its next due fire, which then settles into a steady
 *  interval. Each tick dispatches the mission to its target agent and stamps
 *  lastFiredAt back into config. Called on boot (after the router starts) and
 *  after every missions:save. */
function syncMissions(): void {
  clearMissionTimers();
  const missions = readConfig().missions ?? [];
  for (const m of missions) {
    if (!m.enabled) continue;
    // A weekly mission (day-of-week + time) is armed below and does NOT need an
    // interval, so the interval guard has to come after that branch — it used to
    // be folded into the line above and would have rejected every one of them.
    const weekly = m.kind === 'heartbeat' ? null : normalizeWeekly(m.weekly);
    if (!weekly && !(m.intervalMs > 0)) continue;
    // Heartbeat (Lane A #1) opts out of the fixed setInterval and self-reschedules
    // with an adaptive cadence. Registered into the same missionTimers map so
    // clearMissionTimers() tears it down identically on quit/reset.
    if (m.kind === 'heartbeat') { armHeartbeat(m); continue; }
    const fire = (): void => {
      try {
        // A 'compact' maintenance mission (maint-1) is compaction-ONLY: it carries
        // no dispatch body/target, so skip the hive.send and just fire auto-compact.
        // Gate on `kind!=='compact'` ALONE — that already excludes the compact mission;
        // we deliberately do NOT add `&& m.body`, so other (dispatch) missions keep
        // their prior behaviour, including the historical empty-body send (Pam N1).
        if (m.kind !== 'compact' && hive.enabled()) {
          if (m.id === OPS_STANDUP_MISSION.id) sendOpsStandup(m);
          else hive.send({ to: m.to, act: 'request', subject: m.label, body: m.body }, 'scheduler');
        }
        // Auto-compact: do NOT jam /compact into busy terminals. Hand it to the
        // renderer, which queues a /compact per agent (deduped — never two at
        // once) and delivers it only when that agent goes idle (its drain loop),
        // so a working agent compacts between steps, never mid-step.
        //
        // The CADENCE now belongs to the context trigger, not to a mission — but
        // the legacy per-mission `autoCompact` flag keeps working, routed through
        // the same emit so there is exactly ONE path from main to the renderer.
        // It carries the context trigger's current rule so a mission-driven
        // compaction obeys the same pressure thresholds as a trigger-driven one.
        if (m.autoCompact || m.kind === 'compact') {
          emitContextTrigger('compact', contextRule('compact'));
        }
        const current = readConfig().missions ?? [];
        const next = current.map((x) =>
          x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x
        );
        writeConfig({ missions: next });
        // Let the SCHEDULES panel refresh its "last fired" without a reload (#2.3).
        try { liveWebContents()?.send('missions:updated'); } catch { /* window gone */ }
      } catch (e) {
        console.error('[scheduler] mission', m.id, e);
      }
    };
    const entry: MissionTimer = {};
    if (weekly) {
      // Weekly self-reschedules: there is no steady interval to settle into,
      // because the gap between two slots varies (Fri to Mon is not Mon to Wed,
      // and the week the clocks change is not 168 hours long).
      //
      // `justFired` is a spin guard, not a nicety. weeklyDelayMs returns 0 for a
      // slot that was missed and not yet run, and it learns "already run" from
      // the persisted lastFiredAt — so if fire()'s writeConfig ever failed, the
      // next computation would return 0 again, forever. Passing `now` as the
      // last-fired floor after a fire makes the catch-up branch unreachable, so
      // the worst case is a lost stamp rather than a hot loop.
      const rearm = (justFired: boolean): void => {
        const now = Date.now();
        const persisted = (readConfig().missions ?? []).find((x) => x.id === m.id)?.lastFiredAt ?? 0;
        const delay = weeklyDelayMs(weekly, now, justFired ? Math.max(persisted, now) : persisted);
        if (delay === null) return;
        entry.timeout = setTimeout(() => { fire(); rearm(true); }, delay);
      };
      rearm(false);
      missionTimers.set(m.id, entry);
      continue;
    }
    // Honor lastFiredAt so a partially-elapsed interval is not restarted from
    // zero on reboot or when an unrelated mission is edited: wait only the time
    // remaining until the next due fire, then settle into a steady interval.
    const remaining = Math.max(0, m.intervalMs - (Date.now() - (m.lastFiredAt ?? 0)));
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, m.intervalMs);
    }, remaining);
    missionTimers.set(m.id, entry);
  }
}

const STANDUP_MARK_KV_KEY = 'missions.opsStandup.lastDelivered';

const STRAY_BASELINE_FILE = 'stray-baseline.json';

/** The standup waits for the leftover scan (git plus `du`, seconds to a minute) and
 *  goes out without the section when the scan fails. */
function sendOpsStandup(m: ScheduledMission): void {
  const roots = [...(readConfig().registeredRepos ?? []), join(homedir(), 'src')];
  const agentNames = Object.values(hive.registry().agents ?? {}).map((a) => a.name ?? '');
  const hiveRoot = hive.root();
  let copiesSinceMs: number | undefined;
  try { copiesSinceMs = hiveRoot ? statSync(hiveRoot).birthtimeMs || undefined : undefined; } catch { /* lists every copy */ }
  let safeLeftovers = 0;
  const ledger = hive.tasks() as { tasks?: unknown[] } | null;
  const agents = Object.entries(hive.registry().agents ?? {}).map(([id, a]) => ({ id, cwd: a.cwd }));
  const leftovers = scanLeftovers(roots, agentNames, { copiesSinceMs, tasks: Array.isArray(ledger?.tasks) ? ledger.tasks : [], agents })
    .then((list) => { safeLeftovers = triageLeftovers(list, Date.now()).safe.length; return formatLeftovers(list, homedir()); })
    .catch((e) => { console.error('[standup] leftover scan', e); return null; });
  const baselineFile = hiveRoot ? join(hiveRoot, STRAY_BASELINE_FILE) : null;
  const strays = baselineFile
    ? scanStrayFiles(strayWatchDirs(loadMergeRepos(hiveRoot).map((r) => r.path)), baselineFile, agentNames)
      .then((list) => formatStrayFiles(list, baselineFile))
      .catch((e) => { console.error('[standup] stray-files scan', e); return null; })
    : Promise.resolve(null);
  void Promise.all([leftovers, strays])
    .then(([l, st]) => sendOpsStandupWith(m, [l, st].filter(Boolean).join('\n\n') || null, safeLeftovers > 0 || !!st));
}

/** `cleanup` is set when the tail lists something the Boss can act on now: a leftover
 *  safe to remove or a stray file. Stale leftovers alone never wake the Boss. */
function sendOpsStandupWith(m: ScheduledMission, leftovers: string | null, cleanup = !!leftovers): void {
  const tail = leftovers ? `\n\n${leftovers}` : '';
  runOpsStandup({
    mark: () => persist.getKv<StandupMark>(STANDUP_MARK_KV_KEY) ?? null,
    saveMark: (mark) => persist.setKv(STANDUP_MARK_KV_KEY, mark),
    tasks: () => hive.tasks(),
    logTail: (n) => hive.logTail(n),
    godId: hive.registry().godId ?? 'god',
    systemSenders: SYSTEM_SENDERS,
    send: (note) => hive.send({ to: m.to, act: 'request', subject: m.label, body: (note ? `${m.body}\n\n${note}` : m.body) + tail }, 'scheduler'),
    appendLog: (e) => hive.appendLog(e),
    now: () => Date.now(),
    usage: () => engineWindows(),
    exhausted: () => Object.keys(exhaustedEngines()),
    problems: () => [...standupProblems(hive.fleet(), hive.tasks(), liveTimings().stallAfterMs / 1000), ...(cleanup ? ['leftover or stray files to clean (listed below)'] : [])],
    ack: (note) => { hive.fileHandled({ to: 'god', act: 'inform', subject: `${m.label} (quiet, filed)`, body: note }, hive.registry().godId ?? 'god', 'scheduler'); }
  });
}

// ─── Context trigger (auto-compact / auto-clear own their own timers) ────────
// Compaction used to ride on a mission (`compact-maintenance`), which meant the
// operator had TWO competing controls for one behaviour — a schedule with an
// interval and a trigger with a cadence. The mission is retired (see the
// retirement migration in ensureDefaultMissions); these timers are the single
// remaining source of scheduled context maintenance.
//
// Main owns only the CADENCE. The pressure gate (`minContextPct`) needs each
// agent's live context usage, which only the renderer has, so the whole rule
// rides along in the event and the renderer decides which agents actually get
// the command. That split is why the payload carries the rule rather than a bare
// "go" signal.

/** Timers for the two halves, keyed by action. Same two-phase shape as
 *  `missionTimers` (a setTimeout for the remaining time, then a steady interval)
 *  so a partially-elapsed cadence survives a re-arm. */
const contextTimers = new Map<'compact' | 'clear', MissionTimer>();

/** `ContextRule` has no `lastFiredAt` (unlike `ScheduledMission`), so the last-run
 *  instants live in the durable kv store instead. Without them every re-arm —
 *  boot, a settings edit, a wake from sleep — would restart a 2h cadence from
 *  zero, and an operator who edits the rule twice a day would never see it fire. */
const CONTEXT_LAST_RUN_KV_KEY = 'triggers.context.lastRun';
let contextLastRun: Record<string, number> | null = null;

function contextRunMap(): Record<string, number> {
  if (!contextLastRun) {
    try { contextLastRun = persist.getKv<Record<string, number>>(CONTEXT_LAST_RUN_KV_KEY) ?? {}; }
    catch { contextLastRun = {}; }
  }
  return contextLastRun;
}

/** When the rule last ran. An UNRECORDED half is stamped NOW rather than read as
 *  the epoch: `remaining` would otherwise clamp to 0 and compact every terminal
 *  the instant the app boots. It is the same trap `ensureDefaultMissions` avoids
 *  by stamping `lastFiredAt` when it seeds a mission — a first launch should wait
 *  a full cadence, not open with an interruption. */
function contextLastRunAt(action: 'compact' | 'clear'): number {
  const map = contextRunMap();
  const v = map[action];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return stampContextRun(action);
}

function stampContextRun(action: 'compact' | 'clear'): number {
  const map = contextRunMap();
  const at = Date.now();
  map[action] = at;
  try { persist.setKv(CONTEXT_LAST_RUN_KV_KEY, map); } catch { /* DB best-effort */ }
  return at;
}

/** The live rule for one half, deep-filled. `readConfig` already fills both
 *  halves, so the default is only a belt-and-braces fallback. */
function contextRule(action: 'compact' | 'clear'): ContextRule {
  return readConfig().contextTrigger?.[action] ?? DEFAULT_CONTEXT_TRIGGER[action];
}

/** Clear and forget both context timers (setTimeout + setInterval handles). */
function clearContextTimers(): void {
  for (const t of contextTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  contextTimers.clear();
}

/** Ask the renderer to run one half of the context trigger.
 *
 *  Both callers funnel through here — the legacy per-mission `autoCompact` flag
 *  and the context trigger's own timer — so there is exactly one path from main
 *  to the renderer for each action. */
function emitContextTrigger(action: 'compact' | 'clear', rule: ContextRule): void {
  try { liveWebContents()?.send('trigger:context', { action, rule }); } catch { /* window gone */ }
  // TRANSITIONAL ALIAS: the renderer still carries the pre-Triggers
  // `mission:autoCompact` listener as a fallback. Both fire for compact until
  // every consumer has moved to `trigger:context`; then this line goes.
  if (action === 'compact') {
    try { liveWebContents()?.send('mission:autoCompact'); } catch { /* window gone */ }
  }
}

/** (Re)arm both context timers from persisted config. Clear-then-arm, so calling
 *  it after a settings change, on boot, or on wake from sleep can never stack
 *  duplicates. Honors elapsed-time-since-last-run exactly like mission arming:
 *  an overdue rule fires ONCE and then settles into its steady cadence. */
function syncContextTriggers(): void {
  clearContextTimers();
  for (const action of ['compact', 'clear'] as const) {
    const rule = contextRule(action);
    if (!rule.enabled || !(rule.everyMs > 0)) continue;
    const fire = (): void => {
      try {
        stampContextRun(action);
        // Re-read: the operator may have edited the message/thresholds since the
        // timer was armed, and the renderer should act on what's current.
        emitContextTrigger(action, contextRule(action));
      } catch (e) {
        console.error('[triggers] context', action, e);
      }
    };
    const remaining = Math.max(0, rule.everyMs - (Date.now() - contextLastRunAt(action)));
    const entry: MissionTimer = {};
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, rule.everyMs);
    }, remaining);
    contextTimers.set(action, entry);
  }
}

/** Bring registry dormant/archived flags in line with the renderer roster.
 *
 *  At boot (bootstrapHiveServices, before the renderer can spawn anything) no
 *  worker owns a PTY, so every roster agent becomes DORMANT: kept in fleet.json
 *  and reachable by mail, but asleep until useHive wakes it with work. Any other
 *  `archived:false` entry is a stale carry-over (e.g. the pre-acc13a3 'assistant'
 *  Dwight) and is archived (#57/#58). After boot it reruns on every roster write
 *  so a dismissed or reopened restorable agent follows the roster.
 *
 *  "No live PTY" = ptyForAgent(id) === undefined (ptyToAgent is populated only at
 *  spawn and pruned on teardown). The breaker beat skips every PTY-less agent,
 *  dormant ones included, so none of them is ever steered. */
function syncDormancyWithRoster(boot: boolean): void {
  if (!hive.enabled()) return;
  try {
    const snap = roster.read();
    if (!snap && !boot) return;
    const restorable = rosterIdsOf(snap?.restorable);
    const reg = hive.registry();
    const plan = planDormancy(reg.agents, {
      godId: reg.godId,
      liveIds: new Set(Object.keys(reg.agents).filter((id) => ptyForAgent(id))),
      rosterIds: new Set([...rosterIdsOf(snap?.agents), ...restorable]),
      restorableIds: new Set(restorable),
      boot
    });
    if (!plan.dormant.length && !plan.archived.length) return;
    hive.setDormancy(plan);
    console.log('[dormancy] dormant:', plan.dormant.join(', ') || '-', 'archived:', plan.archived.join(', ') || '-');
  } catch (e) {
    console.error('[dormancy] sync failed:', e);
  }
}

/** One-time migration: ensure the built-in hourly ops standup exists for installs
 *  that predate it. Guarded by `opsStandupSeeded` so a user who later deletes the
 *  mission doesn't get it re-added on every boot. Stamps lastFiredAt = now so the
 *  first standup waits a full interval instead of firing (and compacting every
 *  terminal) immediately on launch. */
function ensureDefaultMissions(): void {
  const cfg = readConfig();
  if (!cfg.opsStandupSeeded) {
    const missions = cfg.missions ?? [];
    const has = missions.some((m) => m.id === OPS_STANDUP_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...OPS_STANDUP_MISSION, lastFiredAt: Date.now() }],
      opsStandupSeeded: true
    });
  }
  const cfgLedger = readConfig();
  if (!cfgLedger.engineLedgerReviewSeeded) {
    const missions = cfgLedger.missions ?? [];
    const has = missions.some((m) => m.id === ENGINE_LEDGER_REVIEW_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...ENGINE_LEDGER_REVIEW_MISSION, lastFiredAt: Date.now() }],
      engineLedgerReviewSeeded: true
    });
  }
  // Seed the built-in heartbeat (Lane A #1) once. Shipped DISABLED, so it just
  // appears in the SCHEDULES panel for the user to turn on; lastFiredAt = now so
  // it doesn't fire on the very first launch after a user enables it.
  const cfg2 = readConfig();
  if (!cfg2.heartbeatSeeded) {
    const missions = cfg2.missions ?? [];
    const has = missions.some((m) => m.id === HEARTBEAT_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...HEARTBEAT_MISSION, lastFiredAt: Date.now() }],
      heartbeatSeeded: true
    });
  }

  // maint-1 RETIREMENT: `compact-maintenance` is no longer a mission. Scheduled
  // compaction is now the CONTEXT TRIGGER's job, so the operator has exactly one
  // control (a cadence + a pressure gate + an editable message) instead of two
  // that could disagree — a mission saying "hourly" while the trigger said "2h"
  // was a real, unresolvable conflict.
  //
  // The carry-over preserves the operator's decisions: whether compaction was ON
  // and how often. It runs at most once per install, and its guard is the
  // mission's own ABSENCE — nothing seeds `compact-maintenance` any more, so once
  // this has removed it there is nothing left to carry and a later hand-edit of
  // the trigger can never be clobbered. That keeps the `*Seeded` convention's
  // promise (exactly once, ever) without a config flag that would only ever be
  // read here; `compactMaintenanceSeeded` is left set so nothing re-seeds it.
  const cfg3 = readConfig();
  const missions3 = cfg3.missions ?? [];
  const retiring = missions3.find((m) => m.id === COMPACT_MAINTENANCE_MISSION.id);
  if (retiring) {
    const current = cfg3.contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
    writeConfig({
      missions: missions3.filter((m) => m.id !== COMPACT_MAINTENANCE_MISSION.id),
      contextTrigger: {
        ...current,
        compact: {
          ...current.compact,
          enabled: retiring.enabled,
          // A hand-tuned interval is a decision; only a missing/absurd one falls
          // back to whatever the trigger already carries.
          everyMs: retiring.intervalMs > 0 ? retiring.intervalMs : current.compact.everyMs
        }
      },
      compactMaintenanceSeeded: true
    });
    // …and its elapsed time, so retiring the mission mid-cycle doesn't restart a
    // 2h cadence from zero (the timers honour last-run exactly as arming did).
    if (typeof retiring.lastFiredAt === 'number' && retiring.lastFiredAt > 0) {
      const map = contextRunMap();
      map.compact = retiring.lastFiredAt;
      try { persist.setKv(CONTEXT_LAST_RUN_KV_KEY, map); } catch { /* DB best-effort */ }
    }
    console.log('[triggers] retired the compact-maintenance mission into contextTrigger.compact',
      `(enabled: ${retiring.enabled}, everyMs: ${retiring.intervalMs})`);
  }

  // autoCompact RETIREMENT: the flag above was only ever half-removed. Retiring
  // `compact-maintenance` left `autoCompact: true` sitting on the ops standup, so
  // a default install still asked for compaction on TWO cadences — hourly from the
  // standup, 2-hourly from the trigger — which is precisely the disagreement that
  // retirement claims to have ended. (config.ts even documented a migration that
  // strips this; it did not exist.)
  //
  // Strip it wherever it survives. This is a pure de-duplication, not a behaviour
  // change: contextTrigger.compact still runs, still on the user's own cadence and
  // pressure gate, and it is what actually performed every one of these
  // compactions already — both paths have called emitContextTrigger since Triggers
  // landed. Idempotent, so it costs one no-op scan per boot once clean.
  const cfg4 = readConfig();
  const missions4 = cfg4.missions ?? [];
  if (missions4.some((m) => m.autoCompact)) {
    writeConfig({
      missions: missions4.map(({ autoCompact, ...rest }) => {
        void autoCompact;
        return rest;
      })
    });
    console.log('[triggers] dropped the legacy per-mission autoCompact flag —',
      'contextTrigger.compact is now the only schedule that compacts');
  }
}

// ─── Heartbeat (Lane A #1) + circuit-breaker beat (#6.6b) ────────────────────

/** Is the floor quiet? Derived ONLY from signals the main process owns or can
 *  stat — log.jsonl mtime (the master signal: every routed msg/drain/spawn/task
 *  append touches it), each agent's inbox + outbox/.sent mtimes, and every live
 *  PTY's lastOutputAt (an agent printing/thinking counts as activity). Crucially
 *  NOT registry.status, which is written 'idle' once at spawn and never
 *  transitions in main — reading it would see the floor quiet forever. */
function isFloorQuiet(thresholdMs: number): boolean {
  const root = hive.root();
  if (!root) return false;
  const times: number[] = [];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
  pushMtime(join(root, 'log.jsonl'));
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      pushMtime(join(agentsDir, id, 'inbox'));
      pushMtime(join(agentsDir, id, 'outbox', '.sent'));
    }
  }
  for (const t of ptyManager.list()) times.push(t.lastOutputAt);
  if (times.length === 0) return false; // nothing to judge → don't fire
  return Date.now() - Math.max(...times) > thresholdMs;
}

/** Newest coordination-file mtime for one agent (inbox + inbox/.done, outbox +
 *  outbox/.sent, memory.md) — FILES only, deliberately excluding PTY output, so
 *  "no-progress" means "not coordinating" even while the agent is busy printing
 *  tokens. inbox/.done and the outbox dir count because handling mail (moving a
 *  message to .done, drafting an outbox message) IS coordination — without them
 *  an inbox-ack turn reads as no-progress (issue #109's second trigger). */
function lastCoordinationAt(agentId: string): number {
  const root = hive.root();
  if (!root) return 0;
  const times: number[] = [0];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
  const dir = join(root, 'agents', agentId);
  pushMtime(join(dir, 'inbox'));
  pushMtime(join(dir, 'inbox', '.done'));
  pushMtime(join(dir, 'outbox'));
  pushMtime(join(dir, 'outbox', '.sent'));
  pushMtime(join(dir, 'memory.md'));
  return Math.max(...times);
}

/** Newest mtime of the agent's OWN WORKING DIRECTORY — the work
 *  `lastCoordinationAt` cannot see. 0 when there is nothing to read.
 *
 *  Provider neutral by construction: `cwd` is the agent's registry entry, the
 *  same field every supported CLI is spawned into, and none of the paths below
 *  is specific to any one of them. An agent whose `cwd` is not a git checkout
 *  simply falls back to the directory's own mtime; an agent with no `cwd` at
 *  all returns 0 and behaves exactly as it does today.
 *
 *  Cheap by construction: a handful of `stat` calls on fixed paths, never a
 *  directory walk. This runs for every agent on every beat, and a working
 *  directory can hold hundreds of thousands of files. Git is what makes it
 *  affordable — each of these is rewritten by ordinary work:
 *
 *    cwd                  a file or directory added or removed at the top level
 *    .git/index           any `git add`, `git status`, `git checkout`
 *    .git/logs/HEAD       the reflog: commit, checkout, reset, merge, rebase
 *    .git/FETCH_HEAD      fetch and pull
 *    .git/packed-refs     and `.git/refs/remotes`: a push updating a tracking ref
 *
 *  Its honest limit: editing a file deep in the tree while running no git
 *  command moves none of these. That case is already covered by the breaker's
 *  own distinct-tool clock, so the two signals are complementary rather than
 *  redundant — this one exists for the window where tool events do not reach
 *  the breaker but the work is unmistakably real.
 */
function lastWorkAt(agentId: string): number {
  const cwd = hive.registry().agents[agentId]?.cwd;
  if (!cwd) return 0;
  const times: number[] = [0];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
  pushMtime(cwd);
  const git = join(cwd, '.git');
  pushMtime(join(git, 'index'));
  pushMtime(join(git, 'logs', 'HEAD'));
  pushMtime(join(git, 'FETCH_HEAD'));
  pushMtime(join(git, 'refs', 'remotes'));
  pushMtime(join(git, 'packed-refs'));
  return Math.max(...times);
}

/** PTY id owning a given agent id, or undefined. */
const crashTracker = new CrashTracker();

/** A roster worker whose CLI died on its own: the renderer puts it back to sleep (a dead
 *  tab is not dormant, so neither its cards, its mail nor a wake request could start it),
 *  automatic wakes wait out a growing backoff, and the Boss hears about it. */
function reviveCrashedWorker(agentId: string, ptyId: string, exitCode: number | undefined, signal: number | undefined): void {
  const reg = hive.registry();
  const a = reg.agents[agentId];
  if (!a || a.isGod || a.isAssistant || a.archived || agentId === reg.godId) return;
  // A temporary worker is torn down on exit (card archived, clean worktree removed),
  // so putting it back to sleep would wake it into a deleted cwd. Report, never revive.
  const worker = liveWorkers.get(ptyId);
  if (worker) {
    hive.appendLog({ kind: 'agent-crash-revive', agentId, revive: false, worker: true });
    informGod(`[worker crashed] ${worker.name}`, `Temporary worker ${agentId} exited abnormally (code ${exitCode ?? '?'}, signal ${signal ?? 0}) and was not revived; its crash tail is under hive/crashes/. Re-request it if the work is still wanted.`, worker.slack);
    return;
  }
  const plan = crashTracker.record(agentId);
  hive.appendLog({ kind: 'agent-crash-revive', agentId, revive: plan.revive, crashesInWindow: plan.crashesInWindow, backoffMs: Number.isFinite(plan.backoffMs) ? plan.backoffMs : null });
  try { liveWebContents()?.send('hive:agentCrashed', { agentId, ptyId }); } catch { /* window gone */ }
  const notice = crashNotice(a.name ?? agentId, agentId, exitCode, signal, plan);
  try { hive.send({ to: 'boss', act: 'inform', subject: notice.subject, body: notice.body, requires_reply: false }, 'harness'); } catch (e) { console.error('[crash] notify failed:', e); }
}

function ptyForAgent(agentId: string): string | undefined {
  for (const [ptyId, a] of ptyToAgent) if (a === agentId) return ptyId;
  return undefined;
}

/** "Stuck" = some worker's PTY is actively printing (recent output) while its
 *  coordination files have gone stale — working-but-not-coordinating. Tightens
 *  the heartbeat cadence so we notice a wedged agent sooner. */
function looksStuck(windowMs: number): boolean {
  const reg = hive.registry();
  const now = Date.now();
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived || id === reg.godId) continue;
    const ptyId = ptyForAgent(id);
    if (!ptyId) continue;
    const idle = ptyManager.idleFor(ptyId) ?? Infinity;
    if (idle < 15_000 && now - lastCoordinationAt(id) > windowMs) return true;
  }
  return false;
}

/** Bounded digest for god — paths + counts, never full files (reference-passing,
 *  #6.2). A few hundred tokens at most. */
function buildHeartbeatDigest(quietMs: number, actionable = 0): string {
  const reg = hive.registry();
  const active = Object.entries(reg.agents).filter(([id, a]) => !a.archived && !a.dormant && id !== reg.godId);
  const names = active.map(([, a]) => a.name).join(', ') || '—';
  const dormant = Object.entries(reg.agents).filter(([id, a]) => a.dormant && !a.archived && id !== reg.godId);
  const boardHead = hive.board().split('\n').slice(0, 10).join('\n').trim();
  const log = hive.logTail(8).map((e) => { try { return JSON.stringify(e); } catch { return ''; } }).filter(Boolean).join('\n');
  const withInbox = active.filter(([id]) => hive.inbox(id).length > 0).map(([, a]) => a.name);
  // When real agent/human mail is waiting, lead with an explicit call-to-action
  // instead of the "quiet" line — this beat fired BECAUSE of unread actionable
  // inbox, not because the floor went quiet, and god must read it now.
  const header = actionable > 0
    ? `Floor heartbeat — ${actionable} actionable inbox message(s) awaiting you (worker/human mail). Drain your inbox NOW and act on them.`
    : `Floor heartbeat — quiet ~${Math.round(quietMs / 60000)}m.`;
  return [
    header,
    `Active agents (${active.length}): ${names}.`,
    ...(dormant.length ? [`Dormant, asleep until they have work (not stalled): ${dormant.map(([, a]) => a.name).join(', ')}.`] : []),
    withInbox.length ? `Undrained inbox: ${withInbox.join(', ')}.` : 'No undrained inboxes.',
    '',
    'Board (head):',
    boardHead || '(empty)',
    '',
    'Recent log:',
    log || '(none)',
    '',
    'Re-engage anyone stalled or blocked and keep the board accurate — or rest if the work is genuinely done.'
  ].join('\n');
}

/** Senders whose mail is the scheduler's OWN noise (heartbeat beats, ops-standup
 *  via 'scheduler', breaker steers, generic 'system') — never a reason to wake
 *  god. Everything else (a worker agent id, 'webhook', a human reply) is real
 *  mail god must act on. Kept narrow so any future real sender counts by default. */
const SYSTEM_SENDERS = new Set(['heartbeat', 'scheduler', 'breaker', 'system']);

/** Count of UNREAD actionable messages in god's inbox — real agent/human mail,
 *  excluding the scheduler's own beats. Drives an inbox-aware re-engage so a
 *  worker's reply (or a human answer) doesn't sit unread while the floor is busy:
 *  the floor-quiet gate alone misses that case — any active agent keeps the floor
 *  "loud", so god was never re-engaged until everything else went idle. */
function godActionableInboxCount(): number {
  try {
    const godId = hive.registry().godId;
    if (!godId) return 0;
    return hive.inbox(godId).filter((m) => !SYSTEM_SENDERS.has(m.from)).length;
  } catch { return 0; }
}

/** Re-engage a quiet floor: drop a durable digest into god's inbox. We never
 *  type directly into god's PTY here — if he's busy that would jam mid-step. The
 *  inbox message is delivered by the renderer's busy-aware inbox-wake (it nudges
 *  god to read his inbox only once he's idle), so the heartbeat defers around a
 *  working god instead of interrupting him. */
function reengageGod(digest: string): void {
  if (!hive.enabled()) return;
  hive.send({ to: getMessageRoute('heartbeat', readConfig(), isKnownAgent), act: 'request', subject: 'Heartbeat', body: digest }, 'heartbeat');
}

/** A native toast for breaker constrain/stop, gated on the notifications setting. */
function breakerToast(title: string, body: string): void {
  if (!readConfig().notifications) return;
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); }
  catch { /* unsupported platform */ }
}

/** One circuit-breaker beat: pull a fresh usage sample per active agent, append
 *  it to the durable cost ledger (the SOLE durable cost store), tick the breaker,
 *  emit each BreakerState on control:breakerState (Seam 2), and enforce any
 *  escalation. God is in the LEDGER (cost visibility) but NOT the breaker inputs
 *  (the heartbeat manages god; we never auto-steer/kill the orchestrator). */
function runBreakerBeat(progressWindowMs: number): void {
  if (!hive.enabled()) return;
  const reg = hive.registry();
  const now = Date.now();
  const inputs: BreakerInput[] = [];
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived) continue;
    // #57/#58: skip assistant + orphaned shells. The breaker must only evaluate
    // live, real agents. An assistant entry (e.g. the pre-acc13a3 headless
    // 'Dwight') or any orphaned entry left archived:false with NO live PTY would
    // otherwise be steered, and that steer bounces to GOD as a requires_reply GOD
    // can't clear → inbox flood. ptyForAgent(id) === undefined means no live PTY.
    // God is exempt from this orphan check (it keeps its own flow + the godId skip
    // below) so its ledger row is unaffected. Live real agents always own a PTY
    // (ptyToAgent is set at spawn), so their breaker behavior is unchanged.
    if (a.isAssistant) continue;
    if (id !== reg.godId && !ptyForAgent(id)) continue;
    const sample = usageProvider.getAgentUsage(id);
    // #56: only append a ledger row for a LIVE session sample. A dead/orphaned
    // agent with a frozen transcript still yields a sample via the transcript
    // fallback, but with an EMPTY sessionId (aggregateLive returns null → no live
    // OTel session). Appending it every ~30s rewrote the identical row forever
    // (2,417 dupes observed). A truthy sessionId is set only by a live session
    // (aggregateLive picks the most-recent live session id), so this gates on
    // "is there a live session" without changing any live-agent behavior.
    if (sample?.sessionId) hive.appendCostLedger(sample); // ledger covers everyone incl. god
    // Second source for the resume key. recordSession() is otherwise reachable
    // ONLY from the hook shim, so any window where hooks don't land leaves the
    // registry with no sessionId and "Restart & Continue" refuses to continue —
    // while this very sample proves the app knew the live session id all along
    // (it was already being written to the cost ledger one line above). Same id,
    // same liveness gate; recordSession writes only on change, so this is a
    // no-op once the hooks are flowing.
    if (sample?.sessionId) hive.recordSession(id, sample.sessionId);
    if (id === reg.godId) continue;            // breaker skips god
    // Progress = fresh coordination files OR a recent OTel tool span. The span
    // leg closes the background-work blind spot: subagent/Workflow tool calls
    // never reach the parent session's PostToolUse hook (so the breaker's own
    // distinct-tool clock stays stale) but their spans DO flow through the
    // collector under this agent's id — an idle parent supervising a hard-
    // working background fleet is progressing, not wedged. Observed live: the
    // one residual no-progress false positive after the #109 fixes.
    const spans = telemetry.getSpans(id);
    const lastSpanAt = spans.length ? spans[spans.length - 1].ts : 0;
    inputs.push({
      agentId: id,
      sample,
      progressing: now - lastCoordinationAt(id) < progressWindowMs || now - lastSpanAt < progressWindowMs,
      // Work, as distinct from coordination. The breaker decides what to do
      // with it; the beat only reports it.
      lastWorkAt: lastWorkAt(id)
    });
  }
  for (const d of breaker.tick(inputs, now)) {
    try { liveWebContents()?.send('control:breakerState', d.state); } catch { /* window gone */ }
    if (d.action === 'none') continue;
    const name = reg.agents[d.state.agentId]?.name ?? d.state.agentId;
    const reason = d.state.reason;
    if (d.action === 'steer') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: steer',
        body: `Automated guardrail: ${reason}. Re-check your approach — if you're looping or stuck, STOP repeating, summarize what you've tried, and ask the Boss for direction.` }, 'breaker');
    } else if (d.action === 'constrain') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: constrain',
        body: `Automated guardrail escalated: ${reason}. Stop active work now: switch to read-only/plan, write a short plan of your next step, and send it to the Boss for sign-off BEFORE running more tools.` }, 'breaker');
      breakerToast(`${name} constrained`, reason);
    } else if (d.action === 'stop') {
      const ptyId = ptyForAgent(d.state.agentId);
      if (ptyId) { try { ptyManager.kill(ptyId); } catch { /* already gone */ } teardownPty(ptyId); }
      breakerToast(`${name} stopped by circuit breaker`, reason);
    }
  }
}

/** Lifetime spend, folded from cost-ledger.jsonl. `telemetry`'s usd counter is
 *  cumulative-since-process-start and restarts at ~0 on every app restart, so
 *  it cannot answer "what has this agent cost us". See costLifetime.ts. */
const costTotals = new CostLedgerTotals();

/** Build + write the live fleet snapshot Michael reads (`<hive>/fleet.json`).
 *  Always-on (independent of the heartbeat) since `claude agents` can't see the
 *  hive's sibling sessions. PII-free; never throws (called from a timer). */
function writeFleetSnapshot(): void {
  if (!hive.enabled()) return;
  try {
    const reg = hive.registry();
    const snap = telemetry.snapshot();
    const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
    const now = Date.now();
    // Async + incremental; returns immediately and never throws into the timer.
    const hiveRoot = hive.root();
    if (hiveRoot) void costTotals.refresh(join(hiveRoot, 'cost-ledger.jsonl'));
    ensureRefusalsLoaded();
    const rosterViews = limitRosterAgents();
    const views = [...rosterViews.live, ...rosterViews.dormant];
    const exhaustion = exhaustedEngines(now);
    const agents = Object.entries(reg.agents)
      .filter(([, a]) => !a.archived)
      .map(([id, a]) => {
        const view = views.find((v) => v.id === id);
        const current = view?.current ?? { provider: a.provider ?? 'claude' };
        const ladder = view ? agentWalk(view, now, false).walk.map((w) => w.entry) : [current];
        const refusal = current.provider === 'antigravity' ? (current.model ? agyRefusals.active(current.model, now) : agyRefusals.forAgent(id, undefined, now)) : undefined;
        const wait = limitWaits.get(id);
        const engine = engineFor(current.provider, current.model);
        const blocked = !!refusal || !!wait || !!pendingSwitches.get(id) || (!!engine && isExhausted(exhaustion, engine, now));
        const u = usageById.get(id) ?? offTranscriptUsage(id, a.provider, a.sessionId);
        const spans = snap.spans[id] ?? [];
        const tokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
        // `usd` is LIFETIME (reset-corrected). Until the first fold completes we
        // fall back to the session figure rather than publishing a cold $0.
        const lifetime = costTotals.usdFor(id);
        const sessionUsd = u ? Number(u.usd.toFixed(4)) : 0;
        return {
          id,
          name: a.name,
          role: a.role ?? (a.isGod ? 'orchestrator' : 'agent'),
          cwd: a.cwd,
          isGod: !!a.isGod,
          breaker: breaker.levelFor(id),
          tokens,
          usd: lifetime === null ? sessionUsd : Number(lifetime.toFixed(4)),
          sessionUsd,
          lastTool: spans.length ? spans[spans.length - 1].tool : (u as { lastTool?: string | null } | undefined)?.lastTool ?? null,
          lastActiveSecAgo: u ? Math.round((now - u.ts) / 1000) : null,
          activityUnknown: activityUnknown(a.provider, u),
          inboxBacklog: hive.inboxBacklog(id),
          onHold: !!a.onHold,
          dormant: !!a.dormant,
          quotaBlocked: blocked,
          engine: engine ?? null,
          model: current.model ?? null,
          ladder,
          resetAt: refusal?.resetAtMs ?? wait?.resetAtMs ?? (engine ? exhaustion[engine]?.untilMs : undefined) ?? null,
          seen: refusal?.seenAtMs ?? (engine ? limitHits.get(engine)?.atMs : undefined) ?? null,
          switchPending: pendingSwitches.has(id),
          jailRefused: jailRefusals.get(id)
        };
      });
    hive.writeFleetSnapshot({ ts: now, agents, hiveCommit: hive.commitHealth() });
    // Same 8s cadence; a no-op until tasks.json changes.
    hive.refreshTaskViews();
    pollCodexIdle();
    noteTasksChanged();
  } catch (e) {
    console.error('[fleet] snapshot failed:', e);
  }
}

/** Arm the heartbeat with an adaptive, self-rescheduling cadence (recursive
 *  setTimeout instead of a fixed setInterval). Each beat runs the cost/breaker
 *  pass, re-engages a quiet floor, stamps lastFiredAt, then re-arms: ~base on a
 *  normal beat, base/4 (min 30s) when an agent looks stuck, base*2.5 right after
 *  a re-engage. Registered into missionTimers so shutdown tears it down. */
function armHeartbeat(m: ScheduledMission): void {
  const base = m.intervalMs;
  const quiet = m.quietThresholdMs ?? 300_000;
  const beat = (): void => {
    let next = base;
    try {
      // (the breaker beat + cost ledger now run on their own always-on timer)
      // Re-engage god when the floor is quiet OR when real agent/human mail is
      // waiting in god's inbox — the latter is independent of floor-quiet so a
      // worker's reply doesn't sit unread while other agents keep the floor busy.
      const actionable = godActionableInboxCount();
      if (isFloorQuiet(quiet) || actionable > 0) {
        reengageGod(buildHeartbeatDigest(quiet, actionable));
        next = Math.round(base * 2.5);            // back off after re-engaging
      } else if (looksStuck(quiet)) {
        next = Math.max(30_000, Math.round(base / 4)); // tighten when an agent is wedged
      }
      const cur = readConfig().missions ?? [];
      writeConfig({ missions: cur.map((x) => (x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x)) });
      try { liveWebContents()?.send('missions:updated'); } catch { /* window gone */ }
    } catch (e) {
      console.error('[heartbeat]', e);
    }
    const entry = missionTimers.get(m.id) ?? {};
    entry.timeout = setTimeout(beat, next);
    missionTimers.set(m.id, entry);
  };
  const remaining = Math.max(0, base - (Date.now() - (m.lastFiredAt ?? 0)));
  missionTimers.set(m.id, { timeout: setTimeout(beat, remaining) });
}

/** The live renderer webContents, or null if the window is gone/destroyed.
 *  Anything that emits to the renderer from a timer/socket/child callback must
 *  route through here — during quit the window can be destroyed while those
 *  callbacks are still in flight, and `.send()` on a destroyed webContents
 *  throws "Object has been destroyed" (the main-process crash dialog). */
function liveWebContents(): Electron.WebContents | null {
  const wc = mainWindow?.webContents;
  if (wc && !wc.isDestroyed()) return wc;
  // Primary gone (closed/destroyed): fall back to any other live window so a
  // global event still reaches a renderer instead of being silently dropped.
  for (const w of allWindows) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents;
  }
  return null;
}

// ─── Slack webhook server (Slack message → Michael's queue) ──────────────────
/** The running Slack ingestion server, or null when disabled/stopped. */
let slackServer: SlackWebhookServer | null = null;
/** The loopback-only reply endpoint (lets the bundled helper post back to Slack
 *  without ever seeing the bot token). Lifecycle is tied to `slackServer`. */
let slackReplyServer: SlackReplyServer | null = null;
/** Last public tunnel URL handed out — persisted so Settings can re-show the
 *  Request URL after a reopen (Slack reuses it until the server is stopped). */
let lastSlackUrl: string | undefined;

/** AUTONOMOUS REQUEST PROTOCOL — built PER MESSAGE (not a static const) so it can
 *  embed the request's concrete `channel`, `thread_ts`, and the resolved helper
 *  path. Prepended (server-side, authoritatively) to the working instruction god
 *  reads for any Slack-origin request: there is no interactive human at the
 *  keyboard, so god must route fast, delegate WITH the exact reply command (so the
 *  worker posts its real result back into THIS thread itself), stay autonomous,
 *  and only block on enumerated high-severity actions. Prepended to god's PROMPT
 *  only — the human-facing kanban card TITLE stays the user's raw text (the
 *  renderer keeps them split). Trailing space is intentional so the user's message
 *  reads naturally after it. */
function buildAutonomousRequestProtocol(channel: string, threadTs: string, helperPath: string): string {
  return `[AUTONOMOUS REQUEST PROTOCOL — this request arrived via Slack; no interactive human is watching] Handle it under this protocol:
1. ROUTE FAST — triage and hand this to the single most-relevant agent right away. CHECK THE LIVE ROSTER FIRST (active agents in registry.json + their state in fleet.json) and prefer an EXISTING agent that fits — especially when the request names one ("ask Pam…", "have Jim…"): route to that agent and only spawn a new one if none is a sensible fit. Decompose only if it genuinely needs several. Don't sit on it.
2. DELEGATE WITH THE REPLY HANDLE — tell that agent to do the work autonomously AND to post its result back to THIS Slack thread itself when done, using exactly: "${hive.nodeCommand()}" "${helperPath}" --channel ${channel} --thread ${threadTs} --text "<substantive result>" (that first path is the harness's bundled Node, already resolved for this machine — pass it verbatim; bare "node" is not on the hook/agent PATH on many machines.)
3. AUTONOMOUS EXECUTION — no interactive questions. PAUSE/ask ONLY for high-severity actions: pushing to main or any remote; buying or spawning infrastructure or paid services; deleting an existing repo, file, or folder it did not create. Stay READ-ONLY at critical infrastructure and git-push-type changes unless explicitly approved.
4. DIRECT, SUBSTANTIVE REPLY — the agent posts a real Slack-mrkdwn answer (short *bold* headline + the actual outcome/specifics/links), NEVER a bare "done"/":white_check_mark:".
5. REPORT TO THE BOSS — the agent then tells you (Michael) what it did.
6. ASYNC QUESTIONS — if a decision is genuinely needed, don't block: post the question + numbered OPTIONS to the thread via that reply command, and record {q, options, askedAt (ISO + day & time), thread_ts ${threadTs}} so the threaded human reply correlates back and resumes.
The user's message starts now: `;
}

// ─── Slack done-notifier (Slack-origin task → done → one summary reply) ───────
/** Polls the shared kanban (hive/tasks.json) for Slack-origin tasks that reach
 *  'done' and posts ONE summary reply into the originating thread. Lifecycle is
 *  tied to `slackServer`. OUTBOUND-only: it never touches inbound queue/lanes. */
let slackDoneTimer: ReturnType<typeof setInterval> | null = null;
/** Re-entrancy guard so a slow post can't overlap the next tick. */
let slackDonePolling = false;
/** Task ids already notified — exactly-once across re-reads AND restarts. Lazily
 *  loaded from / persisted to `slackDoneNotifiedPath()`. */
let slackDoneNotified: Set<string> | null = null;
/** Ids already 'done' when the observer started — baselined (never notified) so a
 *  summary only ever fires on a live …→done transition, not on pre-existing dones. */
let slackDoneBaseline: Set<string> | null = null;
/** thread_ts values an agent has ALREADY answered directly via the loopback
 *  `/reply` endpoint. The done-summary poller skips these — the agent's own
 *  substantive reply already landed in-thread, so the poller is a fallback, not a
 *  duplicator (this is what stops the bare/duplicate `:white_check_mark:` posts). */
const directlyRepliedThreads = new Set<string>();

/** Absolute path to the bundled `md-slack-reply.cjs` helper. Packaged: under
 *  `process.resourcesPath` (electron-builder extraResources). Dev: the repo's
 *  `resources/` dir, resolved from the app path. */
function slackReplyScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'md-slack-reply.cjs')
    : join(app.getAppPath(), 'resources', 'md-slack-reply.cjs');
}

/** W3 — the bundled read-only `skills/` source dir copied into each agent's
 *  `.claude/skills/` at spawn. Same packaged/dev resolution as the helpers above.
 *  Tolerated-missing until lp-manifest (Kevin) populates it (the hive copy is a
 *  no-op on an absent dir). */
function skillsResourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills');
}

/** Where the helper discovers `{ port, token }` for the loopback endpoint. Kept
 *  under userData (NOT the git repo, NOT mined into MemPalace). */
function slackReplyConfigPath(): string {
  return join(app.getPath('userData'), 'slack-reply.json');
}

/** Ledger of task ids whose done-summary has already been posted. Ids ONLY — no
 *  secret ever lands here. Under userData (out of the repo, out of MemPalace). */
function slackDoneNotifiedPath(): string {
  return join(app.getPath('userData'), 'slack-done-notified.json');
}

/** Directory where downloaded Slack attachments are saved (out of repo, out of MemPalace). */
function slackFilesDir(): string {
  return join(app.getPath('userData'), 'slack-files');
}

/** Per-file download size cap — reject files larger than 10 MB before writing. */
const SLACK_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Sanitize a Slack filename: keep only the basename, replace non-safe chars,
 *  prefix with a random hex tag to prevent collisions and path-traversal attacks. */
function sanitizeSlackFilename(name: string | undefined, tag: string): string {
  const safe = (typeof name === 'string' && name)
    ? basename(name).replace(/[^\w.\-]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'file'
    : 'file';
  return `${tag}-${safe}`;
}

/**
 * Download a single Slack private file into slackFilesDir() using the bot token.
 * Returns the local path on success, null on any failure (size limit, network, etc.).
 * The bot token is used only in the Authorization header and is NEVER logged.
 */
function downloadSlackFile(
  file: SlackEventFile,
  botToken: string,
  destDir: string
): Promise<{ path: string; name: string; mimetype: string } | null> {
  return new Promise((resolve) => {
    const tag = randomBytes(4).toString('hex');
    const filename = sanitizeSlackFilename(file.name, tag);
    const destPath = join(destDir, filename);
    const name = file.name ?? filename;
    const mimetype = file.mimetype ?? 'application/octet-stream';

    try {
      mkdirSync(destDir, { recursive: true });
    } catch {
      resolve(null);
      return;
    }

    let urlObj: URL;
    try {
      urlObj = new URL(file.url_private);
    } catch {
      resolve(null);
      return;
    }
    if (urlObj.protocol !== 'https:') { resolve(null); return; }

    const req = httpsRequest(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'GET',
        headers: { authorization: `Bearer ${botToken}` } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume(); // drain response body
          resolve(null);
          return;
        }
        let written = 0;
        let aborted = false;
        const stream = createWriteStream(destPath);
        res.on('data', (chunk: Buffer) => {
          if (aborted) return;
          written += chunk.length;
          if (written > SLACK_FILE_MAX_BYTES) {
            aborted = true;
            stream.destroy();
            try { unlinkSync(destPath); } catch { /* best-effort cleanup */ }
            res.destroy();
            resolve(null);
            return;
          }
          stream.write(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          stream.end(() => resolve({ path: destPath, name, mimetype }));
        });
        res.on('error', () => { stream.destroy(); resolve(null); });
        stream.on('error', () => { res.destroy(); resolve(null); });
      }
    );
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Download all raw Slack files (up to cap) and return the local-path file list.
 * Failures are silently dropped — a partial list is still useful to the agent.
 */
async function downloadSlackFiles(
  rawFiles: SlackEventFile[],
  botToken: string | undefined
): Promise<{ path: string; name: string; mimetype: string }[]> {
  if (!rawFiles.length || !botToken) return [];
  const destDir = slackFilesDir();
  const results = await Promise.all(
    rawFiles.map((f) => downloadSlackFile(f, botToken, destDir))
  );
  return results.filter((r): r is { path: string; name: string; mimetype: string } => r !== null);
}

function loadSlackDoneNotified(): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(slackDoneNotifiedPath(), 'utf8'));
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch { /* missing/corrupt → start empty */ }
  return new Set();
}

function persistSlackDoneNotified(set: Set<string>): void {
  try { writeFileSync(slackDoneNotifiedPath(), JSON.stringify([...set])); }
  catch (e) { console.error('[slack] could not persist done-notify ledger:', e); }
}

/** Slack `chat.postMessage` errors that are permanent for this config — retrying
 *  can never make them succeed, so a failed post with one of these is recorded
 *  (not retried) to avoid flooding the log every 5s. Anything else is treated as
 *  transient and left to retry. */
const TERMINAL_SLACK_ERRORS = new Set<string>([
  'missing_scope', 'invalid_auth', 'not_authed', 'account_inactive',
  'token_revoked', 'token_expired', 'no_permission', 'channel_not_found',
  'not_in_channel', 'is_archived', 'restricted_action', 'org_login_required',
]);

/** The single in-thread summary for a finished task. Sourced from the task's
 *  result/description (falling back to the title), trimmed Slack-friendly. */
function slackDoneSummary(task: HiveTask): string {
  const body = (task.result ?? task.description ?? '').trim();
  const head = `:white_check_mark: *${task.title}*`;
  const text = body ? `${head}\n\n${body}` : head;
  return text.length > 2800 ? `${text.slice(0, 2799)}…` : text;
}

/** One observation pass over the kanban. Posts a summary for any Slack-origin
 *  task that has newly reached 'done'. Best-effort and self-guarding — it must
 *  never throw into the timer, and the bot token never leaves this function. */
async function pollSlackDoneTasks(): Promise<void> {
  if (slackDonePolling) return;
  const botToken = readConfig().slackBotToken;
  if (!botToken) return; // can't post without the token — nothing to do
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return; } // unreadable/missing tasks.json → skip this tick

  const notified = slackDoneNotified ?? (slackDoneNotified = loadSlackDoneNotified());

  // First tick seeds the baseline (ids already done) and posts nothing — so we
  // only ever fire on a transition observed live this session.
  if (slackDoneBaseline === null) {
    slackDoneBaseline = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    return;
  }
  const baseline = slackDoneBaseline;

  slackDonePolling = true;
  try {
    for (const t of tasks) {
      if (t.status !== 'done') continue;
      if (baseline.has(t.id) || notified.has(t.id)) continue; // already handled
      const slack = t.slack;
      if (!slack || !slack.channel || !slack.thread_ts) continue; // non-Slack-origin → leave alone
      // FALLBACK-ONLY: if the agent already posted a DIRECT reply into this thread
      // (loopback /reply), the human has its substantive answer — don't double-post.
      if (directlyRepliedThreads.has(slack.thread_ts)) { notified.add(t.id); persistSlackDoneNotified(notified); continue; }
      // Never post a bare `:white_check_mark: *title*` with no substance: if the card
      // carries neither a result nor a description, there is nothing meaningful to
      // deliver — skip it (still under the FALLBACK contract).
      if (!(t.result ?? t.description ?? '').trim()) { notified.add(t.id); persistSlackDoneNotified(notified); continue; }
      const res = await postSlackReply({
        botToken, channel: slack.channel, thread_ts: slack.thread_ts, text: slackDoneSummary(t)
      });
      if (res.ok) {
        notified.add(t.id);
        persistSlackDoneNotified(notified); // mark-on-success → exactly one delivered reply
      } else if (res.error && TERMINAL_SLACK_ERRORS.has(res.error)) {
        // A permanent config/auth error (e.g. the bot token lacks `chat:write`)
        // will NEVER succeed — record the id so we stop hammering every tick, and
        // log the reason once. Never log the token or message body.
        notified.add(t.id);
        persistSlackDoneNotified(notified);
        console.error('[slack] done-summary post for task', t.id,
          '— giving up (terminal error:', res.error + '). Fix the Slack bot scope/permissions; later tasks post once resolved.');
      } else {
        // Transient (network / rate-limit / unknown) → leave unmarked so a later
        // tick retries. Log the id + error only; never the token or message body.
        console.error('[slack] done-summary post failed for task', t.id, '-', res.error, '(will retry)');
      }
    }
  } finally {
    slackDonePolling = false;
  }
}

/** Begin watching the kanban for Slack-origin done-transitions (idempotent). */
function startSlackDoneObserver(): void {
  if (slackDoneTimer) return;
  slackDoneNotified = loadSlackDoneNotified();
  slackDoneBaseline = null; // re-seed on the first tick of this session
  slackDoneTimer = setInterval(() => { void pollSlackDoneTasks(); }, 5000);
}

/** Stop watching the kanban. Safe to call when not running. */
function stopSlackDoneObserver(): void {
  if (slackDoneTimer) { clearInterval(slackDoneTimer); slackDoneTimer = null; }
  slackDoneBaseline = null;
}

/** Build a SlackWebhookServer from the current config and start it, replacing
 *  any running instance, and return the start result (incl. the public tunnel
 *  URL the user pastes into Slack). No-op + error result when the integration is
 *  disabled or the signing secret is unset. */
async function startSlackServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) {
    return { ok: false, error: 'slack disabled or missing signing secret' };
  }
  slackServer?.stop();
  slackServer = new SlackWebhookServer({
    port: cfg.slackPort && cfg.slackPort > 0 ? cfg.slackPort : 3847,
    signingSecret: cfg.slackSigningSecret,
    channelId: cfg.slackChannelId,
    // Fires from the HTTP server's event loop (not the IPC thread); route through
    // liveWebContents() so a message arriving during window teardown can't throw.
    // Downloads any file attachments (bot token stays in main; local paths go to IPC).
    onMessage: async (m) => {
      const localFiles = await downloadSlackFiles(
        m._rawFiles ?? [],
        readConfig().slackBotToken
      );
      // `text` stays the user's RAW Slack text → drives the readable kanban card
      // title. `autonomyPreamble` is the authoritative policy block the renderer
      // prepends ONLY to god's working instruction (his PTY prompt), keeping the
      // card title human-facing-clean. Built PER MESSAGE so the AUTONOMOUS REQUEST
      // PROTOCOL carries THIS request's concrete channel, thread_ts, and the
      // resolved helper path — god hands the worker an exact reply command.
      // Server-side so it applies to every session.
      const ipcMsg: { text: string; channel: string; ts: string; thread_ts: string; autonomyPreamble: string; files?: typeof localFiles } = {
        text: m.text, channel: m.channel, ts: m.ts, thread_ts: m.thread_ts,
        autonomyPreamble: buildAutonomousRequestProtocol(m.channel, m.thread_ts, slackReplyScriptPath())
      };
      if (localFiles.length > 0) ipcMsg.files = localFiles;
      try { liveWebContents()?.send('slack:incomingMessage', ipcMsg); }
      catch { /* window torn down */ }
    }
  });
  const res = await slackServer.start();
  // ok:false means we never bound the port → drop the instance. ok:true with no
  // url just means the tunnel is unavailable; the local handler is still live.
  if (!res.ok) { slackServer = null; return res; }
  if (res.url) lastSlackUrl = res.url;
  // Bring up the loopback reply endpoint (token-gated, never tunneled) and drop
  // the discovery file for the bundled helper. Best-effort: reply path being
  // unavailable must not sink ingestion.
  await startSlackReplyServer();
  // Begin watching the kanban for Slack-origin tasks that reach 'done', to post
  // their one summary reply in-thread. OUTBOUND-only; never touches ingestion.
  startSlackDoneObserver();
  analytics.trackFeature('slack_trigger');
  return res;
}

/** Start the loopback reply endpoint and write its `{ port, token }` to userData
 *  so `md-slack-reply.cjs` can reach it. The bot token is read lazily from config
 *  at reply time and never written to this file. */
async function startSlackReplyServer(): Promise<void> {
  slackReplyServer?.stop();
  const token = randomBytes(24).toString('hex');
  slackReplyServer = new SlackReplyServer({
    token,
    getBotToken: () => readConfig().slackBotToken,
    // An agent posted a DIRECT substantive reply into this thread → record it so the
    // done-summary poller skips it (the poller is a fallback, not a duplicator).
    onReplied: (thread_ts) => { directlyRepliedThreads.add(thread_ts); }
  });
  const r = await slackReplyServer.start();
  if (!r.ok || r.port === undefined) {
    console.error('[slack] reply endpoint failed to start:', r.error);
    slackReplyServer = null;
    return;
  }
  try {
    writeFileSync(slackReplyConfigPath(), JSON.stringify({ port: r.port, token }), { mode: 0o600 });
  } catch (e) {
    console.error('[slack] could not write reply config:', e);
  }
}

/** Stop and forget the Slack server (+ reply endpoint). Best-effort; safe to call
 *  when not running. The last tunnel URL is retained so Settings keeps showing it. */
function stopSlackServer(): void {
  try { slackServer?.stop(); } catch (e) { console.error('[slack] stop failed:', e); }
  slackServer = null;
  try { slackReplyServer?.stop(); } catch (e) { console.error('[slack] reply stop failed:', e); }
  slackReplyServer = null;
  stopSlackDoneObserver();
  try { if (existsSync(slackReplyConfigPath())) unlinkSync(slackReplyConfigPath()); } catch { /* noop */ }
}

// ─── Generic inbound webhook + status API (multi-endpoint) ───────────────────
/** The running generic-webhook server, or null when disabled/stopped. A PUBLIC
 *  (tunnel-forwarded) surface — secret-gated, unlike the loopback /reply. ONE
 *  server and ONE tunnel serve EVERY configured endpoint; the id in the request
 *  path picks which. Adding a webhook therefore costs no port and no tunnel, and
 *  never disturbs a caller already pointed at another endpoint's URL. */
let webhookServer: WebhookServer | null = null;
/** Last public tunnel URL handed out — retained so Settings can re-show the
 *  endpoint after a reopen (the tunnel rotates it per restart). */
let lastWebhookUrl: string | undefined;

/** Local port the shared server binds to. The port is a property of the SERVER,
 *  not of any one trigger — `webhookPort` stays the (legacy) override. */
const WEBHOOK_DEFAULT_PORT = 3849;

/** The endpoints the operator has switched on. A disabled webhook is not merely
 *  rejected at the door — it is never handed to the server, so its id does not
 *  exist on the wire and its secret is not in memory on the request path. */
function enabledWebhookEndpoints(): WebhookTrigger[] {
  return (readConfig().webhookTriggers ?? []).filter((t) => t.enabled && !!t.secret);
}

/** SHA-256 hex of a capability token. The raw token is returned to the caller
 *  exactly once (the POST response) and never persisted; only this digest lands
 *  on the kanban card, so a GET can match without the raw token ever resting. */
function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** tokenHash → id of the `pending` history entry it belongs to.
 *
 *  A message the mode gate held has NO kanban card (the card is what approval
 *  creates), so this map is the only way its caller's GET can be answered — and
 *  answered HONESTLY, as "awaiting-approval" rather than a lie about queued work.
 *  It stores the token's DIGEST, never the token, exactly like the card stamp,
 *  and it is mirrored into the durable kv store so a restart doesn't 404 every
 *  caller that is still politely waiting on the operator. */
let heldWebhookTokens: Map<string, string> | null = null;
const HELD_TOKENS_KV_KEY = 'triggers.webhook.heldTokens';

function heldTokens(): Map<string, string> {
  if (heldWebhookTokens) return heldWebhookTokens;
  let stored: Record<string, string> | undefined;
  try { stored = persist.getKv<Record<string, string>>(HELD_TOKENS_KV_KEY); }
  catch { stored = undefined; }
  const entries = stored && typeof stored === 'object' ? Object.entries(stored) : [];
  heldWebhookTokens = new Map(entries.filter((e): e is [string, string] => typeof e[1] === 'string'));
  return heldWebhookTokens;
}

function persistHeldTokens(): void {
  try { persist.setKv(HELD_TOKENS_KV_KEY, Object.fromEntries(heldTokens())); }
  catch (e) { console.error('[webhook] could not persist held-token map:', e); }
}

/** Drop mappings whose history entry has aged out of the (capped) ledger — the
 *  operator can no longer decide them, so their tokens are dead weight. */
function pruneHeldTokens(): void {
  const map = heldTokens();
  if (map.size === 0) return;
  const live = new Set(listTriggerHistory().map((e) => e.id));
  let changed = false;
  for (const [hash, entryId] of [...map]) {
    if (!live.has(entryId)) { map.delete(hash); changed = true; }
  }
  if (changed) persistHeldTokens();
}

/** The token digest a held history entry was accepted under, if we still have it. */
function heldTokenHashFor(entryId: string): string | undefined {
  for (const [hash, id] of heldTokens()) if (id === entryId) return hash;
  return undefined;
}

/** Tell the Triggers tab its ledger moved, so history live-refreshes instead of
 *  waiting for the operator to re-open the tab. */
function notifyTriggerHistoryUpdated(): void {
  try { liveWebContents()?.send('triggerHistory:updated'); } catch { /* window gone */ }
}

/**
 * Create the stamped kanban card for an inbound message and route it to god.
 *
 * Split out of `handleWebhookMessage` because the APPROVAL path takes exactly
 * this route later — an operator saying yes must produce the same card and the
 * same god request an auto-allowed message would have, or the two paths drift
 * and "approved" quietly means something weaker than "allowed".
 *
 * Returns false only when the card — the thing the caller polls — could not be
 * written. The god routing is best-effort: the card already exists and is
 * pollable even if the send hiccups.
 */
function dispatchWebhookWork(arg: {
  taskId: string;
  title: string;
  message: string;
  /** Stamped onto the card so a GET can match the caller's token. */
  tokenHash?: string;
  /** 'webhook' | 'org' — only for the subject line and the god-facing note. */
  origin: 'webhook' | 'org';
}): boolean {
  try {
    const card: HiveTask = {
      id: arg.taskId,
      title: arg.title,
      description: arg.message,
      status: 'todo',
      dependsOn: [],
      priority: DEFAULT_PRIORITY,
      createdAt: new Date().toISOString(),
      ...(arg.tokenHash ? { webhook: { tokenHash: arg.tokenHash } } : {})
    };
    // addTask appends against the latest on-disk ledger and is idempotent by task
    // id, so a concurrent card writer (Slack, god, voice, another webhook) can't
    // have its card lost to our stale whole-ledger overwrite. (writeTasks(...existing)
    // recreated exactly that race.) A fresh taskId never collides, so this always adds.
    hive.addTask(card);
  } catch (e) {
    console.error('[webhook] could not create task card:', e instanceof Error ? e.message : e);
    return false;
  }
  // Body carries ONLY the sender's message + the card id (so whoever finishes it
  // updates that card's status/result for the caller's GET) — never the secret,
  // never the raw token.
  try {
    hive.send({
      to: getMessageRoute('webhook', readConfig(), isKnownAgent),
      act: 'request',
      subject: `[${arg.origin}] ${arg.title}`,
      body: `${arg.message}\n\n(Inbound via the generic ${arg.origin} API, tracked as kanban card ${arg.taskId}. When this work is finished, set that card's status to 'done' and fill its 'result' so the caller's status check reflects the outcome.)`,
      requires_reply: false
    }, 'webhook');
  } catch (e) {
    console.error('[webhook] could not route to god:', e instanceof Error ? e.message : e);
  }
  return true;
}

/**
 * A verified POST, run through the endpoint's TriggerMode.
 *
 * `isAutoAllowed(mode, kind)` is the whole gate. When it says yes this behaves
 * exactly as the single-endpoint server always did — card, god request, capability
 * token. When it says no NOTHING reaches the hive: the message is written to the
 * ledger as `pending` and sits there until the operator decides, and the caller
 * is handed its token plus a 202 so it can watch the hold rather than believe
 * work started.
 *
 * Either way an `inbound` history row is recorded. The secret never reaches here
 * (the server hands over `{id,name}` only) and no credential is ever written to
 * the ledger.
 */
function handleWebhookMessage(msg: WebhookInbound, endpoint: WebhookEndpointRef): WebhookDispatch | null {
  // 192-bit unguessable token, returned once; only its hash is stored.
  const token = randomBytes(24).toString('hex');
  const tokenHash = hashWebhookToken(token);
  const full = msg.title ?? msg.message;
  const title = full.length > 80 ? `${full.slice(0, 79)}…` : full;

  const trigger = (readConfig().webhookTriggers ?? []).find((t) => t.id === endpoint.id);
  // An endpoint that vanished between the request and this lookup falls back to
  // the STRICTEST mode, never the most permissive one.
  const mode: TriggerMode = trigger?.mode ?? DEFAULT_TRIGGER_MODE;
  // The caller's own declaration wins; `classifyInboundKind` is the conservative
  // guess for callers that don't declare (it leans 'directive' on purpose).
  const kind: InboundKind = msg.kind ?? classifyInboundKind(msg.message);
  const peer = msg.from?.trim() || endpoint.name || endpoint.id;
  // Minted here, not derived from the task id, because a HELD message has no task
  // id yet and must still be pairable with the reply it eventually earns.
  const correlationId = randomBytes(8).toString('hex');

  const base = {
    source: 'webhook' as const,
    sourceId: endpoint.id,
    sourceName: endpoint.name,
    direction: 'inbound' as const,
    peer,
    title,
    body: msg.message,
    kind,
    correlationId
  };

  if (!isAutoAllowed(mode, kind)) {
    const entry = appendTriggerHistory({ ...base, decision: 'pending' });
    heldTokens().set(tokenHash, entry.id);
    persistHeldTokens();
    notifyTriggerHistoryUpdated();
    return { token, pending: true };
  }

  const taskId = `webhook-${randomBytes(8).toString('hex')}`;
  if (!dispatchWebhookWork({ taskId, title, message: msg.message, tokenHash, origin: 'webhook' })) return null;
  appendTriggerHistory({ ...base, decision: 'auto-allowed', taskId });
  notifyTriggerHistoryUpdated();
  return { token, taskId, pending: false };
}

/** Resolve a capability token to its task's public status — scoped to the ONE
 *  card (or the ONE held message) whose stored hash matches; never lists or leaks
 *  any other task. Returns null for any non-match (the server answers 404 either
 *  way, so a probe can't tell "unknown" from "malformed"). */
function lookupWebhookStatus(token: string): WebhookTaskStatus | null {
  const hash = hashWebhookToken(token);

  // Held messages first — they have no card, and the O(1) hit keeps the common
  // "still waiting" poll off the task scan entirely.
  const heldEntryId = heldTokens().get(hash);
  if (heldEntryId) {
    const entry = listTriggerHistory().find((e) => e.id === heldEntryId);
    if (!entry) { heldTokens().delete(hash); persistHeldTokens(); return null; }
    if (entry.decision === 'pending') {
      return { status: 'awaiting-approval', title: entry.title ?? '' };
    }
    if (entry.decision === 'rejected') {
      return { status: 'rejected', title: entry.title ?? '' };
    }
    // Approved: the release stamped this hash onto a real card, so fall through.
  }

  const wanted = Buffer.from(hash);
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return null; }
  for (const t of tasks) {
    const h = t.webhook?.tokenHash;
    if (!h) continue;
    const have = Buffer.from(h);
    // Both are fixed-length sha-256 hex; compare in constant time defensively.
    if (have.length === wanted.length && timingSafeEqual(have, wanted)) {
      return { status: t.status, title: t.title, result: t.result };
    }
  }
  return null;
}

// ─── Webhook done-observer (the OUTBOUND half of the trigger ledger) ─────────
// Mirrors `pollSlackDoneTasks`: watch the kanban for webhook-origin cards that
// reach 'done' and write the reply side of the conversation, tagged with the
// inbound row's correlationId so the UI can pair request ↔ response.
//
// Unlike the Slack poller there is no "baseline" of already-done ids: the LEDGER
// is the record of what we've already paired, so a card that finished while the
// app was closed still gets its outbound row on the next boot, and re-seeding
// from the ledger makes a duplicate impossible.
let webhookDoneTimer: ReturnType<typeof setInterval> | null = null;
let webhookOutboundRecorded: Set<string> | null = null;

function seedWebhookOutbound(): Set<string> {
  const seen = new Set<string>();
  try {
    for (const e of listTriggerHistory()) {
      if (e.direction === 'outbound' && e.taskId) seen.add(e.taskId);
    }
  } catch { /* unreadable ledger → treat as empty; appends are still deduped by taskId */ }
  return seen;
}

function pollWebhookDoneTasks(): void {
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return; } // unreadable/missing tasks.json → skip this tick
  const done = tasks.filter((t) =>
    t.status === 'done' && (t.webhook != null || t.id.startsWith('webhook-')));
  if (done.length === 0) return;
  const recorded = webhookOutboundRecorded ?? (webhookOutboundRecorded = seedWebhookOutbound());
  const fresh = done.filter((t) => !recorded.has(t.id));
  if (fresh.length === 0) return;

  const history = listTriggerHistory();
  let wrote = false;
  for (const t of fresh) {
    const inbound = history.find((e) => e.direction === 'inbound' && e.taskId === t.id);
    // No inbound row = a card from before the ledger existed. Nothing to pair it
    // with, so mark it handled rather than writing a half of a conversation.
    if (!inbound) { recorded.add(t.id); continue; }
    appendTriggerHistory({
      source: inbound.source,
      sourceId: inbound.sourceId,
      sourceName: inbound.sourceName,
      direction: 'outbound',
      peer: inbound.peer,
      title: t.title,
      body: (t.result ?? '').trim() || '(finished with no result recorded)',
      kind: inbound.kind,
      correlationId: inbound.correlationId,
      taskId: t.id
    });
    recorded.add(t.id);
    wrote = true;
  }
  if (wrote) notifyTriggerHistoryUpdated();
}

/** Begin watching the kanban for webhook-origin done-transitions (idempotent). */
function startWebhookDoneObserver(): void {
  if (webhookDoneTimer) return;
  webhookOutboundRecorded = seedWebhookOutbound();
  webhookDoneTimer = setInterval(() => {
    try { pollWebhookDoneTasks(); } catch (e) { console.error('[webhook] done-observer:', e); }
  }, 5000);
}

/** Stop watching the kanban. Safe to call when not running. */
function stopWebhookDoneObserver(): void {
  if (webhookDoneTimer) { clearInterval(webhookDoneTimer); webhookDoneTimer = null; }
  webhookOutboundRecorded = null;
}

/** Build the shared WebhookServer from the enabled endpoints and start it. A
 *  server that is already up is RE-POINTED rather than restarted (see
 *  `reconcileWebhookServer`): restarting would mint a fresh tunnel URL and break
 *  every other endpoint's caller. The public tunnel is opened only here — never
 *  on a default; a webhook reaches the wire only once the operator enables it. */
async function startWebhookServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const endpoints = enabledWebhookEndpoints();
  if (endpoints.length === 0) return { ok: false, error: 'no enabled webhook endpoints' };
  if (webhookServer) {
    webhookServer.setEndpoints(endpoints);
    return { ok: true, url: webhookServer.publicUrl() ?? lastWebhookUrl };
  }
  pruneHeldTokens();
  const cfg = readConfig();
  const server = new WebhookServer({
    port: cfg.webhookPort && cfg.webhookPort > 0 ? cfg.webhookPort : WEBHOOK_DEFAULT_PORT,
    endpoints,
    onMessage: handleWebhookMessage,
    lookupStatus: lookupWebhookStatus
  });
  webhookServer = server;
  const res = await server.start();
  // ok:false covers BOTH "never bound the port" (fatal → drop the instance) and
  // "bound fine, tunnel unavailable" (the security boundary is live and must stay
  // reachable/stoppable — dropping it there would leak an unstoppable listener).
  if (!res.ok && !server.listening()) { webhookServer = null; return res; }
  analytics.trackFeature('webhook_trigger');
  if (res.url) lastWebhookUrl = res.url;
  startWebhookDoneObserver();
  return res;
}

/** Bring the running server in line with config after any webhook mutation.
 *  Live endpoint swap when it's up, start when the enabled set becomes non-empty,
 *  stop when it empties. Never restarts a healthy server. */
function reconcileWebhookServer(): void {
  const endpoints = enabledWebhookEndpoints();
  if (endpoints.length === 0) { stopWebhookServer(); return; }
  if (webhookServer) { webhookServer.setEndpoints(endpoints); return; }
  void startWebhookServer().then((r) => {
    if (!r.ok) console.error('[webhook] start failed:', r.error);
    else console.log('[webhook] listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
  });
}

/** Per-endpoint public URLs for the settings surface's copy button. Empty string
 *  when no tunnel has ever come up — the UI shows the endpoint, just not a URL
 *  it could hand out yet. */
function webhookEndpointUrls(): { id: string; url: string }[] {
  const base = (webhookServer?.publicUrl() ?? lastWebhookUrl ?? '').replace(/\/+$/, '');
  return (readConfig().webhookTriggers ?? []).map((t) => ({
    id: t.id,
    url: base ? `${base}/${encodeURIComponent(t.id)}` : ''
  }));
}

/** Stop and forget the webhook server. Best-effort; safe when not running. The
 *  last tunnel URL is retained so Settings keeps showing it. */
function stopWebhookServer(): void {
  try { webhookServer?.stop(); } catch (e) { console.error('[webhook] stop failed:', e); }
  webhookServer = null;
  // The done-observer deliberately OUTLIVES the server (it is a ledger concern,
  // not a transport one) — it is torn down with the process/hive, not here.
}

/** The persisted main-window geometry (kv key `window.bounds`). */
interface WindowBounds { x?: number; y?: number; width: number; height: number }

const DEFAULT_WIN = { width: 1440, height: 900 };
const MIN_WIN = { width: 1280, height: 800 };

/** Validate + clamp restored bounds: enforce the minimum size, and drop a
 *  position that no longer lands on any connected display (monitor unplugged) so
 *  the window can't open off-screen. Returns null for unusable input. */
function clampBounds(b: unknown): WindowBounds | null {
  if (!b || typeof b !== 'object') return null;
  const r = b as Partial<WindowBounds>;
  if (typeof r.width !== 'number' || typeof r.height !== 'number') return null;
  const width = Math.max(MIN_WIN.width, Math.round(r.width));
  const height = Math.max(MIN_WIN.height, Math.round(r.height));
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return { width, height };
  const x = Math.round(r.x), y = Math.round(r.y);
  // Keep the position only if the window rect overlaps some display's work area.
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return x < wa.x + wa.width && x + width > wa.x && y < wa.y + wa.height && y + height > wa.y;
  });
  return onScreen ? { x, y, width, height } : { width, height };
}

/** Minimal trailing-edge debounce for the move/resize flood. */
function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | null = null;
  return () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
}

/** Cascade a new floor off the focused window so it doesn't stack exactly on
 *  top, clamped on-screen (clampBounds drops an off-display position). */
function floorCascade(): WindowBounds | null {
  const base = (mainWindow && !mainWindow.isDestroyed())
    ? mainWindow
    : [...allWindows].find((w) => !w.isDestroyed());
  if (!base) return null;
  const b = base.getBounds();
  const OFFSET = 36;
  return clampBounds({ x: b.x + OFFSET, y: b.y + OFFSET, width: b.width, height: b.height });
}

// ─── Shareable hires: munderdifflin:// deep link + file import ──────────────
// A hire manifest NEVER auto-spawns: it is validated, then handed to the
// renderer, which pre-fills the Add-Agent modal for human review. See
// src/shared/hire.ts for the spec + security model.

/** Manifests that arrived before the renderer was ready to receive them.
 *  The renderer PULLS these via hire:drainPending once its subscription is
 *  mounted — main never pushes blind, so a fast-loading packaged renderer
 *  can't lose a deep link to a startup race. */
const pendingHires: HireManifest[] = [];
let rendererReadyForHires = false;

function deliverHire(manifest: HireManifest): void {
  if (rendererReadyForHires && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('hire:import', manifest);
  } else {
    pendingHires.push(manifest);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }
}

async function handleHireLink(link: string): Promise<void> {
  const src = parseHireDeepLink(link);
  if (!src) { console.warn('[hire] ignoring malformed deep link'); return; }
  const res = await fetchHireManifest(src);
  if (!res.ok) {
    console.error('[hire] deep link rejected:', res.error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hire:error', { error: res.error });
    }
    return;
  }
  deliverHire(res.manifest);
  analytics.trackFeature('hire_install');
}

// Register the protocol. In dev (electron .) Windows needs the explicit
// exe+args form or the registration points at electron.exe with no entry.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('munderdifflin', process.execPath, [resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('munderdifflin');
}

// Deep links on Windows/Linux arrive as the argv of a SECOND process — take the
// single-instance lock and forward them to the running instance. (macOS gets
// the 'open-url' event instead.) The lock also rules out two harnesses fighting
// over the same hive, which was previously possible but never useful.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  allowQuit = true;
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const link = argv.find((a) => a.startsWith('munderdifflin://'));
    if (link) void handleHireLink(link);
  });
}

app.on('open-url', (evt, url) => {
  evt.preventDefault();
  void handleHireLink(url);
});

app.on('child-process-gone', (_event, details) => {
  try {
    hive.appendLog({
      kind: 'child-process-gone',
      type: details?.type ?? 'unknown',
      reason: details?.reason ?? 'unknown',
      exitCode: typeof details?.exitCode === 'number' ? details.exitCode : null,
      ...(details?.serviceName ? { serviceName: details.serviceName } : {})
    });
  } catch { /* best-effort */ }
});

// IPC: the renderer signals readiness and PULLS anything queued (deep links
// that arrived before the window/subscription existed, incl. cold starts).
ipcMain.handle('hire:drainPending', () => {
  rendererReadyForHires = true;
  const out = pendingHires.splice(0, pendingHires.length);
  return out;
});

// IPC: "import hires…" file picker in the Add-Agent modal. Every selected file
// is validated independently; valid neighbours survive an invalid manifest.
ipcMain.handle('hire:openFile', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Import hire manifests',
    filters: [{ name: 'Hire manifest', extensions: ['json'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled || res.filePaths.length === 0) {
    return { ok: false, manifests: [], errors: [], error: 'cancelled' };
  }
  const batch = readHireManifestFiles(res.filePaths);
  return {
    ok: batch.manifests.length > 0,
    ...batch,
    error: batch.manifests.length === 0 ? 'no valid hire manifests selected' : undefined
  };
});

/**
 * Create a window. The PRIMARY window (no opts) restores saved geometry, uses
 * the default session, runs the hive, and keeps the existing app-quit warning.
 * A FLOOR window (`{ floor: true }`) gets its own persistent session partition
 * — isolating its renderer state (agents/queues/selection) from every other
 * window — cascades its position, and on close stops only its OWN terminals
 * while the app keeps running.
 */
function createWindow(opts: { floor?: boolean } = {}): BrowserWindow {
  const isFloor = opts.floor === true;

  // Primary restores saved geometry; floors cascade off the focused window.
  let saved: WindowBounds | null = null;
  if (!isFloor) { try { saved = clampBounds(persist.getKv('window.bounds')); } catch { saved = null; } }
  const cascade = isFloor ? floorCascade() : null;
  const geom = cascade ?? saved;

  const win = new BrowserWindow({
    width: geom?.width ?? DEFAULT_WIN.width,
    height: geom?.height ?? DEFAULT_WIN.height,
    ...(geom && geom.x !== undefined && geom.y !== undefined ? { x: geom.x, y: geom.y } : {}),
    minWidth: MIN_WIN.width,
    minHeight: MIN_WIN.height,
    title: isFloor ? `${brandTitle()} \u2014 Floor` : brandTitle(),
    backgroundColor: '#FFF8E7',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Keep Chromium's OS renderer sandbox active; privileged work stays behind
      // the narrow contextBridge/IPC surface owned by the main process.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer runs the hive's heartbeat loops (inbox nudge, message
      // flush, telemetry polls). Chromium throttles timers in occluded windows
      // — incl. behind the LOCK SCREEN — which silently stalls the hive while
      // the user is away. Don't.
      backgroundThrottling: false,
      // Each floor gets its OWN persistent session partition → isolated
      // localStorage so floors never share or stomp each other's office state.
      // The primary keeps the DEFAULT session so existing persisted state loads.
      ...(isFloor ? { partition: `persist:floor-${++floorSeq}` } : {})
    }
  });

  // Capture the webContents once: after 'closed' the window is gone, but this
  // reference stays valid as the per-PTY ownership key.
  const wc = win.webContents;

  allWindows.add(win);
  // Global timer events follow the user — the most-recently-focused window is
  // primary. The primary is also seeded synchronously so boot events route now.
  win.on('focus', () => { mainWindow = win; });
  if (!isFloor) mainWindow = win;

  // Permission gate for the renderer (our own trusted, local content). The only
  // permission we constrain is microphone capture: it's allowed ONLY while a mic
  // feature is actually live — Free Flow dictation (`freeflowEnabled`) OR a
  // Realtime Michael voice session (`realtimeVoiceEnabled`, flipped on by the
  // session at start() before getUserMedia, off at stop()). With both flags off,
  // there's zero mic access even at the Electron layer. We deliberately do NOT
  // gate on OpenAI-key presence: that key (`apikey:openai`) is shared with the CLI
  // engines, so a CLI-only user must not have the mic gate opened. Every other
  // permission keeps the app's prior permissive behavior (e.g. clipboard for
  // xterm/editor copy must keep working).
  const micFeatureLive = (): boolean => {
    const cfg = readConfig();
    return cfg.freeflowEnabled === true || cfg.realtimeVoiceEnabled === true;
  };
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      const mediaTypes = details && 'mediaTypes' in details ? details.mediaTypes : undefined;
      const wantsAudio = !mediaTypes || mediaTypes.includes('audio');
      callback(micFeatureLive() && wantsAudio);
      return;
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'media') return micFeatureLive();
    return true;
  });

  // Only the primary persists geometry (kv `window.bounds`); floors cascade
  // fresh each launch. Skip while maximized/minimized so a restore doesn't save
  // the fullscreen rect.
  if (!isFloor) {
    const saveBounds = debounce(() => {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
      try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
    }, 400);
    win.on('resized', saveBounds);
    win.on('moved', saveBounds);
    win.on('close', () => {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
      try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
    });
  }


  win.once('ready-to-show', () => win.show());

  // Never opens a window; hands the URL to the OS browser instead.
  //
  // Scheme-checked, because this is now reachable from AUTHOR-CONTROLLED markup:
  // a release drop's iframe has `allow-popups`, so a target="_blank" link in a
  // release body arrives here. http(s) only — an unguarded openExternal will
  // happily launch file://, or a registered custom scheme, on the user's machine.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Close interception when live PTYs exist. The red-X destroys the window;
  // intercept it the same way before-quit does so PTY users aren't surprised.
  win.on('close', (e) => {
    if (allowQuit) return;
    if (isFloor) {
      // A floor's close is NOT an app quit — confirm only its OWN terminals,
      // via a self-contained native dialog (no renderer modal). Confirming lets
      // the window close; its PTYs are stopped in the 'closed' handler.
      const owned = ptyManager.countByOwner(wc);
      if (owned > 0) {
        const choice = dialog.showMessageBoxSync(win, {
          type: 'warning',
          buttons: ['Close floor', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: `Close this floor? ${owned} running terminal${owned === 1 ? '' : 's'} on it will be stopped.`,
          detail: 'Other floors keep running.'
        });
        if (choice === 1) e.preventDefault();
      }
      return;
    }
    // Primary window: existing app-wide quit warning (renderer modal).
    const count = ptyManager.list().length;
    if (count === 0) return;
    e.preventDefault();
    win.focus();
    wc.send('app:closeRequested', { ptyCount: count });
  });

  // The primary is the default PTY sink; floors route purely by per-PTY owner.
  if (!isFloor) ptyManager.attachWebContents(wc);

  // A main-frame reload unmounts the renderer's hire subscription — queue again
  // until the fresh renderer drains. Guard on isMainFrame: a stray sub-frame
  // navigation must NOT flip readiness off (the renderer only drains on mount,
  // so a later deep link would otherwise queue and sit until a full reload).
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) rendererReadyForHires = false;
  });

  // A packaged build has no visible console: keep the prefixed lines (theme
  // fallbacks, floor errors, uncaught renderer errors) in <userData>/renderer.log.
  win.webContents.on('console-message', (_e, _level, message) => {
    if (!keepRendererConsoleLine(message)) return;
    try {
      appendFileSync(join(app.getPath('userData'), 'renderer.log'), `${new Date().toISOString()} ${message}\n`);
    } catch { /* logging must never break the window */ }
  });

  loadRendererView(win, { rendererUrl: isDev ? process.env.ELECTRON_RENDERER_URL : undefined });

  attachRendererRecovery(win, {
    reload: () => loadRendererView(win, { rendererUrl: isDev ? process.env.ELECTRON_RENDERER_URL : undefined }),
    log: (event) => { try { hive.appendLog(event); } catch { /* best-effort */ } },
    isQuitting: () => allowQuit,
    windowRole: isFloor ? 'floor' : 'primary'
  });

  // Ctrl/Cmd+R re-resolves the renderer (campRendererDir may have changed) and
  // reloads; PTYs live in main and are only killed on window close.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && !input.alt && !input.shift && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      loadRendererView(win, { rendererUrl: isDev ? process.env.ELECTRON_RENDERER_URL : undefined });
    }
  });

  win.on('closed', () => {
    allWindows.delete(win);
    // A closed floor must not leave its terminals running headless. (Natural
    // onExit teardown — archive + worktree cleanup — still runs per PTY.)
    if (isFloor) { try { ptyManager.killByOwner(wc); } catch { /* best-effort */ } }
    if (mainWindow === win) {
      mainWindow = null;
      for (const w of allWindows) { if (!w.isDestroyed()) { mainWindow = w; break; } }
    }
    syncKeepAwake();
  });

  return win;
}

/** Open a new floor window — gated by the multiWindow flag. Returns the window,
 *  or null when the feature is off (the entry points are hidden in that case,
 *  but the IPC stays defensive). */
function openFloor(): BrowserWindow | null {
  if (!readConfig().multiWindow) return null;
  return createWindow({ floor: true });
}

/** Build + install the application menu. Only called when multiWindow is on, so
 *  flag-off keeps Electron's default menu (zero behavior change). Uses standard
 *  role-based items so copy/paste/quit/etc. work per-platform, and adds the
 *  "New Floor" item (Cmd/Ctrl+Shift+N). */
function installAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const newFloorItem = {
    label: 'New Floor',
    accelerator: 'CmdOrCtrl+Shift+N',
    click: () => { openFloor(); }
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: isMac
        ? [newFloorItem, { type: 'separator' as const }, { role: 'close' as const }]
        : [newFloorItem, { type: 'separator' as const }, { role: 'quit' as const }]
    },
    // The Edit menu is spelled out rather than `{ role: 'editMenu' }` for one
    // reason: `registerAccelerator: false` on the clipboard items.
    //
    // A registered accelerator is claimed by the MENU, which then replays the
    // action through `webContents.paste()` — an async hop that runs a beat after
    // the keystroke. Dictation tools (Muesli, Wispr Flow, …) insert text by
    // stashing the clipboard, writing the transcript, sending the paste key, and
    // restoring the old clipboard immediately; the menu's late paste therefore
    // read the RESTORED clipboard and typed the user's previous copy instead of
    // what they had just said. It hit the terminal and the composer alike,
    // because both were downstream of the same replay.
    //
    // With registerAccelerator false the item still shows its shortcut, but the
    // key is left for the focused element to handle inline — xterm's own paste
    // handler and the textarea's native paste event both read the clipboard
    // synchronously, inside the keystroke, before any restore can land.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const, registerAccelerator: false },
        { role: 'redo' as const, registerAccelerator: false },
        { type: 'separator' as const },
        { role: 'cut' as const, registerAccelerator: false },
        { role: 'copy' as const, registerAccelerator: false },
        { role: 'paste' as const, registerAccelerator: false },
        { role: 'selectAll' as const, registerAccelerator: false }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


// ─── IPC: pty lifecycle ─────────────────────────────────────────────────────
/** Codex stores its rollout transcripts under a PER-AGENT CODEX_HOME
 *  (<hive>/agents/<id>/.codex/sessions/<Y>/<M>/<D>/rollout-*-<sessionId>.jsonl).
 *  A NEWLY added agent gets an empty CODEX_HOME, so `codex resume <sid>` finds
 *  nothing and silently opens a BLANK session — which is exactly what the Add
 *  Agent "resume session" field looked like it was doing. Find the agent whose
 *  CODEX_HOME owns this rollout and RETURN that home so the resumed agent can be
 *  pointed at it (the rollout AND its state_5.sqlite index live there together). */
function findCodexHomeForSession(sessionId: string, siblingsRoot: string): string | null {
  try {
    if (!sessionId || !/^[0-9a-fA-F][0-9a-fA-F-]{15,}$/.test(sessionId)) return null;
    let fallbackHome: string | null = null;
    // Walk each sibling agent's CODEX_HOME (<agent>/.codex) looking for the
    // rollout that owns this session. We RETURN that home rather than copy the
    // rollout out of it: Codex indexes sessions in its state_5.sqlite, so a lone
    // rollout file in a fresh home is invisible to `codex resume`. Pointing the
    // resumed agent at the OWNING home gives it the rollout AND the index.
    let agents: Array<{ name: string; isDirectory(): boolean }>;
    try {
      agents = readdirSync(siblingsRoot, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>;
    } catch { return null; }
    for (const a of agents) {
      if (!a.isDirectory()) continue;
      const home = join(siblingsRoot, a.name, '.codex');
      const sessions = join(home, 'sessions');
      if (!existsSync(sessions)) continue;
      const stack = [sessions];
      let hasRollout = false;
      while (stack.length && !hasRollout) {
        const d = stack.pop() as string;
        let ents: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
          ents = readdirSync(d, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        } catch { continue; }
        for (const e of ents) {
          const pth = join(d, e.name);
          if (e.isDirectory()) stack.push(pth);
          else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(sessionId)) { hasRollout = true; break; }
        }
      }
      if (!hasRollout) continue;
      // Prefer the home whose Codex state DB actually INDEXES this session — a
      // fresh/seeded home may carry only a stray rollout copy (no index), which
      // `codex resume` can't open. Match the id as raw bytes in state_5.sqlite
      // (+ its WAL). Homes with the rollout but no index are a last-resort fallback.
      const idBuf = Buffer.from(sessionId);
      let indexed = false;
      for (const db of ['state_5.sqlite', 'state_5.sqlite-wal']) {
        try { if (readFileSync(join(home, db)).includes(idBuf)) { indexed = true; break; } } catch { /* no db */ }
      }
      if (indexed) return home;
      if (!fallbackHome) fallbackHome = home;
    }
    return fallbackHome;
  } catch (e) {
    console.error('[resume] findCodexHomeForSession failed:', e);
    return null;
  }
}

/** Spawn options shared by the `pty:spawn` IPC handler and the god-triggered
 *  ephemeral-worker watcher. */
type AgentSpawnOptions = SpawnOptions & { hive?: AgentMeta; isolate?: boolean; difficulty?: Difficulty; resume?: boolean; requireResume?: boolean; resumeSessionId?: string; provider?: AgentProvider; noAutoInstall?: boolean };

/** Map a `ptyManager.spawn` failure string to the closed `agent_spawn_failed.reason`
 *  enum (analytics.ts). The two known strings come from PtyManager.spawn; anything
 *  else is a generic `spawn_error`. The raw message never leaves the machine — only
 *  the enum value does, per TELEMETRY.md. */
function spawnFailReason(error?: string): SpawnFailReason {
  if (error?.startsWith('cwd does not exist')) return 'cwd_missing';
  if (error?.includes('already exists')) return 'already_running';
  return 'spawn_error';
}

ipcMain.handle('pty:spawn', async (evt, opts: AgentSpawnOptions) => {
  if (!opts || typeof opts.id !== 'string' || typeof opts.cwd !== 'string' || typeof opts.command !== 'string') {
    return { ok: false, error: 'invalid SpawnOptions' };
  }
  // Record the spawning window as the PTY's owner so its output routes ONLY back
  // to that floor, then run the shared spawn core.
  const owner = BrowserWindow.fromWebContents(evt.sender)?.webContents ?? null;
  return spawnAgentCore(opts, owner);
});

/** Core agent-spawn logic — provider inference, the missing-CLI installer
 *  short-circuit, git-worktree isolation, hive provisioning, model/resume flags,
 *  and the final PTY spawn. Extracted VERBATIM from the `pty:spawn` IPC handler so
 *  it can ALSO be invoked by the god-triggered ephemeral-worker watcher (which has
 *  no renderer `evt`). `owner` is the window that should receive this PTY's output
 *  (null → the primary window). Behavior-identical to the prior inline handler. */
/** The bubblewrap jail for a sandboxed agent (main/agentJail.ts). */
function agentJail(id: string, provider: string, cwd: string): ReturnType<typeof jailPlan> {
  const root = hive.root();
  if (!root) return { ok: false, error: 'the hive is off' };
  if (!jailAvailable()) return { ok: false, error: 'bubblewrap (/usr/bin/bwrap) is not available' };
  const scratchRoot = hiveScratchRoot();
  try { mkdirSync(join(scratchRoot, id), { recursive: true }); } catch { /* jailPlan reports it */ }
  const extraWritable = [
    ...(hive.workspaceOf(id)?.extraDirs ?? []).map(expandTilde),
    ...[memory.env().MEMPALACE_PALACE_PATH].filter((p): p is string => !!p)
  ];
  // Outside the agent's own (writable) scratch folder, so the jail cannot swap the socket.
  const netDir = join(scratchRoot, '.jail-net', id);
  try { mkdirSync(netDir, { recursive: true }); installJailNet(netDir); } catch (e) { return { ok: false, error: `could not prepare the jail network: ${String(e)}` }; }
  const net = {
    dir: netDir,
    node: join(root, 'bin', 'hive-node'),
    proxyPort: JAIL_PROXY_PORT,
    loopbackPorts: jailLoopbackPorts(readConfig().jailLoopbackPorts, provider, hive.otelEndpoint())
  };
  return jailPlan({
    provider, agentId: id, home: homedir(), agentDir: join(root, 'agents', id), hiveRoot: root, scratchRoot, cwd, extraWritable,
    runtimeDirs: [dirname(process.execPath)], net
  });
}

/** Jail refusals by agent id, shown on the fleet row (fleet.json `jailRefused`). */
const jailRefusals = new JailRefusals();

/** A provider the jail cannot run will fail every retry: block the agent's next card and
 *  tell the Boss once, and wakeModeFor holds automatic wakes until something changes. */
function refuseUnjailableProvider(agentId: string, name: string | undefined, provider: string): { ok: false; error: string } {
  const error = `the agent sandbox does not support provider "${provider}" yet`;
  console.error(`[agentJail] refusing to spawn ${agentId}: ${error}`);
  hive.appendLog({ kind: 'agent-jail-refused', agentId, error, permanent: true });
  const card = forCardOf(agentId)?.id;
  const at = Date.now();
  if (jailRefusals.refused(agentId, error, at, { permanent: true, card }).notify) {
    if (card) {
      try {
        hive.patchTask(card, { status: 'blocked' });
        hive.appendCardNote(card, `harness: ${error}, and no engine on this card's ladder can run in the sandbox; blocked, Boss mailed`);
      } catch (e) { console.error('[agentJail] could not block card', card, e); }
    }
    const notice = jailRefusalNotice(name ?? agentId, agentId, error, card);
    try { hive.send({ to: 'boss', act: 'inform', subject: notice.subject, body: notice.body, requires_reply: false }, 'harness'); } catch (e) { console.error('[agentJail] notify failed:', e); }
  }
  return { ok: false, error: `Agent sandbox: ${error}` };
}

/** Host proxies for jailed agents' network namespaces, by agent id. */
const jailProxies = new Map<string, { proxy: { close(): void }; ptyId: string }>();

async function startAgentJailProxy(id: string, ptyId: string, provider: string, netDir: string, loopbackPorts: number[]): Promise<string | null> {
  jailProxies.get(id)?.proxy.close();
  jailProxies.delete(id);
  try {
    const proxy = await startJailProxy({
      sock: join(netDir, JAIL_NET_SOCK),
      allow: () => [...(PROVIDER_NET_HOSTS[provider] ?? []), ...hookServer.jailAllow(id).allow],
      loopbackPorts,
      onDeny: (host) => {
        const { taskId } = hookServer.jailAllow(id);
        reportJailDeny(provider, host, {
          log: (e) => hive.appendLog({ kind: 'net-deny', agentId: id, tool: 'jail-proxy', ...e, taskId }),
          ask: (h) => hookServer.askBossForHost(id, h, taskId, 'a direct connection through the jail proxy')
        });
      }
    });
    jailProxies.set(id, { proxy, ptyId });
    return null;
  } catch (e) {
    return `could not start the jail network proxy: ${String(e)}`;
  }
}

/** Only the PTY that started the proxy stops it, so a late exit of a replaced PTY
 *  never cuts off its successor's network. */
function stopAgentJailProxy(id: string, ptyId: string): void {
  const entry = jailProxies.get(id);
  if (!entry || entry.ptyId !== ptyId) return;
  entry.proxy.close();
  jailProxies.delete(id);
}

async function spawnAgentCore(opts: AgentSpawnOptions, owner: Electron.WebContents | null): Promise<{ ok: boolean; error?: string; cwd?: string; worktreePath?: string; resumeNotFound?: boolean; resumed?: boolean; seedPrompt?: string; kickoff?: string; startDelivered?: boolean }> {
  // ── cwd INGESTION — expand `~` exactly once, here ───────────────────────────
  // This is the single door every agent spawn comes through (`pty:spawn` IPC and
  // the god-triggered ephemeral-worker watcher), so it is where a user-typed
  // `~/dev/foo` becomes an absolute path. Only a shell expands `~`; Node treats it
  // as a literal dir, so without this every downstream existsSync/statSync fails
  // with `cwd does not exist`. Expanding BEFORE hive provisioning is what makes the
  // registry store an ABSOLUTE cwd (and `cwdValid: true`). The resolved value is
  // returned to the caller so the renderer records the same absolute path.
  opts.cwd = expandTilde(opts.cwd);
  if (opts.hive) opts.hive = { ...opts.hive, cwd: expandTilde(opts.hive.cwd) };
  // Which CLI is this? Explicit wins; else inferred from the binary
  // (claude/codex/grok/agy). Non-Claude providers skip every Claude-only spawn step
  // below. Persist the resolved provider onto opts (+ hive meta) so the registry
  // record and downstream provider-aware steps agree on one value.
  const provider = inferAgentProvider(opts.command, opts.provider ?? opts.hive?.provider);
  const claudeProvider = isClaudeProvider(provider);
  opts.provider = provider;
  if (opts.hive) opts.hive = { ...opts.hive, provider };
  // Activation-funnel entry (v0.4.6): every spawn REQUEST, so (attempted − spawned)
  // measures the fallout the whole rebuild exists to see. Gated on !noAutoInstall so
  // the missing-CLI relaunch (the only re-entry, index.ts install-exit handler) does
  // NOT double-count a single user attempt — it is the SAME attempt continuing.
  if (!opts.noAutoInstall) analytics.track('agent_spawn_attempted', { provider });
  // ── Missing engine CLI → run its installer visibly (pre-spawn) ───────────────
  // If the agent's engine binary (claude/codex/…) isn't installed, spawning it
  // just dies with "— process exited (code 1) —" and the user has no idea why.
  // Detect the absent binary BEFORE spawning and, in this SAME terminal, print a
  // banner + RUN the provider's install command so the user can watch it (and
  // complete any interactive sign-in). On a CLEAN install exit the PTY-exit handler
  // auto restart-and-continues — it re-runs THIS spawn (with noAutoInstall) so the
  // freshly-installed CLI launches in the SAME pty/window, no user click. STRICTLY
  // pre-spawn: a non-zero exit from a CLI that DID start never reaches here, so there
  // is no install loop; and the relaunch's noAutoInstall guarantees the installer
  // can't fire twice. Providers with no known installer get a manual hint only (and
  // are NOT armed for relaunch) — nothing arbitrary is ever auto-run. We short-circuit
  // BEFORE worktree/hive/Claude-flag setup: ptyToAgent + worktreePaths stay unset for
  // this id, so when the install PTY exits teardownPty is a harmless no-op (the agent
  // isn't archived and no worktree is torn down) before the relaunch takes over.
  {
    const bin = opts.command.trim().split(/\s+/)[0] || opts.command;
    if (bin && !opts.noAutoInstall && !ptyManager.isCommandAvailable(bin)) {
      // The installer commands are `npm install -g …`. Probe for npm the same way
      // we probe for the engine CLI, so a no-Node machine gets the node-free rung
      // (or an honest manual hint) instead of watching `npm: not found` scroll by.
      // An npm whose Node is BELOW the floor counts as unavailable: founder rule
      // (2026-08-07) is "their Node newer than ours → leave it alone; absent or
      // older → install the latest stable for them".
      const npmAvailable =
        ptyManager.isCommandAvailable('npm') &&
        nodeIsUsable(detectNodeVersion(ptyManager.commandPath('node')));
      // Only reach the network when we actually need to (npm missing/too old);
      // resolveNodeInstaller is timeout-bounded and returns null offline, which
      // simply drops the ladder to the native/manual rung.
      const nodeInstaller = npmAvailable ? null : await resolveNodeInstaller();
      const rung = chooseInstallRung(installInfoForProvider(provider), npmAvailable, nodeInstaller);
      const res = ptyManager.spawn(
        {
          id: opts.id,
          cwd: opts.cwd,
          command: bin,
          cols: opts.cols,
          rows: opts.rows,
          shellScript: buildMissingCliScript(bin, provider, npmAvailable, process.platform, nodeInstaller)
        },
        owner
      );
      // Arm auto restart-and-continue: when this installer PTY exits cleanly, the
      // exit handler re-runs the spawn so the just-installed CLI launches in place
      // (no user click). Only when an installer actually RAN (a provider with no
      // bundled installer just prints a manual hint and exits 0 — relaunching there
      // would spawn the still-missing binary and die) and the PTY actually started.
      // …keyed on the RUNG, not on `installCommand`: the manual rung prints a hint
      // and exits 0, and relaunching there would just respawn the still-missing
      // binary and die with the bare "process exited (code 1)" this whole path exists
      // to replace.
      if (res.ok && rung.command) {
        pendingInstallRelaunch.set(opts.id, { opts, owner, bin, rung: rung.kind });
        // The auto-installer PTY is running; agent_install_finished on its exit says
        // whether it actually produced an agent (rung is non-manual here by construction).
        analytics.track('agent_install_started', { provider, rung: rung.kind });
      } else if (res.ok) {
        // Manual rung: the PTY only printed a hint (no installer to run, no relaunch
        // armed), so no agent will start. This is the Mode 2 case that used to send
        // NOTHING — an absent engine with no unattended install path.
        analytics.track('agent_spawn_failed', { provider, reason: 'cli_missing' });
      } else {
        // The install PTY itself failed to spawn (cwd gone, id clash, throw).
        analytics.track('agent_spawn_failed', { provider, reason: spawnFailReason(res.error) });
      }
      syncKeepAwake();
      return res;
    }
  }
  // Git isolation: when requested and the cwd is a real repo, give this agent
  // its own worktree on an `agent/<id>` branch so it can't clobber other agents'
  // (or the user's) working tree. Best-effort — a failure falls back to the
  // shared cwd rather than blocking the spawn.
  // NOTE (tracked, not yet hardened): the restore flow passes isolate:false and
  // re-enters the existing worktree by cwd, so it never reaches here. But a stale
  // `isolate:true` recipe spawned against an already-existing worktree path would
  // make addWorktree below conflict (path/branch exists) and fall back to the base
  // cwd — reuse-existing-worktree handling here is the follow-up.
  if (opts.isolate === true && await isRepo(opts.cwd)) {
    try {
      const origCwd = opts.cwd;
      const wtRoot = worktreeRoot(readConfig().harnessHome, origCwd, hiveScratchRoot());
      // The id is renderer-supplied (validated only as a string). Slugify it so a
      // crafted id can't inject path separators, then assert the resolved path
      // stays under the worktrees root (defends against bare '..' that slugify
      // leaves intact). If it would escape, bail isolation → fall back to cwd.
      const seg = (opts.hive?.id ?? opts.id).replace(/[^A-Za-z0-9._-]/g, '-');
      const wtPath = join(wtRoot, seg);
      if (!resolve(wtPath).startsWith(resolve(wtRoot) + sep)) {
        console.error('[worktree] refusing unsafe worktree path for id:', opts.hive?.id ?? opts.id);
      } else {
        const br = await getBranch(origCwd);
        const baseBranch = 'current' in br && br.current ? br.current : 'main';
        const wt = await addWorktree(origCwd, wtPath, baseBranch);
        if (wt.ok) {
          opts.cwd = wtPath;
          worktreePaths.set(opts.id, wtPath);
          worktreeOrigins.set(opts.id, origCwd);
          const deps = await linkWorktreeDeps(origCwd, wtPath);
          if (!deps.ok) console.error('[worktree] dependency link failed:', deps.error);
        } else {
          console.error('[worktree] addWorktree failed:', wt.error);
        }
      }
    } catch (e) {
      console.error('[worktree] isolation failed:', e);
    }
  }
  // Proxy-tier CLIs (qwen/crush) route their LLM traffic through a loopback sidecar
  // whose UPSTREAM is read from the preset's bridge.baseUrlEnv inside hive.ensureAgent.
  // For the local-LLM path, feed the user's configured base URL as that upstream so the
  // proxy forwards to their endpoint (Ollama/LM Studio/vLLM). Set on process.env BEFORE
  // ensureAgent reads it. (Crush's baseUrlEnv is an inert sentinel used ONLY as this
  // upstream source; its real routing is the per-agent CRUSH_GLOBAL_CONFIG base_url.)
  if (opts.hive && (provider === 'crush' || provider === 'qwen')) {
    const bridge = providerPreset(provider).bridge;
    const baseUrl = readConfig().providerBaseUrls?.[provider];
    if (bridge && bridge.kind === 'proxy' && baseUrl) process.env[bridge.baseUrlEnv] = baseUrl;
  }
  // If the agent carries hive metadata, provision its workspace and add
  // provider-specific spawn injection. Non-Claude providers get shared AGENT_*
  // env only; Claude Code also gets prompt/settings hook args.
  // Protocol seed that must be TYPED into a bare TUI after boot (Crush —
  // seedDelivery:'type-into-tui') rather than passed on argv. Surfaced in the spawn
  // result so the renderer types it through the per-pty write-chain. (ondev-b)
  let seedPrompt: string | undefined;
  let kickoff: string | undefined;
  let startDelivered = false;
  if (opts.hive && hive.enabled()) {
    try {
      const inj = await hive.ensureAgent(
        { ...opts.hive, cwd: opts.cwd, provider },
        {
          campMcpServerPath: readConfig().campMcpServerPath,
          campConfigPath: configPath(),
          semanticMemory: memory.active(),
          knowledgeGraph: knowledge.active(),
          // Bake the ABSOLUTE KG CLI path into the agent's prompt. The prompt used
          // to spell it `$KG_CLI`, which is POSIX-only: under cmd.exe/PowerShell it
          // expands to nothing, so every knowledge-graph instruction was dead on a
          // Windows floor. Empty when the KG is off (the line isn't emitted then).
          kgCliPath: knowledge.env().KG_CLI,
          theme: readConfig().terminalTheme ?? 'light',
          effort: spawnEffort(opts.hive.id, provider, spawnModelArg(provider, opts.args), opts.resume !== true && !opts.resumeSessionId, opts.difficulty),
          // W3 — default-MCP consent state + the bundled skills source dir.
          mcpDefaults: readConfig().mcpDefaults,
          skillsDir: skillsResourceDir(),
          // The shared palace is mutated by the agent's own `mempalace` calls, so
          // the OS sandbox must let it through (empty when memory is off).
          extraWritableDirs: [memory.env().MEMPALACE_PALACE_PATH].filter((p): p is string => !!p),
          sandbox: readConfig().agentSandbox === true,
          disableBundledSkills: readConfig().workerDisableBundledSkills === true
        }
      );
      opts.args = [...(opts.args ?? []), ...inj.args];
      // Per-agent sandbox level (registry entry).
      if (provider === 'codex') {
        const cfg = readConfig();
        const level = codexSandboxLevelFor({ jailed: isJailed(cfg, opts.hive.id), agentSandbox: cfg.agentSandbox === true, stored: hive.codexSandboxOf(opts.hive.id).level });
        opts.args = applyCodexNetwork(applyCodexSandbox(opts.args, level), level, hive.capabilitiesOf(opts.hive.id).network);
      }
      seedPrompt = inj.seedPrompt;
      kickoff = inj.kickoff;
      startDelivered = inj.startDelivered === true;
      // A degraded spawn (proxy bridge never bound) is told to the user the same
      // way breaker escalations are: a native toast, gated on the notifications
      // setting. The hive already logged it and pushed hive:degraded to the floor.
      if (inj.degraded) breakerToast('Agent running degraded', inj.degraded);
      // Point the agent's mempalace CLI at the shared palace + the `kg` CLI at the
      // enterprise knowledge store (both no-ops / empty when their flags are off).
      opts.env = { ...(opts.env ?? {}), ...inj.env, ...memory.env(), ...knowledge.env() };
    } catch (e) {
      // Hive provisioning is best-effort; never block a spawn on it.
      console.error('[hive] ensureAgent failed:', e);
    }
  }
  // Long-run guardrails + tiering (Lane A #6.4/#6.6). All additive to the args
  // already assembled (incl. the hive injection); an explicit choice always wins.
  // Set when an explicit Add Agent "resume session" id couldn't be located and we
  // silently fell back to a fresh session — returned so the dialog can surface it.
  let resumeNotFound = false;
  // Set when `--resume` was actually attached (explicit id or restore-on-restart),
  // so the renderer can skip re-orienting a god/assistant that resumed its thread.
  let didResume = false;
  // Claude-only — these are Claude Code flags; other CLIs carry their own flags
  // in the command string the renderer already built.
  if (opts.hive && claudeProvider) {
    const cfg = readConfig();
    // Permission posture (D9): only a GUI hire (Add Agent) builds its command
    // through buildSpawnCommand, which bakes autoMode's bypass flag into the
    // command STRING before this function ever sees it. A main-only spawn (the
    // ephemeral-worker watcher, a voice hire) skips that step entirely, so it
    // previously reached here with neither the flag nor any equivalent — every
    // other Claude spawn path got the user's autoMode posture and this one
    // didn't. argsWithAutoModeFlag is idempotent (a GUI spawn's args already has
    // the flag, so this is a no-op for it) and is the SAME check spawnAgentCore
    // already applies for opencode/crush et al a few lines below via
    // HIVE_AUTO_APPROVE — one global toggle, one posture, every spawn path.
    // Confirmed live: a worker spawned without this flag deadlocked — a
    // cross-session message to it came back "held for the recipient user's
    // approval" with no surface for anyone to ever grant that approval.
    const args = argsWithAutoModeFlag(opts.args ?? [], cfg.autoMode, provider);
    // Model precedence: an explicit per-agent --model (from the renderer) wins;
    // else the user's global defaultModel; else the role-based default tier. The
    // GOD is special-cased: it has its own engine config (godProvider/godModel), so
    // modelForRole resolves it and that wins over the worker-oriented defaultModel.
    if (!args.includes('--model')) {
      const m = opts.hive.isGod
        ? modelForRole(opts.hive, cfg)
        : cfg.defaultModel ?? modelForRole(opts.hive, cfg);
      if (m) args.push('--model', m);
    }
    // Name the Remote Control session after the agent (Michael, Jim, Dev1…) so it
    // is identifiable in claude.ai / the mobile app. Otherwise Claude defaults the
    // prefix to the machine hostname (e.g. "vyapaks-macbook-pro-…"), which is
    // opaque when several agents run at once — especially with remoteControlAtStartup
    // on, where RC auto-enables for every session. Slugify the friendly name into a
    // single safe token; Claude still appends its own random suffix for uniqueness.
    if (!args.includes('--remote-control-session-name-prefix')) {
      const label = (opts.hive.name || opts.hive.id || '')
        .trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
      if (label) args.push('--remote-control-session-name-prefix', label);
    }
    // Coarse runaway cap.
    if (typeof cfg.maxTurns === 'number' && cfg.maxTurns > 0 && !args.includes('--max-turns')) {
      args.push('--max-turns', String(cfg.maxTurns));
    }
    // Resume: an explicit session id (Add Agent "resume session" field, #2) wins,
    // else this agent's last recorded session (#1 restore-on-restart / #6.6a).
    // Seed the transcript into the target cwd's Claude project dir first — Claude
    // keys sessions by cwd, so a session started elsewhere is invisible until its
    // `.jsonl` is copied across. Only attach `--resume` if the transcript is
    // actually present (already or after the copy); otherwise fall back to a fresh
    // session rather than launching a `--resume` against a missing id.
    const explicitSid = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
    const sid = explicitSid || (opts.resume === true ? hive.lastSession(opts.hive.id) : undefined);
    if (sid && !args.includes('--resume')) {
      if (seedSessionTranscript(opts.cwd, sid)) {
        args.push('--resume', sid);
        didResume = true;
      } else if (explicitSid) {
        // The user typed a session id in the Add Agent dialog but it isn't in any
        // Claude project dir — we fall back to a FRESH session rather than a broken
        // `--resume`. Make that non-silent: warn on the floor and flag it back to
        // the renderer so the dialog can tell the user 'started fresh'.
        console.warn(`[resume] session "${explicitSid}" not found in any Claude project dir — starting a fresh session`);
        resumeNotFound = true;
      }
    }
    opts.args = args;
  }
  // Idempotent session resume on respawn (#6.6a) — provider-aware: Claude
  // `--resume <sid>`, Grok `--resume <sid>`, Antigravity `--conversation <id>`.
  // The recorded session id comes from hook payloads, so
  // a restored worker continues its prior CLI session. Only when requested AND a
  // prior id exists for this agent.
  // Claude resume — incl. transcript seeding + only-attach-when-present — is
  // handled in the Claude-only block above; this generic flag path covers the
  // other CLIs (it must not blindly attach `--resume` when the seed failed).
  if (opts.hive && !claudeProvider) {
    const preset = providerPreset(provider);
    const rf = preset.resumeFlag;
    const rsub = preset.resumeSubcommand;
    // An id typed into Add Agent's "resume session" field wins; otherwise fall
    // back to this agent's own recorded session (restart-in-place). Previously
    // resumeSessionId was read ONLY in the Claude branch, so a Codex agent
    // silently ignored it and started a brand-new empty session.
    const typedSid = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
    const sid = typedSid || (opts.resume === true ? hive.lastSession(opts.hive.id) : undefined);
    if (sid && rf) {
      const args = opts.args ?? [];
      if (!args.includes(rf)) { args.push(rf, sid); opts.args = args; didResume = true; }
    } else if (sid && rsub) {
      // Subcommand form (Codex): `codex resume [OPTIONS] [SESSION_ID]` — the
      // subcommand MUST be argv[0], the id trails the flags. Codex indexes
      // sessions in state_5.sqlite, so a fresh agent's empty CODEX_HOME can't
      // resume by id. If this agent's own home already has the session, resume in
      // place; otherwise point CODEX_HOME at the agent home that OWNS it (that
      // home has both the rollout and the sqlite index).
      const myHome = (opts.env ?? {}).CODEX_HOME;
      const agentsRoot = myHome ? dirname(dirname(myHome)) : '';
      const ownerHome = agentsRoot ? findCodexHomeForSession(sid, agentsRoot) : null;
      if (!ownerHome) {
        console.warn(`[resume] codex session "${sid}" not found in any agent CODEX_HOME - starting fresh`);
        if (typedSid) resumeNotFound = true;
      } else {
        if (ownerHome !== myHome) opts.env = { ...(opts.env ?? {}), CODEX_HOME: ownerHome };
        const args = opts.args ?? [];
        // Positional order matters: `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`.
        // The hive identity prompt rides in `args` as a POSITIONAL (codex has no
        // prompt flag), so the id must come BEFORE it — appending the id last made
        // codex read the prompt as SESSION_ID ("No saved session found with ID
        // You are \"Dev2\"…") and the id as the prompt.
        if (args[0] !== rsub) { opts.args = [rsub, sid, ...args]; didResume = true; }
        console.log('[resume] codex resume', sid, 'in', ownerHome);
      }
    }
  }
  if (opts.requireResume === true && !didResume) {
    return {
      ok: false,
      error: 'Existing session could not be resumed; no replacement process was started.',
      ...(resumeNotFound ? { resumeNotFound: true } : {})
    };
  }
  // Remember which agent owns this PTY so closing the tab can archive it. A
  // live terminal means active — ensureAgent above already cleared `archived`.
  if (opts.hive?.id) {
    ptyToAgent.set(opts.id, opts.hive.id);
    liveSessions.set(opts.hive.id, { atMs: Date.now(), provider: opts.provider ?? 'claude', cwd: opts.cwd });
    // Worker inbox-wake watchdog (#151): boot grace starts at spawn so the
    // initial orientation prompt is never mistaken for an idle agent.
    workerWake.noteSpawn(opts.id);
    try {
      const cards = openCards(opts.hive.id, tasksOf(hive.tasks()) as NudgeCard[]);
      todoNudger.begin(opts.hive.id, cards.map((c) => String(c.id)), cards.filter((c) => c.status === 'doing').map((c) => String(c.id)));
    }
    catch { todoNudger.forget(opts.hive.id); }
  }
  // Pre-accept Claude Code's bypass-mode warning + folder-trust dialog so the
  // agent (spawned with --permission-mode bypassPermissions) doesn't stall on an
  // interactive prompt it can't answer and exit code 1. Best-effort, never blocks.
  // Claude-only — other CLIs handle their own permission UX.
  if (claudeProvider) {
    try { ensureClaudePermissionsAccepted(opts.cwd); } catch { /* never block spawn */ }
  }
  // Suppress first-run interactive prompts for providers that need it (e.g. Codex
  // directory-trust gate via CODEX_NON_INTERACTIVE). Merges into any env already
  // set on opts.
  const nonInteractiveEnv = nonInteractiveEnvForProvider(provider);
  if (Object.keys(nonInteractiveEnv).length > 0) {
    opts.env = { ...(opts.env ?? {}), ...nonInteractiveEnv };
  }
  // ── BYOK keys + per-provider config for the non-Claude CLI engines (v0.3.1) ──
  // OpenCode / Crush / pi / qwen read BYOK API keys from standard env vars and, for
  // the local-LLM path, a per-provider base URL. Keys are write-only in the broker
  // (read MAIN-ONLY here, never logged); base URLs ride HarnessConfig. Claude/codex
  // use their own login, so they skip this. Pam guardrails #3/#4/#5.
  if (opts.hive && (provider === 'opencode' || provider === 'crush' || provider === 'pi' || provider === 'qwen')) {
    const cfg = readConfig();
    const extra: Record<string, string> = {};
    // 1) BYOK keys — LEAST-PRIVILEGE (Pam/Jim NIT-2): inject ONLY the key for the
    //    spawned model's provider prefix when we can identify it; fall back to all
    //    stored keys when the model/prefix is unknown (default model, qwen slugs,
    //    custom). Reduces the blast radius vs handing every CLI all keys.
    const modelIdx = (opts.args ?? []).indexOf('--model');
    const modelSlug = modelIdx >= 0 ? (opts.args?.[modelIdx + 1] ?? '') : '';
    const prefix = modelSlug.includes('/') ? modelSlug.split('/')[0].toLowerCase() : '';
    const PREFIX_BACKEND: Record<string, string> = {
      anthropic: 'anthropic', openai: 'openai', google: 'google', gemini: 'google', groq: 'groq', openrouter: 'openrouter'
    };
    const scoped = PREFIX_BACKEND[prefix];
    const backends = scoped ? [scoped] : Object.keys(BACKEND_KEY_ENV);
    for (const backend of backends) {
      const key = integrations.getSecret(providerKeyRef(backend));
      if (!key) continue;
      extra[BACKEND_KEY_ENV[backend]] = key;
      // OpenCode/AI-SDK's Google provider reads GOOGLE_GENERATIVE_AI_API_KEY, not
      // GEMINI_API_KEY — inject both so google/* authenticates (Jim NIT #1).
      if (backend === 'google') extra.GOOGLE_GENERATIVE_AI_API_KEY = key;
    }
    // 2) Floor auto-state for pi's bundled extension auto-allow (guardrail #5): it
    //    only auto-approves tool calls when this is '1' (i.e. floor auto mode on).
    extra.HIVE_AUTO_APPROVE = cfg.autoMode ? '1' : '0';
    // 3) OpenCode's auto-approve + local provider live in its single config-injection
    //    env var, built dynamically so permission:allow is GATED on autoMode (#2).
    if (provider === 'opencode') {
      const oc: Record<string, unknown> = { autoupdate: false };
      if (cfg.autoMode) oc.permission = { edit: 'allow', bash: 'allow', webfetch: 'allow' };
      const baseUrl = cfg.providerBaseUrls?.opencode;
      if (baseUrl) {
        // Register the model id the user actually selects (the part after 'local/')
        // so `--model local/<id>` resolves; default to 'local'. Without this the
        // dropdown's `local/llama3` failed against a config that only declared model
        // 'local' (Jim verify-opencode MUST-FIX #2).
        const localModel = (prefix === 'local' && modelSlug.slice(6)) || 'local';
        oc.provider = {
          local: { npm: '@ai-sdk/openai-compatible', name: 'Local (self-hosted)', options: { baseURL: baseUrl }, models: { [localModel]: { name: localModel } } }
        };
      }
      extra.OPENCODE_CONFIG_CONTENT = JSON.stringify(oc);
    }
    opts.env = { ...(opts.env ?? {}), ...extra };
  }
  // Apply after model selection and hive injection so every launch path gets the worker cap.
  opts.env = { ...(opts.env ?? {}), ...workerContextEnv(provider, opts.hive?.isGod, opts.hive?.id ?? opts.id) };
  // A jailed agent that cannot be jailed is refused rather than spawned with full access.
  opts.jail = undefined;
  if (opts.hive && isJailed(readConfig(), opts.hive.id)) {
    if (!jailSupports(provider)) return refuseUnjailableProvider(opts.hive.id, opts.hive.name, provider);
    const jail = agentJail(opts.hive.id, provider, opts.cwd);
    if (!jail.ok) {
      console.error(`[agentJail] refusing to spawn ${opts.hive.id}: ${jail.error}`);
      hive.appendLog({ kind: 'agent-jail-refused', agentId: opts.hive.id, error: jail.error });
      jailRefusals.refused(opts.hive.id, jail.error, Date.now());
      return { ok: false, error: `Agent sandbox: ${jail.error}` };
    }
    if (jail.plan.net) {
      const err = await startAgentJailProxy(opts.hive.id, opts.id, provider, jail.plan.net.dir, jail.plan.net.loopbackPorts);
      if (err) {
        console.error(`[agentJail] refusing to spawn ${opts.hive.id}: ${err}`);
        hive.appendLog({ kind: 'agent-jail-refused', agentId: opts.hive.id, error: err });
        jailRefusals.refused(opts.hive.id, err, Date.now());
        return { ok: false, error: `Agent sandbox: ${err}` };
      }
    }
    opts.jail = jail.plan;
  }
  const res = ptyManager.spawn(opts, owner);
  if (!res.ok && opts.jail?.net && opts.hive) stopAgentJailProxy(opts.hive.id, opts.id);
  if (res.ok && opts.hive) jailRefusals.spawned(opts.hive.id);
  if (res.ok) analytics.track('agent_spawned', { provider });
  else analytics.track('agent_spawn_failed', { provider, reason: spawnFailReason(res.error) });
  syncKeepAwake(); // arm the power-save blocker while ≥1 agent PTY is alive (#18)
  // Hand the resolved worktree path back to the renderer so it can persist it on
  // the agent (only set when isolation actually provisioned a worktree above).
  // The restore flow re-enters this exact worktree (cwd = worktreePath) so a
  // restored isolated agent resumes in the CORRECT checkout, not the base repo.
  const worktreePath = worktreePaths.get(opts.id);
  // `cwd` echoes back the TILDE-EXPANDED absolute path so the renderer's agent
  // record matches what the registry and the PTY actually used.
  return { ...res, cwd: opts.cwd, ...(worktreePath ? { worktreePath } : {}), ...(resumeNotFound ? { resumeNotFound: true } : {}), ...(didResume ? { resumed: true } : {}), ...(seedPrompt ? { seedPrompt } : {}), ...(kickoff && !didResume ? { kickoff } : {}), ...(startDelivered ? { startDelivered } : {}) };
}
ipcMain.handle('pty:write', (_evt, id: string, data: string) => {
  if (typeof id !== 'string' || typeof data !== 'string') return { ok: false, error: 'invalid args' };
  todoNudger.noteInput(ptyToAgent.get(id), data);
  return ptyManager.write(id, data);
});
ipcMain.handle('pty:resize', (_evt, id: string, cols: number, rows: number) => {
  if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return { ok: false, error: 'invalid args' };
  return ptyManager.resize(id, cols, rows);
});
ipcMain.handle('pty:redraw', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  return ptyManager.redraw(id);
});
ipcMain.handle('pty:kill', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  // Kill the process, then run the shared lifecycle teardown (archive the agent,
  // remove its isolated worktree, drop the maps). teardownPty is idempotent, so
  // node-pty firing onExit once the child actually dies is a harmless no-op.
  const res = ptyManager.kill(id);
  teardownPty(id);
  return res;
});
ipcMain.handle('pty:list', () => ptyManager.list());

// ─── IPC: analytics (the ONE renderer-facing seam) ──────────────────────────
/** Count one human-sent message (TELEMETRY.md → `message_sent`). A COUNT, and
 *  nothing else: this channel takes no text, no length and no id, so there is
 *  no shape in which message content could cross it.
 *
 *  This is the only analytics event the renderer can cause. It exists because
 *  two of the four send surfaces — a line typed into the agent's terminal, and
 *  the queue composer — are submits main cannot observe: the `pty:write` handler
 *  above fires on EVERY KEYSTROKE, so counting there would produce a keystroke
 *  meter, not a message count. `steer` and `hive` are counted at their own IPC
 *  handlers in this file and are rejected here (isRendererMessageSurface) so
 *  they can never be counted twice. The event name is fixed here, not passed
 *  in: the renderer chooses a surface, never an event. */
ipcMain.on('perf:lag', (_evt, r: unknown) => {
  if (!r || typeof r !== 'object') return;
  const { kind, what, waitMs, handleMs, ms } = r as Record<string, unknown>;
  if (kind !== 'input-lag' && kind !== 'renderer-longtask') return;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
  hive.appendLog({ kind, what: typeof what === 'string' ? what.slice(0, 40) : undefined, waitMs: num(waitMs), handleMs: num(handleMs), ms: num(ms) });
});

ipcMain.handle('analytics:messageSent', (_evt, surface: unknown) => {
  if (!isRendererMessageSurface(surface)) return { ok: false };
  analytics.trackMessageSent(surface);
  return { ok: true };
});

// Resolve a pasted Claude session id to the cwd it originally ran in, so the Add
// Agent dialog can auto-fill the folder for a resume (#2 zero-step resume). Reads
// the cwd from a transcript record; null when the id is invalid/unknown.
ipcMain.handle('session:resolveCwd', (_evt, sessionId: unknown) =>
  (typeof sessionId === 'string' ? resolveSessionCwd(sessionId) : null));

// ─── IPC: clipboard ─────────────────────────────────────────────────────────
ipcMain.handle('app:copyToClipboard', (_evt, text: unknown) => {
  if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
  try { clipboard.writeText(text); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('app:readClipboard', () => {
  try { return clipboard.readText(); } catch { return ''; }
});
// Same read, SYNCHRONOUS, for the terminal's paste shortcut.
//
// Dictation tools (muesli.works, Wispr Flow, …) type by stashing the user's
// clipboard, writing the transcript, sending the paste key, then restoring the
// old clipboard immediately. An `invoke` read returns a tick or two later — by
// which point the restore has already landed and we paste the PREVIOUS text.
// A `sendSync` read completes inside the keydown handler, before the tool gets
// a chance to put the old contents back.
ipcMain.on('app:readClipboardSync', (evt) => {
  try { evt.returnValue = clipboard.readText(); } catch { evt.returnValue = ''; }
});
// NOTE: the terminal theme is mirrored into each agent's per-session Claude
// settings at spawn (hive.ensureAgent theme option) — deliberately NOT via
// `claude config set -g theme`, which would also restyle the user's own
// Claude sessions outside the app.

// ─── IPC: folder picker ─────────────────────────────────────────────────────
ipcMain.handle('dialog:chooseFolder', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Pick a folder'
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, path: res.filePaths[0] };
});

// ─── IPC: Terminal.app at a folder ──────────────────────────────────────────
ipcMain.handle('terminal:openAtFolder', async (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: 'invalid cwd' };
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const p = spawn('open', ['-a', 'Terminal', cwd]);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: err.trim() || `open exited ${code}` });
    });
  });
});

// ─── IPC: integrations (Phase 2 registry — backend for Ryan's Settings UI) ────
// Records are metadata only (config-backed); secrets are encrypted at rest and NEVER
// returned over IPC. `list` redacts secretRef to a `hasSecret` boolean.
ipcMain.handle('integrations:list', () => integrations.listRecordsRedacted());
ipcMain.handle('integrations:templates', () => INTEGRATION_TEMPLATES);
ipcMain.handle('integrations:upsert', (_evt, record: unknown) => integrations.upsertRecord(record));
ipcMain.handle('integrations:setSecret', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown; secret?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  if (typeof p.secret !== 'string' || !p.secret) return { ok: false, error: 'secret required' };
  return integrations.setSecret(secretRefFor(p.id), p.secret);
});
ipcMain.handle('integrations:remove', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  return integrations.removeRecord(p.id);
});
// ─── IPC: per-CLI-provider BYOK keys (write-only) ────────────────────────────
// API keys for the backend model-providers the non-Claude CLIs use are stored
// WRITE-ONLY under `apikey:<backend>` in the same encrypted broker. The renderer
// can SET a key and ASK whether one is set (boolean) — it can never read the
// plaintext back. Keys are materialized MAIN-ONLY at spawn (spawnAgentCore). Base
// URLs are non-secret and ride HarnessConfig.providerBaseUrls (normal config save).
ipcMain.handle('providerKey:set', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { backend?: unknown; key?: unknown };
  if (typeof p.backend !== 'string' || !(p.backend in BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
  if (typeof p.key !== 'string' || !p.key) return { ok: false, error: 'key required' };
  return integrations.setSecret(providerKeyRef(p.backend), p.key);
});
ipcMain.handle('providerKey:has', (_evt, backend: unknown) =>
  typeof backend === 'string' ? integrations.hasSecret(providerKeyRef(backend)) : false);
ipcMain.handle('providerKey:clear', (_evt, backend: unknown) => {
  if (typeof backend !== 'string' || !(backend in BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
  try { integrations.deleteSecret(providerKeyRef(backend)); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
// Probe an integration's reachability through the broker's own auth path (admin-only;
// runs in main, so the secret is used but never returned — only the upstream status).
ipcMain.handle('integrations:test', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown; path?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  const rec = integrations.getRecord(p.id);
  if (!rec) return { ok: false, error: 'unknown integration' };
  const probe = validateBaseUrl(rec.baseUrl);
  if (!probe.ok) return { ok: false, error: probe.error };
  // Confine the probe path through the SAME gate as the worker forward() path, so an
  // absolute URL / backslash-host / traversal in p.path can't override the origin and
  // exfiltrate the secret to an attacker host. Resolve (and reject) BEFORE the secret
  // is ever materialized, so a bad path never even decrypts it.
  const target = resolveUpstreamUrl(rec.baseUrl, typeof p.path === 'string' ? p.path : '');
  if (!target) return { ok: false, error: 'path escapes the integration baseUrl', code: 'bad_request' };
  const secret = integrations.getSecret(rec.secretRef);
  const headers = buildAuthHeaders(rec.authType, rec.authHeader, secret);
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    const r = await fetch(target, { method: 'GET', headers, redirect: 'manual', signal: ac.signal });
    clearTimeout(timer);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── IPC: theme packs ───────────────────────────────────────────────────────
// Installed office themes in <userData>/themes (see main/themePacks.ts). The list
// rescans, so a pack installed while the app runs shows up on the next reload.
function rescanThemePacks(): InstalledThemePack[] {
  const packs = scanThemePacks(themePacksDir(app.getPath('userData')));
  setInstalledThemePacks(packs);
  return packs;
}
ipcMain.handle('themePacks:list', (): InstalledThemePack[] => rescanThemePacks());
ipcMain.handle('themePacks:asset', (_evt, id: unknown, rel: unknown): Buffer | null => {
  if (typeof id !== 'string' || typeof rel !== 'string') return null;
  if (!installedThemePacks().some((p) => p.id === id)) return null;
  return readThemePackAsset(themePacksDir(app.getPath('userData')), id, rel);
});

// ─── IPC: config ────────────────────────────────────────────────────────────
ipcMain.handle('config:get', (): HarnessConfig => readConfig());
ipcMain.handle('config:update', (_evt, patch: Partial<HarnessConfig>) => {
  // FIRST RUN: every hive-bound service is started by bootstrapHiveServices(),
  // which runs once at app-ready and early-returns on `!hive.enabled()` — i.e.
  // whenever harnessHome is still null, which is exactly the state a fresh
  // install boots in. Onboarding then sets harnessHome through THIS handler and
  // nothing re-bootstrapped, so the hook server, message router, telemetry
  // collector and mission scheduler all stayed dead for the rest of the session.
  //
  // Symptom: agents spawn and run (the PTY is not hive-bound), but no hook ever
  // reaches the app — no `hooks.sock` on disk, so no SessionStart, which means
  // recordSession() is never called and "Restart & Continue" fails with "No
  // recorded session ID"; the cards also sit on "ctx no status tick yet" and 0
  // tool calls. Everything healed on the next app launch, which is what hid it.
  //
  // changeHome() has always handled this by relaunching; onboarding does not
  // relaunch, so bootstrap here on the null → set transition. Gated on the
  // transition so ordinary config writes never re-enter it.
  const hiveWasEnabled = hive.enabled();
  const wasOnboarded = readConfig().onboardingComplete;
  if (patch && 'modelTiers' in patch) {
    const v = validateModelTiers(patch.modelTiers);
    if (!v.ok) { console.warn('[config] modelTiers refused:', v.reason); patch = { ...patch, modelTiers: undefined }; delete patch.modelTiers; }
    else patch = { ...patch, modelTiers: v.tiers };
  }
  const next = writeConfig(patch);
  exportWorkspaceRoot(next);
  exportHumanName(next);
  // Live opt-in/out from Settings → Privacy (TELEMETRY.md).
  if (typeof patch?.telemetryEnabled === 'boolean') analytics.setEnabled(patch.telemetryEnabled);
  // Activation funnel (v0.4.6): onboarding just finished (false → true) — the top of
  // the launch → first-agent funnel. `provider` is the engine chosen in the wizard.
  // Fired here (main), not in the renderer, so it rides the same allowlist as the rest.
  if (!wasOnboarded && next.onboardingComplete) {
    analytics.track('onboarding_completed', { provider: next.godProvider ?? 'claude' });
  }
  // Keep the hive's mirror of the spawn gate current. The queue itself reads
  // config per tick so it gates immediately; this is for the PROMPT, which is
  // built per spawn, so flipping the toggle reaches god the next time he starts.
  if (typeof patch?.orchestratorMaySpawn === 'boolean') hive.setOrchestratorMaySpawn(patch.orchestratorMaySpawn);
  if (!hiveWasEnabled && hive.enabled()) {
    console.log('[hive] harnessHome configured — bootstrapping hive services');
    try { bootstrapHiveServices(); } catch (e) { console.error('[hive] bootstrap after onboarding:', e); }
  }
  return next;
});
ipcMain.handle('config:setAgentTokenCap', (_evt, agentId: unknown, tokenCap: unknown) =>
  setAgentTokenCap(agentId, tokenCap)
);
ipcMain.handle('config:ensureHome', (_evt, path: unknown) => {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, error: 'invalid path' };
  return ensureHarnessHome(path);
});

// Change the harnessHome folder. Because every derived path (hive root, palace,
// sock, agent dirs) resolves lazily through getHome(), the only real work is
// optionally MOVING the existing hive + palace and relaunching so every service
// re-binds against the new root. mode: 'move' copies the data (old kept as a
// safety net), 'fresh' just re-points and bootstraps an empty home.
ipcMain.handle('config:changeHome', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { newHome?: unknown; mode?: unknown };
  if (typeof p.newHome !== 'string' || !p.newHome) return { ok: false, error: 'invalid newHome' };
  const mode: 'move' | 'fresh' = p.mode === 'fresh' ? 'fresh' : 'move';
  // expandTilde BEFORE resolve: both UI callers feed a folder-dialog result
  // (always absolute), but the hive picker's recents list can serve a literal
  // "~/…" persisted by a pre-#140 build — resolve() would anchor that at cwd
  // and the app would relaunch against a real directory named "~". Same
  // defence-in-depth-at-the-consumer rule as expandTilde's own doc.
  const newHome = resolve(expandTilde(p.newHome));
  const oldRaw = readConfig().harnessHome;
  const oldHome = oldRaw ? resolve(oldRaw) : null;

  // Guard against same-folder / nested-folder (a move would self-copy forever).
  if (oldHome) {
    if (newHome === oldHome) return { ok: false, error: 'That is already the current home folder.' };
    const a = newHome + sep, b = oldHome + sep;
    if (a.startsWith(b) || b.startsWith(a)) {
      return { ok: false, error: 'Pick a folder that is not inside (or a parent of) the current home.' };
    }
  }

  const ensured = ensureHarnessHome(newHome);
  if (!ensured.ok) return ensured;

  // Tear down everything bound to the OLD root before copying, so nothing writes
  // mid-copy — a live git commit into hive/.git would otherwise be copied as a
  // half-written object and corrupt the moved repo.
  try { clearMissionTimers(); } catch (e) { console.error('[changeHome] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[changeHome] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[changeHome] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[changeHome] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[changeHome] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[changeHome] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[changeHome] hookServer.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[changeHome] slack.stop:', e); }
  try { stopWebhookServer(); } catch (e) { console.error('[changeHome] webhook.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[changeHome] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[changeHome] reflector.stop:', e); }

  if (mode === 'move' && oldHome) {
    try {
      // roster.json + its backups ride along with hive/palace: the roster is the
      // renderer's half of the same state, and leaving it behind would move the
      // agents' sessions and memory to the new home while their names, notes and
      // worktree paths stayed at the old one.
      for (const sub of ['hive', 'palace', 'roster.json', 'roster-backups']) {
        const src = join(oldHome, sub);
        if (!existsSync(src)) continue;
        // cpSync copies the whole tree incl. .git and is cross-device safe (unlike
        // renameSync, which throws EXDEV across volumes). We COPY, never delete —
        // the old folder stays as a safety net the user removes manually.
        cpSync(src, join(newHome, sub), { recursive: true, force: true, dereference: false });
      }
    } catch (e) {
      // Copy failed: recover IN PLACE against the unchanged old home (config never
      // repointed) so the user loses nothing, and surface the error — no relaunch.
      bootstrapHiveServices();
      const cfg = readConfig();
      if (cfg.slackEnabled && cfg.slackSigningSecret) void startSlackServer();
      reconcileWebhookServer();
      return { ok: false, error: `Could not copy data: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Repoint config and relaunch so every service re-bootstraps against newHome.
  // (Identical recovery path to resetAll — relaunch is the clean re-bind.)
  allowQuit = true;
  writeConfig({ harnessHome: newHome });
  try { ptyManager.killAll(); } catch (e) { console.error('[changeHome] killAll:', e); }
  app.relaunch();
  app.exit(0);
  return { ok: true as const }; // unreachable (process exits) — typed for the renderer
});

// ─── IPC: filesystem (sandboxed to a root) ──────────────────────────────────
ipcMain.handle('fs:listDir', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return listDir(root, rel);
});
ipcMain.handle('fs:readFile', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileText(root, rel);
});
// Raw bytes for files the text reader refuses (images). The renderer cannot
// load them off disk itself — the CSP has no `file:` source and no file
// protocol is registered — so the bytes come through here and become a `blob:`
// URL on the other side. Same root confinement as every other fs handler.
ipcMain.handle('fs:readBinary', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileBinary(root, rel);
});
ipcMain.handle('fs:writeFile', (_evt, root: unknown, rel: unknown, content: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string' || typeof content !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return writeFileText(root, rel, content);
});
// v0.3.4: existence check for the terminal ⌘-click markdown flow (metadata only).
ipcMain.handle('fs:statAbs', (_evt, p: unknown) => {
  if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) {
    return { exists: false, isFile: false, path: '' };
  }
  return statAbs(p);
});

/** Reveal a path in the OS file browser — Finder, Explorer, or whatever the
 *  Linux desktop registers. Backs ⌘-click on a terminal path we cannot open
 *  ourselves (an image, an archive, an unknown extension).
 *
 *  `showItemInFolder`, NEVER `shell.openPath`, for a file. The path arrives
 *  from agent output, and openPath hands an arbitrary file to its default
 *  application: a printed `installer.dmg` or `.desktop` would be one click from
 *  executing. Revealing only ever opens a file browser, so the worst an agent
 *  can achieve by printing a path is a window at a folder the user could
 *  already open themselves.
 *
 *  openPath IS used for a directory, and only after statAbs has confirmed it is
 *  one — a directory has no default application to launch, so the execution
 *  argument above does not apply, and revealing a folder inside its parent is
 *  not what "open this folder" means to anyone. */
ipcMain.handle('fs:revealPath', async (_evt, p: unknown) => {
  if (typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0')) {
    return { ok: false, error: 'bad request' };
  }
  const st = await statAbs(p);
  if (!st.exists) return { ok: false, error: 'not found' };
  if (st.isFile) { shell.showItemInFolder(st.path); return { ok: true }; }
  const err = await shell.openPath(st.path);
  return err ? { ok: false, error: err } : { ok: true };
});

/** Opens a file clicked on an ASK ME card. A file the in-app viewer takes comes back as
 *  route 'viewer' for the renderer to open; HTML and allowlisted files over the viewer's
 *  ceiling go to the system's default app; anything else is revealed. The file must sit
 *  under a folder the card links from (home, the harness home, registered repos, agent
 *  folders), checked on the resolved path so a symlink cannot lead out of them. */
ipcMain.handle('fs:openCardFile', async (_evt, p: unknown) => {
  if (typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0')) {
    return { ok: false, error: 'bad request' };
  }
  const st = await statAbs(p);
  if (!st.exists || !st.isFile) return { ok: false, error: 'not found' };
  let real: string;
  let size: number;
  try { real = await realpath(st.path); size = (await statAsync(real)).size; } catch { return { ok: false, error: 'not found' }; }
  const cfg = readConfig();
  const roots = [homedir(), cfg.harnessHome, ...(cfg.registeredRepos ?? []),
    ...Object.values(hive.registry().agents).map((a) => a.cwd)]
    .filter((r): r is string => typeof r === 'string' && isAbsolute(expandTilde(r)));
  const inside = await Promise.all(roots.map(async (r) => {
    try { const rr = await realpath(expandTilde(r)); return real === rr || real.startsWith(rr.endsWith(sep) ? rr : rr + sep); } catch { return false; }
  }));
  if (!inside.some(Boolean)) return { ok: false, error: 'outside the linked folders' };
  const route = fileOpenRoute(real, size);
  if (route === 'system') {
    const err = await shell.openPath(real);
    return err ? { ok: false, error: err } : { ok: true, route, path: real };
  }
  if (route === 'reveal') shell.showItemInFolder(real);
  return { ok: true, route, path: st.path };
});

// ─── IPC: git ───────────────────────────────────────────────────────────────
ipcMain.handle('git:isRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return false;
  return isRepo(cwd);
});

// The repo a cwd belongs to, following a linked worktree back to its main
// checkout — the renderer groups the agent roster by this.
ipcMain.handle('git:mainRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || !cwd) return null;
  return mainRepoRoot(cwd);
});
ipcMain.handle('git:branch', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranch(cwd);
});
ipcMain.handle('git:status', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getStatus(cwd);
});
ipcMain.handle('git:log', (_evt, cwd: unknown, n: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  const count = typeof n === 'number' ? Math.min(500, Math.max(1, n)) : 50;
  return getLog(cwd, count);
});
ipcMain.handle('git:branches', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranches(cwd);
});
ipcMain.handle('git:aheadBehind', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getAheadBehind(cwd);
});
ipcMain.handle('git:diff', (_evt, cwd: unknown, relPath: unknown) => {
  if (typeof cwd !== 'string' || typeof relPath !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return getDiff(cwd, relPath);
});
// ─── v0.3.4: history / compare / checkout (git visualization) ───────────────
ipcMain.handle('git:logGraph', (_evt, cwd: unknown, n: unknown, skip: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid args' };
  const count = Math.min(500, Math.max(1, typeof n === 'number' ? n : 200));
  const off = Math.max(0, typeof skip === 'number' ? skip : 0);
  return getLogGraph(cwd, count, off);
});
ipcMain.handle('git:commitFiles', (_evt, cwd: unknown, sha: unknown) => {
  if (typeof cwd !== 'string' || typeof sha !== 'string') return { error: 'invalid args' };
  return getCommitFiles(cwd, sha);
});
ipcMain.handle('git:showFile', (_evt, cwd: unknown, rev: unknown, relPath: unknown) => {
  if (typeof cwd !== 'string' || typeof rev !== 'string' || typeof relPath !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return getFileAtRev(cwd, rev, relPath);
});
ipcMain.handle('git:compareRefs', (_evt, cwd: unknown, base: unknown, head: unknown, mode: unknown) => {
  if (typeof cwd !== 'string' || typeof base !== 'string' || typeof head !== 'string') {
    return { error: 'invalid args' };
  }
  return compareRefs(cwd, base, head, mode === 'two' ? 'two' : 'three');
});
ipcMain.handle('git:worktrees', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid args' };
  return listWorktrees(cwd);
});
ipcMain.handle('git:checkout', async (_evt, cwd: unknown, ref: unknown, detach: unknown) => {
  if (typeof cwd !== 'string' || typeof ref !== 'string') return { ok: false, error: 'invalid args' };
  // Guard: never swap files under an actively-working agent. Objective signal
  // owned by main — any live pty whose cwd sits in this tree and emitted output
  // in the last 10s is treated as mid-run. (Idle-but-open terminals are fine:
  // checkoutRef additionally requires a clean tree, and TUIs redraw on fs
  // changes gracefully.)
  const busy = ptyManager.list().find((p) =>
    (p.cwd === cwd || p.cwd.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)) &&
    Date.now() - p.lastOutputAt < 10_000
  );
  if (busy) {
    return { ok: false, error: `an agent is actively working in this repo (${busy.id}) — try again when it goes quiet` };
  }
  return checkoutRef(cwd, ref, detach === true);
});

// ─── IPC: roster mirror (shared between dev and a packaged build) ───────────
// The renderer's store is built synchronously at module load, before any async
// IPC could resolve, so the read is `ipcMain.on` + `returnValue` — one blocking
// round trip at boot, in exchange for the roster being correct on first paint
// instead of flashing an empty floor and then filling in.
// (`roster` itself is constructed earlier so HookServer can read standing goals.)
ipcMain.on('roster:readSync', (evt) => { evt.returnValue = roster.read(); });
ipcMain.on('config:homeSync', (evt) => { evt.returnValue = readConfig().harnessHome ?? null; });
ipcMain.handle('roster:read', () => roster.read());
// ─── F8 feedback board (shared/feedbackBoard.ts) ────────────────────────────
// Reports the puller writes to <harnessHome>/hive/feedback/<game>/<msg-id>/.
const FEEDBACK_THUMB_WIDTH = 320;
function feedbackRoot(): string | null {
  const home = readConfig().harnessHome;
  return home ? join(home, 'hive', 'feedback') : null;
}
function feedbackReports(): FeedbackReport[] {
  const root = feedbackRoot();
  return root ? listFeedbackReports(root) : [];
}
/** Reports for the desktop panel: the screenshot rides along as a small data URL. */
function feedbackForDesktop(): Array<FeedbackReport & { thumb?: string }> {
  return feedbackReports().map((r) => {
    let thumb: string | undefined;
    try {
      if (r.screenshotPath) thumb = nativeImage.createFromPath(r.screenshotPath).resize({ width: FEEDBACK_THUMB_WIDTH }).toDataURL();
    } catch { /* no thumbnail; the text still shows */ }
    return { ...r, thumb };
  });
}
/** 'boss' (or empty) assigns the card to the god; a card exists once addTask lands, and only then is the report marked handled. */
function sendFeedback(reportId: string, agentId: string, note?: string): { ok: boolean; error?: string } {
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const report = feedbackReports().find((r) => r.id === reportId);
  if (!report?.dir) return { ok: false, error: 'report not found' };
  const reg = hive.registry();
  const assignee = !agentId || agentId === 'boss' ? (reg.godId ?? 'god') : agentId;
  const payload = createFeedbackCardPayload(report, assignee, note ?? report.note);
  const card = {
    id: `feedback-${report.game.toLowerCase()}-${report.id}`,
    title: payload.title,
    description: payload.description,
    assignee: payload.assignee,
    project: payload.project,
    status: payload.status,
    dependsOn: [],
    priority: DEFAULT_PRIORITY,
    createdAt: new Date().toISOString()
  } as unknown as HiveTask;
  if (!hive.addTask(card)) return { ok: false, error: 'could not add the card (it may already exist)' };
  dismissFeedbackReport(report.dir, { cardId: card.id, assignee });
  return { ok: true };
}
function saveNote(reportId: string, note: string): { ok: boolean; error?: string } {
  const report = feedbackReports().find((r) => r.id === reportId);
  if (!report?.dir) return { ok: false, error: 'report not found' };
  return saveFeedbackNote(report.dir, note) ? { ok: true } : { ok: false, error: 'could not save the note' };
}
function dismissFeedback(reportId: string): { ok: boolean; error?: string } {
  const report = feedbackReports().find((r) => r.id === reportId);
  if (!report?.dir) return { ok: false, error: 'report not found' };
  return dismissFeedbackReport(report.dir) ? { ok: true } : { ok: false, error: 'could not write the marker' };
}
ipcMain.handle('feedback:list', () => feedbackForDesktop());
ipcMain.handle('feedback:send', (_evt, reportId: unknown, agentId: unknown, note: unknown) =>
  typeof reportId === 'string' && typeof agentId === 'string' ? sendFeedback(reportId, agentId, typeof note === 'string' ? note : undefined) : { ok: false, error: 'invalid request' });
ipcMain.handle('feedback:saveNote', (_evt, reportId: unknown, note: unknown) =>
  typeof reportId === 'string' && typeof note === 'string' ? saveNote(reportId, note) : { ok: false, error: 'invalid request' });
ipcMain.handle('feedback:dismiss', (_evt, reportId: unknown) =>
  typeof reportId === 'string' ? dismissFeedback(reportId) : { ok: false, error: 'invalid request' });

// ─── Phone view (phone.ts) ──────────────────────────────────────────────────
// Served only on the Tailscale address; retried until one exists, since
// tailscaled can come up after the app.
const PHONE_TOKEN_KV = 'phone.token';
let phoneUrl: string | null = null;
function phoneToken(): string {
  let t = persist.getKv<string>(PHONE_TOKEN_KV);
  if (typeof t !== 'string' || t.length < 32) { t = newPhoneToken(); persist.setKv(PHONE_TOKEN_KV, t); }
  return t;
}
const USAGE_LINE_TTL_MS = 60_000;
let usageLines: { at: number; lines: Record<string, string> } = { at: 0, lines: {} };
let usageLinesPending = false;
/** Per-agent "1.5M agy · 250k codex" lines for the last 7 days; the scan runs off the caller's path and the last result is served meanwhile. */
function agentUsageLines(): Record<string, string> {
  if (!usageLinesPending && Date.now() - usageLines.at > USAGE_LINE_TTL_MS && hive.enabled()) {
    usageLinesPending = true;
    gatherUsageLedger({ hiveRoot: hive.root() ?? undefined, ...userUsageHomes() })
      .then((rows) => {
        const byAgent = new Map<string, typeof rows>();
        for (const r of rows) byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r]);
        const lines: Record<string, string> = {};
        for (const [id, rs] of byAgent) { const l = formatAgentUsage7d(rs); if (l) lines[id] = l; }
        usageLines = { at: Date.now(), lines };
      })
      .catch((e) => console.warn('[usage] 7-day gather failed', e))
      .finally(() => { usageLinesPending = false; usageLines.at ||= Date.now(); });
  }
  return usageLines.lines;
}
ipcMain.handle('hive:agentUsage7d', () => agentUsageLines());

function phoneState(): unknown {
  const st = publishedState() as { agents?: { id: string }[] } | null;
  if (!st?.agents) return st;
  const lines = agentUsageLines();
  return { ...st, agents: st.agents.map((a) => (lines[a.id] ? { ...a, usage7dLine: lines[a.id] } : a)) };
}

/** The pty behind an agent id: a hive worker's mapped pty, else the floor agent's pty-<id>. */
function phonePty(agentId: string): string {
  return ptyForAgent(agentId) ?? `pty-${agentId}`;
}

function ensurePhoneServer(): void {
  if (phoneUrl) return;
  const started = startPhoneServer({
    pagePath: () => readConfig().campPhonePagePath,
    token: phoneToken,
    state: phoneState,
    activity: (id) => ({ actionSince: actionSince(id), lastOutputAt: ptyManager.lastOutputAt(phonePty(id)) }),
    transcript: (id) => ptyManager.scrollback(phonePty(id)),
    tasks: () => hive.tasks(),
    patchTask: (id, patch) => hive.enabled() && hive.patchTask(id, patch as Partial<Omit<HiveTask, 'id'>>),
    markResultsSeen: () => (hive.enabled() ? hive.markResultsSeen() : 0),
    sendToGod: (subject, body) => { if (hive.enabled()) hive.send({ to: 'god', act: 'inform', subject, body }, 'human'); },
    routeAnswer: (taskId, q, a) => { if (hive.enabled()) hive.routeHumanAnswer(taskId, q, a); },
    enqueue: enqueueToPrimary,
    roots: () => {
      const c = readConfig();
      const home = c.harnessHome;
      const cwds = ((publishedState() as { agents?: { cwd?: string }[] } | null)?.agents ?? [])
        .map((a) => a.cwd).filter((x): x is string => typeof x === 'string' && !!x);
      return [...new Set([...(home ? [`${home}/hive`, home] : []), ...(c.registeredRepos ?? []), ...cwds])];
    },
    limits: () => formatAllLimits({
      claude: readClaudeLimits(),
      codex: readCodexLimits(),
      agy: readLastAgyQuota(),
    }, Date.now(), parseReservations(readConfig().reservations)),
    feedback: () => feedbackReports().map((r) => ({ ...r, dir: undefined, handled: undefined })),
    sendFeedback,
    saveFeedbackNote: saveNote,
    dismissFeedback,
    modelChoices: async (id, refresh) => {
      if (refresh) await runtimeModelCatalog();
      const a = [...limitRosterAgents().live, ...limitRosterAgents().dormant].find((x) => x.id === id);
      if (!a) return null;
      const label = (e: AgentModelEntry) => ({ provider: e.provider, ...(e.model ? { model: e.model } : {}), label: entryLabel(e) });
      return { current: label(a.current), choices: switchChoices(id).map(label) };
    },
    switchModel: (id, entry, confirmBoss) => modelSwitcher.switchAgentModel(id, entry as AgentModelEntry, 'phone', { confirmBoss }),
    modelSwitching: (id) => modelSwitcher.status(id),
    agentTier: (id) => {
      const a = [...limitRosterAgents().live, ...limitRosterAgents().dormant].find((x) => x.id === id);
      if (!a) return null;
      const unused = a.pin ? exclusionFor(id, a.isGod)(a.pin) : null;
      return {
        tier: TIER_LABEL[a.tier],
        ...(a.pin ? { pin: { provider: a.pin.provider, ...(a.pin.model ? { model: a.pin.model } : {}), label: entryLabel(a.pin), ...(unused ? { unused } : {}) } } : {})
      };
    },
    clearPin: (id) => clearAgentPin(id),
  });
  if (started) { phoneUrl = started.url; console.info(`[phone] serving on ${phoneUrl}`); }
}
ipcMain.handle('phone:link', () => (phoneUrl ? `${phoneUrl}#${phoneToken()}` : null));

// Per-agent provider effort (see shared/effort.ts). Main owns it so every
// spawn path picks it up in one place; the renderer only reads and sets it.
const AGENT_EFFORT_KV = 'agent.effort';
function effortMap(provider = 'claude'): Record<string, EffortLevel> {
  try {
    const m = persist.getKv(provider === 'codex' ? 'agent.codexEffort' : AGENT_EFFORT_KV);
    return m && typeof m === 'object' ? m as Record<string, EffortLevel> : {};
  } catch { return {}; }
}
function agentEffort(id: string, provider = 'claude'): EffortLevel | undefined {
  if (provider !== 'claude' && provider !== 'codex') return undefined;
  const e = effortMap(provider)[id];
  return isEffortLevel(e) ? e : undefined;
}
/** Each agent's difficulty at its last fresh start, so a resumed session keeps the
 *  effort it was launched at rather than taking the cards open now. */
const SESSION_DIFFICULTY_KV = 'agent.sessionDifficulty';
function sessionDifficulties(): Record<string, Difficulty> {
  try {
    const m = persist.getKv(SESSION_DIFFICULTY_KV);
    return m && typeof m === 'object' ? m as Record<string, Difficulty> : {};
  } catch { return {}; }
}
/** The agent's next open card, the one a fresh start works on. */
function forCardOf(agentId: string): { id: string; sendBacks?: number; escalation?: Escalation } | undefined {
  const next = openCards(agentId, tasksOf(hive.tasks()) as NudgeCard[])[0] as { id?: string; sendBacks?: number; difficulty?: unknown; escalation?: unknown } | undefined;
  if (!next?.id) return undefined;
  const escalation = cardEscalation(next);
  return { id: next.id, sendBacks: next.sendBacks, ...(escalation ? { escalation } : {}) };
}
/** The card the fresh start prompt will name first owns this session's difficulty. */
function cardDifficulty(agentId: string): Difficulty | undefined {
  const next = openCards(agentId, tasksOf(hive.tasks()) as NudgeCard[])[0];
  return isDifficulty(next?.difficulty) ? next.difficulty : undefined;
}
/** The card the fresh start prompt will name first owns this session's work kind. */
function cardKind(agentId: string): WorkKind | undefined {
  const next = openCards(agentId, tasksOf(hive.tasks()) as NudgeCard[])[0];
  return isWorkKind(next?.kind) ? next.kind : undefined;
}
/** Effort for a spawn: a fresh one takes `requested` (a spawn-request's) or the agent's
 *  next open card and records it; a resume reuses what its fresh start recorded. */
function spawnEffort(id: string, provider: string, model: string | undefined, fresh: boolean, requested?: Difficulty): EffortLevel | undefined {
  const level = spawnEffortUnrecorded(id, provider, model, fresh, requested);
  spawnedEffort.set(id, level ?? 'default');
  return level;
}
/** The effort each session last launched at, for the ledger rows written after the spawn. */
const spawnedEffort = new Map<string, string>();
function spawnEffortUnrecorded(id: string, provider: string, model: string | undefined, fresh: boolean, requested?: Difficulty): EffortLevel | undefined {
  const own = agentEffort(id, provider);
  const map = sessionDifficulties();
  if (!fresh) return difficultyEffort(map[id], provider, model, own);
  const d = requested ?? cardDifficulty(id);
  if (map[id] !== d) {
    if (d) map[id] = d; else delete map[id];
    try { persist.setKv(SESSION_DIFFICULTY_KV, map); } catch { /* DB best-effort */ }
  }
  return difficultyEffort(d, provider, model, own);
}
/** The model a spawn's argv selects, through the provider's model flag. */
function spawnModelArg(provider: string, args: readonly string[] | undefined): string | undefined {
  const flag = providerPreset(provider as AgentProvider).modelFlag;
  const at = flag && args ? args.indexOf(flag) : -1;
  return at >= 0 ? args?.[at + 1] : undefined;
}
ipcMain.handle('agent:getEfforts', (_evt, provider = 'claude') => effortMap(provider));
ipcMain.handle('agent:setEffort', (_evt, id: unknown, effort: unknown, provider = 'claude') => {
  if (typeof id !== 'string' || !id) return false;
  if (provider !== 'claude' && provider !== 'codex') return false;
  const map = effortMap(provider);
  if (isEffortLevel(effort)) map[id] = effort; else delete map[id];
  try { persist.setKv(provider === 'codex' ? 'agent.codexEffort' : AGENT_EFFORT_KV, map); return true; } catch { return false; }
});

ipcMain.handle('roster:write', (evt, snap: unknown) => {
  if (isDesktopSender(evt.sender)) return { ok: true, skipped: 'desktop mirror' };
  const res = roster.write(snap);
  if (res.ok) syncDormancyWithRoster(false);
  return res;
});

// ─── IPC: hive (multi-agent coordination) ───────────────────────────────────
ipcMain.handle('hive:registry', () => hive.registry());
ipcMain.handle('hive:renameAgent', (_evt, id: unknown, name: unknown) => {
  if (typeof id !== 'string' || typeof name !== 'string') {
    return { ok: false, error: 'Invalid rename request' };
  }
  return hive.renameAgent(id, name);
});
ipcMain.handle('hive:setCodexSandbox', (_evt, id: unknown, level: unknown) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Invalid sandbox request' };
  return hive.setCodexSandbox(id, level);
});
ipcMain.handle('hive:getWorkspace', (_evt, id: unknown) =>
  typeof id === 'string' && id ? hive.workspaceOf(id) : null);
ipcMain.handle('hive:setWorkspace', (evt, id: unknown, patch: unknown) => {
  if (isDesktopSender(evt.sender)) return { ok: false, error: 'Edit the workspace from the main window' };
  if (typeof id !== 'string' || !id || !patch || typeof patch !== 'object') return { ok: false, error: 'Invalid workspace request' };
  const p = patch as { cwd?: unknown; extraDirs?: unknown; unity?: unknown; network?: unknown; mcp?: unknown };
  return hive.setWorkspace(id, { cwd: p.cwd, extraDirs: p.extraDirs, unity: p.unity, network: p.network, mcp: p.mcp });
});
ipcMain.handle('hive:getCodexSandbox', (_evt, id: unknown) =>
  typeof id === 'string' && id ? hive.codexSandboxOf(id) : null);
ipcMain.handle('hive:setAgentHold', (_evt, id: unknown, hold: unknown) => {
  if (typeof id !== 'string' || typeof hold !== 'boolean') {
    return { ok: false, error: 'Invalid hold request' };
  }
  if (hold) todoNudger.cancel(id);
  return hive.setAgentHold(id, hold);
});
ipcMain.handle('hive:board', () => hive.board());
ipcMain.handle('hive:tasks', () => hive.tasks());
ipcMain.handle('hive:bossNudgeDelivered', (_evt, agentId: unknown, ids: unknown) => {
  if (agentId !== 'god' || !Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return;
  const messageIds = [...new Set(ids)];
  hive.appendLog({ kind: 'boss-inbox-nudge', agentId, messageCount: messageIds.length, messageIds });
});
ipcMain.handle('hive:log', (_evt, n: unknown) => hive.logTail(typeof n === 'number' ? n : 200));
ipcMain.handle('hive:memory', (_evt, id: unknown) => (typeof id === 'string' ? hive.memory(id) : ''));
ipcMain.handle('hive:inbox', (_evt, id: unknown) => (typeof id === 'string' ? hive.inbox(id) : []));
// The Boss wakes a dormant agent by id: <hive>/wake-requests/<agentId>.json,
// optionally {"reason": "..."}. The primary renderer polls this and spawns what
// it returns through useRestoreTeam, so the restore spawn recipe and worktree
// handling apply. Every claimed file leaves the queue: .done/ when handed over
// or already live, .failed/ (with an `error` field) when it names no worker.
ipcMain.handle('hive:takeWakeRequests', (evt): Array<{ id: string; reason?: string }> => {
  const root = hive.root();
  // Left queued: a worker woken now would only be told to stop. The next poll after closing time takes them.
  if (!root || isDesktopSender(evt.sender) || closingTime.isActive()) return [];
  const dir = join(root, 'wake-requests');
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const reg = hive.registry();
  const out: Array<{ id: string; reason?: string }> = [];
  for (const f of files) {
    const id = f.slice(0, -'.json'.length);
    const file = join(dir, f);
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
    } catch { /* an empty or non-JSON file still names the agent */ }
    const a = reg.agents[id];
    // Left in place while the agent waits at a spent limit; the next poll after the reset takes it.
    if (limitWaits.has(id)) continue;
    const error = !a ? 'unknown agent id'
      : a.isGod || a.isAssistant ? 'not a worker'
        : a.archived ? 'agent is archived (its tab was closed), not dormant; the human can reopen it'
          : null;
    try {
      const sub = join(dir, error ? '.failed' : '.done');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, f), JSON.stringify({ ...body, ...(error ? { error } : {}), handledAt: new Date().toISOString() }, null, 2));
      unlinkSync(file);
    } catch (e) {
      console.error('[wake] could not file request', f, e);
      continue;
    }
    hive.appendLog({ kind: 'wake-request', agentId: id, ...(error ? { error } : {}) });
    if (error || ptyForAgent(id)) continue;
    crashTracker.clear(id);
    jailRefusals.release(id);
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined;
    hive.noteWakeReason(id, reason);
    out.push({ id, ...(reason ? { reason } : {}) });
  }
  return out;
});
// Voice read-layer: recent message CONTENT (inbox/outbox bodies), REDACTED
// main-side by hive.voiceMessages(). The renderer/voice layer never sees a raw
// body — secrets are stripped here, before the result crosses IPC.
ipcMain.handle('hive:messages', (_evt, opts: unknown) =>
  hive.voiceMessages(opts && typeof opts === 'object' ? (opts as Parameters<typeof hive.voiceMessages>[0]) : {})
);
ipcMain.handle('hive:send', (_evt, partial: Partial<HiveMessage>, from: unknown) => {
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const sender = typeof from === 'string' ? from : 'system';
  const msg = hive.send(partial ?? {}, sender);
  // Count only what a PERSON sent. Every renderer surface that dispatches on a
  // human's behalf passes 'human' (Command Center dispatch, thread replies, ASK
  // ME answers); agent-to-agent traffic passes the agent id and would swamp the
  // number. Counted AFTER the send so a rejected message is never counted.
  if (sender === 'human') analytics.trackMessageSent('hive');
  return { ok: true, message: msg };
});
ipcMain.handle('hive:humanAnswer', (_evt, taskId: unknown, q: unknown, a: unknown) => {
  if (typeof taskId !== 'string' || typeof q !== 'string' || typeof a !== 'string' || !a.trim()) return { ok: false, error: 'invalid answer' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const routed = hive.routeHumanAnswer(taskId, q, a.trim());
  analytics.trackMessageSent('hive');
  return { ok: true, ...routed };
});
ipcMain.handle('hive:resultReply', (_evt, cardId: unknown, resultAt: unknown, reply: unknown) => {
  if (typeof cardId !== 'string' || typeof resultAt !== 'string' || typeof reply !== 'string' || !reply.trim()) return { ok: false, error: 'invalid reply' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const routed = hive.replyToResult(cardId, resultAt, reply);
  if (routed.ok) analytics.trackMessageSent('hive');
  return routed;
});
ipcMain.handle('hive:resultFollowUp', (_evt, cardId: unknown, resultAt: unknown, note: unknown) => {
  if (typeof cardId !== 'string' || typeof resultAt !== 'string' || (note !== undefined && typeof note !== 'string')) return { ok: false, error: 'invalid follow-up' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return hive.followUpFromResult(cardId, resultAt, note ?? '');
});
ipcMain.handle('hive:addTask', (_evt, task: unknown) => {
  if (!task || typeof task !== 'object' || Array.isArray(task)
    || typeof (task as { id?: unknown }).id !== 'string') {
    return { ok: false, error: 'invalid task' };
  }
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return { ok: hive.addTask(task as HiveTask) };
});
ipcMain.handle('hive:patchTask', (_evt, id: unknown, patch: unknown) => {
  if (typeof id !== 'string' || !id || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'invalid task patch' };
  }
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return { ok: hive.patchTask(id, patch as Partial<Omit<HiveTask, 'id'>>) };
});
ipcMain.handle('hive:markResultsSeen', () => {
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return { ok: true, count: hive.markResultsSeen() };
});
ipcMain.handle('hive:deleteTask', (_evt, id: unknown) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid task id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return { ok: hive.deleteTask(id) };
});
ipcMain.handle('hive:setArchived', (_evt, id: unknown, archived: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  hive.setArchived(id, archived === true);
  // The renderer's archive handler moves the agent off the live or dormant list, so mail cannot wake it.
  if (archived === true) { try { liveWebContents()?.send('hive:agentArchived', { id }); } catch { /* window torn down */ } }
  return { ok: true };
});
ipcMain.handle('hive:patchAgentRole', (_evt, id: unknown, role: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (typeof role !== 'string') return { ok: false, error: 'invalid role' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return hive.patchAgentRole(id, role);
});

// ─── IPC: Settings hero payload (remote data, cached) ───────────────────────
/** Plan copy and sponsor, fetched from the repo so they can change without a
 *  release. Validated in shared/heroPayload before it reaches the renderer. */
ipcMain.handle('hero:payload', async (_evt, force: unknown) =>
  loadHero(join(app.getPath('userData'), 'hero.json'), { force: force === true }));

// ─── IPC: model catalog (runtime data, re-read per picker open) ─────────────
/** Each distinct catalog error is logged once, not on every picker open. */
const loggedCatalogErrors = new Set<string>();
function runtimeCatalogSources() {
  const repo = process.env.CAMP_REPO_PATH;
  return {
    baked: modelCatalogData,
    catalogPath: repo ? join(repo, 'src', 'shared', 'modelCatalog.json') : null,
    codexModelsPath: join(homedir(), '.codex', 'models_cache.json'),
    log: (message: string) => {
      if (loggedCatalogErrors.has(message)) return;
      loggedCatalogErrors.add(message);
      console.error(`[model-catalog] ${message}`);
      try { hive.appendLog({ kind: 'model-catalog-error', message }); } catch { /* best-effort */ }
    }
  };
}

// Switch validation also runs synchronously. Use the listing the pickers last read.
let lastAgyModelOutput: string | undefined;
let agyModelsInFlight: Promise<string> | null = null;
function readAgyModels(): Promise<string> {
  agyModelsInFlight ??= new Promise<string>((resolve, reject) => {
    execFile(resolveCliCommand('agy'), ['models'], {
      env: { ...process.env, PATH: userShellPath() },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024
    }, (error, stdout) => {
      lastAgyModelOutput = error ? undefined : stdout;
      if (error) reject(error);
      else resolve(stdout);
    });
  }).finally(() => { agyModelsInFlight = null; });
  return agyModelsInFlight;
}

function runtimeModelCatalog() {
  return loadRuntimeModelCatalogWithAgy({ ...runtimeCatalogSources(), readAgyModels });
}
ipcMain.handle('models:catalog', async () => ({ catalog: await runtimeModelCatalog(), fetchedAt: Date.now(), stale: false }));

// ─── IPC: skills (installed locally, and the browsable catalog) ─────────────
/** Skills the CLIs on this machine can already use. Scans the registered repos
 *  plus the agent's own cwd, so a project-scoped skill shows up where it applies. */
ipcMain.handle('skills:local', (_evt, cwd: unknown): LocalSkill[] => {
  const cfg = readConfig();
  const cwds = [
    ...(typeof cwd === 'string' && cwd ? [cwd] : []),
    ...(cfg.registeredRepos ?? [])
  ];
  try {
    return listLocalSkills({ cwds, bundledDir: skillsResourceDir() });
  } catch (e) {
    console.error('[skills] local scan failed:', e);
    return [];
  }
});
/** The skills catalog, parsed from its README and cached in userData.
 *  `force` is the explicit refresh button; everything else is served from a
 *  day-old cache so opening the tab never waits on the network. */
ipcMain.handle('skills:catalog', async (_evt, force: unknown) => {
  const cachePath = join(app.getPath('userData'), 'skill-catalog.json');
  return loadCatalog(cachePath, { force: force === true });
});

/** Install one catalog skill into ~/.claude/skills. Structured refusals, never a
 *  throw: the UI distinguishes "not installable" from "install failed". */
ipcMain.handle('skills:install', async (_evt, url: unknown, name: unknown) => {
  if (typeof url !== 'string' || typeof name !== 'string') {
    return { ok: false as const, error: 'bad request' };
  }
  return installSkill(url, name);
});
/** Delete an installed skill. The guard rails live in uninstallSkill — it refuses
 *  any path it cannot prove is a skill folder inside a skills root. */
ipcMain.handle('skills:uninstall', (_evt, path: unknown) => {
  if (typeof path !== 'string') return { ok: false as const, error: 'bad request' };
  const cfg = readConfig();
  return uninstallSkill(path, { cwds: cfg.registeredRepos ?? [] });
});
/** Reveal a skill on disk. `openExternal` is deliberately https-only, so a
 *  file:// URL cannot (and should not) be smuggled through it. */
ipcMain.handle('skills:reveal', (_evt, path: unknown) => {
  if (typeof path !== 'string' || !path.trim()) return { ok: false, error: 'bad request' };
  const skillRoots = [join(homedir(), '.claude', 'skills'), join(homedir(), '.config', 'opencode')];
  const target = resolve(path);
  const inRoot = skillRoots.some((r) => target.startsWith(resolve(r) + sep))
    || (readConfig().registeredRepos ?? []).some((c) => target.startsWith(resolve(c) + sep));
  if (!inRoot) return { ok: false, error: 'outside a managed skills directory' };
  shell.showItemInFolder(target);
  return { ok: true };
});

// ─── IPC: setup catalog (which external tools are actually here) ────────────
/**
 * Probe every catalog row against THIS machine.
 *
 * Presence is a PATH resolution, not a spawn: running each candidate to read a
 * --version would be a dozen process launches on every panel open, and several of
 * these CLIs boot a TUI when invoked bare. `resolveCommand` returns its input
 * unchanged when it finds nothing, so "resolved to a real, existing path that is
 * not just the bare name" is the found test.
 *
 * mempalace is the one row that does NOT come from PATH: the memory subsystem
 * already resolves it (including uv/pip locations PATH may not carry for a
 * Finder-launched app) and knows whether the palace is initialised, so it is
 * authoritative and reused rather than re-probed differently here.
 */
ipcMain.handle('tools:status', (): ToolStatus[] => {
  const win = process.platform === 'win32';
  const mem = (() => { try { memory.resetBinCache(); return memory.status(); } catch { return null; } })();
  return toolCatalog().map((spec): ToolStatus => {
    const installCommand = win ? spec.install.win32 : spec.install.posix;
    if (spec.id === 'mempalace') {
      return {
        ...spec,
        installCommand,
        found: !!mem?.available,
        path: mem?.bin ?? null,
        detail: mem?.available
          ? (mem.initialized ? 'palace initialised' : 'installed — palace not built yet')
          : undefined
      };
    }
    if (!spec.bin) return { ...spec, installCommand, found: false, path: null };
    let path: string | null = null;
    try {
      const resolved = resolveCliCommand(spec.bin);
      if (resolved !== spec.bin && existsSync(resolved)) path = resolved;
    } catch { /* a probe must never take the panel down */ }
    return { ...spec, installCommand, found: !!path, path };
  });
});

// ─── IPC: semantic memory (MemPalace CLI) ───────────────────────────────────
// refresh() = resetBinCache + an idempotent start(). The poll is the one thing
// that reliably notices mempalace being installed after boot, so it is what arms
// the mine loop that boot's start() had to skip — otherwise the pill reads
// "getting ready" until the app is restarted.
ipcMain.handle('hive:memoryStatus', () => memory.refresh());
ipcMain.handle('hive:searchMemory', (_evt, query: unknown, wing: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, output: '', error: 'empty query' };
  return memory.search(query, { wing: typeof wing === 'string' ? wing : undefined });
});
ipcMain.handle('hive:memoryWakeUp', (_evt, wing: unknown) =>
  memory.wakeUp(typeof wing === 'string' ? wing : undefined));
ipcMain.handle('hive:mineNow', () => { memory.mineNow(); return { ok: true }; });
// Condense memory.md on demand: an explicit id condenses that one agent (skips
// the size trigger — a "condense now" button); no id runs a full threshold scan.
ipcMain.handle('memory:reflectNow', (_evt, id: unknown) =>
  reflector.reflectNow(typeof id === 'string' && id ? id : undefined));

// ─── IPC: enterprise Knowledge Graph (multimodal context for agents) ─────────
ipcMain.handle('kg:status', () => knowledge.status());
ipcMain.handle('kg:list', () => knowledge.list());
ipcMain.handle('kg:search', (_evt, query: unknown, limit: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return [];
  return knowledge.search(query, typeof limit === 'number' ? limit : undefined);
});
ipcMain.handle('kg:get', (_evt, id: unknown) =>
  (typeof id === 'string' && id ? knowledge.get(id) : null));
ipcMain.handle('kg:remove', (_evt, id: unknown) =>
  ({ ok: typeof id === 'string' && id ? knowledge.remove(id) : false }));
// Ingest one or more files from disk. Best-effort per file; returns per-file
// results so the UI can report partial success.
ipcMain.handle('kg:ingestFiles', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { paths?: unknown; tags?: unknown };
  const paths = Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === 'string') : [];
  const tags = Array.isArray(p.tags) ? p.tags.filter((x): x is string => typeof x === 'string') : undefined;
  const results = paths.map((srcPath) => {
    try {
      const r = knowledge.ingestFile(srcPath, { tags });
      return { ok: true as const, srcPath, docId: r.docId, chunkCount: r.chunkCount };
    } catch (e) {
      return { ok: false as const, srcPath, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return { results };
});
// Open a multi-file picker and ingest the chosen artifacts in one round-trip.
ipcMain.handle('kg:addFiles', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: 'Add documents to the Knowledge Graph'
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  const results = res.filePaths.map((srcPath) => {
    try {
      const r = knowledge.ingestFile(srcPath);
      return { ok: true as const, srcPath, docId: r.docId, chunkCount: r.chunkCount };
    } catch (e) {
      return { ok: false as const, srcPath, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return { ok: true as const, results };
});

// ─── IPC: composer attachments (images + arbitrary files, attached by PATH) ──
// The message queue pipes raw text into a Claude CLI PTY, so attachments travel
// as a file PATH the agent reads with its Read tool (same convention as Slack).
// Picker offers an Images group + All Files.
ipcMain.handle('dialog:attachFiles', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach images or files',
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tiff', 'avif'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, files: res.filePaths.map((p) => ({ path: p, name: basename(p) })) };
});

// Persist the current native clipboard image to a temp PNG so a pasted
// screenshot can be attached by PATH. Returns an error result when the
// clipboard holds no image (e.g. a normal text paste).
ipcMain.handle('clipboard:saveImage', async () => {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return { ok: false as const, error: 'no image in clipboard' };
    const dir = join(app.getPath('temp'), 'cth-pastes');
    mkdirSync(dir, { recursive: true });
    const name = `paste-${Date.now()}.png`;
    const dest = join(dir, name);
    writeFileSync(dest, img.toPNG());
    return { ok: true as const, file: { path: dest, name } };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── IPC: command history (SQLite — every prompt submitted to an agent) ──────
ipcMain.handle('history:add', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { agentId?: unknown; cwd?: unknown; text?: unknown };
  if (typeof p.agentId !== 'string' || typeof p.text !== 'string') return { ok: false, error: 'invalid args' };
  try {
    persist.addHistory({ agentId: p.agentId, cwd: typeof p.cwd === 'string' ? p.cwd : null, text: p.text });
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('history:list', (_evt, agentId: unknown, limit: unknown) =>
  persist.listHistory(
    typeof agentId === 'string' && agentId ? agentId : undefined,
    typeof limit === 'number' ? limit : undefined
  ));
ipcMain.handle('history:search', (_evt, query: unknown, limit: unknown) =>
  persist.searchHistory(typeof query === 'string' ? query : '', typeof limit === 'number' ? limit : undefined));

// ─── IPC: quit confirmation ─────────────────────────────────────────────────
/** Tear the harness down and quit. Shared by the hard "kill all & quit" path
 *  and the closing-time conclusion (after the god confirmed the floor saved). */
function teardownAndQuit(): void {
  allowQuit = true;
  configWatcher?.close();
  rosterWatcher?.close();
  // Each teardown step is best-effort: a throw here (e.g. a dying child or a
  // half-torn-down socket) must never abort the quit or pop a crash dialog.
  try { clearMissionTimers(); } catch (e) { console.error('[quit] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[quit] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[quit] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[quit] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[quit] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[quit] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[quit] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[quit] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[quit] slack.stop:', e); }
  try { stopWebhookServer(); } catch (e) { console.error('[quit] webhook.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[quit] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[quit] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[quit] persist.close:', e); }
  try { hive.stopAllProxyBridges(); } catch (e) { console.error('[quit] stopAllProxyBridges:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[quit] killAll:', e); }
  app.quit();
}
ipcMain.handle('app:confirmClose', () => {
  cancelCampShutdown();
  closingTime.cancel(); // a hard quit overrides a wrap-up in progress
  teardownAndQuit();
});
ipcMain.handle('app:cancelClose', () => {
  // The modal closes on the renderer side. The one thing main owes anybody here
  // is the truth about a restart-to-install: if this quit was one, it has just
  // been called off, and whoever is waiting on it needs to hear that rather than
  // sit disabled forever waiting for a process that is not going to die.
  abortPendingRestart();
});

// Open a new floor (independent office window). Gated by the multiWindow flag
// inside openFloor(); returns whether a window opened so a renderer button can
// reflect availability. The app-menu "New Floor" item calls openFloor() directly.
ipcMain.handle('window:newFloor', () => {
  const win = openFloor();
  return { ok: win != null };
});

// ─── IPC: closing time (graceful, data-loss-free shutdown) ──────────────────
// The third quit-dialog button. The god broadcasts closing time, every worker
// saves its memory and ACKs, the god concludes with CLOSING-TIME-COMPLETE —
// only then does the harness tear down. See closingTime.ts for the protocol.
const closingTime = new ClosingTimeController(
  hive,
  // Roster source: agents with a live PTY right now (ptyToAgent is pruned on
  // every teardown). The registry alone would include ghost workers from
  // sessions that ended with a hard quit — never archived, never able to ACK.
  () => [...new Set(ptyToAgent.values())],
  () => liveWebContents(),
  () => { setTimeout(finishClosingTime, liveTimings().closingTeardownGraceMs); },
  // #7C.2 steering — the graceful interrupt that reaches deeply busy agents
  // at their next hook boundary instead of waiting for a Stop.
  control,
  closingWorkerStatus,
  {
    saveSnapshot: (id) => {
      const s = liveSessions.get(id);
      const label = s?.provider ?? 'session';
      return writeHandoff({ id, name: hive.registry().agents[id]?.name ?? id }, label, label, undefined, 'manual');
    }
  }
);

/** MD_CAMP_INSTALL_DIR, else the folder of the `current.AppImage` launcher this app runs
 *  from, else ~/.local/share/camp. */
function deriveCampInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MD_CAMP_INSTALL_DIR) return env.MD_CAMP_INSTALL_DIR;
  if (env.APPIMAGE && basename(env.APPIMAGE) === 'current.AppImage') return dirname(env.APPIMAGE);
  return join(homedir(), '.local', 'share', 'camp');
}
const campInstallDir = deriveCampInstallDir();
let campShutdown: { complete: () => Promise<RestartResult>; cancel: () => void } | undefined;

function mailCampBoss(subject: string, body: string): void {
  hive.send({ to: 'boss', act: 'inform', subject, body }, 'harness');
}

function cancelCampShutdown(): void {
  const shutdown = campShutdown;
  campShutdown = undefined;
  shutdown?.cancel();
}

function finishClosingTime(): void {
  const shutdown = campShutdown;
  if (!shutdown) { if (!allowQuit) teardownAndQuit(); return; }
  const fail = (error: string) => {
    if (campShutdown !== shutdown) return;
    cancelCampShutdown();
    closingTime.cancel(true);
    mailCampBoss('Camp restart aborted', error);
  };
  void shutdown.complete().then((result) => {
    if (result.ok || campShutdown !== shutdown) return;
    fail(result.error);
  }, (error) => fail(String(error)));
}

function startCampRestartWatchdog(request: WatchdogRequest, root: string): Promise<PreparedWatchdog> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, 'campRestartWatchdog.js'), JSON.stringify(request), root, String(process.pid)], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], cwd: homedir(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    const timer = setTimeout(() => fail(new Error('Camp watchdog did not become ready.')), 5_000);
    const fail = (error: Error): void => {
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(new Error(`Camp watchdog exited before startup (${signal ?? code}).`)));
    child.once('message', (message) => {
      if (message !== 'ready') { fail(new Error('Camp watchdog startup was invalid.')); return; }
      clearTimeout(timer);
      child.removeAllListeners('exit');
      child.removeListener('error', fail);
      child.on('error', (error) => console.error('[camp-restart] watchdog:', error));
      child.unref();
      resolve({
        arm: (fallback) => { child.send(fallback ? 'fallback' : 'native'); },
        cancel: () => { child.kill(); }
      });
    });
  });
}

hive.setRestartCampHook((sender, request) => {
  const root = hive.root();
  if (!root || allowQuit || closingTime.isActive()) return { ok: false, error: 'Camp is already closing.' };
  const maintenanceBlockers = (): string[] => {
    const reasons: string[] = [];
    if (campActivityInProgress(root, 'merge')) reasons.push('A merge is in progress.');
    if (campBuildQueue?.isBuilding() || campBuildLocked(campInstallDir)) reasons.push('An autobuild is in progress.');
    return reasons;
  };
  const controller = new CampRestartController({
    platform: process.platform, packaged: app.isPackaged, appImage: process.env.APPIMAGE,
    installDir: campInstallDir, oldSha: readCampBuildSha(app.getAppPath()), args: process.argv.slice(1),
    getBlockers: () => {
      const activeWorkers = ptyManager.list().flatMap(({ id, pid }) => {
        const agent = ptyToAgent.get(id);
        if (!agent || agent === sender || !pid || !isAlive(pid) || todoNudger.isIdle(agent)) return [];
        return [agent];
      });
      return [...new Set(activeWorkers)].map((id) => `${id} is mid-step.`).concat(maintenanceBlockers());
    },
    relaunch: (params) => app.relaunch(params),
    startWatchdog: (payload) => startCampRestartWatchdog(payload, root),
    teardownAndQuit,
    beginShutdown: (complete, cancel) => {
      const release = beginCampActivity(root, 'restart');
      try {
        const blockers = request.force ? [] : maintenanceBlockers();
        if (blockers.length) { release(); return { ok: false, error: blockers.join(' ') }; }
        todoNudger.cancelAll();
        const result = closingTime.start('restart');
        if (!result.ok) { release(); return { ok: false, error: result.error ?? 'Wrap-up could not start.' }; }
        process.once('exit', release);
        campShutdown = {
          complete: async () => {
            const blockers = request.force ? [] : maintenanceBlockers();
            return blockers.length ? { ok: false, error: blockers.join(' ') } : complete();
          },
          cancel: () => { process.removeListener('exit', release); release(); cancel(); }
        };
        return { ok: true };
      } catch (error) { release(); throw error; }
    }
  });
  return controller.request(request);
});

/** Whether a worker can still answer the wrap-up brief. Frozen = mid-turn (not at its
 *  prompt) yet silent past the stall window; STALLED = the standup's stalled rule. */
function closingWorkerStatus(id: string): WorkerStatus {
  const row = ((hive.fleet() as { agents?: Array<{ id?: string; lastActiveSecAgo?: number | null }> } | null)?.agents ?? []).find((a) => a.id === id);
  const silentSecAgo = typeof row?.lastActiveSecAgo === 'number' ? row.lastActiveSecAgo : undefined;
  const ptyId = ptyForAgent(id);
  const pid = ptyId ? ptyManager.list().find((p) => p.id === ptyId)?.pid : undefined;
  const session = liveSessions.get(id);
  const observation = { silentSecAgo, provider: session?.provider };
  if (!session || !pid || !isAlive(pid)) return { canAnswer: false, dead: true, reason: 'no live process', ...observation };
  const cwd = session.cwd ? statSync(session.cwd, { throwIfNoEntry: false }) : undefined;
  if (!cwd?.isDirectory()) return { canAnswer: false, dead: true, reason: 'invalid working directory (cwd)', ...observation };
  if (limitWaits.has(id)) return { canAnswer: false, reason: 'out of usage quota', ...observation };
  const stallSec = liveTimings().stallAfterMs / 1000;
  if (stalledAgents(hive.fleet(), hive.tasks(), stallSec).has(id)) return { canAnswer: false, stalled: true, reason: 'STALLED', ...observation };
  if (silentSecAgo !== undefined && silentSecAgo > stallSec && !todoNudger.isIdle(id)) return { canAnswer: false, frozen: true, reason: 'frozen', ...observation };
  return { canAnswer: true, ...observation };
}
ipcMain.handle('app:closeWithoutWorkers', (_evt, ids: unknown) => {
  if (!Array.isArray(ids)) return;
  closingTime.closeWithout(ids.filter((x): x is string => typeof x === 'string'));
});
hive.setRoutedObserver((msg, targets) => {
  closingTime.onRouted(msg, targets);
  if (msg.from) {
    if (msg.act === 'done') todoNudger.noteDone(msg.from);
    else todoNudger.noteWork(msg.from);
  }
});
// Broadcasts reach only these agents (plus dormant ones on an includeDormant opt-in).
hive.setLiveAgentSource(() => [...new Set(ptyToAgent.values())]);
hive.setClosingTimeSource(() => closingTime.isActive());
hive.setModelTiersSource(() => parseModelTiers(readConfig().modelTiers));
hive.setApprovedMergeDeps({ cleanup: () => readConfig().harnessMergeCleanup === true });
hive.setCardPatchGate((sender, cardId, patch, ledger) => {
  const f = todoNudgeFacts(sender);
  if (!f.eligible || !f.canClose) return null;
  const allowed = todoNudger.mayWork(sender, cardId, openCards(sender, tasksOf(ledger) as NudgeCard[]));
  if (allowed || patch.status !== 'doing') return null;
  hive.appendLog({ kind: 'card-start-refused', agentId: sender, card: cardId });
  return `${cardId} starts in a fresh session. Do not work on it here: move any card still in doing on as usual, then end your turn. The harness closes this session and starts you fresh on ${cardId}. If you are reading this in that fresh session, ignore it.`;
});
ipcMain.handle('app:startClosingTime', async () => {
  todoNudger.cancelAll();
  if (!closingTime.isActive()) await parkIdleWorkers();
  return closingTime.start();
});

/** Closing time puts idle workers with no open card to sleep before the Boss's brief,
 *  so none spends a turn on its last card's context only to ACK. The renderer answers
 *  each request; one it refuses (a draft or queued message) gets the brief as usual. */
const pendingIdleParks = new Map<string, (parked: boolean) => void>();
const IDLE_PARK_WAIT_MS = 3_000;

function idleParkable(agentId: string): boolean {
  return todoNudger.isIdle(agentId) && closingTimeParkable(todoNudgeFacts(agentId), true);
}

async function parkIdleWorkers(): Promise<string[]> {
  const wc = liveWebContents();
  if (!wc) return [];
  const ids = [...new Set(ptyToAgent.values())].filter(idleParkable);
  const parked = await Promise.all(ids.map((agentId) => new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { pendingIdleParks.delete(agentId); resolve(false); }, IDLE_PARK_WAIT_MS);
    pendingIdleParks.set(agentId, (ok) => { clearTimeout(timer); pendingIdleParks.delete(agentId); resolve(ok); });
    try { wc.send('hive:idleParkDue', { agentId }); } catch { pendingIdleParks.get(agentId)?.(false); }
  })));
  return ids.filter((_, i) => parked[i]);
}

ipcMain.handle('hive:idlePark', (evt, agentId: unknown, refuse: unknown): boolean => {
  if (typeof agentId !== 'string' || isDesktopSender(evt.sender)) return false;
  const done = pendingIdleParks.get(agentId);
  if (!done) return false;
  const ptyId = ptyForAgent(agentId);
  if (refuse === true || !ptyId || !idleParkable(agentId)) { done(false); return false; }
  ptyManager.kill(ptyId);
  teardownPty(ptyId, { dormant: true });
  hive.appendLog({ kind: 'closing-time-auto-ack', agentId });
  done(true);
  return true;
});
ipcMain.handle('app:cancelClosingTime', () => {
  if (closingTime.cancel()) {
    const wasRestarting = Boolean(campShutdown);
    cancelCampShutdown();
    if (wasRestarting) mailCampBoss('Camp restart cancelled', 'The operator cancelled wrap-up.');
  }
});
/** closingTime's wake mode, plus 'skip' while a worker closes for a new card first. */
function wakeModeFor(agentId: string): ReturnType<typeof closingTime.wakeMode> {
  const mode = closingTime.wakeMode(agentId);
  if (mode === 'normal' && crashTracker.held(agentId)) return 'skip';
  if (mode === 'normal' && jailRefusals.held(agentId, forCardOf(agentId)?.id)) return 'skip';
  return mode === 'normal' && todoNudger.holdMail(agentId) ? 'skip' : mode;
}

/** A model change from the panel starts a fresh session; leave it the same handoff note a
 *  limit switch writes, so the work in flight carries over. Call before the old PTY dies. */
ipcMain.handle('hive:switchHandoff', async (_evt, id: unknown, from: unknown, to: unknown) => {
  if (typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string') return false;
  const name = hive.registry().agents[id]?.name ?? id;
  await writeHandoff({ id, name }, from, to, undefined, 'manual');
  return true;
});

ipcMain.handle('hive:wakeMode', (_evt, id: unknown) => (typeof id === 'string' ? wakeModeFor(id) : 'normal'));

/** The renderer could not start a worker a wake request named: refile it under .failed/ with
 *  the reason, so the Boss sees a refusal instead of a .done that started nothing. */
ipcMain.handle('hive:wakeRequestFailed', (_evt, id: unknown, reason: unknown) =>
  typeof id === 'string' && hive.failWakeRequest(id, typeof reason === 'string' ? reason : 'the worker could not be started'));

// ─── IPC: full reset (wipe data + config, relaunch into onboarding) ──────────
ipcMain.handle('app:resetAll', () => {
  allowQuit = true;
  // Tear everything down first so nothing writes back into the dirs we wipe.
  try { clearMissionTimers(); } catch (e) { console.error('[reset] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[reset] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[reset] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[reset] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[reset] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[reset] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[reset] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[reset] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[reset] slack.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[reset] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[reset] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[reset] persist.close:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[reset] killAll:', e); }
  try { hive.removeExposedCodexData(); } catch (e) { console.error('[reset] removeExposedCodexData:', e); }
  // Erase the hive (Michael's + every agent's memory, inboxes, tasks, board,
  // git history) and the semantic-memory palace. Only these harness-created
  // subdirs are removed — never the user's whole harnessHome folder.
  for (const dir of [hive.root(), memory.palacePath()]) {
    if (!dir) continue;
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error('[reset] rm', dir, e); }
  }
  // The roster is the renderer's half of the same state, so it retires with the
  // hive — archived into roster-backups/ rather than deleted, and cleared as the
  // active file so re-selecting this folder later doesn't resurrect agents whose
  // sessions and memory are gone.
  try { roster.archive(); }
  catch (e) { console.error('[reset] roster.archive:', e); }
  // Back to first-run defaults, then relaunch clean so all in-memory services
  // re-bootstrap from scratch and the renderer lands on onboarding.
  resetConfig();
  app.relaunch();
  app.exit(0);
});

// ─── IPC: token telemetry (real usage + est. cost from CC transcripts) ───────
// Reconciler/fallback path: per-cwd transcript sum, now priced PER MODEL (cost
// bug #1 fixed in pricing.ts). Kept for back-compat with the existing UsageRow.
ipcMain.handle('hive:agentUsage', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? readAgentUsage(cwd) : null);
// Current context size (tokens) of an agent's LIVE session — the transcript
// path is learned from the agent's hook payloads (SessionStart fires right at
// spawn), so this works even when several agents share one cwd. Null until the
// first hook fires; a known-but-empty transcript reads as 0 so a freshly
// (re)started session zeroes the gauge instead of leaving a stale value up.
ipcMain.handle('hive:agentContext', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  const tp = hookServer.transcriptPath(agentId);
  if (!tp) return null;
  return readContextTokens(tp) ?? 0;
});
// Context the agent's live session has re-read over the last 7 days, for the
// card gauge's tooltip. Same transcript path as hive:agentContext.
const CONTEXT_READ_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
ipcMain.handle('hive:agentContextRead', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  const tp = hookServer.transcriptPath(agentId);
  if (!tp) return null;
  return readContextReadSince(tp, Date.now() - CONTEXT_READ_WINDOW_MS);
});

// A consolidated, NON-SENSITIVE per-agent directory for the voice read-layer
// (Realtime Michael's get_agent_detail / list_agents). One read that joins
// everything the office-floor sidebar + telemetry know per agent: the registry
// record (name/role/provider/cwd/status/archived/isGod/isAssistant/sessionId/
// cwdValid), live token + breaker + last-tool telemetry, and the current context
// window fill. Includes ARCHIVED agents (unlike the heartbeat's fleet.json, which
// is live-only) so Michael can speak to inactive agents — their cwd and memory
// stay reachable. PII-free: no secrets, env, or API keys ever leave main; cost is
// carried as tokens (+ a usd field the voice layer deliberately never speaks).
ipcMain.handle('hive:agentDirectory', () => {
  if (!hive.enabled()) return { godId: null, agents: [] };
  const reg = hive.registry();
  const snap = telemetry.snapshot();
  const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
  const now = Date.now();
  const agents = Object.entries(reg.agents).map(([id, a]) => {
    const u = usageById.get(id) ?? offTranscriptUsage(id, a.provider, a.sessionId);
    const spans = snap.spans[id] ?? [];
    const tokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
    const ctx = hookServer.contextFor(id);
    return {
      id,
      name: a.name,
      role: a.role ?? (a.isGod ? 'orchestrator' : 'agent'),
      provider: a.provider ?? 'claude',
      model: u?.model ?? null,
      status: a.status ?? 'idle',
      cwd: a.cwd ?? null,
      cwdValid: a.cwdValid ?? null,
      archived: !!a.archived,
      isGod: !!a.isGod,
      isAssistant: !!a.isAssistant,
      sessionId: a.sessionId ?? null,
      hasMemory: hive.hasMemory(id),
      inboxBacklog: hive.inboxBacklog(id),
      breaker: breaker.levelFor(id),
      tokens,
      usd: u ? Number(u.usd.toFixed(4)) : 0,
      lastTool: spans.length ? spans[spans.length - 1].tool : (u as { lastTool?: string | null } | undefined)?.lastTool ?? null,
      lastActiveSecAgo: u ? Math.round((now - u.ts) / 1000) : null,
      activityUnknown: activityUnknown(a.provider, u),
      contextTokens: ctx?.tokens ?? null,
      contextLimit: ctx?.limit ?? null,
      contextPct: ctx && ctx.limit > 0 ? Math.round((ctx.tokens / ctx.limit) * 100) : null
    };
  });
  return { godId: reg.godId, agents };
});

// ─── IPC: live telemetry (the OTel collector — the locked usage-provider seam) ─
// The fleet grid + span waterfall (#7B) read these; Lane A's breaker (#6)
// consumes getAgentUsage in-process via the provider, not over IPC.
ipcMain.handle('telemetry:usage', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getAgentUsage(agentId) : null);
ipcMain.handle('telemetry:spans', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getSpans(agentId) : []);
ipcMain.handle('telemetry:snapshot', () => telemetry.snapshot());

// ─── IPC: circuit-breaker state (Lane A #6 policy → this lane's avatars/meter) ─
// Lane A's breaker calls this with a BreakerState; we fan it out to the renderer
// on `control:breakerState`, where the avatar adapter gives it precedence over
// hook-derived status (#5C looping/zombie). Defined here so the channel exists
// before Jim's policy lands; he produces, this lane consumes.
ipcMain.handle('control:setBreakerState', (_evt, state: unknown) => {
  try { liveWebContents()?.send('control:breakerState', state); } catch { /* window tore down */ }
  return { ok: true };
});

// ─── IPC: operator control over agents (#7C.1–7C.3) ─────────────────────────
// All return the agent's fresh control snapshot so the UI can reflect state.
ipcMain.handle('control:pause', (_evt, agentId: unknown, on: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.pause(agentId, on === true);
  return control.snapshot(agentId);
});
ipcMain.handle('control:autoDelivery', (_evt, agentId: unknown, paused: unknown) => {
  if (typeof agentId !== 'string') return null;
  const on = paused === true;
  control.pauseAutoDelivery(agentId, on);
  const current = new Set(readConfig().autoDeliveryPausedAgents ?? []);
  if (on) current.add(agentId); else current.delete(agentId);
  writeConfig({ autoDeliveryPausedAgents: Array.from(current).sort() });
  return control.snapshot(agentId);
});
ipcMain.handle('control:resume', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.resume(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:gateTool', (_evt, agentId: unknown, tool: unknown, on: unknown) => {
  if (typeof agentId !== 'string' || typeof tool !== 'string') return null;
  control.gateTool(agentId, tool, on === true);
  return control.snapshot(agentId);
});
ipcMain.handle('control:steer', (_evt, agentId: unknown, text: unknown) => {
  if (typeof agentId !== 'string' || typeof text !== 'string') return null;
  control.steer(agentId, text);
  // A steer typed into the control strip is a human message. Counted HERE, at
  // the IPC seam, and deliberately not inside control.steer(): closingTime and
  // the voice action layer call that directly, and neither is a person typing.
  analytics.trackMessageSent('steer');
  return control.snapshot(agentId);
});
ipcMain.handle('control:halt', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.halt(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:unhalt', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.unhalt(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:snapshot', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? control.snapshot(agentId) : null);

// ─── IPC: scheduled missions (recurring auto-dispatch) ──────────────────────
ipcMain.handle('missions:list', () => readConfig().missions ?? []);
ipcMain.handle('missions:save', (_evt, missions) => {
  // lastFiredAt is scheduler-owned. The renderer loads missions once and later
  // sends back a STALE array, so a wholesale write would clobber every
  // lastFiredAt the scheduler has stamped since. Merge by id and keep the newer
  // lastFiredAt (almost always the persisted one) so the UI can never erase it.
  const incoming = (Array.isArray(missions) ? missions : []) as ScheduledMission[];
  const persistedById = new Map(
    (readConfig().missions ?? []).map((m) => [m.id, m] as const)
  );
  const merged = incoming.map((m) => {
    const prevLastFired = persistedById.get(m.id)?.lastFiredAt ?? 0;
    const lastFiredAt = Math.max(m.lastFiredAt ?? 0, prevLastFired) || undefined;
    return { ...m, lastFiredAt };
  });
  writeConfig({ missions: merged });
  syncMissions();
  return { ok: true };
});

// ─── IPC: full-text search across hive files (board, tasks, memory) ──────────
ipcMain.handle('hive:textSearch', (_evt, query: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, results: [] };
  const root = hive.root();
  if (!root) return { ok: false, results: [] };
  const q = query.toLowerCase();
  const results: Array<{ source: string; excerpt: string }> = [];
  // Each target file is (path, readable label). agents/<id>/memory.md is expanded below.
  const targets: Array<{ path: string; source: string }> = [
    { path: join(root, 'board.md'), source: 'board.md' },
    { path: join(root, 'tasks.json'), source: 'tasks.json' }
  ];
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      targets.push({ path: join(agentsDir, id, 'memory.md'), source: `${id}/memory.md` });
    }
  }
  for (const { path, source } of targets) {
    if (!existsSync(path)) continue;
    let hits = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (hits >= 3) break;
      const idx = line.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      // ~40 chars of context on either side of the match.
      const excerpt = line.slice(Math.max(0, idx - 40), idx + q.length + 40).trim();
      results.push({ source, excerpt });
      hits++;
    }
  }
  return { ok: true, results };
});

// ─── IPC: GitHub issue ingestion (gh CLI) ────────────────────────────────────
ipcMain.handle('github:issues', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listIssues(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: GitHub CI status watcher (gh CLI) ──────────────────────────────────
ipcMain.handle('github:ciRuns', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listCIRuns(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: desktop notifications toggle ──────────────────────────────────────
ipcMain.handle('app:setNotifications', (_evt, val) => writeConfig({ notifications: val === true }));

// ─── IPC: onboarding reliability — open Settings deep-link + login-item toggle ─
/** Open a System Settings deep-link (or https URL) in the OS default handler.
 *  Restricted to Settings panes / https so the renderer can't shell arbitrary
 *  schemes. macOS uses `x-apple.systempreferences:`, Windows uses `ms-settings:`
 *  (Linux has no universal settings URI, so the renderer never sends one there).
 *  Used by the onboarding "Permissions & reliability" step. */
ipcMain.handle('app:openExternal', async (_evt, url: unknown) => {
  if (typeof url !== 'string' || !/^(x-apple\.systempreferences:|ms-settings:|https:\/\/)/.test(url)) {
    return { ok: false, error: 'blocked url' };
  }
  await shell.openExternal(url);
  return { ok: true };
});
/** Toggle macOS "Open at Login" — fully programmatic, no permission prompt.
 *  Returns the resulting state so the renderer toggle reflects reality. */
ipcMain.handle('app:setLoginItem', (_evt, enabled: unknown) => {
  app.setLoginItemSettings({ openAtLogin: enabled === true });
  return app.getLoginItemSettings().openAtLogin;
});

// ─── IPC: Slack integration ─────────────────────────────────────────────────
ipcMain.handle('slack:start', () => startSlackServer());
/** Stop must survive a restart. Boot re-arms from `slackEnabled`, so stopping
 *  without clearing it silently brought the server back on the next launch —
 *  the user pressed Stop and Slack was live again.
 *
 *  Persist BEFORE tearing down. If the write throws (read-only volume, ENOSPC)
 *  the server is still up and the UI stays truthful; the other order leaves a
 *  dead server that still reads as Connected with the flag set, which is this
 *  same bug again with no error to show for it.
 *
 *  Only this handler clears the flag. changeHome / quit / reset call
 *  `stopSlackServer()` directly and must not: they are lifecycle, not a user
 *  turning the integration off. (Start persists the flag from the renderer, in
 *  `SettingsModal.startSlack`, not here.) */
ipcMain.handle('slack:stop', () => {
  writeConfig({ slackEnabled: false });
  stopSlackServer();
  return { ok: true };
});
/** Current connection state + last Request URL — lets Settings hydrate the
 *  "Connected" badge and re-show the persisted tunnel URL on reopen. */
ipcMain.handle('slack:status', () => ({ running: slackServer != null, url: lastSlackUrl }));
/** Absolute path to the bundled reply helper, for the prompt the office worker
 *  runs to post its summary back in-thread. No secret crosses this boundary. */
ipcMain.handle('slack:replyScriptPath', () => slackReplyScriptPath());
/** Renderer's immediate "queued" ack into the triggering Slack thread. The bot
 *  token stays in main — only channel/thread/text cross IPC. */
ipcMain.handle('slack:reply', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { channel?: unknown; thread_ts?: unknown; text?: unknown };
  const cfg = readConfig();
  // CLAUSE-3 (human: "stop posting into Slack by default"): this is the ONLY
  // app/voice-INITIATED proactive Slack post (the renderer's "queued" ack). It is
  // OFF unless the user opts in via Settings → Slack. The Slack-ORIGIN done-reply
  // round-trip (done-poller) and an agent's own direct /reply are NOT routed
  // through here, so they are unaffected and always stay on.
  if (!cfg.slackProactivePosting) return { ok: false, error: 'app-initiated Slack posting disabled (enable in Settings → Slack)' };
  const botToken = cfg.slackBotToken;
  if (!botToken) return { ok: false, error: 'no bot token' };
  if (typeof p.channel !== 'string' || typeof p.thread_ts !== 'string' || typeof p.text !== 'string') {
    return { ok: false, error: 'channel, thread_ts, text required' };
  }
  // CLAUSE-1 (fix-slack-integration): an app-initiated send must target an
  // EXPLICIT thread — reject a blank/whitespace channel or thread rather than
  // letting it fall through to an implicit destination (the channel root).
  if (!p.channel.trim() || !p.thread_ts.trim()) {
    return { ok: false, error: 'explicit channel + thread_ts required' };
  }
  return postSlackReply({ botToken, channel: p.channel, thread_ts: p.thread_ts, text: p.text });
});
ipcMain.handle('slack:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as {
    signingSecret?: unknown; botToken?: unknown; channelId?: unknown; port?: unknown; enabled?: unknown;
    proactivePosting?: unknown;
  };
  const next: Partial<HarnessConfig> = {};
  // Trim string fields; an emptied field clears back to undefined.
  if (typeof p.signingSecret === 'string') next.slackSigningSecret = p.signingSecret.trim() || undefined;
  if (typeof p.botToken === 'string') next.slackBotToken = p.botToken.trim() || undefined;
  if (typeof p.channelId === 'string') next.slackChannelId = p.channelId.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.slackPort = p.port;
  if (typeof p.enabled === 'boolean') next.slackEnabled = p.enabled;
  if (typeof p.proactivePosting === 'boolean') next.slackProactivePosting = p.proactivePosting;
  writeConfig(next);
  // Reconcile the running server: disabling (or clearing the secret) stops it. We
  // deliberately do NOT auto-(re)start here — the user presses Start in Settings
  // to fetch the fresh (ephemeral) tunnel URL.
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) stopSlackServer();
  return { ok: true };
});

// ─── IPC: Triggers — context (auto-compact / auto-clear) ────────────────────
ipcMain.handle('triggers:getContext', () => readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER);
ipcMain.handle('triggers:setContext', (_evt, arg: unknown) => {
  const current = readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
  const p = (arg ?? {}) as Partial<ContextTriggerConfig>;
  const next: ContextTriggerConfig = {
    compact: sanitizeContextRule(p.compact, current.compact),
    clear: sanitizeContextRule(p.clear, current.clear)
  };
  writeConfig({ contextTrigger: next });
  // The timers ARE the setting — a cadence saved but not re-armed would keep
  // firing on the old rhythm until the next boot.
  syncContextTriggers();
  return next;
});

/** Clamp one half of the context trigger. The renderer is not trusted with the
 *  arming maths: a zero/negative/NaN `everyMs` would arm a runaway timer, and an
 *  out-of-range percentage would silently disable (or permanently trip) the
 *  pressure gate. */
function sanitizeContextRule(patch: Partial<ContextRule> | undefined, current: ContextRule): ContextRule {
  const p = (patch ?? {}) as Partial<ContextRule>;
  const num = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    everyMs: num(p.everyMs, current.everyMs, 60_000, 86_400_000),
    minContextPct: num(p.minContextPct, current.minContextPct, 0, 100),
    minContextPctLargeWindow: num(p.minContextPctLargeWindow, current.minContextPctLargeWindow, 0, 100),
    ...(p.bossMinContextTokens !== undefined || current.bossMinContextTokens !== undefined
      ? { bossMinContextTokens: num(p.bossMinContextTokens, current.bossMinContextTokens ?? 0, 0, 10_000_000) }
      : {}),
    message: typeof p.message === 'string' ? p.message : current.message
  };
}

// ─── IPC: Triggers — webhooks (many endpoints, one server, one tunnel) ──────
ipcMain.handle('webhooks:list', () => readConfig().webhookTriggers ?? []);
ipcMain.handle('webhooks:save', (_evt, arg: unknown) => {
  const incoming = Array.isArray(arg) ? arg : [];
  const existing = readConfig().webhookTriggers ?? [];
  const list: WebhookTrigger[] = [];
  const seen = new Set<string>();
  for (const raw of incoming) {
    const t = sanitizeWebhookTrigger(raw, existing);
    if (!t || seen.has(t.id)) continue; // an id is a URL path segment — one owner each
    seen.add(t.id);
    list.push(t);
  }
  writeConfig({ webhookTriggers: list });
  reconcileWebhookServer();
  return list;
});
ipcMain.handle('webhooks:delete', (_evt, arg: unknown) => {
  const id = typeof arg === 'string' ? arg : '';
  const list = (readConfig().webhookTriggers ?? []).filter((t) => t.id !== id);
  writeConfig({ webhookTriggers: list });
  // Revoking one endpoint must not disturb the others: the live server is
  // re-pointed, not restarted, so every remaining caller's URL keeps working.
  reconcileWebhookServer();
  return list;
});
/** Mint a strong (256-bit) secret for the operator to paste into their caller.
 *  Not persisted here — it belongs to whichever endpoint the UI saves it onto. */
ipcMain.handle('webhooks:generateSecret', () => randomBytes(32).toString('hex'));
/** Server state + the tunnel root + one public URL per configured endpoint (the
 *  UI offers a copy button per webhook, so the root alone isn't enough). */
ipcMain.handle('webhooks:status', () => ({
  running: webhookServer != null,
  url: lastWebhookUrl,
  endpoints: webhookEndpointUrls()
}));

/** Normalise one endpoint coming back from the renderer. Unknown/blank fields
 *  fall back to what is already persisted, so a UI that round-trips a partially
 *  filled row can never blank a live secret or silently widen a mode. */
function sanitizeWebhookTrigger(raw: unknown, existing: WebhookTrigger[]): WebhookTrigger | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<WebhookTrigger>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  // The id is spliced into a public URL path. Restrict it to a boring charset
  // rather than escaping later: no slashes (which would forge a nested route),
  // no encoded traversal, nothing that could make two endpoints alias.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return null;
  const prior = existing.find((t) => t.id === id);
  const secret = typeof r.secret === 'string' && r.secret.trim() ? r.secret.trim() : prior?.secret ?? '';
  const mode = isTriggerMode(r.mode) ? r.mode : prior?.mode ?? DEFAULT_TRIGGER_MODE;
  return {
    id,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : prior?.name ?? id,
    secret,
    // A secretless endpoint can never be enabled — it would be an open door.
    enabled: secret ? (typeof r.enabled === 'boolean' ? r.enabled : prior?.enabled ?? false) : false,
    mode,
    schema: typeof r.schema === 'string' && r.schema.trim() ? r.schema : prior?.schema ?? DEFAULT_WEBHOOK_SCHEMA,
    createdAt: typeof r.createdAt === 'number' && r.createdAt > 0 ? r.createdAt : prior?.createdAt ?? Date.now()
  };
}

function isTriggerMode(v: unknown): v is TriggerMode {
  return v === 'strict' || v === 'allow-all' || v === 'communication-only';
}

// ─── IPC: Triggers — organisation (persistence only; no transport yet) ──────
ipcMain.handle('org:getTrigger', () => readConfig().orgTrigger ?? DEFAULT_ORG_TRIGGER);
ipcMain.handle('org:setTrigger', (_evt, arg: unknown) => {
  const current = readConfig().orgTrigger ?? DEFAULT_ORG_TRIGGER;
  const p = (arg ?? {}) as Partial<OrgTriggerConfig>;
  // PERSIST ONLY — the peer messaging service does not exist yet, so nothing
  // reads `apiKey` beyond the settings surface that shows it. Deliberately no
  // start/stop, no network, no side effect of any kind.
  const next: OrgTriggerConfig = {
    apiKey: typeof p.apiKey === 'string' ? p.apiKey.trim() : current.apiKey,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    mode: isTriggerMode(p.mode) ? p.mode : current.mode
  };
  writeConfig({ orgTrigger: next });
  return next;
});

// ─── IPC: Triggers — history ledger + the approval gate ─────────────────────
ipcMain.handle('triggerHistory:list', () => listTriggerHistory());
ipcMain.handle('triggerHistory:clear', (_evt, arg: unknown) => {
  const source = arg === 'webhook' || arg === 'org' ? arg : undefined;
  clearTriggerHistory(source);
  pruneHeldTokens();
  notifyTriggerHistoryUpdated();
  return { ok: true };
});
/**
 * The operator's verdict on a held message.
 *
 * 'approved' RELEASES it: it takes the identical path an auto-allowed message
 * would have taken (card + god request), then the entry flips. 'rejected' just
 * flips — nothing is ever dispatched.
 *
 * Idempotent by construction: only an entry still sitting at `pending` can be
 * decided, so a double-click (or two windows deciding at once) cannot dispatch
 * the same message twice.
 */
ipcMain.handle('triggerHistory:decide', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { id?: unknown; decision?: unknown };
  const id = typeof p.id === 'string' ? p.id : '';
  const decision = p.decision === 'approved' ? 'approved' : p.decision === 'rejected' ? 'rejected' : null;
  if (!id || !decision) return null;
  const entry: TriggerHistoryEntry | undefined = listTriggerHistory().find((e) => e.id === id);
  if (!entry) return null;
  if (entry.decision !== 'pending') return entry; // already decided → no-op, not a re-dispatch

  if (decision === 'rejected') {
    const next = updateTriggerHistory(id, { decision: 'rejected' });
    notifyTriggerHistoryUpdated();
    return next;
  }

  const taskId = `webhook-${randomBytes(8).toString('hex')}`;
  const tokenHash = heldTokenHashFor(id);
  const title = entry.title ?? (entry.body.length > 80 ? `${entry.body.slice(0, 79)}…` : entry.body);
  if (!dispatchWebhookWork({ taskId, title, message: entry.body, tokenHash, origin: entry.source })) {
    // The card is what the caller polls and what god works from. Leave the entry
    // pending so the operator can approve again once the hive is writable.
    return entry;
  }
  // The hash now lives on the card, so the caller's GET resolves through the
  // normal task lookup from here on.
  if (tokenHash) { heldTokens().delete(tokenHash); persistHeldTokens(); }
  const next = updateTriggerHistory(id, { decision: 'approved', taskId });
  pruneHeldTokens();
  notifyTriggerHistoryUpdated();
  return next;
});

// ─── IPC: Generic webhook (LEGACY single-endpoint channels) ─────────────────
// Kept alive for Settings → Webhook, which still speaks the one-secret shape.
// They are now THIN SHIMS over the multi-endpoint engine: the legacy secret and
// enabled flag map onto the `legacy` WebhookTrigger the config migration created,
// so the two surfaces can never disagree about whether the endpoint is live.
ipcMain.handle('webhook:start', () => startWebhookServer());
ipcMain.handle('webhook:stop', () => { stopWebhookServer(); return { ok: true }; });
/** Current state + last public endpoint URL, for the Settings badge/URL field. */
ipcMain.handle('webhook:status', () => ({ running: webhookServer != null, url: lastWebhookUrl }));
/** Mint a strong (256-bit) secret, persist it, and return it so Settings can show
 *  it for the user to copy into their client. The previous secret is replaced. */
ipcMain.handle('webhook:generateSecret', () => {
  const secret = randomBytes(32).toString('hex');
  writeConfig({ webhookSecret: secret });
  upsertLegacyWebhookTrigger({ secret });
  return { ok: true, secret };
});
ipcMain.handle('webhook:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as { secret?: unknown; port?: unknown; enabled?: unknown };
  const next: Partial<HarnessConfig> = {};
  if (typeof p.secret === 'string') next.webhookSecret = p.secret.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.webhookPort = p.port;
  if (typeof p.enabled === 'boolean') next.webhookEnabled = p.enabled;
  writeConfig(next);
  upsertLegacyWebhookTrigger({
    secret: typeof p.secret === 'string' ? p.secret.trim() : undefined,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined
  });
  // Disabling (or clearing the secret) stops the public surface immediately; the
  // reconcile also picks up the case where OTHER endpoints are still enabled, in
  // which case the server stays up minus the legacy one.
  reconcileWebhookServer();
  return { ok: true };
});

/** Mirror a legacy `webhook:setConfig` / `webhook:generateSecret` edit onto the
 *  `legacy` WebhookTrigger. Creates the row only once a secret exists — an
 *  enabled endpoint without a secret would be an open door, so a bare "enable"
 *  against a never-configured webhook is deliberately a no-op. */
function upsertLegacyWebhookTrigger(patch: { secret?: string; enabled?: boolean }): void {
  const list = readConfig().webhookTriggers ?? [];
  const prior = list.find((t) => t.id === 'legacy');
  const secret = patch.secret !== undefined ? patch.secret : prior?.secret ?? '';
  if (!secret) return;
  const row: WebhookTrigger = {
    id: 'legacy',
    name: prior?.name ?? 'Default webhook',
    secret,
    enabled: patch.enabled !== undefined ? patch.enabled : prior?.enabled ?? false,
    mode: prior?.mode ?? DEFAULT_TRIGGER_MODE,
    schema: prior?.schema ?? DEFAULT_WEBHOOK_SCHEMA,
    createdAt: prior?.createdAt ?? Date.now()
  };
  writeConfig({
    webhookTriggers: prior ? list.map((t) => (t.id === 'legacy' ? row : t)) : [...list, row]
  });
}

// ─── Snip to card: global hotkey → region → note → a card for the boss ─────
const snipLog = (line: string): void => {
  console.log(`[snip] ${line}`);
  try { hive.appendLog({ kind: 'snip', line }); } catch { /* no hive yet */ }
};
function notifySnipOutcome(out: SnipOutcome): void {
  if (out.status !== 'filed' && out.status !== 'failed') return;
  try {
    new Notification({ title: brandTitle(), body: out.status === 'filed' ? `Snip filed as ${out.cardId}` : `Snip not filed: ${out.error}` }).show();
  } catch { /* the log already has it */ }
}
const snipHotkey = createSnipHotkey(globalShortcut, snipLog);
const snipSession = createSnipSession(snipSessionDeps(
  createSnipWindows({ rendererUrl: isDev ? process.env.ELECTRON_RENDERER_URL : undefined, log: snipLog }),
  () => snipContextDeps(process.pid, app.getPath('home'), app.getPath('userData'), hive.root()),
  (input) => fileSnipCard(hive, input, { to: getMessageRoute('snip', readConfig(), isKnownAgent) }),
  snipLog
));
const onSnipHotkey = () => void snipSession.start().then(notifySnipOutcome);
/** Read fresh on every arm, so an applet rebinding counts without a Camp restart. */
const cinnamonBindings = () => readCinnamonBindings(join(app.getPath('home'), '.config', 'cinnamon', 'spices'));
function armSnipHotkey(): void {
  const desktop = cinnamonBindings();
  const migrated = migratedSnipHotkey(readConfig(), desktop);
  if (migrated) {
    snipLog(`snip hotkey: saved ${readConfig().snipHotkey} is an old default, moved to ${migrated}`);
    writeConfig({ snipHotkey: migrated });
  }
  if ((readConfig().snipDefaultsVersion ?? 0) < SNIP_DEFAULTS_VERSION) writeConfig({ snipDefaultsVersion: SNIP_DEFAULTS_VERSION });
  snipHotkey.arm(snipHotkeyOf(readConfig()), onSnipHotkey, desktop);
}
ipcMain.handle('snip:setHotkey', (_evt, accelerator: unknown) => {
  if (typeof accelerator !== 'string') return snipHotkey.status();
  writeConfig({ snipHotkey: accelerator.trim() });
  return snipHotkey.arm(snipHotkeyOf(readConfig()), onSnipHotkey, cinnamonBindings());
});
ipcMain.handle('snip:hotkeyStatus', () => snipHotkey.status());

// ─── IPC: Free Flow (voice dictation → message queue) ────────────────────────
// Entry point B is hold-Option-to-talk, handled entirely in the renderer
// (capture-phase key listeners) — no globalShortcut here. macOS doesn't deliver
// the Fn key to Electron (electron#16714) and a faithful native Fn helper
// (CGEventTap) is deferred; hold-Option is the human-chosen v1 activation.

ipcMain.handle('freeflow:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as { enabled?: unknown; apiKey?: unknown; model?: unknown };
  const next: Partial<HarnessConfig> = {};
  if (typeof p.enabled === 'boolean') next.freeflowEnabled = p.enabled;
  // Trim string fields; an emptied key clears back to undefined.
  if (typeof p.apiKey === 'string') next.groqApiKey = p.apiKey.trim() || undefined;
  if (typeof p.model === 'string') next.freeflowModel = p.model.trim() || DEFAULT_GROQ_MODEL;
  writeConfig(next);
  return { ok: true };
});

/** Transcribe one captured audio clip via Groq. Gated on the flag + a key being
 *  present, so a disabled feature can NEVER reach the network. The Groq key stays
 *  in main — only the audio bytes cross IPC inbound and the transcript outbound. */
ipcMain.handle('freeflow:transcribe', async (_evt, arg: unknown) => {
  const cfg = readConfig();
  if (!cfg.freeflowEnabled) return { ok: false, error: 'Free Flow is disabled' };
  if (!cfg.groqApiKey) return { ok: false, error: 'no Groq API key set' };
  const a = (arg ?? {}) as { audio?: unknown; mimeType?: unknown; filename?: unknown; language?: unknown };
  if (!(a.audio instanceof ArrayBuffer) && !(a.audio instanceof Uint8Array)) {
    return { ok: false, error: 'no audio' };
  }
  const out = await transcribeWithGroq({
    apiKey: cfg.groqApiKey,
    audio: a.audio,
    mimeType: typeof a.mimeType === 'string' ? a.mimeType : undefined,
    filename: typeof a.filename === 'string' ? a.filename : undefined,
    model: cfg.freeflowModel || DEFAULT_GROQ_MODEL,
    language: typeof a.language === 'string' && a.language ? a.language : undefined
  });
  if (out.ok) analytics.trackFeature('voice_dictation');
  return out;
});

// ─── IPC: Realtime Michael (voice orchestrator — ephemeral token mint, rt-1) ──
// MAIN owns the BYOK OpenAI key (encrypted broker, apikey:openai) and mints a
// short-lived EPHEMERAL client secret; the real key never crosses IPC. All wiring
// lives in ./realtime so this stays a single registration line.
registerRealtimeIpc();

// ─── IPC: Realtime Michael voice ACTIONS (rt-5, Phase 2) ─────────────────────
// Thin adapters over the SAME main fns the god PTY already uses. ALL of the safety
// spine — soft-vs-destructive tiering, the two-step verbal echo-back confirm, the
// distinct-token rule, the hard allowlist (kill-god / mass-ops forbidden), and the
// michael-voice attribution — lives in ./realtimeActions. This site only injects
// the existing functions; it adds NO new orchestration logic.
// ─── IPC: Realtime Michael completion watcher (rt-12, Phase 2) ───────────────
// Jim's net-new engine (realtimeCompletionWatcher.ts) detects a voice-dispatched
// task finishing (card→done OR a done-reply in michael-voice's inbox) and EMITS it;
// I own the seam — inject the hive read deps, push completions to the live session
// (so Michael speaks them unprompted), and bridge waitFor / queue-drain over IPC.
const completionWatcher = initCompletionWatcher({
  readTasks: () => { const t = hive.tasks() as { tasks?: TaskCard[] }; return Array.isArray(t?.tasks) ? t.tasks : []; },
  // Voice dispatches go out as from:michael-voice, so assignee done-replies land here.
  readInbox: () => {
    // Voice dispatches go out from:michael-voice, so done-replies normally land in its
    // inbox — but an assignee may address god out of habit. Merge both inboxes (de-dupe
    // by id) so a god-addressed completion isn't missed; the detector filters by sender.
    try {
      const mv = hive.inbox('michael-voice') as unknown as InboxMessage[];
      const godId = hive.registry().godId;
      const god = godId ? (hive.inbox(godId) as unknown as InboxMessage[]) : [];
      const seen = new Set<string>();
      return [...mv, ...god].filter((m) => !!m?.id && !seen.has(m.id) && seen.add(m.id) !== undefined);
    } catch {
      return [];
    }
  },
  onNotify: (evt) => {
    try {
      if (!Notification.isSupported()) return;
      const reg = hive.registry();
      const title = resolveGodName(reg.agents[reg.godId ?? 'god']?.name);
      new Notification({ title, body: evt.summary }).show();
    } catch { /* best-effort */ }
  }
});

registerRealtimeActionIpc({
  hiveEnabled: () => hive.enabled(),
  hiveSend: (partial, from) => hive.send(partial, from),
  hiveTasks: () => hive.tasks(),
  hiveAddTask: (task) => hive.addTask(task as HiveTask),
  hivePatchTask: (id, patch) => hive.patchTask(id, patch as Partial<Omit<HiveTask, 'id'>>),
  hiveDeleteTask: (id) => hive.deleteTask(id),
  hiveRegistry: () => hive.registry(),
  hiveLog: (event) => hive.appendLog(event),
  controlPause: (id, on) => control.pause(id, on),
  controlSteer: (id, text) => control.steer(id, text),
  controlHalt: (id) => control.halt(id),
  controlSnapshot: (id) => control.snapshot(id),
  killAgent: (id) => {
    const r = ptyManager.kill(id);
    teardownPty(id);
    // A voice (MAIN-initiated) kill: the renderer never removed the card itself
    // (unlike a UI kill), so tell the floor to archive it. Mirrors hive:agentSpawned.
    try { liveWebContents()?.send('hive:agentArchived', { id }); } catch { /* window torn down */ }
    return r;
  },
  spawnAgent: async (opts) => {
    const o = opts as AgentSpawnOptions;
    const res = await spawnAgentCore(o, null);
    // The renderer roster is only mutated by renderer-initiated hires (AddAgentModal),
    // so a MAIN-initiated spawn is invisible on the floor until we broadcast it. The
    // renderer (useHive) builds the Agent card from this descriptor; addAgent is
    // idempotent so a renderer-initiated hire is never double-carded.
    if (res.ok) {
      try {
        liveWebContents()?.send('hive:agentSpawned', {
          id: o.id,
          name: o.hive?.name ?? o.id,
          provider: o.provider ?? o.hive?.provider ?? 'claude',
          cwd: res.worktreePath ?? o.cwd,
          command: o.command,
          role: o.hive?.role,
          worktreePath: res.worktreePath
        });
      } catch { /* window torn down */ }
    }
    return res;
  },
  listMissions: () => readConfig().missions ?? [],
  // The spec carries lastFiredAt through from listMissions(), so a wholesale write
  // preserves the scheduler's stamps; edit_schedule is deliberate + rare.
  saveMissions: (missions) => { writeConfig({ missions }); },
  // rt-12: register each voice dispatch so the watcher can detect its completion.
  trackDispatch: (d) => { try { completionWatcher.track({ ...d, kind: 'dispatch' }); } catch { /* watcher unavailable */ } },
  // ── v0.3.4 full-control extensions ──
  controlResume: (id) => control.resume(id),
  controlAutoDelivery: (id, paused) => control.pauseAutoDelivery(id, paused),
  controlGateTool: (id, toolName, on) => control.gateTool(id, toolName, on),
  setArchived: (id, archived) => {
    if (!hive.enabled()) return { ok: false, error: 'hive disabled' };
    hive.setArchived(id, archived);
    try { liveWebContents()?.send(archived ? 'hive:agentArchived' : 'hive:agentSpawned', { id }); } catch { /* window gone */ }
    return { ok: true };
  },
  // clear_context: hand the text to the renderer's queue so delivery rides every
  // existing gate (idle-only, boot grace, draft/picker safety).
  enqueueToAgent: (id, text) => {
    try { liveWebContents()?.send('realtime:enqueue', { agentId: id, text }); } catch { /* window gone */ }
  },
  getConfigValue: (key) => (readConfig() as unknown as Record<string, unknown>)[key],
  patchConfig: (patch) => { writeConfig(patch as Partial<HarnessConfig>); }
});

// rt-12 seam: push detected completions to the live floor; bridge live-flag, queue
// drain (closed-session warm-start), and wait_for over IPC. Then start polling.
completionWatcher.onCompletion((evt) => { try { liveWebContents()?.send('realtime:completion', evt); } catch { /* window gone */ } });
// v0.3.4: the floor delta watcher shares the session-live flag — while a voice
// session is open it pushes coalesced floor updates the renderer injects as
// silent conversation items (snapshot-at-connect + append-only deltas).
const floorWatcher = new RealtimeFloorWatcher({
  enabled: () => hive.enabled(),
  registry: () => hive.registry(),
  tasks: () => hive.tasks(),
  ptys: () => ptyManager.list().map((p) => ({ id: p.id, lastOutputAt: p.lastOutputAt })),
  push: (text) => { try { liveWebContents()?.send('realtime:floorDelta', { text }); } catch { /* window gone */ } }
});
floorWatcher.start();
ipcMain.handle('realtime:setSessionLive', (_e, live: unknown) => {
  completionWatcher.setSessionLive(live === true);
  floorWatcher.setSessionLive(live === true);
  return { ok: true };
});
// v0.3.4: app self-knowledge for the voice get_app_info tool — version + the
// newest CHANGELOG sections. Read-only; ships CHANGELOG.md with the app.
ipcMain.handle('app:info', () => {
  let changelog = '';
  for (const p of [join(app.getAppPath(), 'CHANGELOG.md'), join(process.cwd(), 'CHANGELOG.md')]) {
    try { changelog = readFileSync(p, 'utf8'); if (changelog) break; } catch { /* try next */ }
  }
  const top = changelog
    ? changelog.split(/\n## /).slice(1, 3).map((s) => `## ${s}`).join('\n').slice(0, 8000)
    : '';
  return { version: app.getVersion(), changelog: top };
});
ipcMain.handle('realtime:drainCompletions', () => completionWatcher.drainQueuedCompletions());
ipcMain.handle('realtime:waitFor', (_e, taskId: unknown, timeoutMs: unknown) =>
  typeof taskId === 'string'
    ? completionWatcher.waitFor(taskId, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 120_000)
    : Promise.resolve({ timedOut: true as const, taskId: '' }));
completionWatcher.start();

// ─── god-triggered ephemeral Slack workers ──────────────────────────────────
// god drops a spawn-request JSON into HIVE_ROOT/spawn-requests/; MAIN polls that
// queue (same cadence + atomic-rename archival as the hive router — reliability
// over latency, no fs.watch/dedup needed), spins up a FRESH ISOLATED worker via
// the shared spawnAgentCore, dispatches the objective through the standard inbox
// path, then watches each worker for a terminal `act:"done"` (success → release)
// or excessive idleness (reap). All teardown flows through teardownPty's
// safety-gate, so a worker's worktree is never auto-removed while it holds
// unintegrated work. Every terminal failure informs god WITH the Slack coords so
// god closes the Slack loop; the success path is the worker replying in-thread.

/** A spawn-request god drops into HIVE_ROOT/spawn-requests/<id>.json. god authors
 *  these directly; `objective` and `cwd` are the only required fields. */
interface SpawnRequest {
  id?: string;
  objective?: string;
  command?: string;                                   // engine CLI; default = config.defaultCommand
  provider?: AgentProvider;                           // optional explicit provider
  model?: string;                                     // optional --model override (Claude)
  cwd?: string;                                        // repo the worker (and its worktree) runs in
  name?: string;                                       // display name
  slack?: { channel: string; thread_ts: string };     // reply target + where failures surface
  isolate?: boolean;                                   // default true (fresh worktree)
  tokenCap?: number;                                   // optional per-worker token cap (advisory P1)
  // Appearance on the office floor. Both optional and both validated renderer-side
  // against the real cast and accent lists, so a bad value degrades to the default
  // rather than breaking the card.
  //
  // Naming a worker after a cast member ALREADY gets you their avatar: the floor
  // card infers it from the name. These two exist for the case that inference
  // cannot express, an agent called something else that should still look like a
  // particular character, and picking the accent instead of taking the one hashed
  // from the worker id.
  character?: string;
  accent?: string;
  /** Engines this task may run on, cheapest first, e.g. ["agy","codex","claude"]. Used
   *  only when neither `command` nor `provider` is set; see engineChoice.ts. */
  engines?: string[];
  /** easy | normal | hard (shared/difficulty.ts): hard tries `engines` strongest first,
   *  and the level sets the worker's effort. */
  difficulty?: Difficulty;
  /** WORK_KINDS (shared/workKind.ts): a reserved engine is
   *  dropped from `engines` unless this is one of its kinds. */
  kind?: WorkKind;
}

/** One line per temporary-worker start and end in HIVE_ROOT/engine-ledger.jsonl, so
 *  engine choices can be judged later against how the work went: which engine, why,
 *  what usage looked like, and whether the worker finished or was reaped. */
function appendEngineLedger(event: Record<string, unknown>): void {
  const root = hive.root();
  if (!root) return;
  try {
    appendFileSync(join(root, 'engine-ledger.jsonl'), JSON.stringify({ ts: Date.now(), ...event }) + '\n', 'utf8');
    writeFileSync(join(root, 'engine-ledger-summary.md'), ledgerSummaryMarkdown(readEngineLedger(), Date.now()), 'utf8');
  } catch (e) { console.warn('[worker] engine ledger write failed:', e); }
}

function readEngineLedger(): string {
  const root = hive.root();
  const p = root ? join(root, 'engine-ledger.jsonl') : '';
  try { return p && existsSync(p) ? readFileSync(p, 'utf8') : ''; } catch { return ''; }
}

ipcMain.handle('app:homeDir', () => homedir());

ipcMain.handle('engineLedger:summary', () => {
  const text = readEngineLedger();
  return { week: summarizeLedger(text, Date.now() - 7 * 86_400_000), all: summarizeLedger(text) };
});

function recordWorkerEnd(rec: WorkerRec): void {
  appendEngineLedger({
    kind: 'end', workerId: rec.workerId, outcome: rec.outcome ?? 'exited',
    durationMs: Date.now() - rec.spawnedAt, tokens: workerTokensUsed(rec.workerId), difficulty: rec.difficulty, effort: rec.effort
  });
}

/** Latest usage readings for engine choice; set once the readers start. */
let readCodexLimits: () => CodexLimits | null = () => null;
let readAgyQuota: () => AgyQuota | null = () => null;

/** The /quota panel pool each agy engine draws on (AgyPool.label). */
const AGY_POOL: Partial<Record<EngineId, string>> = { agy: 'gem', 'agy-claude': 'claude', 'agy-argon': 'argon' };

/** Each engine's usage windows with their lengths: Claude's 5h/7d, Codex's 5h/weekly, and
 *  agy's three pools (Gemini for `agy`, Claude and GPT for `agy-claude`, Argon for `agy-argon`). */
function engineWindows(): Record<EngineId, Array<UsageWindow | undefined>> {
  const claude = readClaudeLimits();
  const codex = readCodexLimits();
  const sec = (b: { percent: number; resetsAt?: number; reset?: boolean } | undefined, lengthMs: number | undefined, sampleAtMs: number | undefined): UsageWindow | undefined =>
    b ? {
      percent: b.percent,
      ...(b.resetsAt !== undefined ? { resetsAtMs: b.resetsAt * 1000 } : {}),
      ...(lengthMs ? { lengthMs } : {}),
      ...(typeof sampleAtMs === 'number' && Number.isFinite(sampleAtMs) && !b.reset ? { sampleAtMs } : {})
    } : undefined;
  const codexLen = (b?: { windowMinutes: number }): number | undefined => (b ? b.windowMinutes * 60_000 : undefined);
  const quota = readAgyQuota();
  const agy = (engine: EngineId): Array<UsageWindow | undefined> => {
    const pool = quota?.pools.find((p) => p.label === AGY_POOL[engine]);
    return pool && quota ? agyPoolWindows(pool, quota.at).map((w) => (w ? { ...w, sampleAtMs: quota.at } : undefined)) : [];
  };
  return {
    // Claude's lengths come from the usage body's own keys, five_hour and seven_day.
    claude: [sec(claude?.fiveHour, FIVE_HOURS_MS, claude?.updatedAt), sec(claude?.sevenDay, SEVEN_DAYS_MS, claude?.updatedAt)],
    codex: [sec(codex?.fiveHour, codexLen(codex?.fiveHour), codex?.updatedAt), sec(codex?.weekly, codexLen(codex?.weekly), codex?.updatedAt)],
    agy: agy('agy'),
    'agy-claude': agy('agy-claude'),
    'agy-argon': agy('agy-argon')
  };
}

/** Engines out of quota right now: a refusal in an agent's session log (limitHits) or
 *  a meter at 100% of a window that has not reset. */
function exhaustedEngines(nowMs = Date.now(), windows = engineWindows()): ExhaustionMap {
  const map: ExhaustionMap = {};
  for (const [id, ex] of limitHits) noteExhaustion(map, id, Math.max(ex.untilMs, nowMs + 1), ex.source, nowMs);
  for (const id of Object.keys(windows) as EngineId[]) {
    const until = spentUntil(windows[id], nowMs);
    if (until !== undefined) noteExhaustion(map, id, until, `${id} meter at 100%`, nowMs);
  }
  for (const [id] of previouslyExhausted) {
    if (!map[id]) noteExhaustion(map, id, nowMs + 1, `${id} awaiting capacity restoration`, nowMs);
  }
  return map;
}

/** Each engine's reading for engine choice: the tighter window, with a window that has
 *  reset or resets within RESET_SOON_MS reading 0%, and an exhausted engine reading full
 *  until its reset whatever its meter last said. */
function engineReadings(nowMs = Date.now(), cfg = readConfig()): EngineReadings {
  const options = { thresholds: getEngineThresholds(cfg) };
  const windows = engineWindows();
  const readings: EngineReadings = {};
  for (const id of Object.keys(windows) as EngineId[]) readings[id] = readEngine(windows[id], nowMs, options);
  return applyExhaustion(readings, exhaustedEngines(nowMs, windows), nowMs);
}

/** Percent used of each engine's tighter window, for the ledger. */
function engineUsage(): EngineUsage {
  const r = engineReadings();
  const out: EngineUsage = {};
  for (const id of Object.keys(r) as EngineId[]) if (r[id]?.percent !== undefined) out[id] = r[id]!.percent;
  return out;
}

/** Each engine's pace (projected percent at reset, rounded) for the ledger. */
function enginePace(r: EngineReadings): Partial<Record<EngineId, number>> {
  const out: Partial<Record<EngineId, number>> = {};
  for (const id of Object.keys(r) as EngineId[]) if (r[id]?.pace !== undefined) out[id] = Math.round(r[id]!.pace!);
  return out;
}

/** Each engine's projected lockout for the ledger, as the reason writes it ("~4.1d", "none"). */
function engineLockout(r: EngineReadings): Partial<Record<EngineId, string>> {
  const out: Partial<Record<EngineId, string>> = {};
  for (const id of Object.keys(r) as EngineId[]) {
    const ms = r[id]?.lockoutMs;
    if (ms !== undefined) out[id] = ms > 0 ? lockoutText(ms) : 'none';
  }
  return out;
}

/** Why an agent cannot run an entry (its registry settings, or the CLI is not installed), or null. */
function exclusionFor(agentId: string, isGod: boolean): (e: AgentModelEntry) => string | null {
  const ws = hive.workspaceOf(agentId);
  const sb = hive.codexSandboxOf(agentId);
  const placement: AgentPlacement = {
    unity: ws?.unity === true,
    network: ws?.network === true,
    extraDirs: ws?.extraDirs.length ?? 0,
    codexSandbox: sb.stored && readConfig().agentSandbox === true ? sb.level : undefined,
    isGod,
    ...(isJailed(readConfig(), agentId) ? { jailProviders: JAIL_PROVIDERS } : {})
  };
  return (e) => entryExclusion(e, placement)
    ?? (ptyManager.isCommandAvailable(providerPreset(e.provider).defaultCommand) ? null : `${providerPreset(e.provider).defaultCommand} is not installed`);
}

/** The entries of a model list an agent can run on, plus why each other one is ruled out. */
function allowedModelEntries(agentId: string, isGod: boolean, models: AgentModelEntry[]): {
  allowed: AgentModelEntry[]; excluded: Array<{ entry: AgentModelEntry; reason: string }>;
} {
  const why = exclusionFor(agentId, isGod);
  const excluded: Array<{ entry: AgentModelEntry; reason: string }> = [];
  const allowed: AgentModelEntry[] = [];
  for (const e of models) {
    const r = why(e);
    if (r) excluded.push({ entry: e, reason: r }); else allowed.push(e);
  }
  return { allowed, excluded };
}

/** An agent's tier walk for a fresh start (shared/modelTiers.ts): its card's difficulty
 *  (the Boss ignores it) and kind, the camp reservations, and what it cannot run. Without
 *  `forCard` it is the normal-card walk fleet.json and the Edit Agent modal show. */
function agentWalk(a: { id: string; isGod: boolean; tier: Tier }, nowMs: number, forCard = true): AgentWalk & { difficulty?: Difficulty } {
  const cfg = readConfig();
  const difficulty = forCard && !a.isGod ? cardDifficulty(a.id) : undefined;
  const escalation = difficulty === 'hard' ? forCardOf(a.id)?.escalation : undefined;
  const walk = resolveAgentWalk({
    tiers: parseModelTiers(cfg.modelTiers),
    agentTier: a.tier,
    difficulty,
    ...(escalation ? { escalation } : {}),
    nowMs,
    exclusion: exclusionFor(a.id, a.isGod),
    ...(forCard ? { reservations: parseReservations(cfg.reservations), kind: cardKind(a.id) } : {})
  });
  return { ...walk, ...(difficulty ? { difficulty } : {}) };
}

/** A persistent agent's fresh-start pick over its tier walk (main/tierPick.ts): a usable
 *  pin, else the first walked tier with room, else a wait until the next reset.
 *  Every call is logged to engine-ledger.jsonl. */
ipcMain.handle('engine:chooseForAgent', (_evt, req: unknown) => {
  const r = (req ?? {}) as { agentId?: unknown; isGod?: unknown; current?: unknown };
  if (typeof r.agentId !== 'string' || !r.agentId) return null;
  const agentId = r.agentId;
  const view = [...limitRosterAgents().live, ...limitRosterAgents().dormant].find((v) => v.id === agentId);
  const current = cleanModelList([r.current])[0] ?? view?.current;
  const isGod = view?.isGod ?? r.isGod === true;
  const tier = view?.tier ?? agentTierOf(undefined, parseModelTiers(readConfig().modelTiers), current);
  const readings = engineReadings();
  const nowMs = Date.now();
  const walk = agentWalk({ id: agentId, isGod, tier }, nowMs);
  // A pin sticks while its entry has room and is not refused; it applies again after a reset.
  const pin = modelSwitcher.pinnedEntry(agentId, (e) =>
    !exclusionFor(agentId, isGod)(e) && !refusedEntry(e, nowMs, agentId) && !isExhausted(exhaustedEngines(nowMs), engineFor(e.provider, e.model), nowMs));
  const pick = pickAgentEntry({
    walk, readings, nowMs, pin, thresholds: getEngineThresholds(readConfig()),
    candidateOf: (e) => candidateFor(e, agentId)
  });
  const excluded = walk.excluded.map((x) => ({ entry: x.entry, reason: x.reason }));
  const difficulty = walk.difficulty;
  const card = forCardOf(agentId);
  appendEngineLedger({
    kind: 'agent-pick', agentId, chosen: pick.entry ? entryLabel(pick.entry) : null,
    previous: current ? entryLabel(current) : undefined,
    changed: !!pick.entry && !!current && !sameEntry(pick.entry, current),
    reason: pick.reason, tier, pickedTier: pick.tier,
    excluded: excluded.length ? excluded.map((x) => `${entryLabel(x.entry)}: ${x.reason}`) : undefined,
    difficulty, usage: engineUsage(), pace: enginePace(readings), lockout: engineLockout(readings),
    effort: pick.entry ? ledgerEffort(difficulty, pick.entry.provider, pick.entry.model, agentEffort(agentId, pick.entry.provider)) : undefined,
    ...(card ? { card: card.id, sendBacks: card.sendBacks ?? 0 } : {}),
    ...escalationLedger(walk, pick)
  });
  return { entry: pick.entry, quotaBlocked: pick.quotaBlocked, reason: difficulty ? `${difficulty} card; ${pick.reason}` : pick.reason, excluded };
});

// Provider usage limits: hold, hand off and switch.

/** Engines whose CLI refused work in an agent's session log or terminal, until their
 *  reset; `atMs` is when the refusal was recorded. */
const limitHits = new Map<EngineId, Exhaustion & { atMs: number }>();
const previouslyExhausted = new Map<EngineId, number>();
const restoredAt = new Map<EngineId, number>();
const agyRefusals = new AgyRefusalStore();
/** Usage for engines with no Claude transcript: Antigravity's conversation db, Codex's rollout. */
function offTranscriptUsage(id: string, provider: string | undefined, sessionId: string | undefined) {
  return agyUsageSample(id, provider, sessionId) ?? codexUsageSample(id, provider, sessionId, hive.root());
}
/** Codex with no readable rollout: the activity signal is missing, not absent. */
function activityUnknown(provider: string | undefined, u: unknown): boolean { return provider === 'codex' && !u; }
const noProgressWatch = new NoProgressWatch();
const modelActivity = new Map<string, { tokens: number; at: number }>();
function modelActivityAt(id: string, tokens: number, now: number): number {
  const prev = modelActivity.get(id);
  if (!prev || prev.tokens !== tokens) { modelActivity.set(id, { tokens, at: now }); return now; }
  return prev.at;
}
const refusalTerminals = new Map<string, AgyRefusalTerminal>();

let refusalHydratedRoot: string | null = null;
function refreshAgyRefusals(): void {
  for (const [id, a] of Object.entries(hive.registry().agents)) {
    if (a.archived || a.provider !== 'antigravity') continue;
    for (const r of readAgyRefusals(id, a.sessionId, Date.now())) agyRefusals.record(r);
  }
}

function ensureRefusalsLoaded(): void {
  const root = hive.root();
  if (!root) return;
  agyRefusals.load(join(root, 'agy-model-refusals.json'));
  if (refusalHydratedRoot !== root) {
    refreshAgyRefusals();
    refusalHydratedRoot = root;
  }
}

function refusedEntry(e: AgentModelEntry, now = Date.now(), agentId?: string): boolean {
  ensureRefusalsLoaded();
  const engine = engineFor(e.provider, e.model);
  const agyRef = e.provider === 'antigravity'
    ? (e.model ? agyRefusals.active(e.model, now) : agentId ? agyRefusals.forAgent(agentId, undefined, now) : undefined)
    : undefined;
  const agyActive = agyRef && (!engine || (restoredAt.get(engine) ?? 0) < agyRef.atMs);
  return (engine && limitHits.has(engine)) === true || !!agyActive;
}

function candidateFor(e: AgentModelEntry, agentId: string) {
  return { engine: engineFor(e.provider, e.model), label: entryLabel(e), blocked: refusedEntry(e, Date.now(), agentId), ...(e.maxPercent !== undefined ? { maxPercent: e.maxPercent } : {}) };
}

/** Each live agent's session: when its PTY started, on which CLI, in which folder. A
 *  refusal logged before `atMs` belongs to an earlier session. */
const liveSessions = new Map<string, { atMs: number; provider: AgentProvider; cwd: string }>();
/** Agents held at a spent limit with nowhere to move (dormant ones included). */
const limitWaits = new Map<string, LimitWait & { engine: EngineId; resumeAtMs?: number; refused: boolean; atMs?: number; capacityRestored?: boolean }>();
/** The one toast per hold telling the human an agent is locked; kept in step with limitWaits. */
const limitLockNotices = new LimitLockNotices(() => !!readConfig().notifications, breakerToast);
/** Expiry alerts for earned Codex reset credits before they expire. */
const codexResetCreditNotices = new CodexResetCreditNotices(() => !!readConfig().notifications, breakerToast, () => liveTimings().codexResetCreditAlertLeadMs);
/** Expiry alerts for banked Claude limit resets (/limit-reset) before they expire. */
const claudeResetGrantNotices = new ClaudeResetGrantNotices(() => !!readConfig().notifications, breakerToast, () => liveTimings().claudeResetGrantAlertLeadMs, () => liveTimings().claudeResetGrantFinalAlertLeadMs);
const RESERVATION_EXPIRY_KV = 'engine.reservationExpiryNotified';
/** One toast per reservation when it ends; the notified keys persist so a restart stays quiet. */
const reservationExpiryNotices = new ReservationExpiryNotices(
  () => !!readConfig().notifications,
  breakerToast,
  () => { try { const v = persist.getKv<string[]>(RESERVATION_EXPIRY_KV); return Array.isArray(v) ? v : []; } catch { return []; } },
  (keys) => { try { persist.setKv(RESERVATION_EXPIRY_KV, keys); } catch { /* DB best-effort */ } }
);
/** Agents proposed to the renderer for a limit switch, with what main expects them to move to. */
const pendingSwitches = new Map<string, { from: string; to: string; resetAtMs?: number; proposedAt: number; manual?: boolean }>();
/** Session-log tails already parsed, by path; re-read only when size or mtime changes. */
const limitLogCache = new Map<string, { size: number; mtimeMs: number; hit: LimitHit | null }>();
const LIMIT_TAIL_BYTES = 128 * 1024;
const HANDOFF_LOG_BYTES = 1024 * 1024;
/** A switch the renderer has not carried out is proposed again after this long. */
const SWITCH_REPROPOSE_MS = 60_000;
let limitStopTimer: ReturnType<typeof setTimeout> | null = null;

/** Every model an agent can be switched to: the camp tier entries it can run (strong first),
 *  its current engine, then every catalog model its settings and installed CLIs allow. */
function switchChoices(agentId: string): AgentModelEntry[] {
  const a = [...limitRosterAgents().live, ...limitRosterAgents().dormant].find((x) => x.id === agentId);
  if (!a) return [];
  const known: AgentModelEntry[] = [];
  const providers = { ...modelCatalogData.providers, ...(loadRuntimeModelCatalog(runtimeCatalogSources(), lastAgyModelOutput)?.providers ?? {}) } as Record<string, Array<{ id?: string }>>;
  for (const [provider, models] of Object.entries(providers)) {
    for (const m of models) known.push({ provider: provider as AgentModelEntry['provider'], ...(m.id ? { model: m.id } : {}) });
  }
  const tiers = parseModelTiers(readConfig().modelTiers);
  const { allowed } = allowedModelEntries(agentId, a.isGod, [...TIERS.flatMap((t) => tiers[t]), a.current, ...known]);
  return cleanModelList(allowed);
}

/** Store `entry` as the agent's engine and its persisted pin, and tell the open windows. */
function persistModelChoice(id: string, entry: AgentModelEntry): void {
  const isGod = id === (hive.registry().godId ?? 'god') || hive.registry().agents[id]?.isGod === true;
  const cfg = readConfig();
  const command = buildSpawnCommand({ defaultCommand: cfg.defaultCommand, autoMode: cfg.autoMode !== false }, entry.model, entry.provider);
  const view = [...limitRosterAgents().live, ...limitRosterAgents().dormant].find((v) => v.id === id);
  const effectiveLadder = view ? agentWalk(view, Date.now(), false).walk.map((w) => w.entry) : [entry];
  const patch: AgentBalancerPatch = { id, isGod, provider: entry.provider, model: entry.model, command, engineChanged: true, pin: entry, effectiveLadder };
  applyBalancerPatches([patch]);
  for (const w of allWindows) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
      try { w.webContents.send('hive:agentConfigChanged', { patches: [patch] }); } catch { /* window gone */ }
    }
  }
}

/** Clear an agent's model pin, so its next fresh start follows its tier walk. Edit Agent and the phone both call this. */
function clearAgentPin(agentId: string): boolean {
  const view = [...limitRosterAgents().live, ...limitRosterAgents().dormant].find((v) => v.id === agentId);
  if (!view) return false;
  modelSwitcher.clearPin(agentId);
  const patch: AgentBalancerPatch = {
    id: agentId, isGod: view.isGod, provider: view.current.provider, model: view.current.model, engineChanged: false, pin: null,
    effectiveLadder: agentWalk(view, Date.now(), false).walk.map((w) => w.entry)
  };
  applyBalancerPatches([patch]);
  for (const w of allWindows) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
      try { w.webContents.send('hive:agentConfigChanged', { patches: [patch] }); } catch { /* window gone */ }
    }
  }
  return true;
}

ipcMain.handle('engine:clearPin', (_evt, agentId: unknown): boolean => {
  if (typeof agentId !== 'string' || !agentId) return false;
  return clearAgentPin(agentId);
});

ipcMain.handle('engine:pinModel', async (_evt, agentId: unknown, entry: unknown): Promise<{ ok: boolean; error?: string }> => {
  if (typeof agentId !== 'string' || !agentId || typeof entry !== 'object' || !entry) return { ok: false, error: 'bad request' };
  const r = await modelSwitcher.switchAgentModel(agentId, entry as AgentModelEntry, 'desktop', { confirmBoss: true });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
});

/** How long a restarted agent has to show a live terminal again. */
const RESTART_WAKE_TIMEOUT_MS = 30_000;

/** The agent as the model switcher and the tests checkpoint see it. */
function switchAgentView(id: string) {
  const { live, dormant } = limitRosterAgents();
  const a = live.find((x) => x.id === id) ?? dormant.find((x) => x.id === id);
  if (!a) return null;
  return { id: a.id, name: a.name, isGod: a.isGod, current: a.current, walk: a.walk, live: live.some((x) => x.id === id) && !!ptyForAgent(id) };
}

/** Agents whose restart the tests checkpoint asked for and that has not happened yet. */
const checkpointRestarts = new Set<string>();

/** switchModel(agentId, entry, reason): respawn a live agent on another model through the limit-switch path. */
const modelSwitcher = createModelSwitcher({
  now: () => Date.now(),
  agent: switchAgentView,
  quiet: (id) => { const ptyId = ptyForAgent(id); return !!ptyId && Date.now() - (ptyManager.lastOutputAt(ptyId) ?? 0) >= WORKER_WAKE_IDLE_MS; },
  closing: () => closingTime.isActive(),
  choices: switchChoices,
  persist: (id, entry) => persistModelChoice(id, entry),
  storedPin: (id) => [...limitRosterAgents().live, ...limitRosterAgents().dormant].find((v) => v.id === id)?.pin ?? null,
  restart: async (id, from, to) => {
    const a = limitRosterAgents().live.find((x) => x.id === id);
    if (!a || !ptyForAgent(id) || closingTime.isActive()) return false;
    limitWaits.delete(id);
    pendingSwitches.set(id, { from, to, proposedAt: Date.now(), manual: true });
    await writeHandoff(a, from, to, undefined, checkpointRestarts.has(id) ? 'checkpoint' : 'manual');
    try { liveWebContents()?.send('hive:limitSwitchDue', { agentId: id, isGod: a.isGod }); } catch { /* window torn down */ }
    console.log('[model] proposing switch', id, from, '->', to);
    return true;
  },
  ledger: appendEngineLedger
});

/** Keep automation off `id` while a checkpoint restart is queued or in flight; nothing is queued when it came back applied or refused. */
async function holdForRestart<T extends { ok: boolean; state?: string }>(id: string, run: Promise<T>): Promise<T> {
  checkpointRestarts.add(id);
  const r = await run;
  if (!r.ok || r.state === 'applied') checkpointRestarts.delete(id);
  return r;
}

/** Red tests committed by a senior that implements the same card: write the handoff, restart fresh on its current model. */
const testsCheckpoint = createTestsCheckpoint({
  agent: (id) => {
    const v = switchAgentView(id);
    return v ? { ...v, role: hive.registry().agents[id]?.role } : null;
  },
  card: (id) => (tasksOf(hive.tasks()) as Array<{ id: string; assignee?: string; testsCheckpoint?: unknown }>).find((t) => t.id === id) ?? null,
  writeHandoff: async (id) => {
    const v = switchAgentView(id);
    if (v) await writeHandoff(v, entryLabel(v.current), entryLabel(v.current), undefined, 'checkpoint');
  },
  settle: (cardId, note) => hive.settleTestsCheckpoint(cardId, note),
  switcher: {
    freshRestart: (id, reason) => holdForRestart(id, modelSwitcher.freshRestart(id, reason))
  },
  ledger: (event) => { try { hive.appendLog(event as Parameters<typeof hive.appendLog>[0]); } catch { /* log unavailable */ } }
});
hive.setTestsReadyObserver((sender, cardId, ready) => { void testsCheckpoint.onSignal(sender, cardId, ready); });
/** Boss-requested restart of a hung agent: handoff, kill the process tree, wake a fresh session on its card. */
const agentRestarter = createAgentRestarter({
  now: () => Date.now(),
  bossId: () => hive.registry().godId ?? null,
  recentActivityMs: () => liveTimings().restartRecentActivityMs,
  agent: (id) => {
    const v = switchAgentView(id);
    if (!v) return null;
    const row = ((hive.fleet() as { agents?: Array<{ id?: string; lastActiveSecAgo?: number | null }> } | null)?.agents ?? []).find((a) => a.id === id);
    const secAgo = typeof row?.lastActiveSecAgo === 'number' ? row.lastActiveSecAgo : undefined;
    const view = [...limitRosterAgents().live, ...limitRosterAgents().dormant].find((x) => x.id === id);
    const walk = view ? agentWalk(view, Date.now()).walk.map((w) => w.entry) : [];
    return { id: v.id, isGod: v.isGod, current: v.current, ladder: walk.length ? walk : [v.current], ...(secAgo !== undefined ? { lastActivityAt: Date.now() - secAgo * 1000 } : {}) };
  },
  currentCard: (id) => {
    const mine = (tasksOf(hive.tasks()) as Array<{ id: string; status?: string; assignee?: string; title?: string; brief?: string; backloggedAt?: unknown }>)
      .filter((t) => t.assignee === id && !t.backloggedAt && (t.status === 'doing' || t.status === 'todo'));
    const card = mine.find((t) => t.status === 'doing') ?? mine[0];
    return card ? { id: card.id, status: card.status, title: card.title, brief: card.brief } : null;
  },
  choices: switchChoices,
  blocked: (id, force) => {
    if (closingTime.isActive()) return 'closing time is running; restart after the wrap-up';
    if (pendingSwitches.has(id) || checkpointRestarts.has(id)) return `a model switch for ${id} is already in flight`;
    if (limitWaits.has(id) && !force) return `${id} is held at a usage limit, not hung; pass force:true to restart anyway`;
    return null;
  },
  writeHandoff: async (id, data) => {
    const v = switchAgentView(id);
    if (!v) throw new Error('agent not on the floor');
    await writeHandoff(v, entryLabel(data.from), entryLabel(data.to), undefined, 'manual');
    const root = hive.root();
    if (!root) throw new Error('no hive root');
    const file = join(root, 'agents', id, 'handoff.md');
    const last = data.lastActivityAt ? new Date(data.lastActivityAt).toISOString() : 'unknown';
    const section = [
      '', '## Boss restart', '',
      `Your session was restarted by the Boss: ${data.reason}`,
      `Last session activity: ${last}. Model: ${entryLabel(data.from)} -> ${entryLabel(data.to)}.`,
      `Resume card \`${data.card.id}\`${data.card.title ? ` (${data.card.title})` : ''}.`,
      ...(data.card.brief ? ['', 'Card brief:', '', data.card.brief] : []), ''
    ].join('\n');
    appendFileSync(file, section, 'utf8');
  },
  stopTree: async (id) => {
    const ptyId = ptyForAgent(id);
    limitWaits.delete(id);
    pendingSwitches.delete(id);
    checkpointRestarts.delete(id);
    modelSwitcher.completed(id);
    if (!ptyId) return true;
    const pid = ptyManager.list().find((p) => p.id === ptyId)?.pid;
    ptyManager.kill(ptyId);
    teardownPty(ptyId, { dormant: true });
    if (typeof pid === 'number') {
      const deadline = Date.now() + KILL_GRACE_MS + 2_000;
      while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      if (isAlive(pid)) { hardKillTree(pid); await new Promise((r) => setTimeout(r, 300)); }
      if (isAlive(pid)) return false;
    }
    return true;
  },
  startFresh: async (id, model, cardId) => {
    const v = switchAgentView(id);
    if (!v) return false;
    if (!sameEntry(v.current, model)) {
      persistModelChoice(id, model);
      modelSwitcher.pin(id, model);
    }
    const a = limitRosterAgents().live.find((x) => x.id === id) ?? limitRosterAgents().dormant.find((x) => x.id === id);
    liveWebContents()?.send('hive:agentRestartDue', { agentId: id, cardId, isGod: !!a?.isGod });
    const deadline = Date.now() + RESTART_WAKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (ptyForAgent(id)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  },
  appendLog: (e) => hive.appendLog(e),
  noteCard: (cardId, note) => hive.appendCardNote(cardId, note)
});
hive.setRestartAgentHook((sender, body) => agentRestarter.restart(sender, body));
hive.setArchiveAgentGuard((id) => ([...ptyToAgent.values()].includes(id) ? 'it has a live terminal session (close its tab to archive it)' : null));
hive.setFreshStartHook((agentId) => {
  void (async () => {
    try {
      const v = switchAgentView(agentId);
      if (v) await writeHandoff(v, entryLabel(v.current), entryLabel(v.current), undefined, 'checkpoint');
      await holdForRestart(agentId, modelSwitcher.freshRestart(agentId, 'checkpoint'));
    } catch (e) { console.error('[answer-hold] fresh restart failed:', e); }
  })();
});

/** True while nothing automatic may be typed into `agentId`: it waits at a limit or is
 *  about to be switched off one. */
function limitHeld(agentId: string): boolean {
  return limitWaits.has(agentId) || pendingSwitches.has(agentId) || checkpointRestarts.has(agentId);
}

function readTailText(path: string, maxBytes: number): string | null {
  try {
    const st = statSync(path);
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, len, st.size - len); } finally { closeSync(fd); }
    return buf.toString('utf8');
  } catch { return null; }
}

/** The newest rollout in an agent's own CODEX_HOME, from the last two days' folders. */
function newestAgentRollout(agentId: string, sessionId?: string): string | null {
  const root = hive.root();
  if (!root) return null;
  const sessions = join(root, 'agents', agentId, '.codex', 'sessions');
  let best: { path: string; mtimeMs: number } | null = null;
  for (const date of recentDateDirs(Date.now(), 2)) {
    let names: string[];
    try { names = readdirSync(join(sessions, date)); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith('rollout-') || !n.endsWith('.jsonl') || (sessionId && !n.endsWith(`-${sessionId}.jsonl`))) continue;
      const path = join(sessions, date, n);
      try { const m = statSync(path).mtimeMs; if (!best || m > best.mtimeMs) best = { path, mtimeMs: m }; } catch { /* gone */ }
    }
  }
  return best?.path ?? null;
}

/** The session log of an agent's current (or just-ended) session: the path its hooks
 *  last reported, else the newest Codex rollout in its CODEX_HOME, else the Claude
 *  transcript of its recorded session id. agy keeps no log the harness can read. */
function agentSessionLog(agentId: string, provider: AgentProvider, cwd: string): string | null {
  const hooked = hookServer.transcriptPath(agentId);
  const isRollout = (p: string): boolean => /[\\/]rollout-[^\\/]*\.jsonl$/.test(p);
  if (provider === 'codex') {
    const sid = hive.registry().agents[agentId]?.sessionId;
    if (hooked && isRollout(hooked) && (!sid || hooked.endsWith(`-${sid}.jsonl`)) && existsSync(hooked)) return hooked;
    return newestAgentRollout(agentId, sid);
  }
  if (isClaudeProvider(provider)) {
    if (hooked && !isRollout(hooked) && existsSync(hooked)) return hooked;
    const sid = hive.registry().agents[agentId]?.sessionId;
    if (sid && /^[A-Za-z0-9_-]+$/.test(sid)) {
      const path = join(projectDir(cwd), `${sid}.jsonl`);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** The usage-limit refusal that ended the agent's current session's last turn, or null. */
async function readTailTextAsync(path: string, maxBytes: number): Promise<string | null> {
  try {
    const fh = await openAsync(path, 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally { await fh.close(); }
  } catch { return null; }
}

/** agentLimitHit for the limit beat: the same answer and cache, with the stat and the
 *  transcript read off the main thread (transcripts sit on a disk others are writing). */
async function agentLimitHitAsync(agentId: string): Promise<LimitHit | null> {
  const s = liveSessions.get(agentId);
  if (!s || s.provider === 'antigravity') return agentLimitHit(agentId);
  const path = agentSessionLog(agentId, s.provider, s.cwd);
  if (!path) return null;
  let st: { size: number; mtimeMs: number };
  try { st = await statAsync(path); } catch { return null; }
  const prev = limitLogCache.get(path);
  let hit: LimitHit | null;
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) hit = prev.hit;
  else {
    const text = await readTailTextAsync(path, LIMIT_TAIL_BYTES) ?? '';
    hit = s.provider === 'codex' ? codexLimitHit(text) : claudeLimitHit(text);
    limitLogCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, hit });
  }
  return hit && hit.atMs >= s.atMs ? hit : null;
}

function agentLimitHit(agentId: string): LimitHit | null {
  const s = liveSessions.get(agentId);
  if (!s) return null;
  if (s.provider === 'antigravity') {
    ensureRefusalsLoaded();
    const r = agyRefusals.forAgent(agentId, liveModelOf(agentId), Date.now());
    return r ?? null;
  }
  const path = agentSessionLog(agentId, s.provider, s.cwd);
  if (!path) return null;
  let st: ReturnType<typeof statSync>;
  try { st = statSync(path); } catch { return null; }
  const prev = limitLogCache.get(path);
  let hit: LimitHit | null;
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) hit = prev.hit;
  else {
    const text = readTailText(path, LIMIT_TAIL_BYTES) ?? '';
    hit = s.provider === 'codex' ? codexLimitHit(text) : claudeLimitHit(text);
    limitLogCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, hit });
  }
  return hit && hit.atMs >= s.atMs ? hit : null;
}

const liveModelCache = new Map<string, { size: number; mtimeMs: number; model: string | null }>();

/** The model the agent's live session is actually running, from its session log, or
 *  null when there is no live session or the log does not say. agy keeps no log. */
function agentLiveModel(agentId: string): string | null {
  const s = liveSessions.get(agentId);
  if (!s || s.provider === 'antigravity') return null;
  const path = agentSessionLog(agentId, s.provider, s.cwd);
  if (!path) return null;
  let st: ReturnType<typeof statSync>;
  try { st = statSync(path); } catch { return null; }
  const prev = liveModelCache.get(path);
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev.model;
  const model = liveModelFromLog(readTailText(path, LIMIT_TAIL_BYTES) ?? '', s.provider);
  liveModelCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, model });
  return model;
}

/** Last model-close per agent, so a fresh session that still reads as off-list (an
 *  allowed list the balancer cannot honour) is not closed again on every delivery. */
const lastModelClose = new Map<string, number>();
const MODEL_CLOSE_COOLDOWN_MS = 10 * 60_000;

interface LimitAgentView {
  id: string;
  name: string;
  isGod: boolean;
  /** Must keep its session: the prep assistant, or a worker the roster does not own. */
  pinned: boolean;
  current: AgentModelEntry;
  /** Its camp tier: stored, else the tier holding its current engine. */
  tier: Tier;
  /** Its persisted pin. */
  pin?: AgentModelEntry;
  /** Its normal-card tier walk, before placement exclusions; [current] when the tiers are empty. */
  walk: AgentModelEntry[];
}

/** Roster agents (live and dormant) as the limit watch sees them. The Boss's current
 *  engine, tier and pin live in config, every other agent's on its roster entry. */
function limitRosterAgents(): { live: LimitAgentView[]; dormant: LimitAgentView[] } {
  const snap = roster.read();
  const cfg = readConfig();
  const tiers = parseModelTiers(cfg.modelTiers);
  const view = (raw: unknown): LimitAgentView | null => {
    if (!raw || typeof raw !== 'object') return null;
    const a = raw as { id?: unknown; name?: unknown; provider?: unknown; command?: unknown; model?: unknown; tier?: unknown; pin?: unknown; isGod?: unknown; isAssistant?: unknown };
    if (typeof a.id !== 'string' || !a.id) return null;
    const isGod = a.isGod === true;
    const provider = isGod
      ? (cfg.godProvider ?? 'claude')
      : inferAgentProvider(typeof a.command === 'string' ? a.command : undefined, typeof a.provider === 'string' ? a.provider as AgentProvider : undefined);
    const model = isGod ? cfg.godModel : typeof a.model === 'string' && a.model ? a.model : undefined;
    const current: AgentModelEntry = { provider, ...(model ? { model } : {}) };
    const tier = agentTierOf(isGod ? cfg.godTier : a.tier, tiers, current);
    const pin = cleanModelList([isGod ? cfg.godPin : a.pin])[0];
    const walk = resolveAgentWalk({ tiers, agentTier: tier, nowMs: 0 }).walk.map((w) => w.entry);
    return {
      id: a.id,
      name: typeof a.name === 'string' ? a.name : a.id,
      isGod,
      pinned: a.isAssistant === true,
      current,
      tier,
      ...(pin ? { pin } : {}),
      walk: walk.length ? walk : [current]
    };
  };
  const pick = (list: unknown): LimitAgentView[] => (Array.isArray(list) ? list.map(view).filter((v): v is LimitAgentView => !!v) : []);
  return { live: pick(snap?.agents), dormant: pick(snap?.restorable) };
}

function applyBalancerPatches(patches: AgentBalancerPatch[]): { ok: boolean; reason?: string } {
  const cfg = readConfig();
  const autoMode = cfg.autoMode !== false;
  const reg = hive.registry();
  const workerPatches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  for (const p of patches) {
    const isGod = p.id === (reg.godId ?? 'god') || reg.agents[p.id]?.isGod === true;
    const cmd = buildSpawnCommand({ defaultCommand: cfg.defaultCommand, autoMode }, p.model, p.provider);
    if (isGod) {
      const nextCfg = writeConfig({
        ...(p.tier ? { godTier: p.tier } : {}),
        ...(p.pin !== undefined ? { godPin: p.pin ?? undefined } : {}),
        ...(p.engineChanged ? { godProvider: p.provider, godModel: p.model, defaultCommand: cmd } : {})
      });
      for (const w of allWindows) {
        if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
          try { w.webContents.send('config:changed', nextCfg); } catch { /* window gone */ }
        }
      }
    }
    workerPatches.push({
      id: p.id,
      patch: {
        ...(p.tier ? { tier: p.tier } : {}),
        ...(p.pin !== undefined ? { pin: p.pin ?? undefined } : {}),
        ...(p.engineChanged ? { provider: p.provider, model: p.model, command: cmd } : {})
      }
    });
  }
  if (workerPatches.length) {
    roster.patchAgents(workerPatches);
  }
  return { ok: true };
}

/** One-shot move from per-agent ladders to camp tiers (shared/modelTiers.ts planTierMigration):
 *  back the old ladders up, write the tier lists and every agent's tier, then drop the ladders. */
function migrateModelTiers(): void {
  const cfg = readConfig();
  if (!needsTierMigration(cfg)) {
    const withTop = withTopTier(cfg.modelTiers);
    if (withTop) writeConfig({ modelTiers: parseModelTiers(withTop) });
    return;
  }
  const snap = roster.read();
  const rows = [...(snap?.agents ?? []), ...(snap?.restorable ?? [])]
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string');
  const reg = hive.registry();
  const agents = rows.filter((r) => r.isGod !== true).map((r) => ({
    id: r.id as string,
    provider: inferAgentProvider(typeof r.command === 'string' ? r.command : undefined, typeof r.provider === 'string' ? r.provider as AgentProvider : undefined),
    ...(typeof r.model === 'string' && r.model ? { model: r.model } : {}),
    models: r.models,
    archived: reg.agents[r.id as string]?.archived === true
  }));
  const plan = planTierMigration({ god: { provider: cfg.godProvider ?? 'claude', model: cfg.godModel, models: cfg.godModels }, agents });
  const home = cfg.harnessHome;
  if (home) {
    try {
      const dir = rosterBackupDir(home);
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(join(dir, `ladders-${stamp}.json`), JSON.stringify({
        savedAt: new Date().toISOString(),
        godModels: cfg.godModels ?? null,
        agents: rows.map((r) => ({ id: r.id, models: r.models ?? null }))
      }, null, 2), 'utf8');
    } catch (e) {
      console.error('[model-tiers] could not back up the old ladders; migration skipped:', e);
      return;
    }
  }
  writeConfig({ modelTiers: plan.tiers, ...(plan.godTier ? { godTier: plan.godTier } : {}), godModels: undefined });
  const patches = rows.map((r) => ({ id: r.id as string, patch: { models: undefined, ...(plan.agentTiers[r.id as string] ? { tier: plan.agentTiers[r.id as string] } : {}) } }));
  if (snap && patches.length) roster.patchAgents(patches);
  hive.appendLog({ kind: 'model-tier-migration', tiers: Object.fromEntries(TIERS.map((t) => [t, plan.tiers[t].map(entryLabel)])), agentTiers: plan.agentTiers, godTier: plan.godTier });
  console.log('[model-tiers] migrated per-agent ladders to camp tiers', plan.agentTiers);
}

hive.setAgentBalancerAdapter({
  readAgents: () => {
    const cfg = readConfig();
    const reg = hive.registry();
    const views = limitRosterAgents();
    const out: Record<string, AgentBalancerState> = {};
    for (const v of [...views.live, ...views.dormant]) {
      const ws = hive.workspaceOf(v.id);
      const sb = hive.codexSandboxOf(v.id);
      out[v.id] = {
        id: v.id,
        provider: v.current.provider,
        ...(v.current.model ? { model: v.current.model } : {}),
        tier: v.tier,
        isGod: v.isGod,
        isAssistant: v.pinned,
        archived: reg.agents[v.id]?.archived === true,
        onRoster: true,
        placement: {
          unity: ws?.unity === true,
          network: ws?.network === true,
          extraDirs: ws?.extraDirs.length ?? 0,
          codexSandbox: sb.stored && cfg.agentSandbox === true ? sb.level : undefined,
          isGod: v.isGod,
          ...(isJailed(cfg, v.id) ? { jailProviders: JAIL_PROVIDERS } : {})
        }
      };
    }
    const godId = reg.godId ?? 'god';
    if (!out[godId] && (reg.godId || reg.agents[godId])) {
      const godProvider = cfg.godProvider ?? 'claude';
      const godModel = cfg.godModel;
      const ws = hive.workspaceOf(godId);
      const sb = hive.codexSandboxOf(godId);
      out[godId] = {
        id: godId,
        provider: godProvider,
        ...(godModel ? { model: godModel } : {}),
        ...(isTier(cfg.godTier) ? { tier: cfg.godTier } : {}),
        isGod: true,
        onRoster: true,
        placement: {
          unity: ws?.unity === true,
          network: ws?.network === true,
          extraDirs: ws?.extraDirs.length ?? 0,
          codexSandbox: sb.stored && cfg.agentSandbox === true ? sb.level : undefined,
          isGod: true,
          ...(isJailed(cfg, godId) ? { jailProviders: JAIL_PROVIDERS } : {})
        }
      };
    }
    return out;
  },
  apply: applyBalancerPatches
});

/** Write agents/<id>/handoff.md from the old session's log, the agent's cards, mail and
 *  memory, and its worktrees' git state. Best-effort: a note that cannot be written leaves
 *  the switch to go ahead without one. */
async function writeHandoff(a: Pick<LimitAgentView, 'id' | 'name'>, from: string, to: string, resetAtMs: number | undefined, reason: 'limit' | 'manual' | 'checkpoint' = 'limit'): Promise<void> {
  const root = hive.root();
  if (!root) return;
  const s = liveSessions.get(a.id);
  const path = s ? agentSessionLog(a.id, s.provider, s.cwd) : null;
  const text = path ? readTailText(path, HANDOFF_LOG_BYTES) ?? '' : '';
  const digest = !text ? { messages: [], tools: [] } : s?.provider === 'codex' ? codexDigest(text) : claudeDigest(text);
  const nowMs = Date.now();
  try {
    const gathered = await gatherHandoff({
      hiveRoot: root, agentId: a.id, scratchRoot: hiveScratchRoot(), tasks: tasksOf(hive.tasks()) as BoardCard[], nowMs,
      extraDirs: repoHints(digest), fallbackDir: s?.cwd
    });
    const note = buildHandoff({
      agentName: a.name, from, to, resetAtMs, reason, nowMs, digest, ...gathered,
      stopDetail: reason === 'limit' ? agentLimitHit(a.id)?.message : undefined,
      logGap: logGapReason({ provider: s?.provider, hadSession: !!s, logPath: path, logChars: text.length })
    }, undefined, redactSecrets);
    writeFileSync(join(root, 'agents', a.id, 'handoff.md'), note, 'utf8');
  } catch (e) { console.error('[limit] handoff write failed:', e); }
}

function pushLimitWaits(): void {
  const waits: LimitWaits = {};
  for (const [id, w] of limitWaits) waits[id] = { provider: w.provider, ...(w.resetAtMs !== undefined ? { resetAtMs: w.resetAtMs } : {}) };
  try { liveWebContents()?.send('hive:limitWaits', waits); } catch { /* window torn down */ }
}

/**
 * One pass of the limit watch, every limitPollMs and shortly after each Stop:
 * 1. Record any usage-limit refusal in a live agent's session log as its engine being
 *    exhausted until the reset the refusal names.
 * 2. For each live agent on an exhausted engine, once its terminal is quiet: when its
 *    model list has an allowed entry on another engine with room, write the handoff and
 *    propose the switch to the renderer (hive:limitSwitchDue); otherwise hold it.
 * 3. Hold dormant agents none of whose entries has room, so they are not woken into
 *    a refusal.
 * 4. Release a hold once its reset plus RESUME_GRACE_MS has passed; a live agent then
 *    gets one "continue" prompt (hive:limitResume).
 */
let limitBeatRunning = false;

async function runLimitBeat(): Promise<void> {
  if (!hive.enabled() || limitBeatRunning) return;
  limitBeatRunning = true;
  try { await limitBeat(); await modelSwitcher.tick(); } finally { limitBeatRunning = false; }
}

async function limitBeat(): Promise<void> {
  const now = Date.now();
  const reg = hive.registry();
  ensureRefusalsLoaded();
  refreshAgyRefusals();
  /** Live agents whose own last turn was refused: they were mid-task. */
  const refused = new Set<string>();
  for (const [ptyId, agentId] of [...ptyToAgent]) {
    const s = liveSessions.get(agentId);
    if (!s || !ptyId) continue;
    const hit = await agentLimitHitAsync(agentId);
    if (!hit) continue;
    const engine = engineFor(s.provider, liveModelOf(agentId));
    if (engine && (restoredAt.get(engine) ?? 0) >= hit.atMs) continue;
    refused.add(agentId);
    if (!engine || s.provider === 'antigravity') continue;
    const until = hitUntil(hit);
    const prevHit = limitHits.get(engine);
    const before = prevHit?.untilMs ?? 0;
    const beforeAt = prevHit?.atMs ?? 0;
    if (until > now && (until > before || hit.atMs > beforeAt)) {
      limitHits.set(engine, { untilMs: Math.max(until, before), source: `${agentId}: ${hit.message.slice(0, 120)}`, atMs: Math.max(hit.atMs, beforeAt) });
      if (until > before) hive.appendLog({ kind: 'limit-hit', agentId, engine, resetAt: new Date(until).toISOString() });
    }
  }

  let beatTasks: ReturnType<typeof tasksOf> | null = null;
  const hasWork = (id: string): boolean => dormantWakeReason(id, beatTasks ??= tasksOf(hive.tasks()), hive.inbox(id)) !== null;

  const ALL_ENGINES: EngineId[] = ['codex', 'claude', 'agy', 'agy-claude', 'agy-argon'];
  const windows = engineWindows();
  const codexLimits = readCodexLimits();
  const ordinaryUsageAllowed = codexLimits?.ordinaryUsageAllowed;
  codexResetCreditNotices.check(codexLimits, now);
  reservationExpiryNotices.check(parseReservations(readConfig().reservations), now);
  claudeResetGrantNotices.check({ resetGrants: readClaudeResetGrants(now) }, now);

  for (const engine of ALL_ENGINES) {
    const spent = spentUntil(windows[engine], now);
    if (spent !== undefined) {
      const sampleAt = windows[engine]?.find((w) => w && typeof w.sampleAtMs === 'number')?.sampleAtMs ?? now;
      if ((restoredAt.get(engine) ?? 0) < sampleAt) {
        previouslyExhausted.set(engine, Math.max(previouslyExhausted.get(engine) ?? 0, sampleAt));
      }
    }
  }
  for (const [engine, ex] of limitHits) {
    previouslyExhausted.set(engine, Math.max(previouslyExhausted.get(engine) ?? 0, ex.atMs));
  }

  for (const engine of ALL_ENGINES) {
    const activeWaits = [...limitWaits.values()].filter((w) => w.engine === engine && !w.capacityRestored);
    const wasExhausted = previouslyExhausted.has(engine) || limitHits.has(engine) || activeWaits.length > 0;
    if (!wasExhausted) continue;
    const exhaustedAtMs = Math.max(
      previouslyExhausted.get(engine) ?? 0,
      limitHits.get(engine)?.atMs ?? 0,
      ...activeWaits.filter((w) => typeof w.atMs === 'number').map((w) => w.atMs!)
    );
    if (isCapacityRestored(engine, windows[engine], { ordinaryUsageAllowed, wasExhausted: true, exhaustedAtMs })) {
      const sampleAtMs = windows[engine]?.find((w) => w && typeof w.sampleAtMs === 'number')?.sampleAtMs ?? now;
      limitHits.delete(engine);
      previouslyExhausted.delete(engine);
      restoredAt.set(engine, Math.max(restoredAt.get(engine) ?? 0, sampleAtMs));
      const wokenAgents: string[] = [];
      for (const [id, w] of limitWaits) {
        if (w.engine !== engine) continue;
        w.capacityRestored = true;
        if (!closingTime.isActive() && canResumeLimitWait(w, { capacityRestored: true, nowMs: now, resumeAtMs: w.resumeAtMs })) {
          wokenAgents.push(id);
          limitWaits.delete(id);
          if (ptyForAgent(id) && (w.refused || hasWork(id))) {
            hive.appendLog({ kind: 'limit-resume', agentId: id, provider: w.provider });
            try { liveWebContents()?.send('hive:limitResume', { agentId: id, text: limitResumeText(w.provider, 'capacity-restored') }); } catch { /* window torn down */ }
          }
        }
      }
      const evt = createCapacityRestoredEvent(engine, now, {
        ...(engine === 'codex' && ordinaryUsageAllowed !== undefined ? { ordinaryUsageAllowed } : {}),
        ...(wokenAgents.length ? { wokenAgents } : {})
      });
      hive.appendLog(evt);
    }
  }

  const map = exhaustedEngines(now, windows);
  const readings = engineReadings(now);
  const { live, dormant } = limitRosterAgents();
  const before = JSON.stringify([...limitWaits.entries()]);
  const seen = new Set<string>();
  const thresholds = getEngineThresholds(readConfig());
  /** The agent's walk for its card, as entries and the tier group of each ('reserved' for a reserved one). */
  const walkOf = (a: LimitAgentView): { list: AgentModelEntry[]; groups: string[] } => {
    const w = a.pinned ? null : agentWalk(a, now);
    if (!w?.walk.length) return { list: [a.current], groups: [a.tier] };
    return { list: w.walk.map((x) => x.entry), groups: w.walk.map((x) => (x.preferred ? 'reserved' : x.tier)) };
  };
  const decide = (a: LimitAgentView, canSwitch: boolean) => {
    const { list, groups } = walkOf(a);
    const cands = list.map((e) => candidateFor(e, a.id));
    const pick = pickByTier(groups, cands, (l) => limitSwitchPick(l, readings, now, { thresholds }));
    const current = engineFor(a.current.provider, a.current.model);
    const rawNamed = a.current.provider === 'antigravity' ? (a.current.model ? agyRefusals.active(a.current.model, now) : agyRefusals.forAgent(a.id, undefined, now)) : undefined;
    const named = rawNamed && (!current || (restoredAt.get(current) ?? 0) < rawNamed.atMs) ? rawNamed : undefined;
    if (named && current) previouslyExhausted.set(current, Math.max(previouslyExhausted.get(current) ?? 0, named.atMs));
    const decision = named && !isExhausted(map, current, now)
      ? canSwitch && pick && !cands[pick.index].blocked
        ? { kind: 'switch' as const, index: pick.index }
        : { kind: 'wait' as const, untilMs: hitUntil(named) }
      : limitDecision(current, cands, pick, map, now, canSwitch);
    return { current, decision, list, until: named ? hitUntil(named) : current ? map[current]?.untilMs : undefined, atMs: named?.atMs ?? (current ? (limitHits.get(current)?.atMs ?? previouslyExhausted.get(current)) : undefined) };
  };
  // `locked`: no entry on the list has room, so only the reset frees it. The other holds
  // wait for a quiet terminal or for work, then switch, and are not worth a toast.
  const hold = (a: LimitAgentView, engine: EngineId, untilMs: number | undefined, locked: boolean, atMs?: number): void => {
    const prev = limitWaits.get(a.id);
    const effUntilMs = prev && prev.engine === engine && prev.resetAtMs !== undefined && untilMs === now + 1 ? prev.resetAtMs : untilMs;
    const resumeAtMs = effUntilMs !== undefined ? effUntilMs + RESUME_GRACE_MS : undefined;
    const wasRefused = refused.has(a.id) || !!prev?.refused;
    const waitAtMs = atMs ?? prev?.atMs ?? limitHits.get(engine)?.atMs ?? previouslyExhausted.get(engine) ?? now;
    if (!prev || prev.resumeAtMs !== resumeAtMs || prev.refused !== wasRefused || prev.atMs !== waitAtMs) {
      limitWaits.set(a.id, {
        provider: a.current.provider,
        engine,
        refused: wasRefused,
        atMs: waitAtMs,
        ...(prev?.capacityRestored ? { capacityRestored: true } : {}),
        ...(effUntilMs !== undefined ? { resetAtMs: effUntilMs, resumeAtMs } : {})
      });
    }
    if (!prev) hive.appendLog({ kind: 'limit-hold', agentId: a.id, engine, resetAt: effUntilMs ? new Date(effUntilMs).toISOString() : undefined });
    if (locked) limitLockNotices.held(a.id, a.name, a.current.provider, effUntilMs);
  };
  // Spawn-request workers are not on the roster; they run their one engine to the end.
  const offRoster: LimitAgentView[] = [];
  for (const agentId of ptyToAgent.values()) {
    const s = liveSessions.get(agentId);
    if (!s || live.some((a) => a.id === agentId)) continue;
    const current: AgentModelEntry = { provider: s.provider };
    offRoster.push({ id: agentId, name: reg.agents[agentId]?.name ?? agentId, isGod: false, pinned: true, current, tier: 'medium', walk: [current] });
  }
  for (const a of [...live, ...offRoster]) {
    const ptyId = ptyForAgent(a.id);
    if (!ptyId) continue;
    seen.add(a.id);
    if (pendingSwitches.has(a.id)) {
      const p = pendingSwitches.get(a.id)!;
      if (p.manual || now - p.proposedAt < SWITCH_REPROPOSE_MS) continue;
      pendingSwitches.delete(a.id);
    }
    const r = reg.agents[a.id];
    const canSwitch = !a.pinned && !liveWorkers.has(ptyId) && !r?.onHold;
    const { current, decision, list, until, atMs } = decide(a, canSwitch);
    if (decision.kind === 'ok') continue;
    if (decision.kind === 'wait') { hold(a, current!, decision.untilMs, true, atMs); continue; }
    // A meter at 100% with the agent idle and nothing to do: hold it rather than start a
    // fresh session for no work.
    if (!refused.has(a.id) && !hasWork(a.id)) { hold(a, current!, until, false, atMs); continue; }
    // Never cut a turn that is still producing output; a refused turn goes quiet at once.
    const quiet = now - (ptyManager.lastOutputAt(ptyId) ?? 0) >= WORKER_WAKE_IDLE_MS;
    if (!quiet || closingTime.isActive()) { hold(a, current!, until, false, atMs); continue; }
    const to = entryLabel(list[decision.index]);
    const from = entryLabel(a.current);
    const resetAtMs = until;
    limitWaits.delete(a.id);
    pendingSwitches.set(a.id, { from, to, resetAtMs, proposedAt: now });
    await writeHandoff(a, from, to, resetAtMs);
    try { liveWebContents()?.send('hive:limitSwitchDue', { agentId: a.id, isGod: a.isGod }); } catch { /* window torn down */ }
    console.log('[limit] proposing switch', a.id, from, '->', to);
  }
  for (const a of dormant) {
    seen.add(a.id);
    const { list } = walkOf(a);
    const engines = list.map((e) => engineFor(e.provider, e.model));
    if (list.every((entry, i) => isExhausted(map, engines[i], now) || refusedEntry(entry, now, a.id))) {
      const soonest = Math.min(...list.map((entry, i) => Math.max(map[engines[i]!]?.untilMs ?? 0,
        entry.provider === 'antigravity' ? hitUntil((entry.model ? agyRefusals.active(entry.model, now) : agyRefusals.forAgent(a.id, undefined, now)) ?? { atMs: 0, message: '' }) : 0)));
      hold(a, engines[0]!, soonest, true);
    } else if (!closingTime.isActive() && limitWaits.has(a.id)) {
      const w = limitWaits.get(a.id)!;
      const hasAlt = list.some((entry, i) => engines[i] !== w.engine && !isExhausted(map, engines[i], now) && !refusedEntry(entry, now, a.id));
      if (hasAlt || canResumeLimitWait(w, { capacityRestored: w.capacityRestored === true, nowMs: now, resumeAtMs: w.resumeAtMs })) {
        limitWaits.delete(a.id);
      }
    }
  }
  for (const [id, w] of limitWaits) {
    if (!seen.has(id)) { limitWaits.delete(id); continue; }
    const entry = [...live, ...dormant].find((a) => a.id === id)?.current;
    if ((entry && refusedEntry(entry, now, id)) || isExhausted(map, w.engine, now) || !canResumeLimitWait(w, { capacityRestored: w.capacityRestored === true, nowMs: now, resumeAtMs: w.resumeAtMs })) continue;
    // A resume restarts the agent's work; the wait stays until closing time ends or is cancelled.
    if (closingTime.isActive()) continue;
    limitWaits.delete(id);
    if (ptyForAgent(id) && (w.refused || hasWork(id))) {
      hive.appendLog({ kind: 'limit-resume', agentId: id, provider: w.provider });
      try { liveWebContents()?.send('hive:limitResume', { agentId: id, text: limitResumeText(w.provider, w.capacityRestored ? 'capacity-restored' : undefined) }); } catch { /* window torn down */ }
    }
  }
  for (const id of pendingSwitches.keys()) if (!ptyForAgent(id)) { pendingSwitches.delete(id); modelSwitcher.completed(id); checkpointRestarts.delete(id); }
  for (const r of agyRefusals.pendingNotices()) {
    if (hitUntil(r) <= now) { agyRefusals.markNotified(r); continue; }
    const id = `quota-${noticeKey(r)}-${r.source}`;
    const inbox = hive.root() ? join(hive.root()!, 'agents', reg.godId ?? 'god', 'inbox') : null;
    if (inbox && (existsSync(join(inbox, `${id}.json`)) || existsSync(join(inbox, '.done', `${id}.json`)))) {
      agyRefusals.markNotified(r); continue;
    }
    hive.send({ id, to: 'boss', act: 'inform', subject: `Quota refusal: ${r.agentId}`,
      body: `${r.agentId}: antigravity/${r.model} refused work (${r.errorId}); resets ${new Date(hitUntil(r)).toISOString()}. Source: ${r.source}; first seen ${new Date(r.seenAtMs).toISOString()}; switch pending: ${pendingSwitches.has(r.agentId)}.`,
      requires_reply: false }, 'harness');
    agyRefusals.markNotified(r);
  }
  for (const a of [...live, ...dormant]) {
    const paused = reg.agents[a.id]?.onHold || closingTime.isActive();
    const usage = telemetry.snapshot().usage.find((u) => u.agentId === a.id)
      ?? offTranscriptUsage(a.id, reg.agents[a.id]?.provider, reg.agents[a.id]?.sessionId);
    const activity = Math.max(lastWorkAt(a.id), modelActivityAt(a.id, usage ? usage.input + usage.output + usage.cacheRead + usage.cacheCreation : 0, now), liveSessions.get(a.id)?.atMs ?? 0);
    if (noProgressWatch.check(a.id, !paused && hasWork(a.id), activity, now)) {
      hive.send({ to: 'boss', act: 'inform', subject: `No model progress: ${a.name}`,
        body: `${a.id} has pending work and ${noProgressReason(reg.agents[a.id]?.provider, !!usage)} for 10 minutes. Quota blocked: ${limitHeld(a.id) || refusedEntry(a.current, now, a.id)}; switch pending: ${pendingSwitches.has(a.id)}. Inspect fleet.json and the agent's inbox.`, requires_reply: false }, 'harness');
    }
  }
  limitLockNotices.keepOnly(limitWaits.keys());
  if (JSON.stringify([...limitWaits.entries()]) !== before) pushLimitWaits();
}

// The DB reader supplies absolute timestamps even when terminal frames were missed.
ptyManager.setOutputObserver((ptyId, data) => {
  const agentId = ptyToAgent.get(ptyId);
  if (!agentId || liveSessions.get(agentId)?.provider !== 'antigravity') return;
  let terminal = refusalTerminals.get(ptyId);
  if (!terminal) { terminal = new AgyRefusalTerminal(); refusalTerminals.set(ptyId, terminal); }
  const geometry = ptyManager.geometry(ptyId);
  if (geometry) terminal.resize(geometry.cols, geometry.rows);
  terminal.write(data, (r) => {
    if (ptyToAgent.get(ptyId) !== agentId) return;
    const model = liveModelOf(agentId);
    if (!r || !model || (r.resetInMs === undefined && !r.errorId)) return;
    try {
      ensureRefusalsLoaded();
      agyRefusals.terminal(agentId, model, r, Date.now());
      scheduleLimitBeat(500);
    } catch (e) { console.error('[limit] terminal refusal failed:', e); }
  });
});

function scheduleLimitBeat(delayMs = 1500): void {
  if (limitStopTimer) return;
  limitStopTimer = setTimeout(() => {
    limitStopTimer = null;
    void runLimitBeat().catch((e) => console.error('[limit beat]', e));
  }, delayMs);
}

/** The model the agent's live session runs, from its roster entry (the Boss's from config). */
function liveModelOf(agentId: string): string | undefined {
  const { live } = limitRosterAgents();
  return live.find((a) => a.id === agentId)?.current.model
    ?? agyRefusals.forAgent(agentId, undefined, Date.now())?.model;
}

ipcMain.handle('hive:limitWaits', (): LimitWaits => {
  const out: LimitWaits = {};
  for (const [id, w] of limitWaits) out[id] = { provider: w.provider, ...(w.resetAtMs !== undefined ? { resetAtMs: w.resetAtMs } : {}) };
  return out;
});

/** The renderer carries out a proposed limit switch: main ends the session the dormant
 *  way (worktree kept, registry dormant), and the renderer moves the card to the
 *  restorable list and wakes it, which balances it onto the new engine. */
ipcMain.handle('hive:limitSwitch', (evt, agentId: unknown): { ok: boolean; error?: string } => {
  if (typeof agentId !== 'string' || isDesktopSender(evt.sender)) return { ok: false, error: 'invalid' };
  const p = pendingSwitches.get(agentId);
  const ptyId = ptyForAgent(agentId);
  if (!p || !ptyId) return { ok: false, error: 'no switch pending' };
  if (closingTime.isActive()) return { ok: false, error: 'wrap-up' };
  pendingSwitches.delete(agentId);
  ptyManager.kill(ptyId);
  teardownPty(ptyId, { dormant: true });
  hive.appendLog({ kind: p.manual ? 'model-switch' : 'limit-switch', agentId, from: p.from, to: p.to, resetAt: p.resetAtMs ? new Date(p.resetAtMs).toISOString() : undefined });
  console.log(p.manual ? '[model] switched' : '[limit] switched', agentId, p.from, '->', p.to);
  modelSwitcher.completed(agentId);
  checkpointRestarts.delete(agentId);
  return { ok: true };
});

/** Polling cadence — matches the hive router. */
/** Re-entrancy guard so a slow tick (await spawn / git checks) never overlaps. */
let workerTickRunning = false;

/** HIVE_ROOT/spawn-requests — the queue dir god drops requests into. */
function spawnRequestsDir(): string | null {
  const root = hive.root();
  return root ? join(root, 'spawn-requests') : null;
}

/** Move a processed request out of the queue so it's never reprocessed. */
function archiveRequest(filePath: string, sub: '.done' | '.failed'): void {
  const queue = spawnRequestsDir();
  try {
    if (!queue) throw new Error('no hive root');
    const dir = join(queue, sub);
    mkdirSync(dir, { recursive: true });
    renameSync(filePath, join(dir, basename(filePath)));
  } catch (e) {
    // Last resort: delete it so a poison file can't loop forever.
    try { unlinkSync(filePath); } catch { /* noop */ }
    console.error('[worker] archiveRequest failed:', e);
  }
}

/** Did this worker post a terminal `act:"done"` yet? Scans its own outbox AND
 *  outbox/.sent (the router archives delivered mail there ~every 1.5s), so the
 *  signal is caught whether or not it's been routed out yet.
 *
 *  Stale-done guard: agent dirs persist after teardown, so REUSING a reqId would
 *  leave a PRIOR worker's `done` sitting in this same dir. Without a guard that
 *  stale signal would release the new worker on its very first tick — before it
 *  does anything or replies — causing a silent Slack hang. So we only count a
 *  `done` authored AFTER this worker spawned: by its `created_at` (the message's
 *  own timestamp), falling back to the file's mtime when `created_at` is missing
 *  or unparseable. When neither yields a usable timestamp we DON'T count it
 *  (fail toward keeping the worker alive — the idle reaper is the backstop). */
function workerSignaledDone(workerId: string, spawnedAt: number): boolean {
  const root = hive.root();
  if (!root) return false;
  const base = join(root, 'agents', workerId, 'outbox');
  for (const dir of [base, join(base, '.sent')]) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fp = join(dir, f);
      try {
        const msg = JSON.parse(readFileSync(fp, 'utf8')) as { act?: string; created_at?: string };
        if (msg.act !== 'done') continue;
        let ts = Date.parse(msg.created_at ?? '');
        if (!Number.isFinite(ts)) {
          try { ts = statSync(fp).mtimeMs; } catch { ts = NaN; }
        }
        if (Number.isFinite(ts) && ts > spawnedAt) return true;
      } catch { /* skip unreadable/partial */ }
    }
  }
  return false;
}

/** Spin up one ephemeral worker from a spawn-request. Terminal failures (bad
 *  request, missing CLI, spawn error) archive to .failed and inform god WITH the
 *  Slack coords so god can post a 'couldn't start' reply. On success the worker is
 *  registered (for done-scan / reaping / safe teardown) and dispatched its
 *  objective via the standard inbox path. */
async function processSpawnRequest(filePath: string): Promise<void> {
  let raw: SpawnRequest;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8')) as SpawnRequest;
  } catch (e) {
    console.error('[worker] unparseable spawn-request:', filePath, e);
    informGod('[worker spawn rejected] unparseable request', `Could not parse spawn-request ${basename(filePath)} — ${String(e)}`);
    archiveRequest(filePath, '.failed');
    return;
  }
  const slack = raw.slack && typeof raw.slack.channel === 'string' && typeof raw.slack.thread_ts === 'string'
    ? { channel: raw.slack.channel, thread_ts: raw.slack.thread_ts } : undefined;
  const fail = (reason: string): void => {
    informGod(`[worker spawn rejected] ${reason}`, `Spawn-request ${basename(filePath)} rejected: ${reason}.`, slack);
    archiveRequest(filePath, '.failed');
  };

  const objective = typeof raw.objective === 'string' ? raw.objective.trim() : '';
  if (!objective) { fail('missing "objective"'); return; }

  const reqId = (typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : basename(filePath).replace(/\.json$/i, ''))
    .replace(/[^A-Za-z0-9._-]/g, '-');
  const workerId = `worker-${reqId}`;
  if (liveWorkers.has(workerId)) { fail(`worker "${workerId}" already running`); return; }

  // Worker request files are hand/LLM-authored, so `~/…` shows up here too — expand
  // before the existence check (Node reads `~` literally).
  const cwd = typeof raw.cwd === 'string' && raw.cwd.trim() ? expandTilde(raw.cwd) : '';
  if (!cwd || !existsSync(cwd)) { fail(`"cwd" missing or not found (${cwd || 'unset'})`); return; }

  // Request line → executable + argv (auto-mode inheritance, tokenization,
  // model-flag dedupe). Pure and unit-tested — see workerLaunch.ts for why this
  // translation earned a test.
  const cfgSpawn = readConfig();
  let engineNote = '';
  if (raw.difficulty !== undefined && !isDifficulty(raw.difficulty)) { fail(`"difficulty" must be one of ${DIFFICULTIES.join(', ')}`); return; }
  const difficulty = raw.difficulty;
  if (raw.kind !== undefined && !isWorkKind(raw.kind)) { fail(`"kind": ${workKindError(raw.kind)}`); return; }
  const engineTable = getEngines(cfgSpawn);
  const difficultyOrder = engineOrderFor(parseEngineList(raw.engines), difficulty, (ref) => isWeakModel(engineTable[engineRefId(ref)]?.model));
  const reservedEngines = applyReservations(difficultyOrder, parseReservations(cfgSpawn.reservations), raw.kind, Date.now(), (ref) => engineTable[engineRefId(ref)]);
  if (reservedEngines.blocked && !raw.command && !raw.provider) { fail(`no engine is free for this request: ${reservedEngines.blocked}`); return; }
  if (raw.command || raw.provider) {
    const named = applyReservations([{ provider: inferAgentProvider(raw.command, raw.provider), model: raw.model }], parseReservations(cfgSpawn.reservations), raw.kind, Date.now());
    if (named.blocked) { fail(`the named provider is reserved: ${named.blocked}`); return; }
  }
  const engines = reservedEngines.list;
  if (engines.length && !raw.command && !raw.provider) {
    const pick = chooseEngine(engines, engineReadings(Date.now(), cfgSpawn), (p) => ptyManager.isCommandAvailable(providerPreset(p).defaultCommand), (e) => refusedEntry({ provider: e.provider, model: raw.model ?? e.model }), { engines: cfgSpawn.engines, thresholds: getEngineThresholds(cfgSpawn) });
    if (!pick) { fail(`none of the requested engines (${engines.map(engineRefId).join(', ')}) is installed and free of known refusals`); return; }
    raw.provider = pick.engine.provider;
    raw.command = providerPreset(pick.engine.provider).defaultCommand;
    if (pick.engine.model && !raw.model) raw.model = pick.engine.model;
    engineNote = `engine ${pick.engine.id}: ${pick.reason}${reservedEngines.notes.length ? `; ${reservedEngines.notes.join('; ')}` : ''}`;
  }
  const namedModel = resolveNamedModel(inferAgentProvider(raw.command, raw.provider), raw.model);
  raw.model = namedModel.model;
  const modelNote = namedModel.note ?? '';
  let launch: ReturnType<typeof buildWorkerLaunch>;
  try {
    launch = buildWorkerLaunch({
      requestCommand: raw.command,
      requestProvider: raw.provider,
      requestModel: raw.model,
      defaultCommand: cfgSpawn.defaultCommand,
      autoMode: !!cfgSpawn.autoMode
    });
  } catch (e) { fail(e instanceof Error ? e.message : String(e)); return; }
  const bin = launch.bin;
  // Validate the executable name on the spawn path. A spawn-request file is
  // untrusted input (authored by the orchestrator, reachable by anything that can
  // write HIVE_ROOT/spawn-requests), so the bin must be a plain command token or
  // an absolute path — never a string a downstream shell `which`/`where` could
  // reinterpret. Rejected here, before any resolution; the resolver guards behind
  // it validate the same thing in depth.
  if (!isSafeCommandName(bin) && !isAbsolute(bin)) {
    fail(`refusing spawn: engine command "${bin}" is not a plain command name or an absolute path`);
    return;
  }
  // Missing-CLI → FAIL FAST. A headless worker has no human to watch an installer,
  // so we never run the cc49e1e install banner here — we reject and tell god.
  if (!ptyManager.isCommandAvailable(bin)) { fail(`engine CLI "${bin}" is not installed`); return; }

  const isolate = raw.isolate !== false; // default true
  // Base branch the worktree will be cut from (for the ahead-of-base safety check).
  let baseBranch = 'main';
  try { const br = await getBranch(cwd); if ('current' in br && br.current) baseBranch = br.current; } catch { /* keep default */ }

  const meta: AgentMeta = {
    id: workerId,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Worker ${reqId.slice(0, 12)}`,
    provider: raw.provider,
    role: 'worker',
    cwd
  };
  // Phase 2: grant this worker a broker capability over the currently-enabled
  // integrations and inject the broker URL + a per-worker capability TOKEN (a handle,
  // never a secret) into its env, so it can reach registered REST integrations through
  // the loopback secret broker without ever seeing a credential. Only when the broker
  // is up; the grant is revoked in teardownPty (and below if the spawn fails).
  const brokerEnv: Record<string, string> = {};
  if (integrationBroker.running()) {
    const token = integrationBroker.grant(workerId, integrations.enabledIds());
    brokerEnv.MD_BROKER_URL = integrationBroker.url();
    brokerEnv.MD_BROKER_TOKEN = token;
  }
  const spawnOpts: AgentSpawnOptions = {
    id: workerId, cwd, command: bin, cols: 120, rows: 32,
    args: launch.args,
    hive: meta, isolate, difficulty, provider: raw.provider, env: brokerEnv
  };

  let res: { ok: boolean; error?: string; worktreePath?: string };
  try {
    res = await spawnAgentCore(spawnOpts, liveWebContents());
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (!res.ok) { integrationBroker.revoke(workerId); fail(`spawn failed — ${res.error ?? 'unknown error'}`); return; }

  // A god-hired worker is a MAIN-initiated spawn, so the renderer would never
  // card it on its own (same reason as the voice-spawn broadcast): without this
  // the worker is invisible on the floor, never enters the roster, and after a
  // restart nothing offers to restore it. The card rides the normal agent
  // lifecycle from here — teardownPty broadcasts the matching archive. A card
  // RESTORED after an app quit revives through the renderer's normal spawn path
  // and never re-enters liveWorkers: ephemerality is a property of the hiring,
  // not of the card, so a restored worker is a regular agent (no reaping).
  try {
    liveWebContents()?.send('hive:agentSpawned', {
      id: workerId,
      name: meta.name,
      provider: raw.provider ?? 'claude',
      cwd: res.worktreePath ?? cwd,
      command: launch.command,
      role: meta.role,
      worktreePath: res.worktreePath,
      character: typeof raw.character === 'string' ? raw.character : undefined,
      accent: typeof raw.accent === 'string' ? raw.accent : undefined
    });
  } catch { /* window torn down */ }

  // Register for done-scan / idle-reap / token-cap / safe teardown (pty id == workerId).
  // tokenCap is optional plumbing (default unlimited) — only a positive finite cap is kept.
  const tokenCap = typeof raw.tokenCap === 'number' && Number.isFinite(raw.tokenCap) && raw.tokenCap > 0
    ? raw.tokenCap : undefined;
  const effort = spawnedEffort.get(workerId) ?? 'default';
  liveWorkers.set(workerId, { workerId, reqId, name: meta.name, slack, baseBranch, spawnedAt: Date.now(), tokenCap, difficulty, effort });
  appendEngineLedger({
    kind: 'start', workerId, objective: objective.slice(0, 200),
    provider: raw.provider ?? inferAgentProvider(launch.command), model: raw.model,
    chosenBy: engineNote ? 'ladder' : 'named', engines: engines.length ? engines : undefined,
    reason: engineNote || undefined, difficulty, effort, usage: engineUsage()
  });

  // Dispatch the objective via the standard inbox path (zero new transport),
  // reusing the autonomous-request preamble so the worker gets the exact Slack
  // reply command + autonomy policy. `from: god` so the worker treats it as a god
  // dispatch per its protocol.
  try {
    const prefix = slack
      ? buildAutonomousRequestProtocol(slack.channel, slack.thread_ts, slackReplyScriptPath())
      : '[AUTONOMOUS WORKER TASK — no interactive human is watching. Work autonomously; do not ask interactive questions.] The task starts now: ';
    const suffix = `\n\n[CAPABILITIES] Before you start, consult your capability catalog — run the \`/capabilities\` skill (or read \`$AGENT_DIR/.claude/skills/capabilities/SKILL.md\`). It lists your temporal date-range skills (\`/today\`, \`/last30Days\`, \`/lastQuarter\`, …) and the integrations available to you (reached via the loopback broker) and how to call each. For any time-scoped work, resolve the dates with those skills instead of computing them by hand.\n\n[WORKER COMPLETION] When finished, signal done by sending ONE outbox message to the Boss ("to":"boss") with "act":"done" and a short result summary — that releases this ephemeral worker (terminal closed; your branch is handed to the Boss). Do NOT push to any remote; the Boss is the sole integrator.`;
    hive.send({ to: workerId, conversation: `worker-${reqId}`, act: 'request', subject: meta.name, body: `${prefix}${objective}${suffix}` }, 'god');
  } catch (e) {
    console.error('[worker] dispatch send failed:', e);
  }

  const spawnNotes = [engineNote, modelNote].filter(Boolean).join('; ');
  console.log(`[worker] spawned ${workerId} (cwd=${cwd}, base=${baseBranch}${slack ? ', slack' : ''}${spawnNotes ? `, ${spawnNotes}` : ''})`);
  if (spawnNotes) informGod(`[worker spawned] ${meta.name} on ${raw.provider}`, `${workerId}: ${spawnNotes}.`, slack);
  archiveRequest(filePath, '.done');
}

/** Total tokens (input+output+cache) a worker has burned so far, from the usage
 *  provider — 0 when unknown. Mirrors the breaker's `tokensOf`. Used only by the
 *  (default-off) per-worker token cap. */
function workerTokensUsed(workerId: string): number {
  const s = usageProvider.getAgentUsage(workerId);
  return s ? s.input + s.output + s.cacheRead + s.cacheCreation : 0;
}

/** Throttle for the GC sweep — git checks are cheap but pointless every 1.5s tick. */
let lastGcSweepAt = 0;
let gcSweepRunning = false;

/** Reclaim preserved worker worktrees (+ their scratch dirs) whose work is now
 *  integrated, or whose worktree was already removed by hand. Fail-safe: a worktree
 *  is removed ONLY when `worktreeIsGcSafe` proves it clean AND integrated; any doubt
 *  KEEPS it (never discards un-integrated work — god is the sole integrator). Runs
 *  inside the worker tick, throttled to gcSweepMs, and is a no-op when nothing is
 *  preserved (the common case → zero cost). */
async function gcPreservedWorktrees(): Promise<void> {
  if (gcSweepRunning || preservedWorktrees.size === 0) return;
  gcSweepRunning = true;
  try {
    for (const [key, e] of [...preservedWorktrees]) {
      // A worker id that is live again (reqId reuse) → never GC its worktree or
      // scratch out from under the new run; leave the stale entry for a later sweep.
      if (liveWorkers.has(e.workerId)) continue;
      // (a) Worktree already gone (removed at clean teardown, or god removed it by
      //     hand per the preserve note) → just reclaim the scratch dir + drop tracking.
      if (!existsSync(e.wtPath)) {
        removeWorkerScratch(e.workerId);
        preservedWorktrees.delete(key);
        console.log(`[worker gc] ${e.workerId}: worktree already gone — reclaimed scratch`);
        continue;
      }
      // (b) Still on disk → reclaim ONLY when provably integrated + clean.
      const deps = await unlinkWorktreeDeps(e.origCwd, e.wtPath);
      if (!deps.ok) { console.error('[worker gc] dependency unlink failed (keeping):', deps.error); continue; }
      let safe: { gc: boolean; detail: string };
      try { safe = await worktreeIsGcSafe(e.wtPath, e.baseBranch); }
      catch (err) { console.error('[worker gc] gc-safe check threw (keeping):', err); continue; }
      if (!safe.gc) continue; // keep — fail-safe
      const r = await removeWorktree(e.origCwd, e.wtPath);
      if (!r.ok) { console.error(`[worker gc] removeWorktree failed (keeping ${e.workerId}):`, r.error); continue; }
      removeWorkerScratch(e.workerId);
      preservedWorktrees.delete(key);
      console.log(`[worker gc] reclaimed ${e.workerId} (${safe.detail})`);
      informGod(
        `[worker worktree reclaimed] ${e.workerId}`,
        renderMessageTemplate(hive.root(), 'workerWorktreeReclaimed', { workerId: e.workerId, detail: safe.detail, wtPath: e.wtPath }, BUNDLED_MESSAGE_TEMPLATES.workerWorktreeReclaimed),
        e.slack
      );
    }
  } finally {
    gcSweepRunning = false;
  }
}

/** One controller tick: (1) finish/reap live workers (frees slots), then (2) pull
 *  new requests up to the concurrency cap. Order matters so a freed slot is reused
 *  the same tick. */
async function ephemeralWorkerTick(): Promise<void> {
  if (workerTickRunning) return;
  workerTickRunning = true;
  try {
    const cfg = readConfig();
    const maxWorkers = Math.max(1, cfg.maxConcurrentWorkers ?? 4);
    const idleTimeoutMs = Math.max(1, cfg.workerIdleTimeoutMinutes ?? 20) * 60_000;
    // Per-worker token cap. 0 = UNLIMITED (the default — wired but never throttles
    // unless a positive cap is set per-request or via defaultWorkerTokenCap).
    const defaultTokenCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0
      ? cfg.defaultWorkerTokenCap : 0;

    // (1) Finish or reap. Each release calls teardownPty EXPLICITLY after the
    //     kill, like every other kill site: ptyManager.kill() deletes the session
    //     synchronously, so when node-pty's async onExit later fires it fails the
    //     session-identity guard and the global exit handler (→ teardownPty)
    //     never runs. Relying on onExit here left released workers un-torn-down:
    //     no hive archive, no hive:agentArchived, frozen floor cards, and god
    //     kept mailing dead agents (seen live 2026-08-16 with worker-business/
    //     worker-qa/worker-bizreview). A double teardown is a harmless no-op.
    for (const [workerId, rec] of [...liveWorkers]) {
      if (rec.releasing) continue;
      if (workerSignaledDone(workerId, rec.spawnedAt)) {
        // Success: the worker already replied in-thread; just release it.
        rec.releasing = true;
        rec.outcome = 'done';
        console.log(`[worker] ${workerId} signaled done — releasing`);
        ptyManager.kill(workerId);
        teardownPty(workerId);
        continue;
      }
      // Token-cap reap (default-off plumbing). An effective cap > 0 → reap when the
      // worker's cumulative token use exceeds it; its committed work is preserved.
      const tokenCap = (rec.tokenCap && rec.tokenCap > 0) ? rec.tokenCap : defaultTokenCap;
      if (tokenCap > 0) {
        const used = workerTokensUsed(workerId);
        if (used > tokenCap) {
          rec.releasing = true;
          rec.outcome = 'reaped-token-cap';
          console.warn(`[worker] reaping ${workerId} — token cap (${used.toLocaleString()} > ${tokenCap.toLocaleString()})`);
          informGod(
            `[worker reaped — token cap] ${workerId}`,
            renderMessageTemplate(hive.root(), 'workerReapedTokenCap', { workerId, used: used.toLocaleString(), tokenCap: tokenCap.toLocaleString() }, BUNDLED_MESSAGE_TEMPLATES.workerReapedTokenCap),
            rec.slack
          );
          ptyManager.kill(workerId);
          teardownPty(workerId);
          continue;
        }
      }
      const rawIdleMs = ptyManager.idleFor(workerId);
      if (rawIdleMs === undefined) continue; // PTY already gone; teardownPty cleans up
      const agentId = ptyToAgent.get(workerId) ?? workerId;
      const isHeld = limitWaits.has(agentId);
      rec.holdClock = advanceHoldClock(rec.holdClock ?? { heldMs: 0 }, isHeld, rawIdleMs, Date.now());
      const idleMs = idleOutsideHold(rawIdleMs, rec.holdClock);
      if (!isHeld && idleMs > idleTimeoutMs) {
        rec.releasing = true;
        rec.outcome = 'reaped-idle';
        console.warn(`[worker] reaping idle ${workerId} (${Math.round(idleMs / 60000)}min idle)`);
        informGod(
          `[worker reaped — idle] ${workerId}`,
          renderMessageTemplate(hive.root(), 'workerReapedIdle', { workerId, idleMinutes: Math.round(idleMs / 60000), capMinutes: Math.round(idleTimeoutMs / 60000) }, BUNDLED_MESSAGE_TEMPLATES.workerReapedIdle),
          rec.slack
        );
        ptyManager.kill(workerId);
        teardownPty(workerId);
      }
    }

    // (2) Process new requests, honoring the concurrency cap (backpressure: leave
    //     the rest in the queue for a later tick).
    //
    //     Gated on config.orchestratorMaySpawn (default OFF): letting the
    //     orchestrator spin up agents unprompted is a SPEND decision, so the
    //     operator opts in. The gate sits HERE, on intake, and not on the watcher
    //     itself, because step (1) above owns the lifecycle of workers that are
    //     already running — reaping, teardown, the Slack failure notice — and
    //     turning the toggle off mid-flight must not strand them.
    //
    //     Declining also means declining to CONSUME. A request dropped in while
    //     this is off stays in the queue and runs when it is turned on, rather
    //     than being eaten and failed for a reason god never asked about.
    const dir = readConfig().orchestratorMaySpawn ? spawnRequestsDir() : null;
    if (dir && existsSync(dir)) {
      let files: string[] = [];
      try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { /* dir vanished */ }
      for (const f of files) {
        if (liveWorkers.size >= maxWorkers) break;
        await processSpawnRequest(join(dir, f));
      }
    }

    // (3) GC preserved worktrees whose work has since integrated. Throttled to
    //     gcSweepMs and a no-op when nothing is preserved (the common case).
    const now = Date.now();
    if (preservedWorktrees.size > 0 && now - lastGcSweepAt >= liveTimings().gcSweepMs) {
      lastGcSweepAt = now;
      await gcPreservedWorktrees();
    }
  } catch (e) {
    console.error('[worker] tick error:', e);
  } finally {
    workerTickRunning = false;
  }
}

function startEphemeralWorkerWatcher(): void {
  if (liveTimers.workerWatchTimer || !hive.enabled()) return;
  const dir = spawnRequestsDir();
  if (dir) { try { mkdirSync(dir, { recursive: true }); } catch { /* noop */ } }
  armLive(liveTimers, 'workerWatchTimer', () => { void ephemeralWorkerTick(); });
}

// ─── Drop folders ───────────────────────────────────────────────────────────
// Folders under <hive> whose pending files become mail (vault-inbox → keeper,
// card-proposals → Boss, plus any lane added to config.dropFolders). Mail is what
// starts a dormant agent and nudges a live idle one (main/dropFolders.ts).
const dropFolderWatcher = new DropFolderWatcher(
  () => hive.root(),
  () => getDropFolders(readConfig()),
  (msg, source) => { hive.send(msg, source); },
  () => closingTime.isActive(),
  (id) => id === 'boss' || id === 'broadcast' || !!hive.registry().agents[id]
);
function startDropFolderWatcher(): void {
  if (!hive.enabled()) return;
  dropFolderWatcher.start();
}

// ─── Relayed ASK ME answers ─────────────────────────────────────────────────
// answer_ask on the camp-propose MCP queues into <hive>/ask-answers/; this applies
// each one through the same patchTask + routeHumanAnswer path as hive:humanAnswer.
const ASK_RELAY_POLL_MS = 5_000;
function askRelayTick(): void {
  const root = hive.root();
  if (!hive.enabled() || !root) return;
  try {
    applyAskAnswers(root, {
      tasks: () => hive.tasks(),
      patchTask: (id, patch) => hive.patchTask(id, patch as Partial<Omit<HiveTask, 'id'>>),
      routeAnswer: (id, q, a) => { hive.routeHumanAnswer(id, q, a); },
      reject: (relay, reason) => {
        hive.send({
          to: 'boss', act: 'inform', subject: `Relayed ASK ME answer not applied: ${relay.cardId}`,
          body: `A session outside the hive (${relay.source || 'unknown folder'}) relayed the human's answer through camp-propose answer_ask, but ${reason}.\nQ: ${relay.q}\nA: ${relay.answer}\nApply it by hand if it still holds.`
        }, 'harness');
      }
    });
  } catch (e) {
    console.error('[ask-relay]', e);
  }
}

// ─── Unity broker ───────────────────────────────────────────────────────────
// Agents with the unity flag drop requests into agents/<id>/unity-requests/; main
// runs Unity in batch mode inside a GPU-passing bwrap (main/unityBroker.ts).
const unityBroker = new UnityBroker({
  hiveRoot: () => hive.root(),
  agent: (id) => hive.brokerAgent(id),
  notify: (id, subject, body) => {
    hive.send({ to: id, act: 'inform', subject, body, requires_reply: false }, 'unity-broker');
  },
  log: (event) => hive.appendLog(event),
  editorRoot: () => readConfig().unityEditorRoot,
  maxConcurrent: () => readConfig().unityMaxConcurrent,
  minMemAvailableGb: () => readConfig().unityMinMemAvailableGb,
  maxMemPressureAvg10: () => readConfig().unityMaxMemPressureAvg10,
  agentCooldownSec: () => readConfig().unityAgentCooldownSec,
  resultsRoot: () => hiveScratchRoot(),
  earlyoomJournal: (sinceMs) => new Promise<string>((resolve, reject) => {
    execFile('journalctl', earlyoomJournalArgs(sinceMs),
      { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  })
});
function startUnityBroker(): void {
  if (liveTimers.unityBrokerTimer || !hive.enabled() || process.platform !== 'linux') return;
  armLive(liveTimers, 'unityBrokerTimer', () => { void unityBroker.tick(); });
  setTimeout(pruneOldUnityResults, UNITY_RESULTS_PRUNE_FIRST_DELAY_MS);
  setInterval(pruneOldUnityResults, UNITY_RESULTS_PRUNE_EVERY_MS);
}

const UNITY_RESULTS_PRUNE_FIRST_DELAY_MS = 5 * 60_000;
function pruneOldUnityResults(): void {
  try {
    const r = pruneUnityResults(unityResultsDirs(hive.root(), hiveScratchRoot()), Date.now());
    hive.appendLog({
      kind: 'unity-results-prune',
      deleted: r.deleted.map((d) => d.path),
      freedGB: Math.round(r.freedBytes / 1e7) / 100,
      kept: r.kept,
      ...(r.errors.length ? { errors: r.errors } : {})
    });
  } catch (e) { console.error('[unity-results prune]', e); }
}

function stopEphemeralWorkerWatcher(): void {
  stopLive(liveTimers, 'workerWatchTimer');
}

/** Snapshot of one live ephemeral worker for the renderer Workers tab. */
interface WorkerSnapshot {
  workerId: string;
  reqId: string;
  name: string;
  baseBranch: string;
  spawnedAt: number;
  ageMs: number;
  idleMs: number | null;        // null = PTY already gone
  tokensUsed: number;
  tokenCap: number | null;      // effective cap (per-request or config default); null = unlimited
  hasSlack: boolean;
  releasing: boolean;
  status: 'releasing' | 'working';
}
/** Snapshot of a preserved-but-not-yet-GC'd worktree for the tab. */
interface PreservedSnapshot {
  workerId: string;
  wtPath: string;
  baseBranch: string;
  preservedAt: number;
}

/** List live ephemeral workers (+ preserved worktrees awaiting GC) for the tab. */
ipcMain.handle('workers:list', (): { live: WorkerSnapshot[]; preserved: PreservedSnapshot[]; maxWorkers: number } => {
  const cfg = readConfig();
  const defaultCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0
    ? cfg.defaultWorkerTokenCap : 0;
  const now = Date.now();
  const live: WorkerSnapshot[] = [...liveWorkers.values()].map((rec) => {
    const idle = ptyManager.idleFor(rec.workerId);
    const effCap = (rec.tokenCap && rec.tokenCap > 0) ? rec.tokenCap : (defaultCap > 0 ? defaultCap : 0);
    return {
      workerId: rec.workerId,
      reqId: rec.reqId,
      name: rec.name ?? rec.workerId,
      baseBranch: rec.baseBranch,
      spawnedAt: rec.spawnedAt,
      ageMs: Math.max(0, now - rec.spawnedAt),
      idleMs: idle === undefined ? null : idle,
      tokensUsed: workerTokensUsed(rec.workerId),
      tokenCap: effCap > 0 ? effCap : null,
      hasSlack: !!rec.slack,
      releasing: !!rec.releasing,
      status: rec.releasing ? 'releasing' : 'working'
    };
  });
  const preserved: PreservedSnapshot[] = [...preservedWorktrees.values()].map((e) => ({
    workerId: e.workerId, wtPath: e.wtPath, baseBranch: e.baseBranch, preservedAt: e.preservedAt
  }));
  return { live, preserved, maxWorkers: Math.max(1, cfg.maxConcurrentWorkers ?? 4) };
});

/** Manually stop a live ephemeral worker. Mirrors the done-release path: mark
 *  releasing, then kill + teardownPty runs the SAFETY-GATED worktree teardown
 *  (committed work is preserved, never force-discarded). Idempotent. teardownPty
 *  is called explicitly (D10) rather than left to the PTY's natural exit: kill()
 *  frees the manager's id slot synchronously, so by the time the process's real
 *  exit arrives the exit-handler's stale-id guard already misreads it as a
 *  reclaimed id and skips teardown — the worker would stay "live" in registry.json
 *  and fleet.json forever after this call. */
ipcMain.handle('workers:stop', (_evt, workerId: string): { ok: boolean; error?: string } => {
  if (typeof workerId !== 'string' || !workerId) return { ok: false, error: 'invalid worker id' };
  const rec = liveWorkers.get(workerId);
  if (!rec) return { ok: false, error: 'no such live worker' };
  if (rec.releasing) return { ok: true }; // already stopping
  rec.releasing = true;
  console.log(`[worker] manual stop requested for ${workerId}`);
  try { ptyManager.kill(workerId); } catch (e) { return { ok: false, error: String(e) }; }
  teardownPty(workerId);
  return { ok: true };
});

let campBuildPoll: NodeJS.Timeout | undefined;
let campBuildQueue: CampBuildQueue | undefined;

/** The branch of the projects.json entry whose repo is `repo`, else CAMP_BRANCH. */
function campRepoBranch(repo: string): string | undefined {
  const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
  const hit = loadMergeRepos(hive.root()).find((r) => real(r.path) === real(repo));
  return hit?.branch ?? process.env.CAMP_BRANCH ?? undefined;
}

function startCampBuildQueue(): void {
  const repo = process.env.CAMP_REPO_PATH;
  if (campBuildPoll || process.platform !== 'linux' || !app.isPackaged || !repo) return;
  const branch = campRepoBranch(repo);
  if (!branch) {
    console.warn('[camp-build] no integration branch: give the Camp repo a projects.json entry with "repo" and "branch", or set CAMP_BRANCH');
    return;
  }
  const queue = new CampBuildQueue({
    repo,
    branch,
    installDir: campInstallDir,
    log: (event) => hive.appendLog(event),
    mailBoss: (subject, body) => { hive.send({ to: 'boss', act: 'inform', subject, body }, 'harness'); }
  });
  campBuildQueue = queue;
  const poll = (): void => {
    if (hive.enabled() && !closingTime.isActive()) void queue.poll().catch((error) => console.error('[camp-build]', error));
  };
  poll();
  campBuildPoll = setInterval(poll, 2000).unref();
}

/** Start every hive-bound background service against the current harnessHome.
 *  Called on boot, and again to recover in place if a folder-change copy fails
 *  (config:changeHome tears these down before copying). No-op without a home. */
const campStartupRestart = readCampRestartArgs(process.argv.slice(1));

function logCampStartup(restart?: typeof campStartupRestart): void {
  const appPath = app.getAppPath();
  const sha = readCampBuildSha(appPath);
  recordCampRestartStartup({
    appStart: {
      kind: 'app-start', version: app.getVersion(), packaged: app.isPackaged,
      appPath, exePath: process.execPath, electron: process.versions.electron, platform: process.platform
    },
    sha,
    restart: restart?.expectedSha === sha ? restart : undefined,
    log: (event) => hive.appendLog(event),
    mailBoss: mailCampBoss
  });
  const modelWarnings = modelCatalogWarnings(readConfig());
  if (modelWarnings.length) hive.appendLog({ kind: 'model-catalog-warning', warnings: modelWarnings });
  if (restart) hive.flushWritesSync();
}

function bootstrapHiveServices(): void {
  if (!hive.enabled()) return;
  hive.ensureHive();
  watchRosterHome();
  // Tell the hive what it is running inside, BEFORE anything spawns: the prompt
  // builder reads this, so an agent spawned earlier would never learn it.
  hive.setRuntimeInfo({ version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath() });
  hive.setOrchestratorMaySpawn(readConfig().orchestratorMaySpawn === true);
  // An app-start marker in the event log. log.jsonl had twelve event kinds and
  // none of them meant "the app restarted", so a relaunch, and more importantly a
  // switch between a packaged build and a local one, was invisible to every agent
  // reading the feed. That gap cost a multi-hour investigation whose answer was
  // exactly this: a local build inherits the launching shell's umask, a
  // Finder-launched app does not.
  if (!campStartupRestart) logCampStartup();
  else hive.sweepAllInboxesStaleWrapup();
  setStallSink((r) => hive.appendLog({ ...r }));
  control.replaceAutoDeliveryPauses(readConfig().autoDeliveryPausedAgents ?? []);
  unparkAfterClosingTime();
  try { hive.retireSupersededAsks(); } catch (e) { console.error('[retire-asks] failed:', e); }
  try {
    const r = hive.moveNoticesToResults();
    if (r.error) console.error('[notices-to-results]', r.error);
    else if (r.moved.length || r.skipped.length) console.log(`[notices-to-results] moved ${r.moved.length}, skipped ${r.skipped.length}${r.backup ? `, backup ${r.backup}` : ''}`);
  } catch (e) { console.error('[notices-to-results] failed:', e); }
  try { hive.autoUnblockDependents(); } catch (e) { console.error('[auto-unblock] startup failed:', e); }
  syncDormancyWithRoster(true); // roster agents sleep until they have work; stale entries archive
  try { mkdirSync(join(hive.root()!, 'wake-requests'), { recursive: true }); } catch { /* no hive root yet */ }
  hive.startRouter();
  startCampBuildQueue();
  startEphemeralWorkerWatcher(); // poll HIVE_ROOT/spawn-requests → ephemeral workers
  startDropFolderWatcher(); // config-declared drop folders → mail (vault-inbox, card-proposals, ...)
  setInterval(askRelayTick, ASK_RELAY_POLL_MS).unref();
  startUnityBroker(); // poll agents/<id>/unity-requests → batch Unity runs
  // Phase 2: the loopback secret broker. Bind it BEFORE workers spawn so each spawn can
  // be granted a capability token + the broker URL in its env. Loopback-only, idempotent.
  void integrationBroker.start().then((r) => {
    if (r.ok) console.log('[broker] integration broker listening on', integrationBroker.url());
    else console.error('[broker] failed to start:', r.error);
  });
  ensureDefaultMissions(); // one-time: seed the built-in hourly ops standup
  syncMissions(); // arm recurring auto-dispatch missions now the router is live
  syncContextTriggers(); // …and the context trigger's own compact/clear cadences
  // Pair replies to inbound webhook messages in the ledger. Tied to the FEATURE
  // (any endpoint configured), not to the server: an approved message's card can
  // finish long after the operator switched the public surface back off, and its
  // reply still belongs in the history.
  if ((readConfig().webhookTriggers ?? []).length > 0) startWebhookDoneObserver();
  hookServer.start();
  // Bind the telemetry collector BEFORE the renderer spawns any agent, then point
  // the hive at it so every subsequent spawn is instrumented. Best-effort — a bind
  // failure just leaves telemetry off (transcript reconciler stays). No breaker.start():
  // the breaker is POLICY-only, ticked by the heartbeat beat (#1, ships disabled).
  void telemetry.start().then((r) => {
    if (r.ok && r.endpoint) { hive.setOtelEndpoint(r.endpoint); console.log('[telemetry] collector listening', r.endpoint); }
    else console.error('[telemetry] collector failed to start:', r.error);
  });
  memory.start(); // init shared palace + mine loop (no-op without mempalace)
  reflector.start(); // bound oversized memory.md files on a timer (no-op until threshold)

  armAlwaysOnBeats();
}

/** Closing time parks open cards as blocked; reopening the floor puts them back to todo
 *  so their workers wake, and tells the Boss which ones. */
function unparkAfterClosingTime(): void {
  try {
    const restored = hive.unparkClosingTimeCards();
    if (!restored.length) return;
    hive.send({
      to: getMessageRoute('wrapUp', readConfig(), isKnownAgent), act: 'inform', subject: 'Wrap-up over: parked cards are back to todo',
      body: `These cards were parked as blocked at wrap-up and are todo again, so their workers start on them: ${restored.join(', ')}. Cards that got a new human question while parked stay blocked.`
    }, 'harness');
  } catch (e) { console.error('[unpark] failed:', e); }
}

/** Cadence of the worker inbox-wake watchdog (#151). Well under the renderer's
 *  own nudge cooldown so a throttled window is caught within ~15s of a stall. */
const WORKER_WAKE_POLL_MS = 15_000;
let workerWakeTimer: ReturnType<typeof setInterval> | null = null;

/** Type the renderer's guarded nudge into one worker's PTY — text first, Enter a
 *  tick later (the exact submitToPty pattern: a single-chunk write would land the
 *  "\r" inside the input box and never submit). With `confirm` the Enter is repeated until
 *  a UserPromptSubmit hook proves the prompt went in (a TUI still loading swallows it).
 *  Best-effort + never throws. */
async function nudgeWorker(ptyId: string, agentId: string, ids: string[] = [], bracketed = false, closing = false, confirm = false): Promise<void> {
  // Same text the renderer queues (#187's inboxNudgeText), so the two wake paths
  // produce byte-identical nudges: the queue's one-pending rule recognises either
  // via isInboxNudge, and a watchdog nudge names its ids so the agent can still
  // tell "I filed this last turn" from "woken for nothing".
  // Codex drops characters from a long line typed raw and never submits it, so
  // it gets the bracketed-paste form (the renderer's submitToPty does the same).
  const text = inboxNudgeText(ids, 'worker', closing);
  const wrote = ptyManager.write(ptyId, bracketed ? `\x1b[200~${text}\x1b[201~` : text);
  if (!wrote.ok) { console.warn(`[worker-wake] write failed for ${ptyId}: ${wrote.error}`); return; }
  await new Promise((r) => setTimeout(r, 140));
  const pressEnter = async (): Promise<void> => {
    const submitted = ptyManager.write(ptyId, '\r');
    if (!submitted.ok) throw new Error(submitted.error ?? `pty write failed: ${ptyId}`);
  };
  try {
    if (!confirm) { await pressEnter(); return; }
    const ok = await pressEnterUntilSubmitted(pressEnter, () => promptSubmits.arm(agentId), SUBMIT_CONFIRM_MS);
    if (!ok) console.warn(`[worker-wake] no UserPromptSubmit from ${agentId} after repeated Enter; nudge may be sitting unsent`);
  } catch (e) { console.warn(`[worker-wake] submit failed for ${ptyId}:`, e); }
}

/** Main-process inbox-wake beat (issue #151, fix A): the renderer's idle nudge
 *  (useHive.ts) is the only path that wakes a worker parked on an undrained
 *  inbox — and it lives on a setInterval in the renderer, which a throttled or
 *  occluded window stops honoring. This beat is the renderer-INDEPENDENT fallback:
 *  it gathers live-worker facts (PTY quiescence, inbox depth, control flags) and
 *  lets WorkerWakeWatchdog.decide apply the exact renderer guards (idle-only,
 *  post-boot-grace, not paused/halted, no pending HITL, cooldown), then types the
 *  same nudge the renderer would have. God is never a candidate (its heartbeat
 *  path already re-engages it). */
function runWorkerWakeBeat(): void {
  if (!hive.enabled()) return;
  const reg = hive.registry();
  if (!reg?.agents || !reg.godId) return;
  const now = Date.now();
  const facts: WorkerWakeFacts[] = [];
  for (const [agentId, a] of Object.entries(reg.agents)) {
    if (agentId === reg.godId || a?.archived || limitHeld(agentId)) continue;
    const ptyId = ptyForAgent(agentId);
    if (!ptyId) continue;
    const snap = control.snapshot(agentId);
    facts.push({
      agentId,
      isGod: agentId === reg.godId,
      ptyId,
      lastOutputAt: ptyManager.lastOutputAt(ptyId) ?? 0,
      inboxIds: hive.inbox(agentId).map((message) => message.id).filter(Boolean),
      autoDeliveryPaused: snap.autoDeliveryPaused,
      paused: snap.paused,
      halted: snap.halted,
      wakeMode: closingTime.wakeMode(agentId)
    });
  }
  for (const agentId of workerWake.decide(facts, now)) {
    const ptyId = ptyForAgent(agentId);
    if (!ptyId) continue;
    // Re-read at delivery time, not from the facts snapshot: the agent may have
    // drained the mail during the beat, and a nudge naming ids it already filed
    // is the exact staleness #187 exists to stop.
    const ids = hive.inbox(agentId).map((m) => m.id).filter(Boolean);
    if (!ids.length) { console.log(`[worker-wake] ${agentId} drained before delivery, skipping`); continue; }
    const mode = wakeModeFor(agentId);
    if (mode === 'skip') { console.log(`[worker-wake] ${agentId} acked closing time or is closing for a new card, not waking`); continue; }
    console.log(`[worker-wake] nudging ${agentId} on ${ptyId} (${ids.length} pending${mode === 'closing' ? ', closing time' : ''})`);
    const provider = reg.agents[agentId]?.provider;
    // Same UserPromptSubmit-capable engines as submitToPty in useHive.ts; an unset
    // provider is a legacy Claude entry.
    const acknowledges = provider === undefined || provider === 'claude' || provider === 'codex' || provider === 'gemini' || provider === 'antigravity';
    void nudgeWorker(ptyId, agentId, ids, provider === 'codex', mode === 'closing', acknowledges);
  }
}

/** Roster agents the human pinned with "keep running" in Edit Agent. */
function keepRunningIds(): Set<string> {
  const snap = roster.read();
  const out = new Set<string>();
  for (const entry of Array.isArray(snap?.agents) ? snap.agents : []) {
    const a = entry as { id?: unknown; keepRunning?: unknown } | null;
    if (a && typeof a.id === 'string' && a.keepRunning === true) out.add(a.id);
  }
  return out;
}

/** Next-card nudge eligibility, read when the check scheduled at Stop runs. A limit
 *  hold set by the Stop's own limit beat lands before then. */
function todoNudgeFacts(agentId: string): TodoNudgeFacts {
  const reg = hive.registry();
  const a = reg.agents[agentId];
  const ptyId = ptyForAgent(agentId);
  const snap = control.snapshot(agentId);
  const eligible = todoNudgeEligible({
    hiveEnabled: hive.enabled(),
    closingTime: closingTime.isActive(),
    hasPty: !!ptyId,
    registered: !!a,
    archived: a?.archived,
    isBoss: agentId === reg.godId || !!a?.isGod,
    isAssistant: a?.isAssistant,
    onHold: a?.onHold,
    limitHeld: limitHeld(agentId),
    paused: snap.paused,
    halted: snap.halted,
    autoDeliveryPaused: snap.autoDeliveryPaused
  });
  if (!eligible) return { eligible, hasMail: false, cards: [] };

  let hasWork = false;
  let lastWorkAt: number | undefined;
  const root = hive.root();
  if (root) {
    const outboxDir = join(root, 'agents', agentId, 'outbox');
    try {
      if (existsSync(outboxDir)) {
        if (readdirSync(outboxDir).some((f) => f.endsWith('.json'))) hasWork = true;
        const sentDir = join(outboxDir, '.sent');
        if (existsSync(sentDir)) {
          for (const f of readdirSync(sentDir)) {
            if (!f.endsWith('.json')) continue;
            try {
              const mt = statSync(join(sentDir, f)).mtimeMs;
              if (lastWorkAt === undefined || mt > lastWorkAt) lastWorkAt = mt;
            } catch { /* noop */ }
          }
        }
      }
    } catch { /* noop */ }
    if (a?.cwd) {
      try {
        const headLog = join(a.cwd, '.git', 'logs', 'HEAD');
        if (existsSync(headLog)) {
          const mt = statSync(headLog).mtimeMs;
          if (lastWorkAt === undefined || mt > lastWorkAt) lastWorkAt = mt;
        }
      } catch { /* noop */ }
    }
  }

  const ledger = tasksOf(hive.tasks()) as NudgeCard[];
  let memoryUpdated = false;
  const session = liveSessions.get(agentId);
  if (session && root) {
    try { memoryUpdated = statSync(join(root, 'agents', agentId, 'memory.md')).mtimeMs >= session.atMs; } catch { /* no handoff yet */ }
  }
  return {
    eligible,
    hasMail: hive.inbox(agentId).length > 0,
    cards: openCards(agentId, ledger),
    finishedCards: ledger.filter((c) => c.assignee === agentId && (c.status === 'blocked' || c.status === 'done')),
    memoryUpdated,
    canClose: !!ptyId && !liveWorkers.has(ptyId) && !keepRunningIds().has(agentId),
    ...(hasWork ? { hasWork } : {}),
    ...(lastWorkAt !== undefined ? { lastWorkAt } : {})
  };
}

function pollCodexIdle(): void {
  for (const [agentId, session] of liveSessions) {
    if (session.provider !== 'codex' || !ptyForAgent(agentId)) continue;
    const path = agentSessionLog(agentId, 'codex', session.cwd);
    const sid = hive.registry().agents[agentId]?.sessionId;
    // A summarizer or a previous session can also write rollouts in this home.
    if (!path || !sid || !path.endsWith(`-${sid}.jsonl`)) continue;
    const text = readTailText(path, 256 * 1024);
    if (text) todoNudger.noteSession(agentId, text);
  }
}

let tasksMtime = -1;
/** A card assigned to an idle worker closes it for that card (TodoNudger.cardsChanged). */
function noteTasksChanged(): void {
  const root = hive.root();
  if (!root) return;
  let m = -1;
  try { m = statSync(join(root, 'tasks.json')).mtimeMs; } catch { return; }
  if (m === tasksMtime) return;
  const first = tasksMtime < 0;
  tasksMtime = m;
  if (!first) todoNudger.cardsChanged();
}

/** Agents main asked the renderer to close for a new card, until it answers. */
const pendingCardCloses = new Set<string>();

/** Ask the renderer to close at a card boundary. The renderer refuses while it holds
 *  a queued message or a draft; the final main-side check decides whether to wake. */
function proposeCardClose(agentId: string, cards: NudgeCard[]): boolean {
  const wc = liveWebContents();
  if (!wc) { recordCardCloseRefusal(agentId, 'renderer-unavailable'); return false; }
  try { wc.send('hive:cardCloseDue', { agentId }); } catch { recordCardCloseRefusal(agentId, 'renderer-send-failed'); return false; }
  pendingCardCloses.add(agentId);
  hive.appendLog({ kind: 'card-close-proposed', agentId, reason: todoNudger.finished(agentId) ? 'card-finished' : 'new-card-while-idle', next: cards.map((c) => String(c.id)) });
  console.log('[card-close] proposed', agentId, 'next', cards.map((c) => String(c.id)).join(','));
  return true;
}

function sendBossCompactResume(agentId: string): void {
  const wc = liveWebContents();
  const root = hive.root();
  if (!wc || !root) return;
  try { wc.send('hive:compactResume', { agentId, text: bossCompactResumeText(join(root, 'agents', agentId)) }); } catch { return; }
  hive.appendLog({ kind: 'compact-resume', agentId });
}

/** Queued through the renderer like a limit resume, so a draft or a queued message
 *  ahead of it is respected. */
function sendTodoNudge(agentId: string, cards: NudgeCard[]): boolean {
  const wc = liveWebContents();
  const root = hive.root();
  if (!wc || !root) return false;
  try { wc.send('hive:todoNudge', { agentId, text: todoNudgeText(cards, join(root, 'agents', agentId, 'outbox')) }); } catch { return false; }
  hive.appendLog({ kind: 'todo-nudge', agentId, cards: cards.map((c) => String(c.id)) });
  return true;
}

function reportIgnoredTodoNudge(agentId: string, cards: NudgeCard[]): void {
  const ids = cards.map((c) => String(c.id));
  hive.appendLog({ kind: 'todo-nudge-ignored', agentId, cards: ids });
  const name = hive.registry().agents[agentId]?.name ?? agentId;
  hive.send({
    to: 'god',
    act: 'inform',
    subject: `${name} is not starting its cards`,
    body: ignoredTodoNudgeBody(name, agentId, cards),
    requires_reply: false
  }, 'harness');
}

function recordCardCloseRefusal(agentId: string, reason: string): void {
  pendingCardCloses.delete(agentId);
  hive.appendLog({ kind: 'card-close-refused', agentId, reason });
}

function refuseCardClose(agentId: string, reason: string): { ok: false; error: string } {
  if (!todoNudger.closeRefused(agentId, reason)) recordCardCloseRefusal(agentId, reason);
  return { ok: false, error: reason };
}

ipcMain.handle('hive:cardCloseRefuse', (evt, agentId: unknown, reason: unknown): void => {
  if (typeof agentId !== 'string' || isDesktopSender(evt.sender)) return;
  const allowed = ['closing-time', 'missing-agent', 'missing-pty', 'boss-or-assistant', 'keep-running', 'missing-cwd', 'queued-message', 'draft'];
  refuseCardClose(agentId, typeof reason === 'string' && allowed.includes(reason) ? reason : 'renderer-refused');
});

/** The renderer accepts a card-close proposal. Read again: a turn, input, a hold or a
 *  card set to "doing" since the proposal keeps the session. */
ipcMain.handle('hive:cardClose', (evt, agentId: unknown): { ok: boolean; error?: string; wake?: boolean } => {
  if (typeof agentId !== 'string' || isDesktopSender(evt.sender)) return { ok: false, error: 'invalid' };
  const ptyId = ptyForAgent(agentId);
  if (!pendingCardCloses.has(agentId)) return refuseCardClose(agentId, 'no-close-pending');
  if (!ptyId) return refuseCardClose(agentId, 'missing-pty');
  const f = todoNudgeFacts(agentId);
  if (!todoNudger.closeStands(agentId)) return refuseCardClose(agentId, 'agent-no-longer-idle');
  if (!f.eligible) return refuseCardClose(agentId, 'agent-ineligible');
  if (!f.canClose) return refuseCardClose(agentId, 'session-cannot-close');
  if (!todoNudger.shouldClose(agentId, f)) return refuseCardClose(agentId, 'no-card-boundary');
  const reason = todoNudger.finished(agentId, f) ? 'card-finished' : 'new-card-while-idle';
  const wake = f.cards.length > 0 || f.hasMail;
  pendingCardCloses.delete(agentId);
  ptyManager.kill(ptyId);
  teardownPty(ptyId, { dormant: true });
  hive.appendLog({ kind: 'card-close', agentId, reason, next: f.cards.map((c) => String(c.id)) });
  console.log('[card-close]', agentId, reason, wake ? 'waking fresh' : 'parked');
  return { ok: true, wake };
});

/** Before mail is typed into a worker: is its live session on a model its list allows?
 *  If not, close it so the mail wakes it fresh on an allowed one, the same way a new
 *  card does. The queued message is left for the fresh session. */
ipcMain.handle('hive:modelCheck', (evt, agentId: unknown): { closed: boolean; live?: string } => {
  if (typeof agentId !== 'string' || isDesktopSender(evt.sender)) return { closed: false };
  const live = agentLiveModel(agentId);
  const s = liveSessions.get(agentId);
  if (!live || !s) return { closed: false };
  const view = limitRosterAgents().live.find((v) => v.id === agentId);
  if (!view || view.isGod || view.pinned) return { closed: false, live };
  const tiers = parseModelTiers(readConfig().modelTiers);
  const onList = cleanModelList([...TIERS.flatMap((t) => tiers[t]), ...(view.pin ? [view.pin] : []), view.current]);
  if (liveModelAllowed(live, s.provider, onList)) return { closed: false, live };
  const now = Date.now();
  if (now - (lastModelClose.get(agentId) ?? 0) < MODEL_CLOSE_COOLDOWN_MS) return { closed: false, live };
  const f = todoNudgeFacts(agentId);
  const ptyId = ptyForAgent(agentId);
  if (!f.eligible || !f.canClose || !ptyId) return { closed: false, live };
  if (f.cards.some((c) => c.status === 'doing')) return { closed: false, live };
  lastModelClose.set(agentId, now);
  ptyManager.kill(ptyId);
  teardownPty(ptyId, { dormant: true });
  hive.appendLog({ kind: 'model-close', agentId, live, allowed: onList.map(entryLabel) });
  console.log('[model-close]', agentId, 'was running', live, 'outside', onList.map(entryLabel).join(', '));
  return { closed: true, live };
});

/** The model each live agent's session is actually running, for the agent cards. */
ipcMain.handle('hive:liveModels', (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const id of liveSessions.keys()) {
    const m = sessionModel(agentLiveModel(id), liveModelOf(id));
    if (m) out[id] = m;
  }
  return out;
});

/** (Re)arm the always-on beats (decoupled from the optional heartbeat): the live
 *  fleet snapshot Michael reads (~8s) + the breaker/cost-ledger beat (~30s).
 *  Guarded (clear-then-set) so a re-bootstrap (changeHome recovery) OR a
 *  powerMonitor resume can't stack duplicate timers — these are setInterval
 *  handles that freeze during true system sleep and must be re-armed on wake. */
function armAlwaysOnBeats(): void {
  writeFleetSnapshot();
  armLive(liveTimers, 'fleetTimer', writeFleetSnapshot);
  armLive(liveTimers, 'breakerBeatTimer', () => { try { runBreakerBeat(liveTimings().breakerProgressToolWindowMs); } catch (e) { console.error('[breaker beat]', e); } });
  if (workerWakeTimer) clearInterval(workerWakeTimer);
  workerWakeTimer = setInterval(() => { try { runWorkerWakeBeat(); } catch (e) { console.error('[worker-wake beat]', e); } }, WORKER_WAKE_POLL_MS);
  runWorkerWakeBeat(); // catch-up on arm — power-resume re-arms and drains the backlog
  armLive(liveTimers, 'limitTimer', () => { void runLimitBeat().catch((e) => console.error('[limit beat]', e)); });
}

/** Wall-clock instant we last observed the machine suspend or lock, so a resume
 *  can report how long we were out. Best-effort context for the renderer follow-on
 *  (auto-revive); null until the first suspend/lock of the session. */
let lastSuspendAt: number | null = null;
/** Single pending post-resume PTY health check, so overlapping resume+unlock
 *  events collapse to ONE check (the latest) instead of stacking. */
let resumeHealthTimer: NodeJS.Timeout | null = null;

/** After the machine wakes, probe each live PTY for liveness and surface any that
 *  didn't survive. macOS can wedge a child `claude` process/socket across a long
 *  sleep while node-pty still holds the fd (its exit event never fired) — so a
 *  dead PTY can linger in our list. `process.kill(pid, 0)` is a pure existence
 *  probe (signal 0 never touches the process); ESRCH means the process is gone.
 *  We only LOG + NOTIFY here (no auto-kill/respawn — true revive is renderer-owned
 *  via pty:spawn) and emit `power:resume` as the integration point for the
 *  follow-on renderer auto-revive card. */
function healthCheckPtys(reason: string, awayMs: number | null): void {
  const ptys = ptyManager.list();
  const dead: string[] = [];
  for (const p of ptys) {
    if (typeof p.pid === 'number' && p.pid > 0) {
      try { process.kill(p.pid, 0); }   // liveness probe only — never kills
      catch { dead.push(p.id); }        // ESRCH: process gone but PTY still registered
    }
  }
  const away = awayMs != null ? ` (away ~${Math.round(awayMs / 1000)}s)` : '';
  if (dead.length) {
    console.warn(`[power] ${reason}${away}: ${dead.length}/${ptys.length} PTY(s) look wedged (process gone):`, dead.join(', '));
    breakerToast('Agents need a restart', `${dead.length} agent terminal(s) didn't survive sleep — re-open them to resume.`);
  } else {
    console.log(`[power] ${reason}${away}: ${ptys.length} PTY(s) healthy`);
  }
  // Single integration point for the (separate) renderer auto-revive card: it can
  // listen for 'power:resume' and respawn the `dead` PTYs with --resume.
  try { liveWebContents()?.send('power:resume', { reason, awayMs, dead, total: ptys.length }); } catch { /* window gone */ }
}

/** Re-arm everything that runs on a frozen libuv timer after the machine slept,
 *  and surface any PTY that didn't survive. macOS pauses setTimeout/setInterval
 *  during true system sleep (the monotonic clock halts) — on wake they resume
 *  where they paused, shifted by the whole sleep, so missions due during sleep
 *  never fired and never replay. We rebuild the scheduler (syncMissions reuses its
 *  remaining=max(0,…) semantics → each overdue mission fires exactly ONCE then
 *  re-settles, never N replays), re-arm the always-on beats, re-evaluate the
 *  power blocker, then — after a short grace for PTYs to wake their pipes —
 *  health-check the terminals. Idempotent: overlapping resume+unlock events
 *  collapse safely (clear-then-arm everywhere; at most one catch-up fire). */
function onSystemResume(reason: string): void {
  console.log(`[power] ${reason} — re-arming scheduler, beats, router, keep-awake`);
  try { syncMissions(); } catch (e) { console.error('[power] syncMissions on resume', e); }
  // Same freeze, same catch-up: the context timers honour elapsed-time-since-last-
  // run, so a compact/clear that came due while the machine slept fires ONCE here
  // rather than being lost or replayed N times.
  try { syncContextTriggers(); } catch (e) { console.error('[power] syncContextTriggers on resume', e); }
  try { armAlwaysOnBeats(); } catch (e) { console.error('[power] armAlwaysOnBeats on resume', e); }
  // The hive message router (outbox→inbox drain) is a setInterval that freezes
  // during true system sleep exactly like the beats above — but it was the one
  // always-on timer never re-armed on wake. Symptom: after a long sleep the
  // scheduler→god path recovered (it injects straight into god's inbox), while
  // every agent's outbox silently stopped draining, so god→worker and
  // worker↔worker mail piled up undelivered. Re-arm the poll loop (clear-then-set,
  // idempotent) and immediately drain the backlog that accrued while we were out
  // instead of waiting for the first post-wake tick. The renderer's idle inbox-wake
  // nudge (useHive.ts) then wakes each parked recipient once its mail lands.
  try {
    hive.stopRouter();
    hive.startRouter();
    const drained = hive.routeOnce();
    if (drained > 0) console.log(`[power] ${reason} — flushed ${drained} queued hive message(s)`);
  } catch (e) { console.error('[power] router re-arm on resume', e); }
  try { syncKeepAwake(); } catch (e) { console.error('[power] syncKeepAwake on resume', e); }
  const awayMs = lastSuspendAt != null ? Date.now() - lastSuspendAt : null;
  // Give PTYs a beat to resume their pipes before judging them wedged; reset any
  // pending check so a resume quickly followed by unlock runs the probe just once.
  if (resumeHealthTimer) clearTimeout(resumeHealthTimer);
  resumeHealthTimer = setTimeout(() => {
    resumeHealthTimer = null;
    healthCheckPtys(reason, awayMs);
  }, 15_000);
}

app.whenReady().then(() => {
  const startConfig = readConfig();
  exportWorkspaceRoot(startConfig);
  exportHumanName(startConfig);
  if (!gotInstanceLock) return;
  rescanThemePacks();
  try { migrateModelTiers(); } catch (e) { console.error('[model-tiers] migration failed:', e); }
  ensurePhoneServer();
  armLive(liveTimers, 'phoneServerTimer', ensurePhoneServer);
  // Realtime Michael mic-gate hygiene (rt-8 / Pam rt-10 nit): the voice session
  // opens the mic permission gate by persisting realtimeVoiceEnabled=true and
  // closes it on disconnect — but a hard crash/reload mid-session skips that
  // teardown, leaving the flag stuck true so the gate would boot PRE-OPEN with no
  // live session. Force it closed at startup (a real session re-opens it via
  // setMicGate(true)); macOS TCC stays a second gate regardless.
  if (readConfig().realtimeVoiceEnabled) writeConfig({ realtimeVoiceEnabled: false });

  // Anonymous product analytics (PostHog) — the full contract lives in
  // TELEMETRY.md. No-op unless a build-time key was injected (official releases
  // only), and gated on DO_NOT_TRACK + the telemetryEnabled config (opt-out).
  analytics.init({
    stateDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    enabled: readConfig().telemetryEnabled !== false
  });

  // A cold-start deep link (Windows/Linux) rides in on OUR argv.
  const startupHireLink = process.argv.find((a) => a.startsWith('munderdifflin://'));
  if (startupHireLink) void handleHireLink(startupHireLink);

  // Hand every spawned agent the path to the Slack reply discovery file via the
  // inherited env (pty merges process.env). The path is stable whether or not the
  // server is running; the FILE only exists while it is, so the helper degrades
  // to "endpoint not running" cleanly. NO secret is in the env — only the path.
  process.env.MD_SLACK_REPLY_CONFIG = slackReplyConfigPath();
  // Open the durable store first — createWindow() reads the saved window bounds.
  // Guarded: a DB failure (e.g. a bad native build) must degrade to defaults,
  // never block app startup.
  try { persist.open(); } catch (e) { console.error('[db] open failed:', e); }
  // Auto-update from GitHub releases (packaged builds only; gated on the
  // `autoUpdate` config flag). Download-in-background + restart-to-apply toast;
  // never restarts on its own. Falls back to a notify-only releases/latest
  // check where native updating isn't possible (win-portable, dev-ish builds).
  initAutoUpdater(() => liveWebContents());
  initClaudeLimits();
  readCodexLimits = initCodexLimits(() => hive.root(), (e) => { try { hive.appendLog(e); } catch { /* best-effort */ } });
  readAgyQuota = initAgyQuota(() => [readConfig().harnessHome, hive.root()], (e) => { try { hive.appendLog(e); } catch { /* best-effort */ } });
  // Bootstrap the hive (if harnessHome is configured) and start the message router.
  bootstrapHiveServices();
  armSnipHotkey();
  configWatcher = startConfigWatcher({ onReload: (config) => {
    syncTimers(liveTimers, config);
    syncMissions();
    syncContextTriggers();
    watchRosterHome();
    for (const w of allWindows) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('config:changed', config);
    }
  } });
  // Survive sleep/lock. macOS freezes libuv timers during true system sleep, so a
  // locked/idle/slept Mac stops firing schedules and can wedge PTYs. On wake we
  // re-arm the scheduler (catching up missed missions ONCE) + beats + keep-awake,
  // then health-check terminals. App-lifetime listeners — powerMonitor outlives
  // every window, so there is nothing to tear down on quit.
  powerMonitor.on('resume', () => onSystemResume('resume'));
  powerMonitor.on('unlock-screen', () => onSystemResume('unlock-screen'));
  powerMonitor.on('suspend', () => { lastSuspendAt = Date.now(); console.log('[power] suspend — system sleeping'); });
  powerMonitor.on('lock-screen', () => { lastSuspendAt = Date.now(); console.log('[power] lock-screen'); });
  // Multi-window floors (opt-in): install the menu carrying "New Floor". When
  // off, the app keeps Electron's default menu — zero behavior change.
  if (readConfig().multiWindow) installAppMenu();
  const firstWindow = createWindow();
  if (campStartupRestart) firstWindow.once('ready-to-show', () => {
    if (hive.enabled()) logCampStartup(campStartupRestart);
  });
  // Auto-start the Slack webhook server when configured. Best-effort: a tunnel
  // failure (offline) is logged, not fatal. The tunnel URL is ephemeral and
  // changes per restart, so the user re-pastes it via Settings → Start.
  const slackCfg = readConfig();
  if (slackCfg.slackEnabled && slackCfg.slackSigningSecret) {
    void startSlackServer().then((r) => {
      if (!r.ok) console.error('[slack] auto-start failed:', r.error);
      else console.log('[slack] webhook listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  // Auto-start the generic webhook only for endpoints the user has explicitly
  // enabled (each with its own secret) — never a default-on public surface.
  // Opt-in, like Slack; an install with no enabled endpoint opens no tunnel.
  if (enabledWebhookEndpoints().length > 0) {
    void startWebhookServer().then((r) => {
      if (!r.ok) console.error('[webhook] auto-start failed:', r.error);
      else console.log('[webhook] listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// before-quit covers Cmd-Q / dock-quit; the per-window close handler covers
// the red close button. Both routes hit the same warning UX.
app.on('before-quit', (e) => {
  if (allowQuit) return;
  const count = ptyManager.list().length;
  if (count === 0) return;
  e.preventDefault();
  if (mainWindow) {
    mainWindow.focus();
    mainWindow.webContents.send('app:closeRequested', { ptyCount: count });
  }
});

// Every window loads the config once at start-up, so tell them all when a
// setting is saved — a floor left out would keep showing what it opened with.
onConfigWritten((config) => {
  for (const w of allWindows) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    w.webContents.send('config:changed', config);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Full teardown, not a bare killAll: this path must also stop the proxy
    // sidecars and helper servers — on Windows a child is NOT killed when its
    // parent exits, so anything skipped here outlives the app.
    teardownAndQuit();
  }
});

// Final analytics flush (session_ended + drain the send queue), bounded so a
// hung network can never wedge quit: preventDefault ONCE, race the flush
// against a short timeout, then exit hard.
//
// finish MUST be app.exit(), not a re-entrant app.quit(): when the quit was
// initiated while a window was still open (the "kill all & quit" confirm path
// calls teardownAndQuit → app.quit() and the window closes DURING that quit),
// Electron is left with its internal is-quitting state set after this
// preventDefault, and the later app.quit() is silently a no-op — no before-quit,
// no will-quit, no quit; the main process idles forever with zero windows. On
// Windows that stranded the whole Electron process group (main + GPU + network
// service) after every agents-running quit. By this point teardown has already
// run and the flush has finished or timed out, so an unconditional exit is
// exactly what's left to do.
// will-quit flushes the queued hive writes; this catches an exit that skipped it.
process.on('exit', () => hive.flushWritesSync());
let analyticsFlushed = false;
app.on('will-quit', (e) => {
  globalShortcut.unregisterAll();
  if (analyticsFlushed) return;
  analyticsFlushed = true;
  e.preventDefault();
  const finish = (): void => app.exit(0);
  Promise.race([
    // A private display also goes when its helper sees our end of its stdin close.
    Promise.all([analytics.endSession(), stopAllUnityDisplays(), hive.flushCommits()]),
    new Promise<void>((r) => setTimeout(r, 1200))
  ]).then(finish, finish);
});
