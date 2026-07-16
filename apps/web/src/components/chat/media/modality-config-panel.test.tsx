import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import {
  ImageAspectRatioControl,
  VideoAspectRatioControl,
  VideoResolutionControl,
  VideoDurationControl,
  AudioFormatControl,
  AudioDurationControl,
  MediaCostLine,
} from '@/components/chat/media/modality-config-panel';

// Mock useModels so panels can look up pricing without a QueryClient.
// Tests that care about pricing override the return value inline.
// The `mockUseModels` ref has to be declared via `vi.hoisted` so it's available
// inside the vi.mock factory (which runs before top-level declarations).
const { mockUseModels } = vi.hoisted(() => ({
  mockUseModels: vi.fn(() => ({ data: { models: [], premiumIds: new Set<string>() } })),
}));
vi.mock('@/hooks/models/models', () => ({
  useModels: mockUseModels,
}));

interface MockModelsPayload {
  models: {
    id: string;
    modality: 'text' | 'image' | 'video' | 'audio';
    pricePerImage?: number;
    pricePerSecond?: number;
    pricePerSecondByResolution?: Record<string, number>;
  }[];
}

function mockModels(payload: MockModelsPayload): void {
  mockUseModels.mockReturnValue({
    data: {
      models: payload.models as never,
      premiumIds: new Set<string>(),
    },
  });
}

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };

function resetModelStoreStub(overrides: Partial<ModelStoreStub> = {}): void {
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

describe('ImageAspectRatioControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub({ activeModality: 'image', imageConfig: { aspectRatio: '1:1' } });
  });

  it('renders aspect ratio picker with all supported ratios', () => {
    render(<ImageAspectRatioControl />);
    expect(screen.getByRole('button', { name: '1:1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '4:3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3:4' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '9:16' })).toBeInTheDocument();
  });

  it('marks the active aspect ratio with aria-pressed=true', () => {
    resetModelStoreStub({ activeModality: 'image', imageConfig: { aspectRatio: '16:9' } });
    render(<ImageAspectRatioControl />);
    expect(screen.getByRole('button', { name: '16:9' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1:1' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls setImageConfig when an aspect ratio is clicked', () => {
    render(<ImageAspectRatioControl />);
    fireEvent.click(screen.getByRole('button', { name: '16:9' }));
    expect(modelStoreStubRef.current.setImageConfig).toHaveBeenCalledWith({
      aspectRatio: '16:9',
    });
  });

  it('exposes the aspect ratio group with a screen-reader-only legend', () => {
    render(<ImageAspectRatioControl />);
    expect(screen.getByText(/aspect ratio/i)).toBeInTheDocument();
  });

  it('renders each ratio as a proportional shape pill with the ratio as label', () => {
    render(<ImageAspectRatioControl />);
    const shapes = screen.getAllByTestId('aspect-ratio-shape');
    expect(shapes).toHaveLength(5);
    const square = screen
      .getByRole('button', { name: '1:1' })
      .querySelector<HTMLElement>('[data-testid="aspect-ratio-shape"]')!;
    expect(square.style.aspectRatio).toBe('1 / 1');
    const wide = screen
      .getByRole('button', { name: '16:9' })
      .querySelector<HTMLElement>('[data-testid="aspect-ratio-shape"]')!;
    expect(wide.style.aspectRatio).toBe('16 / 9');
  });

  it('narrows ratios to the intersection across selected models', () => {
    mockModels({
      models: [
        {
          id: 'fictional/narrow-image',
          modality: 'image',
          pricePerImage: 0.04,
          supportedAspectRatios: ['1:1', '16:9'],
        } as never,
      ],
    });
    resetModelStoreStub({
      activeModality: 'image',
      imageConfig: { aspectRatio: '1:1' },
      selections: {
        text: [],
        image: [{ id: 'fictional/narrow-image', name: 'Narrow' }],
        audio: [],
        video: [],
      },
    });
    render(<ImageAspectRatioControl />);
    expect(screen.getByRole('button', { name: '1:1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '4:3' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '3:4' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '9:16' })).not.toBeInTheDocument();
  });
});

describe('VideoAspectRatioControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
    });
  });

  it('renders the two Veo-supported ratios', () => {
    render(<VideoAspectRatioControl />);
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '9:16' })).toBeInTheDocument();
  });

  it('does not render 1:1 or 4:3 (Veo does not support these)', () => {
    render(<VideoAspectRatioControl />);
    expect(screen.queryByRole('button', { name: '1:1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '4:3' })).not.toBeInTheDocument();
  });

  it('marks the active aspect ratio with aria-pressed=true', () => {
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '9:16', durationSeconds: 4, resolution: '720p' },
    });
    render(<VideoAspectRatioControl />);
    expect(screen.getByRole('button', { name: '9:16' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('writes setVideoConfig when aspect ratio changes', () => {
    render(<VideoAspectRatioControl />);
    fireEvent.click(screen.getByRole('button', { name: '9:16' }));
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
      aspectRatio: '9:16',
    });
  });

  it('renders each video ratio as a proportional shape pill', () => {
    render(<VideoAspectRatioControl />);
    const wide = screen
      .getByRole('button', { name: '16:9' })
      .querySelector<HTMLElement>('[data-testid="aspect-ratio-shape"]')!;
    expect(wide.style.aspectRatio).toBe('16 / 9');
    const tall = screen
      .getByRole('button', { name: '9:16' })
      .querySelector<HTMLElement>('[data-testid="aspect-ratio-shape"]')!;
    expect(tall.style.aspectRatio).toBe('9 / 16');
  });

  it('narrows ratios to the intersection across selected video models', () => {
    mockModels({
      models: [
        {
          id: 'fictional/landscape-only',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.4 },
          supportedAspectRatios: ['16:9'],
        } as never,
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'fictional/landscape-only', name: 'Landscape Only' }],
      },
    });
    render(<VideoAspectRatioControl />);
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '9:16' })).not.toBeInTheDocument();
  });
});

