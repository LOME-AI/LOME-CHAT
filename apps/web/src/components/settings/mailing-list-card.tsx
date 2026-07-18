import * as React from 'react';
import { Card, CardContent, CardDescription, CardTitle, Switch } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import {
  useNewsletterSettings,
  useUpdateNewsletterSettings,
} from '@/hooks/newsletter/use-newsletter-settings';

/**
 * The switch always renders server truth, never local state: a
 * complaint-suppressed subscriber toggling on gets {subscribed: false} back
 * and the switch settles off with no error surface — deliberate product
 * behavior, not a failure.
 */
export function MailingListCard(): React.JSX.Element {
  const settings = useNewsletterSettings();
  const update = useUpdateNewsletterSettings();

  let control: React.JSX.Element;
  if (settings.isPending) {
    control = (
      <div
        data-testid={TEST_IDS.skeletonBlock}
        className="bg-muted h-[1.15rem] w-8 shrink-0 animate-pulse rounded-full"
        aria-hidden
      />
    );
  } else if (settings.isError) {
    control = (
      <p className="text-destructive shrink-0 text-sm">
        Could not load this setting. Refresh to try again.
      </p>
    );
  } else {
    control = (
      <Switch
        data-testid={TEST_IDS.settingsMailingListToggle}
        aria-label="Mailing list"
        checked={settings.data.subscribed}
        disabled={update.isPending}
        onCheckedChange={(checked) => {
          update.mutate({ subscribed: checked });
        }}
      />
    );
  }

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 pt-6">
        <div className="space-y-1.5">
          <CardTitle className="text-brand-red">Mailing list</CardTitle>
          <CardDescription>
            A few letters a year to your account email. No tracking. Separate from account and
            billing emails.
          </CardDescription>
        </div>
        {control}
      </CardContent>
    </Card>
  );
}
