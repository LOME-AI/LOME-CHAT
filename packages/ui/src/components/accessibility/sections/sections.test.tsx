import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ACCESSIBILITY_PREFERENCES_DEFAULTS, type AccessibilityPreferences } from '@hushbox/shared';

const storeState: {
  prefs: AccessibilityPreferences;
  update: (changes: Partial<AccessibilityPreferences>) => void;
  reset: () => void;
} = {
  prefs: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS },
  update: vi.fn(),
  reset: vi.fn(),
};

vi.mock('../store', () => ({
  useA11yStore: <T,>(
    selector: (
      state: AccessibilityPreferences & {
        update: (changes: Partial<AccessibilityPreferences>) => void;
        reset: () => void;
      }
    ) => T
  ): T =>
    selector({
      ...storeState.prefs,
      update: storeState.update,
      reset: storeState.reset,
    }),
}));

vi.mock('../../../hooks/use-is-touch-device', () => ({
  useIsTouchDevice: (): boolean => false,
}));

vi.mock('../lib/font-loader', () => ({
  activateFont: vi.fn().mockResolvedValue(true),
}));

const { ttsLoadMock, ttsPreloadVoiceMock } = vi.hoisted(() => ({
  ttsLoadMock: vi.fn(
    (_voice: string, _onProgress?: (l: number, t: number) => void): Promise<void> =>
      Promise.resolve()
  ),
  ttsPreloadVoiceMock: vi.fn((_voice: string): Promise<void> => Promise.resolve()),
}));

vi.mock('../lib/tts-engine', () => ({
  TTS_VOICES: [
    { id: 'af_heart', displayName: 'Heart', accent: 'American', gender: 'female' },
    { id: 'am_michael', displayName: 'Michael', accent: 'American', gender: 'male' },
  ],
  getTtsService: (): {
    load: typeof ttsLoadMock;
    preloadVoice: typeof ttsPreloadVoiceMock;
  } => ({
    load: ttsLoadMock,
    preloadVoice: ttsPreloadVoiceMock,
  }),
}));

import { VisualSection } from './visual';
import { TypographySection } from './typography';
import { ReadingAidsSection } from './reading-aids';
import { MotionSection } from './motion';
import { PointerFocusSection } from './pointer-focus';
import { AudioSection } from './audio';
import { MetaSection } from './meta';
import { ProfilesSection } from './profiles';
import { activateFont } from '../lib/font-loader';

const activateFontMock = vi.mocked(activateFont);

beforeEach(() => {
  storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS };
  (storeState.update as ReturnType<typeof vi.fn>).mockReset();
  (storeState.reset as ReturnType<typeof vi.fn>).mockReset();
  activateFontMock.mockClear();
  activateFontMock.mockResolvedValue();
  ttsLoadMock.mockReset();
  ttsLoadMock.mockImplementation(() => Promise.resolve());
  ttsPreloadVoiceMock.mockReset();
  ttsPreloadVoiceMock.mockImplementation(() => Promise.resolve());
});

function clickCard(title: string): void {
  const card = screen.getByRole('button', { name: new RegExp(`^${title}: `) });
  fireEvent.click(card);
}

