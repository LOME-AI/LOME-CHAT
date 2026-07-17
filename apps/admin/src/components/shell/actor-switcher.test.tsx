import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { DEV_ADMIN_ACTORS, setDevActor } from '@/lib/dev-actor';
import { ActorSwitcher } from './actor-switcher.js';

const { envMock } = vi.hoisted(() => ({ envMock: { devAuthEnabled: true } }));
vi.mock('@/lib/env', () => ({ isDevAuthEnabled: () => envMock.devAuthEnabled }));

beforeEach(() => {
  envMock.devAuthEnabled = true;
});

afterEach(() => {
  setDevActor(DEV_ADMIN_ACTORS[0]);
});

describe('ActorSwitcher', () => {
  it('production-leak guard: renders nothing when dev auth is disabled (production shape)', () => {
    envMock.devAuthEnabled = false;
    render(<ActorSwitcher />);
    expect(screen.queryByTestId(TEST_IDS.adminActorSwitcher)).not.toBeInTheDocument();
  });

  it('renders when dev auth is enabled (local dev or E2E)', () => {
    render(<ActorSwitcher />);
    expect(screen.getByTestId(TEST_IDS.adminActorSwitcher)).toBeInTheDocument();
  });

  it('shows the current actor when enabled', () => {
    render(<ActorSwitcher />);
    expect(screen.getByTestId(TEST_IDS.adminActorSwitcher)).toHaveTextContent('admin@hushbox.test');
  });

  it('toggles to the other allowlisted actor on click', async () => {
    const user = userEvent.setup();
    render(<ActorSwitcher />);

    await user.click(screen.getByTestId(TEST_IDS.adminActorSwitcher));
    expect(screen.getByTestId(TEST_IDS.adminActorSwitcher)).toHaveTextContent('ops@hushbox.test');

    await user.click(screen.getByTestId(TEST_IDS.adminActorSwitcher));
    expect(screen.getByTestId(TEST_IDS.adminActorSwitcher)).toHaveTextContent('admin@hushbox.test');
  });
});
