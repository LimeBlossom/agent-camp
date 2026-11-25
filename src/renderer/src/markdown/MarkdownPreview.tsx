/**
 * Rendered markdown view (v0.3.4) — the shared preview used by the IDE's
 * split/preview modes, the fullscreen file overlay, and (via those) the
 * terminal ⌘-click flow. The `card` variant renders agent-written markdown
 * inside another surface: the ASK ME question and the task detail's Q&A trail.
 *
 * SECURITY: agent-generated markdown is untrusted. react-markdown WITHOUT
 * rehype-raw renders to React elements only — no HTML sink exists, raw HTML in
 * the source is shown as text, and the default urlTransform already drops
 * javascript: URIs. Keep it that way: never add rehype-raw here.
 *
 * Links never navigate the window: http(s)/mailto go through the main-process
 * opener; relative *.md links surface through onOpenMarkdownLink so the host
 * (IDE tab / overlay) opens them in context; everything else is inert.
 */
import { memo, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useWorkspaceImage } from '@/hooks/useWorkspaceImage';
import { fileCandidatesUnderRoots, imageCandidatesUnderRoots, videoCandidatesUnderRoots, isExternal, isRelativeMd, isRemoteImage, resolveLocalImageRel, resolveRel, resolveUnderRoots } from './mdLinks';
import { isImagePath } from '@shared/imageTypes';
import { openMediaExternally } from '@/media/openMedia';
import { remarkSoftBreaks } from './remarkSoftBreaks';
import { rehypeAutoDir } from './rehypeAutoDir';
import { useRtl } from '@/i18n/useDirection';

/** How the rendered markdown sits in its host.
 *  - `document` (default): a page — its own type scale, 72ch measure, page padding.
 *  - `card`: markdown INSIDE another surface (an ASK ME question, a Q&A entry).
 *    Inherits the host's font and size, drops the page chrome, and keeps a single
 *    newline as a line break the way the plain-text block it replaced did. */
export type MarkdownVariant = 'document' | 'card';

// Hoisted: a fresh array on every render would make react-markdown re-run the
// whole pipeline even when nothing about the source changed.
const DOC_PLUGINS = [remarkGfm];
const CARD_PLUGINS = [remarkGfm, remarkSoftBreaks];

/** Per-block `dir="auto"`, for an RTL app language only — see the note at the
 *  `useRtl()` call site below. Frozen module constants so the prop identity is
 *  stable and react-markdown does not re-run the pipeline on every render. */
const AUTO_DIR_PLUGINS = [rehypeAutoDir];
const NO_PLUGINS: never[] = [];

export interface MarkdownPreviewProps {
  source: string;
  /** Repo-relative path of the file being previewed (for resolving relative links). */
  baseRel?: string;
  /** Absolute workspace root. Supplying it turns LOCAL images from placeholder
   *  chips into actual pictures (read through the root-confined fs IPC); without
   *  it every image stays a chip, because there is nothing to resolve against. */
  root?: string;
  /** Several workspaces a document may point into, by absolute path (the ASK ME
   *  card). Local images under any of them render, and a click enlarges them; a
   *  link to a local image shows it; a link to any other local file reveals it.
   *  A relative path resolves against `root`, or the first of these. */
  roots?: string[];
  /** Open a sibling markdown file (repo-relative path) in the host's context. */
  onOpenMarkdownLink?: (rel: string) => void;
  /** With `roots`: make a backticked file path clickable. Gets the absolute
   *  paths it might name, most likely first; the host checks which exists. */
  onOpenFile?: (candidates: string[]) => void;
  /** Page vs in-card rendering. Defaults to `document`. */
  variant?: MarkdownVariant;
}

