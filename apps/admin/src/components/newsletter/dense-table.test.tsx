import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DenseTable } from './dense-table.js';

describe('DenseTable', () => {
  it('renders visible headers and the row children', () => {
    render(
      <DenseTable testId="dense" headers={[{ label: 'Id' }, { label: 'Email' }]}>
        <tr>
          <td>row-cell</td>
        </tr>
      </DenseTable>
    );
    const table = screen.getByTestId('dense');
    expect(within(table).getByText('Id')).toBeInTheDocument();
    expect(within(table).getByText('Email')).toBeInTheDocument();
    expect(within(table).getByText('row-cell')).toBeInTheDocument();
  });

  it('keeps an sr-only header in the accessibility tree without visible text', () => {
    render(
      <DenseTable testId="dense" headers={[{ label: 'Actions', srOnly: true }]}>
        <tr>
          <td>x</td>
        </tr>
      </DenseTable>
    );
    const header = screen.getByText('Actions');
    expect(header).toHaveClass('sr-only');
  });
});
