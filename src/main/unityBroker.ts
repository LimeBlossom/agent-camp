/**
 * Unity broker: an agent granted `unity` (an open card that needs it, or the agent's override flag) files a request, the harness runs Unity
 * for it in batch mode inside a harness-owned bubblewrap that passes the GPU through.
 *
 * Why a broker: Codex's workspace-write sandbox builds a /dev with no nvidia/dri nodes,
 * so Unity started from inside an agent never gets a GPU. The bwrap here is the one
 * measured to work (RTX device nodes, Unity's licence and user dirs) while refusing
 * writes outside the project, the results folder and Unity's own dirs.
 *
 * Display: even -batchmode Unity opens an X window for its context, and on :0 that window
 * steals the user's focus. Each run gets its own display (Xvfb, or Xephyr drawing into an
 * unmapped window on :0) and the sandbox sees only that display's socket.
 *
 * Queue: <hive>/agents/<id>/unity-requests/<reqId>.json. The directory names the
 * requester; nothing inside the file is trusted to say who asked. Results land in
 * <scratch>/<id>/unity-results/<reqId>/ (see unityResultsBase) and the agent gets an
 * inbox message.
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  statSync, lstatSync, writeFileSync, unlinkSync, openSync, closeSync, accessSync,
  constants as fsConstants
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { inAgentScope } from './agentScope';
import { expandTilde } from './fs';
import { BUNDLED_MESSAGE_TEMPLATES, renderMessageTemplate } from './messageTemplates';
import { UNITY_DISPLAY_HELPER } from './unityDisplayHelper';

export const UNITY_TIMEOUT_DEFAULT_SEC = 600;
export const UNITY_TIMEOUT_MAX_SEC = 3600;
export const DEFAULT_UNITY_EDITOR_ROOT = join(homedir(), 'Unity', 'Hub', 'Editor');
const BWRAP = '/usr/bin/bwrap';
const GPU_NODES = ['/dev/dri', '/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-modeset', '/dev/nvidia-uvm', '/dev/nvidia-uvm-tools'];
/** Files the harness writes into a results folder; everything else there is an output. */
const HARNESS_FILES = new Set(['result.json', 'unity.log', 'console.log']);

const BARE_ARGS = ['-runTests', '-nographics', '-quit'];
const VALUE_ARGS = ['-testPlatform', '-testFilter', '-testCategory', '-assemblyNames', '-buildTarget'];
const EXECUTE_METHOD = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const DENIED_ENV = new Set(['PATH', 'HOME', 'DISPLAY', 'XAUTHORITY', 'MD_UNITY_OUT']);

/** The folder an agent's broker results go in: `<scratchRoot>/<agentId>/unity-results`,
 *  or `<agentDir>/unity-results` when there is no scratch root or it cannot be created
 *  (the drive is not mounted). `create` false only reports the path (prompt text). */
export function unityResultsBase(agentDir: string, agentId: string, scratchRoot?: string | null, create = true): string {
  if (scratchRoot) {
    // bwrap cannot make a bind target's parents through a symlink, so bind the real path.
    let root = scratchRoot;
    try { root = realpathSync(scratchRoot); } catch { /* missing: keep as given */ }
    const dir = join(root, agentId, 'unity-results');
    if (!create) { if (existsSync(root)) return dir; }
    else { try { mkdirSync(dir, { recursive: true }); return dir; } catch { /* fall back */ } }
  }
  return join(agentDir, 'unity-results');
}

export interface UnityRequest {
  project: string;
  executeMethod?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
}

export interface UnityResult {
  ok: boolean;
  exitCode: number | null;
  reason?: string;
  durationSec: number;
  logPath: string | null;
  outputs: string[];
}

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Is `child` the same path as `parent` or below it? Both must already be real paths. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The project's real path, provided it lies inside the agent's cwd or one of its extra
 *  folders after symlinks and `..` are resolved. A relative project resolves against cwd. */
export function resolveProjectInWorkspace(project: unknown, cwd: string, extraDirs: string[]): Checked<string> {
  if (typeof project !== 'string' || !project.trim()) return { ok: false, reason: 'missing "project"' };
  const p = expandTilde(project.trim());
  const abs = isAbsolute(p) ? p : resolve(expandTilde(cwd), p);
  let real: string;
  try { real = realpathSync(abs); } catch { return { ok: false, reason: `project ${abs} does not exist` }; }
  const roots = [cwd, ...extraDirs].flatMap((r) => {
    try { return [realpathSync(expandTilde(r))]; } catch { return []; }
  });
  if (roots.some((r) => isInside(real, r))) return { ok: true, value: real };
  return { ok: false, reason: `project ${real} is outside this agent's workspace (its folder and extra folders)` };
}

/** The Unity editor binary for a project, from ProjectSettings/ProjectVersion.txt. */
export function unityEditorFor(projectReal: string, editorRoot: string): Checked<{ version: string; editor: string }> {
  const pv = join(projectReal, 'ProjectSettings', 'ProjectVersion.txt');
  let text: string;
  try { text = readFileSync(pv, 'utf8'); } catch { return { ok: false, reason: `not a Unity project: ${pv} is missing` }; }
  const m = /^m_EditorVersion:\s*(\S+)/m.exec(text);
  if (!m || !/^[0-9A-Za-z._-]+$/.test(m[1]) || m[1].startsWith('.')) {
    return { ok: false, reason: `no usable m_EditorVersion in ${pv}` };
  }
  const editor = join(expandTilde(editorRoot), m[1], 'Editor', 'Unity');
  if (!existsSync(editor)) return { ok: false, reason: `Unity ${m[1]} is not installed (expected ${editor})` };
  return { ok: true, value: { version: m[1], editor } };
}

export function checkExecuteMethod(v: unknown): Checked<string | undefined> {
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== 'string' || !EXECUTE_METHOD.test(v)) {
    return { ok: false, reason: '"executeMethod" must look like Namespace.Class.Method (letters, digits, _ and . only)' };
  }
  return { ok: true, value: v };
}

/** The agent's args filtered through the allowlist. -testResults always writes into the
 *  results folder (only its file name is kept), with or without a value. */
