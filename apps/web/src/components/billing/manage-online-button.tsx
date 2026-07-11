import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@hushbox/ui';
import { MARKETING_BASE_URL, ROUTES, TEST_IDS } from '@hushbox/shared';
import { unportedEndpoint } from '@/lib/unported-endpoint.js';
import { openExternalUrl } from '@/capacitor/browser';

/** Opens the billing page in the system browser with a one-time login token. */
export function ManageOnlineButton(): React.JSX.Element {
  const [isLoading, setIsLoading] = React.useState(false);

  const handleClick = async (): Promise<void> => {
    setIsLoading(true);
    try {
      // UNPORTED: the login-link route is not mounted on the rebuilt backend
      // (the domain lives in identity's billing-portal; no billing route yet).
      const { token }: { token: string } = await unportedEndpoint('POST /api/billing/login-link');
      await openExternalUrl(`${MARKETING_BASE_URL}${ROUTES.BILLING}?token=${token}`);
    } catch (error: unknown) {
      console.error('Failed to generate billing login token:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      data-testid={TEST_IDS.manageOnlineButton}
      size="lg"
      disabled={isLoading}
      onClick={() => {
        void handleClick();
      }}
    >
      <ExternalLink className="mr-2 h-4 w-4" />
      Manage Balance Online
    </Button>
  );
}
