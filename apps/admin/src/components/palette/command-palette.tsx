import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Dialog, DialogContent, DialogDescription, DialogTitle, Input } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { NAV_ITEMS } from '@/components/shell/admin-nav';
import { useRunOp } from '@/components/ops/op-modal-provider';
import { useOps } from '@/hooks/use-ops';
import { getRecents, pushRecent } from './recents.js';
import { usePalette } from './palette-provider.js';
import type { PaletteAction } from './recents.js';

interface PaletteItem {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly action: PaletteAction;
}

interface PaletteSection {
  readonly heading: string;
  readonly items: readonly PaletteItem[];
}

function matches(item: PaletteItem, query: string): boolean {
  const haystack = `${item.label} ${item.hint ?? ''}`.toLowerCase();
  return haystack.includes(query);
}

function buildSections(
  query: string,
  screens: readonly PaletteItem[],
  ops: readonly PaletteItem[]
): readonly PaletteSection[] {
  if (query === '') {
    const recents = getRecents().map((entry) => ({
      id: entry.id,
      label: entry.label,
      action: entry.action,
    }));
    return [
      ...(recents.length > 0 ? [{ heading: 'Recents', items: recents }] : []),
      { heading: 'Screens', items: screens },
      { heading: 'Ops', items: ops },
    ];
  }
  const screenMatches = screens.filter((item) => matches(item, query));
  const opMatches = ops.filter((item) => matches(item, query));
  const top = screenMatches[0] ?? opMatches[0];
  const goToUser: PaletteItem = {
    id: `user:${query}`,
    label: `Go to user "${query}"`,
    hint: 'full email or user id',
    action: { kind: 'user', q: query },
  };
  return [
    ...(top === undefined ? [] : [{ heading: 'Top result', items: [top] }]),
    ...sectionWithout('Screens', screenMatches, top),
    ...sectionWithout('Ops', opMatches, top),
    { heading: 'Users', items: [goToUser] },
  ];
}

function sectionWithout(
  heading: string,
  items: readonly PaletteItem[],
  top: PaletteItem | undefined
): readonly PaletteSection[] {
  const rest = items.filter((item) => item !== top);
  return rest.length > 0 ? [{ heading, items: rest }] : [];
}

/**
 * The keyboard-first launcher: screens, ops (opening the OpModal), and
 * go-to-user. Built on the Dialog primitive — focus trap, Escape, and focus
 * restore come from it; list navigation is arrows + Enter here.
 */
export function CommandPalette(): React.JSX.Element | null {
  const { open, setOpen } = usePalette();
  const navigate = useNavigate();
  const runOp = useRunOp();
  const ops = useOps({ enabled: open });
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState(0);

  const screens = React.useMemo<readonly PaletteItem[]>(
    () =>
      NAV_ITEMS.map((item) => ({
        id: `screen:${item.to}`,
        label: item.label,
        action: { kind: 'screen', to: item.to },
      })),
    []
  );
  const opItems = React.useMemo<readonly PaletteItem[]>(
    () =>
      (ops.data?.ops ?? []).map((op) => ({
        id: `op:${op.name}`,
        label: op.title,
        hint: op.name,
        action: { kind: 'op', name: op.name },
      })),
    [ops.data]
  );

  const sections = buildSections(query.trim().toLowerCase(), screens, opItems);
  const flat = sections.flatMap((section) => section.items);
  // Each section paired with its first item's flat-list index, so keyboard
  // selection and rendered options share one numbering.
  const sectionsWithOffset = sections.map((section, index) => ({
    section,
    offset: sections.slice(0, index).reduce((total, prior) => total + prior.items.length, 0),
  }));
  const selectedIndex = Math.min(selected, Math.max(flat.length - 1, 0));

  // With no trigger element, Radix only ever reports close attempts.
  function closePalette(): void {
    setOpen(false);
    setQuery('');
    setSelected(0);
  }

  function run(item: PaletteItem): void {
    pushRecent({ id: item.id, label: item.label, action: item.action });
    closePalette();
    switch (item.action.kind) {
      case 'screen': {
        void navigate({ to: item.action.to });
        break;
      }
      case 'op': {
        runOp({ opName: item.action.name });
        break;
      }
      case 'user': {
        void navigate({ to: '/customer-360', search: { q: item.action.q } });
        break;
      }
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((current) => Math.min(current + 1, flat.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = flat[selectedIndex];
      if (item !== undefined) {
        run(item);
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={() => {
        closePalette();
      }}
    >
      <DialogContent
        data-testid={TEST_IDS.adminPalette}
        showCloseButton={false}
        className="top-24 translate-y-0 gap-0 p-0"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search screens, ops, and users. Use the arrow keys and Enter.
        </DialogDescription>
        <Input
          data-testid={TEST_IDS.adminPaletteInput}
          role="combobox"
          aria-expanded={true}
          aria-controls="admin-palette-listbox"
          aria-activedescendant={`admin-palette-item-${String(selectedIndex)}`}
          aria-label="Search screens, ops, and users"
          placeholder="Search screens, ops, and users"
          autoComplete="off"
          className="rounded-b-none border-0 border-b focus-visible:ring-0"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={handleKeyDown}
        />
        <div
          id="admin-palette-listbox"
          role="listbox"
          aria-label="Palette results"
          className="max-h-80 overflow-y-auto p-1"
        >
          {sectionsWithOffset.map(({ section, offset }) => (
            <section key={section.heading} aria-label={section.heading}>
              <h3 className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium uppercase">
                {section.heading}
              </h3>
              {section.items.map((item, itemIndex) => {
                const index = offset + itemIndex;
                const isSelected = index === selectedIndex;
                return (
                  <div
                    key={`${section.heading}-${item.id}`}
                    id={`admin-palette-item-${String(index)}`}
                    data-testid={TEST_IDS.adminPaletteOption}
                    role="option"
                    aria-selected={isSelected}
                    className={`flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-sm ${
                      isSelected ? 'bg-accent text-accent-foreground' : ''
                    }`}
                    onMouseEnter={() => {
                      setSelected(index);
                    }}
                    onClick={() => {
                      run(item);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        run(item);
                      }
                    }}
                    tabIndex={-1}
                  >
                    <span>{item.label}</span>
                    {item.hint === undefined ? null : (
                      <span className="text-muted-foreground font-mono text-xs">{item.hint}</span>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