export function buildUnityArgs(input: unknown, resultsDir: string): Checked<string[]> {
  if (input === undefined) return { ok: true, value: [] };
  if (!Array.isArray(input) || input.some((a) => typeof a !== 'string')) {
    return { ok: false, reason: '"args" must be an array of strings' };
  }
  const args = input as string[];
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (BARE_ARGS.includes(a)) { out.push(a); continue; }
    if (VALUE_ARGS.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || !v.trim() || v.startsWith('-') || /[\0\r\n]/.test(v)) return { ok: false, reason: `${a} needs a value` };
      out.push(a, v);
      i++;
      continue;
    }
    if (a === '-testResults') {
      let name = 'test-results.xml';
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith('-')) {
        i++;
        const b = basename(v.replace(/\\/g, '/'));
        if (b && b !== '.' && b !== '..' && !/[\0\r\n]/.test(b)) name = b;
      }
      out.push(a, join(resultsDir, name));
      continue;
    }
    return {
      ok: false,
      reason: `argument "${a}" is not allowed (allowed: ${[...BARE_ARGS, ...VALUE_ARGS.map((x) => `${x} <value>`), '-testResults'].join(', ')})`
    };
  }
  return { ok: true, value: out };
}

const DEFAULT_TEST_RESULTS = 'test-results.xml';
const NO_TESTS_REASON = 'no tests ran: the -testFilter matched nothing (NUnit wants namespace-qualified names, not bare class names)';

/** The -testResults file a -runTests run writes: the one buildUnityArgs pinned into the
 *  results folder, else the default name the broker adds. */
function testResultsPath(args: string[], resultsDir: string): string {
  const i = args.indexOf('-testResults');
  return i >= 0 && args[i + 1] ? args[i + 1] : join(resultsDir, DEFAULT_TEST_RESULTS);
}

/** Why a -runTests run did not run any test, or null. A filter that matches nothing exits
 *  0 with no results.xml (or total="0"), which must not read as green. */
export function testRunProblem(args: string[] | undefined, resultsDir: string): string | null {
  if (!args || !args.includes('-runTests')) return null;
  let xml: string;
  try { xml = readFileSync(testResultsPath(args, resultsDir), 'utf8'); } catch { return `${NO_TESTS_REASON}; no results.xml was written`; }
  const m = /<test-run\b[^>]*\btotal="(\d+)"/.exec(xml);
  if (!m) return `${NO_TESTS_REASON}; results.xml has no <test-run total>`;
  return Number(m[1]) === 0 ? `${NO_TESTS_REASON}; results.xml total is 0` : null;
}

const EARLYOOM_KILL = /earlyoom.*sending SIG(?:TERM|KILL) to process \d+ uid \d+ "Unity/;

/** The earlyoom journal line that killed a Unity run, or null. The victim is matched by the
 *  run's time window (the caller passes only journal text since the run started) and the
 *  process name "Unity", never by pid: Unity's pid lives inside bwrap's pid namespace and
 *  does not match the host pid earlyoom logs. */
export function earlyoomKillLine(journal: string): string | null {
  return journal.split('\n').find((l) => EARLYOOM_KILL.test(l))?.trim() ?? null;
}

/** journalctl args that list earlyoom kill lines since the epoch-ms. "earlyoom" is the
 *  SYSLOG_IDENTIFIER, so it is selected with -t; --grep only sees the MESSAGE field. */
export function earlyoomJournalArgs(sinceMs: number): string[] {
  return ['--since', `@${Math.floor(sinceMs / 1000)}`, '--no-pager', '-o', 'short-iso', '-t', 'earlyoom', '--grep', 'sending SIG'];
}

/** The earlyoom kill reason, quoting the journal line. */
export function earlyoomReason(line: string): string {
  return `killed by earlyoom (low memory), not a test failure; retry when memory is free. Journal: ${line}`;
}

/** The request's env, refusing keys that could steer the loader, the sandbox, Unity's own
 *  switches or the harness's output folder. */
export function filterUnityEnv(input: unknown): Checked<Record<string, string>> {
  if (input === undefined) return { ok: true, value: {} };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: '"env" must be an object of strings' };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!ENV_KEY.test(k)) return { ok: false, reason: `env key "${k}" must be UPPER_CASE letters, digits and _` };
    if (typeof v !== 'string') return { ok: false, reason: `env ${k} must be a string` };
    if (DENIED_ENV.has(k) || k.startsWith('LD_') || k.startsWith('UNITY_') || k.startsWith('BWRAP')) {
      return { ok: false, reason: `env ${k} is not allowed` };
    }
    out[k] = v;
  }
  return { ok: true, value: out };
}

export function clampTimeoutSec(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return UNITY_TIMEOUT_DEFAULT_SEC;
  return Math.min(UNITY_TIMEOUT_MAX_SEC, Math.max(1, Math.round(v)));
}

/** A Unity editor's comm: "Unity" when started directly, "unityhub-unity-" (the 15-char cut
 *  of unityhub-unity-editor-<version>) when Unity Hub opened it. */
export function isUnityComm(comm: string): boolean {
  return comm === 'Unity' || comm.startsWith('unityhub-unity');
}

/** Running Unity editors, direct or Hub-launched, and the real -projectPath each was given. */
export function listUnityProcesses(procRoot = '/proc'): Array<{ pid: number; projectPath?: string }> {
  const out: Array<{ pid: number; projectPath?: string }> = [];
  let entries: string[] = [];
  try { entries = readdirSync(procRoot); } catch { return out; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      if (!isUnityComm(readFileSync(join(procRoot, e, 'comm'), 'utf8').trim())) continue;
      const argv = readFileSync(join(procRoot, e, 'cmdline'), 'utf8').split('\0');
      const i = argv.findIndex((a) => a.toLowerCase() === '-projectpath');
      // An editor's asset import workers are Unity processes of their own, not instances.
      if (argv.some((a) => a.startsWith('AssetImportWorker'))) continue;
      let projectPath = i >= 0 ? argv[i + 1] : undefined;
      if (projectPath) { try { projectPath = realpathSync(projectPath); } catch { /* keep as given */ } }
      out.push({ pid: Number(e), projectPath });
    } catch { /* process exited mid-scan */ }
  }
  return out;
}

/** Why Unity cannot open this project right now, or null. Never touches the lock file. */
export function projectBusyReason(projectReal: string, procs = listUnityProcesses()): string | null {
  const holder = procs.find((p) => p.projectPath === projectReal);
  if (holder) return `Unity (pid ${holder.pid}) already has ${projectReal} open`;
  if (procs.length > 0 && existsSync(join(projectReal, 'Temp', 'UnityLockfile'))) {
    return `${join(projectReal, 'Temp', 'UnityLockfile')} exists while a Unity process is running`;
  }
  return null;
}

