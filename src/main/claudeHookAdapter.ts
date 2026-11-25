/** Bridges the user's Claude Code setup into Codex hive workers. The adapter script below is
 *  written to <hive>/bin/claude-hook-adapter.cjs; the rest decides what a worker's
 *  config.toml registers. ~/.claude is only read, never written. */

/** Claude SessionStart hooks a Codex hive agent gets: the machine identity only. The other
 *  context hooks (vault listing, backlog, global memory index, Beta architecture) add ~23k
 *  chars to every agent's first call; an agent reads what its task needs instead.
 *  vault-sync.sh and config-sync.sh have side effects and must never run per spawn. */
export const PORTED_SESSION_START = ['inject-machine-identity.sh'];

/** Claude PreToolUse hooks the adapter runs; the same list as PORTED_PRE in the script. */
export const PORTED_PRE_TOOL_USE = ['no-em-dashes.sh', 'vault-write-reminder.sh', 'git-guard.sh', 'safe-data-ops-check.sh',
  'test-scope-check.sh', 'capture-check.sh', 'agy-guard.sh'];

export function claudeHookScript(command: string): string | null {
  const m = /([A-Za-z0-9_.-]+\.sh)\b/.exec(command);
  return m ? m[1] : null;
}

/** The Codex hook commands for a worker, from the user's Claude settings: one PreToolUse
 *  adapter call (it re-reads settings.json on every call) when any ported PreToolUse hook
 *  is registered, and one SessionStart call per ported context hook, in settings order.
 *  `adapter` is the quoted node + script prefix. */
export function codexClaudeHookCommands(settings: unknown, adapter: string): Array<{ event: 'PreToolUse' | 'SessionStart'; command: string }> {
  const hooks = (settings as { hooks?: Record<string, unknown> } | null)?.hooks ?? {};
  const commandsOf = (event: string): string[] => {
    const out: string[] = [];
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    for (const g of groups) {
      const list = (g as { hooks?: unknown } | null)?.hooks;
      for (const h of Array.isArray(list) ? list : []) {
        const c = h as { type?: unknown; command?: unknown } | null;
        if (c?.type === 'command' && typeof c.command === 'string') out.push(c.command);
      }
    }
    return out;
  };
  const out: Array<{ event: 'PreToolUse' | 'SessionStart'; command: string }> = [];
  if (commandsOf('PreToolUse').some((c) => PORTED_PRE_TOOL_USE.includes(claudeHookScript(c) ?? ''))) {
    out.push({ event: 'PreToolUse', command: `${adapter} pre-tool-use` });
  }
  for (const c of commandsOf('SessionStart')) {
    if (PORTED_SESSION_START.includes(claudeHookScript(c) ?? '')) out.push({ event: 'SessionStart', command: `${adapter} session-start ${c}` });
  }
  return out;
}

