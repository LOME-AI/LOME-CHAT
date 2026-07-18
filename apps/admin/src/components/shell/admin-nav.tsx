import * as React from 'react';
import { Link } from '@tanstack/react-router';
import {
  Boxes,
  LayoutDashboard,
  ListChecks,
  Mail,
  MessageSquare,
  ScrollText,
  Terminal,
  UserRound,
  Wrench,
} from 'lucide-react';
import { Logo } from '@hushbox/ui';
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
  { to: '/feedback', label: 'Feedback', icon: MessageSquare },
  { to: '/newsletter', label: 'Newsletter', icon: Mail },
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
      // Below ~900px the sidebar is an icon rail: wordmark and labels hide
      // (sr-only), icons + title tooltips keep every screen reachable without
      // spending the narrow viewport on chrome. Mobile layout stays a
      // non-goal; this only keeps nav usable at phone widths.
      className="border-border bg-sidebar flex w-14 shrink-0 flex-col border-r min-[900px]:w-52"
    >
      <div className="border-border flex min-h-[var(--app-header-height)] items-center border-b px-3 py-2 text-sm font-semibold">
        <a
          // Admin is a separate SPA with no /chat route of its own; link out to
          // the product web app. Plain anchor, not a router Link.
          href={`${import.meta.env['VITE_WEB_URL'] as string}/chat`}
          aria-label="HushBox - Go to chat"
          className="focus-visible:ring-ring/50 rounded-md outline-none focus-visible:ring-[3px]"
        >
          {/* Icon rail: hide the shared Logo's wordmark below the breakpoint,
              mirroring the old sr-only pattern, keeping only the brand mark. */}
          <Logo className="[&>span]:sr-only min-[900px]:[&>span]:not-sr-only" />
        </a>
      </div>
      <ul className="flex flex-col gap-0.5 p-2">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <li key={to}>
            <Link
              to={to}
              title={label}
              className="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 flex items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-[3px] min-[900px]:justify-start"
              activeProps={{ className: 'bg-accent text-accent-foreground' }}
              activeOptions={{ exact: to === '/' }}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="sr-only min-[900px]:not-sr-only">{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