/** Why this project's Library must not be opened, or null: a file directly in Library/ (the
 *  SourceAssetDB/ArtifactDB LMDB files and their locks live there) has more than one hard
 *  link, so it is shared with another tree (`cp -al`). Two Unitys writing one LMDB hang and
 *  then abort with "Database corruption detected". */
export function sharedLibraryReason(projectReal: string): string | null {
  const lib = join(projectReal, 'Library');
  let names: string[];
  try { names = readdirSync(lib); } catch { return null; }
  const shared = names.filter((n) => {
    try { const st = lstatSync(join(lib, n)); return st.isFile() && st.nlink > 1; } catch { return false; }
  });
  if (shared.length === 0) return null;
  return `${lib} is hardlinked to another tree (${shared.slice(0, 3).join(', ')}${shared.length > 3 ? ', ...' : ''} have more than one link); ` +
    'Unity would share its asset database with that tree and corrupt it. Re-copy it with cp -a --reflink=auto (never cp -al), or delete it and let Unity rebuild';
}

/** Pid files a Unity session leaves in Library/ so the next one can stop its lingering
 *  Burst and ILPP servers. Burst's client SIGKILLs the stored pid with no name check, and a
 *  sandboxed run stores pids from its own namespace, where the next run's pid of that number
 *  is usually one of Unity's own threads: the run kills itself (exit 137) ~1.3 s in. On the
 *  host the same number is some unrelated process. */
export const SANDBOX_PID_FILES = ['burst.pid', 'ilpp.pid'];

/** Removes the pid files; call only while no Unity has the project open. Returns those removed. */
export function clearSandboxPidFiles(projectReal: string): string[] {
  const removed: string[] = [];
  for (const name of SANDBOX_PID_FILES) {
    try {
      unlinkSync(join(projectReal, 'Library', name));
      removed.push(name);
    } catch { /* absent */ }
  }
  return removed;
}

/** Where Unity on Linux keeps this project's PlayerPrefs (editor and player alike):
 *  ~/.config/unity3d/<companyName>/<productName>, from ProjectSettings.asset. Every clone
 *  of a game shares it, so concurrent runs would read and overwrite each other's settings. */
export function playerPrefsDir(home: string, projectSettingsText: string): string | null {
  const field = (k: string): string | null => {
    const m = new RegExp(`^\\s*${k}:\\s*(.+?)\\s*$`, 'm').exec(projectSettingsText);
    const v = m?.[1]?.replace(/^['"]|['"]$/g, '').trim();
    return v && !/[/\\]|^\.\.?$/.test(v) ? v : null;
  };
  const company = field('companyName');
  const product = field('productName');
  return company && product ? join(home, '.config', 'unity3d', company, product) : null;
}

/** Unity's per-user folders that must stay writable inside the sandbox. */
export function unityUserDirs(home: string, narrowCache: boolean): string[] {
  return [
    join(home, '.config', 'unity3d'),
    join(home, '.local', 'share', 'unity3d'),
    narrowCache ? join(home, '.cache', 'unity3d') : join(home, '.cache')
  ];
}

/** The bwrap argv: the whole filesystem read-only, the GPU nodes and X socket passed in,
 *  and only the project, the results folder and Unity's user dirs writable. */
export function bwrapArgv(o: {
  project: string;
  resultsDir: string;
  userDirs: string[];
  gpuNodes: string[];
  /** The private display's socket, /tmp/.X11-unix/X<n>; never the whole directory. */
  x11Socket: string | null;
  /** A network namespace of its own, so :0's abstract socket (@/tmp/.X11-unix/X0) is out of reach. */
  unshareNet: boolean;
  /** Sound-server sockets to cover. A read-only bind still lets Unity connect to them,
   *  so the game's music would play on the user's speakers. */
  audioSockets?: string[];
  /** Sound-server socket folders (PulseAudio's) to cover with an empty tmpfs. */
  audioDirs?: string[];
  /** Folders laid over a user-dir path for this run only, after the user dirs are bound. */
  overlays?: Array<{ src: string; dst: string }>;
  command: string[];
}): string[] {
  return [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    ...o.gpuNodes.flatMap((d) => ['--dev-bind', d, d]),
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    ...(o.audioDirs ?? []).flatMap((d) => ['--tmpfs', d]),
    ...(o.audioSockets ?? []).flatMap((s) => ['--ro-bind', '/dev/null', s]),
    ...(o.x11Socket ? ['--bind', o.x11Socket, o.x11Socket] : []),
    '--bind', o.project, o.project,
    '--bind', o.resultsDir, o.resultsDir,
    ...o.userDirs.flatMap((d) => ['--bind', d, d]),
    ...(o.overlays ?? []).flatMap((m) => ['--bind', m.src, m.dst]),
    '--unshare-pid',
    ...(o.unshareNet ? ['--unshare-net'] : []),
    '--die-with-parent',
    '--',
    ...o.command
  ];
}

/** The user's PipeWire and PulseAudio sockets under XDG_RUNTIME_DIR, so bwrapArgv can cover
 *  them. Only paths that exist are returned: bwrap fails on a mount target that is missing. */
export function audioMounts(runtimeDir: string | undefined): { audioSockets: string[]; audioDirs: string[] } {
  if (!runtimeDir) return { audioSockets: [], audioDirs: [] };
  const audioSockets = ['pipewire-0', 'pipewire-0-manager'].map((n) => join(runtimeDir, n)).filter((s) => existsSync(s));
  const audioDirs = [join(runtimeDir, 'pulse')].filter((d) => existsSync(d));
  return { audioSockets, audioDirs };
}

/** The Unity argv the harness always builds. -force-vulkan is not optional: on a private
 *  display GL falls back to llvmpipe, Vulkan reaches the real GPU. */
export function unityCommand(editor: string, project: string, logPath: string, method: string | undefined, extra: string[]): string[] {
  return [
    editor,
    '-batchmode',
    '-force-vulkan',
    '-projectPath', project,
    '-logFile', logPath,
    ...(method ? ['-executeMethod', method] : []),
    ...extra
  ];
}

/** Unity's environment: the harness env, the request's env, then the private display. The
 *  user's X cookie and any Wayland socket are dropped so only display :n is offered. */
export function unityEnv(base: NodeJS.ProcessEnv, requested: Record<string, string>, display: number, outDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v;
  Object.assign(env, requested);
  delete env.XAUTHORITY;
  delete env.WAYLAND_DISPLAY;
  // Belt and braces with the covered sockets: point both sound clients at nothing.
  env.PULSE_SERVER = 'unix:/nonexistent';
  env.PIPEWIRE_REMOTE = '/nonexistent';
  env.DISPLAY = `:${display}`;
  env.MD_UNITY_OUT = outDir;
  // Games that honour this flag send no telemetry while this is set; a request cannot unset it.
  env.LBS_NO_TELEMETRY = '1';
  return env;
}

/** The helper's first line: "DISPLAY <n> <server pid>" or "ERROR <reason>". Display 0 is
 *  refused even if a server reported it: that is the user's screen. */
export function parseDisplayLine(line: string): { ok: true; display: number; serverPid: number } | { ok: false; reason: string } {
  const t = line.trim();
  const m = /^DISPLAY (\d+) (\d+)$/.exec(t);
  if (m) {
    const display = Number(m[1]);
    if (display === 0) return { ok: false, reason: 'the private display came up as :0' };
    return { ok: true, display, serverPid: Number(m[2]) };
  }
  if (t.startsWith('ERROR ')) return { ok: false, reason: t.slice(6) };
  return { ok: false, reason: t ? `unexpected output from the display helper: ${t.slice(0, 200)}` : 'the display helper exited without starting a display' };
}

/** First executable file named <name> on PATH. */
export function findOnPath(name: string, pathVar = process.env.PATH ?? ''): string | null {
  for (const dir of pathVar.split(':')) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) { accessSync(p, fsConstants.X_OK); return p; }
    } catch { /* next */ }
  }
  return null;
}

