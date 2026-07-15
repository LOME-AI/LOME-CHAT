import * as React from 'react';
import { useState } from 'react';
import { createFileRoute, redirect, useNavigate, useSearch } from '@tanstack/react-router';
import { DEV_PASSWORD, displayUsername, ROUTES, TEST_ID_BUILDERS } from '@hushbox/shared';
import { toast } from '@hushbox/ui';
import { env } from '@/lib/env';
import { client, fetchJson } from '@/lib/api-client.js';
import { idempotentHeaders } from '@/lib/idempotent-mutation.js';
import { signIn, signOutAndClearCache } from '@/lib/auth';
import { useDevPersonas, type PersonaType } from '@/hooks/models/dev-personas';
import type { DevPersona } from '@hushbox/shared';

export interface PersonasSearch {
  type: string | undefined;
}

export const Route = createFileRoute('/dev/personas')({
  validateSearch: (search: Record<string, unknown>): PersonasSearch => ({
    type: typeof search['type'] === 'string' ? search['type'] : undefined,
  }),
  beforeLoad: () => {
    if (!env.isDev) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is designed to be thrown
      throw redirect({ to: ROUTES.LOGIN });
    }
  },
  component: PersonasPage,
});

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? `${String(count)} ${singular}` : `${String(count)} ${plural}`;
}

function getPersonaType(typeParameter: string | undefined): PersonaType {
  if (typeParameter === 'test') {
    return 'test';
  }
  return 'dev';
}

function PersonasPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { type: typeParameter } = useSearch({ from: '/dev/personas' });
  const personaType = getPersonaType(typeParameter);
  const [loadingPersonaId, setLoadingPersonaId] = useState<string | null>(null);
  const { data, isLoading, isError } = useDevPersonas(personaType);

  async function handlePersonaClick(persona: DevPersona): Promise<void> {
    setLoadingPersonaId(persona.id);

    try {
      // Sign out first to clear any existing session and query cache
      await signOutAndClearCache();

      const response = await signIn.email({
        identifier: persona.email,
        password: DEV_PASSWORD,
        keepSignedIn: true,
      });

      if (response.error) {
        toast.error(response.error.message);
        return;
      }

      void navigate({ to: ROUTES.CHAT });
    } catch (error) {
      console.error('Persona login failed:', error);
      toast.error('Failed to switch persona. Please try again.');
    } finally {
      setLoadingPersonaId(null);
    }
  }

  async function handleBillingPortal(e: React.MouseEvent, persona: DevPersona): Promise<void> {
    e.stopPropagation();
    setLoadingPersonaId(persona.id);

    try {
      await signOutAndClearCache();

      const loginResponse = await signIn.email({
        identifier: persona.email,
        password: DEV_PASSWORD,
        keepSignedIn: true,
      });

      if (loginResponse.error) {
        toast.error(loginResponse.error.message);
        return;
      }

      const { token } = await fetchJson<{ token: string }>(
        client.billing['login-link'].$post({}, idempotentHeaders({}))
      );
      void navigate({ to: '/billing-portal', search: { token } });
    } catch {
      toast.error('Failed to open billing portal');
    } finally {
      setLoadingPersonaId(null);
    }
  }

  const isAuthenticating = loadingPersonaId !== null;
  const title = personaType === 'test' ? 'Test Personas' : 'Developer Personas';

  if (isLoading) {
    return (
      <div className="bg-background flex min-h-full flex-col items-center justify-center p-8">
        <h1 className="text-foreground mb-8 text-3xl font-bold">{title}</h1>
        <p className="text-muted-foreground">Loading personas...</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="bg-background flex min-h-full flex-col items-center justify-center p-8">
        <h1 className="text-foreground mb-8 text-3xl font-bold">{title}</h1>
        <p className="text-destructive">Failed to load personas. Please try again.</p>
      </div>
    );
  }

  const personas = data?.personas ?? [];

  if (personas.length === 0) {
    return (
      <div className="bg-background flex min-h-full flex-col items-center justify-center p-8">
        <h1 className="text-foreground mb-8 text-3xl font-bold">{title}</h1>
        <p className="text-muted-foreground">No personas found. Run the seed script first.</p>
      </div>
    );
  }

  return (
    <div className="bg-background flex min-h-full flex-col items-center justify-center p-8">
      <h1 className="text-foreground mb-8 text-3xl font-bold">{title}</h1>

      <div className="grid gap-4 md:grid-cols-3">
        {personas.map((persona) => (
          <button
            key={persona.id}
            type="button"
            data-testid={TEST_ID_BUILDERS.personaCard(persona.email.split('@')[0] ?? '')}
            data-persona={persona.id}
            aria-busy={loadingPersonaId === persona.id}
            aria-disabled={isAuthenticating}
            onClick={() => void handlePersonaClick(persona)}
            disabled={isAuthenticating}
            className="bg-card hover:bg-accent border-border flex min-w-[240px] flex-col items-center rounded-lg border p-6 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div className="bg-primary text-primary-foreground mb-4 flex h-16 w-16 items-center justify-center rounded-full text-2xl font-bold">
              {displayUsername(persona.username).charAt(0)}
            </div>

            <span className="text-foreground mb-1 text-lg font-semibold">
              {displayUsername(persona.username)}
            </span>

            <span className="text-muted-foreground mb-3 text-sm">{persona.email}</span>

            <div className="text-muted-foreground mb-3 flex flex-wrap justify-center gap-2 text-xs">
              <span>
                {pluralize(persona.stats.conversationCount, 'conversation', 'conversations')}
              </span>
              <span>·</span>
              <span>{pluralize(persona.stats.messageCount, 'message', 'messages')}</span>
              <span>·</span>
              <span>{pluralize(persona.stats.projectCount, 'project', 'projects')}</span>
            </div>

            <span className="text-muted-foreground mb-3 text-sm font-medium">
              {persona.credits}
            </span>

            {persona.emailVerified ? (
              <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-200">
                Verified
              </span>
            ) : (
              <span className="rounded-full bg-yellow-100 px-3 py-1 text-xs font-medium text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                Unverified
              </span>
            )}

            <span
              role="button"
              tabIndex={0}
              className="text-primary mt-2 cursor-pointer text-xs hover:underline"
              onClick={(e) => void handleBillingPortal(e, persona)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation();
                  void handleBillingPortal(e as unknown as React.MouseEvent, persona);
                }
              }}
            >
              Billing Portal
            </span>

            {loadingPersonaId === persona.id && (
              <span className="text-muted-foreground mt-2 text-sm">Signing in...</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
