import { describe, expect, it } from 'vitest';
import { mediaTag, textTag } from '@hushbox/shared';
import { deriveModelPorts } from './model-ports.js';
import type { Modality, ModelDescriptor } from '@hushbox/shared';

function descriptorWith(
  inputs: readonly Modality[],
  outputs: readonly Modality[]
): ModelDescriptor {
  return {
    id: 'model',
    provider: 'p',
    version: '1',
    inputs: [...inputs],
    outputs: [...outputs],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: {},
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

describe('deriveModelPorts', () => {
  it('derives text -> text as a single text input and text output port', () => {
    const ports = deriveModelPorts(descriptorWith(['text'], ['text']));
    expect(ports._unsafeUnwrap()).toEqual({ in: [textTag()], out: textTag() });
  });

  it('derives text -> image with the default image mime allowlist', () => {
    const ports = deriveModelPorts(descriptorWith(['text'], ['image']));
    expect(ports._unsafeUnwrap()).toEqual({
      in: [textTag()],
      out: mediaTag('image', ['image/png', 'image/jpeg', 'image/webp']),
    });
  });

  it('derives text -> video with the default video mime allowlist', () => {
    const ports = deriveModelPorts(descriptorWith(['text'], ['video']));
    expect(ports._unsafeUnwrap()).toEqual({
      in: [textTag()],
      out: mediaTag('video', ['video/mp4', 'video/webm']),
    });
  });

  it('binds a multimodal (text+image) input to a text input port and text output', () => {
    const ports = deriveModelPorts(descriptorWith(['text', 'image'], ['text']));
    expect(ports._unsafeUnwrap()).toEqual({ in: [textTag()], out: textTag() });
  });

  it('binds a multimodal (text+image) input with a video output to text-in, video-out', () => {
    const ports = deriveModelPorts(descriptorWith(['text', 'image'], ['video']));
    expect(ports._unsafeUnwrap()).toEqual({
      in: [textTag()],
      out: mediaTag('video', ['video/mp4', 'video/webm']),
    });
  });

  it('fails closed on an audio output — not a runnable model shape', () => {
    expect(deriveModelPorts(descriptorWith(['text'], ['audio'])).isErr()).toBe(true);
  });

  it('fails closed on an embedding output — not a runnable model shape', () => {
    expect(deriveModelPorts(descriptorWith(['text'], ['embedding'])).isErr()).toBe(true);
  });

  it('fails closed on a no-text input — not a runnable model shape', () => {
    expect(deriveModelPorts(descriptorWith(['image'], ['image'])).isErr()).toBe(true);
  });

  it('fails closed on an embedding-only input — no text input to send', () => {
    expect(deriveModelPorts(descriptorWith(['embedding'], ['text'])).isErr()).toBe(true);
  });

  it('fails closed on a multi-modality output — a single port has no union', () => {
    expect(deriveModelPorts(descriptorWith(['text'], ['text', 'image'])).isErr()).toBe(true);
  });

  it('fails closed when a side declares no modality', () => {
    expect(deriveModelPorts(descriptorWith([], ['text'])).isErr()).toBe(true);
  });
});
