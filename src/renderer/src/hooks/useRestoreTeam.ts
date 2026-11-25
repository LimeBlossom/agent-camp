import { useSyncExternalStore } from 'react';
import { useStore, type Agent } from '@/store/store';
import { buildSpawnCommand, inferAgentProvider, tokenizeCommand, type HarnessConfig } from '@/store/config';
import { roleForHiveSpawn } from '@shared/agentRole';
import { freshEngine } from './freshEngine';

/** "Restore team": respawn workers from the previous session.
 *
 *  Lives here rather than inside AgentStrip because the floor strip is hidden in
 *  fullscreen, which used to mean the restore button (and the list of restorable
 *  agents) simply vanished when you went fullscreen. Both mount points share the
 *  progress state below, so a restore kicked off from one view shows as running
 *  in the other and can't be double-started.
 *
 *  Nothing restores on its own at launch. The restorable list doubles as the
 *  DORMANT roster: useHive wakes one agent through `wakeDormantAgent` when it has
 *  work (shared/dormantWake.ts) or the Boss files a wake request. */

let restoring = false;
let note: string | null = null;
const listeners = new Set<() => void>();

/** Config from the latest hook render or wake call. Used to rebuild a spawn command
 *  for an agent persisted before the `command` field existed, or moved to another
 *  entry of its model list. */
let lastConfig: HarnessConfig | null = null;
/** Wakes asked for while a restore was running; drained when it finishes. */
const pendingWakes = new Set<string>();
/** Last wake attempt per agent. A failed spawn leaves the agent restorable and
 *  the has-work poll keeps seeing its work, so without this it respawns every tick. */
const wakeStamps = new Map<string, number>();
export const WAKE_RETRY_MS = 60_000;

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// useSyncExternalStore requires a stable snapshot identity — returning a fresh
// object each call would loop forever, so the two fields are read separately.
const getRestoring = (): boolean => restoring;
const getNote = (): string | null => note;

export interface RestoreTeamState {
  restoring: boolean;
  /** Outcome of the last run ("restored 3 · 1 failed — …"), or null. */
  restoreNote: string | null;
  /** Respawn the restorable agents; with `onlyId`, just that one. */
  restoreTeam: (onlyId?: string) => Promise<void>;
}

/** Respawn restorable workers (all of them, or just `onlyIds`) with their
 *  ORIGINAL agent id, cwd, model and command — the hive workspace (memory.md,
 *  inbox, registry entry) reattaches by itself, no memory transplant needed. */
