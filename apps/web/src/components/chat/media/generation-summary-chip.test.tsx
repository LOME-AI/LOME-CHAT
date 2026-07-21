import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import { GenerationSummaryChip } from '@/components/chat/media/generation-summary-chip';

const { mockUseModels } = vi.hoisted(() => ({
  mockUseModels: vi.fn(() => ({ data: { models: [], premiumIds: new Set<string>() } })),
}));
vi.mock('@/hooks/models/models', () => ({
  useModels: mockUseModels,
}));

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };

function resetStub(overrides: Partial<ModelStoreStub> = {}): void {
  modelStoreStubRef.current = createModelStoreStub(overrides);
}

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = vi.fn((selector?: (s: ModelStoreStub) => unknown) =>
    selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current
  );
  (store as unknown as Record<string, unknown>)['setState'] = vi.fn();
  (store as unknown as Record<string, unknown>)['getState'] = () => modelStoreStubRef.current;
  return { ...actual, useModelStore: store };
});

describe('GenerationSummaryChip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseModels.mockReturnValue({ data: { models: [], premiumIds: new Set<string>() } });
  });

  describe('image modality', () => {
    beforeEach(() => {
      resetStub({ activeModality: 'image', imageConfig: { aspectRatio: '1:1' } });
    });

    it('renders the current image aspect ratio', () => {
      render(<GenerationSummaryChip modality="image" onClick={() => {}} />);
      expect(screen.getByText('1:1')).toBeInTheDocument();
    });

    it('renders a proportional aspect-ratio shape matching the value', () => {
      resetStub({ activeModality: 'image', imageConfig: { aspectRatio: '4:3' } });
      render(<GenerationSummaryChip modality="image" onClick={() => {}} />);
      const shape = screen.getByTestId('aspect-ratio-shape');
      expect(shape.style.aspectRatio).toBe('4 / 3');
    });

    it('renders the chip as a button with an accessible label', () => {
      render(<GenerationSummaryChip modality="image" onClick={() => {}} />);
      expect(screen.getByRole('button', { name: /image settings/i })).toBeInTheDocument();
    });

    it('fires onClick when the chip is tapped', () => {
      const handleClick = vi.fn();
      render(<GenerationSummaryChip modality="image" onClick={handleClick} />);
      fireEvent.click(screen.getByRole('button', { name: /image settings/i }));
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('does not render the cost inside the chip (cost lives in the sheet)', () => {
      mockUseModels.mockReturnValue({
        data: {
          models: [
            {
              id: 'google/imagen-4',
              modality: 'image',
              pricing: { perImage: '40000000' },
            } as never,
          ],
          premiumIds: new Set<string>(),
        },
      });
      resetStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: {
          text: [],
          image: [{ id: 'google/imagen-4', name: 'Imagen 4' }],
          audio: [],
          video: [],
        },
      });
      render(<GenerationSummaryChip modality="image" onClick={() => {}} />);
      expect(screen.queryByText(/≈ \$\d+\.\d+/)).not.toBeInTheDocument();
      expect(screen.queryByText('(estimate)')).not.toBeInTheDocument();
    });
  });

  describe('video modality', () => {
    beforeEach(() => {
      resetStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '1080p' },
      });
    });

    it('renders aspect ratio, duration, and resolution', () => {
      render(<GenerationSummaryChip modality="video" onClick={() => {}} />);
      const summary = screen.getByTestId('video-summary-text');
      expect(summary).toHaveTextContent('16:9');
      expect(summary).toHaveTextContent('4s');
      expect(summary).toHaveTextContent('1080p');
    });

    it('renders a proportional shape for the video aspect ratio', () => {
      resetStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '9:16', durationSeconds: 4, resolution: '1080p' },
      });
      render(<GenerationSummaryChip modality="video" onClick={() => {}} />);
      expect(screen.getByTestId('aspect-ratio-shape').style.aspectRatio).toBe('9 / 16');
    });

    it('renders the chip as a button with an accessible label describing all params', () => {
      render(<GenerationSummaryChip modality="video" onClick={() => {}} />);
      const button = screen.getByRole('button', { name: /video settings/i });
      expect(button).toHaveAccessibleName(expect.stringMatching(/16:9/));
      expect(button).toHaveAccessibleName(expect.stringMatching(/4 seconds/));
      expect(button).toHaveAccessibleName(expect.stringMatching(/1080p/));
    });

    it('fires onClick when the chip is tapped', () => {
      const handleClick = vi.fn();
      render(<GenerationSummaryChip modality="video" onClick={handleClick} />);
      fireEvent.click(screen.getByRole('button', { name: /video settings/i }));
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('does not render the cost inside the chip (cost lives in the sheet)', () => {
      mockUseModels.mockReturnValue({
        data: {
          models: [
            {
              id: 'google/veo-3.1',
              modality: 'video',
              pricing: { perSecondByResolution: { '720p': '100000000', '1080p': '150000000' } },
            } as never,
          ],
          premiumIds: new Set<string>(),
        },
      });
      resetStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '1080p' },
        selections: {
          text: [],
          image: [],
          audio: [],
          video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
        },
      });
      render(<GenerationSummaryChip modality="video" onClick={() => {}} />);
      expect(screen.queryByText(/≈ \$\d+\.\d+/)).not.toBeInTheDocument();
      expect(screen.queryByText('(estimate)')).not.toBeInTheDocument();
    });
  });
});
