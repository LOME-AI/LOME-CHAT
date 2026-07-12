import { interpolate, useCurrentFrame } from 'remotion';

interface ReceiptCardProps {
  lines: readonly string[];
  background?: string;
  fontFamily?: string;
}

/**
 * The payoff card: flat brand-color background, lines set like an invoice
 * line item, one 6-frame fade in. No CTA — the refusal to ask is the
 * personality. Logo/badges are composed by the ad on top of this.
 */
export const ReceiptCard: React.FC<ReceiptCardProps> = ({
  lines,
  background = '#0d0d0f',
  fontFamily = 'Inter, system-ui, sans-serif',
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background,
        opacity,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 10%',
        gap: 28,
      }}
    >
      {lines.map((line) => (
        <div
          key={line}
          style={{
            color: '#ffffff',
            fontFamily,
            fontSize: 50,
            fontWeight: 500,
            lineHeight: 1.3,
          }}
        >
          {line}
        </div>
      ))}
    </div>
  );
};
