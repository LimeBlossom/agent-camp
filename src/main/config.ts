import type { Reservation } from '../shared/reservations';
import type { EngineConfig } from './engineChoice';
import type { BossInboxNudgeConfig } from '../shared/bossInboxBatch';
import { setTimingsConfigReader, type TimingsConfig } from './timings';
import { app } from 'electron';
import { watchFiles } from './watchFiles';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  autoModeFlagForProvider,
  defaultCommandForProvider,
  inferAgentProvider,
  providerPreset,
  type AgentProvider
} from '../shared/agentProvider';
import { defaultMcpDefaults, retierMcpConsent } from '../shared/mcpCatalog';
import { MAX_AGENT_TOKEN_CAP } from '../shared/tokenCaps';
import { expandTilde, normalizeHiveHome } from './fs';
import type { IntegrationRecord } from '../shared/integrations';
import type { AgentModelEntry } from '../shared/modelBalance';
import type { ModelTiers, Tier } from '../shared/modelTiers';
import { migrateModelCommand, migrateModelList } from '../shared/modelMigration';
import { migrateModel } from '../shared/modelCatalogCheck';
import {
  DEFAULT_CONTEXT_TRIGGER,
  DEFAULT_ORG_TRIGGER,
  DEFAULT_TRIGGER_MODE,
  DEFAULT_WEBHOOK_SCHEMA,
  type ContextTriggerConfig,
  type OrgTriggerConfig,
  type WebhookTrigger
} from '../shared/triggers';
import type { DropFolderConfig } from './dropFolders';
import type { MessageRoutesConfig } from './messageRoutes';

/** A recurring auto-dispatched mission fired on an interval by the scheduler. */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  /** Day-of-week + time-of-day schedule. When present and valid this REPLACES
   *  `intervalMs` — an interval cannot say "weekday mornings", because it drifts
   *  against the clock and a 24h one started at 15:00 fires at 15:00 forever.
   *  `intervalMs` is deliberately left on the record so switching back restores
   *  the cadence the user had. See shared/weeklySchedule.ts. */
  weekly?: { days: number[]; minute: number };
  to: string;
  body: string;
  enabled: boolean;
  /** When true, the scheduler asks the renderer to compact live terminals when
   *  this mission fires — but only agents whose context has filled past the bar
   *  in `contextTrigger.compact` (60% by default, 40% on ~1M-token windows), so
   *  small/idle sessions are left alone instead of compacting on every tick.
   *
   *  This gate used to be described here but was never actually implemented: every
   *  live agent was compacted on every tick. It is real now, and the bars live in
   *  `ContextTriggerConfig` where the operator can edit them, so do not restate
   *  the numbers anywhere else — they will drift. */
  autoCompact?: boolean;
  lastFiredAt?: number;
  /** Mission flavor. Absent ⇒ 'dispatch' (the classic interval-dispatch mission,
   *  e.g. the ops standup). 'heartbeat' (Lane A #1) is a context-aware beat: it
   *  observes live floor state, re-engages a quiet god, and ticks the circuit
   *  breaker — armed with an adaptive cadence, not a fixed setInterval. */
  kind?: 'dispatch' | 'heartbeat' | 'compact';
  /** Heartbeat only: a floor is "quiet" when no tracked signal (log.jsonl mtime,
   *  inbox/outbox mtimes, any PTY output) has moved in this many ms. Default
   *  ~5 min. NOT derived from registry.status (which never transitions in main). */
  quietThresholdMs?: number;
}

/** The built-in hourly ops standup: god reviews who's doing what + whether tasks
 *  are on track and agents are running, and every terminal's context is compacted.
 *  Shipped enabled by default; users can toggle it off in the Command Center. */
export const OPS_STANDUP_MISSION: ScheduledMission = {
  id: 'ops-standup',
  label: 'Hourly ops standup',
  intervalMs: 3_600_000,
  to: 'god',
  body:
    'Hourly ops standup. Review every agent: who is doing what, and confirm each ' +
    'is still running (not stalled or idle-stale). Check the task board — are ' +
    'in-flight tasks on track, and is anything blocked or unowned? Flag stale ' +
    'agents and at-risk tasks, and keep the board accurate. (As part of this ' +
    "standup each working agent is asked to summarise its current task and the " +
    'next step, then compact and resume from the same point — so terminal ' +
    'contexts stay bounded without losing work. The compaction is queued and ' +
    'runs when an agent is idle, so it never interrupts work mid-step.)',
  enabled: true
  // NO autoCompact. Compaction belongs to contextTrigger.compact and nothing else.
  // This flag used to live here as well, which meant a default install asked for
  // compaction on TWO cadences — hourly from this standup and 2-hourly from the
  // trigger — the exact "two controls that disagree" the maint-1 retirement below
  // was written to end. The standup's own prose still describes compaction, and
  // that stays true: the trigger does it, just not on this mission's clock.
};

/** The built-in heartbeat (Lane A #1). A context-aware beat that, each tick,
 *  observes live floor state and — only when the floor has gone quiet — drops a
 *  digest into god's inbox and (if god's PTY is genuinely idle) nudges it to
 *  re-engage anyone stalled. The same beat ticks the circuit breaker.
 *
 *  Shipped DISABLED by default (opt-in): unlike the standup, which only sends a
 *  hive message, the heartbeat types into god's PTY, so the user turns it on
 *  explicitly in the Command Center once they want active re-engagement.
 *  `intervalMs` is the normal-cadence base; the scheduler derives a tighter beat
 *  when an agent looks stuck and a slower one right after a re-engage. */
/** Weekly nudge to put the engine ledger in front of the human, so the engine-ladder
 *  experiment gets judged from data. Seeded once (engineLedgerReviewSeeded). */
export const ENGINE_LEDGER_REVIEW_MISSION: ScheduledMission = {
  id: 'engine-ledger-review',
  label: 'Weekly engine ledger review',
  intervalMs: 7 * 86_400_000,
  to: 'god',
  body:
    'Weekly engine ledger review. Read engine-ledger-summary.md in the hive root (it ' +
    'shows which engine each temporary worker ran on and how it ended, for the last 7 ' +
    'days and all time). Put it on an ASK ME card for the human: one bold line naming ' +
    'what stands out (an engine whose workers keep getting reaped, one never picked, ' +
    'one that is always full), the last-7-days table, and the question whether to ' +
    'change the engine order or the 85% cutoff. If no temporary workers ran this ' +
    'week, say so in one line instead of asking.',
  enabled: true
};

export const HEARTBEAT_MISSION: ScheduledMission = {
  id: 'heartbeat',
  label: 'Floor heartbeat',
  intervalMs: 120_000,
  to: 'god',
  body:
    'Floor heartbeat: the team has gone quiet. Review the digest in your inbox, ' +
    're-engage anyone stalled or blocked, and keep the board accurate — or rest ' +
    'if the work is genuinely done.',
  enabled: false,
  kind: 'heartbeat',
  quietThresholdMs: 300_000
};

