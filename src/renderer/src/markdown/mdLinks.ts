/**
 * Pure link/path logic for the markdown preview.
 *
 * Extracted from MarkdownPreview.tsx so it can be unit-tested: these are the
 * functions that decide what a rendered document is allowed to REACH, and a
 * `.tsx` file cannot be loaded by the `node --test` harness. The component keeps
 * only the rendering.
 */
import { isImagePath, videoMimeForPath } from '@shared/imageTypes';

/** Resolve `href` against the directory of `baseRel` ('' when unknown).
 *
 *  Note that `..` can only ever pop segments that this function itself pushed —
 *  once `parts` is empty a `..` is dropped — so the result is always a path
 *  UNDER the workspace root, never a sibling of it. That is a convenience, not
 *  the security boundary: the real containment check is `safeResolve` in the main
 *  process, which every read goes through. */
export function resolveRel(baseRel: string | undefined, href: string): string {
  const baseDir = (baseRel ?? '').split('/').slice(0, -1);
  const parts = [...baseDir];
  for (const seg of href.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

export function isExternal(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

/** True when `href` carries any URI scheme (http:, data:, file:, javascript:…). */
function hasScheme(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

export function isRelativeMd(href: string): boolean {
  return !hasScheme(href) && /\.(md|markdown)(#.*)?$/i.test(href);
}

/**
 * Workspace-relative path for a markdown `<img src>`, or null when the source is
 * not a local image we may load.
 *
 * WHY THIS EXISTS: the preview used to replace EVERY image with a placeholder
 * chip, so an agent-written report containing screenshots rendered as a row of
 * "🖼 screenshot" pills — the report's evidence was invisible everywhere in the
 * app. Local images can now be resolved and read through the same root-confined
 * IPC as everything else.
 *
 * What is refused, and why:
 *  - anything with a SCHEME (http:, https:, data:, file:, javascript:). Remote
 *    URLs are already dead under the CSP (`img-src 'self' data: blob:`), and
 *    silently proxying them through the main process would turn a rendered
 *    document into a network beacon that leaks "this user opened this file" to
 *    whoever authored the markdown. Agent-generated markdown is untrusted.
 *  - anything whose extension is not a known image type — there is no reason for
 *    an <img> to pull an arbitrary file's bytes into the renderer.
 *
 * A leading `/` is read as workspace-root-relative rather than as a filesystem
 * absolute path; the leading slashes are stripped and the rest resolves from the
 * root, so `/etc/passwd` becomes the (harmless, nonexistent) `etc/passwd` inside
 * the workspace instead of escaping to the real one.
 */
export function resolveLocalImageRel(baseRel: string | undefined, src: string | undefined): string | null {
  if (typeof src !== 'string') return null;
  const raw = src.trim();
  if (!raw) return null;
  if (hasScheme(raw)) return null;
  if (!isImagePath(raw)) return null;
  // Strip the query/hash before resolving — they are cache-busters, not path.
  const clean = raw.split('#')[0].split('?')[0];
  const rooted = clean.startsWith('/');
  const rel = resolveRel(rooted ? undefined : baseRel, clean);
  return rel || null;
}

/** A local file named by an ABSOLUTE path (or a `file://` URL), split into the
 *  allowed root it sits under and its path relative to that root; null when it
 *  is not absolute or sits under none of `roots`. This is what lets a surface
 *  with several known workspaces (the ASK ME card) show a file an agent names by
 *  its full path. Containment is still enforced by `safeResolve` in main. */
export function resolveUnderRoots(
  roots: readonly string[],
  src: string | undefined,
): { root: string; rel: string } | null {
  if (typeof src !== 'string') return null;
  let p = src.trim().split('#')[0].split('?')[0];
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(p.replace(/^file:\/\//i, '')); } catch { return null; }
  }
  if (!p.startsWith('/') || p.includes('\0')) return null;
  for (const r of roots) {
    const root = r.replace(/\/+$/, '');
    if (root && p.startsWith(root + '/')) {
      const rel = resolveRel(undefined, p.slice(root.length + 1));
      if (rel) return { root, rel };
    }
  }
  return null;
}

/** Where an image path written on a several-workspace surface (the ASK ME card)
 *  might live, in the order to try them. An absolute path names exactly one
 *  place; a relative one could be under any root, and agents write them relative
 *  to the hive as often as to their own cwd, so each root is a candidate. */
export function imageCandidatesUnderRoots(
  roots: readonly string[],
  src: string | undefined,
): { root: string; rel: string }[] {
  if (typeof src !== 'string' || !isImagePath(src.trim().split('#')[0].split('?')[0])) return [];
  const abs = resolveUnderRoots(roots, src);
  if (abs) return [abs];
  if (src.trim().startsWith('/')) return [];
  const rel = resolveLocalImageRel(undefined, src);
  if (!rel) return [];
  return roots.map((r) => ({ root: r.replace(/\/+$/, ''), rel })).filter((c) => c.root);
}

/** Like imageCandidatesUnderRoots, for an mp4/m4v/webm path. */
export function videoCandidatesUnderRoots(
  roots: readonly string[],
  src: string | undefined,
): { root: string; rel: string }[] {
  if (typeof src !== 'string' || !videoMimeForPath(src.trim().split('#')[0].split('?')[0])) return [];
  const abs = resolveUnderRoots(roots, src);
  if (abs) return [abs];
  if (src.trim().startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(src.trim())) return [];
  const rel = resolveRel(undefined, src.trim().split('#')[0].split('?')[0]);
  if (!rel) return [];
  return roots.map((r) => ({ root: r.replace(/\/+$/, ''), rel })).filter((c) => c.root);
}

/** Absolute paths a file token written on a several-workspace surface might
 *  name, in the order to try them: its own path when absolute and under a root,
 *  else the token under each root. A relative token must look like a file path
 *  (a separator and an extension, no scheme), so prose in backticks stays prose;
 *  an absolute path under a root needs no extension, so a folder qualifies.
 *  Spaces are allowed only in an absolute path under a root, since a relative
 *  token with spaces is as likely a command line (`git add a/b.md`).
 *  Existence is the caller's check. */
export function fileCandidatesUnderRoots(roots: readonly string[], src: string | undefined): string[] {
  if (typeof src !== 'string') return [];
  const t = src.trim();
  if (!t || /[\t\n\r]/.test(t) || hasScheme(t) || !/[/\\]/.test(t)) return [];
  const abs = resolveUnderRoots(roots, t);
  if (abs) return [`${abs.root}/${abs.rel}`];
  if (t.startsWith('/') || /\s/.test(t) || !(/\.[A-Za-z0-9]{1,8}$/.test(t) || /^[^/\\].*\/$/.test(t))) return [];
  const rel = resolveRel(undefined, t);
  if (!rel) return [];
  return roots.map((r) => r.replace(/\/+$/, '')).filter(Boolean).map((r) => `${r}/${rel}`);
}

/** Extra roots for a card: the folders holding the other relative paths it backticks, under
 *  each root. An agent names one output folder in full and the next by bare name
 *  (`a/b/run-1/` and `run-2/`), so the bare one resolves beside the first. */
export function siblingRoots(roots: readonly string[], source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/`([^`\s]+\/[^`\s]+)`/g)) {
    const t = m[1].replace(/\/+$/, '');
    if (t.startsWith('/') || hasScheme(t) || !t.includes('/')) continue;
    const dir = resolveRel(undefined, t).split('/').slice(0, -1).join('/');
    if (!dir) continue;
    for (const r of roots) {
      const c = `${r.replace(/\/+$/, '')}/${dir}`;
      if (!roots.includes(c) && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

/** An http(s) URL whose path names an image. */
export function isRemoteImage(src: string | undefined): boolean {
  return typeof src === 'string' && /^https?:\/\//i.test(src) && isImagePath(src.split('#')[0].split('?')[0]);
}
