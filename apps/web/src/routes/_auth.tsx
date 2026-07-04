import * as React from 'react';
import { createFileRoute, redirect, Link, Outlet } from '@tanstack/react-router';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { CipherWall, Logo } from '@hushbox/ui';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { authClient } from '@/lib/auth';

const AUTH_CIPHER_MESSAGES: readonly string[] = [
  'Encrypted By Default',
  'Only You Hold The Key',
  'Every Model, One Place',
  'Private Group Chats',
  'Zero-Knowledge Password',
  'Switch Models Anytime',
  'Your Messages, Your Control',
  'No Subscriptions Required',
  'One App, Every AI',
  'Never Lose A Conversation',
  'Stop Juggling Subscriptions',
  'Try Any Model Instantly',
  'Your Ideas Stay Yours',
  'Simple, Honest Pricing',
  'No More App Switching',
  'Built For Your Workflow',
];

export const Route = createFileRoute('/_auth')({
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (session.data) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is designed to be thrown
      throw redirect({ to: ROUTES.CHAT });
    }
  },
  component: AuthLayout,
});

function AuthLayout(): React.JSX.Element {
  return (
    <div data-testid={TEST_IDS.authLayout} className="bg-background flex min-h-full">
      <div className="relative flex flex-1 flex-col justify-center px-8 pt-14 pb-8 lg:px-16 lg:pt-0 lg:pb-0">
        <div className="absolute top-4 left-4">
          <Link to={ROUTES.CHAT} aria-label="HushBox - Go to chat">
            <Logo />
          </Link>
        </div>
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="mx-auto w-full max-w-md">
          <div className="mb-6 flex justify-center" />
          <Outlet />
        </div>
      </div>

      <div className="hidden overflow-hidden lg:block lg:flex-1">
        <CipherWall messages={AUTH_CIPHER_MESSAGES} />
      </div>
    </div>
  );
}