describe('VideoResolutionControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows an empty-state hint when no model is selected', () => {
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: { text: [], image: [], audio: [], video: [] },
    });
    render(<VideoResolutionControl />);
    expect(screen.getByText(/Select a video model to see resolution options/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /720p/i })).not.toBeInTheDocument();
  });

  it('renders each supported resolution as a button labeled by its raw value', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.1, '1080p': 0.15 },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    expect(screen.getByRole('button', { name: '720p' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1080p' })).toBeInTheDocument();
  });

  it('imposes no resolution constraint for a model with empty per-resolution pricing', () => {
    mockModels({
      models: [
        {
          id: 'video/no-pricing',
          modality: 'video',
          pricePerSecondByResolution: {},
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'video/no-pricing', name: 'No Pricing' }],
      },
    });
    render(<VideoResolutionControl />);
    // A model with no per-resolution pricing contributes no options, so the
    // agreed intersection is empty and no resolution buttons render.
    expect(screen.queryByRole('button', { name: '720p' })).not.toBeInTheDocument();
  });

  it('renders consumer-friendly labels (HD/FHD) above the raw pixel resolution', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.1, '1080p': 0.15 },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    const hdButton = screen.getByRole('button', { name: '720p' });
    expect(hdButton).toHaveTextContent('HD');
    expect(hdButton).toHaveTextContent('720p');
    const fhdButton = screen.getByRole('button', { name: '1080p' });
    expect(fhdButton).toHaveTextContent('FHD');
    expect(fhdButton).toHaveTextContent('1080p');
  });

  it('does not render any per-second price line inside the resolution control', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.1, '1080p': 0.15 },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    expect(screen.queryByTestId('resolution-price')).not.toBeInTheDocument();
    expect(screen.queryByText(/\$\d+\.\d+\/s/)).not.toBeInTheDocument();
  });

  it('omits resolutions not priced by the primary model', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          modality: 'video',
          pricePerSecondByResolution: { '1080p': 0.15 },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    expect(screen.queryByRole('button', { name: /720p/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1080p/ })).toBeInTheDocument();
  });

  it('writes setVideoConfig when a resolution is clicked', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.1, '1080p': 0.15 },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    fireEvent.click(screen.getByRole('button', { name: '1080p' }));
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
      resolution: '1080p',
    });
  });

  it('falls back to the first supported resolution when the current one is unsupported', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          modality: 'video',
          pricePerSecondByResolution: { '1080p': 0.15 },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
      resolution: '1080p',
    });
  });
});

