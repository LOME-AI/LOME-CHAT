import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import { GenerationConfigSheet } from '@/components/chat/media/generation-config-sheet';

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

describe('GenerationConfigSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseModels.mockReturnValue({ data: { models: [], premiumIds: new Set<string>() } });
  });

  it('renders nothing visible when open=false', () => {
    resetStub({ activeModality: 'image', imageConfig: { aspectRatio: '1:1' } });
    render(<GenerationConfigSheet modality="image" open={false} onOpenChange={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders a dialog when open=true', () => {
    resetStub({ activeModality: 'image', imageConfig: { aspectRatio: '1:1' } });
    render(<GenerationConfigSheet modality="image" open={true} onOpenChange={() => {}} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  describe('image modality', () => {
    beforeEach(() => {
      resetStub({ activeModality: 'image', imageConfig: { aspectRatio: '1:1' } });
    });

    it('renders the image aspect ratio control', () => {
      render(<GenerationConfigSheet modality="image" open={true} onOpenChange={() => {}} />);
      expect(screen.getByRole('button', { name: '1:1' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '4:3' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '9:16' })).toBeInTheDocument();
    });

    it('uses the "Image settings" accessible label on the sheet', () => {
      render(<GenerationConfigSheet modality="image" open={true} onOpenChange={() => {}} />);
      expect(
        screen.getByRole('dialog', { name: /image generation settings/i })
      ).toBeInTheDocument();
    });

    it('does not render video-specific controls', () => {
      render(<GenerationConfigSheet modality="image" open={true} onOpenChange={() => {}} />);
      expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    });

    it('propagates aspect ratio selection to the store', () => {
      render(<GenerationConfigSheet modality="image" open={true} onOpenChange={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: '16:9' }));
      expect(modelStoreStubRef.current.setImageConfig).toHaveBeenCalledWith({
        aspectRatio: '16:9',
      });
    });
  });

  describe('video modality', () => {
    beforeEach(() => {
      mockUseModels.mockReturnValue({
        data: {
          models: [
            {
              id: 'google/veo-3.1',
              modality: 'video',
              supportedVideoResolutions: ['720p', '1080p'],
              supportedAspectRatios: ['16:9', '9:16'],
              supportedVideoDurationsSeconds: [4, 6, 8],
              pricing: { perSecondByResolution: { '720p': '100000000', '1080p': '150000000' } },
            } as never,
          ],
          premiumIds: new Set<string>(),
        },
      });
      resetStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
        selections: {
          text: [],
          image: [],
          audio: [],
          video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
        },
      });
    });

    it('renders duration, aspect, and resolution controls', () => {
      render(<GenerationConfigSheet modality="video" open={true} onOpenChange={() => {}} />);
      expect(screen.getByRole('slider')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '720p' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '1080p' })).toBeInTheDocument();
    });

    it('uses the "Video settings" accessible label on the sheet', () => {
      render(<GenerationConfigSheet modality="video" open={true} onOpenChange={() => {}} />);
      expect(
        screen.getByRole('dialog', { name: /video generation settings/i })
      ).toBeInTheDocument();
    });

    it('renders sections in sheet order: aspect, resolution, duration (above Estimated cost)', () => {
      render(<GenerationConfigSheet modality="video" open={true} onOpenChange={() => {}} />);
      const sheet = screen.getByRole('dialog');
      const sliderEl = sheet.querySelector('input[type="range"]');
      const aspectEl = sheet.querySelector('[aria-pressed][type="button"]');
      expect(sliderEl).toBeTruthy();
      expect(aspectEl).toBeTruthy();
      const innerHtml = sheet.innerHTML;
      // Aspect ratio (first aria-pressed button) appears before the duration slider
      expect(innerHtml.indexOf('aria-pressed')).toBeLessThan(innerHtml.indexOf('type="range"'));
      // Duration slider appears before the Cost row
      expect(innerHtml.indexOf('type="range"')).toBeLessThan(innerHtml.indexOf('>Cost<'));
    });

    it('hides the inline "Duration" label in the sheet (the section title already says it)', () => {
      render(<GenerationConfigSheet modality="video" open={true} onOpenChange={() => {}} />);
      // The slider's accessible label remains for screen readers.
      expect(
        screen.getByRole('slider', { name: /video duration in seconds/i })
      ).toBeInTheDocument();
      // Visible "Duration" text appears exactly once (the section heading),
      // not twice (heading + inline label).
      expect(screen.getAllByText(/^Duration$/)).toHaveLength(1);
    });

    it('propagates duration changes via the slider', () => {
      render(<GenerationConfigSheet modality="video" open={true} onOpenChange={() => {}} />);
      fireEvent.change(screen.getByRole('slider'), { target: { value: '6' } });
      expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
        durationSeconds: 6,
      });
    });

    it('propagates aspect ratio selection', () => {
      render(<GenerationConfigSheet modality="video" open={true} onOpenChange={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: '9:16' }));
      expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
        aspectRatio: '9:16',
      });
    });

    it('propagates resolution selection', () => {
      render(<GenerationConfigSheet modality="video" open={true} onOpenChange={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: '1080p' }));
      expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
        resolution: '1080p',
      });
    });
  });
});
