/** The phone page's markdown subset for ASK ME questions: paragraphs, line breaks,
 *  headings, bullets, code fences, bold, inline code, links (label only), images,
 *  videos and sound files, either `![alt](path)` or a backticked image or video path. Returns plain data; the page
 *  builds DOM from it with textContent, so no agent text ever becomes markup.
 *
 *  phonePage.ts embeds this function's source in the page, so its body must stay
 *  self-contained: no imports, no closures over module scope, no helper calls. */

export type PhoneSpan =
  | { kind: 'text' | 'b' | 'code'; text: string }
  | { kind: 'img' | 'video' | 'audio'; src: string; alt: string }
  | { kind: 'br' };

export interface PhoneBlock {
  kind: 'p' | 'li' | 'h' | 'pre';
  spans: PhoneSpan[];
  /** A numbered list item: its number leads the spans, so the page hides the bullet. */
  ordered?: boolean;
}

export function parsePhoneMarkdown(source: string): PhoneBlock[] {
  var IMG_EXT = /\.(?:png|jpe?g|gif|webp|svg)$/i;
  var VIDEO_EXT = /\.(?:mp4|m4v|webm)$/i;
  var AUDIO_EXT = /\.(?:mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
  var REMOTE = /^[a-z][a-z0-9+.-]*:/i;
  var INLINE = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)|`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\[([^\]]+)\]\(([^)\s]+)\)/g;

  // A path written both as ![alt](path) and as `path` shows once; the backticked copy stays copyable text.
  var pictured: { [src: string]: boolean } = {};
  var twin = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))/g, tm: RegExpExecArray | null;
  var whole = String(source || '');
  while ((tm = twin.exec(whole))) pictured[(tm[1] !== undefined ? tm[1] : tm[2]).trim()] = true;

  function inline(text: string): PhoneSpan[] {
    var out: PhoneSpan[] = [];
    var last = 0, m: RegExpExecArray | null;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text))) {
      if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
      last = INLINE.lastIndex;
      if (m[2] !== undefined || m[3] !== undefined) {
        var src = (m[2] !== undefined ? m[2] : m[3]).trim();
        // The page's CSP only loads images from itself, so a remote URL stays readable text.
        if (REMOTE.test(src)) out.push({ kind: 'text', text: m[0] });
        else out.push({ kind: VIDEO_EXT.test(src) ? 'video' : AUDIO_EXT.test(src) ? 'audio' : 'img', src: src, alt: m[1] || src });
      } else if (m[4] !== undefined) {
        var code = m[4].trim();
        var media = !/\s/.test(code) && !REMOTE.test(code) && !pictured[code];
        if (media && IMG_EXT.test(code)) out.push({ kind: 'img', src: code, alt: code });
        else if (media && VIDEO_EXT.test(code)) out.push({ kind: 'video', src: code, alt: code });
        else if (media && AUDIO_EXT.test(code)) out.push({ kind: 'audio', src: code, alt: code });
        else out.push({ kind: 'code', text: m[4] });
      } else if (m[5] !== undefined || m[6] !== undefined) {
        out.push({ kind: 'b', text: m[5] !== undefined ? m[5] : (m[6] as string) });
      } else {
        out.push({ kind: 'text', text: m[7] as string });
      }
    }
    if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
    return out;
  }

  var blocks: PhoneBlock[] = [];
  var para: PhoneBlock | null = null;
  var fence: PhoneBlock | null = null;
  var lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (fence) {
      if (/^\s*```/.test(line)) { fence = null; continue; }
      var t = fence.spans[0] as { kind: 'code'; text: string };
      t.text += (t.text ? '\n' : '') + line;
      continue;
    }
    if (/^\s*```/.test(line)) {
      para = null;
      fence = { kind: 'pre', spans: [{ kind: 'code', text: '' }] };
      blocks.push(fence);
      continue;
    }
    if (!line.trim()) { para = null; continue; }
    var h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (h) { para = null; blocks.push({ kind: 'h', spans: inline(h[1]) }); continue; }
    var li = /^(\s*)(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      para = null;
      var spans = inline(li[3]);
      if (li[2]) spans.unshift({ kind: 'text', text: li[2] + '. ' });
      blocks.push(li[2] ? { kind: 'li', spans: spans, ordered: true } : { kind: 'li', spans: spans });
      continue;
    }
    if (para) para.spans = para.spans.concat([{ kind: 'br' }], inline(line));
    else { para = { kind: 'p', spans: inline(line) }; blocks.push(para); }
  }
  return blocks;
}
