import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
} from './select';

describe('Select', () => {
  it('renders trigger element', () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select an option" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option 1</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByText('Select an option')).toBeInTheDocument();
  });

  it('opens select when trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option 1</SelectItem>
          <SelectItem value="2">Option 2</SelectItem>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByText('Option 1')).toBeInTheDocument();
      expect(screen.getByText('Option 2')).toBeInTheDocument();
    });
  });

  it('selects item when clicked', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Select onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="option1">Option 1</SelectItem>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByText('Option 1')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Option 1'));
    expect(onValueChange).toHaveBeenCalledWith('option1');
  });

  it('trigger has data-slot attribute', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByTestId('trigger')).toHaveAttribute('data-slot', 'select-trigger');
  });

  it('renders controlled select', () => {
    render(
      <Select value="option1">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="option1">Selected Option</SelectItem>
        </SelectContent>
      </Select>
    );

    expect(screen.getByText('Selected Option')).toBeInTheDocument();
  });

  it('supports disabled state', () => {
    render(
      <Select disabled>
        <SelectTrigger data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );

    expect(screen.getByTestId('trigger')).toBeDisabled();
  });
});

describe('SelectTrigger', () => {
  it('applies custom className', () => {
    render(
      <Select>
        <SelectTrigger className="custom-class" data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByTestId('trigger')).toHaveClass('custom-class');
  });

  it('supports sm size', () => {
    render(
      <Select>
        <SelectTrigger size="sm" data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByTestId('trigger')).toHaveAttribute('data-size', 'sm');
  });

  it('supports default size', () => {
    render(
      <Select>
        <SelectTrigger size="default" data-testid="trigger">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByTestId('trigger')).toHaveAttribute('data-size', 'default');
  });
});

describe('SelectItem', () => {
  it('has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1" data-testid="item">
            Option
          </SelectItem>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByTestId('item')).toHaveAttribute('data-slot', 'select-item');
    });
  });

  it('applies custom className', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1" className="custom-class" data-testid="item">
            Option
          </SelectItem>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByTestId('item')).toHaveClass('custom-class');
    });
  });

  it('supports disabled state', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1" disabled data-testid="item">
            Disabled Option
          </SelectItem>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByTestId('item')).toHaveAttribute('data-disabled');
    });
  });
});

describe('SelectGroup', () => {
  it('has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup data-testid="group">
            <SelectLabel>Group Label</SelectLabel>
            <SelectItem value="1">Option</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByTestId('group')).toHaveAttribute('data-slot', 'select-group');
    });
  });
});

describe('SelectLabel', () => {
  it('renders label text', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>My Label</SelectLabel>
            <SelectItem value="1">Option</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByText('My Label')).toBeInTheDocument();
    });
  });

  it('has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel data-testid="label">Label</SelectLabel>
            <SelectItem value="1">Option</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByTestId('label')).toHaveAttribute('data-slot', 'select-label');
    });
  });
});

describe('SelectSeparator', () => {
  it('has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option 1</SelectItem>
          <SelectSeparator data-testid="separator" />
          <SelectItem value="2">Option 2</SelectItem>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByTestId('separator')).toHaveAttribute('data-slot', 'select-separator');
    });
  });
});

describe('SelectValue', () => {
  it('has data-slot attribute', () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue data-testid="value" placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByTestId('value')).toHaveAttribute('data-slot', 'select-value');
  });

  it('displays placeholder when no value', () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Choose option" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByText('Choose option')).toBeInTheDocument();
  });

  it('applies popper-positioning classes when position is popper', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="1">Option 1</SelectItem>
        </SelectContent>
      </Select>
    );
    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      const content = document.querySelector('[data-slot="select-content"]');
      expect(content).not.toBeNull();
      expect(content!.className).toContain('data-[side=bottom]:translate-y-1');
    });
  });
});
