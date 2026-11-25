/**
 * How a god-hired worker's spawn request becomes an executable + argv, as a
 * pure function: this exact translation silently killed real workers for days
 * while reporting success, which is what earned it a unit test.
 */
import { type AgentProvider, autoModeFlagForProvider, hasAutoModeStance, inferAgentProvider, normalizeAgentProvider, providerPreset } from '../shared/agentProvider';
import { tokenizeCommand } from '../shared/commandLine';

export interface WorkerLaunch {
  /** The executable name alone — what the PTY layer resolves and spawns. */
  bin: string;
  /** Everything else, in argv form, model flag included when applicable. */
  args: string[];
  /** The full effective command line, for display and floor cards. */
  command: string;
  env: Record<string, string>;
}

export function workerContextEnv(provider: AgentProvider, isGod = false, agentId?: string): Record<string, string> {
  if (provider !== 'claude' || isGod || agentId === 'god') return {};
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' };
}

export function buildWorkerLaunch(opts: {
  /** `command` from the spawn request — god authors a full command LINE. */
  requestCommand?: unknown;
  requestProvider?: unknown;
  /** Separate `model` field from the request, if any. */
  requestModel?: unknown;
  defaultCommand?: string;
  /** The app's auto (skip-permissions) setting. */
  autoMode: boolean;
  isGod?: boolean;
  agentId?: string;
}): WorkerLaunch {
  // Throws on a request that would launch the wrong CLI; the caller rejects it.
  const requested = typeof opts.requestProvider === 'string' && opts.requestProvider.trim() ? opts.requestProvider.trim() : '';
  const named = normalizeAgentProvider(requested);
  if (requested && !named) throw new Error(`unknown "provider" "${requested}"`);
  // A named provider launches its own CLI; a non-claude request must never land on claude.
  let command =
    typeof opts.requestCommand === 'string' && opts.requestCommand.trim()
      ? opts.requestCommand.trim()
      : named && inferAgentProvider(opts.defaultCommand) !== named
        ? providerPreset(named).defaultCommand
        : (opts.defaultCommand ?? 'claude');
  if (!command) throw new Error(`provider "${named}" has no default command; name one in "command"`);
  if (named && named !== 'claude' && inferAgentProvider(command) === 'claude') {
    throw new Error(`provider "${named}" resolved to the claude CLI (${command}); refusing to fall back to Claude`);
  }
  // Inherit the app's auto (skip-permissions) mode when the request takes no
  // stance of its own: a headless worker has no human to click through tool
  // prompts, so without the flag it stalls at the first ask until the idle
  // reaper kills it. The flag is the PROVIDER'S — a codex worker needs
  // `-a never -s workspace-write`, and claude's --permission-mode
  // would mean nothing to it (an earlier hardcoded-claude version left every
  // non-claude worker stalling; review caught it). An explicit stance in the
  // request still wins: the flag's leading token already present as a TOKEN
  // (not substring — copilot's flag starts with `-s`) means the request chose.
  const provider = inferAgentProvider(command, opts.requestProvider);
  const autoFlag = opts.autoMode ? autoModeFlagForProvider(provider) : '';
  if (autoFlag && !hasAutoModeStance(tokenizeCommand(command), provider)) {
    command += ` ${autoFlag}`;
  }
  // god authors `command` as a full command LINE ("claude --model … --permission-mode …"),
  // but the PTY layer takes ONE executable name (resolveCommand) plus argv — the
  // unsplit line made node-pty exec a binary literally named like the whole
  // string → ENOENT → the worker died within ~1s of spawning while its request
  // archived as .done (this killed both flag-carrying Ryan spawns on 2026-08-16;
  // only the bare-`claude` one lived). Split with the SAME tokenizer the
  // renderer's spawn flows use, and hand the flags over as argv.
  const tokens = tokenizeCommand(command);
  const bin = tokens[0] || command;
  const flags = tokens.slice(1);
  // A separate `model` field only applies when the command line didn't pick a
  // model itself (spawnAgentCore likewise skips its default-model injection
  // when argv already carries --model).
  const model =
    typeof opts.requestModel === 'string' && opts.requestModel.trim() ? opts.requestModel.trim() : '';
  const args = [...flags, ...(model && !flags.includes('--model') ? ['--model', model] : [])];
  return { bin, args, command, env: workerContextEnv(provider, opts.isGod, opts.agentId) };
}
