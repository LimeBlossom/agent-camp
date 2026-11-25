import { mediaOpenNotice } from '@shared/fileOpenRoute';

export const MEDIA_NOTICE_EVENT = 'cth:media-notice';

/** Shows `text` in the MediaNotice strip; never throws. */
export function showMediaNotice(text: string): void {
  window.dispatchEvent(new CustomEvent<string>(MEDIA_NOTICE_EVENT, { detail: text }));
}

/** Opens an image or video in the system's default app. Every click that used to open the
 *  in-app viewer goes through here; main's openCardFile confines the path and allowlists
 *  the type. A miss or an opener error shows a notice instead of throwing. */
export async function openMediaExternally(absPath: string): Promise<void> {
  const r = await window.cth.openCardFile(absPath).catch(() => null);
  const notice = mediaOpenNotice(r);
  if (notice) showMediaNotice(notice);
}