describe('VisualSection', () => {
  it('renders only the three remaining visual cards', () => {
    render(<VisualSection />);
    for (const title of ['Contrast', 'Color intensity', 'Color-blindness filter']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${title}: `) })).not.toBeNull();
    }
  });

  it('does not render removed cards (Reverse colors, Underline links)', () => {
    render(<VisualSection />);
    expect(screen.queryByRole('button', { name: /^Reverse colors/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Underline links/ })).toBeNull();
  });

  it('cycling Contrast calls update with the next value', () => {
    render(<VisualSection />);
    clickCard('Contrast');
    expect(storeState.update).toHaveBeenCalledWith({ contrast: 'increased' });
  });

  it('cycling Color intensity calls update with a saturation value', () => {
    render(<VisualSection />);
    clickCard('Color intensity');
    expect(storeState.update).toHaveBeenCalledWith(
      expect.objectContaining({ saturation: expect.anything() })
    );
  });

  it('cycling Color-blindness filter calls update with a colorblindSimulate value', () => {
    render(<VisualSection />);
    clickCard('Color-blindness filter');
    expect(storeState.update).toHaveBeenCalledWith(
      expect.objectContaining({ colorblindSimulate: expect.anything() })
    );
  });

  it('Color-blindness filter labels use technical term first', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, colorblindSimulate: 'protan' };
    render(<VisualSection />);
    expect(screen.getByText('Protanopia (red-blind)')).not.toBeNull();
  });
});

describe('TypographySection', () => {
  it('renders typography cards (no Align text left)', () => {
    render(<TypographySection />);
    for (const title of [
      'Text size',
      'Space between letters',
      'Space between lines',
      'Space between paragraphs',
      'Font',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(`^${title}: `) })).not.toBeNull();
    }
    expect(screen.queryByRole('button', { name: /^Align text left/ })).toBeNull();
  });

  it('cycling Text size updates fontSize', () => {
    render(<TypographySection />);
    clickCard('Text size');
    expect(storeState.update).toHaveBeenCalledWith({ fontSize: '112' });
  });

  it('default Font label is "Merriweather (default)"', () => {
    render(<TypographySection />);
    expect(screen.getByText('Merriweather (default)')).not.toBeNull();
  });

  it('cycling Space between letters updates letterSpacing', () => {
    render(<TypographySection />);
    clickCard('Space between letters');
    expect(storeState.update).toHaveBeenCalledWith(
      expect.objectContaining({ letterSpacing: expect.anything() })
    );
  });

  it('cycling Space between lines updates lineHeight', () => {
    render(<TypographySection />);
    clickCard('Space between lines');
    expect(storeState.update).toHaveBeenCalledWith(
      expect.objectContaining({ lineHeight: expect.anything() })
    );
  });

  it('cycling Space between paragraphs updates paragraphSpacing', () => {
    render(<TypographySection />);
    clickCard('Space between paragraphs');
    expect(storeState.update).toHaveBeenCalledWith(
      expect.objectContaining({ paragraphSpacing: expect.anything() })
    );
  });

  it('cycling Font to a non-system face updates fontFamily and activates the font', () => {
    render(<TypographySection />);
    clickCard('Font');
    expect(storeState.update).toHaveBeenCalledWith({ fontFamily: 'atkinson' });
    expect(activateFontMock).toHaveBeenCalledWith('atkinson');
  });

  it('cycling Font back to the system face does not activate a font', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, fontFamily: 'open-dyslexic' };
    render(<TypographySection />);
    clickCard('Font');
    expect(storeState.update).toHaveBeenCalledWith({ fontFamily: 'system' });
    expect(activateFontMock).not.toHaveBeenCalled();
  });
});

describe('ReadingAidsSection', () => {
  it('renders the two reading helpers (Page outline removed)', () => {
    render(<ReadingAidsSection />);
    for (const title of ['Magnifier lens', 'Reading band']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${title}: `) })).not.toBeNull();
    }
    expect(screen.queryByRole('button', { name: /^Page outline/ })).toBeNull();
  });

  it('toggling Magnifier lens calls update with magnifier:true', () => {
    render(<ReadingAidsSection />);
    clickCard('Magnifier lens');
    expect(storeState.update).toHaveBeenCalledWith({ magnifier: true });
  });

  it('toggling Reading band calls update with readingGuide:true', () => {
    render(<ReadingAidsSection />);
    clickCard('Reading band');
    expect(storeState.update).toHaveBeenCalledWith({ readingGuide: true });
  });

  it('shows Reading band as on when readingGuide is already enabled', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, readingGuide: true };
    render(<ReadingAidsSection />);
    clickCard('Reading band');
    expect(storeState.update).toHaveBeenCalledWith({ readingGuide: false });
  });

  it('shows Magnifier lens as on when magnifier is already enabled', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, magnifier: true };
    render(<ReadingAidsSection />);
    clickCard('Magnifier lens');
    expect(storeState.update).toHaveBeenCalledWith({ magnifier: false });
  });
});

describe('MotionSection', () => {
  it('renders a single Animations card', () => {
    render(<MotionSection />);
    expect(screen.getByRole('button', { name: /^Animations: / })).not.toBeNull();
  });

  it('toggling Animations (Allow → Stop) writes stopAnimations:true', () => {
    render(<MotionSection />);
    clickCard('Animations');
    expect(storeState.update).toHaveBeenCalledWith({ stopAnimations: true });
  });

  it('shows Stop when stopAnimations is already true and cycles back to Allow', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, stopAnimations: true };
    render(<MotionSection />);
    const button = screen.getByRole('button', { name: /^Animations: / });
    expect(button.getAttribute('aria-label')).toMatch(/Stop/);
    clickCard('Animations');
    expect(storeState.update).toHaveBeenCalledWith({ stopAnimations: false });
  });
});