/** The dedicated auto-compact MAINTENANCE schedule (maint-1). DECOUPLED from the
 *  ops standup so editing/replacing a standup can never silently disable
 *  compaction again (the bug this fixes). It fires ONLY the auto-compact signal —
 *  `kind:'compact'` makes syncMissions skip the hive.send dispatch (empty to/body).
 *  Shipped DISABLED (v0.3.4 founder decision): scheduled compaction is opt-in.
 *  Turn it on in Settings → General or the Schedules tab; the Schedules warning
 *  panel explains the risk of leaving it off for long-running agents. It is the
 *  SINGLE source of truth for compaction, and it's persistent: deleting it makes
 *  it reappear DISABLED.
 *  Existing installs keep whatever enabled state the user already has
 *  (compactMaintenanceSeeded guards re-seeding). */
export const COMPACT_MAINTENANCE_MISSION: ScheduledMission = {
  id: 'compact-maintenance',
  label: 'Auto-compact (maintenance)',
  // 2h, matching DEFAULT_CONTEXT_TRIGGER.compact.everyMs. The two cadences must
  // agree: this mission is the schedule half of the same behaviour the context
  // trigger now owns, and a 1h seed here would keep interrupting agents on the
  // old rhythm no matter what the trigger says.
  intervalMs: 7_200_000,
  to: '',
  body: '',
  enabled: false,
  autoCompact: true,
  kind: 'compact'
};

/** The 1h cadence `compact-maintenance` was seeded with before Triggers doubled
 *  it. `migrateTriggersV1` bumps only missions still sitting on this EXACT value,
 *  so an interval the user tuned by hand is left exactly where they put it. */
const LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS = 3_600_000;

/** Circuit-breaker thresholds (Lane A #6.6b). The breaker runs inside the
 *  heartbeat beat, so it only ticks when the heartbeat is enabled. Trip
 *  conditions are behavioral by default; `costCapUsd` is the only $-based one and
 *  is unset by default (a hardcoded dollar default would be arbitrary). Defaults
 *  are deliberately conservative and steer-first — `hardStop` is OFF unless the
 *  user opts in, so the breaker never auto-kills a healthy long-runner. */
export interface CircuitBreakerConfig {
  /** Master switch for breaker evaluation within the beat. Default true. */
  enabled?: boolean;
  /** Allow the top of the ladder (kill PTY + archive). Default false = the
   *  breaker may steer/constrain but never hard-stops until the user opts in. */
  hardStop?: boolean;
  /** Consecutive identical tool calls (same name+input) before tripping. */
  repeatedToolLimit?: number;
  /** Consecutive api_error / retry events before tripping. */
  errorStormLimit?: number;
  /** Output-token velocity (tokens/min, diffed across beats) before tripping. */
  tokenVelocityPerMin?: number;
}

/** Enterprise Knowledge Graph (multimodal context store + agent access tool).
 *  The user ingests their own documents/images/PDFs; agents query them on demand
 *  via the `kg` CLI. Opt-in like the heartbeat/Slack features — `enabled` gates
 *  everything (no env injected, no prompt line, no store touched when off). See
 *  docs/design/knowledge-graph.md. */
export interface KnowledgeGraphConfig {
  /** Master switch. Default false = zero behaviour change (the feature is dark). */
  enabled?: boolean;
  /** Override the store location. Unset = <userData>/knowledge. */
  rootPath?: string;
}

