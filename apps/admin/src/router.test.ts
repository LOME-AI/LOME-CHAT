import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import * as React from 'react';
import { router } from './router.js';
import { queryClient } from './providers/query-provider.js';

describe('router', () => {
  it('is constructed from the generated route tree', () => {
    expect(router.routeTree).toBeDefined();
  });

  it('carries the shared query client in context', () => {
    expect(router.options.context).toEqual({ queryClient });
  });

  it('degrades an uncaught route render throw to a readable error component', () => {
    const ErrorComponent = router.options.defaultErrorComponent;
    expect(ErrorComponent).toBeDefined();

    const { getByRole } = render(
      React.createElement(ErrorComponent!, { error: new Error('kaboom'), reset: () => {} })
    );

    expect(getByRole('alert')).toHaveTextContent('Something went wrong');
  });

  it('renders a not-found component for unknown routes', () => {
    const NotFoundComponent = router.options.defaultNotFoundComponent;
    expect(NotFoundComponent).toBeDefined();

    const { getByRole } = render(React.createElement(NotFoundComponent as React.ComponentType, {}));

    expect(getByRole('alert')).toHaveTextContent(/not found/i);
  });
});
