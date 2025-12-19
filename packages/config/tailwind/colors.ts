export const colors = {
  light: {
    primary: '#ec4755',
    secondary: '#7209b7',
    tertiary: '#ffba75',
    tertiaryLight: '#ffba7544',
    background: '#fef8e0',
    paper: '#ffffff',
    text: '#000000',
    textMuted: '#444444',
    accent: '#4CC9F0',
    error: '#FF5757',
    warning: '#FFC914',
    info: '#00BBF9',
    success: '#00F5D4',
  },
  dark: {
    primary: '#ec4755',
    secondary: '#b5179e',
    tertiary: '#ffd1a1',
    tertiaryLight: '#ffba7522',
    background: '#000000',
    paper: '#121212',
    text: '#F2F2F2',
    textMuted: '#BBBBBB',
    accent: '#7B2CBF',
    error: '#FF5757',
    warning: '#FFBE0B',
    info: '#3A86FF',
    success: '#00F5D4',
  },
} as const;

export type ColorTheme = typeof colors.light;
export type ColorKey = keyof ColorTheme;
