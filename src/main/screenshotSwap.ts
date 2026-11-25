import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SwapOptions {
  hiveRoot: string;
  cardId: string;
  /** New images, in the order of the image links they replace. */
  images: string[];
  /** Stamp for the kept copy of each replaced file. */
  now?: () => Date;
}

export interface SwapResult {
  ok: boolean;
  error?: string;
  /** Each link swapped: the embedded path, now holding the new image, and where the old one went. */
  swapped?: Array<{ link: string; from: string; keptOld: string }>;
  /** Every image link in the question and whether its file is there. */
  links?: Array<{ link: string; ok: boolean }>;
}

const IMAGE_LINK = /!\[[^\]]*\]\(([^)\s]+)\)/g;

export function imageLinks(md: string): string[] {
  return [...md.matchAll(IMAGE_LINK)].map((m) => m[1]);
}

/** The card question the swap targets: the open one (no answer, not dismissed), else the latest. */
function targetQuestion(card: Record<string, unknown>): string | null {
  const qa = Array.isArray(card.humanQA) ? card.humanQA.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { q?: unknown }).q === 'string') : [];
  const open = [...qa].reverse().find((e) => !e.a && !e.dismissedAt);
  const pick = open ?? qa[qa.length - 1];
  return pick ? (pick.q as string) : null;
}

/** Copy new screenshots over the files a card's question already embeds (only files
 *  inside the hive), so every link keeps working with no ledger edit, then check each
 *  link resolves. The replaced file is kept beside it as `<name>.prev-<stamp><ext>`. */
export function swapScreenshots(o: SwapOptions): SwapResult {
  if (!o.cardId || !o.images?.length) return { ok: false, error: 'card_id and at least one image are required.' };
  let card: Record<string, unknown> | undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(o.hiveRoot, 'tasks.json'), 'utf8')) as { tasks?: Array<Record<string, unknown>> };
    card = raw.tasks?.find((t) => t && t.id === o.cardId);
  } catch (e) {
    return { ok: false, error: `tasks.json unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!card) return { ok: false, error: `no card ${o.cardId}` };
  const q = targetQuestion(card);
  if (!q) return { ok: false, error: `card ${o.cardId} has no question to swap images in` };
  const resolve = (l: string): string => (path.isAbsolute(l) ? l : path.join(o.hiveRoot, l));
  const links = imageLinks(q);
  if (o.images.length > links.length) return { ok: false, error: `the question embeds ${links.length} image(s); ${o.images.length} given` };
  const missing = o.images.filter((s) => !fs.existsSync(s) || !fs.statSync(s).isFile());
  if (missing.length) return { ok: false, error: `new image not found: ${missing.join(', ')}` };
  const root = path.resolve(o.hiveRoot) + path.sep;
  const outside = links.slice(0, o.images.length).filter((l) => !path.resolve(resolve(l)).startsWith(root));
  if (outside.length) return { ok: false, error: `only images copied into the hive can be swapped; outside it: ${outside.join(', ')}` };

  const checked = links.map((l) => {
    const p = resolve(l);
    return { link: l, ok: fs.existsSync(p) && fs.statSync(p).isFile() && fs.statSync(p).size > 0 };
  });
  const broken = checked.filter((c) => !c.ok).map((c) => c.link);
  if (broken.length) {
    return { ok: false, error: `broken image link(s): ${broken.join(', ')}`, links: checked };
  }

  const stamp = (o.now ?? (() => new Date()))().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const swapped: NonNullable<SwapResult['swapped']> = [];
  const createdBackups: Array<{ dest: string; backup: string }> = [];
  const modifiedDestinations = new Map<string, Buffer>();

  const rollback = (): { rollbackErrors: string[]; preservedBackups: string[] } => {
    const rollbackErrors: string[] = [];
    const restoredDests = new Set<string>();
    for (const [destPath, origBytes] of modifiedDestinations.entries()) {
      try {
        fs.writeFileSync(destPath, origBytes);
        restoredDests.add(destPath);
      } catch (e) {
        rollbackErrors.push(`failed to restore ${destPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const preservedBackups: string[] = [];
    for (const { dest, backup } of createdBackups) {
      if (restoredDests.has(dest)) {
        try { if (fs.existsSync(backup)) fs.unlinkSync(backup); } catch { /* ignore */ }
      } else {
        if (fs.existsSync(backup)) {
          preservedBackups.push(backup);
        }
      }
    }
    return { rollbackErrors, preservedBackups };
  };

  try {
    for (let i = 0; i < o.images.length; i++) {
      const dest = resolve(links[i]);
      const ext = path.extname(dest);
      const base = path.basename(dest, ext);
      const dir = path.dirname(dest);
      let keptOld = path.join(dir, `${base}.prev-${stamp}${ext}`);
      if (fs.existsSync(keptOld)) {
        let seq = 1;
        while (fs.existsSync(path.join(dir, `${base}.prev-${stamp}-${seq}${ext}`))) seq++;
        keptOld = path.join(dir, `${base}.prev-${stamp}-${seq}${ext}`);
      }
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(dest) && !modifiedDestinations.has(dest)) {
        modifiedDestinations.set(dest, fs.readFileSync(dest));
      }
      if (fs.existsSync(dest)) {
        fs.copyFileSync(dest, keptOld);
        createdBackups.push({ dest, backup: keptOld });
      }
      fs.copyFileSync(o.images[i], dest);
      if (fs.statSync(dest).size !== fs.statSync(o.images[i]).size) {
        throw new Error(`copy to ${dest} came out a different size`);
      }
      swapped.push({ link: links[i], from: o.images[i], keptOld: fs.existsSync(keptOld) ? keptOld : '' });
    }
  } catch (err) {
    const { rollbackErrors, preservedBackups } = rollback();
    const errMessage = err instanceof Error ? err.message : String(err);
    if (rollbackErrors.length > 0) {
      const rollbackMsg = `rollback/restoration failed: ${rollbackErrors.join('; ')}`;
      const recoveryMsg = preservedBackups.length > 0 ? `; recovery backup preserved at: ${preservedBackups.join(', ')}` : '';
      return { ok: false, error: `${errMessage} (${rollbackMsg}${recoveryMsg})` };
    }
    return { ok: false, error: errMessage };
  }

  return { ok: true, swapped, links: checked };
}