/** Xvfb when installed (no parent display involved at all), else Xephyr under a hidden parent. */
export function pickDisplayServer(pathVar?: string): string | null {
  return findOnPath('Xvfb', pathVar) ?? findOnPath('Xephyr', pathVar);
}

export interface PrivateDisplay {
  display: number;
  socket: string;
  /** Stops the server and the helper; resolves once the helper has exited. */
  stop(): Promise<void>;
}

const liveDisplays = new Set<PrivateDisplay>();

/** Stops every private display still up (app quit). Only processes the broker started. */
export function stopAllUnityDisplays(): Promise<void> {
  return Promise.all([...liveDisplays].map((d) => d.stop())).then(() => undefined);
}

/** Starts a private X server through the helper script, outside any sandbox. The helper owns
 *  the server (the server dies with it) and stops it when its stdin closes, so a harness that
 *  dies without cleaning up still takes the display down. */
export function startPrivateDisplay(
  helperPath: string, server: string, env: NodeJS.ProcessEnv, readyTimeoutSec = 30
): Promise<PrivateDisplay | { error: string }> {
  return new Promise((resolveStart) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('python3', [helperPath, '1920', '1080', server], { detached: true, stdio: ['pipe', 'pipe', 'ignore'], env });
    } catch (e) {
      resolveStart({ error: `could not start the display helper (${String(e)})` });
      return;
    }
    let exited = false;
    const exitedP = new Promise<void>((r) => child.once('exit', () => { exited = true; r(); }));
    const killGroup = (sig: NodeJS.Signals): void => {
      try { if (child.pid && !exited) process.kill(-child.pid, sig); } catch { /* gone */ }
    };
    let stopping: Promise<void> | null = null;
    const handle: PrivateDisplay = {
      display: -1,
      socket: '',
      stop: () => {
        if (stopping) return stopping;
        stopping = (async () => {
          try { child.stdin?.end(); } catch { /* closed */ }
          const t1 = setTimeout(() => killGroup('SIGTERM'), 5000);
          const t2 = setTimeout(() => killGroup('SIGKILL'), 8000);
          await exitedP;
          clearTimeout(t1);
          clearTimeout(t2);
          liveDisplays.delete(handle);
        })();
        return stopping;
      }
    };
    liveDisplays.add(handle);
    let out = '';
    let settled = false;
    const settle = (v: PrivateDisplay | { error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ('error' in v) void handle.stop().then(() => resolveStart(v));
      else resolveStart(v);
    };
    const timer = setTimeout(() => settle({ error: `the private display did not start within ${readyTimeoutSec}s` }), readyTimeoutSec * 1000);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      const nl = out.indexOf('\n');
      if (nl < 0) return;
      const parsed = parseDisplayLine(out.slice(0, nl));
      if (!parsed.ok) { settle({ error: parsed.reason }); return; }
      const socket = `/tmp/.X11-unix/X${parsed.display}`;
      if (!existsSync(socket)) { settle({ error: `display :${parsed.display} has no socket at ${socket}` }); return; }
      handle.display = parsed.display;
      handle.socket = socket;
      settle(handle);
    });
    child.once('error', (e) => settle({ error: `could not start the display helper (${e.message})` }));
    child.once('exit', () => {
      const first = parseDisplayLine(out.split('\n')[0]);
      settle({ error: first.ok ? 'the display helper exited early' : first.reason });
    });
  });
}

/** The paragraph an agent granted Unity (card needs or override flag) gets in its hive protocol. */
export function unityPromptText(requestsDir: string, resultsDir: string, hiveRoot?: string | null): string {
  return renderMessageTemplate(hiveRoot, 'unityPrompt', {
    requestsDir,
    resultsDir,
    requestsFile: join(requestsDir, '<id>.json'),
    resultsFile: join(resultsDir, '<id>')
  }, BUNDLED_MESSAGE_TEMPLATES.unityPrompt);
}

/** `<hive>/unity-hold.json` {reason, since, allow?: [agentId]}: while it exists the broker
 *  starts no Unity for any agent not in `allow`. Read at every request, so setting or
 *  clearing it needs no restart. */
export const UNITY_HOLD_FILE = 'unity-hold.json';

export interface UnityHold { reason: string; since: string | null; allow: string[] }

/** The hold that applies to `agentId`, or null. A file that cannot be read still holds:
 *  a broken hold must never let runs through. */
export function unityHoldFor(hiveRoot: string, agentId: string): UnityHold | null {
  const file = join(hiveRoot, UNITY_HOLD_FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (!existsSync(file)) return null;
    return { reason: `${file} is unreadable (${e instanceof Error ? e.message : String(e)})`, since: null, allow: [] };
  }
  const h = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const allow = Array.isArray(h.allow) ? h.allow.filter((a): a is string => typeof a === 'string') : [];
  if (allow.includes(agentId)) return null;
  const reason = typeof h.reason === 'string' && h.reason.trim() ? h.reason.trim() : `${file} gives no reason`;
  return { reason, since: typeof h.since === 'string' ? h.since : null, allow };
}

