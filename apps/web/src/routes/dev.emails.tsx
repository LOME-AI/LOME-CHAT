import * as React from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ROUTES, TEST_ID_BUILDERS } from '@hushbox/shared';
import { env } from '@/lib/env';
import { unportedEndpoint } from '@/lib/unported-endpoint.js';

export const Route = createFileRoute('/dev/emails')({
  beforeLoad: () => {
    if (!env.isDev) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: ROUTES.LOGIN });
    }
  },
  component: EmailsPage,
});

interface EmailTemplate {
  name: string;
  label: string;
  html: string;
}

interface EmailsResponse {
  templates: EmailTemplate[];
}

function EmailsPage(): React.JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['dev-emails'],
    // UNPORTED: the rebuilt dev routes have no /dev/emails template preview.
    queryFn: (): Promise<EmailsResponse> => unportedEndpoint('GET /api/dev/emails'),
    enabled: env.isDev,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="bg-background flex min-h-full flex-col items-center justify-center p-8">
        <h1 className="text-foreground mb-8 text-3xl font-bold">Email Templates</h1>
        <p className="text-muted-foreground">Loading email templates...</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="bg-background flex min-h-full flex-col items-center justify-center p-8">
        <h1 className="text-foreground mb-8 text-3xl font-bold">Email Templates</h1>
        <p className="text-destructive">Failed to load email templates. Please try again.</p>
      </div>
    );
  }

  const templates = data?.templates ?? [];

  if (templates.length === 0) {
    return (
      <div className="bg-background flex min-h-full flex-col items-center justify-center p-8">
        <h1 className="text-foreground mb-8 text-3xl font-bold">Email Templates</h1>
        <p className="text-muted-foreground">No email templates found.</p>
      </div>
    );
  }

  return (
    <div className="bg-background min-h-full p-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-foreground mb-2 text-3xl font-bold">Email Templates</h1>
        <p className="text-muted-foreground mb-8 text-sm">{String(templates.length)} templates</p>

        <div className="space-y-12">
          {templates.map((template) => (
            <div key={template.name}>
              <h2 className="text-foreground mb-3 text-lg font-semibold">{template.label}</h2>
              <iframe
                data-testid={TEST_ID_BUILDERS.emailIframe(template.name)}
                title={`${template.label} email template preview`}
                srcDoc={template.html}
                sandbox=""
                className="border-border h-[600px] w-full rounded-lg border bg-white"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
