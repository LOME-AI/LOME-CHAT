import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockUseStatusBar = vi.fn();
vi.mock('@/capacitor/hooks/use-status-bar', () => ({
  useStatusBar: (...args: unknown[]) => mockUseStatusBar(...args),
}));

import { ThemeProvider, useTheme } from './theme-provider';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => {
      store[key] = value;
    },
    removeItem: (key: string): void => {
      store[key] = undefined as unknown as string;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Required for localStorage mock
      delete store[key];
    },
    clear: (): void => {
      store = {};
    },
  };
})();

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

function TestConsumer(): React.JSX.Element {
  const { mode, triggerTransition } = useTheme();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <button
        onClick={(e) => {
          triggerTransition({ x: e.clientX, y: e.clientY });
        }}
        data-testid="toggle"
      >
        Toggle
      </button>
    </div>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseStatusBar.mockClear();
    localStorageMock.clear();
    delete document.documentElement.dataset['theme'];
    document.documentElement.classList.remove('dark');
    document.documentElement.style.removeProperty('--transition-x');
    document.documentElement.style.removeProperty('--transition-y');
    document.documentElement.style.removeProperty('--transition-radius');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('provides default light mode', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('light');
  });

  it('reads mode from localStorage if available', () => {
    localStorageMock.setItem('themeMode', 'dark');
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
  });

  it('sets data-theme attribute on document', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('provides triggerTransition function', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('toggle')).toBeInTheDocument();
  });

  it('renders children', () => {
    render(
      <ThemeProvider>
        <div data-testid="child">Child content</div>
      </ThemeProvider>
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('useTheme throws warning when used outside provider', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

    function InvalidConsumer(): React.JSX.Element {
      const { triggerTransition } = useTheme();
      triggerTransition({ x: 0, y: 0 });
      return <div>test</div>;
    }

    render(<InvalidConsumer />);
    expect(consoleSpy).toHaveBeenCalledWith('ThemeProvider context not available');
    consoleSpy.mockRestore();
  });

  it('toggles theme and updates localStorage when View Transitions API is not supported', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('mode')).toHaveTextContent('light');

    fireEvent.click(screen.getByTestId('toggle'));

    // Since View Transitions API is not available in jsdom, it should toggle instantly
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(localStorageMock.getItem('themeMode')).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggles back to light mode', () => {
    localStorageMock.setItem('themeMode', 'dark');
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('mode')).toHaveTextContent('dark');

    fireEvent.click(screen.getByTestId('toggle'));

    expect(screen.getByTestId('mode')).toHaveTextContent('light');
    expect(localStorageMock.getItem('themeMode')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('sets dark class on documentElement in dark mode', () => {
    localStorageMock.setItem('themeMode', 'dark');
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('calls useStatusBar with current mode', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(mockUseStatusBar).toHaveBeenCalledWith('light');
  });

  it('calls useStatusBar with dark mode after toggle', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByTestId('toggle'));

    expect(mockUseStatusBar).toHaveBeenCalledWith('dark');
  });

  it('defaults to dark when no stored preference and the OS prefers dark', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        media: '',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    );
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    vi.unstubAllGlobals();
  });

  it('logs and falls back to light when reading localStorage throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
    const getSpy = vi.spyOn(localStorageMock, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(errorSpy).toHaveBeenCalledWith('Error accessing localStorage:', expect.any(Error));
    expect(screen.getByTestId('mode')).toHaveTextContent('light');
    getSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('logs when persisting the theme to localStorage throws but still applies the mode', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    const setSpy = vi.spyOn(localStorageMock, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    fireEvent.click(screen.getByTestId('toggle'));
    expect(errorSpy).toHaveBeenCalledWith(
      'Error saving themeMode to localStorage:',
      expect.any(Error)
    );
    // The mode still flips even though persistence failed.
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    setSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('ignores a second toggle while a transition is in flight, re-enabling after the timeout', () => {
    vi.useFakeTimers();
    try {
      render(
        <ThemeProvider>
          <TestConsumer />
        </ThemeProvider>
      );
      fireEvent.click(screen.getByTestId('toggle'));
      expect(screen.getByTestId('mode')).toHaveTextContent('dark');

      // Second click before the 1500ms lock clears is ignored.
      fireEvent.click(screen.getByTestId('toggle'));
      expect(screen.getByTestId('mode')).toHaveTextContent('dark');

      // The lock clears on the timeout, so a subsequent toggle works again.
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      fireEvent.click(screen.getByTestId('toggle'));
      expect(screen.getByTestId('mode')).toHaveTextContent('light');
    } finally {
      vi.useRealTimers();
    }
  });
});
