import { interpolate, useCurrentFrame } from 'remotion';

interface SubtitleLineProps {
  text: string;
  /** Frames this component is mounted for (its parent Sequence duration). */
  durationInFrames: number;
  fontFamily?: string;
  fontSize?: number;
}

/**
 * The overlay IS the subtitle — same words as the VO by design. Opacity-only
 * motion (6-frame fades); the type never animates. Stillness is the voice.
 */
export const SubtitleLine: React.FC<SubtitleLineProps> = ({
  text,
  durationInFrames,
  fontFamily = 'Inter, system-ui, sans-serif',
  fontSize = 54,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 6, durationInFrames - 6, durationInFrames], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        left: '8%',
        right: '8%',
        bottom: '18%',
        opacity,
        color: '#ffffff',
        fontFamily,
        fontSize,
        fontWeight: 500,
        lineHeight: 1.35,
        textShadow: '0 2px 18px rgba(0,0,0,0.65)',
      }}
    >
      {text}
    </div>
  );
};
