import { describe, it, expect } from 'vitest';
import { classifyPythonError, INPUT_UNSUPPORTED_MARKER } from './error-classification.js';

describe('classifyPythonError', () => {
  it('classifies a traceback carrying the input marker as input_unsupported', () => {
    const traceback = [
      'Traceback (most recent call last):',
      '  File "<exec>", line 1, in <module>',
      `RuntimeError: ${INPUT_UNSUPPORTED_MARKER}`,
    ].join('\n');
    expect(classifyPythonError(traceback)).toBe('input_unsupported');
  });

  it('classifies the marker anywhere in the text, not only at the end', () => {
    expect(classifyPythonError(`prefix ${INPUT_UNSUPPORTED_MARKER} suffix`)).toBe(
      'input_unsupported'
    );
  });

  it('classifies an ordinary traceback as python_error', () => {
    const traceback = [
      'Traceback (most recent call last):',
      '  File "<exec>", line 1, in <module>',
      'ZeroDivisionError: division by zero',
    ].join('\n');
    expect(classifyPythonError(traceback)).toBe('python_error');
  });

  it('classifies empty text as python_error', () => {
    expect(classifyPythonError('')).toBe('python_error');
  });
});