export interface HarnessConfig {
  /** Has the user completed the first-run onboarding? */
  onboardingComplete: boolean;
  /** Self-identified audience picked on the first onboarding screen. Drives the
   *  copy register everywhere onboarding explains itself: 'technical' shows CLI /
   *  flag lingo, 'non-technical' explains each concept in plain language. Unset =
   *  not yet chosen (treated as technical for any incidental copy). */
  audience?: 'technical' | 'non-technical';
  /** Folder where the harness keeps its own state (agent metadata, logs). */
  harnessHome: string | null;
  /** Recently-opened hive home folders (most-recent first), surfaced by the
   *  launch-time hive picker. Maintained by writeConfig whenever harnessHome is
   *  set (onboarding finish, changeHome). Capped to a handful. */
  recentHives?: string[];
  /** Open harnessHome at launch without showing the hive picker. */
  autoOpenHive?: boolean;
  /** Folder holding the agents' scratch space (.hive-scratch), the stray-file watch and
   *  the default merge repos. Null derives it from harnessHome's real parent folder;
   *  MD_WORKSPACE_ROOT in the launch environment wins over both. */
  workspaceRoot?: string | null;
  /** The name card notes use for the human who answers ASK ME ("awaiting <name>"); notes
   *  saying "the human" match either way. */
  humanName?: string | null;
  /** Folders the user registered during onboarding (used as quick-picks). */
  registeredRepos: string[];
  /** When true, new agents are spawned with --permission-mode bypassPermissions. */
  autoMode: boolean;
  /** OS sandbox for hive agents (Claude's bubblewrap block, Codex workspace-write).
   *  Off: Claude agents get no sandbox block and every Codex agent runs danger-full-access. */
  agentSandbox?: boolean;
  /** Agent ids whose whole CLI process runs in the bubblewrap jail (main/agentJail.ts).
   *  Unset or empty: nobody. */
  sandboxedAgents?: string[];
  /** Hosts every jailed agent may fetch, on top of its doing card's netAllow (main/netAllow.ts). */
  netAllowDefault?: string[];
  /** Host loopback ports a jailed agent can reach from its own network namespace
   *  (main/agentJail.ts), e.g. 9876 for Blender MCP. Default none. */
  jailLoopbackPorts?: number[];
  /** Hide the skills bundled with Claude Code from Claude hive workers (not the Boss).
   *  On by default; applies at each worker's next spawn. */
  workerDisableBundledSkills?: boolean;
  /** May the orchestrator ("Michael") spin up agents on its own?
   *
   *  Default FALSE. Spawning an agent is a SPEND decision, so it should not
   *  happen unprompted. The ability itself shipped in v0.4.4 with no gate at all,
   *  so this closes an existing default-on behaviour rather than gating a new
   *  feature: an operator who wants it must now say so.
   *
   *  Off does not FAIL a queued spawn request, it declines to consume one. The
   *  request sits in HIVE_ROOT/spawn-requests until the toggle is turned on. */
  orchestratorMaySpawn: boolean;
  /** Where Unity Hub installs editors, for the Unity broker. Unset = ~/Unity/Hub/Editor. */
  unityEditorRoot?: string;
  /** Agent Unity runs at once (2, so the human's own editor makes 3). Unset = 2. */
  unityMaxConcurrent?: number;
  /** Unity broker holds new runs below this MemAvailable in GB; 0 disables. Unset = 8. */
  unityMinMemAvailableGb?: number;
  /** Unity broker holds new runs above this memory PSI some avg10; 0 disables. Unset = 10. */
  unityMaxMemPressureAvg10?: number;
  /** Seconds between one agent's Unity run starts. Unset = 300. */
  unityAgentCooldownSec?: number;
  /** The command we run when spawning a new agent. */
  defaultCommand: string;
  /** Default model for newly spawned agents (e.g. 'claude-sonnet-5-5[1m]'); unset = CLI default. */
  defaultModel?: string;
  /** Which provider powers the GOD orchestrator ("Michael"). The persona is
   *  constant; only its engine is selectable. Default 'claude'. Eligible providers
   *  are those that can receive inbox (claude/codex/antigravity/qwen). */
  godProvider?: AgentProvider;
  /** The model GOD runs on. Unset falls back to the provider preset's
   *  `recommendedOrchestratorModel`, then MODEL_GOD. Default 'claude-opus-5-5'. */
  godModel?: string;
  /** Retired: the Boss's old per-agent ladder, read once by the tier migration. */
  godModels?: AgentModelEntry[];
  /** Camp-wide model tiers (shared/modelTiers.ts), set by the human in Settings > AI Engines;
   *  the Boss cannot edit them. */
  modelTiers?: ModelTiers;
  /** The Boss's camp tier; unset reads as the tier holding its current engine. */
  godTier?: Tier;
  /** The Boss's persisted pin. */
  godPin?: AgentModelEntry;
  /** Per-server consent state for the default MCP bundle, keyed by catalog id.
   *  Seeded from MCP_CATALOG (safe-readonly ON, write/secret OFF); the user flips
   *  these in Settings. A server is wired into an agent only when enabled here. */
  mcpDefaults?: { [id: string]: { enabled: boolean } };
  /** One-time guard: `filesystem`/`git` were switched off in mcpDefaults when they
   *  moved to the write tier. */
  mcpWriteRetierV1?: boolean;
  /** Enable semantic memory (MemPalace CLI). No-op if mempalace isn't installed. */
  semanticMemory: boolean;
  /** Embedding model for the palace: lightweight 'minilm' or multilingual 'embeddinggemma'. */
  embeddingModel: 'minilm' | 'embeddinggemma';
  /** Recurring auto-dispatch missions handled by the scheduler. */
  missions?: ScheduledMission[];
  /** One-time guard: has the built-in hourly ops standup been seeded into an
   *  existing install's missions? Prevents re-adding it after a user deletes it. */
  opsStandupSeeded?: boolean;
  /** One-time guard for the built-in heartbeat mission (mirrors opsStandupSeeded
   *  so a user who deletes the heartbeat doesn't get it re-added every boot). */
  heartbeatSeeded?: boolean;
  /** One-time guard for the weekly engine ledger review mission. */
  engineLedgerReviewSeeded?: boolean;
  /** maint-1 guard for the dedicated auto-compact maintenance mission. UNLIKE the
   *  two above, this does NOT suppress re-add forever: once seeded (flag set), a
   *  later delete makes the mission reappear DISABLED on next boot (compaction is
   *  required, so it's never silently lost — only user-disabled). */
  compactMaintenanceSeeded?: boolean;
  /** DEPRECATED (v0.3.4): config-file only, no UI anywhere. Hard dollar ceiling
   *  across all active agents. Still enforced if present so legacy configs keep
   *  their guard, but the token cap (costCapTokens) is the real budget —
   *  scheduled for removal next release. */
  costCapUsd?: number;
  /** Hard TOKEN ceiling (total tokens across all active agents) before the
   *  breaker trips. The user-facing budget — set in Settings. Opt-in like the
   *  $-cap; total = input + output + cacheRead + cacheCreation, summed across the
   *  floor (the biggest token spender is blamed). */
  costCapTokens?: number;
  /** Per-agent token ceiling, keyed by agent id. When an agent's own WORK tokens
   *  (input + output + cacheCreation — cacheRead excluded, see breaker.ts #189)
   *  exceed its cap the breaker trips that agent alone (independent of the floor
   *  budget, which sums all kinds). Set from each agent's card in the Command
   *  Center. */
  agentTokenCaps?: Record<string, number>;
  /** Agent ids whose automatic inbox/queue delivery is paused. Pending messages
   *  stay durable until the operator explicitly resumes delivery. */
  autoDeliveryPausedAgents?: string[];
  /** Passed to every spawned agent as `--max-turns <n>` when set; unset = no cap
   *  (Claude Code's default). A coarse runaway guard independent of the breaker. */
  maxTurns?: number;
  /** Max concurrent god-triggered ephemeral Slack workers; extra spawn-requests
   *  wait in the queue (natural backpressure, a resource backstop). Default 4. */
  maxConcurrentWorkers?: number;
  /** Engine model/description overrides, keyed by the compiled engine IDs. */
  engines?: EngineConfig['engines'];
  /** Engine selection cutoffs; missing fields use the built-in defaults. */
  engineThresholds?: EngineConfig['engineThresholds'];
  /** Engine quota kept for some kinds of work until a date (shared/reservations.ts). */
  reservations?: Reservation[];
  /** Minutes an ephemeral worker may produce NO output before the reaper kills it
   *  — idle-based, never wall-clock, so an actively-working worker is never reaped.
   *  Default 20. */
  workerIdleTimeoutMinutes?: number;
  /** Registered integrations (Phase 2) — labeled REST endpoints workers reach through
   *  the loopback secret broker. METADATA ONLY: each record carries a `secretRef`
   *  handle, never the secret value (secrets live encrypted in a separate file via
   *  Electron safeStorage — see src/main/integrations.ts). Default []. */
  integrations?: IntegrationRecord[];
  /** Default per-worker TOTAL-token cap (input+output+cache) applied to every
   *  god-triggered ephemeral worker; a worker's own spawn-request `tokenCap`
   *  overrides it. When the effective cap is exceeded the worker is reaped (its
   *  committed work preserved) and god is informed. This is PLUMBING for a later
   *  budget feature: per the human directive there is NO per-worker cap today, so
   *  the default is 0 = UNLIMITED — the mechanism is wired but never throttles
   *  unless someone explicitly sets a positive cap (per request or here). */
  defaultWorkerTokenCap?: number;
  /** Circuit-breaker thresholds (Lane A #6.6b). Unset = conservative defaults. */
  circuitBreaker?: CircuitBreakerConfig;
  /** Live timing cadences and caps for engine loops, beats and guardrails. */
  timings?: TimingsConfig;
  /** Enterprise Knowledge Graph (multimodal context for agents). Default OFF. */
  knowledgeGraph?: KnowledgeGraphConfig;
  /** Fire native desktop notifications on agent lifecycle events (idle finish / waiting for input). */
  notifications?: boolean;
  /** Opt-in "strong keep-alive": while ≥1 agent PTY is live, escalate the power
   *  blocker from 'prevent-app-suspension' to 'prevent-display-sleep', which on
   *  macOS also blocks TRUE system sleep (lid-close/idle) so scheduled missions
   *  and terminals keep firing ON TIME while away — at a battery cost (best on
   *  AC). Default OFF: the honest default is "survive sleep + catch up once on
   *  resume" (see the powerMonitor 'resume' handler), not "stay awake". */
  strongKeepalive?: boolean;
  /** After the harness merges a branch the human approved (ask_human on_approve), remove the
   *  worker's worktree when it is clean, merged and inside that worker's own scratch,
   *  and ask the worker to delete its own non-git scratch. Default ON;
   *  an explicit false in config.json keeps it off. */
  harnessMergeCleanup?: boolean;
  /** Auto-update from GitHub releases (v0.3.4). Default ON. Packaged builds
   *  check on boot + every ~6h, download in the background, and show a
   *  "restart to update" toast — installation is always user-initiated. OFF
   *  disables checking entirely. (Mirrored in preload + renderer config.) */
  autoUpdate?: boolean;
  /** Multi-window "floors": expose a New Floor action that opens additional
   *  windows, each an independent office with isolated renderer state (its own
   *  session partition) and per-window PTY routing. ON by default (v0.3.4: code
   *  and comment disagreed; the shipped behavior — enabled — wins) —
   *  the window/PTY-ownership plumbing is always active and single-window-safe,
   *  but the New Floor entry points (app menu item + IPC) only appear when on.
   *  The on-disk hive (god orchestration under harnessHome) stays process-global;
   *  floors share it. */
  multiWindow?: boolean;
  /** Outside path to run camp MCP server from instead of bundled script. */
  campMcpServerPath?: string;
  /** Absolute path to a phone page HTML file (e.g. out/phone/index.html), read on each request. Missing, unreadable or non-file falls back to the bundled page. */
  campPhonePagePath?: string;
  /** Outside loose renderer directory (e.g. out/renderer) or HTML entry point to load desktop UI from without repackaging AppImage. */
  campRendererDir?: string;
  /** Alias for campRendererDir pointing to loose renderer directory or file. */
  campRendererPath?: string;
  /** Terminal theme — mirrored into each agent's per-session Claude settings
   *  ("theme" key) at spawn so the TUI's truecolor palette matches. Scoped to
   *  harness agents only; the user's global Claude theme is never touched. */
  terminalTheme?: 'light' | 'dark';
  /** Anonymous product analytics (PostHog) — the exact events/properties are
   *  documented in TELEMETRY.md. Default ON (opt-out, like autoUpdate); builds
   *  without an injected key and environments with DO_NOT_TRACK set never send
   *  regardless of this flag. (Mirrored in preload + renderer config.) */
  telemetryEnabled?: boolean;
  /** Master flag for the TV-show office themes feature (Settings theme picker +
   *  destructive switch flow). Default false = the picker is hidden and the
   *  office renders as today (zero behavior change). */
  tvShowOffices?: boolean;
  /** Which office map/cast theme the pixel office renders. Only honored when
   *  `tvShowOffices` is on; otherwise the office theme is used. Unbuilt show
   *  themes fall back to 'office' in the loader. */
  /** A built-in theme id or an installed theme pack's id. */
  officeTheme?: string;
  /** Per-CLI-provider local/self-hosted base URL (Ollama/LM Studio/vLLM, …) for the
   *  OpenCode/Crush/pi/qwen engines; applied at spawn (config-injection or proxy
   *  upstream). API KEYS are NOT stored here — they live write-only in the secret
   *  broker (integrations.ts), read MAIN-ONLY at spawn. */
  providerBaseUrls?: Partial<Record<AgentProvider, string>>;
  /** Per-CLI-provider default model slug, used to pre-fill the model picker. */
  providerDefaultModels?: Partial<Record<AgentProvider, string>>;
  /** Master toggle for the Slack → Michael's-queue integration. */
  slackEnabled?: boolean;
  /** Slack app signing secret (Basic Information → Signing Secret). Never logged. */
  slackSigningSecret?: string;
  /** Bot token (xoxb-…) — only needed if the bot ever replies; optional for now. */
  slackBotToken?: string;
  /** Restrict ingestion to one channel id; empty/undefined = any channel. */
  slackChannelId?: string;
  /** Local HTTP port the webhook server binds to (default 3847). */
  slackPort?: number;
  /** Opt-in: allow APP/VOICE-INITIATED proactive posting into Slack (e.g. the
   *  renderer's "queued" acknowledgement). DEFAULT OFF per the human directive
   *  "stop posting into Slack by default". This does NOT gate the Slack-ORIGIN
   *  done-reply round-trip (a user @-mention → task → result posted back to that
   *  thread) or an agent's own direct in-thread reply — those always stay on. */
  slackProactivePosting?: boolean;

