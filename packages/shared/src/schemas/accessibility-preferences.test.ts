import { describe, it, expect } from 'vitest';
import {
  accessibilityPreferencesSchema,
  ACCESSIBILITY_PREFERENCES_DEFAULTS,
  reconcileAccessibilityPreferences,
  TTS_VOICE_IDS,
  type AccessibilityPreferences,
} from './accessibility-preferences.js';

describe('TTS_VOICE_IDS', () => {
  it('lists exactly the voices the ttsVoice preference accepts', () => {
    for (const id of TTS_VOICE_IDS) {
      expect(accessibilityPreferencesSchema.parse({ version: 1, ttsVoice: id }).ttsVoice).toBe(id);
    }
    expect(TTS_VOICE_IDS).toHaveLength(5);
  });
});

describe('ACCESSIBILITY_PREFERENCES_DEFAULTS', () => {
  it('exists and is a parsed object', () => {
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS).toBeDefined();
    expect(typeof ACCESSIBILITY_PREFERENCES_DEFAULTS).toBe('object');
  });

  it('has the correct default values for all visual fields', () => {
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.version).toBe(1);
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.contrast).toBe('normal');
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.saturation).toBe('100');
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.colorblindSimulate).toBe('none');
  });

  it('has the correct default values for all typography fields', () => {
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.fontSize).toBe('100');
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.letterSpacing).toBe('0');
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.lineHeight).toBe('1.5');
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.paragraphSpacing).toBe('1');
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.fontFamily).toBe('system');
  });

  it('has the correct default values for all reading aids fields', () => {
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.magnifier).toBe(false);
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.readingGuide).toBe(false);
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.readingHighlight).toBe(true);
  });

  it('has the correct default values for all audio fields', () => {
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.ttsEnabled).toBe(false);
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.ttsVoice).toBe('af_heart');
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.streamChatAloud).toBe(false);
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.muteSounds).toBe(false);
  });

  it('has the correct default value for motion field', () => {
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.stopAnimations).toBe(false);
  });

  it('has the correct default values for pointer & focus fields', () => {
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.cursorSize).toBe('normal');
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.cursorColor).toBe('black');
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.focusWidth).toBe('0');
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.focusColor).toBe('yellow');
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.focusHalo).toBe(false);
  });

  it('contains every expected key', () => {
    const expectedKeys = [
      'version',
      'contrast',
      'saturation',
      'colorblindSimulate',
      'fontSize',
      'letterSpacing',
      'lineHeight',
      'paragraphSpacing',
      'fontFamily',
      'magnifier',
      'readingGuide',
      'readingHighlight',
      'ttsEnabled',
      'ttsVoice',
      'streamChatAloud',
      'muteSounds',
      'stopAnimations',
      'cursorSize',
      'cursorColor',
      'focusWidth',
      'focusColor',
      'focusHalo',
    ];
    const localeSort = (a: string, b: string): number => a.localeCompare(b);
    expect(Object.keys(ACCESSIBILITY_PREFERENCES_DEFAULTS).toSorted(localeSort)).toEqual(
      expectedKeys.toSorted(localeSort)
    );
  });

  it('does not contain removed keys (invert, highlightLinks, forceLeftAlign, pageStructure)', () => {
    const keys = Object.keys(ACCESSIBILITY_PREFERENCES_DEFAULTS);
    expect(keys).not.toContain('invert');
    expect(keys).not.toContain('highlightLinks');
    expect(keys).not.toContain('forceLeftAlign');
    expect(keys).not.toContain('pageStructure');
  });
});

describe('accessibilityPreferencesSchema — version', () => {
  it('accepts version: 1', () => {
    expect(() => accessibilityPreferencesSchema.parse({ version: 1 })).not.toThrow();
  });

  it('rejects version: 2', () => {
    expect(() => accessibilityPreferencesSchema.parse({ version: 2 })).toThrow();
  });

  it('rejects version: 0', () => {
    expect(() => accessibilityPreferencesSchema.parse({ version: 0 })).toThrow();
  });

  it('rejects missing version', () => {
    expect(() => accessibilityPreferencesSchema.parse({})).toThrow();
  });

  it('rejects version as string "1"', () => {
    expect(() => accessibilityPreferencesSchema.parse({ version: '1' })).toThrow();
  });
});

