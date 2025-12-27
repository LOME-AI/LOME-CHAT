import * as React from 'react';
import { Button } from '@lome-chat/ui';
import { Menu } from 'lucide-react';
import { useUIStore } from '@/stores/ui';

/**
 * Hamburger menu button for mobile navigation.
 * Opens the mobile sidebar when clicked.
 */
export function HamburgerButton(): React.JSX.Element {
  const setMobileSidebarOpen = useUIStore((state) => state.setMobileSidebarOpen);

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => {
        setMobileSidebarOpen(true);
      }}
      className="md:hidden"
      data-testid="hamburger-button"
      aria-label="Open menu"
    >
      <Menu className="h-5 w-5" aria-hidden="true" />
    </Button>
  );
}