  // ─── Free Flow (voice dictation → message queue) ───────────────────────────
  /** Master toggle for Free Flow push-to-talk dictation. Default OFF: with it off
   *  the composer shows no mic button, no getUserMedia runs, and no Groq call is
   *  ever made (zero behavior change). */
  freeflowEnabled?: boolean;
  /** User-pasted Groq API key (the user supplies their own free key). Used ONLY in
   *  the main process for the Groq STT call; NEVER logged, and never crosses IPC
   *  for the request. Treated like `slackBotToken`. */
  groqApiKey?: string;
  /** Groq Whisper model id. Default 'whisper-large-v3-turbo' (fast, multilingual). */
  freeflowModel?: string;

  /** Global shortcut for snip-to-card (shared/snip.ts). Unset = DEFAULT_SNIP_HOTKEY, '' = off. */
  snipHotkey?: string;
  /** SNIP_DEFAULTS_VERSION once replaced snip defaults were rewritten (shared/snip.ts migratedSnipHotkey). */
  snipDefaultsVersion?: number;

  // ─── Realtime Michael (premium speech-to-speech voice orchestrator) ─────────
  /** True ONLY while a Realtime Michael voice session is live: the renderer
   *  session flips this on at start() (before getUserMedia) and off at stop().
   *  The main-process mic permission gate reads it so the Electron media
   *  permission is open EXACTLY while the voice loop holds the mic — never just
   *  because an OpenAI key exists (that key is shared with the CLI engines).
   *  Default off; absence ⇒ mic denied, mirroring `freeflowEnabled`. */
  realtimeVoiceEnabled?: boolean;
  /** How long (ms) a realtime voice session may sit with no voice activity before
   *  it auto-disconnects (the rt-9 idle guard). Default 180000 (3 min). 0 = never
   *  auto-disconnect on idle — the spend cap remains the runaway guard. The user
   *  tunes this in Settings → Realtime Michael. */
  realtimeIdleDisconnectMs?: number;

