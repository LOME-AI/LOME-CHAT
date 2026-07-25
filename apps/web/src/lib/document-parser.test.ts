import { describe, it, expect } from 'vitest';
import { MIN_LINES_FOR_DOCUMENT } from '@hushbox/shared/documents';
import {
  getLanguageDisplayName,
  getFileExtension,
  extractTitle,
  generateDocumentId,
  getDocumentType,
  isRunnableDocument,
  shouldExtractAsDocument,
} from './document-parser';

describe('getLanguageDisplayName', () => {
  it('returns proper capitalization for JavaScript', () => {
    expect(getLanguageDisplayName('javascript')).toBe('JavaScript');
  });

  it('returns proper capitalization for TypeScript', () => {
    expect(getLanguageDisplayName('typescript')).toBe('TypeScript');
  });

  it('returns acronym-style for CSS', () => {
    expect(getLanguageDisplayName('css')).toBe('CSS');
  });

  it('returns acronym-style for HTML', () => {
    expect(getLanguageDisplayName('html')).toBe('HTML');
  });

  it('returns acronym-style for JSON', () => {
    expect(getLanguageDisplayName('json')).toBe('JSON');
  });

  it('returns proper name for Python', () => {
    expect(getLanguageDisplayName('python')).toBe('Python');
  });

  it('handles special display names like C++', () => {
    expect(getLanguageDisplayName('cpp')).toBe('C++');
  });

  it('handles special display names like C#', () => {
    expect(getLanguageDisplayName('csharp')).toBe('C#');
  });

  it('capitalizes first letter for unknown languages', () => {
    expect(getLanguageDisplayName('obscurelang')).toBe('Obscurelang');
  });

  it('handles single-character languages', () => {
    expect(getLanguageDisplayName('r')).toBe('R');
    expect(getLanguageDisplayName('c')).toBe('C');
  });

  it('resolves alias js to JavaScript', () => {
    expect(getLanguageDisplayName('js')).toBe('JavaScript');
  });

  it('resolves alias ts to TypeScript', () => {
    expect(getLanguageDisplayName('ts')).toBe('TypeScript');
  });

  it('resolves alias py to Python', () => {
    expect(getLanguageDisplayName('py')).toBe('Python');
  });

  it('resolves alias objc to Objective-C', () => {
    expect(getLanguageDisplayName('objc')).toBe('Objective-C');
  });

  it('resolves hyphenated ID objective-c', () => {
    expect(getLanguageDisplayName('objective-c')).toBe('Objective-C');
  });
});

describe('getFileExtension', () => {
  it('returns js for javascript', () => {
    expect(getFileExtension('javascript')).toBe('js');
  });

  it('returns ts for typescript', () => {
    expect(getFileExtension('typescript')).toBe('ts');
  });

  it('returns py for python', () => {
    expect(getFileExtension('python')).toBe('py');
  });

  it('returns rs for rust', () => {
    expect(getFileExtension('rust')).toBe('rs');
  });

  it('returns cs for csharp (filters c# alias)', () => {
    expect(getFileExtension('csharp')).toBe('cs');
  });

  it('falls back to language ID for go', () => {
    expect(getFileExtension('go')).toBe('go');
  });

  it('falls back to language ID for java', () => {
    expect(getFileExtension('java')).toBe('java');
  });

  it('falls back to language ID lowercase for unknown', () => {
    expect(getFileExtension('UnknownLang')).toBe('unknownlang');
  });
});

describe('generateDocumentId', () => {
  it('returns string starting with doc-', () => {
    expect(generateDocumentId('hello')).toMatch(/^doc-/);
  });

  it('is deterministic for same content', () => {
    const id1 = generateDocumentId('const x = 1;');
    const id2 = generateDocumentId('const x = 1;');
    expect(id1).toBe(id2);
  });

  it('returns different IDs for different content', () => {
    const id1 = generateDocumentId('const x = 1;');
    const id2 = generateDocumentId('const y = 2;');
    expect(id1).not.toBe(id2);
  });
});

