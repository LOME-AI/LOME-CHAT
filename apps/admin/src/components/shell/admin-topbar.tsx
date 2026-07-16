import * as React from 'react';
import { Search } from 'lucide-react';
import { Button, ThemeToggle } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { usePalette } from '@/components/palette/palette-provider';
import { ActorSwitcher } from './actor-switcher.js';

export function AdminTopbar(): React.JSX.Element {
  const { setOpen } = usePalette();
  return (
    <header
      data-chrome=""
      data-testid={TEST_IDS.adminTopbar}
      className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-3"
    >
      <Button
        variant="outline"
        size="sm"
        data-testid={TEST_IDS.adminSearch}
        className="text-muted-foreground w-64 justify-start"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Search className="mr-2 h-4 w-4" />
        Search
        <kbd className="bg-muted ml-auto rounded px-1.5 font-mono text-xs">⌘K</kbd>
      </Button>
      <div className="ml-auto flex items-center gap-2">
        <ActorSwitcher />
        <ThemeToggle />
      </div>
    </header>
  );
}