  // ─── Generic inbound webhook + status API (LEGACY, single-endpoint) ─────────
  // Superseded by `webhookTriggers`, which allows many endpoints over one server
  // and one tunnel. These three are kept because they are the MIGRATION SOURCE
  // (`migrateTriggersV1` folds them into a `WebhookTrigger`) and because the main
  // process still reads them until the server is rewired onto the new list.
  // Nothing new should be written here.
  /** @deprecated Use `webhookTriggers[].enabled`. */
  webhookEnabled?: boolean;
  /** App-generated shared secret callers echo in `x-md-webhook-secret`. Never
   *  logged, and never forwarded into the routed message/card/response.
   *  @deprecated Use `webhookTriggers[].secret` (one secret per endpoint, so
   *  revoking one caller never disturbs the others). */
  webhookSecret?: string;
  /** Local HTTP port the generic webhook server binds to (default 3849).
   *  @deprecated The port is a property of the shared server, not of any one
   *  trigger; `webhookTriggers` are multiplexed over it by id. */
  webhookPort?: number;

  // ─── Triggers (src/shared/triggers.ts owns every type here) ────────────────
  /** Auto-compaction / auto-clearing of agent terminal context. Both halves ship
   *  in DEFAULT_CONTEXT_TRIGGER; `readConfig` deep-fills them, because the
   *  top-level merge below is one level deep and a half-written sub-object would
   *  otherwise reach consumers with `undefined` thresholds. */
  contextTrigger?: ContextTriggerConfig;
  bossInboxNudge?: Partial<BossInboxNudgeConfig>;
  /** Inbound HTTP endpoints, one entry per caller. Replaces the legacy single
   *  webhook above; several coexist on one port, told apart by `id` in the path. */
  webhookTriggers?: WebhookTrigger[];
  /** Peer messaging between teammates' clone nodes. Persistence + UI only today —
   *  no transport service reads `apiKey` yet. */
  orgTrigger?: OrgTriggerConfig;
  /** One-time guard for `migrateTriggersV1` (legacy webhook → webhookTriggers,
   *  1h → 2h compact cadence). Set once the migration has run to completion. */
  triggersMigratedV1?: boolean;
  /** One-time guard for `cleanSnapshotDefaultsV1`. Keep it out of DEFAULTS, or a
   *  stored config without it reads as already cleaned. */
  snapshotDefaultsCleanedV1?: boolean;

  // ─── Memory reflection (the janitor's condense half) ───────────────────────
  /** Master toggle for the in-process MemoryReflector. Default on. */
  reflectEnabled?: boolean;
  /** How often to scan agent memory.md files for condensing (default 30 min). */
  reflectIntervalMs?: number;
  /** Condense when bytes exceed this percent of the 128 KB budget (matches the
   *  janitor's TRIGGER_PCT). DECIDED: 50. */
  reflectByteTriggerPct?: number;
  /** ...OR when `## ` section count exceeds this (AND bytes > floor). DECIDED: 50. */
  reflectSectionTrigger?: number;
  /** Newest K verbatim `## ` sections kept untouched on each condense. */
  reflectRecentKeep?: number;
  /** Never condense a file smaller than this; also the section-trigger byte floor.
   *  DECIDED: 16 KB. */
  reflectMinBytes?: number;

  // ─── Drop folder notifiers ────────────────────────────────────────────────
  /** Config-declared drop folders run by the generic ticker (replaces hand-written pollers). */
  dropFolders?: DropFolderConfig[];

  // ─── Message routes ───────────────────────────────────────────────────────
  /** Message routing table mapping engine lifecycle/webhook/heartbeat events to agent recipients. */
  routes?: MessageRoutesConfig;
}

const DEFAULTS: HarnessConfig = {
  onboardingComplete: false,
  harnessHome: null,
  recentHives: [],
  registeredRepos: [],
  autoMode: true,
  agentSandbox: false,
  workerDisableBundledSkills: true,
  orchestratorMaySpawn: false,
  defaultCommand: 'claude',
  godProvider: 'claude',
  godModel: 'claude-opus-5-5',
  // Global default model for every agent that hasn't picked one explicitly — wins
  // over the role-based tiers (modelForRole) in the spawn handler, so all agents
  // (incl. god) default to Opus 5.5. A per-agent model choice still overrides it.
  defaultModel: 'claude-opus-5-5',
  // Seeded from the MCP catalog so the consent defaults never drift from it
  // (safe-readonly ON, write/secret OFF).
  mcpDefaults: defaultMcpDefaults(),
  maxConcurrentWorkers: 4,
  workerIdleTimeoutMinutes: 20,
  integrations: [],
  defaultWorkerTokenCap: 0, // 0 = unlimited (human directive: NO per-worker cap)
  semanticMemory: true,
  embeddingModel: 'minilm',
  missions: [OPS_STANDUP_MISSION],
  notifications: false,
  strongKeepalive: false,
  harnessMergeCleanup: true,
  autoUpdate: true,
  telemetryEnabled: true,
  multiWindow: true,
  tvShowOffices: false,
  officeTheme: 'office',
  slackEnabled: false,
  slackSigningSecret: undefined,
  slackBotToken: undefined,
  slackChannelId: undefined,
  slackPort: undefined,
  slackProactivePosting: false,
  freeflowEnabled: true,
  groqApiKey: undefined,
  freeflowModel: 'whisper-large-v3-turbo',
  realtimeVoiceEnabled: false,
  realtimeIdleDisconnectMs: 180_000,
  webhookEnabled: false,
  webhookSecret: undefined,
  webhookPort: undefined,
  // Triggers. These three are the ONLY object/array defaults that get handed
  // straight back out of `readConfig` for a config that never persisted them, so
  // `withTriggerDefaults` re-copies them on every read — see the note there.
  contextTrigger: DEFAULT_CONTEXT_TRIGGER,
  webhookTriggers: [],
  orgTrigger: DEFAULT_ORG_TRIGGER,
  triggersMigratedV1: false,
  // Memory reflection — preventive; nobody is over threshold today, so it sits
  // dark until an agent's memory crosses one of these (the verify gate is the
  // safety for the LLM step). Thresholds DECIDED by god 2026-06-06.
  reflectEnabled: true,
  reflectIntervalMs: 1_800_000,
  reflectByteTriggerPct: 50,
  reflectSectionTrigger: 50,
  reflectRecentKeep: 12,
  reflectMinBytes: 16_384,
  // Enterprise Knowledge Graph — opt-in; dark until the user enables it.
  // v0.3.4 fix: default OFF, matching the field's own documentation ("Default
  // OFF / dark until enabled") — the true default contradicted it. Existing
  // installs keep their persisted value.
  knowledgeGraph: { enabled: false }
};

export function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