/** The adapter, run by the hive's node launcher. */
export const CLAUDE_HOOK_ADAPTER = String.raw`'use strict';
// Runs the user's Claude Code hooks for a Codex hive worker (written by Munder Difflin;
// do not edit). ~/.claude stays the source of truth: the scripts and their registration
// in ~/.claude/settings.json are read on every call, never copied.
//
//   pre-tool-use             Codex PreToolUse payload on stdin. Translated to the Claude
//                            shape (shell -> Bash; apply_patch -> one Write or Edit per
//                            file) and run through the ported Claude PreToolUse hooks. A
//                            deny comes back as Codex's permissionDecision deny.
//   session-start <cmd...>   Runs one Claude SessionStart context hook and passes its
//                            additionalContext on (plain stdout is wrapped).
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

// Claude PreToolUse hooks whose input maps cleanly onto a Codex tool call.
const PORTED_PRE = ['no-em-dashes.sh', 'vault-write-reminder.sh', 'git-guard.sh', 'safe-data-ops-check.sh',
  'test-scope-check.sh', 'capture-check.sh', 'agy-guard.sh'];
const SHELL_TOOLS = ['Bash', 'shell', 'local_shell', 'exec_command', 'container.exec', 'unified_exec'];

function claudeDir() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }

function scriptName(command) {
  const m = /([A-Za-z0-9_.-]+\.sh)\b/.exec(String(command || ''));
  return m ? m[1] : null;
}

/** [{matcher, command}] for one event in a Claude settings object, filtered to the allow list. */
function hooksFor(settings, event, allow) {
  const out = [];
  const groups = (settings && settings.hooks && settings.hooks[event]) || [];
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const h of (g && Array.isArray(g.hooks)) ? g.hooks : []) {
      if (!h || h.type !== 'command' || typeof h.command !== 'string') continue;
      if (allow && allow.indexOf(scriptName(h.command)) < 0) continue;
      out.push({ matcher: typeof g.matcher === 'string' ? g.matcher : '', command: h.command });
    }
  }
  return out;
}

function matcherHits(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  try { return new RegExp('^(?:' + matcher + ')$').test(toolName); } catch (e) { return false; }
}

/** Files in an apply_patch body, with the lines it adds and removes in each. */
function parsePatch(text) {
  const files = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      cur = { op: m[1].toLowerCase(), path: m[2].trim(), added: [], removed: [] };
      files.push(cur);
      continue;
    }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv && cur) { cur.path = mv[1].trim(); continue; }
    if (!cur || line.indexOf('***') === 0 || line.indexOf('@@') === 0) continue;
    if (line[0] === '+') cur.added.push(line.slice(1));
    else if (line[0] === '-') cur.removed.push(line.slice(1));
  }
  return files;
}

function commandString(cmd) {
  if (Array.isArray(cmd)) {
    // ["bash", "-lc", "<script>"] is how Codex spells most shell calls.
    if (cmd.length >= 3 && /(^|\/)(ba|z)?sh$/.test(cmd[0]) && /^-l?c$/.test(cmd[1])) return String(cmd[2]);
    return cmd.map(String).join(' ');
  }
  return typeof cmd === 'string' ? cmd : '';
}

/** Claude-shaped tool calls for one Codex PreToolUse payload. */
function translate(payload) {
  const name = payload && payload.tool_name;
  const input = (payload && payload.tool_input) || {};
  const cwd = (payload && payload.cwd) || process.cwd();
  const base = Object.assign({}, payload, { hook_event_name: 'PreToolUse' });
  if (SHELL_TOOLS.indexOf(name) >= 0) {
    const command = commandString(input.command !== undefined ? input.command : input.cmd);
    return command ? [Object.assign({}, base, { tool_name: 'Bash', tool_input: { command: command } })] : [];
  }
  if (name === 'apply_patch') {
    const body = typeof input.command === 'string' ? input.command : (typeof input.patch === 'string' ? input.patch : input.input);
    return parsePatch(body).filter(function (f) { return f.op !== 'delete'; }).map(function (f) {
      const file = path.isAbsolute(f.path) ? f.path : path.join(cwd, f.path);
      return f.op === 'add'
        ? Object.assign({}, base, { tool_name: 'Write', tool_input: { file_path: file, content: f.added.join('\n') } })
        : Object.assign({}, base, { tool_name: 'Edit', tool_input: { file_path: file, old_string: f.removed.join('\n'), new_string: f.added.join('\n') } });
    });
  }
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') return [base];
  return [];
}

/** A Claude hook's result as {deny} or {context} or {}. Codex rejects allow and ask, so
 *  only a deny (JSON, or exit code 2 with stderr) blocks; anything else is context. */
function interpret(res) {
  const out = {};
  let parsed = null;
  const text = String(res.stdout || '').trim();
  if (text) { try { parsed = JSON.parse(text); } catch (e) { parsed = null; } }
  const hso = parsed && parsed.hookSpecificOutput;
  if (hso && hso.permissionDecision === 'deny') {
    out.deny = String(hso.permissionDecisionReason || 'Blocked by a Claude hook.');
  } else if (parsed && parsed.decision === 'block') {
    out.deny = String(parsed.reason || 'Blocked by a Claude hook.');
  } else if (res.status === 2) {
    out.deny = String(res.stderr || '').trim() || 'Blocked by a Claude hook.';
  }
  if (hso && typeof hso.additionalContext === 'string' && hso.additionalContext.trim()) out.context = hso.additionalContext;
  return out;
}

function runHook(argvOrCommand, input, cwd) {
  const env = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: cwd });
  const opts = { input: input, cwd: cwd, env: env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 };
  const r = Array.isArray(argvOrCommand)
    ? cp.spawnSync(argvOrCommand[0], argvOrCommand.slice(1), opts)
    : cp.spawnSync('/bin/sh', ['-c', argvOrCommand], opts);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function existingDir(d) { try { return fs.statSync(d).isDirectory() ? d : null; } catch (e) { return null; } }

/** Codex PreToolUse output for one payload, or null to let the call through silently. */
function preToolUse(payload, hooks, run) {
  run = run || runHook;
  const cwd = existingDir(payload && payload.cwd) || process.cwd();
  const contexts = [];
  for (const call of translate(payload)) {
    for (const h of hooks) {
      if (!matcherHits(h.matcher, call.tool_name)) continue;
      const r = interpret(run(h.command, JSON.stringify(call), cwd));
      if (r.deny) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.deny } };
      if (r.context) contexts.push(r.context);
    }
  }
  return contexts.length ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: contexts.join('\n\n') } } : null;
}

/** Codex SessionStart output from one Claude context hook's stdout, or null. */
function sessionStartOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  let ctx = text;
  try {
    const parsed = JSON.parse(text);
    const hso = parsed && parsed.hookSpecificOutput;
    ctx = hso && typeof hso.additionalContext === 'string' ? hso.additionalContext : '';
  } catch (e) { /* plain text is the context itself */ }
  return ctx.trim() ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } } : null;
}

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; } }

function main(argv) {
  const mode = argv[0];
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch (e) { payload = {}; }
  let out = null;
  try {
    if (mode === 'pre-tool-use') {
      let settings = {};
      try { settings = JSON.parse(fs.readFileSync(path.join(claudeDir(), 'settings.json'), 'utf8')); } catch (e) { settings = {}; }
      out = preToolUse(payload, hooksFor(settings, 'PreToolUse', PORTED_PRE));
    } else if (mode === 'session-start' && argv.length > 1) {
      const cwd = existingDir(payload.cwd) || process.cwd();
      const claudePayload = Object.assign({}, payload, { hook_event_name: 'SessionStart' });
      out = sessionStartOutput(runHook(argv.slice(1), JSON.stringify(claudePayload), cwd).stdout);
    }
  } catch (e) { out = null; }
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
}

module.exports = { PORTED_PRE, hooksFor, matcherHits, parsePatch, translate, interpret, preToolUse, sessionStartOutput, scriptName };
if (require.main === module) main(process.argv.slice(2));
`;