describe('getDocumentType', () => {
  it('returns mermaid for mermaid language', () => {
    expect(getDocumentType('mermaid')).toBe('mermaid');
  });

  it('returns html for html language', () => {
    expect(getDocumentType('html')).toBe('html');
  });

  it('returns react for jsx language', () => {
    expect(getDocumentType('jsx')).toBe('react');
  });

  it('returns react for tsx language', () => {
    expect(getDocumentType('tsx')).toBe('react');
  });

  it('returns js for js language', () => {
    expect(getDocumentType('js')).toBe('js');
  });

  it('returns js for javascript language', () => {
    expect(getDocumentType('javascript')).toBe('js');
  });

  it('returns python for python language', () => {
    expect(getDocumentType('python')).toBe('python');
  });

  it('returns code for other languages', () => {
    expect(getDocumentType('typescript')).toBe('code');
    expect(getDocumentType('go')).toBe('code');
  });
});

describe('isRunnableDocument', () => {
  it('is true for the runnable kinds', () => {
    expect(isRunnableDocument('html')).toBe(true);
    expect(isRunnableDocument('js')).toBe(true);
    expect(isRunnableDocument('react')).toBe(true);
    expect(isRunnableDocument('python')).toBe(true);
  });

  it('is false for code and mermaid', () => {
    expect(isRunnableDocument('code')).toBe(false);
    expect(isRunnableDocument('mermaid')).toBe(false);
  });
});

describe('shouldExtractAsDocument', () => {
  it('returns false when language is undefined', () => {
    expect(shouldExtractAsDocument(undefined, 20)).toBe(false);
  });

  it('returns true for mermaid regardless of line count', () => {
    expect(shouldExtractAsDocument('mermaid', 1)).toBe(true);
    expect(shouldExtractAsDocument('mermaid', 3)).toBe(true);
  });

  it('returns false for code with fewer than MIN_LINES_FOR_DOCUMENT lines', () => {
    expect(shouldExtractAsDocument('typescript', MIN_LINES_FOR_DOCUMENT - 1)).toBe(false);
  });

  it('returns true for code with MIN_LINES_FOR_DOCUMENT or more lines', () => {
    expect(shouldExtractAsDocument('typescript', MIN_LINES_FOR_DOCUMENT)).toBe(true);
    expect(shouldExtractAsDocument('python', MIN_LINES_FOR_DOCUMENT + 5)).toBe(true);
  });
});

describe('extractTitle', () => {
  it('returns function name from code content', () => {
    const content = 'function processData() {\n  return 1;\n}';
    expect(extractTitle(content, 'javascript', 'code')).toBe('processData');
  });

  it('returns display name when no code title found', () => {
    const content = '// just a comment\n// another comment';
    expect(extractTitle(content, 'typescript', 'code')).toBe('TypeScript');
  });

  it('returns mermaid diagram type for mermaid content', () => {
    const content = 'flowchart TD\n    A --> B';
    expect(extractTitle(content, 'mermaid', 'mermaid')).toBe('Flowchart Diagram');
  });

  it('returns class name from class definition', () => {
    const content = 'class UserService {\n  constructor() {}\n}';
    expect(extractTitle(content, 'typescript', 'code')).toBe('UserService');
  });

  it('falls back to the generic Mermaid title when the first line matches no known diagram prefix', () => {
    const content = 'timeline\n    2024 : launched';
    expect(extractTitle(content, 'mermaid', 'mermaid')).toBe('Mermaid Diagram');
  });

  it('falls back to the language display name when the first code line declares no named symbol', () => {
    // First non-comment line ("hello world") matches no CODE_PATTERN, so
    // extractCodeTitle breaks out and returns null.
    const content = 'hello world\nsecond line';
    expect(extractTitle(content, 'plaintext', 'code')).toBe(getLanguageDisplayName('plaintext'));
  });
});
