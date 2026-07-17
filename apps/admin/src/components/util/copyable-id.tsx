import * as React from 'react';
import { Copy } from 'lucide-react';
import { IconButton } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';

interface CopyableIdProps {
  readonly value: string;
  /** What is being copied, for the button's accessible name. */
  readonly label: string;
}

/** Density convention: monospace id with a copy button beside it. */
export function CopyableId({ value, label }: CopyableIdProps): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1">
      {/* nowrap, never break-all: a wrapped uuid reads as two ids; wide tables
          scroll in their own containers instead. */}
      <span title={value} className="font-mono text-xs whitespace-nowrap">
        {value}
      </span>
      <IconButton
        data-testid={TEST_IDS.adminCopyId}
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard.writeText(value);
        }}
      >
        <Copy className="h-3.5 w-3.5" />
      </IconButton>
    </span>
  );
}
