import * as React from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { Button, Overlay, OverlayContent } from '@hushbox/ui';
import { useAppVersionStore } from '@/stores/app-version';
import { isNative } from '@/capacitor/platform';
import { checkForUpdate, applyUpdate } from '@/capacitor/live-update';

export function UpgradeRequiredModal(): React.JSX.Element | null {
  const upgradeRequired = useAppVersionStore((s) => s.upgradeRequired);
  const [isUpdating, setIsUpdating] = React.useState(false);

  if (!upgradeRequired) return null;

  // On native the action is an OTA update; on web it is a browser reload.
  const native = isNative();
  const actionLabel = native ? 'Update' : 'Refresh';
  const description = native
    ? 'A new version is available. Please update to continue.'
    : 'A new version is available. Please refresh to continue.';

  const handleRefresh = (): void => {
    if (!isNative()) {
      globalThis.location.reload();
      return;
    }

    setIsUpdating(true);
    void (async (): Promise<void> => {
      try {
        const result = await checkForUpdate();
        if (result.updateAvailable && result.serverVersion) {
          await applyUpdate(result.serverVersion);
        }
      } finally {
        setIsUpdating(false);
      }
    })();
  };

  return (
    <Overlay
      open={upgradeRequired}
      onOpenChange={() => {
        /* non-dismissable */
      }}
      ariaLabel="Update Required"
      showCloseButton={false}
    >
      <OverlayContent
        data-testid={TEST_IDS.upgradeRequiredModal}
        size="sm"
        className="items-center text-center"
      >
        <RefreshCw className="text-muted-foreground h-10 w-10" />
        <div>
          <h2 data-testid={TEST_IDS.upgradeRequiredTitle} className="text-lg font-semibold">
            Update Required
          </h2>
          <p
            data-testid={TEST_IDS.upgradeRequiredDescription}
            className="text-muted-foreground mt-1 text-sm"
          >
            {description}
          </p>
        </div>
        <Button
          data-testid={TEST_IDS.upgradeRequiredRefresh}
          onClick={handleRefresh}
          disabled={isUpdating}
          className="w-full"
        >
          {isUpdating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Updating...
            </>
          ) : (
            actionLabel
          )}
        </Button>
      </OverlayContent>
    </Overlay>
  );
}
