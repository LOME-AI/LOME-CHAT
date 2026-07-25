/**
 * The opt-in arrival chime, synthesized rather than shipped as an audio file:
 * a two-note-free 120 ms tone needs no asset, no fetch, and no decode, so it
 * also works with no network.
 */
const CHIME_HZ = 880;
const CHIME_SECONDS = 0.12;
const CHIME_PEAK_GAIN = 0.06;
/** Exponential ramps cannot reach zero; this is the audible floor. */
const CHIME_FLOOR_GAIN = 0.0001;

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (!('AudioContext' in globalThis)) return null;
  context ??= new AudioContext();
  return context;
}

/**
 * Open (and un-suspend) the audio context from inside the user gesture that
 * turned sound on. Browsers only lift the autoplay block for a context touched
 * during a real interaction, so the toggle click is what makes later
 * notification chimes audible.
 */
export function primeNotificationSound(): void {
  const ctx = audioContext();
  if (ctx?.state !== 'suspended') return;
  void (async (): Promise<void> => {
    try {
      await ctx.resume();
    } catch {
      // A refused resume just leaves the app silent; sound is never the sole signal.
    }
  })();
}

export function playNotificationSound(): void {
  const ctx = audioContext();
  if (ctx === null) return;

  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.frequency.value = CHIME_HZ;
  gain.gain.setValueAtTime(CHIME_PEAK_GAIN, ctx.currentTime);
  // Ramp down instead of cutting off — an abrupt stop clicks.
  gain.gain.exponentialRampToValueAtTime(CHIME_FLOOR_GAIN, ctx.currentTime + CHIME_SECONDS);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start();
  oscillator.stop(ctx.currentTime + CHIME_SECONDS);
}

/** Test-only: drops the cached context so each test starts from a clean slate. */
export function resetNotificationSoundForTests(): void {
  context = null;
}
