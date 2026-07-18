/** One recipient's delivery row joined with its send address and token. */
export interface DeliveryTarget {
  readonly deliveryId: string;
  readonly status: 'claimed' | 'sent' | 'failed';
  readonly email: string;
  readonly unsubscribeToken: string;
}

/** The atomic issue-claim disposition the dispatch handler branches on. */
export type DispatchIssueClaim =
  | { readonly kind: 'claimed'; readonly subject: string; readonly bodyMarkdown: string }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'sent' }
  | { readonly kind: 'not-due' }
  | { readonly kind: 'missing' };

/**
 * The dispatch job's single-writer store over `newsletter_issues` +
 * `newsletter_deliveries`. Every mutation is an atomic conditional statement;
 * infra failures throw (the job attempt fails and retries).
 */
export interface NewsletterDispatchStore {
  /**
   * `scheduled → sending` when due, and — in the SAME transaction — the
   * recipient freeze: the winning claim inserts one `claimed` delivery row
   * per then-subscribed recipient, so composition is immutable for the
   * issue's lifetime (a subscriber who joins mid-dispatch is simply not in
   * this issue). On 0 rows the actual state is read and classified; a row
   * already `sending` reports `claimed` too — the lease-reclaimed retry of
   * the run that owns it — and inserts nothing.
   */
  claimIssue(issueId: string, topic: string, now: Date): Promise<DispatchIssueClaim>;

  /** Every delivery row for the issue, in stable subscriber-id order. */
  loadTargets(issueId: string): Promise<DeliveryTarget[]>;

  markDeliveries(
    deliveryIds: readonly string[],
    status: 'sent' | 'failed',
    resendIdByDeliveryId?: ReadonlyMap<string, string>
  ): Promise<void>;

  /** `sending → sent` with counts aggregated from the delivery rows. */
  completeIssue(issueId: string, now: Date): Promise<void>;
}