describe('PointerFocusSection', () => {
  it('renders the pointer and focus cards (non-touch device)', () => {
    render(<PointerFocusSection />);
    for (const title of [
      'Pointer size',
      'Pointer color',
      'Focus ring thickness',
      'Focus ring color',
      'Focus glow',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(`^${title}: `) })).not.toBeNull();
    }
  });

  it('cycling Pointer size calls update with a cursorSize value', () => {
    render(<PointerFocusSection />);
    clickCard('Pointer size');
    expect(storeState.update).toHaveBeenCalledWith(
      expect.objectContaining({ cursorSize: expect.anything() })
    );
  });

  it('cycling Focus ring thickness calls update with a focusWidth value', () => {
    render(<PointerFocusSection />);
    clickCard('Focus ring thickness');
    expect(storeState.update).toHaveBeenCalledWith(
      expect.objectContaining({ focusWidth: expect.anything() })
    );
  });

  it('Pointer color only offers black / white (no system)', () => {
    render(<PointerFocusSection />);
    const button = screen.getByRole('button', { name: /^Pointer color: / });
    expect(button.getAttribute('aria-label')).toMatch(/Black|White/);
  });

  it('cycling Pointer color from black goes to white', () => {
    render(<PointerFocusSection />);
    clickCard('Pointer color');
    expect(storeState.update).toHaveBeenCalledWith({ cursorColor: 'white' });
  });

  it('clicking Focus ring color while thickness is Off also bumps thickness to Thin', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, focusWidth: '0' };
    render(<PointerFocusSection />);
    clickCard('Focus ring color');
    expect(storeState.update).toHaveBeenCalledWith({ focusColor: 'magenta', focusWidth: '2' });
  });

  it('clicking Focus ring color while thickness is non-Off does NOT change thickness', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, focusWidth: '4' };
    render(<PointerFocusSection />);
    clickCard('Focus ring color');
    expect(storeState.update).toHaveBeenCalledWith({ focusColor: 'magenta' });
  });

  it('toggling Focus glow ON while thickness is Off also bumps thickness to Thin', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, focusWidth: '0', focusHalo: false };
    render(<PointerFocusSection />);
    clickCard('Focus glow');
    expect(storeState.update).toHaveBeenCalledWith({ focusHalo: true, focusWidth: '2' });
  });

  it('toggling Focus glow ON while thickness is already set does NOT touch thickness', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, focusWidth: '4', focusHalo: false };
    render(<PointerFocusSection />);
    clickCard('Focus glow');
    expect(storeState.update).toHaveBeenCalledWith({ focusHalo: true });
  });

  it('toggling Focus glow OFF never bumps thickness', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, focusWidth: '0', focusHalo: true };
    render(<PointerFocusSection />);
    clickCard('Focus glow');
    expect(storeState.update).toHaveBeenCalledWith({ focusHalo: false });
  });
});

