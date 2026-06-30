import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installMediaPauser } from './media-pauser';

describe('installMediaPauser', () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    cleanup = undefined;
  });

  afterEach(() => {
    cleanup?.();
    document.body.innerHTML = '';
  });

  function flushMutations(): Promise<void> {
    // MutationObserver callbacks fire on a microtask. Awaiting a resolved
    // Promise yields back after the queued microtasks have run.
    return Promise.resolve();
  }

  /**
   * Spy on `.pause()` with an empty implementation. jsdom does not implement
   * the real method and prints "Not implemented: HTMLMediaElement's pause()"
   * to stderr if we let the original run; using mockImplementation keeps
   * test output pristine.
   */
  function spyPause(el: HTMLMediaElement): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(el, 'pause').mockImplementation(() => {});
  }

  it('pauses an existing autoplay <video> element on install', () => {
    const video = document.createElement('video');
    video.setAttribute('autoplay', '');
    document.body.append(video);
    const pauseSpy = spyPause(video);

    cleanup = installMediaPauser();

    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('pauses an existing autoplay <audio> element on install', () => {
    const audio = document.createElement('audio');
    audio.setAttribute('autoplay', '');
    document.body.append(audio);
    const pauseSpy = spyPause(audio);

    cleanup = installMediaPauser();

    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('removes the autoplay attribute from existing autoplay <video>', () => {
    const video = document.createElement('video');
    video.setAttribute('autoplay', '');
    document.body.append(video);
    spyPause(video);
    expect(video.hasAttribute('autoplay')).toBe(true);

    cleanup = installMediaPauser();

    expect(video.hasAttribute('autoplay')).toBe(false);
  });

  it('removes the autoplay attribute from existing autoplay <audio>', () => {
    const audio = document.createElement('audio');
    audio.setAttribute('autoplay', '');
    document.body.append(audio);
    spyPause(audio);
    expect(audio.hasAttribute('autoplay')).toBe(true);

    cleanup = installMediaPauser();

    expect(audio.hasAttribute('autoplay')).toBe(false);
  });

  it('does not touch a <video> without the autoplay attribute on install', () => {
    const video = document.createElement('video');
    document.body.append(video);
    const pauseSpy = spyPause(video);

    cleanup = installMediaPauser();

    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it('pauses a freshly inserted autoplay <video> via MutationObserver', async () => {
    cleanup = installMediaPauser();

    const video = document.createElement('video');
    video.setAttribute('autoplay', '');
    const pauseSpy = spyPause(video);
    document.body.append(video);

    await flushMutations();

    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(video.hasAttribute('autoplay')).toBe(false);
  });

  it('pauses a freshly inserted autoplay <audio> via MutationObserver', async () => {
    cleanup = installMediaPauser();

    const audio = document.createElement('audio');
    audio.setAttribute('autoplay', '');
    const pauseSpy = spyPause(audio);
    document.body.append(audio);

    await flushMutations();

    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(audio.hasAttribute('autoplay')).toBe(false);
  });

  it('pauses autoplay media nested inside a newly inserted subtree', async () => {
    cleanup = installMediaPauser();

    const wrapper = document.createElement('div');
    const video = document.createElement('video');
    video.setAttribute('autoplay', '');
    const audio = document.createElement('audio');
    audio.setAttribute('autoplay', '');
    wrapper.append(video);
    wrapper.append(audio);
    const videoSpy = spyPause(video);
    const audioSpy = spyPause(audio);
    document.body.append(wrapper);

    await flushMutations();

    expect(videoSpy).toHaveBeenCalledTimes(1);
    expect(audioSpy).toHaveBeenCalledTimes(1);
  });

  it('does not pause a freshly inserted <video> without autoplay', async () => {
    cleanup = installMediaPauser();

    const video = document.createElement('video');
    const pauseSpy = spyPause(video);
    document.body.append(video);

    await flushMutations();

    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it('ignores non-Element nodes added to the DOM', async () => {
    cleanup = installMediaPauser();

    const text = document.createTextNode('hello');
    document.body.append(text);

    await flushMutations();

    expect(text.nodeType).toBe(Node.TEXT_NODE);
  });

  it('calls endElement() on existing svg <animate> elements', () => {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    const animate = document.createElementNS(svgNs, 'animate');
    // jsdom does not implement endElement(), so attach a stub spy.
    const endSpy = vi.fn();
    (animate as unknown as { endElement: () => void }).endElement = endSpy;
    svg.append(animate);
    document.body.append(svg);

    cleanup = installMediaPauser();

    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('calls endElement() on existing svg <animateTransform> elements', () => {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    const animateTransform = document.createElementNS(svgNs, 'animateTransform');
    const endSpy = vi.fn();
    (animateTransform as unknown as { endElement: () => void }).endElement = endSpy;
    svg.append(animateTransform);
    document.body.append(svg);

    cleanup = installMediaPauser();

    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when a svg <animate> element has no endElement method', () => {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    const animate = document.createElementNS(svgNs, 'animate');
    svg.append(animate);
    document.body.append(svg);

    expect(() => {
      cleanup = installMediaPauser();
    }).not.toThrow();
  });

  it('cleanup disconnects the observer — autoplay video added after cleanup is not paused', async () => {
    cleanup = installMediaPauser();
    cleanup();
    cleanup = undefined;

    const video = document.createElement('video');
    video.setAttribute('autoplay', '');
    const pauseSpy = spyPause(video);
    document.body.append(video);

    await flushMutations();

    expect(pauseSpy).not.toHaveBeenCalled();
    expect(video.hasAttribute('autoplay')).toBe(true);
  });

  it('returns a cleanup function', () => {
    cleanup = installMediaPauser();
    expect(typeof cleanup).toBe('function');
  });

  it('handles multiple autoplay media inserted in a single tick', async () => {
    cleanup = installMediaPauser();

    const v1 = document.createElement('video');
    v1.setAttribute('autoplay', '');
    const v2 = document.createElement('video');
    v2.setAttribute('autoplay', '');
    const a1 = document.createElement('audio');
    a1.setAttribute('autoplay', '');
    const v1Spy = spyPause(v1);
    const v2Spy = spyPause(v2);
    const a1Spy = spyPause(a1);
    document.body.append(v1);
    document.body.append(v2);
    document.body.append(a1);

    await flushMutations();

    expect(v1Spy).toHaveBeenCalledTimes(1);
    expect(v2Spy).toHaveBeenCalledTimes(1);
    expect(a1Spy).toHaveBeenCalledTimes(1);
  });

  it('pauses an autoplay media element that is itself the inserted node (not nested)', async () => {
    cleanup = installMediaPauser();

    const video = document.createElement('video');
    video.setAttribute('autoplay', '');
    const pauseSpy = spyPause(video);
    // Direct insert of a media element (not wrapped in a div).
    document.body.append(video);

    await flushMutations();

    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });
});
