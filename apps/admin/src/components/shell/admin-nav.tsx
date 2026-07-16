import * as React from 'react';
import { Link } from '@tanstack/react-router';
import {
  Boxes,
  LayoutDashboard,
  ListChecks,
  ScrollText,
  Terminal,
  UserRound,
  Wrench,
} from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';

export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
}

/** The screen list — also the command palette's Screens group. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/customer-360', label: 'Customer 360', icon: UserRound },
  { to: '/jobs', label: 'Jobs', icon: ListChecks },
  { to: '/audit', label: 'Audit trail', icon: ScrollText },
  { to: '/models', label: 'Models', icon: Boxes },
  { to: '/sql', label: 'SQL panel', icon: Terminal },
  { to: '/ops', label: 'Ops catalog', icon: Wrench },
];

export function AdminNav(): React.JSX.Element {
  return (
    <nav
      data-chrome=""
      data-testid={TEST_IDS.adminNav}
      className="border-border bg-sidebar flex w-52 shrink-0 flex-col border-r"
    >
      <div className="border-border border-b px-3 py-3 text-sm font-semibold">HushBox Admin</div>
      <ul className="flex flex-col gap-0.5 p-2">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <li key={to}>
            <Link
              to={to}
              className="text-muted-foreground hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
              activeProps={{ className: 'bg-accent text-accent-foreground' }}
              activeOptions={{ exact: to === '/' }}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