describe('VideoDurationControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
    });
  });

  it('falls back to the 1-8s legacy bounds when no model is selected', () => {
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '8');
    expect(slider).toHaveValue('4');
  });

  it('writes setVideoConfig when duration changes (no model — no snap)', () => {
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '6' } });
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
      durationSeconds: 6,
    });
  });

  it('displays the current duration next to the slider', () => {
    render(<VideoDurationControl />);
    expect(screen.getByText(/4s/i)).toBeInTheDocument();
  });

  it('exposes the duration in aria-valuetext for screen readers', () => {
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuetext', '4 seconds');
  });

  it('clamps min and max to the selected Veo 3.1 model durations (4-8)', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1-generate-001',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.4 },
          supportedVideoDurationsSeconds: [4, 6, 8],
        } as never,
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1-generate-001', name: 'Veo 3.1' }],
      },
    });
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '4');
    expect(slider).toHaveAttribute('max', '8');
  });

  it('hides the inline "Duration" label when hideInlineLabel is set', () => {
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: { text: [], image: [], audio: [], video: [] },
    });
    render(<VideoDurationControl hideInlineLabel />);
    expect(screen.queryByText('Duration')).not.toBeInTheDocument();
  });

  it('runs the slider freely when the selected models agree on no supported durations', () => {
    mockModels({
      models: [
        {
          id: 'video/no-durations',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.4 },
          supportedVideoDurationsSeconds: [],
        } as never,
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'video/no-durations', name: 'No Durations' }],
      },
    });
    render(<VideoDurationControl />);
    // No snap occurs because there is no supported-duration set.
    expect(modelStoreStubRef.current.setVideoConfig).not.toHaveBeenCalled();
  });

  it('snaps an out-of-range initial duration onto the supported set on mount', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1-generate-001',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.4 },
          supportedVideoDurationsSeconds: [4, 6, 8],
        } as never,
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1-generate-001', name: 'Veo 3.1' }],
      },
    });
    render(<VideoDurationControl />);
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
      durationSeconds: 4,
    });
  });

  it('snaps a raw 5 to the nearest supported value (4) when Veo 3.1 is selected', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1-generate-001',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.4 },
          supportedVideoDurationsSeconds: [4, 6, 8],
        } as never,
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1-generate-001', name: 'Veo 3.1' }],
      },
    });
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '5' } });
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
      durationSeconds: 4,
    });
  });

  it('intersects durations across multiple selected models with disjoint sets', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1-generate-001',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.4 },
          supportedVideoDurationsSeconds: [4, 6, 8],
        } as never,
        {
          id: 'mock/long-only',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.4 },
          supportedVideoDurationsSeconds: [6, 8, 10],
        } as never,
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [
          { id: 'google/veo-3.1-generate-001', name: 'Veo 3.1' },
          { id: 'mock/long-only', name: 'Long Only' },
        ],
      },
    });
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '6');
    expect(slider).toHaveAttribute('max', '8');
  });
});