export function unityHoldReason(hiveRoot: string, agentId: string): string | null {
  const hold = unityHoldFor(hiveRoot, agentId);
  return hold ? `unity-hold: ${hold.reason}` : null;
}

export interface BrokerAgent {
  unity: boolean;
  cwd: string;
  extraDirs: string[];
}

export interface BrokerDeps {
  hiveRoot(): string | null;
  agent(id: string): BrokerAgent | null | undefined;
  /** Delivers an inbox message to the agent through the hive router. */
  notify(id: string, subject: string, body: string): void;
  /** Appends to the hive's log.jsonl. */
  log(event: Record<string, unknown>): void;
  editorRoot?(): string | undefined;
  /** Scratch root for results (hiveScratchRoot() in the app); unset keeps them in the agent folder. */
  resultsRoot?(): string | null;
  bwrapPath?: string;
  home?: string;
  /** Bind only ~/.cache/unity3d instead of all of ~/.cache. */
  narrowCache?: boolean;
  /** Seconds between SIGTERM and SIGKILL of the process group on timeout. */
  killGraceSec?: number;
  /** Starts the run's private display; defaults to the helper in <hive>/bin. */
  startDisplay?(): Promise<PrivateDisplay | { error: string }>;
  /** Give Unity its own network namespace, cutting it off from :0's abstract X socket. */
  unshareNet?: boolean;
  /** Agent runs at once; read at each request. Unset = UNITY_MAX_CONCURRENT_DEFAULT. */
  maxConcurrent?(): number | undefined;
  /** Seconds between one agent's run starts; read at each request. Unset = the default. */
  agentCooldownSec?(): number | undefined;
  /** Unity editors on the machine; defaults to a /proc scan. */
  unityProcesses?(): Array<{ pid: number; projectPath?: string }>;
  /** System journal text since the epoch-ms; the app runs journalctl. Unset = no earlyoom check. */
  earlyoomJournal?(sinceMs: number): Promise<string>;
  /** Raw /proc/meminfo text; defaults to the real file. May throw. */
  readMeminfo?(): string;
  /** Raw /proc/pressure/memory text; defaults to the real file. May throw. */
  readMemoryPressure?(): string;
  /** Hold new runs below this MemAvailable (GB); read at each request. 0 disables. Unset = default. */
  minMemAvailableGb?(): number | undefined;
  /** Hold new runs above this memory PSI some avg10; read at each request. 0 disables. Unset = default. */
  maxMemPressureAvg10?(): number | undefined;
  now?(): number;
}

/** The human's own editor plus 2 agent runs, inside Unity Personal's 3 instances. */
export const UNITY_MAX_CONCURRENT_DEFAULT = 2;
export const UNITY_AGENT_COOLDOWN_DEFAULT_SEC = 300;
export const UNITY_MACHINE_INSTANCE_LIMIT = 3;
/** One agent editor is ~5 GB; below this a new start risks swap thrash. */
export const UNITY_MIN_MEM_AVAILABLE_GB_DEFAULT = 8;
export const UNITY_MAX_MEM_PSI_AVG10_DEFAULT = 10;
const KB_PER_GB = 1024 * 1024;

function nonNegativeNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** MemAvailable in GB from /proc/meminfo text, or null when absent. */
export function parseMemAvailableGb(text: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
  return m ? Number(m[1]) / KB_PER_GB : null;
}

/** The `some avg10=` value from /proc/pressure/memory text, or null when absent. */
export function parseMemPsiSomeAvg10(text: string): number | null {
  const m = /^some\b[^\n]*\bavg10=(\d+(?:\.\d+)?)/m.exec(text);
  return m ? Number(m[1]) : null;
}

function nonNegativeInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

export type HandleOutcome =
  | { status: 'done'; resultPath: string; result: UnityResult }
  | { status: 'deferred'; reason: string };

export class UnityBroker {
  /** Real project path → the run holding it. One broker run per project. */
  private readonly running = new Map<string, string>();
  private ticking = false;
  private recovered = false;
  /** Agent id → ms its last run started, for the per-agent cooldown. */
  private readonly lastStart = new Map<string, number>();
  /** Request files whose agent was already told the request is waiting. */
  private readonly deferNotified = new Set<string>();

  constructor(private readonly deps: BrokerDeps) {}

