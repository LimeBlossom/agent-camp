import { useEffect, useRef } from 'react';
import { useActiveCast } from '@/scene/office/activeCast';
import { installPortraitRecovery } from '@/scene/office/portraitRecovery';

export interface SpritePortraitProps {
  character: string;
  /** Pixels per source pixel. Whole numbers are exact; half-steps (1.5, 2.5)
   *  double every other row, which pixel art survives. The blit runs with
   *  smoothing off, so nothing here is ever interpolated. */
  scale?: number;
  background?: string;
}

/** Static standing portrait of an Office cast member (recolored LimeZu sprite). */
export function SpritePortrait({
  character,
  scale = 2,
  background = 'transparent'
}: SpritePortraitProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cast = useActiveCast();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    return installPortraitRecovery(canvas, {
      paint: async () => {
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (background !== 'transparent') {
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        await cast.portrait.paint(ctx, character, scale);
      }
    });
  }, [character, scale, background, cast]);

  // A fractional scale can land on a fractional pixel count; the canvas
  // attributes are integers either way, so round once and use the same number
  // for the backing store and the CSS box (a mismatch is what makes pixel art
  // blurry).
  const w = Math.round(cast.portrait.w * scale);
  const h = Math.round(cast.portrait.h * scale);

  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
      style={{
        width: w,
        height: h,
        imageRendering: 'pixelated'
      }}
    />
  );
}
