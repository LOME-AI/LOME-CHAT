const COLORS = {
  background: '#0a0a0a',
  card: '#171717',
  textPrimary: '#fafafa',
  textSecondary: '#a1a1aa',
  accent: '#ec4755',
  border: '#27272a',
} as const;

export function wrapInBaseTemplate(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <title>HushBox</title>
  <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&display=swap" rel="stylesheet">
</head>
<body style="margin: 0; padding: 0; background-color: ${COLORS.background}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${COLORS.background};">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <!-- Header -->
          <tr>
            <td align="center" style="padding: 20px 0; border-bottom: 1px solid ${COLORS.border};">
              <span style="font-size: 24px; font-weight: 700; color: ${COLORS.textPrimary}; letter-spacing: 2px; font-family: 'Merriweather', Georgia, serif;">Hush<span style="color: ${COLORS.accent};">Box</span></span>
            </td>
          </tr>
          <!-- Content Card -->
          <tr>
            <td style="padding: 40px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${COLORS.card}; border-radius: 12px; border: 1px solid ${COLORS.border};">
                <tr>
                  <td style="padding: 40px;">
                    ${content}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="center" style="padding: 20px 0; border-top: 1px solid ${COLORS.border};">
              <p style="margin: 0 0 8px 0; color: ${COLORS.textSecondary}; font-size: 12px;">
                &copy; 2026 LOME-AI LLC
              </p>
              <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 12px;">
                Questions? <a href="mailto:hello@hushbox.ai" style="color: ${COLORS.accent}; text-decoration: none;">hello@hushbox.ai</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export { COLORS };
