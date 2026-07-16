import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';

import { SettingCard } from './setting-card';

const OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'mid', label: 'Medium' },
  { value: 'on', label: 'On' },
] as const;

describe('SettingCard', () => {
  it('renders the title and the current value label', () => {
    render(<SettingCard title="Contrast" options={OPTIONS} value="mid" onChange={() => {}} />);
    expect(screen.getByText('Contrast')).not.toBeNull();
    expect(screen.getByText('Medium')).not.toBeNull();
  });

  it('cycles forward on click', () => {
    const onChange = vi.fn();
    render(<SettingCard title="Contrast" options={OPTIONS} value="off" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenCalledWith('mid');
  });

  it('wraps around from the last value back to the first', () => {
    const onChange = vi.fn();
    render(<SettingCard title="Contrast" options={OPTIONS} value="on" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenCalledWith('off');
  });

  it('uses ArrowLeft to cycle backward', () => {
    const onChange = vi.fn();
    render(<SettingCard title="Contrast" options={OPTIONS} value="mid" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('off');
  });

  it('uses ArrowRight / ArrowUp / Space / Enter to cycle forward', () => {
    for (const key of ['ArrowRight', 'ArrowUp', ' ', 'Enter']) {
      const onChange = vi.fn();
      render(<SettingCard title="X" options={OPTIONS} value="off" onChange={onChange} />);
      fireEvent.keyDown(screen.getByRole('button'), { key });
      expect(onChange).toHaveBeenCalledWith('mid');
      cleanup();
    }
  });

  it('jumps to first option with Home', () => {
    const onChange = vi.fn();
    render(<SettingCard title="X" options={OPTIONS} value="on" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Home' });
    expect(onChange).toHaveBeenCalledWith('off');
  });

  it('jumps to last option with End', () => {
    const onChange = vi.fn();
    render(<SettingCard title="X" options={OPTIONS} value="off" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'End' });
    expect(onChange).toHaveBeenCalledWith('on');
  });

  it('exposes aria-label including title and current value label', () => {
    render(<SettingCard title="Contrast" options={OPTIONS} value="mid" onChange={() => {}} />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Contrast: Medium');
  });

  it('sets data-state="off" when the current value is the first option', () => {
    render(<SettingCard title="X" options={OPTIONS} value="off" onChange={() => {}} />);
    expect(screen.getByRole('button').dataset['state']).toBe('off');
  });

  it('sets data-state="on" when the current value is past the first option', () => {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    expect(screen.getByRole('button').dataset['state']).toBe('on');
  });

  it('renders one dot per option', () => {
    render(<SettingCard title="X" options={OPTIONS} value="off" onChange={() => {}} />);
    const dots = screen
      .getByRole('button')
      .querySelectorAll('[data-slot="setting-card-dots"] > span');
    expect(dots).toHaveLength(OPTIONS.length);
  });

  it('marks exactly one dot as active matching the current value', () => {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    const dots = screen
      .getByRole('button')
      .querySelectorAll('[data-slot="setting-card-dots"] > span');
    const activeStates = [...dots].map((d) => (d as HTMLElement).dataset['active']);
    expect(activeStates).toEqual(['false', 'true', 'false']);
  });

  it('treats an unknown current value as index 0', () => {
    render(
      <SettingCard
        title="X"
        options={OPTIONS}
        value={'wat' as 'off' | 'mid' | 'on'}
        onChange={() => {}}
      />
    );
    expect(screen.getByText('Off')).not.toBeNull();
  });

  it('sets data-intensity proportional to current index', () => {
    render(<SettingCard title="X" options={OPTIONS} value="on" onChange={() => {}} />);
    expect(screen.getByRole('button').dataset['intensity']).toBe('1.00');
  });

  it('emits no onChange when ignored keys are pressed', () => {
    const onChange = vi.fn();
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders a previous-arrow and next-arrow alongside the dots', () => {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    const button = screen.getByRole('button');
    expect(button.querySelector('[data-slot="setting-card-prev"]')).not.toBeNull();
    expect(button.querySelector('[data-slot="setting-card-next"]')).not.toBeNull();
  });

  it('marks both arrows as decorative (aria-hidden)', () => {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    const previous = screen.getByTestId(TEST_IDS.settingCardPrev);
    const next = screen.getByTestId(TEST_IDS.settingCardNext);
    expect(previous.getAttribute('aria-hidden')).toBe('true');
    expect(next.getAttribute('aria-hidden')).toBe('true');
  });

  it('clicking the previous arrow cycles backward', () => {
    const onChange = vi.fn();
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={onChange} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.settingCardPrev));
    expect(onChange).toHaveBeenCalledWith('off');
  });

  it('clicking the next arrow cycles forward', () => {
    const onChange = vi.fn();
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={onChange} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.settingCardNext));
    expect(onChange).toHaveBeenCalledWith('on');
  });

  it('clicking the previous arrow does not also trigger the card click handler', () => {
    const onChange = vi.fn();
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={onChange} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.settingCardPrev));
    // Forward cycle would call with 'on'; backward with 'off'. We must NOT see both.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('off');
  });

  it('renders dots inside a centered controls row alongside the arrows', () => {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    const dots = screen
      .getByRole('button')
      .querySelector<HTMLElement>('[data-slot="setting-card-dots"]');
    expect(dots).not.toBeNull();
    expect(dots?.parentElement?.className).toContain('justify-center');
  });

  it('uses cursor-pointer so the card shows the clickable cursor on hover', () => {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    expect(screen.getByRole('button').className).toContain('cursor-pointer');
  });

  it('tints a below-neutral value with the info color', () => {
    render(
      <SettingCard title="X" options={OPTIONS} value="off" neutralIndex={2} onChange={() => {}} />
    );
    const button = screen.getByRole('button');
    expect(button.dataset['state']).toBe('on');
    expect(button.style.getPropertyValue('--a11y-card-bg')).toContain('--color-info');
  });

  it('tints an above-neutral value with the brand-red color', () => {
    render(
      <SettingCard title="X" options={OPTIONS} value="on" neutralIndex={0} onChange={() => {}} />
    );
    const button = screen.getByRole('button');
    expect(button.style.getPropertyValue('--a11y-card-bg')).toContain('--color-brand-red');
  });

  it('renders safely with no options and never emits onChange', () => {
    const onChange = vi.fn();
    render(<SettingCard<string> title="Empty" options={[]} value="x" onChange={onChange} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Home' });
    fireEvent.keyDown(button, { key: 'End' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
