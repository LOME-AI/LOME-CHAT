import { describe, it, expect } from 'vitest';

import { normalizeForSpeech } from './text-normalizer';

describe('normalizeForSpeech', () => {
  describe('emphasis markers', () => {
    it('strips bold double-asterisks', () => {
      expect(normalizeForSpeech('**bold**')).toBe('bold');
    });

    it('strips bold double-underscores', () => {
      expect(normalizeForSpeech('__bold__')).toBe('bold');
    });

    it('strips italic single asterisks around a word', () => {
      expect(normalizeForSpeech('*italic*')).toBe('italic');
    });

    it('strips italic single underscores around a word', () => {
      expect(normalizeForSpeech('_italic_')).toBe('italic');
    });

    it('strips bold-italic triple asterisks', () => {
      expect(normalizeForSpeech('***bold italic***')).toBe('bold italic');
    });

    it('strips nested bold inside a sentence', () => {
      expect(normalizeForSpeech('hello **world** today')).toBe('hello world today');
    });

    it('strips strikethrough double tildes', () => {
      expect(normalizeForSpeech('~~struck~~')).toBe('struck');
    });

    it('passes a lone asterisk through unchanged when there is no closing marker', () => {
      expect(normalizeForSpeech('a*b')).toBe('a*b');
    });

    it('passes a lone underscore through unchanged when there is no closing marker', () => {
      expect(normalizeForSpeech('snake_case_word')).toBe('snake_case_word');
    });
  });

  describe('code', () => {
    it('strips inline code backticks but keeps the inner text', () => {
      expect(normalizeForSpeech('use `npm install` to install')).toBe('use npm install to install');
    });

    it('drops fenced code blocks entirely', () => {
      expect(normalizeForSpeech('before ```js\nconsole.log()\n``` after')).toBe('before after');
    });

    it('keeps an orphan backtick when it has no closing pair', () => {
      expect(normalizeForSpeech('pretend `unfinished')).toBe('pretend `unfinished');
    });
  });

  describe('headings', () => {
    it('strips a leading hash and space from a heading line', () => {
      expect(normalizeForSpeech('# Title')).toBe('Title');
    });

    it('strips multiple leading hashes from sub-headings', () => {
      expect(normalizeForSpeech('### Section')).toBe('Section');
    });

    it('does not strip a hash that is mid-line', () => {
      expect(normalizeForSpeech('issue #123 fixed')).toBe('issue #123 fixed');
    });

    it('handles a heading after a newline', () => {
      expect(normalizeForSpeech('intro\n## Sub\nbody')).toBe('intro\nSub\nbody');
    });
  });

  describe('lists', () => {
    it('strips a leading dash marker from a bulleted list item', () => {
      expect(normalizeForSpeech('- item')).toBe('item');
    });

    it('strips a leading asterisk marker from a bulleted list item', () => {
      expect(normalizeForSpeech('* item')).toBe('item');
    });

    it('strips a leading plus marker from a bulleted list item', () => {
      expect(normalizeForSpeech('+ item')).toBe('item');
    });

    it('strips a numbered list marker', () => {
      expect(normalizeForSpeech('1. first item')).toBe('first item');
    });

    it('handles multi-digit numbered list markers', () => {
      expect(normalizeForSpeech('10. tenth item')).toBe('tenth item');
    });

    it('does not strip a dash inside a word', () => {
      expect(normalizeForSpeech('well-known fact')).toBe('well-known fact');
    });

    it('strips bullet markers across multiple lines', () => {
      expect(normalizeForSpeech('- one\n- two\n- three')).toBe('one\ntwo\nthree');
    });
  });

  describe('blockquotes', () => {
    it('strips a leading > from a blockquote line', () => {
      expect(normalizeForSpeech('> quoted text')).toBe('quoted text');
    });

    it('strips > across multiple blockquote lines', () => {
      expect(normalizeForSpeech('> line one\n> line two')).toBe('line one\nline two');
    });
  });

  describe('horizontal rules', () => {
    it('drops a line that is only three dashes', () => {
      expect(normalizeForSpeech('above\n---\nbelow')).toBe('above\nbelow');
    });

    it('drops a line that is only three asterisks', () => {
      expect(normalizeForSpeech('above\n***\nbelow')).toBe('above\nbelow');
    });

    it('drops a line that is only three underscores', () => {
      expect(normalizeForSpeech('above\n___\nbelow')).toBe('above\nbelow');
    });
  });

  describe('links and images', () => {
    it('keeps the label only for a markdown link', () => {
      expect(normalizeForSpeech('Visit [hello](http://example.com) now')).toBe('Visit hello now');
    });

    it('keeps the alt text only for an image', () => {
      expect(normalizeForSpeech('See ![diagram](/img.png) above')).toBe('See diagram above');
    });

    it('drops the image entirely when alt text is empty', () => {
      expect(normalizeForSpeech('hello ![](/img.png) world')).toBe('hello world');
    });
  });

  describe('html', () => {
    it('strips simple html tags', () => {
      expect(normalizeForSpeech('a <br> b')).toBe('a b');
    });

    it('strips html tags with attributes', () => {
      expect(normalizeForSpeech('a <span class="x">text</span> b')).toBe('a text b');
    });
  });

  describe('raw urls', () => {
    it('replaces a bare http url with the word link', () => {
      expect(normalizeForSpeech('go to https://example.com today')).toBe('go to link today');
    });

    it('replaces a bare http url with the word link', () => {
      expect(normalizeForSpeech('go to http://example.com today')).toBe('go to link today');
    });
  });

  describe('tables', () => {
    it('strips pipes and joins cells with commas', () => {
      expect(normalizeForSpeech('| a | b | c |')).toBe('a, b, c');
    });

    it('drops a table separator row of dashes and pipes', () => {
      expect(normalizeForSpeech('| h1 | h2 |\n|----|----|\n| v1 | v2 |')).toBe('h1, h2\nv1, v2');
    });
  });

  describe('whitespace', () => {
    it('collapses multiple spaces to a single space', () => {
      expect(normalizeForSpeech('a    b')).toBe('a b');
    });

    it('preserves newlines as boundaries', () => {
      expect(normalizeForSpeech('a\nb')).toBe('a\nb');
    });
  });

  describe('combinations', () => {
    it('strips bold inside a sentence with terminal punctuation', () => {
      expect(normalizeForSpeech('**Hello.** World.')).toBe('Hello. World.');
    });

    it('handles a list of bolded items', () => {
      expect(normalizeForSpeech('- **First** item\n- **Second** item')).toBe(
        'First item\nSecond item'
      );
    });

    it('handles a heading containing a link', () => {
      expect(normalizeForSpeech('# [Title](http://x.com)')).toBe('Title');
    });

    it('is idempotent — normalizing twice gives the same result', () => {
      const input = '## **Heading** with `code` and [link](http://x.com).';
      expect(normalizeForSpeech(normalizeForSpeech(input))).toBe(normalizeForSpeech(input));
    });
  });

  describe('structural edge cases', () => {
    it('renders a blockquote wrapping a horizontal rule as an empty line', () => {
      expect(normalizeForSpeech('> ---')).toBe('');
    });

    it('drops a table row whose cells are all empty', () => {
      expect(normalizeForSpeech('|  |  |')).toBe('');
    });

    it('reduces a whitespace-only line to nothing', () => {
      expect(normalizeForSpeech('First.\n \nSecond.')).toBe('First.\n\nSecond.');
    });

    it('collapses interior runs but preserves single edge spaces around text', () => {
      expect(normalizeForSpeech('   spaced   ')).toBe(' spaced ');
    });
  });
});
