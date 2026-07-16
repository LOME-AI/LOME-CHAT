import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dices } from 'lucide-react';
import {
  textSuggestions,
  imageSuggestions,
  videoSuggestions,
  audioSuggestions,
  type PromptSuggestion,
} from '@/lib/prompt-suggestions';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import { SuggestionChips } from '@/components/chat/input/suggestion-chips';

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };
const reducedMotionRef = { current: true };
const suggestionsOverride: { current: PromptSuggestion[] | null } = { current: null };
const randomIndexOverride: { current: number | null } = { current: null };

vi.mock('@/lib/prompt-suggestions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/prompt-suggestions')>();
  return {
    ...actual,
    getSuggestionsForModality: (
      modality?: Parameters<typeof actual.getSuggestionsForModality>[0]
    ) => suggestionsOverride.current ?? actual.getSuggestionsForModality(modality),
  };
});

vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    getSecureRandomIndex: (length: number) =>
      randomIndexOverride.current ?? actual.getSecureRandomIndex(length),
  };
});

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = vi.fn((selector?: (s: ModelStoreStub) => unknown) =>
    selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current
  );
  (store as unknown as Record<string, unknown>)['setState'] = vi.fn();
  (store as unknown as Record<string, unknown>)['getState'] = () => modelStoreStubRef.current;
  return { ...actual, useModelStore: store };
});

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useReducedMotion: () => reducedMotionRef.current,
  };
});

