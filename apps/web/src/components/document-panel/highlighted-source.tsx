import * as React from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { TEST_IDS } from '@hushbox/shared';

/** Build a fenced code block string, using a fence longer than any backtick run in content */
function buildFencedCodeBlock(content: string, language?: string): string {
  let maxRun = 0;
  let current = 0;
  for (const char of content) {
    if (char === '`') {
      current++;
      if (current > maxRun) maxRun = current;
    } else {
      current = 0;
    }
  }
  const fence = '`'.repeat(Math.max(3, maxRun + 1));
  return `${fence}${language ?? ''}\n${content}\n${fence}`;
}

/**
 * Document source under Shiki highlighting, via the same Streamdown code plugin
 * the chat transcript uses. Every place the panel shows source text goes through
 * here — the raw toggle, the pending view while a document is still arriving,
 * and the Python source beside its Run control — so a language highlights the
 * same way whichever of them is on screen.
 */
export function HighlightedSource({
  content,
  language,
}: Readonly<{ content: string; language: string | undefined }>): React.JSX.Element {
  return (
    <div data-testid={TEST_IDS.highlightedCode} className="document-panel-code">
      <Streamdown plugins={{ code }} controls={{ code: false }} animated={false}>
        {buildFencedCodeBlock(content, language)}
      </Streamdown>
    </div>
  );
}
