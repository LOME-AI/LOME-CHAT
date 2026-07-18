import { useCurrentFrame } from 'remotion';

import { crossFadeOpacity, popInScale } from './fade.js';
import { splitEmphasis } from './caption-emphasis.js';

interface SubtitleLineProps {
  text: string;
  /** Frames this component is mounted for (its parent Sequence duration). */
  durationInFrames: number;
  /** A word/phrase within `text` to render in the brand accent. */
  emphasis?: string;
  fontFamily?: string;
  fontSize?: number;
}

const ACCENT = '#ec4755';

/**
 * A social-style caption chunk: bold, lower-centre, high-contrast. The overlay
 * IS the subtitle — same words as the VO by design — but chunked phrase by
 * phrase at the data level so each lands on its beat. One emphasis word carries
 * the brand accent; motion is a subtle fade + scale settle, never a bounce.
 */
export const SubtitleLine: React.FC<SubtitleLineProps> = ({
  text,
  durationInFrames,
  emphasis,
  fontFamily = 'Inter, system-ui, sans-serif',
  fontSize = 64,
}) => {
  const frame = useCurrentFrame();
  const opacity = crossFadeOpacity(frame, durationInFrames);
  const scale = popInScale(frame);
  const { before, word, after } = splitEmphasis(text, emphasis);

  return (
    <div
      style={{
        position: 'absolute',
        left: '6%',
        right: '6%',
        bottom: '20%',
        textAlign: 'center',
        opacity,
        transform: `scale(${String(scale)})`,
        color: '#ffffff',
        fontFamily,
        fontSize,
        fontWeight: 700,
        letterSpacing: '-0.01em',
        lineHeight: 1.2,
        textShadow: '0 2px 22px rgba(0,0,0,0.7)',
      }}
    >
      {before}
      {word ? <span style={{ color: ACCENT }}>{word}</span> : null}
      {after}
    </div>
  );
};
