import * as React from 'react';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { Button, Input } from '@hushbox/ui';
import { getApiUrl } from '../../lib/api-url';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface NewsletterSignupProps {
  /** Compact embed for blog/welcome footers: one-line pitch, tighter row. */
  compact?: boolean;
}

/**
 * Newsletter signup island. Every submit with a well-formed email lands on
 * the same "check your inbox" state regardless of the response, so the UI
 * can never leak whether an address is already on the list (enumeration
 * safety lives server-side; this surface stays deliberately uniform).
 */
export function NewsletterSignup({
  compact = false,
}: Readonly<NewsletterSignupProps>): React.JSX.Element {
  const [email, setEmail] = React.useState('');
  const [invalid, setInvalid] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const inputId = React.useId();
  const errorId = React.useId();

  // Runs only after hydration, so static Astro HTML never carries the signal.
  React.useEffect(() => {
    setReady(true);
  }, []);

  const readyAttribute = ready ? { [TEST_SIGNALS.newsletterReady]: 'true' } : {};

  const handleSubmit = (event: React.SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!EMAIL_PATTERN.test(email)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    // Fire and forget: the outcome must never change what the user sees.
    void (async (): Promise<void> => {
      try {
        await fetch(`${getApiUrl()}/newsletter/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
      } catch {
        // Deliberately swallowed: the success state is identical either way.
      }
    })();
    setDone(true);
  };

  if (done) {
    return (
      <div {...readyAttribute} className="w-full text-center">
        <p role="status" className="text-foreground font-serif text-lg">
          Check your inbox to confirm.
        </p>
      </div>
    );
  }

  return (
    <form
      {...readyAttribute}
      noValidate
      onSubmit={handleSubmit}
      className="mx-auto flex w-full max-w-md flex-col gap-3"
    >
      {compact && (
        <p className="text-foreground text-center font-serif text-base">Join our newsletter</p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor={inputId} className="sr-only">
          Email address
        </label>
        <Input
          id={inputId}
          data-testid={TEST_IDS.newsletterSignupInput}
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@example.com"
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? errorId : undefined}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <Button type="submit" data-testid={TEST_IDS.newsletterSignupSubmit}>
          Subscribe
        </Button>
      </div>
      {invalid && (
        <p id={errorId} role="alert" className="text-destructive text-sm">
          Please enter a valid email address.
        </p>
      )}
    </form>
  );
}
