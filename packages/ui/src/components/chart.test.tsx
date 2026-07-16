import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ChartContainer, ChartTooltipContent, ChartLegendContent, useChart } from './chart';
import type { ChartConfig } from './chart';

const TEST_CONFIG: ChartConfig = {
  revenue: { label: 'Revenue', color: 'red' },
  cost: { label: 'Cost', color: 'blue' },
};

function renderTooltip(
  props: Partial<Parameters<typeof ChartTooltipContent>[0]> = {}
): ReturnType<typeof render> {
  return render(
    <ChartContainer config={TEST_CONFIG}>
      <ChartTooltipContent
        active
        payload={[
          { name: 'revenue', dataKey: 'revenue', value: 100, color: 'red' },
          { name: 'cost', dataKey: 'cost', value: 50, color: 'blue' },
        ]}
        label="Jan 1"
        {...props}
      />
    </ChartContainer>
  );
}

describe('ChartContainer', () => {
  it('renders children', () => {
    render(
      <ChartContainer config={TEST_CONFIG}>
        <span>child</span>
      </ChartContainer>
    );
    expect(screen.getByText('child')).toBeInTheDocument();
  });

  it('sets data-chart attribute', () => {
    const { container } = render(
      <ChartContainer config={TEST_CONFIG}>
        <span>child</span>
      </ChartContainer>
    );
    expect(container.querySelector('[data-chart]')).toBeInTheDocument();
  });

  it('injects CSS color variables from config', () => {
    const { container } = render(
      <ChartContainer config={TEST_CONFIG}>
        <span>child</span>
      </ChartContainer>
    );
    const el = container.querySelector('[data-chart]')!;
    expect((el as HTMLElement).style.getPropertyValue('--color-revenue')).toBe('red');
    expect((el as HTMLElement).style.getPropertyValue('--color-cost')).toBe('blue');
  });

  it('skips config entries without a color', () => {
    const config: ChartConfig = {
      revenue: { label: 'Revenue' },
      cost: { label: 'Cost', color: 'blue' },
    };
    const { container } = render(
      <ChartContainer config={config}>
        <span>child</span>
      </ChartContainer>
    );
    const el = container.querySelector('[data-chart]')!;
    expect((el as HTMLElement).style.getPropertyValue('--color-revenue')).toBe('');
    expect((el as HTMLElement).style.getPropertyValue('--color-cost')).toBe('blue');
  });

  it('applies className', () => {
    const { container } = render(
      <ChartContainer config={TEST_CONFIG} className="my-class">
        <span>child</span>
      </ChartContainer>
    );
    expect(container.querySelector('[data-chart]')).toHaveClass('my-class');
  });
});

describe('useChart', () => {
  it('throws when used outside ChartContainer', () => {
    function BadConsumer(): React.JSX.Element {
      useChart();
      return <span>fail</span>;
    }
    expect(() => render(<BadConsumer />)).toThrow(
      'useChart must be used within a <ChartContainer />'
    );
  });
});