describe('accessibilityPreferencesSchema — full object', () => {
  it('accepts a fully-specified valid object', () => {
    const fullObject: AccessibilityPreferences = {
      version: 1,
      contrast: 'high',
      saturation: '150',
      colorblindSimulate: 'protan',
      fontSize: '141',
      letterSpacing: '0.12',
      lineHeight: '2.0',
      paragraphSpacing: '2',
      fontFamily: 'open-dyslexic',
      magnifier: true,
      readingGuide: true,
      readingHighlight: false,
      ttsEnabled: true,
      ttsVoice: 'bm_george',
      streamChatAloud: true,
      muteSounds: true,
      stopAnimations: true,
      cursorSize: 'xlarge',
      cursorColor: 'white',
      focusWidth: '6',
      focusColor: 'magenta',
      focusHalo: true,
    };
    expect(() => accessibilityPreferencesSchema.parse(fullObject)).not.toThrow();
    const parsed = accessibilityPreferencesSchema.parse(fullObject);
    expect(parsed).toEqual(fullObject);
  });

  it('fills in defaults when only version: 1 is provided', () => {
    const parsed = accessibilityPreferencesSchema.parse({ version: 1 });
    expect(parsed).toEqual(ACCESSIBILITY_PREFERENCES_DEFAULTS);
  });

  it('preserves explicitly-set values that differ from defaults', () => {
    const parsed = accessibilityPreferencesSchema.parse({
      version: 1,
      fontSize: '124',
      ttsEnabled: true,
    });
    expect(parsed.fontSize).toBe('124');
    expect(parsed.ttsEnabled).toBe(true);
    expect(parsed.contrast).toBe('normal');
    expect(parsed.fontFamily).toBe('system');
  });

  it('strips unknown / removed keys without erroring', () => {
    const parsed = accessibilityPreferencesSchema.parse({
      version: 1,
      invert: true,
      highlightLinks: true,
      forceLeftAlign: true,
      pageStructure: true,
    });
    expect(parsed).not.toHaveProperty('invert');
    expect(parsed).not.toHaveProperty('highlightLinks');
    expect(parsed).not.toHaveProperty('forceLeftAlign');
    expect(parsed).not.toHaveProperty('pageStructure');
  });
});

describe('accessibilityPreferencesSchema — enum field rejections', () => {
  it('rejects invalid contrast value', () => {
    expect(() =>
      accessibilityPreferencesSchema.parse({ version: 1, contrast: 'medium' })
    ).toThrow();
  });

  it('rejects invalid saturation value', () => {
    expect(() => accessibilityPreferencesSchema.parse({ version: 1, saturation: '200' })).toThrow();
  });

  it('rejects invalid colorblindSimulate value', () => {
    expect(() =>
      accessibilityPreferencesSchema.parse({ version: 1, colorblindSimulate: 'rainbow' })
    ).toThrow();
  });

  it('rejects invalid fontSize value', () => {
    expect(() => accessibilityPreferencesSchema.parse({ version: 1, fontSize: '300' })).toThrow();
  });

  it('rejects fontSize values from the previous scale (175, 200)', () => {
    expect(() => accessibilityPreferencesSchema.parse({ version: 1, fontSize: '175' })).toThrow();
    expect(() => accessibilityPreferencesSchema.parse({ version: 1, fontSize: '200' })).toThrow();
  });

  it('accepts the new sub-default fontSize 88', () => {
    const parsed = accessibilityPreferencesSchema.parse({ version: 1, fontSize: '88' });
    expect(parsed.fontSize).toBe('88');
  });

  it('rejects invalid letterSpacing value', () => {
    expect(() =>
      accessibilityPreferencesSchema.parse({ version: 1, letterSpacing: '0.5' })
    ).toThrow();
  });

  it('rejects invalid lineHeight value', () => {
    expect(() => accessibilityPreferencesSchema.parse({ version: 1, lineHeight: '3.0' })).toThrow();
  });

  it('rejects invalid paragraphSpacing value', () => {
    expect(() =>
      accessibilityPreferencesSchema.parse({ version: 1, paragraphSpacing: '4' })
    ).toThrow();
  });

  it('rejects invalid fontFamily value', () => {
    expect(() =>
      accessibilityPreferencesSchema.parse({ version: 1, fontFamily: 'comic-sans' })
    ).toThrow();
  });

  it('rejects invalid ttsVoice value', () => {
    expect(() =>
      accessibilityPreferencesSchema.parse({ version: 1, ttsVoice: 'cf_unknown' })
    ).toThrow();
  });

  it('rejects non-boolean stopAnimations value', () => {
    expect(() =>
      accessibilityPreferencesSchema.parse({ version: 1, stopAnimations: 'force-on' })
    ).toThrow();
  });

  it('rejects invalid cursorSize value', () => {
    expect(() =>
      accessibilityPreferencesSchema.parse({ version: 1, cursorSize: 'huge' })
    ).toThrow();
  });

  it('rejects invalid cursorColor value (system removed)', () => {
    expect(() =>
      accessibilityPreferencesSchema.parse({ version: 1, cursorColor: 'system' })
    ).toThrow();
  });

  it('rejects invalid focusWidth value', () => {
    expect(() => accessibilityPreferencesSchema.parse({ version: 1, focusWidth: '10' })).toThrow();
  });

  it('rejects invalid focusColor value', () => {
    expect(() =>
      accessibilityPreferencesSchema.parse({ version: 1, focusColor: 'orange' })
    ).toThrow();
  });
});

