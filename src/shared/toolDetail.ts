/**
 * A short, human phrase for what a tool call is doing, from its input: what an
 * agent's thought bubble and status line show instead of a bare "using Bash".
 * Undefined when the input says nothing useful; callers fall back to the name.
 */
const MAX = 80;

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX ? one.slice(0, MAX - 1).trimEnd() + '…' : one;
}

function base(p: unknown): string | undefined {
  if (typeof p !== 'string' || !p) return undefined;
  return p.split(/[\\/]/).filter(Boolean).pop();
}

function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export function toolDetail(tool: string | undefined, input: unknown): string | undefined {
  if (!tool || !input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  const file = base(i.file_path ?? i.notebook_path ?? i.path);
  switch (tool) {
    case 'Bash': {
      const d = str(i, 'description');
      if (d) return clip(d);
      const c = str(i, 'command');
      return c ? clip(`running ${c}`) : undefined;
    }
    case 'Read': return file ? `reading ${file}` : undefined;
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return file ? `editing ${file}` : undefined;
    case 'Write': return file ? `writing ${file}` : undefined;
    // The pattern itself is regex noise in a bubble; where it looks is what reads.
    case 'Grep': return file ? `searching ${file}` : 'searching the code';
    case 'Glob': return file ? `looking for files in ${file}` : 'looking for files';
    case 'WebFetch': {
      const u = str(i, 'url');
      if (!u) return undefined;
      try { return `reading ${new URL(u).host}`; } catch { return undefined; }
    }
    case 'WebSearch': { const q = str(i, 'query'); return q ? clip(`searching the web: ${q}`) : undefined; }
    case 'Task': case 'Agent': { const d = str(i, 'description'); return d ? clip(`delegating: ${d}`) : undefined; }
    case 'TodoWrite': return 'updating the to-do list';
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return clip(`${mcp[2].replace(/_/g, ' ')} (${mcp[1]})`);
  return undefined;
}
