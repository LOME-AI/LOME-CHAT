import * as React from 'react';
import { useState, useEffect } from 'react';
import { z } from 'zod';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Logo } from '@hushbox/ui';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { authClient } from '@/lib/auth';
import { BillingContent } from '@/components/billing/billing-content';
import { ThemeToggle } from '@/components/shared/theme-toggle';

export interface BillingPortalSearch {
  token: string | undefined;
}

const tokenSchema = z.string();

export const Route = createFileRoute('/billing-portal')({
  validateSearch: (search: Record<string, unknown>): BillingPortalSearch => {
    const token = tokenSchema.safeParse(search['token']);
    return { token: token.success ? token.data : undefined };
  },
  component: BillingPortalPage,
});

function BillingPortalPage(): React.JSX.Element {
  const { token } = Route.useSearch();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (!token) {
      globalThis.location.href = '/login';
      return;
    }

    const validToken = token;
    async function exchangeToken(): Promise<void> {
      const result = await authClient.tokenLogin({ token: validToken });
      if (result.error) {
        setState('error');
        setErrorMessage(result.error.message);
      } else {
        setState('ready');
      }
    }

    void exchangeToken();
  }, [token]);

  if (state === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="border-primary h-8 w-8 animate-spin rounded-full border-4 border-t-transparent" />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center" data-testid={TEST_IDS.billingPortalError}>
          <h1 className="text-foreground mb-2 text-2xl font-bold">Link expired</h1>
          <p className="text-muted-foreground mb-4">{errorMessage}</p>
          <p className="text-muted-foreground text-sm">Return to the app to generate a new link.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid={TEST_IDS.billingPortal}>
      <header data-chrome="" className="flex items-center justify-between border-b px-4 py-3">
        <Link to={ROUTES.CHAT} aria-label="HushBox - Go to chat">
          <Logo />
        </Link>
        <ThemeToggle />
      </header>
      <BillingContent billingOnly />
    </div>
  );
}
