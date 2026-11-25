/**
 * Hard denies for agent shell commands, applied by Camp's PreToolUse hook server
 * to every agent it runs (Claude `Bash` and Codex shell tools): no `git push`
 * except of the ~/.claude repo, and no delete aimed outside the agent's own
 * delete roots. The boss may lead a command with HIVE_GUARD_OVERRIDE="<reason>";
 * the caller logs every use.
 *
 * This is a parser, not a sandbox: what it cannot resolve (an unknown variable,
 * a command substitution, an unreadable `cd`) it treats as outside, so the
 * failure mode is a false deny, never a silent pass.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export interface GuardContext {
  cwd: string | null;
  home: string;
  /** The variables the agent's shell was spawned with; `$NAME` in a command expands from these. */
  env: Record<string, string>;
  deleteRoots: string[];
  pushRepos: string[];
  isBoss: boolean;
}

export interface GuardVerdict {
  deny: string | null;
  override: string | null;
}

export const OVERRIDE_VAR = 'HIVE_GUARD_OVERRIDE';

/** Tool names whose input is a shell command: Claude's, Codex's and Antigravity's run_command. */
export const SHELL_TOOL_NAMES = ['Bash', 'shell', 'local_shell', 'exec_command', 'container.exec', 'unified_exec', 'run_command'];

interface Word {
  text: string;
  /** Holds an expansion the guard cannot evaluate ($VAR, $(...), backticks). */
  unresolved: boolean;
  /** Why the first unknown `$NAME` in this word could not be expanded. */
  unknown?: string;
  /** Index in text of the first unquoted glob character, or -1. */
  glob: number;
  /** Index in text where quoting or expansion first began (assignment detection). */
  special: number;
}

interface Parsed {
  segments: Word[][];
  /** Bodies of $(...), `...` and <(...): scripts that run too. */
  subs: string[];
}