async function restoreAgents(onlyIds?: string[]): Promise<void> {
  if (restoring) {
    for (const id of onlyIds ?? []) pendingWakes.add(id);
    return;
  }
  restoring = true;
  note = null;
  emit();
  const prevSel = useStore.getState().selectedId;
  const restorableAgents = useStore.getState().restorableAgents.filter((a) => !onlyIds || onlyIds.includes(a.id));
  // Tally every agent's outcome so the run ALWAYS leaves a visible trace — the
  // original bug was that every failure path was console-only, so a click that
  // couldn't spawn anything looked like a dead button.
  let restored = 0;
  let alreadyLive = 0;
  // Main's start prompt for agents that wait to be typed to (Claude); others got it on argv.
  const kickoffs = new Map<string, string>();
  const failures: string[] = [];
  try {
    // Restore every agent CONCURRENTLY. Each spawn is keyed by its own ptyId and
    // touches no cross-agent state in the renderer, and in the main process the
    // whole `pty:spawn` handler (hive registry read-modify-write included) runs
    // synchronously between awaits, so concurrent handlers can't interleave
    // mid-update. Serially this cost the sum of every agent's git probe + spawn;
    // a 6-agent team took ~6× one agent for no reason.
    // Spawns run concurrently but agents are ADDED in roster order afterwards.
    // Calling addAgent from inside each spawn made completion timing decide
    // the roster order — and that order is persisted, so a slow provider or a
    // slow git probe silently overwrote the sequence the user had dragged the
    // cards into.
    const restoredInOrder = await Promise.all([...restorableAgents].map(async (a): Promise<Agent | null> => {
      // Per-agent guard: one agent's failure (or a rejected IPC call) must NEVER
      // abort the others — an unhandled rejection here used to make the
      // entire restore a silent no-op after the first bad agent.
      try {
        const savedProvider = inferAgentProvider(a.command, a.provider);
        const savedCommand = (a.command ?? '').trim() || (lastConfig ? buildSpawnCommand(lastConfig, a.model, savedProvider) : '');
        // Every spawn here is fresh, so it may move along the agent's tier walk.
        const engine = savedCommand
          ? await freshEngine(a.id, false, { provider: savedProvider, model: a.model, command: savedCommand }, lastConfig)
          : { provider: savedProvider, model: a.model, command: savedCommand, note: undefined };
        const { provider, command } = engine;
        if (!command || !a.cwd) {
          // No spawn recipe (an old entry persisted before `command`, with no
          // config to rebuild one). Keep it restorable and SAY why rather than
          // silently dropping it — silent removal read as "nothing happened".
          failures.push(`${a.name}: no saved command`);
          return null;
        }
        const [exe, ...args] = tokenizeCommand(command);
        const ptyId = a.ptyId ?? `pty-${a.id}`;
        // An isolated agent's worktree SURVIVES an app restart on disk (it's only
        // torn down on per-tab close / mid-session exit, not on quit). So re-enter
        // that exact worktree as the cwd rather than re-isolating — `git worktree
        // add` would conflict with the existing path/branch, and re-isolating would
        // also lose the worktree's uncommitted work. cwd = the worktree means
        // resume + seedSessionTranscript land in the CORRECT checkout.
        // But the user may have manually pruned/deleted the worktree between runs —
        // gitIsRepo (git rev-parse) returns false for a missing/invalid dir, so
        // fall back to the base repo cwd rather than spawning into a dead path.
        let cwd = a.cwd;
        let worktreeGone = false;
        if (a.worktreePath) {
          if (await window.cth.gitIsRepo(a.worktreePath)) {
            cwd = a.worktreePath;
          } else {
            worktreeGone = true;
            console.warn(`[restore] worktree gone for ${a.id} (${a.worktreePath}); falling back to base repo ${a.cwd}`);
          }
        }
        const res = await window.cth.spawnPty({
          id: ptyId,
          cwd,
          command: exe,
          provider,
          args,
          cols: 100,
          rows: 30,
          // Worktree (if any) already exists on disk — cd into it, don't create a
          // new one (re-isolating would conflict on the existing path/branch and
          // lose its uncommitted work).
          isolate: false,
          // Fresh session on purpose: resuming reloads a day-old context on every
          // wake and burned the Codex 5-hour limit. Continuity is tasks, ASK ME,
          // memory.md and inbox, which reattach by agent id.
          resume: false,
          hive: { id: a.id, name: a.name, provider, cwd, role: roleForHiveSpawn(a) }
        });
        if (res.ok) {
          restored++;
          if (res.kickoff) kickoffs.set(a.id, res.kickoff);
          return {
              ...a,
              provider,
              ...(engine.note ? { model: engine.model, command } : {}),
              ptyId,
              archived: false,
              status: 'idle',
              // Surface the worktree fallback on the floor card; otherwise normal.
              action: worktreeGone ? 'worktree gone — using base repo' : engine.note ?? 'starting up',
              // The worktree is no longer on disk — drop it so this agent is treated
              // as a plain base-cwd agent going forward (a future restore won't keep
              // re-probing a dead path).
              worktreePath: worktreeGone ? undefined : a.worktreePath,
              // Crush spawns bare (no positional protocol) and hands the seed back
              // here; useHive types it after boot. Re-seeding a resumed worker is
              // idempotent (it just re-reads its inbox per protocol). (ondev-b)
              seedPrompt: res.seedPrompt,
              carrying: undefined,
              currentStation: 'desk',
              recentTextTs: Date.now()
          };
        } else if ((res.error ?? '').includes('already exists')) {
          // A live PTY with this id is already running (e.g. respawned at boot or
          // by another path) — the agent isn't actually missing, so retire it from
          // the restorable list rather than reporting a phantom failure.
          alreadyLive++;
          useStore.getState().removeRestorableAgent(a.id);
        } else {
          // Leave it restorable so the user can retry — but record WHY so the
          // outcome is shown on the floor, not buried in the devtools console.
          failures.push(`${a.name}: ${res.error ?? 'spawn failed'}`);
          console.error('[restore] spawn failed for', a.id, res.error);
        }
      } catch (e) {
        failures.push(`${a.name}: ${e instanceof Error ? e.message : String(e)}`);
        console.error('[restore] error for', a.id, e);
      }
      return null;
    }));
    // Add in the ORIGINAL roster order, not completion order.
    for (const restoredAgent of restoredInOrder) {
      if (!restoredAgent) continue;
      useStore.getState().addAgent(restoredAgent);
      const kickoff = kickoffs.get(restoredAgent.id);
      if (kickoff) useStore.getState().enqueueMessage(restoredAgent.id, kickoff);
    }
    // A close-and-rewake that did not spawn leaves the floor like any dormant agent.
    for (const a of restorableAgents) {
      if (a.rewaking && !restoredInOrder.some((r) => r?.id === a.id)) useStore.getState().updateAgent(a.id, { rewaking: undefined });
    }
  } finally {
    // addAgent auto-selects each spawn; put the user back where they were.
    const sel = useStore.getState();
    if (prevSel && sel.agents.some((x) => x.id === prevSel)) sel.select(prevSel);
    restoring = false;
    // ALWAYS surface a result so the button can never look inert.
    const parts: string[] = [];
    if (restored) parts.push(`restored ${restored}`);
    if (alreadyLive) parts.push(`${alreadyLive} already live`);
    if (failures.length) parts.push(`${failures.length} failed — ${failures.join('; ')}`);
    note = parts.length ? parts.join(' · ') : 'nothing to restore';
    emit();
    if (pendingWakes.size) {
      const next = [...pendingWakes];
      pendingWakes.clear();
      void restoreAgents(next);
    }
  }
}

