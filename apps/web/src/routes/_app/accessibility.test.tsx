import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { Route } from './accessibility';

// The panel's internals are out of scope for this route, and its subpath pulls
// the speech engine, so the whole subpath is replaced. The provider stack that
// renderRoute mounts comes from `@hushbox/ui/accessibility`, a different module,
// and stays real.
vi.mock('@hushbox/ui/accessibility/panel', () => ({
  AccessibilityPanel: (): React.JSX.Element => (
    <section data-testid="accessibility-panel-mock">Panel</section>
  ),
}));

describe('/accessibility route', () => {
  it('renders the PageHeader with title "Accessibility"', () => {
    renderRoute(Route);
    expect(screen.getByText('Accessibility')).toBeInTheDocument();
  });

  it('renders the ThemeToggle in the header right slot', () => {
    renderRoute(Route);
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('renders the AccessibilityPanel below the header', () => {
    renderRoute(Route);
    expect(screen.getByTestId('accessibility-panel-mock')).toBeInTheDocument();
  });
});