describe('VideoResolutionControl + 4K', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a 4K button when the selected Veo 3.1 model lists it', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1-generate-001',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.4, '1080p': 0.4, '4k': 0.6 },
          supportedVideoResolutions: ['720p', '1080p', '4k'],
        } as never,
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1-generate-001', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    const fourK = screen.getByRole('button', { name: /^4k$/i });
    expect(fourK).toBeInTheDocument();
    expect(fourK).toHaveTextContent('4K');
    expect(fourK).toHaveTextContent('2160p');
  });

  it('drops 4K from the intersection when Veo 3.0 (no 4K) is co-selected — primary is Veo 3.1', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.0-generate-001',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.4, '1080p': 0.4 },
          supportedVideoResolutions: ['720p', '1080p'],
        } as never,
        {
          id: 'google/veo-3.1-generate-001',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.4, '1080p': 0.4, '4k': 0.6 },
          supportedVideoResolutions: ['720p', '1080p', '4k'],
        } as never,
      ],
    });
    // Order matters: Veo 3.1 is primary (has 4K). Without cross-model
    // agreement, the picker would expose 4K despite Veo 3.0 not supporting it,
    // which is the exact bug the agreement helper exists to prevent.
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [
          { id: 'google/veo-3.1-generate-001', name: 'Veo 3.1' },
          { id: 'google/veo-3.0-generate-001', name: 'Veo 3.0' },
        ],
      },
    });
    render(<VideoResolutionControl />);
    expect(screen.queryByRole('button', { name: /4k/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /720p/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1080p/i })).toBeInTheDocument();
  });
});

describe('AudioFormatControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub({
      activeModality: 'audio',
      audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
    });
  });

  it('renders the format picker with all supported formats', () => {
    render(<AudioFormatControl />);
    expect(screen.getByRole('button', { name: 'mp3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'wav' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ogg' })).toBeInTheDocument();
  });

  it('marks the active format with aria-pressed=true', () => {
    render(<AudioFormatControl />);
    expect(screen.getByRole('button', { name: 'mp3' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'wav' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls setAudioConfig when a format is clicked', () => {
    render(<AudioFormatControl />);
    fireEvent.click(screen.getByRole('button', { name: 'wav' }));
    expect(modelStoreStubRef.current.setAudioConfig).toHaveBeenCalledWith({ format: 'wav' });
  });
});

describe('AudioDurationControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub({
      activeModality: 'audio',
      audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
    });
  });

  it('renders a max duration slider that reflects audioConfig.maxDurationSeconds', () => {
    render(<AudioDurationControl />);
    const slider = screen.getByRole('slider', { name: /audio max duration/i });
    expect(slider).toHaveValue('60');
  });

  it('calls setAudioConfig when the duration slider changes', () => {
    render(<AudioDurationControl />);
    const slider = screen.getByRole('slider', { name: /audio max duration/i });
    fireEvent.change(slider, { target: { value: '120' } });
    expect(modelStoreStubRef.current.setAudioConfig).toHaveBeenCalledWith({
      maxDurationSeconds: 120,
    });
  });

  it('caps the slider max at MAX_AUDIO_DURATION_SECONDS', () => {
    render(<AudioDurationControl />);
    const slider = screen.getByRole('slider', { name: /audio max duration/i });
    expect(slider).toHaveAttribute('max', '600');
    expect(slider).toHaveAttribute('min', '1');
  });

  it('exposes the audio max duration in aria-valuetext for screen readers', () => {
    render(<AudioDurationControl />);
    const slider = screen.getByRole('slider', { name: /audio max duration/i });
    expect(slider).toHaveAttribute('aria-valuetext', '60 seconds');
  });
});