describe('AudioSection', () => {
  it('renders Mute all sounds + Read chat replies aloud + disclaimer regardless of ttsEnabled', () => {
    render(<AudioSection />);
    expect(screen.getByRole('button', { name: /^Mute all sounds: / })).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Read chat replies aloud: / })).not.toBeNull();
    expect(screen.getByText(/88 MB, one-time download/)).not.toBeNull();
    expect(
      screen.getByText(/Runs entirely on your device\. No audio or text ever leaves this device/)
    ).not.toBeNull();
  });

  it('does NOT render the old "Turn on read-aloud" gate button', () => {
    render(<AudioSection />);
    expect(screen.queryByText(/Turn on read-aloud/)).toBeNull();
  });

  it('renders the same controls when ttsEnabled is already true', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ttsEnabled: true };
    render(<AudioSection />);
    expect(screen.getByRole('button', { name: /^Read chat replies aloud: / })).not.toBeNull();
    expect(screen.getByText(/88 MB, one-time download/)).not.toBeNull();
  });

  it('does not render placeholder "Read page" / "Read selection" buttons', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ttsEnabled: true };
    render(<AudioSection />);
    expect(screen.queryByText('Read page')).toBeNull();
    expect(screen.queryByText('Read selection')).toBeNull();
  });

  it('voice selector trigger uses the widened (twice as wide) class', () => {
    const { container } = render(<AudioSection />);
    const trigger = container.querySelector('[aria-labelledby="a11y-voice-label"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.className).toContain('w-[22rem]');
  });

  it('first-time enable: loads the model with the currently selected voice so its embedding warms up', async () => {
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: false,
      ttsVoice: 'am_michael',
    };
    render(<AudioSection />);
    fireEvent.click(screen.getByRole('button', { name: /^Read chat replies aloud: / }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ttsLoadMock).toHaveBeenCalledTimes(1);
    expect(ttsLoadMock.mock.calls[0]![0]).toBe('am_michael');
  });

  it('voice change after TTS is enabled triggers preloadVoice() so the new embedding is fetched up front', async () => {
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: true,
      ttsVoice: 'af_heart',
    };
    const { rerender } = render(<AudioSection />);
    expect(ttsPreloadVoiceMock).not.toHaveBeenCalled();
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: true,
      ttsVoice: 'am_michael',
    };
    rerender(<AudioSection />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ttsPreloadVoiceMock).toHaveBeenCalledTimes(1);
    expect(ttsPreloadVoiceMock).toHaveBeenLastCalledWith('am_michael');
  });

  it('voice change before TTS is enabled does NOT call preloadVoice()', async () => {
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: false,
      ttsVoice: 'af_heart',
    };
    const { rerender } = render(<AudioSection />);
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: false,
      ttsVoice: 'am_michael',
    };
    rerender(<AudioSection />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ttsPreloadVoiceMock).not.toHaveBeenCalled();
  });

  it('download-size disclosure shows the q8/WASM size (~88 MB) unconditionally', async () => {
    render(<AudioSection />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText(/88 MB, one-time download/)).not.toBeNull();
    expect(screen.queryByText(/330 MB/)).toBeNull();
  });

  it('mid-download, shows bytes loaded/total, speed, and ETA derived from progress callbacks', async () => {
    let capturedOnProgress: ((loaded: number, total: number) => void) | undefined;
    ttsLoadMock.mockImplementation(
      (_voice: string, onProgress?: (l: number, t: number) => void): Promise<void> => {
        capturedOnProgress = onProgress;
        // Never resolves — we want to inspect the mid-download UI.
        return new Promise<void>(() => {});
      }
    );

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_700_000_000_000));

      storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ttsEnabled: false };
      render(<AudioSection />);
      fireEvent.click(screen.getByRole('button', { name: /^Read chat replies aloud: / }));

      // Flush the microtask that invokes load() inside the handler.
      await act(async () => {
        await Promise.resolve();
      });
      expect(capturedOnProgress).toBeDefined();

      const MB = 1_048_576;
      act(() => {
        capturedOnProgress!(0, 88 * MB);
      });
      vi.setSystemTime(new Date(1_700_000_001_000));
      act(() => {
        capturedOnProgress!(4 * MB, 88 * MB);
      });

      expect(screen.getByText(/4\.0 \/ 88 MB/)).not.toBeNull();
      expect(screen.getByText(/4\.0 MB\/s/)).not.toBeNull();
      expect(screen.getByText(/21s left/)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('toggling read-aloud off writes streamChatAloud:false', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, streamChatAloud: true };
    render(<AudioSection />);
    const button = screen.getByRole('button', { name: /^Read chat replies aloud: / });
    expect(button.getAttribute('aria-label')).toMatch(/On/);
    fireEvent.click(button);
    expect(storeState.update).toHaveBeenCalledWith({ streamChatAloud: false });
  });

  it('enabling read-aloud when the model is already loaded skips the download', () => {
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: true,
      streamChatAloud: false,
    };
    render(<AudioSection />);
    fireEvent.click(screen.getByRole('button', { name: /^Read chat replies aloud: / }));
    expect(storeState.update).toHaveBeenCalledWith({ streamChatAloud: true });
    expect(ttsLoadMock).not.toHaveBeenCalled();
  });

  it('first-time enable completes: requests persistent storage and turns chat-aloud on', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis.navigator, 'storage');
    Object.defineProperty(globalThis.navigator, 'storage', {
      configurable: true,
      value: { persist },
    });
    try {
      storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ttsEnabled: false };
      ttsLoadMock.mockResolvedValueOnce();
      render(<AudioSection />);
      fireEvent.click(screen.getByRole('button', { name: /^Read chat replies aloud: / }));
      await waitFor(() => {
        expect(storeState.update).toHaveBeenCalledWith({ ttsEnabled: true, streamChatAloud: true });
      });
      expect(persist).toHaveBeenCalled();
    } finally {
      if (originalStorage) Object.defineProperty(globalThis.navigator, 'storage', originalStorage);
      else Reflect.deleteProperty(globalThis.navigator as object, 'storage');
    }
  });

  it('surfaces a download error when the model fails to load', async () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ttsEnabled: false };
    ttsLoadMock.mockRejectedValueOnce(new Error('network down'));
    render(<AudioSection />);
    fireEvent.click(screen.getByRole('button', { name: /^Read chat replies aloud: / }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('network down');
    });
  });

  it('ignores download progress callbacks that report a non-positive total', async () => {
    let onProgress: ((loaded: number, total: number) => void) | undefined;
    ttsLoadMock.mockImplementation(
      (_voice: string, callback?: (l: number, t: number) => void): Promise<void> => {
        onProgress = callback;
        return new Promise<void>(() => {});
      }
    );
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ttsEnabled: false };
    render(<AudioSection />);
    fireEvent.click(screen.getByRole('button', { name: /^Read chat replies aloud: / }));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      onProgress?.(10, 0);
    });
    // A non-positive total is ignored, so no byte-progress text appears.
    expect(screen.queryByText(/\/ 0 MB/)).toBeNull();
  });

  it('does not re-preload when the voice effect runs without a voice change', async () => {
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: false,
      ttsVoice: 'af_heart',
    };
    const { rerender } = render(<AudioSection />);
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: true,
      ttsVoice: 'af_heart',
    };
    rerender(<AudioSection />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ttsPreloadVoiceMock).not.toHaveBeenCalled();
  });

  it('logs but does not throw when voice preload rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    ttsPreloadVoiceMock.mockRejectedValueOnce(new Error('preload boom'));
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: true,
      ttsVoice: 'af_heart',
    };
    const { rerender } = render(<AudioSection />);
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: true,
      ttsVoice: 'am_michael',
    };
    rerender(<AudioSection />);
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalled();
    });
    consoleError.mockRestore();
  });

  it('toggling Mute all sounds writes muteSounds:true', () => {
    render(<AudioSection />);
    fireEvent.click(screen.getByRole('button', { name: /^Mute all sounds: / }));
    expect(storeState.update).toHaveBeenCalledWith({ muteSounds: true });
  });

  it('shows Mute all sounds as on when muted', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, muteSounds: true };
    render(<AudioSection />);
    expect(
      screen.getByRole('button', { name: /^Mute all sounds: / }).getAttribute('aria-label')
    ).toMatch(/On/);
  });

  it('selecting a different voice writes the new ttsVoice', async () => {
    const user = userEvent.setup();
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ttsVoice: 'af_heart' };
    render(<AudioSection />);
    await user.click(screen.getByRole('combobox', { name: /Voice/ }));
    await user.click(await screen.findByRole('option', { name: /Michael/ }));
    expect(storeState.update).toHaveBeenCalledWith({ ttsVoice: 'am_michael' });
  });
});

