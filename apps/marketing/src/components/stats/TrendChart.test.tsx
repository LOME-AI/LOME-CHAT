import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TrendChart } from './TrendChart';
import type { TrendBand } from './compute-stats';

const BANDS: readonly TrendBand[] = [
  {
    id: 'a/one',
    label: 'One',
    color: 'var(--chart-1)',
    path: 'M 0 100 L 100 100 L 100 60 L 0 60 Z',
    topPath: 'M 0 100 L 100 60',
  },
  {
    id: 'others',
    label: 'Others',
    color: 'var(--border)',
    path: 'M 0 60 L 100 60 L 100 0 L 0 0 Z',
    topPath: 'M 0 0 L 100 0',
  },
];

describe('TrendChart', () => {
  it('renders an svg image with the given accessible label', () => {
    render(
      <TrendChart
        bands={BANDS}
        axis={{ left: '30 days ago', right: 'today' }}
        ariaLabel="Model share over the last 30 days"
      />
    );
    expect(
      screen.getByRole('img', { name: 'Model share over the last 30 days' })
    ).toBeInTheDocument();
  });

  it('renders one gradient-filled area path per band', () => {
    const { container } = render(
      <TrendChart bands={BANDS} axis={{ left: '30 days ago', right: 'today' }} ariaLabel="chart" />
    );
    const areas = container.querySelectorAll('path[fill^="url(#"]');
    expect(areas).toHaveLength(2);
    const gradients = container.querySelectorAll('linearGradient');
    expect(gradients).toHaveLength(2);
    for (const [index, band] of BANDS.entries()) {
      expect(areas[index].getAttribute('d')).toBe(band.path);
      expect(areas[index].getAttribute('fill')).toBe(`url(#${gradients[index].id})`);
    }
  });

  it('fades each band gradient from strong under its top line to faint at its bottom', () => {
    const { container } = render(
      <TrendChart bands={BANDS} axis={{ left: '30 days ago', right: 'today' }} ariaLabel="chart" />
    );
    const gradients = container.querySelectorAll('linearGradient');
    for (const [index, band] of BANDS.entries()) {
      const stops = gradients[index].querySelectorAll('stop');
      expect(stops).toHaveLength(2);
      expect(stops[0].getAttribute('stop-color')).toBe(band.color);
      expect(stops[0].getAttribute('stop-opacity')).toBe('0.75');
      expect(stops[1].getAttribute('stop-color')).toBe(band.color);
      expect(stops[1].getAttribute('stop-opacity')).toBe('0.08');
      // Vertical fade over the band's own extent (objectBoundingBox units).
      expect(gradients[index].getAttribute('x1')).toBe('0');
      expect(gradients[index].getAttribute('y1')).toBe('0');
      expect(gradients[index].getAttribute('x2')).toBe('0');
      expect(gradients[index].getAttribute('y2')).toBe('1');
    }
  });

  it('strokes a solid top-boundary line for every band in its series color', () => {
    const { container } = render(
      <TrendChart bands={BANDS} axis={{ left: '30 days ago', right: 'today' }} ariaLabel="chart" />
    );
    const lines = container.querySelectorAll('path[fill="none"]');
    expect(lines).toHaveLength(2);
    for (const [index, band] of BANDS.entries()) {
      expect(lines[index].getAttribute('d')).toBe(band.topPath);
      expect(lines[index].getAttribute('stroke')).toBe(band.color);
      expect(lines[index].getAttribute('stroke-width')).toBe('2');
      // The viewBox is stretched non-uniformly; without this the 2px line would distort.
      expect(lines[index].getAttribute('vector-effect')).toBe('non-scaling-stroke');
    }
  });

  it('keeps the legend swatches solid, keyed to the hard lines', () => {
    const { container } = render(
      <TrendChart bands={BANDS} axis={{ left: '30 days ago', right: 'today' }} ariaLabel="chart" />
    );
    const swatches = container.querySelectorAll('ul rect');
    expect(swatches).toHaveLength(2);
    for (const [index, band] of BANDS.entries()) {
      expect(swatches[index].getAttribute('fill')).toBe(band.color);
    }
  });

  it('renders a legend entry per band', () => {
    render(
      <TrendChart bands={BANDS} axis={{ left: '30 days ago', right: 'today' }} ariaLabel="chart" />
    );
    expect(screen.getByRole('list', { name: 'Legend' })).toBeInTheDocument();
    expect(screen.getByText('One')).toBeInTheDocument();
    expect(screen.getByText('Others')).toBeInTheDocument();
  });

  it('renders a quiet placeholder instead of an empty chart when there are no bands', () => {
    render(<TrendChart bands={[]} axis={{ left: '', right: '' }} ariaLabel="chart" />);
    expect(screen.getByText('Not enough data yet')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Legend' })).not.toBeInTheDocument();
  });

  it('renders both axis labels', () => {
    render(
      <TrendChart bands={BANDS} axis={{ left: '30 days ago', right: 'today' }} ariaLabel="chart" />
    );
    expect(screen.getByText('30 days ago')).toBeInTheDocument();
    expect(screen.getByText('today')).toBeInTheDocument();
  });
});
