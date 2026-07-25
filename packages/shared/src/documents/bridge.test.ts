import { describe, it, expect } from 'vitest';
import type { DocumentErrorCode, LoadingPhase, ConsoleStream } from './bridge.js';
import {
  RUNNABLE_DOCUMENT_KINDS,
  RunnableDocumentKind,
  DOCUMENT_ERROR_CODES,
  LOADING_PHASES,
  CONSOLE_STREAMS,
  ResultOutput,
  InitMessage,
  RunMessage,
  StopMessage,
  ParentToFrameMessage,
  ReadyMessage,
  RenderedMessage,
  ConsoleMessage,
  ResultMessage,
  ErrorMessage,
  LoadingMessage,
  FrameToParentMessage,
  parseParentToFrameMessage,
  parseFrameToParentMessage,
} from './bridge.js';

describe('RunnableDocumentKind', () => {
  it('accepts each runnable kind', () => {
    for (const kind of RUNNABLE_DOCUMENT_KINDS) {
      expect(RunnableDocumentKind.parse(kind)).toBe(kind);
    }
  });

  it('rejects a non-runnable kind (mermaid stays outside the bridge)', () => {
    expect(RunnableDocumentKind.safeParse('mermaid').success).toBe(false);
  });
});

describe('parent→frame: init', () => {
  it('round-trips a valid init message', () => {
    const msg = { type: 'init', kind: 'react', code: 'export default () => null', requestId: 'r1' };
    expect(InitMessage.parse(msg)).toEqual(msg);
  });

  it('rejects init with an unknown kind', () => {
    const parsed = InitMessage.safeParse({
      type: 'init',
      kind: 'ruby',
      code: 'x',
      requestId: 'r1',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects init with an empty requestId', () => {
    const parsed = InitMessage.safeParse({ type: 'init', kind: 'html', code: 'x', requestId: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects init missing the code field', () => {
    const parsed = InitMessage.safeParse({ type: 'init', kind: 'html', requestId: 'r1' });
    expect(parsed.success).toBe(false);
  });
});

describe('parent→frame: run and stop', () => {
  it('round-trips run', () => {
    expect(RunMessage.parse({ type: 'run', requestId: 'r2' })).toEqual({
      type: 'run',
      requestId: 'r2',
    });
  });

  it('round-trips stop', () => {
    expect(StopMessage.parse({ type: 'stop', requestId: 'r3' })).toEqual({
      type: 'stop',
      requestId: 'r3',
    });
  });
});

describe('ParentToFrameMessage union', () => {
  it('discriminates init, run, and stop', () => {
    expect(
      ParentToFrameMessage.parse({ type: 'init', kind: 'js', code: 'x', requestId: 'a' }).type
    ).toBe('init');
    expect(ParentToFrameMessage.parse({ type: 'run', requestId: 'a' }).type).toBe('run');
    expect(ParentToFrameMessage.parse({ type: 'stop', requestId: 'a' }).type).toBe('stop');
  });

  it('rejects a frame→parent message shape', () => {
    expect(ParentToFrameMessage.safeParse({ type: 'ready' }).success).toBe(false);
  });

  it('rejects a non-object payload', () => {
    expect(ParentToFrameMessage.safeParse('nope').success).toBe(false);
    expect(ParentToFrameMessage.safeParse(null).success).toBe(false);
  });
});

describe('frame→parent messages', () => {
  it('round-trips ready (no requestId — sent once on load)', () => {
    expect(ReadyMessage.parse({ type: 'ready' })).toEqual({ type: 'ready' });
  });

  it('round-trips rendered', () => {
    expect(RenderedMessage.parse({ type: 'rendered', requestId: 'r' })).toEqual({
      type: 'rendered',
      requestId: 'r',
    });
  });

  it('round-trips a stdout console line', () => {
    const msg = { type: 'console', requestId: 'r', stream: 'stdout', text: 'hi' };
    expect(ConsoleMessage.parse(msg)).toEqual(msg);
  });

  it('rejects a console line with an unknown stream', () => {
    expect(
      ConsoleMessage.safeParse({ type: 'console', requestId: 'r', stream: 'log', text: 'hi' })
        .success
    ).toBe(false);
  });

  it('round-trips a result with png and text outputs', () => {
    const msg = {
      type: 'result',
      requestId: 'r',
      outputs: [
        { type: 'image/png', data: 'base64==' },
        { type: 'text', data: 'done' },
      ],
    };
    expect(ResultMessage.parse(msg)).toEqual(msg);
  });

  it('rejects a result output with an unknown type', () => {
    expect(ResultOutput.safeParse({ type: 'image/jpeg', data: 'x' }).success).toBe(false);
  });

  it('round-trips an error with a closed code', () => {
    const msg = { type: 'error', requestId: 'r', code: 'transpile_failed', message: 'bad jsx' };
    expect(ErrorMessage.parse(msg)).toEqual(msg);
  });

  it('rejects an error with an unknown code', () => {
    expect(
      ErrorMessage.safeParse({ type: 'error', requestId: 'r', code: 'kaboom', message: 'x' })
        .success
    ).toBe(false);
  });

  it('round-trips a loading phase', () => {
    const msg = { type: 'loading', requestId: 'r', phase: 'transpiling' };
    expect(LoadingMessage.parse(msg)).toEqual(msg);
  });

  it('rejects a loading message with an unknown phase', () => {
    expect(
      LoadingMessage.safeParse({ type: 'loading', requestId: 'r', phase: 'warp' }).success
    ).toBe(false);
  });
});

describe('FrameToParentMessage union', () => {
  it('discriminates every frame→parent variant', () => {
    expect(FrameToParentMessage.parse({ type: 'ready' }).type).toBe('ready');
    expect(FrameToParentMessage.parse({ type: 'rendered', requestId: 'r' }).type).toBe('rendered');
    expect(
      FrameToParentMessage.parse({ type: 'console', requestId: 'r', stream: 'stderr', text: 'e' })
        .type
    ).toBe('console');
    expect(FrameToParentMessage.parse({ type: 'result', requestId: 'r', outputs: [] }).type).toBe(
      'result'
    );
    expect(
      FrameToParentMessage.parse({
        type: 'error',
        requestId: 'r',
        code: 'import_failed',
        message: 'm',
      }).type
    ).toBe('error');
    expect(
      FrameToParentMessage.parse({ type: 'loading', requestId: 'r', phase: 'executing' }).type
    ).toBe('loading');
  });

  it('rejects a parent→frame message shape', () => {
    expect(
      FrameToParentMessage.safeParse({ type: 'init', kind: 'html', code: 'x', requestId: 'r' })
        .success
    ).toBe(false);
  });
});

describe('parse helpers', () => {
  it('parseParentToFrameMessage returns a typed success for a valid message', () => {
    const result = parseParentToFrameMessage({ type: 'run', requestId: 'r' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.requestId).toBe('r');
  });

  it('parseParentToFrameMessage returns failure (never throws) for garbage', () => {
    expect(parseParentToFrameMessage(42).success).toBe(false);
  });

  it('parseFrameToParentMessage returns a typed success for a valid message', () => {
    const result = parseFrameToParentMessage({ type: 'ready' });
    expect(result.success).toBe(true);
  });

  it('parseFrameToParentMessage returns failure (never throws) for garbage', () => {
    expect(parseFrameToParentMessage(null).success).toBe(false);
  });
});

describe('exhaustive constant sets', () => {
  it('exposes the closed constant tuples the UI switches over', () => {
    expect(RUNNABLE_DOCUMENT_KINDS).toEqual(['html', 'js', 'react', 'python']);
    expect(CONSOLE_STREAMS).toEqual(['stdout', 'stderr']);
    expect(LOADING_PHASES.length).toBeGreaterThan(0);
    expect(DOCUMENT_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it('derives enum types from the tuples', () => {
    const kind: RunnableDocumentKind = 'python';
    const stream: ConsoleStream = 'stderr';
    const phase: LoadingPhase = LOADING_PHASES[0];
    const code: DocumentErrorCode = DOCUMENT_ERROR_CODES[0];
    expect([kind, stream, phase, code]).toHaveLength(4);
  });
});