describe('reconcileAccessibilityPreferences', () => {
  it('returns full defaults when given an empty object', () => {
    expect(reconcileAccessibilityPreferences({})).toEqual(ACCESSIBILITY_PREFERENCES_DEFAULTS);
  });

  it('returns full defaults when given null', () => {
    expect(reconcileAccessibilityPreferences(null)).toEqual(ACCESSIBILITY_PREFERENCES_DEFAULTS);
  });

  it('returns full defaults when called with no argument', () => {
    expect(reconcileAccessibilityPreferences()).toEqual(ACCESSIBILITY_PREFERENCES_DEFAULTS);
  });

  it('returns full defaults when given a non-object (string, number, array)', () => {
    expect(reconcileAccessibilityPreferences('hello')).toEqual(ACCESSIBILITY_PREFERENCES_DEFAULTS);
    expect(reconcileAccessibilityPreferences(42)).toEqual(ACCESSIBILITY_PREFERENCES_DEFAULTS);
    expect(reconcileAccessibilityPreferences([])).toEqual(ACCESSIBILITY_PREFERENCES_DEFAULTS);
  });

  it('keeps valid fields and defaults invalid ones independently', () => {
    const result = reconcileAccessibilityPreferences({
      contrast: 'high',
      fontSize: 'huge',
      magnifier: true,
      saturation: 'rainbow',
      fontFamily: 'atkinson',
    });
    expect(result.contrast).toBe('high');
    expect(result.magnifier).toBe(true);
    expect(result.fontFamily).toBe('atkinson');
    expect(result.fontSize).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.fontSize);
    expect(result.saturation).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.saturation);
  });

  it('defaults missing fields without affecting present ones', () => {
    const result = reconcileAccessibilityPreferences({ contrast: 'low' });
    expect(result.contrast).toBe('low');
    expect(result.fontSize).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.fontSize);
    expect(result.fontFamily).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.fontFamily);
  });

  it('drops unknown / removed legacy keys', () => {
    const result = reconcileAccessibilityPreferences({
      contrast: 'high',
      legacyDeprecated: 'something',
      invert: true,
    }) as AccessibilityPreferences & Record<string, unknown>;
    expect(result.contrast).toBe('high');
    expect(result['legacyDeprecated']).toBeUndefined();
    expect(result['invert']).toBeUndefined();
  });

  it('output always satisfies the full schema', () => {
    const result = reconcileAccessibilityPreferences({
      contrast: 'high',
      fontSize: 'huge',
      garbage: true,
    });
    expect(() => accessibilityPreferencesSchema.parse(result)).not.toThrow();
  });

  it('produces every expected key on output', () => {
    const localeSort = (a: string, b: string): number => a.localeCompare(b);
    const result = reconcileAccessibilityPreferences({});
    const expectedKeys = Object.keys(ACCESSIBILITY_PREFERENCES_DEFAULTS).toSorted(localeSort);
    expect(Object.keys(result).toSorted(localeSort)).toEqual(expectedKeys);
  });
});

describe('accessibilityPreferencesSchema — boolean field validation', () => {
  const booleanFields = [
    'magnifier',
    'readingGuide',
    'readingHighlight',
    'ttsEnabled',
    'streamChatAloud',
    'muteSounds',
    'stopAnimations',
    'focusHalo',
  ] as const;

  for (const field of booleanFields) {
    describe(`field: ${field}`, () => {
      it(`accepts true`, () => {
        expect(() =>
          accessibilityPreferencesSchema.parse({ version: 1, [field]: true })
        ).not.toThrow();
        const parsed = accessibilityPreferencesSchema.parse({ version: 1, [field]: true });
        expect(parsed[field]).toBe(true);
      });

      it(`accepts false`, () => {
        expect(() =>
          accessibilityPreferencesSchema.parse({ version: 1, [field]: false })
        ).not.toThrow();
        const parsed = accessibilityPreferencesSchema.parse({ version: 1, [field]: false });
        expect(parsed[field]).toBe(false);
      });

      it(`rejects string "true"`, () => {
        expect(() =>
          accessibilityPreferencesSchema.parse({ version: 1, [field]: 'true' })
        ).toThrow();
      });

      it(`rejects number 1`, () => {
        expect(() => accessibilityPreferencesSchema.parse({ version: 1, [field]: 1 })).toThrow();
      });
    });
  }
});