/**
 * Spawn one dormant agent. Returns false when it is not dormant (already live,
 * dismissed, or unknown) or was tried within WAKE_RETRY_MS, unless `force` (a limit
 * switch just put it to sleep and it must come back now). What it is woken for is
 * main's business: the spawn reads the agent's cards, mail, any Boss reason and any
 * handoff note.
 */
export function wakeDormantAgent(id: string, config: HarnessConfig | null | undefined, force = false): boolean {
  if (config) lastConfig = config;
  if (!useStore.getState().restorableAgents.some((a) => a.id === id)) return false;
  const now = Date.now();
  if (!force && now - (wakeStamps.get(id) ?? 0) < WAKE_RETRY_MS) return false;
  wakeStamps.set(id, now);
  void restoreAgents([id]);
  return true;
}

/**
 * @param config used to rebuild a spawn command for a restorable agent persisted
 *        before the `command` field existed, or moved by its model list.
 */
export function useRestoreTeam(config?: HarnessConfig | null): RestoreTeamState {
  const isRestoring = useSyncExternalStore(subscribe, getRestoring, getRestoring);
  const restoreNote = useSyncExternalStore(subscribe, getNote, getNote);
  if (config) lastConfig = config;
  const restoreTeam = (onlyId?: string): Promise<void> => restoreAgents(onlyId ? [onlyId] : undefined);
  return { restoring: isRestoring, restoreNote, restoreTeam };
}