/**
 * Deep-fill the trigger sub-objects, and hand back copies of them.
 *
 * TWO problems, one fix. First, the merge in `readConfig` is one level deep, so a
 * `contextTrigger` persisted by an older build (or by a `writeConfig` that
 * patched only `compact`) arrives missing sub-keys that DEFAULTS would have
 * supplied — the consumer then reads `undefined` where it expects a number and
 * the rule never fires. Second, that same shallow merge hands the literal
 * DEFAULT_CONTEXT_TRIGGER / DEFAULT_ORG_TRIGGER instances to every config that
 * didn't persist them, so one caller mutating what it read would rewrite the
 * defaults for the whole process — and for every config read afterwards.
 *
 * Every branch below therefore constructs a fresh object, including the
 * "nothing persisted" branch.
 */
function withTriggerDefaults(cfg: HarnessConfig): HarnessConfig {
  return {
    ...cfg,
    contextTrigger: {
      compact: { ...DEFAULT_CONTEXT_TRIGGER.compact, ...cfg.contextTrigger?.compact },
      clear: { ...DEFAULT_CONTEXT_TRIGGER.clear, ...cfg.contextTrigger?.clear }
    },
    orgTrigger: { ...DEFAULT_ORG_TRIGGER, ...cfg.orgTrigger },
    webhookTriggers: Array.isArray(cfg.webhookTriggers)
      ? cfg.webhookTriggers.map((t) => ({ ...t }))
      : []
  };
}

/** Set once `migrateTriggersV1` has run in THIS process. `writeConfig` reads
 *  before it writes, so without an in-memory latch the migration's own persist
 *  would re-enter `readConfig` and run the migration a second time before
 *  `triggersMigratedV1: true` ever reached disk. */
let triggersMigrationRan = false;

/**
 * Fold the pre-Triggers config shape forward, exactly once per install.
 *
 * Runs from `readConfig`, so it is complete before any consumer can observe the
 * config — there is no boot ordering to get wrong and no window in which half
 * the app sees the old shape. Two things move:
 *
 *   1. The single legacy webhook (`webhookEnabled`/`webhookSecret`) becomes one
 *      `WebhookTrigger` with the stable id `legacy`, so the caller that already
 *      holds that secret keeps working across the upgrade. Skipped when
 *      `webhookTriggers` is already populated — the user has moved on, and
 *      re-adding a synthesised entry would resurrect a revoked endpoint.
 *   2. The seeded `compact-maintenance` mission moves from the old 1h cadence to
 *      2h, but ONLY if it still reads exactly 1h. A user-chosen interval is a
 *      decision, not a stale default, and is left alone.
 *
 * Wrapped end-to-end in a try/catch: a config that is corrupt in some unrelated
 * way must still boot the app, and a migration is never worth a failed launch.
 */
function migrateTriggersV1(cfg: HarnessConfig): HarnessConfig {
  if (cfg.triggersMigratedV1 || triggersMigrationRan) return cfg;
  triggersMigrationRan = true;
  try {
    const next: HarnessConfig = { ...cfg, triggersMigratedV1: true };

    const legacySecret = typeof cfg.webhookSecret === 'string' ? cfg.webhookSecret.trim() : '';
    if (legacySecret && (cfg.webhookTriggers?.length ?? 0) === 0) {
      next.webhookTriggers = [
        {
          id: 'legacy',
          name: 'Default webhook',
          secret: legacySecret,
          enabled: cfg.webhookEnabled ?? false,
          mode: DEFAULT_TRIGGER_MODE,
          schema: DEFAULT_WEBHOOK_SCHEMA,
          createdAt: Date.now()
        }
      ];
    }

    const missions = Array.isArray(cfg.missions) ? cfg.missions : [];
    const stale = (m: ScheduledMission): boolean =>
      m?.id === COMPACT_MAINTENANCE_MISSION.id
      && m.intervalMs === LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS;
    if (missions.some(stale)) {
      next.missions = missions.map((m) =>
        stale(m) ? { ...m, intervalMs: COMPACT_MAINTENANCE_MISSION.intervalMs } : m
      );
    }

    persistConfig(next);
    return next;
  } catch {
    // Leave the config exactly as read. The latch above stays set, so a failing
    // migration retries on the next launch rather than on every single read.
    return cfg;
  }
}

let mcpRetierRan = false;

/** Turn `filesystem`/`git` off once per install: installs seeded them ON while they
 *  were safe-readonly. Same latch and failure handling as migrateTriggersV1. Keep
 *  `mcpWriteRetierV1` out of DEFAULTS, or a stored config without it reads as done. */
function migrateMcpWriteRetierV1(cfg: HarnessConfig): HarnessConfig {
  if (cfg.mcpWriteRetierV1 || mcpRetierRan) return cfg;
  mcpRetierRan = true;
  try {
    const next: HarnessConfig = { ...cfg, mcpDefaults: retierMcpConsent(cfg.mcpDefaults), mcpWriteRetierV1: true };
    persistConfig(next);
    return next;
  } catch {
    return cfg;
  }
}

/** Defaults an older build snapshotted into config.json and that have since changed.
 *  Add a line here whenever a DEFAULTS value changes, so a stale pin is dropped once. */
const RETIRED_DEFAULTS: Partial<HarnessConfig> = {
  harnessMergeCleanup: false
};

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Drop keys that equal a current or retired default, so a default change reaches
 *  installs whose config.json was a whole-config snapshot. Runs once per install,
 *  on the raw file contents before defaults are merged in; user-set values that
 *  differ from every default are kept. */
function cleanSnapshotDefaultsV1(parsed: Record<string, unknown>): Record<string, unknown> {
  if (parsed.snapshotDefaultsCleanedV1) return parsed;
  try {
    const cleaned: Record<string, unknown> = { snapshotDefaultsCleanedV1: true };
    for (const [k, v] of Object.entries(parsed)) {
      const key = k as keyof HarnessConfig;
      const pinned = key in DEFAULTS && sameValue(v, DEFAULTS[key]);
      const retired = key in RETIRED_DEFAULTS && sameValue(v, RETIRED_DEFAULTS[key]);
      if (!pinned && !retired) cleaned[k] = v;
    }
    persistConfig(cleaned as unknown as HarnessConfig);
    return cleaned;
  } catch {
    return parsed;
  }
}

const lastGoodConfigs = new Map<string, HarnessConfig>();

export function readConfig(): HarnessConfig {
  const p = configPath();
  // No file yet = a first run with nothing to migrate; the defaults ARE the
  // post-migration shape. Deliberately does not persist — a bare read must not
  // conjure a config.json before onboarding has written one.
  if (!existsSync(p)) return withTriggerDefaults({ ...DEFAULTS });
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config must be an object');
    const stored = cleanSnapshotDefaultsV1(parsed);
    const config = migrateRetiredModels(normalizeStoredHomes(migrateMcpWriteRetierV1(migrateTriggersV1(withTriggerDefaults({ ...DEFAULTS, ...stored })))));
    lastGoodConfigs.set(p, structuredClone(config));
    return config;
  } catch {
    const cached = lastGoodConfigs.get(p);
    return cached ? structuredClone(cached) : withTriggerDefaults({ ...DEFAULTS });
  }
}