export const MarkdownPreview = memo(function MarkdownPreview({
  source, baseRel, root, roots, onOpenMarkdownLink, onOpenFile, variant = 'document'
}: MarkdownPreviewProps) {
  const imageRoot = root ?? roots?.[0];
  const rootsKey = roots?.join('\n');
  const card = variant === 'card';
  // Per-block direction, gated on the APP LANGUAGE rather than on the text.
  //
  // The plugin stamps `dir="auto"`, which resolves from each block's first
  // strong character — so ungated it fires for an English user the moment an
  // agent quotes a line of Arabic, and mirrors a block of their UI over
  // something they never turned on. Keying it to the chosen language instead
  // means an English user's markdown renders through exactly the pipeline it
  // rendered through before this existed, whatever the agent writes into it.
  const rtl = useRtl();
  // Stable renderers: react-markdown compares these by identity, and a fresh
  // function each render remounts every image (a reload and a height jump) on
  // any re-render of the host, e.g. each keystroke in the ASK ME answer box.
  const components = useMemo((): Components => ({
    a: ({ href, children }) => {
      const h = href ?? '';
      const local = roots ? resolveUnderRoots(roots, h) : null;
      if (local) {
        const abs = `${local.root}/${local.rel}`;
        if (isImagePath(local.rel)) {
          return (
            <span>
              <a href={h} title={`${abs} (open in default app)`} onClick={(e) => { e.preventDefault(); void openMediaExternally(abs); }}>{children}</a>
              <MdImage root={local.root} rel={local.rel} alt={String(children ?? '')} src={abs} />
            </span>
          );
        }
        return (
          <a href={h} title={`${abs} (reveal in folder)`}
            onClick={(e) => { e.preventDefault(); void window.cth.revealPath?.(abs); }}>
            {children}
          </a>
        );
      }
      const relImage = roots && !hasSchemeOrAnchor(h) ? imageCandidatesUnderRoots(roots, h) : [];
      if (relImage.length) {
        return (
          <span>
            <a href={h} title={`${h} (open in default app)`}
              onClick={(e) => { e.preventDefault(); void openMediaExternally(`${relImage[0].root}/${relImage[0].rel}`); }}>{children}</a>
            <MdImage root={relImage[0].root} rel={relImage[0].rel} next={relImage.slice(1)} alt={String(children ?? '')} src={h} />
          </span>
        );
      }
      const onClick = (e: React.MouseEvent) => {
        e.preventDefault();
        if (isExternal(h)) { void window.cth.openExternal?.(h); return; }
        if (isRelativeMd(h) && onOpenMarkdownLink) {
          onOpenMarkdownLink(resolveRel(baseRel, h.replace(/#.*$/, '')));
        }
        // anything else (file:, anchors into self, unknown schemes): inert
      };
      const clickable = isExternal(h) || (isRelativeMd(h) && !!onOpenMarkdownLink);
      return (
        <a
          href={h || undefined}
          onClick={onClick}
          title={h}
          style={clickable ? undefined : { cursor: 'default', textDecoration: 'underline dotted' }}
        >
          {children}
        </a>
      );
    },
    // Agents name a screenshot as `path/to/shot.png` far more often than as
    // an image, so on a card with roots an inline-code image path shows it.
    code: ({ className, children }) => {
      const text = typeof children === 'string' ? children.trim() : '';
      const found = roots && !className && !/\s/.test(text) ? imageCandidatesUnderRoots(roots, text) : [];
      const vids = !found.length && roots && !className && !/\s/.test(text) ? videoCandidatesUnderRoots(roots, text) : [];
      if (vids.length) {
        return (
          <span>
            <code>{children}</code>
            <MdVideo root={vids[0].root} rel={vids[0].rel} next={vids.slice(1)} alt={text} src={text} />
          </span>
        );
      }
      if (!found.length) {
        const files = roots && onOpenFile && !className ? fileCandidatesUnderRoots(roots, text) : [];
        if (!files.length) return <code className={className}>{children}</code>;
        return (
          <code className="cth-md-filelink" title={`${text} (click to open)`} onClick={() => onOpenFile!(files)}>
            {children}
          </code>
        );
      }
      return (
        <span>
          <code>{children}</code>
          <MdImage root={found[0].root} rel={found[0].rel} next={found.slice(1)} alt={text} src={text} />
        </span>
      );
    },
    // Images. LOCAL ones render for real (bytes via the root-confined fs
    // IPC → blob URL); remote ones stay a placeholder chip. Until now
    // every image was a chip, which meant an agent's report saying "see
    // the screenshot below" showed a pill reading "🖼 screenshot" and the
    // evidence was unviewable anywhere in the app.
    img: ({ alt, src }) => {
      const s = typeof src === 'string' ? src : undefined;
      const found = roots ? imageCandidatesUnderRoots(roots, s) : [];
      const vids = roots && !found.length ? videoCandidatesUnderRoots(roots, s) : [];
      if (vids.length) return <MdVideo root={vids[0].root} rel={vids[0].rel} next={vids.slice(1)} alt={alt} src={s} />;
      if (found.length) return <MdImage root={found[0].root} rel={found[0].rel} next={found.slice(1)} alt={alt} src={s} />;
      // Remote images stay unloaded (the CSP forbids them, and loading them
      // would tell a document's author it was opened); offer the browser instead.
      if (roots && isRemoteImage(s)) return <ImageChip alt={alt} src={s} onOpen={() => void window.cth.openExternal?.(s!)} />;
      const rel = imageRoot ? resolveLocalImageRel(baseRel, s) : null;
      if (!imageRoot || !rel) return <ImageChip alt={alt} src={s} />;
      return <MdImage root={imageRoot} rel={rel} alt={alt} src={s} />;
    }
  }), [rootsKey, baseRel, imageRoot, onOpenMarkdownLink, onOpenFile]);
  return (
    <div className={card ? 'cth-md-preview cth-md-card' : 'cth-md-preview'}>
      <ReactMarkdown
        remarkPlugins={card ? CARD_PLUGINS : DOC_PLUGINS}
        rehypePlugins={rtl ? AUTO_DIR_PLUGINS : NO_PLUGINS}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}, (a, b) => a.source === b.source && a.baseRel === b.baseRel && a.root === b.root
  && a.variant === b.variant && a.onOpenMarkdownLink === b.onOpenMarkdownLink && a.onOpenFile === b.onOpenFile
  // Hosts build `roots` fresh each render; equal contents mean nothing changed.
  && (a.roots === b.roots || (!!a.roots && !!b.roots && a.roots.join('\n') === b.roots.join('\n'))));

function hasSchemeOrAnchor(href: string): boolean {
  return href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** Fallback for anything we won't (or can't) load: remote URLs, non-images,
 *  and local files that turned out to be missing or undecodable. */
function ImageChip({ alt, src, note, onOpen }: { alt?: string; src?: string; note?: string; onOpen?: () => void }) {
  return (
    <span className="cth-md-img" title={onOpen ? `${src} (open in browser)` : src}
      onClick={onOpen} style={onOpen ? { cursor: 'pointer' } : undefined}>
      {alt || 'image'}{note ? ` — ${note}` : ''}
    </span>
  );
}

/** A local video inside rendered markdown, played inline from a blob URL. Falls back to the chip when the file is missing or too large. */
function MdVideo({ root, rel, next, alt, src }: {
  root: string; rel: string; next?: { root: string; rel: string }[]; alt?: string; src?: string;
}) {
  const vid = useWorkspaceImage(root, rel);
  if (vid.status === 'loading') return <ImageChip alt={alt} src={src} note="loading" />;
  if (vid.status === 'error' && next?.length) {
    return <MdVideo root={next[0].root} rel={next[0].rel} next={next.slice(1)} alt={alt} src={src} />;
  }
  if (vid.status === 'error') return <ImageChip alt={alt} src={src} note={vid.error} />;
  return <video className="cth-md-image" src={vid.url} controls preload="metadata" title={src} style={{ maxWidth: '100%' }} />;
}

/** A local image inside rendered markdown; a click opens it in the default app.
 *  Falls back to the chip on any failure so a stale path in a report degrades to
 *  the old behaviour instead of a broken-image glyph. Blob lifetime (create AND
 *  revoke) belongs to the hook. */
function MdImage({ root, rel, next, alt, src }: {
  root: string; rel: string; next?: { root: string; rel: string }[]; alt?: string; src?: string;
}) {
  const img = useWorkspaceImage(root, rel);
  const [decodeFailed, setDecodeFailed] = useState(false);
  if (img.status === 'loading') return <ImageChip alt={alt} src={src} note="loading" />;
  if (img.status === 'error' && next?.length) {
    return <MdImage root={next[0].root} rel={next[0].rel} next={next.slice(1)} alt={alt} src={src} />;
  }
  if (img.status === 'error') return <ImageChip alt={alt} src={src} note={img.error} />;
  if (decodeFailed) return <ImageChip alt={alt} src={src} note="could not decode" />;
  return (
    <img
      className="cth-md-image"
      src={img.url}
      alt={alt || rel}
      title={`${src} (open in default app)`}
      onError={() => setDecodeFailed(true)}
      onClick={() => void openMediaExternally(`${root}/${rel}`)}
      style={{ cursor: 'pointer' }}
    />
  );
}