describe('MediaCostLine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('image modality', () => {
    it('displays an estimated cost when an image model is selected', () => {
      mockModels({
        models: [{ id: 'google/imagen-4', modality: 'image', pricePerImage: 0.04 }],
      });
      resetModelStoreStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: {
          text: [],
          image: [{ id: 'google/imagen-4', name: 'Imagen 4' }],
          audio: [],
          video: [],
        },
      });
      render(<MediaCostLine modality="image" />);
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
    });

    it('renders an "(estimate)" sublabel below the dollar amount', () => {
      mockModels({
        models: [{ id: 'google/imagen-4', modality: 'image', pricePerImage: 0.04 }],
      });
      resetModelStoreStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: {
          text: [],
          image: [{ id: 'google/imagen-4', name: 'Imagen 4' }],
          audio: [],
          video: [],
        },
      });
      render(<MediaCostLine modality="image" />);
      expect(screen.getByText('(estimate)')).toBeInTheDocument();
    });

    it('renders null when no image model is selected', () => {
      mockModels({ models: [] });
      resetModelStoreStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: { text: [], image: [], audio: [], video: [] },
      });
      const { container } = render(<MediaCostLine modality="image" />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('video modality', () => {
    it('displays an estimated cost for the current config', () => {
      mockModels({
        models: [
          {
            id: 'google/veo-3.1',
            modality: 'video',
            pricePerSecondByResolution: { '720p': 0.1, '1080p': 0.15 },
          },
        ],
      });
      resetModelStoreStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
        selections: {
          text: [],
          image: [],
          audio: [],
          video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
        },
      });
      render(<MediaCostLine modality="video" />);
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
    });
  });

  describe('audio modality', () => {
    it('displays an estimated cost for the current config', () => {
      mockUseModels.mockReturnValue({
        data: {
          models: [
            { id: 'openai/tts-1', modality: 'audio', pricePerSecond: 0.015 } as never,
          ] as never,
          premiumIds: new Set<string>(),
        },
      });
      resetModelStoreStub({
        activeModality: 'audio',
        audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
        selections: {
          text: [],
          image: [],
          audio: [{ id: 'openai/tts-1', name: 'TTS-1' }],
          video: [],
        },
      });
      render(<MediaCostLine modality="audio" />);
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
    });
  });

  describe('unknown selected models price at zero', () => {
    it('treats an image model missing from the catalog as zero-priced', () => {
      mockModels({
        models: [{ id: 'google/imagen-4', modality: 'image', pricePerImage: 0.04 }],
      });
      resetModelStoreStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: {
          text: [],
          image: [
            { id: 'google/imagen-4', name: 'Imagen 4' },
            { id: 'ghost/model', name: 'Ghost' },
          ],
          audio: [],
          video: [],
        },
      });
      render(<MediaCostLine modality="image" />);
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
    });

    it('treats a video model missing from the catalog as zero-priced', () => {
      mockModels({
        models: [
          {
            id: 'google/veo-3.1',
            modality: 'video',
            pricePerSecondByResolution: { '720p': 0.2 },
          },
        ],
      });
      resetModelStoreStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '16:9', resolution: '720p', durationSeconds: 4 },
        selections: {
          text: [],
          image: [],
          audio: [],
          video: [
            { id: 'google/veo-3.1', name: 'Veo 3.1' },
            { id: 'ghost/model', name: 'Ghost' },
          ],
        },
      });
      render(<MediaCostLine modality="video" />);
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
    });

    it('treats an audio model missing from the catalog as zero-priced', () => {
      mockModels({
        models: [{ id: 'openai/tts-1', modality: 'audio', pricePerSecond: 0.015 }],
      });
      resetModelStoreStub({
        activeModality: 'audio',
        audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
        selections: {
          text: [],
          image: [],
          audio: [
            { id: 'openai/tts-1', name: 'TTS-1' },
            { id: 'ghost/model', name: 'Ghost' },
          ],
          video: [],
        },
      });
      render(<MediaCostLine modality="audio" />);
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
    });
  });
});

describe('AudioFormatControl when FEATURE_FLAGS.AUDIO_ENABLED is on', () => {
  // Save/restore pattern — afterEach runs even when beforeEach throws,
  // so the flag can't leak across tests in this file.
  let originalAudioEnabled: boolean;

  beforeEach(async () => {
    const { FEATURE_FLAGS } = await import('@hushbox/shared');
    originalAudioEnabled = FEATURE_FLAGS.AUDIO_ENABLED;
    FEATURE_FLAGS.AUDIO_ENABLED = true;
    resetModelStoreStub({
      activeModality: 'audio',
      audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
      selections: {
        text: [],
        image: [],
        audio: [{ id: 'openai/tts-1', name: 'TTS-1' }],
        video: [],
      },
    });
  });

  afterEach(async () => {
    const { FEATURE_FLAGS } = await import('@hushbox/shared');
    FEATURE_FLAGS.AUDIO_ENABLED = originalAudioEnabled;
  });

  it('renders the format picker independent of the flag (parent handles flag gating)', () => {
    render(<AudioFormatControl />);
    expect(screen.getByRole('button', { name: 'mp3' })).toBeInTheDocument();
  });
});