setTimingsConfigReader(readConfig);

/** The Boss's engine and the tiers moved off retired models (shared/modelMigration);
 *  persisted by the next writeConfig. defaultModel is left alone: it is reported by
 *  modelCatalogWarnings and the human picks its replacement. */
function migrateRetiredModels(cfg: HarnessConfig): HarnessConfig {
  cfg.godModel = migrateModel(cfg.godProvider ?? 'claude', cfg.godModel);
  cfg.godModels = migrateModelList(cfg.godModels);
  if (cfg.modelTiers && typeof cfg.modelTiers === 'object') {
    for (const tier of Object.keys(cfg.modelTiers) as (keyof typeof cfg.modelTiers)[]) {
      cfg.modelTiers[tier] = migrateModelList(cfg.modelTiers[tier]);
    }
  }
  cfg.defaultCommand = migrateModelCommand(cfg.defaultCommand) ?? cfg.defaultCommand;
  return cfg;
}

/** (#140, the upgrade path) A config.json persisted BEFORE `writeConfig`
 *  learned to expand `~` still holds literal `~/…` strings in `harnessHome` /
 *  `recentHives`, and nothing rewrites the file until the next write — so the
 *  hive picker renders the raw `~` string and feeds it straight back into
 *  `config:changeHome`, which lands on `resolve()` → `<cwd>/~/…`, a real
 *  directory named "~". `normalizeHiveHome` only cleans values on the way IN;
 *  this cleans them on the way OUT, so no consumer can see a `~` path
 *  regardless of the file's vintage. Expanded duplicates collapse (a stale
 *  "~/X" next to its absolute twin becomes one entry). */
function normalizeStoredHomes(cfg: HarnessConfig): HarnessConfig {
  if (typeof cfg.harnessHome === 'string' && cfg.harnessHome.trim()) {
    cfg.harnessHome = expandTilde(cfg.harnessHome);
  }
  if (Array.isArray(cfg.recentHives)) {
    const seen = new Set<string>();
    cfg.recentHives = cfg.recentHives
      .filter((h): h is string => typeof h === 'string' && !!h.trim())
      .map((h) => expandTilde(h))
      .filter((h) => (seen.has(h) ? false : (seen.add(h), true)));
  }
  return cfg;
}

/** Announces every saved setting, so a screen showing one can update.
 *
 *  Settings, Slack, voice and notifications each save by their own route, and
 *  all of them end up writing the file below — so one subscription here covers
 *  every setting rather than the ones anybody remembered to wire up. */
type ConfigWriteListener = (next: HarnessConfig) => void;
const configWriteListeners = new Set<ConfigWriteListener>();

export function onConfigWritten(listener: ConfigWriteListener): () => void {
  configWriteListeners.add(listener);
  return () => { configWriteListeners.delete(listener); };
}

function persistConfig(next: HarnessConfig): HarnessConfig {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  // Store only what differs from DEFAULTS, so a later default change reaches
  // installs that never set the key.
  // A file this build wrote is never a whole-config snapshot, so mark it cleaned:
  // otherwise a deliberate value equal to a retired default would be dropped.
  const onDisk: Record<string, unknown> = { snapshotDefaultsCleanedV1: true };
  for (const [k, v] of Object.entries(next)) {
    const key = k as keyof HarnessConfig;
    if (!(key in DEFAULTS) || !sameValue(v, DEFAULTS[key])) onDisk[k] = v;
  }
  writeFileSync(p, JSON.stringify(onDisk, null, 2), 'utf8');
  // Saving one setting stores only that setting, so fill the rest back in first:
  // subscribers must see the same complete config a read gives them, never a
  // half-filled one. Skip the migration — it saves in its own right, and has
  // already run against what this change was built on.
  const view = normalizeStoredHomes(withTriggerDefaults({ ...DEFAULTS, ...next }));
  lastGoodConfigs.set(p, structuredClone(view));
  // The change is already saved, so one failed subscriber must not fail the save
  // for its caller, nor stop the subscribers after it.
  for (const listener of configWriteListeners) {
    try { listener(view); } catch { /* a broken listener is not a failed save */ }
  }
  return next;
}

export function writeConfig(patch: Partial<HarnessConfig>): HarnessConfig {
  const current = readConfig();
  const next: HarnessConfig = { ...current, ...patch };
  // Project INGESTION — a registered repo is typed by hand ("~/dev/foo") as often
  // as it is picked from the folder dialog. Expand `~` here so the persisted list
  // (and therefore every agent's default cwd) is ABSOLUTE; Node's fs/spawn treat
  // `~` as a literal directory name and the spawn dies with `cwd does not exist`.
  if (Array.isArray(patch.registeredRepos)) {
    const seen = new Set<string>();
    next.registeredRepos = patch.registeredRepos
      .map((r) => expandTilde(r))
      .filter((r) => r && !seen.has(r) && (seen.add(r), true));
  }
  // The HIVE HOME needs the exact same treatment as registeredRepos above, and for
  // years it did not get it (#140). Onboarding SUGGESTS `~/HarnessAgents` and the
  // field is free text, so the common path — accept the default, press Finish —
  // persisted a literal `~`. The first thing the finish step does is create the
  // directory, and Node's mkdir has no idea what `~` means: it tried to make a
  // folder actually named "~", which fails as
  //   ENOENT: no such file or directory, mkdir '~/HarnessAgents'
  // and left the wizard wedged on its last step with no way forward. Expand BEFORE
  // the value is persisted or copied into recentHives, so every downstream reader
  // (mkdir, the hive root, the launch picker) sees one absolute path.
  if (typeof patch.harnessHome === 'string' && patch.harnessHome) {
    const { home, recentHives } = normalizeHiveHome(patch.harnessHome, current.recentHives ?? []);
    next.harnessHome = home;
    next.recentHives = recentHives;
  }
  return persistConfig(next);
}

/** Set or clear one agent's token ceiling against the latest config on disk.
 *
 * Renderer config objects are snapshots. Replacing `agentTokenCaps` from one of
 * those snapshots loses caps written since the snapshot was read (most visibly
 * while reviewing a batch of imported hires). Keep the read-modify-write in the
 * synchronous main process so each call merges with the result of the previous
 * one before returning the updated config to the renderer. */
export function setAgentTokenCap(agentId: unknown, tokenCap: unknown): HarnessConfig {
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    throw new Error('invalid agent token cap');
  }
  if (
    tokenCap !== undefined
    && (
      typeof tokenCap !== 'number'
      || !Number.isInteger(tokenCap)
      || tokenCap <= 0
      || tokenCap > MAX_AGENT_TOKEN_CAP
    )
  ) throw new Error('invalid agent token cap');

  const current = readConfig();
  const agentTokenCaps = { ...(current.agentTokenCaps ?? {}) };
  if (tokenCap === undefined) delete agentTokenCaps[agentId];
  else agentTokenCaps[agentId] = tokenCap;
  return persistConfig({
    ...current,
    agentTokenCaps
  });
}

