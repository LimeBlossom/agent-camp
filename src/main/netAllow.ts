/**
 * Network allowlist for jailed research agents (hive-sandbox-3).
 *
 * Checked at PreToolUse: every http(s) URL in a tool call's input must be on the
 * allowlist of the agent's doing card (plus config.netAllowDefault). Anything else is
 * denied with an "ask for it" reason, and the hook server mails boss a request.
 * This mediates tool calls only; a jailed process opening its own sockets is not stopped.
 */

/** Tools that write files: a URL in their input is a citation, not a fetch. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const WRITE_TOOL_NAME = /write|edit|replace|create_file|patch/i;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Shell separators end a URL too: `curl https://github.com; echo` must yield github.com.
const URL_RE = /\bhttps?:\/\/[^\s'"`<>()\\;|&,]+/gi;

export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (LOOPBACK.has(h)) return true;
  return allow.some((entry) => {
    const e = entry.trim().toLowerCase().replace(/^\*?\./, '');
    return !!e && (h === e || h.endsWith(`.${e}`));
  });
}

function strings(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
}

/** A shell expansion in a URL's host: `$H`, `${H}`, `$(cmd)` or a backtick. */
const SHELL_EXPANSION = /[$`]/;
// URL_RE needs a host character and stops at a backtick, so `https://\`cmd\`` needs its own match.
const BACKTICK_HOST_RE = /\bhttps?:\/\/`/gi;

/** The http(s) URLs in a tool call's input: literal hosts (lowercased, in order, deduped)
 *  and how many URLs build their host at runtime, which no allowlist entry can name. */
function scanUrls(toolName: string | undefined, input: unknown): { hosts: string[]; dynamic: number } {
  const hosts: string[] = [];
  let dynamic = 0;
  if (toolName && (WRITE_TOOLS.has(toolName) || WRITE_TOOL_NAME.test(toolName))) return { hosts, dynamic };
  const texts: string[] = [];
  strings(input, texts);
  for (const t of texts) {
    dynamic += t.match(BACKTICK_HOST_RE)?.length ?? 0;
    for (const m of t.matchAll(URL_RE)) {
      const authority = m[0].replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
      if (SHELL_EXPANSION.test(authority)) { dynamic++; continue; }
      let host: string;
      try { host = new URL(m[0]).hostname.toLowerCase(); } catch { continue; }
      if (host && !hosts.includes(host)) hosts.push(host);
    }
  }
  return { hosts, dynamic };
}

/** Literal hosts of the http(s) URLs in a tool call's input, lowercased, in order, deduped. */
export function urlHostsOf(toolName: string | undefined, input: unknown): string[] {
  return scanUrls(toolName, input).hosts;
}

export function netDecision(o: { toolName: string | undefined; input: unknown; allow: readonly string[]; taskId: string }): { blocked: string[]; deny?: string } {
  const { hosts, dynamic } = scanUrls(o.toolName, o.input);
  const blocked = hosts.filter((h) => !hostAllowed(h, o.allow));
  if (!blocked.length && !dynamic) return { blocked };
  const reasons: string[] = [];
  if (blocked.length) {
    const list = blocked.join(', ');
    reasons.push(`${list} ${blocked.length > 1 ? 'are' : 'is'} not on the network allowlist for task ${o.taskId}. `
      + `Ask for it: the harness has sent boss a request naming ${list} and ${o.taskId}. `
      + 'Carry on without it until boss adds it to the card; do not try another route to the same host.');
  }
  if (dynamic) {
    reasons.push('A URL host built from a shell variable or substitution is not resolvable statically; the proxy decides at runtime. '
      + 'Write the host literally so it can be checked against the allowlist.');
  }
  return { blocked, deny: reasons.join(' ') };
}
