import * as React from 'react';
import { UserRoundCog } from 'lucide-react';
import { Button } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { isDevAuthEnabled } from '@/lib/env';
import { DEV_ADMIN_ACTORS, setDevActor, useDevActor } from '@/lib/dev-actor';

function ActorSwitcherButton(): React.JSX.Element {
  const actor = useDevActor();
  const nextActor = actor === DEV_ADMIN_ACTORS[0] ? DEV_ADMIN_ACTORS[1] : DEV_ADMIN_ACTORS[0];

  return (
    <Button
      variant="outline"
      size="sm"
      className="font-mono text-xs"
      title="Dev actor — click to switch identity"
      data-testid={TEST_IDS.adminActorSwitcher}
      onClick={() => {
        setDevActor(nextActor);
      }}
    >
      <UserRoundCog className="mr-2 h-4 w-4" />
      {actor}
    </Button>
  );
}

/**
 * Dev/E2E-only control showing the identity the dev-auth wrapper mints tokens
 * for; clicking swaps to the other allowlisted dev actor (the wrapper's
 * per-actor cache re-mints on the next request). Renders nothing in
 * production, where Cloudflare Access supplies the identity at the edge.
 */
export function ActorSwitcher(): React.JSX.Element | null {
  if (!isDevAuthEnabled()) {
    return null;
  }
  return <ActorSwitcherButton />;
}