describe('MetaSection', () => {
  it('renders a reset-to-defaults button', () => {
    render(<MetaSection />);
    expect(screen.getByRole('button', { name: /Reset all to defaults/ })).not.toBeNull();
  });

  it('does NOT render a Reset to OS preferences button', () => {
    render(<MetaSection />);
    expect(screen.queryByRole('button', { name: /OS preferences/i })).toBeNull();
  });

  it('clicking Reset all to defaults invokes the store reset', () => {
    render(<MetaSection />);
    fireEvent.click(screen.getByRole('button', { name: /Reset all to defaults/ }));
    expect(storeState.reset).toHaveBeenCalledTimes(1);
  });
});

describe('ProfilesSection', () => {
  it('renders all five profile entries plus a Default entry', () => {
    render(<ProfilesSection />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(6);
  });

  it('renders a Default quick-start button as the first entry', () => {
    render(<ProfilesSection />);
    const first = screen.getAllByRole('button')[0]!;
    expect(first.textContent).toContain('Default');
  });

  it('clicking the Default button calls reset() only (no update)', () => {
    render(<ProfilesSection />);
    const first = screen.getAllByRole('button')[0]!;
    fireEvent.click(first);
    expect(storeState.reset).toHaveBeenCalledTimes(1);
    expect(storeState.update).not.toHaveBeenCalled();
  });

  it('clicking a profile calls reset() then update(profile.preset)', () => {
    render(<ProfilesSection />);
    // Default is index 0; first real profile is index 1.
    const firstProfile = screen.getAllByRole('button')[1]!;
    fireEvent.click(firstProfile);
    expect(storeState.reset).toHaveBeenCalledTimes(1);
    expect(storeState.update).toHaveBeenCalledTimes(1);
    const passed = (storeState.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(Object.keys(passed as Record<string, unknown>).length).toBeGreaterThanOrEqual(
      Object.keys(ACCESSIBILITY_PREFERENCES_DEFAULTS).length
    );
  });

  it('every quick-start button uses cursor-pointer', () => {
    render(<ProfilesSection />);
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('cursor-pointer');
    }
  });
});