describe('ChartTooltipContent', () => {
  describe('visibility', () => {
    it('returns null when not active', () => {
      const { container } = renderTooltip({ active: false });
      const chartEl = container.querySelector('[data-chart]')!;
      expect(chartEl.children.length).toBe(0);
    });

    it('returns null when payload is not provided', () => {
      const { container } = render(
        <ChartContainer config={TEST_CONFIG}>
          <ChartTooltipContent active label="Jan 1" />
        </ChartContainer>
      );
      const chartEl = container.querySelector('[data-chart]')!;
      expect(chartEl.children.length).toBe(0);
    });

    it('returns null when payload is empty', () => {
      const { container } = renderTooltip({ payload: [] });
      const chartEl = container.querySelector('[data-chart]')!;
      expect(chartEl.children.length).toBe(0);
    });

    it('renders when active with payload', () => {
      renderTooltip();
      expect(screen.getByText('Revenue')).toBeInTheDocument();
      expect(screen.getByText('Cost')).toBeInTheDocument();
    });
  });

  describe('label', () => {
    it('renders the label', () => {
      renderTooltip({ label: 'March' });
      expect(screen.getByText('March')).toBeInTheDocument();
    });

    it('hides label when hideLabel is true', () => {
      renderTooltip({ label: 'March', hideLabel: true });
      expect(screen.queryByText('March')).not.toBeInTheDocument();
    });

    it('applies labelFormatter', () => {
      renderTooltip({
        label: 'raw',
        labelFormatter: (l) => `Formatted: ${l}`,
      });
      expect(screen.getByText('Formatted: raw')).toBeInTheDocument();
    });
  });

  describe('values', () => {
    it('renders raw values by default', () => {
      renderTooltip();
      expect(screen.getByText('100')).toBeInTheDocument();
      expect(screen.getByText('50')).toBeInTheDocument();
    });

    it('applies valueFormatter', () => {
      renderTooltip({ valueFormatter: (v) => `$${String(v)}` });
      expect(screen.getByText('$100')).toBeInTheDocument();
      expect(screen.getByText('$50')).toBeInTheDocument();
    });

    it('treats missing value as 0', () => {
      renderTooltip({
        payload: [{ name: 'revenue', dataKey: 'revenue', color: 'red' }],
      });
      expect(screen.getByText('0')).toBeInTheDocument();
    });
  });

  describe('config labels', () => {
    it('uses config label over dataKey', () => {
      renderTooltip({
        payload: [{ dataKey: 'revenue', value: 10, color: 'red' }],
      });
      expect(screen.getByText('Revenue')).toBeInTheDocument();
    });

    it('falls back to key when config has no label', () => {
      renderTooltip({
        payload: [{ dataKey: 'unknown', value: 10, color: 'green' }],
      });
      expect(screen.getByText('unknown')).toBeInTheDocument();
    });

    it('falls back to name when dataKey is absent', () => {
      renderTooltip({
        payload: [{ name: 'revenue', value: 10, color: 'red' }],
      });
      expect(screen.getByText('Revenue')).toBeInTheDocument();
    });
  });

  describe('nameKey', () => {
    it('resolves the config label from name when nameKey is set, ignoring dataKey', () => {
      renderTooltip({
        nameKey: 'name',
        payload: [{ name: 'revenue', dataKey: 'value', value: 10, color: 'red' }],
      });
      expect(screen.getByText('Revenue')).toBeInTheDocument();
      expect(screen.queryByText('value')).not.toBeInTheDocument();
    });

    it('still renders the value when nameKey resolves the label', () => {
      renderTooltip({
        nameKey: 'name',
        payload: [{ name: 'revenue', dataKey: 'value', value: 10, color: 'red' }],
      });
      expect(screen.getByText('10')).toBeInTheDocument();
    });
  });

  describe('indicators', () => {
    it('renders dot indicators by default', () => {
      const { container } = renderTooltip();
      const indicators = container.querySelectorAll('.shrink-0');
      expect(indicators.length).toBe(2);
      const first = indicators[0]! as HTMLElement;
      expect(first.style.width).toBe('8px');
      expect(first.style.height).toBe('8px');
      expect(first.style.borderStyle).toBe('solid');
    });

    it('renders line indicators', () => {
      const { container } = renderTooltip({ indicator: 'line' });
      const indicators = container.querySelectorAll('.shrink-0');
      const first = indicators[0]! as HTMLElement;
      expect(first.style.width).toBe('16px');
      expect(first.style.height).toBe('3px');
    });

    it('renders dashed indicators', () => {
      const { container } = renderTooltip({ indicator: 'dashed' });
      const indicators = container.querySelectorAll('.shrink-0');
      const first = indicators[0]! as HTMLElement;
      expect(first.style.borderStyle).toBe('dashed');
    });

    it('hides indicators when hideIndicator is true', () => {
      const { container } = renderTooltip({ hideIndicator: true });
      expect(container.querySelectorAll('.shrink-0').length).toBe(0);
    });
  });

  describe('hideZeroValues', () => {
    it('shows zero-value items by default', () => {
      renderTooltip({
        payload: [
          { dataKey: 'revenue', value: 100, color: 'red' },
          { dataKey: 'cost', value: 0, color: 'blue' },
        ],
      });
      expect(screen.getByText('Revenue')).toBeInTheDocument();
      expect(screen.getByText('Cost')).toBeInTheDocument();
    });

    it('hides zero-value items when hideZeroValues is true', () => {
      renderTooltip({
        hideZeroValues: true,
        payload: [
          { dataKey: 'revenue', value: 100, color: 'red' },
          { dataKey: 'cost', value: 0, color: 'blue' },
        ],
      });
      expect(screen.getByText('Revenue')).toBeInTheDocument();
      expect(screen.queryByText('Cost')).not.toBeInTheDocument();
    });

    it('hides string "0" values', () => {
      renderTooltip({
        hideZeroValues: true,
        payload: [
          { dataKey: 'revenue', value: 100, color: 'red' },
          { dataKey: 'cost', value: '0', color: 'blue' },
        ],
      });
      expect(screen.getByText('Revenue')).toBeInTheDocument();
      expect(screen.queryByText('Cost')).not.toBeInTheDocument();
    });

    it('returns null when all values are zero', () => {
      const { container } = renderTooltip({
        hideZeroValues: true,
        payload: [
          { dataKey: 'revenue', value: 0, color: 'red' },
          { dataKey: 'cost', value: 0, color: 'blue' },
        ],
      });
      const chartEl = container.querySelector('[data-chart]')!;
      expect(chartEl.children.length).toBe(0);
    });

    it('keeps non-zero items intact when filtering', () => {
      renderTooltip({
        hideZeroValues: true,
        valueFormatter: (v) => `$${String(v)}`,
        payload: [
          { dataKey: 'revenue', value: 42, color: 'red' },
          { dataKey: 'cost', value: 0, color: 'blue' },
        ],
      });
      expect(screen.getByText('$42')).toBeInTheDocument();
      expect(screen.queryByText('$0')).not.toBeInTheDocument();
    });
  });

  describe('color resolution', () => {
    it('uses item color when provided', () => {
      const { container } = renderTooltip({
        payload: [{ dataKey: 'revenue', value: 10, color: '#ff0000' }],
      });
      const indicator = container.querySelector('.shrink-0')!;
      expect((indicator as HTMLElement).style.backgroundColor).toBe('rgb(255, 0, 0)');
    });

    it('falls back to CSS variable when no item color', () => {
      const { container } = renderTooltip({
        payload: [{ dataKey: 'revenue', value: 10 }],
      });
      const indicator = container.querySelector('.shrink-0')!;
      expect((indicator as HTMLElement).style.backgroundColor).toBe('var(--color-revenue)');
    });
  });

  describe('nameKey resolution', () => {
    it('resolves the config key from payload[nameKey] when present', () => {
      renderTooltip({
        nameKey: 'category',
        payload: [
          {
            name: 'x',
            dataKey: 'value',
            value: 10,
            color: 'red',
            payload: { category: 'revenue' },
          },
        ],
      });
      expect(screen.getByText('Revenue')).toBeInTheDocument();
    });

    it('falls back to item name when payload[nameKey] is absent', () => {
      renderTooltip({
        nameKey: 'category',
        payload: [{ name: 'revenue', dataKey: 'value', value: 10, color: 'red' }],
      });
      expect(screen.getByText('Revenue')).toBeInTheDocument();
    });
  });

  it('treats a missing value as zero', () => {
    renderTooltip({
      payload: [{ name: 'revenue', dataKey: 'revenue', color: 'red' }],
    });
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('falls back to dataKey when a payload item has no name', () => {
    renderTooltip({
      payload: [{ dataKey: 'revenue', value: 10, color: 'red' }],
    });
    expect(screen.getByText('Revenue')).toBeInTheDocument();
  });

  it('resolves to an empty key when a payload item has neither name nor dataKey', () => {
    renderTooltip({
      payload: [{ value: 10, color: 'red' }],
    });
    // No config entry resolves; the item still renders its numeric value.
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('falls back to item name under nameKey when dataKey is also absent', () => {
    renderTooltip({
      nameKey: 'category',
      payload: [{ name: 'revenue', value: 10, color: 'red' }],
    });
    expect(screen.getByText('Revenue')).toBeInTheDocument();
  });

  it('resolves to an empty key under nameKey when name and dataKey are absent', () => {
    renderTooltip({
      nameKey: 'category',
      payload: [{ value: 10, color: 'red' }],
    });
    expect(screen.getByText('10')).toBeInTheDocument();
  });
});

describe('ChartLegendContent', () => {
  function renderLegend(
    props: Partial<Parameters<typeof ChartLegendContent>[0]> = {}
  ): ReturnType<typeof render> {
    return render(
      <ChartContainer config={TEST_CONFIG}>
        <ChartLegendContent
          payload={[
            { value: 'revenue', dataKey: 'revenue', color: 'red' },
            { value: 'cost', dataKey: 'cost', color: 'blue' },
          ]}
          {...props}
        />
      </ChartContainer>
    );
  }

  it('returns null when payload is not provided', () => {
    const { container } = render(
      <ChartContainer config={TEST_CONFIG}>
        <ChartLegendContent />
      </ChartContainer>
    );
    const chartEl = container.querySelector('[data-chart]')!;
    expect(chartEl.children.length).toBe(0);
  });

  it('returns null when payload is empty', () => {
    const { container } = renderLegend({ payload: [] });
    const chartEl = container.querySelector('[data-chart]')!;
    expect(chartEl.children.length).toBe(0);
  });

  it('renders legend items with config labels', () => {
    renderLegend();
    expect(screen.getByText('Revenue')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();
  });

  it('falls back to key when config has no label', () => {
    renderLegend({
      payload: [{ value: 'unknown', dataKey: 'unknown', color: 'green' }],
    });
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('renders color indicators', () => {
    const { container } = renderLegend();
    const indicators = container.querySelectorAll('.h-2.w-2');
    expect(indicators.length).toBe(2);
    expect((indicators[0] as HTMLElement).style.backgroundColor).toBe('red');
    expect((indicators[1] as HTMLElement).style.backgroundColor).toBe('blue');
  });

  it('falls back to CSS variable when no entry color', () => {
    const { container } = renderLegend({
      payload: [{ value: 'revenue', dataKey: 'revenue' }],
    });
    const indicator = container.querySelector('.h-2.w-2')!;
    expect((indicator as HTMLElement).style.backgroundColor).toBe('var(--color-revenue)');
  });

  it('resolves the config key from entry.value when dataKey is absent', () => {
    renderLegend({
      payload: [{ value: 'revenue', color: 'red' }],
    });
    expect(screen.getByText('Revenue')).toBeInTheDocument();
  });

  it('resolves to an empty key when a legend entry has neither dataKey nor value', () => {
    const { container } = renderLegend({
      payload: [{ color: 'red' }],
    });
    // The legend still renders an item wrapper even with an empty key.
    expect(container.querySelector('.h-2.w-2')).not.toBeNull();
  });
});
