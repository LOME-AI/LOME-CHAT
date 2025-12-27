import * as React from 'react';
import { Sidebar } from '@/components/sidebar/sidebar';
import { MobileSidebar } from '@/components/sidebar/mobile-sidebar';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps): React.JSX.Element {
  return (
    <div data-testid="app-shell" className="bg-background flex h-screen">
      {/* Desktop sidebar */}
      <Sidebar />

      {/* Mobile sidebar overlay */}
      <MobileSidebar />

      {/* Main content area */}
      <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
