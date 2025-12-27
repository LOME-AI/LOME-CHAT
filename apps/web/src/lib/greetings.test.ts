import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getGreeting } from './greetings';

describe('getGreeting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // Always select first greeting
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('when not authenticated', () => {
    it('returns a greeting with title and subtitle', () => {
      const greeting = getGreeting(false);
      expect(greeting).toHaveProperty('title');
      expect(greeting).toHaveProperty('subtitle');
      expect(typeof greeting.title).toBe('string');
      expect(typeof greeting.subtitle).toBe('string');
    });

    it('returns welcome-themed greeting', () => {
      const greeting = getGreeting(false);
      // Check it contains welcome-related words
      const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
      expect(
        combinedText.includes('welcome') ||
          combinedText.includes('ready') ||
          combinedText.includes('journey') ||
          combinedText.includes('start')
      ).toBe(true);
    });
  });

  describe('when authenticated', () => {
    describe('morning (5 AM - 11:59 AM)', () => {
      it('returns morning greeting at 6 AM', () => {
        vi.setSystemTime(new Date('2024-01-01T06:00:00'));
        const greeting = getGreeting(true);
        expect(greeting).toHaveProperty('title');
        expect(greeting).toHaveProperty('subtitle');
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('morning') ||
            combinedText.includes('rise') ||
            combinedText.includes('dawn') ||
            combinedText.includes('early')
        ).toBe(true);
      });

      it('returns morning greeting at 11 AM', () => {
        vi.setSystemTime(new Date('2024-01-01T11:00:00'));
        const greeting = getGreeting(true);
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('morning') ||
            combinedText.includes('rise') ||
            combinedText.includes('dawn') ||
            combinedText.includes('early')
        ).toBe(true);
      });
    });

    describe('afternoon (12 PM - 4:59 PM)', () => {
      it('returns afternoon greeting at 2 PM', () => {
        vi.setSystemTime(new Date('2024-01-01T14:00:00'));
        const greeting = getGreeting(true);
        expect(greeting).toHaveProperty('title');
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('afternoon') ||
            combinedText.includes('midday') ||
            combinedText.includes('daydream')
        ).toBe(true);
      });

      it('returns afternoon greeting at 4 PM', () => {
        vi.setSystemTime(new Date('2024-01-01T16:00:00'));
        const greeting = getGreeting(true);
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('afternoon') ||
            combinedText.includes('midday') ||
            combinedText.includes('daydream')
        ).toBe(true);
      });
    });

    describe('evening (5 PM - 8:59 PM)', () => {
      it('returns evening greeting at 6 PM', () => {
        vi.setSystemTime(new Date('2024-01-01T18:00:00'));
        const greeting = getGreeting(true);
        expect(greeting).toHaveProperty('title');
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('evening') ||
            combinedText.includes('sunset') ||
            combinedText.includes('twilight')
        ).toBe(true);
      });

      it('returns evening greeting at 8 PM', () => {
        vi.setSystemTime(new Date('2024-01-01T20:00:00'));
        const greeting = getGreeting(true);
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('evening') ||
            combinedText.includes('sunset') ||
            combinedText.includes('twilight')
        ).toBe(true);
      });
    });

    describe('night (9 PM - 4:59 AM)', () => {
      it('returns night greeting at 10 PM', () => {
        vi.setSystemTime(new Date('2024-01-01T22:00:00'));
        const greeting = getGreeting(true);
        expect(greeting).toHaveProperty('title');
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('night') ||
            combinedText.includes('midnight') ||
            combinedText.includes('moon') ||
            combinedText.includes('star') ||
            combinedText.includes('nocturnal')
        ).toBe(true);
      });

      it('returns night greeting at 2 AM', () => {
        vi.setSystemTime(new Date('2024-01-01T02:00:00'));
        const greeting = getGreeting(true);
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('night') ||
            combinedText.includes('midnight') ||
            combinedText.includes('moon') ||
            combinedText.includes('star') ||
            combinedText.includes('nocturnal')
        ).toBe(true);
      });
    });
  });

  describe('boundary conditions', () => {
    it('5 AM is morning', () => {
      vi.setSystemTime(new Date('2024-01-01T05:00:00'));
      const greeting = getGreeting(true);
      const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
      expect(
        combinedText.includes('morning') ||
          combinedText.includes('rise') ||
          combinedText.includes('dawn') ||
          combinedText.includes('early')
      ).toBe(true);
    });

    it('12 PM is afternoon', () => {
      vi.setSystemTime(new Date('2024-01-01T12:00:00'));
      const greeting = getGreeting(true);
      const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
      expect(
        combinedText.includes('afternoon') ||
          combinedText.includes('midday') ||
          combinedText.includes('daydream')
      ).toBe(true);
    });

    it('5 PM is evening', () => {
      vi.setSystemTime(new Date('2024-01-01T17:00:00'));
      const greeting = getGreeting(true);
      const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
      expect(
        combinedText.includes('evening') ||
          combinedText.includes('sunset') ||
          combinedText.includes('twilight')
      ).toBe(true);
    });

    it('9 PM is night', () => {
      vi.setSystemTime(new Date('2024-01-01T21:00:00'));
      const greeting = getGreeting(true);
      const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
      expect(
        combinedText.includes('night') ||
          combinedText.includes('midnight') ||
          combinedText.includes('moon') ||
          combinedText.includes('star') ||
          combinedText.includes('nocturnal')
      ).toBe(true);
    });
  });
});
