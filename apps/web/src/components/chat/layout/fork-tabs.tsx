import * as React from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { cn, DropdownMenuItem } from '@hushbox/ui';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { ItemRow } from '@/components/shared/item-row';

interface Fork {
  id: string;
  name: string;
  tipMessageId: string | null;
  createdAt: string;
}

interface ForkTabsProps {
  forks: Fork[];
  activeForkId: string | null;
  onForkSelect: (forkId: string) => void;
  onRename: (forkId: string, currentName: string) => void;
  onDelete: (forkId: string) => void;
}

export function ForkTabs({
  forks,
  activeForkId,
  onForkSelect,
  onRename,
  onDelete,
}: Readonly<ForkTabsProps>): React.JSX.Element | null {
  if (forks.length < 2) return null;

  return (
    <div
      role="tablist"
      aria-label="Conversation forks"
      data-chrome=""
      className="border-border flex gap-1 overflow-x-auto border-b px-2 py-1"
    >
      {forks.map((fork) => {
        const isActive = fork.id === activeForkId;
        return (
          <ItemRow
            key={fork.id}
            data-testid={TEST_ID_BUILDERS.forkTab(fork.id)}
            className={cn(
              'shrink-0',
              '[&:hover:not(:has([data-menu-trigger]:hover))]:bg-muted',
              isActive && 'bg-accent text-accent-foreground',
              !isActive && 'text-muted-foreground'
            )}
            menuProps={{ align: 'start' }}
            menuContent={
              <>
                <DropdownMenuItem
                  onSelect={() => {
                    onRename(fork.id, fork.name);
                  }}
                >
                  <Pencil />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    onDelete(fork.id);
                  }}
                  className="text-destructive"
                >
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </>
            }
          >
            <button
              role="tab"
              type="button"
              aria-selected={isActive}
              className="cursor-pointer px-3 py-1.5 text-sm font-medium"
              onClick={() => {
                if (!isActive) onForkSelect(fork.id);
              }}
            >
              {fork.name}
            </button>
          </ItemRow>
        );
      })}
    </div>
  );
}