  /** One poll of every agent's request queue. Runs are started, not awaited, so a long
   *  Unity run never blocks the next tick; a claimed request has already left the queue. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const root = this.deps.hiveRoot();
      if (!root) return;
      const agentsDir = join(root, 'agents');
      let ids: string[] = [];
      try { ids = readdirSync(agentsDir); } catch { return; }
      if (!this.recovered) { this.recovered = true; for (const id of ids) this.recoverInterrupted(root, id); }
      for (const id of ids) {
        const queue = join(agentsDir, id, 'unity-requests');
        let files: string[] = [];
        try { files = readdirSync(queue).filter((f) => f.endsWith('.json')).sort(); } catch { continue; }
        for (const f of files) {
          this.handle(id, join(queue, f)).catch((e) => console.error('[unity] request failed:', e));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Validates, runs and reports one request file. Everything up to claiming the file runs
   *  synchronously, so a concurrent tick can never pick the same file twice. */
  handle(agentId: string, filePath: string): Promise<HandleOutcome> {
    const root = this.deps.hiveRoot();
    if (!root) return Promise.resolve({ status: 'deferred', reason: 'hive disabled' });
    const agentDir = join(root, 'agents', agentId);
    const reqId = (basename(filePath).replace(/\.json$/i, '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '')) || 'request';
    const reject = (reason: string): Promise<HandleOutcome> =>
      Promise.resolve(this.finish(agentId, reqId, filePath, null, agentDir, { ok: false, exitCode: null, reason, durationSec: 0, logPath: null, outputs: [] }));

    let raw: unknown;
    try { raw = JSON.parse(readFileSync(filePath, 'utf8')); } catch (e) {
      if (!existsSync(filePath)) return Promise.resolve({ status: 'deferred', reason: 'request file vanished' });
      return reject(`request is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reject('request must be a JSON object');
    const req = raw as Partial<UnityRequest>;

    const hold = unityHoldFor(root, agentId);
    if (hold) {
      const detail = `The Boss has put a hold on Unity runs${hold.since ? ` since ${hold.since}` : ''}; resend this request after the hold is cleared.`;
      return Promise.resolve(this.finish(agentId, reqId, filePath, null, agentDir,
        { ok: false, exitCode: null, reason: `unity-hold: ${hold.reason}`, durationSec: 0, logPath: null, outputs: [] }, detail));
    }

    const agent = this.deps.agent(agentId);
    if (!agent) return reject(`agent ${agentId} is not in the registry`);
    if (!agent.unity) return reject('the Unity broker is off for this agent: none of its open cards needs "unity" (the Boss tags a card with needs: ["unity"]), and Edit Agent → Workspace → Unity is off');
    if (process.platform !== 'linux') return reject('the Unity broker runs only on Linux');
    const bwrap = this.deps.bwrapPath ?? BWRAP;
    if (!existsSync(bwrap)) return reject(`${bwrap} is not installed`);

    const project = resolveProjectInWorkspace(req.project, agent.cwd, agent.extraDirs);
    if (!project.ok) return reject(project.reason);
    const editor = unityEditorFor(project.value, this.deps.editorRoot?.() || DEFAULT_UNITY_EDITOR_ROOT);
    if (!editor.ok) return reject(editor.reason);
    const method = checkExecuteMethod(req.executeMethod);
    if (!method.ok) return reject(method.reason);
    const env = filterUnityEnv(req.env);
    if (!env.ok) return reject(env.reason);

    if (this.running.has(project.value)) {
      return Promise.resolve({ status: 'deferred', reason: `broker run ${this.running.get(project.value)} holds ${project.value}` });
    }
    const slot = this.slotBusyReason(agentId);
    if (slot) return Promise.resolve(this.deferWithNotice(agentId, reqId, filePath, slot));
    const busy = projectBusyReason(project.value, this.unityProcesses());
    if (busy) return reject(busy);
    const shared = sharedLibraryReason(project.value);
    if (shared) return reject(shared);

    const resultsBase = this.resultsBase(agentDir, agentId);
    const resultsDir = this.freshResultsDir(resultsBase, reqId);
    const args = buildUnityArgs(req.args, resultsDir);
    if (!args.ok) return reject(args.reason);
    // Without -testResults Unity writes the XML outside the results folder, where the
    // broker could not tell a run that ran from one that did not.
    if (args.value.includes('-runTests') && !args.value.includes('-testResults')) {
      args.value.push('-testResults', join(resultsDir, DEFAULT_TEST_RESULTS));
    }

    // Claim: out of the queue before anything awaits.
    const runningDir = join(dirname(filePath), '.running');
    const claimed = join(runningDir, basename(filePath));
    try {
      mkdirSync(runningDir, { recursive: true });
      renameSync(filePath, claimed);
    } catch (e) {
      return Promise.resolve({ status: 'deferred', reason: `could not claim the request (${String(e)})` });
    }
    this.running.set(project.value, `${agentId}/${reqId}`);
    this.lastStart.set(agentId, this.now());
    this.deferNotified.delete(filePath);
    // Anything that throws between here and run() must release the project, or every
    // later request for it is deferred until the app restarts (a full disk did this).
    let swapped: string | null;
    try {
      mkdirSync(resultsDir, { recursive: true });
      // The agent can write its own folder, so re-check both binds right before bwrap
      // resolves them: a symlink swapped in after validation must not become writable.
      swapped = bindTargetsSwapped(project.value, resultsDir, resultsBase);
    } catch (e) {
      swapped = `could not prepare the results folder (${e instanceof Error ? e.message : String(e)})`;
    }
    if (swapped) {
      this.running.delete(project.value);
      try {
        return Promise.resolve(this.finish(agentId, reqId, claimed, null, agentDir, { ok: false, exitCode: null, reason: swapped, durationSec: 0, logPath: null, outputs: [] }));
      } catch (e) {
        return Promise.resolve({ status: 'deferred', reason: `${swapped}; reporting it failed too (${String(e)})` });
      }
    }

    const timeoutSec = clampTimeoutSec(req.timeoutSec);
    const logPath = join(resultsDir, 'unity.log');
    const command = unityCommand(editor.value.editor, project.value, logPath, method.value, args.value);
    this.deps.log({ kind: 'unity-run-start', agentId, reqId, project: project.value, unity: editor.value.version, executeMethod: method.value ?? null, timeoutSec });
    clearSandboxPidFiles(project.value);
    const runStartMs = Date.now();
    return this.run(bwrap, project.value, resultsDir, command, env.value, timeoutSec)
      .then(async (r) => {
        let problem = r.ok ? testRunProblem(args.value, resultsDir) : null;
        const ranTests = !!args.value?.includes('-runTests');
        const notOurKill = /^(timed out|could not start|bwrap failed)/.test(r.reason ?? '');
        if (ranTests && (!r.ok || problem) && !notOurKill && this.deps.earlyoomJournal) {
          try {
            const line = earlyoomKillLine(await this.deps.earlyoomJournal(runStartMs));
            if (line) problem = earlyoomReason(line);
          } catch { /* no journal access: keep the plain reason */ }
        }
        return this.finish(agentId, reqId, claimed, resultsDir, agentDir,
          { ...r, ...(problem ? { ok: false, reason: problem } : {}), logPath, outputs: [] });
      })
      .finally(() => {
        // The run's pids mean nothing outside its namespace; leave none for the user's editor.
        clearSandboxPidFiles(project.value);
        this.running.delete(project.value);
      });
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private unityProcesses(): Array<{ pid: number; projectPath?: string }> {
    return (this.deps.unityProcesses ?? listUnityProcesses)();
  }

  /** Why no run may start for this agent yet, or null: its cooldown, the agent-run cap, or
   *  the machine's Unity instance limit. A request held back here stays in the queue. */
  private slotBusyReason(agentId: string): string | null {
    const cooldownMs = nonNegativeInt(this.deps.agentCooldownSec?.(), UNITY_AGENT_COOLDOWN_DEFAULT_SEC) * 1000;
    const last = this.lastStart.get(agentId);
    if (last !== undefined && this.now() - last < cooldownMs) {
      const ago = Math.floor((this.now() - last) / 1000);
      const left = Math.ceil((cooldownMs - (this.now() - last)) / 1000);
      return `cooldown: ${agentId} started a Unity run ${ago}s ago; its next run may start in ${left}s`;
    }
    const max = nonNegativeInt(this.deps.maxConcurrent?.(), UNITY_MAX_CONCURRENT_DEFAULT);
    if (this.running.size >= max) {
      return `${this.running.size} agent Unity runs are running (cap ${max}); this one starts when a slot frees`;
    }
    // Broker runs count from this.running: a claimed run may not have spawned Unity yet.
    const outside = this.unityProcesses()
      .filter((p) => !(p.projectPath && this.running.has(p.projectPath))).length;
    const total = outside + this.running.size;
    if (total + 1 > UNITY_MACHINE_INSTANCE_LIMIT) {
      return `${total} Unity instances are already running on this machine (limit ${UNITY_MACHINE_INSTANCE_LIMIT}); this one starts when one exits`;
    }
    return this.memoryBusyReason();
  }

  /** Holds a start while the machine is short of memory. A signal that cannot be read is
   *  skipped with a warning, so a missing /proc never blocks runs. */
  private memoryBusyReason(): string | null {
    const minGb = nonNegativeNumber(this.deps.minMemAvailableGb?.(), UNITY_MIN_MEM_AVAILABLE_GB_DEFAULT);
    const maxPsi = nonNegativeNumber(this.deps.maxMemPressureAvg10?.(), UNITY_MAX_MEM_PSI_AVG10_DEFAULT);
    if (minGb > 0) {
      const gb = this.readSignal('MemAvailable', this.deps.readMeminfo ?? (() => readFileSync('/proc/meminfo', 'utf8')), parseMemAvailableGb);
      if (gb !== null && gb < minGb) {
        return `memory is tight: MemAvailable ${gb.toFixed(1)} GB < ${minGb} GB; this one starts when memory frees`;
      }
    }
    if (maxPsi > 0) {
      const psi = this.readSignal('memory PSI', this.deps.readMemoryPressure ?? (() => readFileSync('/proc/pressure/memory', 'utf8')), parseMemPsiSomeAvg10);
      if (psi !== null && psi > maxPsi) {
        return `memory is tight: PSI some avg10 ${psi.toFixed(1)} > ${maxPsi}; this one starts when pressure eases`;
      }
    }
    return null;
  }

  private readSignal(name: string, read: () => string, parse: (t: string) => number | null): number | null {
    try {
      const v = parse(read());
      if (v === null) this.deps.log({ kind: 'unity-broker-warn', message: `mem gate: ${name} unparseable; signal skipped` });
      return v;
    } catch (err) {
      this.deps.log({ kind: 'unity-broker-warn', message: `mem gate: ${name} unreadable (${err instanceof Error ? err.message : String(err)}); signal skipped` });
      return null;
    }
  }

  /** Defers a request and tells its agent once per request file, not on every tick. */
  private deferWithNotice(agentId: string, reqId: string, filePath: string, reason: string): HandleOutcome {
    if (!this.deferNotified.has(filePath)) {
      this.deferNotified.add(filePath);
      this.deps.notify(agentId, `Unity request ${reqId} is queued`,
        `Your Unity request ${reqId} waits in the queue: ${reason}. Leave the file where it is; the broker starts it on its own.`);
    }
    return { status: 'deferred', reason };
  }

  /** Brings up the run's private display, runs Unity on it, and always takes it down. Never
   *  falls back to the user's display. */
  private async run(
    bwrap: string, project: string, resultsDir: string, command: string[],
    requestedEnv: Record<string, string>, timeoutSec: number
  ): Promise<Omit<UnityResult, 'logPath' | 'outputs'>> {
    const display = await (this.deps.startDisplay ? this.deps.startDisplay() : this.defaultDisplay());
    if ('error' in display) {
      return { ok: false, exitCode: null, reason: `could not start a private display, so Unity was not run: ${display.error}`, durationSec: 0 };
    }
    try {
      return await this.runOnDisplay(bwrap, project, resultsDir, command,
        unityEnv(process.env, requestedEnv, display.display, resultsDir), timeoutSec, display.socket);
    } finally {
      await display.stop();
    }
  }

  private defaultDisplay(): Promise<PrivateDisplay | { error: string }> {
    const root = this.deps.hiveRoot();
    if (!root) return Promise.resolve({ error: 'hive disabled' });
    const server = pickDisplayServer();
    if (!server) return Promise.resolve({ error: 'neither Xvfb nor Xephyr is installed' });
    const helper = join(root, 'bin', 'unity-display.py');
    try {
      mkdirSync(dirname(helper), { recursive: true });
      writeFileSync(helper, UNITY_DISPLAY_HELPER, 'utf8');
    } catch (e) {
      return Promise.resolve({ error: `could not write ${helper} (${String(e)})` });
    }
    return startPrivateDisplay(helper, server, process.env);
  }

  /** This run's own copy of the game's PlayerPrefs folder, seeded from the user's, so two
   *  agents testing the same game never share settings and a run's changes stay in its
   *  results. Best-effort: no project settings, no overlay. */
  private privatePlayerPrefs(home: string, project: string, resultsDir: string): Array<{ src: string; dst: string }> {
    try {
      const dst = playerPrefsDir(home, readFileSync(join(project, 'ProjectSettings', 'ProjectSettings.asset'), 'utf8'));
      if (!dst) return [];
      const src = join(resultsDir, 'player-prefs');
      mkdirSync(src, { recursive: true });
      mkdirSync(dst, { recursive: true });
      if (existsSync(join(dst, 'prefs'))) copyFileSync(join(dst, 'prefs'), join(src, 'prefs'));
      return [{ src, dst }];
    } catch { return []; }
  }

  private runOnDisplay(
    bwrap: string, project: string, resultsDir: string, command: string[],
    env: Record<string, string>, timeoutSec: number, x11Socket: string
  ): Promise<Omit<UnityResult, 'logPath' | 'outputs'>> {
    const home = this.deps.home ?? homedir();
    const userDirs = unityUserDirs(home, this.deps.narrowCache ?? true);
    for (const d of userDirs) mkdirSync(d, { recursive: true });
    const overlays = this.privatePlayerPrefs(home, project, resultsDir);
    const argv = bwrapArgv({
      project,
      resultsDir,
      userDirs,
      gpuNodes: GPU_NODES.filter((d) => existsSync(d)),
      x11Socket: existsSync(x11Socket) ? x11Socket : null,
      unshareNet: this.deps.unshareNet ?? true,
      ...audioMounts(env.XDG_RUNTIME_DIR),
      overlays,
      command
    });
    const started = Date.now();
    const consoleFd = openSync(join(resultsDir, 'console.log'), 'a');
    return new Promise((done) => {
      let timedOut = false;
      let child: ReturnType<typeof spawn>;
      try {
        const run = inAgentScope(bwrap, argv);
        child = spawn(run.file, run.args, { detached: true, stdio: ['ignore', consoleFd, consoleFd], env });
      } catch (e) {
        closeSync(consoleFd);
        done({ ok: false, exitCode: null, reason: `could not start bwrap (${String(e)})`, durationSec: 0 });
        return;
      }
      const killGroup = (sig: NodeJS.Signals): void => {
        try { if (child.pid) process.kill(-child.pid, sig); } catch { /* already gone */ }
      };
      let hardKill: ReturnType<typeof setTimeout> | null = null;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        hardKill = setTimeout(() => killGroup('SIGKILL'), (this.deps.killGraceSec ?? 10) * 1000);
      }, timeoutSec * 1000);
      const settle = (code: number | null, signal: NodeJS.Signals | null, err?: Error): void => {
        clearTimeout(timer);
        if (hardKill) clearTimeout(hardKill);
        // Anything left in the group (a stray helper) goes with the run.
        killGroup('SIGKILL');
        try { closeSync(consoleFd); } catch { /* closed */ }
        const durationSec = Math.round((Date.now() - started) / 100) / 10;
        const reason = err ? `bwrap failed to start (${err.message})`
          : timedOut ? `timed out after ${timeoutSec}s; the process group was killed`
          : code !== 0 ? (signal ? `Unity was killed by ${signal}` : `Unity exited with code ${code}; see unity.log`)
          : undefined;
        done({ ok: !err && !timedOut && code === 0, exitCode: code, ...(reason ? { reason } : {}), durationSec });
      };
      child.once('error', (e) => settle(null, null, e));
      child.once('exit', (code, signal) => settle(code, signal));
    });
  }

  /** Writes result.json, archives the request, tells the agent and logs the run. */
  private finish(
    agentId: string, reqId: string, requestPath: string, resultsDir: string | null,
    agentDir: string, result: UnityResult, detail?: string
  ): HandleOutcome {
    const dir = resultsDir ?? this.freshResultsDir(this.resultsBase(agentDir, agentId), reqId);
    mkdirSync(dir, { recursive: true });
    result.outputs = listOutputs(dir);
    const resultPath = join(dir, 'result.json');
    writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
    archive(requestPath, join(agentDir, 'unity-requests', result.ok ? '.done' : '.failed'));
    this.deps.log({
      kind: 'unity-run', agentId, reqId, ok: result.ok, exitCode: result.exitCode,
      reason: result.reason ?? null, durationSec: result.durationSec, resultPath
    });
    const head = result.ok ? 'finished' : 'failed';
    const body = [
      `Unity request ${reqId} ${head}${result.reason ? `: ${result.reason}` : ''}.`,
      detail ?? '',
      `Result: ${resultPath}`,
      result.logPath ? `Log: ${result.logPath}` : '',
      result.outputs.length ? `Outputs (${dir}): ${result.outputs.join(', ')}` : ''
    ].filter(Boolean).join('\n');
    try { this.deps.notify(agentId, `[unity] ${reqId} ${head}`, body); } catch (e) { console.error('[unity] notify failed:', e); }
    return { status: 'done', resultPath, result };
  }

  /** A results folder no earlier run used: a reused request id gets a suffix, never a
   *  folder that already holds someone's outputs. */
  private freshResultsDir(resultsBase: string, reqId: string): string {
    const base = join(resultsBase, reqId);
    if (!existsSync(base)) return base;
    for (let n = 2; ; n++) {
      const next = `${base}-${n}`;
      if (!existsSync(next)) return next;
    }
  }

  private resultsBase(agentDir: string, agentId: string): string {
    return unityResultsBase(agentDir, agentId, this.deps.resultsRoot?.());
  }

  /** A request still in .running when the harness starts belonged to a run that died with
   *  the previous process (bwrap --die-with-parent took Unity with it). */
  private recoverInterrupted(root: string, agentId: string): void {
    const runningDir = join(root, 'agents', agentId, 'unity-requests', '.running');
    let files: string[] = [];
    try { files = readdirSync(runningDir).filter((f) => f.endsWith('.json')); } catch { return; }
    const agentDir = join(root, 'agents', agentId);
    const resultsBase = this.resultsBase(agentDir, agentId);
    for (const f of files) {
      const reqId = f.replace(/\.json$/i, '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '') || 'request';
      const dir = join(resultsBase, reqId);
      const existing = existsSync(join(dir, 'result.json'));
      this.finish(agentId, reqId, join(runningDir, f), existing ? this.freshResultsDir(resultsBase, reqId) : dir, agentDir, {
        ok: false, exitCode: null, reason: 'interrupted: the harness stopped during this run',
        durationSec: 0, logPath: existsSync(join(dir, 'unity.log')) ? join(dir, 'unity.log') : null, outputs: []
      });
    }
  }
}

function bindTargetsSwapped(project: string, resultsDir: string, resultsBase: string): string | null {
  try {
    if (realpathSync(project) !== project) return `project ${project} changed after it was checked`;
    if (lstatSync(resultsDir).isSymbolicLink() || !isInside(realpathSync(resultsDir), realpathSync(resultsBase))) {
      return `results folder ${resultsDir} is not a plain folder inside ${resultsBase}`;
    }
    return null;
  } catch (e) {
    return `could not check the bind targets (${e instanceof Error ? e.message : String(e)})`;
  }
}

function listOutputs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    let names: string[] = [];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const full = join(d, n);
      const rel = prefix ? `${prefix}/${n}` : n;
      try {
        if (statSync(full).isDirectory()) walk(full, rel);
        else if (!(prefix === '' && HARNESS_FILES.has(n))) out.push(rel);
      } catch { /* vanished */ }
    }
  };
  walk(dir, '');
  return out;
}

function archive(filePath: string, dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    renameSync(filePath, join(dir, basename(filePath)));
  } catch (e) {
    // A request that cannot be moved must not be run again on the next tick.
    try { unlinkSync(filePath); } catch { /* gone */ }
    console.error('[unity] archive failed:', e);
  }
}
