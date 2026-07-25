import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetNotificationSoundForTests } from '@/lib/notification-activity/sound';
import { useNotificationActivityStore } from './notification-activity';

/**
 * The slice of Web Audio the enabling gesture touches. Turning sound on has to
 * open the context inside the click, which is what lifts the autoplay block.
 */
function installSuspendedAudio(): { resume: ReturnType<typeof vi.fn> } {
  const resume = vi.fn(() => Promise.resolve());
  class FakeAudioContext {
    state: AudioContextState = 'suspended';
    resume = resume;
  }
  Object.defineProperty(globalThis, 'AudioContext', {
    value: FakeAudioContext,
    configurable: true,
    writable: true,
  });
  return { resume };
}

function beAway(): void {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
}

function beWatching(): void {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
}

describe('useNotificationActivityStore', () => {
  beforeEach(() => {
    useNotificationActivityStore.setState({ unreadCount: 0, soundEnabled: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, 'AudioContext');
    resetNotificationSoundForTests();
  });

  it('starts a session with nothing unread', () => {
    expect(useNotificationActivityStore.getState().unreadCount).toBe(0);
  });

  it('counts an event that arrives while the user is away', () => {
    beAway();

    useNotificationActivityStore.getState().recordActivity();

    expect(useNotificationActivityStore.getState().unreadCount).toBe(1);
  });

  it('accumulates every event that arrives while the user is away', () => {
    beAway();

    useNotificationActivityStore.getState().recordActivity();
    useNotificationActivityStore.getState().recordActivity();

    expect(useNotificationActivityStore.getState().unreadCount).toBe(2);
  });

  it('ignores an event that arrives while the user is watching', () => {
    beWatching();

    useNotificationActivityStore.getState().recordActivity();

    expect(useNotificationActivityStore.getState().unreadCount).toBe(0);
  });

  it('ignores an event this user authored, even while away', () => {
    beAway();

    useNotificationActivityStore.getState().recordActivity({ selfAuthored: true });

    expect(useNotificationActivityStore.getState().unreadCount).toBe(0);
  });

  it('clears the count on markAllSeen', () => {
    beAway();
    useNotificationActivityStore.getState().recordActivity();

    useNotificationActivityStore.getState().markAllSeen();

    expect(useNotificationActivityStore.getState().unreadCount).toBe(0);
  });

  it('leaves an already-clear count untouched on markAllSeen', () => {
    useNotificationActivityStore.getState().markAllSeen();

    expect(useNotificationActivityStore.getState().unreadCount).toBe(0);
  });

  it('keeps notification sound off until it is explicitly turned on', () => {
    expect(useNotificationActivityStore.getState().soundEnabled).toBe(false);

    useNotificationActivityStore.getState().setSoundEnabled(true);

    expect(useNotificationActivityStore.getState().soundEnabled).toBe(true);
  });

  it('unlocks audio playback with the gesture that turns sound on', () => {
    const { resume } = installSuspendedAudio();

    useNotificationActivityStore.getState().setSoundEnabled(true);

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('does not touch audio when sound is turned off', () => {
    const { resume } = installSuspendedAudio();

    useNotificationActivityStore.getState().setSoundEnabled(false);

    expect(resume).not.toHaveBeenCalled();
  });
});
