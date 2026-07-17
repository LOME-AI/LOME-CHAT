import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { Button, Input } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';

/** The dashboard's front-and-center user lookup: email or user id, straight
 * to Customer 360 (the same entry the palette's go-to-user offers). */
export function UserSearch({
  initialTerm,
}: Readonly<{
  /** Seeds the input (the deep-linked `?q=`) so refining never means retyping. */
  initialTerm?: string | undefined;
}> = {}): React.JSX.Element {
  const navigate = useNavigate();
  const [term, setTerm] = React.useState(initialTerm ?? '');

  function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    const q = term.trim();
    if (q === '') {
      return;
    }
    void navigate({ to: '/customer-360', search: { q } });
  }

  return (
    <form
      data-testid={TEST_IDS.adminUserSearch}
      onSubmit={handleSubmit}
      className="flex max-w-xl items-center gap-2"
    >
      <Input
        data-testid={TEST_IDS.adminUserSearchInput}
        aria-label="Find a user by email or user id"
        placeholder="Email or user id"
        autoComplete="off"
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
        }}
      />
      <Button type="submit" variant="outline">
        <Search className="mr-2 h-4 w-4" />
        Open Customer 360
      </Button>
    </form>
  );
}