describe('SuggestionChips', () => {
  const mockOnSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    modelStoreStubRef.current = createModelStoreStub();
    reducedMotionRef.current = true;
    suggestionsOverride.current = null;
    randomIndexOverride.current = null;
  });

  it('renders suggestion chips container', () => {
    render(<SuggestionChips onSelect={mockOnSelect} />);
    expect(screen.getByTestId('suggestion-chips')).toBeInTheDocument();
  });

  it('renders all 4 text category chips by default (reduced motion)', () => {
    render(<SuggestionChips onSelect={mockOnSelect} />);
    for (const suggestion of textSuggestions) {
      expect(screen.getByRole('button', { name: suggestion.label })).toBeInTheDocument();
    }
  });

  it('calls onSelect with a prompt from the clicked category', async () => {
    const user = userEvent.setup();
    render(<SuggestionChips onSelect={mockOnSelect} />);

    const firstSuggestion = textSuggestions[0];
    if (!firstSuggestion) throw new Error('No suggestions available');
    await user.click(screen.getByRole('button', { name: firstSuggestion.label }));

    expect(mockOnSelect).toHaveBeenCalled();
    const calledPrompt = mockOnSelect.mock.calls[0]?.[0] as string;
    expect(firstSuggestion.prompts).toContain(calledPrompt);
  });

  it('renders "Surprise Me" button when showSurpriseMe is true', () => {
    render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);
    expect(screen.getByRole('button', { name: /surprise me/i })).toBeInTheDocument();
  });

  it('Surprise Me selects a random prompt from the active modality pool', async () => {
    const user = userEvent.setup();
    render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);

    await user.click(screen.getByRole('button', { name: /surprise me/i }));

    expect(mockOnSelect).toHaveBeenCalled();
    const calledPrompt = mockOnSelect.mock.calls[0]?.[0] as string;
    const pool = textSuggestions.flatMap((s) => s.prompts);
    expect(pool).toContain(calledPrompt);
  });

  it('omits "Surprise Me" when showSurpriseMe is false', () => {
    render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe={false} />);
    expect(screen.queryByRole('button', { name: /surprise me/i })).not.toBeInTheDocument();
  });

  it('applies custom className to the container', () => {
    render(<SuggestionChips onSelect={mockOnSelect} className="custom-class" />);
    expect(screen.getByTestId('suggestion-chips')).toHaveClass('custom-class');
  });

  describe('slot structure (5 stable slots regardless of modality)', () => {
    for (const [modality, suggestionsForModality] of [
      ['text', textSuggestions],
      ['image', imageSuggestions],
      ['video', videoSuggestions],
      ['audio', audioSuggestions],
    ] as const) {
      it(`renders 5 buttons in ${modality} modality (4 categories + Surprise Me)`, () => {
        modelStoreStubRef.current.activeModality = modality;
        render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);

        for (const suggestion of suggestionsForModality) {
          expect(screen.getByRole('button', { name: suggestion.label })).toBeInTheDocument();
        }
        expect(screen.getByRole('button', { name: /surprise me/i })).toBeInTheDocument();

        const slots = screen.getAllByTestId(/^suggestion-slot-/u);
        expect(slots).toHaveLength(5);
      });

      it(`renders 4 buttons in ${modality} modality when showSurpriseMe is false`, () => {
        modelStoreStubRef.current.activeModality = modality;
        render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe={false} />);
        const slots = screen.getAllByTestId(/^suggestion-slot-/u);
        expect(slots).toHaveLength(4);
      });
    }

    it('clicking a category pill in image modality selects from imageSuggestions', async () => {
      const user = userEvent.setup();
      modelStoreStubRef.current.activeModality = 'image';
      const firstImage = imageSuggestions[0];
      if (!firstImage) throw new Error('No image suggestions');

      render(<SuggestionChips onSelect={mockOnSelect} />);
      await user.click(screen.getByRole('button', { name: firstImage.label }));

      const called = mockOnSelect.mock.calls[0]?.[0] as string;
      expect(firstImage.prompts).toContain(called);
    });

    it('Surprise Me in video modality draws from videoSuggestions', async () => {
      const user = userEvent.setup();
      modelStoreStubRef.current.activeModality = 'video';
      render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);

      await user.click(screen.getByRole('button', { name: /surprise me/i }));

      const called = mockOnSelect.mock.calls[0]?.[0] as string;
      expect(videoSuggestions.flatMap((s) => s.prompts)).toContain(called);
    });

    it('Surprise Me in audio modality draws from audioSuggestions', async () => {
      const user = userEvent.setup();
      modelStoreStubRef.current.activeModality = 'audio';
      render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);

      await user.click(screen.getByRole('button', { name: /surprise me/i }));

      const called = mockOnSelect.mock.calls[0]?.[0] as string;
      expect(audioSuggestions.flatMap((s) => s.prompts)).toContain(called);
    });
  });

  describe('persistence across modality switches', () => {
    it('keeps the same DOM button at each slot when modality changes', () => {
      modelStoreStubRef.current.activeModality = 'text';
      const { rerender } = render(
        <SuggestionChips onSelect={mockOnSelect} showSurpriseMe className="x" />
      );
      const slotsBefore = screen.getAllByTestId(/^suggestion-slot-/u);
      expect(slotsBefore).toHaveLength(5);

      act(() => {
        modelStoreStubRef.current.activeModality = 'image';
      });
      rerender(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe className="x" />);

      const slotsAfter = screen.getAllByTestId(/^suggestion-slot-/u);
      expect(slotsAfter).toHaveLength(5);
      for (let index = 0; index < 5; index++) {
        expect(slotsAfter[index]).toBe(slotsBefore[index]);
      }
    });

    it('does not wrap the chip row in AnimatePresence (no row-level unmount on modality switch)', () => {
      const { container } = render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);
      const allMotion = container.querySelectorAll('[data-framer-presence]');
      expect(allMotion).toHaveLength(0);
    });
  });

  describe('row layout (max 3 pills in row 1)', () => {
    it('renders two rows when showSurpriseMe is true (3 in row 1, 2 in row 2)', () => {
      render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);
      const rows = screen.getAllByTestId('suggestion-chips-row');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.querySelectorAll('button')).toHaveLength(3);
      expect(rows[1]?.querySelectorAll('button')).toHaveLength(2);
    });

    it('renders two rows when showSurpriseMe is false (3 in row 1, 1 in row 2)', () => {
      render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe={false} />);
      const rows = screen.getAllByTestId('suggestion-chips-row');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.querySelectorAll('button')).toHaveLength(3);
      expect(rows[1]?.querySelectorAll('button')).toHaveLength(1);
    });

    it('first row contains slots 0,1,2 and second row contains slots 3,4', () => {
      render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);
      const rows = screen.getAllByTestId('suggestion-chips-row');
      expect(rows[0]?.querySelector('[data-testid="suggestion-slot-0"]')).not.toBeNull();
      expect(rows[0]?.querySelector('[data-testid="suggestion-slot-1"]')).not.toBeNull();
      expect(rows[0]?.querySelector('[data-testid="suggestion-slot-2"]')).not.toBeNull();
      expect(rows[1]?.querySelector('[data-testid="suggestion-slot-3"]')).not.toBeNull();
      expect(rows[1]?.querySelector('[data-testid="suggestion-slot-4"]')).not.toBeNull();
    });
  });

  describe('label and icon animation', () => {
    beforeEach(() => {
      reducedMotionRef.current = false;
    });

    it('uses TypingAnimation for each pill label', () => {
      render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);
      const typing = screen.getAllByTestId('typing-animation');
      expect(typing.length).toBeGreaterThanOrEqual(5);
    });

    it('uses IconMorph for each pill icon', () => {
      render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);
      const iconSlots = screen.getAllByTestId('icon-morph');
      expect(iconSlots).toHaveLength(5);
    });

    it('wraps each pill label in MorphWidth so width changes do not snap', () => {
      render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);
      const widthMorphs = screen.getAllByTestId('morph-width');
      expect(widthMorphs).toHaveLength(5);
    });
  });

  describe('empty-data guards', () => {
    it('does not select when a clicked category has no prompts', async () => {
      const user = userEvent.setup();
      suggestionsOverride.current = [
        { id: 'empty', icon: Dices, label: 'Empty', prompts: [] } as unknown as PromptSuggestion,
      ];
      render(<SuggestionChips onSelect={mockOnSelect} />);

      await user.click(screen.getByRole('button', { name: 'Empty' }));

      expect(mockOnSelect).not.toHaveBeenCalled();
    });

    it('does not select on Surprise Me when the pool is empty', async () => {
      const user = userEvent.setup();
      suggestionsOverride.current = [
        { id: 'empty', icon: Dices, label: 'Empty', prompts: [] } as unknown as PromptSuggestion,
      ];
      render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);

      await user.click(screen.getByRole('button', { name: 'Surprise Me' }));

      expect(mockOnSelect).not.toHaveBeenCalled();
    });

    it('does not select when the random index falls out of range for a category', async () => {
      const user = userEvent.setup();
      suggestionsOverride.current = [
        {
          id: 'cat',
          icon: Dices,
          label: 'Cat',
          prompts: ['only'],
        } as unknown as PromptSuggestion,
      ];
      randomIndexOverride.current = 5;
      render(<SuggestionChips onSelect={mockOnSelect} />);

      await user.click(screen.getByRole('button', { name: 'Cat' }));

      expect(mockOnSelect).not.toHaveBeenCalled();
    });

    it('does not select on Surprise Me when the random index falls out of range', async () => {
      const user = userEvent.setup();
      suggestionsOverride.current = [
        {
          id: 'cat',
          icon: Dices,
          label: 'Cat',
          prompts: ['only'],
        } as unknown as PromptSuggestion,
      ];
      randomIndexOverride.current = 5;
      render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);

      await user.click(screen.getByRole('button', { name: 'Surprise Me' }));

      expect(mockOnSelect).not.toHaveBeenCalled();
    });
  });
});