const SEPARATORS = new Set([';', '&', '|', '(', ')']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const WRAPPERS = new Set(['sudo', 'command', 'nice', 'nohup', 'time', 'exec', 'builtin', 'ionice', 'chrt', 'stdbuf']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done']);
const DELETERS = new Set(['rm', 'unlink', 'rmdir', 'shred']);
/** git global options that take a separate argument. */
const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);
const XARGS_ARG_OPTS = new Set(['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file']);

interface VarScope {
  home: string;
  trusted: Map<string, string>;
  rebound: Set<string>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A command that can rebind any variable without naming it. */
const REBINDS_ANY = /(^|[\s;&|(){}`])(source|eval|\.)(?=[\s;&|)]|$)/;

/**
 * The spawn-env variables a command may be expanded with. Judged once on the
 * whole command, nested scripts included, so `X=/ bash -c '... $X'` is seen.
 * A name that appears anywhere other than as `$NAME` / `${NAME}` (an assignment,
 * export, read, for, printf -v, a `${NAME:-x}` form) may hold another value at
 * run time, so it stays unresolved.
 */
function varScope(command: string, home: string, env: Record<string, string>): VarScope {
  const trusted = new Map<string, string>();
  const rebound = new Set<string>();
  const any = REBINDS_ANY.test(command);
  for (const [name, value] of Object.entries({ ...env, HOME: home })) {
    if (!IDENT.test(name)) continue;
    const rest = command.replace(new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`, 'g'), '');
    if (any || new RegExp(`(^|[^A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(rest)) rebound.add(name);
    else trusted.set(name, value);
  }
  return { home, trusted, rebound };
}

/** Reads `$(...)` / `<(...)` starting after the opening paren; returns [body, indexAfterClose]. */
function readBalanced(s: string, i: number): [string, number] {
  let depth = 1;
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); i = j < 0 ? s.length : j + 1; continue; }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return [s.slice(start, i), i + 1];
    i++;
  }
  return [s.slice(start), s.length];
}

function parse(script: string, vars: VarScope): Parsed {
  const segments: Word[][] = [];
  const subs: string[] = [];
  let seg: Word[] = [];
  let w: Word | null = null;
  const heredocs: Array<{ delim: string; strip: boolean }> = [];
  let i = 0;
  const begin = (): Word => (w ??= { text: '', unresolved: false, glob: -1, special: Infinity });
  const mark = (x: Word): void => { if (x.special === Infinity) x.special = x.text.length; };
  const endWord = (): void => { if (w) seg.push(w); w = null; };
  const endSeg = (): void => { endWord(); if (seg.length) segments.push(seg); seg = []; };

  const expand = (x: Word): void => {
    // At s[i] === '$'.
    mark(x);
    const n = script[i + 1];
    if (n === '(') {
      const [body, after] = readBalanced(script, i + 2);
      subs.push(body);
      x.unresolved = true;
      i = after;
      return;
    }
    let name = '';
    let j = i + 1;
    if (n === '{') {
      const close = script.indexOf('}', j);
      name = script.slice(j + 1, close < 0 ? script.length : close);
      j = close < 0 ? script.length : close + 1;
    } else {
      const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(script.slice(j));
      if (!m) { x.text += '$'; i++; return; }
      name = m[1];
      j += name.length;
    }
    const value = vars.trusted.get(name);
    if (value !== undefined) x.text += value;
    else {
      x.unresolved = true;
      if (IDENT.test(name)) {
        x.unknown ??= vars.rebound.has(name) ? `$${name} is reassigned by the command` : `$${name} is not set in this agent's environment`;
      }
    }
    i = j;
  };

  while (i < script.length) {
    const c = script[i];
    if (c === '\n') {
      endSeg();
      i++;
      // Heredoc bodies are data, not commands.
      while (heredocs.length) {
        const h = heredocs.shift()!;
        while (i < script.length) {
          const nl = script.indexOf('\n', i);
          const line = script.slice(i, nl < 0 ? script.length : nl);
          i = nl < 0 ? script.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '#' && !w) {
      const nl = script.indexOf('\n', i);
      i = nl < 0 ? script.length : nl;
      continue;
    }
    if (c === '\\') {
      if (script[i + 1] === '\n') { i += 2; continue; }
      const x = begin(); mark(x);
      x.text += script[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === "'") {
      const x = begin(); mark(x);
      const j = script.indexOf("'", i + 1);
      x.text += script.slice(i + 1, j < 0 ? script.length : j);
      i = j < 0 ? script.length : j + 1;
      continue;
    }
    if (c === '"') {
      const x = begin(); mark(x);
      i++;
      while (i < script.length && script[i] !== '"') {
        const d = script[i];
        if (d === '\\' && '$`"\\\n'.includes(script[i + 1] ?? '')) { x.text += script[i + 1] === '\n' ? '' : script[i + 1]; i += 2; continue; }
        if (d === '$') { expand(x); continue; }
        if (d === '`') {
          const j = script.indexOf('`', i + 1);
          subs.push(script.slice(i + 1, j < 0 ? script.length : j));
          x.unresolved = true;
          i = j < 0 ? script.length : j + 1;
          continue;
        }
        x.text += d;
        i++;
      }
      i++;
      continue;
    }
    if (c === '$') { expand(begin()); continue; }
    if (c === '`') {
      const x = begin(); mark(x);
      const j = script.indexOf('`', i + 1);
      subs.push(script.slice(i + 1, j < 0 ? script.length : j));
      x.unresolved = true;
      i = j < 0 ? script.length : j + 1;
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && script[i + 1] === '>')) {
      if (c === '<' && script[i + 1] === '(') {
        const [body, after] = readBalanced(script, i + 2);
        subs.push(body);
        i = after;
        continue;
      }
      // A redirection: drop a pending fd number, the operator and its target word.
      const fd = w as Word | null;
      if (fd && /^\d+$/.test(fd.text) && fd.special === Infinity) w = null;
      else endWord();
      let op = '';
      while (i < script.length && '<>&|-'.includes(script[i])) { op += script[i]; i++; }
      while (script[i] === ' ' || script[i] === '\t') i++;
      const hereStart = i;
      while (i < script.length && !' \t\n;&|()<>'.includes(script[i])) i++;
      if (op === '<<' || op === '<<-') {
        heredocs.push({ delim: script.slice(hereStart, i).replace(/['"\\]/g, ''), strip: op === '<<-' });
      }
      continue;
    }
    if (SEPARATORS.has(c)) {
      endSeg();
      i++;
      if ((c === '&' || c === '|') && script[i] === c) i++;
      continue;
    }
    const x = begin();
    if ((c === '*' || c === '?' || c === '[') && x.glob < 0) x.glob = x.text.length;
    if (c === '~' && x.text === '' && x.special === Infinity && (i + 1 >= script.length || '/ \t\n;&|)'.includes(script[i + 1]))) {
      x.text += vars.home;
      i++;
      continue;
    }
    x.text += c;
    i++;
  }
  endSeg();
  return { segments, subs };
}

function isAssignment(x: Word): boolean {
  const m = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(x.text);
  return !!m && m[0].length - 1 < x.special;
}

/** Real path of `p`, following symlinks in its existing prefix (the leaf too unless keepLeaf). */
function canonical(p: string, keepLeaf = false): string {
  const abs = resolve(p);
  if (keepLeaf) {
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonical(parent), basename(abs));
  }
  let head = abs;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(basename(head));
    head = up;
  }
  let real = head;
  try { real = realpathSync(head); } catch { /* keep the spelling */ }
  return tail.length ? join(real, ...tail) : real;
}

function within(p: string, root: string, allowEqual: boolean): boolean {
  if (p === root) return allowEqual;
  return p.startsWith(root.endsWith(sep) ? root : root + sep);
}

interface Violation { reason: string }

class Analyzer {
  private roots: string[];
  private pushRepos: string[];
  private vars: VarScope;
  constructor(private ctx: GuardContext, command = '') {
    this.vars = varScope(command, ctx.home, ctx.env);
    this.roots = ctx.deleteRoots.map((r) => canonical(r));
    this.pushRepos = ctx.pushRepos.map((r) => canonical(r));
  }

  /** Absolute path for a word, or null when it cannot be known. */
  private pathOf(x: Word, cwd: string | null): string | null {
    if (x.unresolved) return null;
    if (isAbsolute(x.text)) return x.text;
    return cwd ? resolve(cwd, x.text) : null;
  }

  private checkDelete(x: Word, cwd: string | null, contentsOnly: boolean): Violation | null {
    let raw = x;
    let inside = contentsOnly;
    if (x.glob >= 0) {
      const prefix = x.text.slice(0, x.glob);
      const dir = prefix.endsWith('/') ? prefix : dirname(prefix || '.');
      raw = { ...x, text: dir || '/' };
      inside = true;
    }
    const abs = this.pathOf(raw, cwd);
    if (!abs) return { reason: `cannot resolve delete target "${x.text}"${x.unknown ? ` (${x.unknown})` : ''}` };
    const real = canonical(abs, !inside && !x.text.endsWith('/'));
    if (this.roots.some((r) => within(real, r, inside))) return null;
    return { reason: `delete of ${real} is outside this agent's scratch` };
  }

  checkFileDelete(path: string, cwd: string | null): Violation | null {
    return this.checkDelete({ text: path, unresolved: false, glob: -1, special: Infinity }, cwd, false);
  }

  private checkPush(repoDir: string | null): Violation | null {
    if (repoDir) {
      const real = canonical(repoDir);
      if (this.pushRepos.some((r) => within(real, r, true))) return null;
    }
    return { reason: 'git push is denied for agents; the boss pushes after review' };
  }

  /** Violations of one script, starting in cwd. */
  run(script: string, cwd: string | null, inheritedOverride: string | null, out: Array<{ v: Violation; override: string | null }>): void {
    const { segments, subs } = parse(script, this.vars);
    for (const sub of subs) this.run(sub, cwd, inheritedOverride, out);
    for (const segment of segments) cwd = this.segment(segment, cwd, inheritedOverride, out);
  }

  /** Checks one simple command; returns the cwd for the next one. */
  private segment(words: Word[], cwd: string | null, inherited: string | null, out: Array<{ v: Violation; override: string | null }>): string | null {
    let k = 0;
    let override = inherited;
    const push = (v: Violation | null): void => { if (v) out.push({ v, override }); };
    for (;;) {
      while (k < words.length && isAssignment(words[k])) {
        const t = words[k].text;
        if (t.startsWith(`${OVERRIDE_VAR}=`)) override = words[k].unresolved ? null : t.slice(OVERRIDE_VAR.length + 1).trim() || null;
        k++;
      }
      if (k >= words.length) return cwd;
      const name = basename(words[k].text);
      if (KEYWORDS.has(words[k].text)) { k++; continue; }
      if (WRAPPERS.has(name)) {
        k++;
        while (k < words.length && words[k].text.startsWith('-')) k++;
        continue;
      }
      if (name === 'env') {
        k++;
        while (k < words.length && words[k].text.startsWith('-')) k++;
        continue;
      }
      if (name === 'timeout') {
        k++;
        while (k < words.length && words[k].text.startsWith('-')) k++;
        k++;
        continue;
      }
      break;
    }
    const cmd = words[k];
    const name = basename(cmd.text);
    const args = words.slice(k + 1);

    if (name === 'cd') {
      const target = args.find((a) => !a.text.startsWith('-'));
      if (!target) return this.ctx.home;
      return this.pathOf(target, cwd);
    }
    if (SHELLS.has(name)) {
      const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a.text));
      if (ci >= 0 && args[ci + 1]) {
        if (args[ci + 1].unresolved) push({ reason: `cannot read the script passed to ${name} -c` });
        else this.run(args[ci + 1].text, cwd, override, out);
      }
      return cwd;
    }
    if (name === 'git') { this.git(args, cwd, push); return cwd; }
    if (DELETERS.has(name)) {
      let dashdash = false;
      for (const a of args) {
        if (!dashdash && a.text === '--') { dashdash = true; continue; }
        if (!dashdash && a.text.startsWith('-') && a.text.length > 1) continue;
        push(this.checkDelete(a, cwd, false));
      }
      return cwd;
    }
    if (name === 'find') {
      const paths: Word[] = [];
      let j = 0;
      while (j < args.length && !/^[-(!]/.test(args[j].text)) paths.push(args[j++]);
      const rest = args.slice(j).map((a) => a.text);
      const deletes = rest.includes('-delete') || rest.some((t, n) =>
        (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') && DELETERS.has(basename(rest[n + 1] ?? '')));
      if (deletes) {
        const starts = paths.length ? paths : [{ text: '.', unresolved: false, glob: -1, special: Infinity }];
        for (const p of starts) push(this.checkDelete(p, cwd, false));
      }
      return cwd;
    }
    if (name === 'xargs') {
      let j = 0;
      while (j < args.length && args[j].text.startsWith('-')) j += XARGS_ARG_OPTS.has(args[j].text) ? 2 : 1;
      if (j < args.length && (DELETERS.has(basename(args[j].text)) || basename(args[j].text) === 'git')) {
        // The targets arrive on stdin; all that is known is where they resolve from.
        push(this.checkDelete({ text: '.', unresolved: false, glob: -1, special: Infinity }, cwd, true));
      }
      return cwd;
    }
    return cwd;
  }

  private git(args: Word[], cwd: string | null, push: (v: Violation | null) => void): void {
    let repo = cwd;
    let gitDir: string | null = null;
    const aliases = new Map<string, string>();
    let j = 0;
    while (j < args.length && args[j].text.startsWith('-')) {
      const a = args[j];
      const eq = a.text.indexOf('=');
      const opt = a.text.startsWith('--') && eq > 0 ? a.text.slice(0, eq) : a.text;
      const inline = a.text.startsWith('--') && eq > 0;
      if (!GIT_ARG_OPTS.has(opt)) { j++; continue; }
      const val: Word | undefined = inline ? { ...a, text: a.text.slice(eq + 1) } : args[j + 1];
      j += inline ? 1 : 2;
      if (!val) break;
      if (opt === '-C') repo = this.pathOf(val, repo);
      else if (opt === '--git-dir') gitDir = this.pathOf(val, repo);
      else if (opt === '--work-tree') repo = this.pathOf(val, repo);
      else if (opt === '-c') {
        const m = /^alias\.([^=]+)=(.*)$/s.exec(val.text);
        if (m) aliases.set(m[1], m[2]);
      }
    }
    const sub = args[j]?.text;
    if (!sub) return;
    const alias = aliases.get(sub);
    const pushes = sub === 'push' || sub === 'send-pack' || (alias !== undefined && /\b(push|send-pack)\b/.test(alias));
    if (pushes) { push(this.checkPush(gitDir ? dirname(gitDir) : repo)); return; }
    if (sub === 'clean') {
      const rest = args.slice(j + 1);
      const dd = rest.findIndex((a) => a.text === '--');
      const specs = (dd >= 0 ? rest.slice(dd + 1) : rest.filter((a) => !a.text.startsWith('-')));
      const base: Word = { text: repo ?? '', unresolved: repo === null, glob: -1, special: Infinity };
      if (!specs.length) push(this.checkDelete(base, cwd, true));
      for (const s of specs) push(this.checkDelete(s, repo, true));
    }
  }
}

export function guardShellCommand(command: string, ctx: GuardContext): GuardVerdict {
  const found: Array<{ v: Violation; override: string | null }> = [];
  new Analyzer(ctx, command).run(command, ctx.cwd, null, found);
  let override: string | null = null;
  for (const f of found) {
    if (ctx.isBoss && f.override) { override ??= f.override; continue; }
    const lift = ctx.isBoss ? ` Lead the command with ${OVERRIDE_VAR}="<reason>" to lift this (the reason is logged).` : '';
    return { deny: `Denied by Camp's agent guard: ${f.v.reason}.${lift}`, override: null };
  }
  return { deny: null, override };
}

/** Paths an apply_patch body removes: each Delete File, and the source of each Move to. */
function patchRemovals(patch: string): string[] {
  const out: string[] = [];
  let updating: string | null = null;
  for (const line of patch.split('\n')) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line.trimEnd());
    if (m) {
      updating = m[1] === 'Update' ? m[2].trim() : null;
      if (m[1] === 'Delete') out.push(m[2].trim());
    } else if (updating && /^\*\*\* Move to: /.test(line)) {
      out.push(updating);
      updating = null;
    }
  }
  return out;
}

/** The guard for a Codex apply_patch body. No override: the boss deletes with rm, which takes the prefix. */
export function guardPatch(patch: string, ctx: GuardContext): GuardVerdict {
  const analyzer = new Analyzer(ctx);
  for (const path of patchRemovals(patch)) {
    const v = analyzer.checkFileDelete(path, ctx.cwd);
    if (v) {
      const lift = ctx.isBoss ? ` Delete it with rm instead, led by ${OVERRIDE_VAR}="<reason>" (the reason is logged).` : '';
      return { deny: `Denied by Camp's agent guard: ${v.reason}.${lift}`, override: null };
    }
  }
  return { deny: null, override: null };
}

/** The directory a shell or patch call runs in, as given by the tool (Codex workdir, Antigravity Cwd). */
export function toolWorkdirOf(input: unknown): string | null {
  const o = input as { workdir?: unknown; Cwd?: unknown } | null | undefined;
  const dir = o?.workdir ?? o?.Cwd;
  return typeof dir === 'string' && dir ? dir : null;
}

/** The body of a Codex apply_patch tool input, or null. */
export function patchTextOf(toolName: string | undefined, input: unknown): string | null {
  if (toolName !== 'apply_patch' || !input || typeof input !== 'object') return null;
  const o = input as { command?: unknown; patch?: unknown; input?: unknown };
  const body = [o.command, o.patch, o.input].find((v) => typeof v === 'string');
  return typeof body === 'string' ? body : null;
}

/** A shell tool input as one command string, or null when it is not one. */
export function shellCommandOf(toolName: string | undefined, input: unknown): string | null {
  if (!toolName || !SHELL_TOOL_NAMES.includes(toolName) || !input || typeof input !== 'object') return null;
  const o = input as { command?: unknown; cmd?: unknown; CommandLine?: unknown };
  const raw = o.command ?? o.cmd ?? o.CommandLine;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((a) => {
      const s = String(a);
      return /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
    }).join(' ');
  }
  return null;
}