/** Wipe the persisted config back to first-run defaults so the app boots into
 *  onboarding again. Used by the "reset & start over" flow. */
export function resetConfig(): HarnessConfig {
  // Saved like any other change, so a reset announces itself too.
  persistConfig({ ...DEFAULTS });
  // Drop the migration latch too: the file on disk is back to `triggersMigratedV1:
  // false`, and a latch left set would keep the flag from ever being written again
  // in this process. The migration itself is a no-op on defaults either way.
  triggersMigrationRan = false;
  return withTriggerDefaults({ ...DEFAULTS });
}

/** Model ids by tier (Lane A #6.4). Kept in sync with the claude list in
 *  src/shared/modelCatalog.json, which `agentModels()` in
 *  src/renderer/src/store/config.ts reads. */
const MODEL_GOD = 'claude-opus-5-5';                  // orchestration, highest capability
const MODEL_WORKER = 'claude-sonnet-5-5';             // general execution
const MODEL_HELPER = 'claude-haiku-5-5';             // narrow, cheap helpers

/** Minimal structural shape for tiering — a subset of AgentMeta so config.ts
 *  stays free of a hive.ts import. */
export interface RoleHint {
  isGod?: boolean;
  role?: string;
  capabilities?: string[];
}

/** Default model for an agent given its role (Lane A #6.4): Opus for the god,
 *  Haiku for narrow helpers (triage / routing / verification / formatting),
 *  Sonnet for general workers. Returns a model id (matching the catalog) or
 *  undefined to fall back to the CLI default. This is only a DEFAULT — an
 *  explicit per-agent model selection always wins. */
export function modelForRole(
  meta: RoleHint,
  config?: Pick<HarnessConfig, 'godProvider' | 'godModel'>
): string | undefined {
  if (meta.isGod) {
    // GOD engine is selectable: an explicit godModel wins, else the chosen
    // provider's recommended orchestrator model, else the legacy Opus default.
    const preset = providerPreset(config?.godProvider ?? 'claude');
    return config?.godModel ?? preset.recommendedOrchestratorModel ?? MODEL_GOD;
  }
  const hay = `${meta.role ?? ''} ${(meta.capabilities ?? []).join(' ')}`.toLowerCase();
  if (/\b(triage|rout|verif|lint|format|summar|classif|label)/.test(hay)) return MODEL_HELPER;
  return MODEL_WORKER;
}

/** Ensure harnessHome exists on disk. Expands `~` first — the onboarding wizard
 *  lets the user type the path, and mkdir treats a literal `~` as a plain
 *  directory name (issue #140's `ENOENT: mkdir '~/HarnessAgents'`). */
export function ensureHarnessHome(path: string): { ok: boolean; error?: string } {
  try {
    // Expand HERE too, not only at the config write (#140). This runs FIRST —
    // onboarding calls it before updateConfig — so normalizing only at the write
    // boundary left the actual mkdir still receiving a literal `~`. Depending on
    // the process cwd that either fails outright or, worse, quietly succeeds by
    // creating a directory genuinely named "~" somewhere nobody will look, and
    // the hive then lives at a path the user cannot find. This is the
    // "defense-in-depth at the consumers" the expandTilde doc calls for: the
    // ingestion point normalizes, and the consumer refuses to trust that it did.
    mkdirSync(expandTilde(path), { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function ensureClaudeGlobalPermissions(home: string): void {
  const dir = join(home, '.claude');
  const p = join(dir, 'settings.json');
  try {
    let s: Record<string, unknown> = {};
    if (existsSync(p)) {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      s = parsed as Record<string, unknown>;
    }
    if (s.skipDangerousModePermissionPrompt !== true || s.skipAutoPermissionPrompt !== true) {
      s.skipDangerousModePermissionPrompt = true;
      s.skipAutoPermissionPrompt = true;
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
    }
  } catch (error) {
    console.warn(
      `[config] Could not safely update Claude config at ${p}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

type ClaudeProjectConfig = Record<string, unknown> & { hasTrustDialogAccepted?: boolean };
type ClaudeConfig = Record<string, unknown> & { projects?: Record<string, ClaudeProjectConfig> };

function ensureClaudeProjectTrust(home: string, cwd: string): void {
  const p = join(home, '.claude.json');
  try {
    let c: ClaudeConfig = {};
    if (existsSync(p)) {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      c = parsed as ClaudeConfig;
    }
    if (c.projects?.[cwd]?.hasTrustDialogAccepted !== true) {
      c.projects = c.projects ?? {};
      c.projects[cwd] = { ...(c.projects[cwd] ?? {}), hasTrustDialogAccepted: true };
      writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');
    }
  } catch (error) {
    console.warn(
      `[config] Could not safely update Claude config at ${p}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Idempotently pre-accept Claude Code's first-run prompts so agents spawned with
 *  `--permission-mode bypassPermissions` start cleanly. Without this, a fresh
 *  install shows an interactive "WARNING: Bypass Permissions mode … 1. No, exit /
 *  2. Yes, I accept" prompt that the PTY can't answer in time, so the agent exits
 *  code 1 on its own (reported by multiple users).
 *
 *  Two separate gates, written only when they aren't already satisfied (so we
 *  rarely touch files a running `claude` also writes):
 *   1. `~/.claude/settings.json` → `skipDangerousModePermissionPrompt` +
 *      `skipAutoPermissionPrompt` — these gate the bypass-mode warning (global).
 *   2. `~/.claude.json` → `projects[cwd].hasTrustDialogAccepted` — the per-folder
 *      "do you trust the files in this folder?" dialog.
 *
 *  Each file is an independent best-effort boundary: unsafe existing contents
 *  are preserved without preventing the other file from being handled safely. */
export function ensureClaudePermissionsAccepted(cwd?: string): void {
  let home: string;
  try { home = homedir(); } catch { return; }
  if (!home) return;

  ensureClaudeGlobalPermissions(home);
  if (cwd) {
    ensureClaudeProjectTrust(home, cwd);
  }
}

export interface ConfigWatcherOptions {
  debounceMs?: number;
  onReload?: (config: HarnessConfig) => void;
}

/**
 * Watch config.json for on-disk changes with debouncing, surviving bad JSON
 * by keeping the last good known config.
 */
export function startConfigWatcher(
  options?: ConfigWatcherOptions
): { close: () => void } {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  readConfig(); // Seed the fallback before an external editor can truncate the file.
  return watchFiles([path], () => options?.onReload?.(readConfig()), options?.debounceMs);
}

