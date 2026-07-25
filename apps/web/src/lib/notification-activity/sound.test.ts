import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  playNotificationSound,
  primeNotificationSound,
  resetNotificationSoundForTests,
} from './sound';

interface FakeContext {
  state: AudioContextState;
  currentTime: number;
  destination: unknown;
  resume: ReturnType<typeof vi.fn>;
  createOscillator: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
}

const constructed: FakeContext[] = [];
const started: unknown[] = [];

function fakeOscillator(): unknown {
  const node = {
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(() => {
      started.push(node);
    }),
    stop: vi.fn(),
  };
  return node;
}

function fakeGain(): unknown {
  return {
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  };
}

function installWebAudio(state: AudioContextState = 'running'): void {
  class FakeAudioContext implements FakeContext {
    state = state;
    currentTime = 0;
    destination = { id: 'destination' };
    resume = vi.fn(() => {
      this.state = 'running';
      return Promise.resolve();
    });
    createOscillator = vi.fn(() => fakeOscillator());
    createGain = vi.fn(() => fakeGain());

    constructor() {
      constructed.push(this);
    }
  }
  Object.defineProperty(globalThis, 'AudioContext', {
    value: FakeAudioContext,
    configurable: true,
    writable: true,
  });
}

describe('notification sound', () => {
  beforeEach(() => {
    constructed.length = 0;
    started.length = 0;
    resetNotificationSoundForTests();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'AudioContext');
    resetNotificationSoundForTests();
  });

  it('stays silent on a platform without Web Audio', () => {
    expect(() => {
      primeNotificationSound();
      playNotificationSound();
    }).not.toThrow();
    expect(constructed).toHaveLength(0);
  });

  it('plays a tone through the audio destination', () => {
    installWebAudio();

    playNotificationSound();

    expect(started).toHaveLength(1);
    expect(constructed[0]?.createGain).toHaveBeenCalledTimes(1);
  });

  it('resumes a suspended context when the enabling gesture primes it', () => {
    installWebAudio('suspended');

    primeNotificationSound();

    expect(constructed[0]?.resume).toHaveBeenCalledTimes(1);
  });

  it('leaves a running context alone when primed', () => {
    installWebAudio('running');

    primeNotificationSound();

    expect(constructed[0]?.resume).not.toHaveBeenCalled();
  });

  it('reuses one audio context across plays', () => {
    installWebAudio();

    primeNotificationSound();
    playNotificationSound();
    playNotificationSound();

    expect(constructed).toHaveLength(1);
    expect(started).toHaveLength(2);
  });

  it('never surfaces a refused resume', async () => {
    installWebAudio('suspended');
    primeNotificationSound();
    const context = constructed[0];
    if (context === undefined) throw new Error('expected an audio context');
    context.state = 'suspended';
    context.resume.mockReturnValue(Promise.reject(new Error('gesture required')));

    expect(() => {
      primeNotificationSound();
    }).not.toThrow();
    await Promise.resolve();

    expect(context.resume).toHaveBeenCalledTimes(2);
  });
});
