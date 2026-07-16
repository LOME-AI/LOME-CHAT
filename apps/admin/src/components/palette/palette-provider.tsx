import * as React from 'react';

interface PaletteContextValue {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}

const PaletteContext = React.createContext<PaletteContextValue | undefined>(undefined);

export function usePalette(): PaletteContextValue {
  const value = React.useContext(PaletteContext);
  if (value === undefined) {
    throw new Error('usePalette requires a PaletteProvider ancestor');
  }
  return value;
}

/** Owns palette open state and the global Cmd+K / Ctrl+K toggle. */
export function PaletteProvider({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    globalThis.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const value = React.useMemo<PaletteContextValue>(() => ({ open, setOpen }), [open]);

  return <PaletteContext value={value}>{children}</PaletteContext>;
}
