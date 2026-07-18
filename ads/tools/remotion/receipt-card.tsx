import { useCurrentFrame } from 'remotion';

import { fadeInOpacity } from './fade.js';

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
  const opacity = fadeInOpacity(frame);

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
