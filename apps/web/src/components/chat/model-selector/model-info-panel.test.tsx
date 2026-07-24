import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ModelInfoPanel } from '@/components/chat/model-selector/model-info-panel';
import type { Model } from '@hushbox/shared';

// Model fixtures carry BILLABLE (fee-inclusive) nano-USD rates in `pricing`
// (the wire shape; fees are baked at catalog ingestion). The shared nano
// formatters are pure renderers, so the rendered dollar values are the rate
// (e.g. a $0.04 base per-image rate displays as $0.046).

function buildModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    provider: 'OpenAI',
    modality: 'text' as const,
    contextLength: 128_000,
    pricing: { inputPerToken: '2500', outputPerToken: '10000' },
    capabilities: [],
    description: 'Fast and capable model from OpenAI.',
    supportedParameters: [],
    ...overrides,
  };
}

describe('ModelInfoPanel', () => {
  describe('full mode (default)', () => {
    it('renders provider name', () => {
      render(<ModelInfoPanel model={buildModel({ provider: 'Anthropic' })} />);
      expect(screen.getByText('Anthropic')).toBeInTheDocument();
    });

    it('renders input and output price labels', () => {
      render(<ModelInfoPanel model={buildModel()} />);
      expect(screen.getByText('Input Price / Token')).toBeInTheDocument();
      expect(screen.getByText('Output Price / Token')).toBeInTheDocument();
    });

    it('renders capacity in tokens', () => {
      render(<ModelInfoPanel model={buildModel({ contextLength: 128_000 })} />);
      expect(screen.getByText(/128,000 tokens/)).toBeInTheDocument();
    });

    it('renders description', () => {
      render(<ModelInfoPanel model={buildModel({ description: 'A test description.' })} />);
      expect(screen.getByText('A test description.')).toBeInTheDocument();
    });

    it('renders expensive model warning for costly models', () => {
      render(
        <ModelInfoPanel
          model={buildModel({
            pricing: { inputPerToken: '60000', outputPerToken: '240000' },
          })}
        />
      );
      expect(screen.getByTestId('expensive-model-warning')).toBeInTheDocument();
    });

    it('does not render expensive model warning for affordable models', () => {
      render(<ModelInfoPanel model={buildModel()} />);
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('renders zero token prices when a text model omits its rates', () => {
      // Empty pricing exercises the `?? '0'` BigInt fallbacks on both the
      // displayed rates and the expensive-model check.
      render(<ModelInfoPanel model={buildModel({ pricing: {} })} />);
      expect(screen.getAllByText('$0 / 1k')).toHaveLength(2);
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });
  });

  describe('compact mode', () => {
    it('omits description', () => {
      render(<ModelInfoPanel model={buildModel({ description: 'Should not appear.' })} compact />);
      expect(screen.queryByText('Should not appear.')).not.toBeInTheDocument();
      expect(screen.queryByText('Description')).not.toBeInTheDocument();
    });

    it('omits expensive model warning', () => {
      render(
        <ModelInfoPanel
          model={buildModel({
            pricing: { inputPerToken: '60000', outputPerToken: '240000' },
          })}
          compact
        />
      );
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('renders provider name', () => {
      render(<ModelInfoPanel model={buildModel({ provider: 'Google' })} compact />);
      expect(screen.getByText('Google')).toBeInTheDocument();
    });

    it('renders pricing labels', () => {
      render(<ModelInfoPanel model={buildModel()} compact />);
      expect(screen.getByText('Input Price / Token')).toBeInTheDocument();
      expect(screen.getByText('Output Price / Token')).toBeInTheDocument();
    });

    it('renders capacity', () => {
      render(<ModelInfoPanel model={buildModel({ contextLength: 200_000 })} compact />);
      expect(screen.getByText(/200,000 tokens/)).toBeInTheDocument();
    });
  });

  describe('Smart Model entry', () => {
    const smartModel = buildModel({
      id: 'smart-model',
      name: 'Auto (best for prompt)',
      isSmartModel: true,
      minPricing: { inputPerToken: '1000', outputPerToken: '2000' },
      maxPricing: { inputPerToken: '60000', outputPerToken: '240000' },
    });

    it('renders how it works section', () => {
      render(<ModelInfoPanel model={smartModel} />);
      expect(screen.getByText('How It Works')).toBeInTheDocument();
      expect(screen.getByText(/Analyzes each message/)).toBeInTheDocument();
    });

    it('renders price ranges', () => {
      render(<ModelInfoPanel model={smartModel} />);
      expect(screen.getByText('Input Price Range')).toBeInTheDocument();
      expect(screen.getByText('Output Price Range')).toBeInTheDocument();
    });

    it('renders capacity', () => {
      render(<ModelInfoPanel model={smartModel} />);
      expect(screen.getByText(/128,000 tokens/)).toBeInTheDocument();
    });

    it('shows Varies when a pool bound is absent', () => {
      render(<ModelInfoPanel model={buildModel({ isSmartModel: true })} />);
      expect(screen.getAllByText('Varies').length).toBeGreaterThan(0);
    });

    it('compact Smart Model omits how it works', () => {
      render(<ModelInfoPanel model={smartModel} compact />);
      expect(screen.queryByText('How It Works')).not.toBeInTheDocument();
      expect(screen.getByText('Input Price Range')).toBeInTheDocument();
    });
  });

  describe('image modality', () => {
    const imageModel: Model = {
      id: 'google/imagen-4',
      name: 'Imagen 4',
      provider: 'Google',
      modality: 'image' as const,
      contextLength: 0,
      pricing: { perImage: '40000000' },
      capabilities: [],
      description: 'Image generation model.',
      supportedParameters: [],
    };

    it('renders provider', () => {
      render(<ModelInfoPanel model={imageModel} />);
      expect(screen.getByText('Google')).toBeInTheDocument();
    });

    it('renders the billable price per image', () => {
      render(<ModelInfoPanel model={imageModel} />);
      expect(screen.getByText('Price per Image')).toBeInTheDocument();
      // Billable $0.04 renders as-is at 3 decimals.
      expect(screen.getByText('$0.040/image')).toBeInTheDocument();
    });

    it('renders description', () => {
      render(<ModelInfoPanel model={imageModel} />);
      expect(screen.getByText('Image generation model.')).toBeInTheDocument();
    });

    it('does not render token-based pricing', () => {
      render(<ModelInfoPanel model={imageModel} />);
      expect(screen.queryByText('Input Price / Token')).not.toBeInTheDocument();
      expect(screen.queryByText('Output Price / Token')).not.toBeInTheDocument();
    });

    it('does not render capacity', () => {
      render(<ModelInfoPanel model={imageModel} />);
      expect(screen.queryByText('Capacity Limit')).not.toBeInTheDocument();
    });

    it('does not render expensive model warning', () => {
      render(<ModelInfoPanel model={imageModel} />);
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('renders compactly without a description', () => {
      render(<ModelInfoPanel model={imageModel} compact />);
      expect(screen.getByText('Price per Image')).toBeInTheDocument();
      expect(screen.queryByText('Image generation model.')).not.toBeInTheDocument();
    });

    it('renders a zero per-image price when the rate is omitted', () => {
      // Empty pricing exercises the `perImage ?? '0'` BigInt fallback.
      render(<ModelInfoPanel model={{ ...imageModel, pricing: {} }} />);
      expect(screen.getByText('$0.000/image')).toBeInTheDocument();
    });
  });

  describe('video modality', () => {
    const videoModel: Model = {
      id: 'google/veo-3.1',
      name: 'Veo 3.1',
      provider: 'Google',
      modality: 'video' as const,
      contextLength: 0,
      pricing: {
        perSecondByResolution: { '720p': '200000000', '1080p': '400000000', '4k': '800000000' },
      },
      capabilities: [],
      description: 'Video generation model.',
      supportedParameters: [],
    };

    it('renders provider', () => {
      render(<ModelInfoPanel model={videoModel} />);
      expect(screen.getByText('Google')).toBeInTheDocument();
    });

    it('renders pricing-by-resolution table', () => {
      render(<ModelInfoPanel model={videoModel} />);
      expect(screen.getByText('Resolution')).toBeInTheDocument();
      expect(screen.getByText('$/second')).toBeInTheDocument();
    });

    it('renders each resolution row with the billable price', () => {
      render(<ModelInfoPanel model={videoModel} />);
      // Billable $/s renders as-is: 0.20, 0.40, 0.80.
      expect(screen.getByText('720p')).toBeInTheDocument();
      expect(screen.getByText('$0.20/s')).toBeInTheDocument();
      expect(screen.getByText('1080p')).toBeInTheDocument();
      expect(screen.getByText('$0.40/s')).toBeInTheDocument();
      expect(screen.getByText('4k')).toBeInTheDocument();
      expect(screen.getByText('$0.80/s')).toBeInTheDocument();
    });

    it('orders resolutions 720p before 1080p before 4k', () => {
      render(<ModelInfoPanel model={videoModel} />);
      const sd = screen.getByText('720p');
      const hd = screen.getByText('1080p');
      const ultra = screen.getByText('4k');
      expect(sd.compareDocumentPosition(hd) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(hd.compareDocumentPosition(ultra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('renders description', () => {
      render(<ModelInfoPanel model={videoModel} />);
      expect(screen.getByText('Video generation model.')).toBeInTheDocument();
    });

    it('does not render token-based pricing', () => {
      render(<ModelInfoPanel model={videoModel} />);
      expect(screen.queryByText('Input Price / Token')).not.toBeInTheDocument();
      expect(screen.queryByText('Output Price / Token')).not.toBeInTheDocument();
    });

    it('does not render capacity', () => {
      render(<ModelInfoPanel model={videoModel} />);
      expect(screen.queryByText('Capacity Limit')).not.toBeInTheDocument();
    });

    it('does not render expensive model warning', () => {
      render(<ModelInfoPanel model={videoModel} />);
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('renders compactly', () => {
      render(<ModelInfoPanel model={videoModel} compact />);
      expect(screen.getByText('720p')).toBeInTheDocument();
      expect(screen.queryByText('Video generation model.')).not.toBeInTheDocument();
    });

    it('sorts unknown resolutions after known ones and alphabetically among themselves', () => {
      const mixed: Model = {
        ...videoModel,
        pricing: {
          perSecondByResolution: { zeta: '500000000', '720p': '200000000', alpha: '300000000' },
        },
      };
      render(<ModelInfoPanel model={mixed} />);

      const known = screen.getByText('720p');
      const alpha = screen.getByText('alpha');
      const zeta = screen.getByText('zeta');
      // Known resolution precedes both unknowns; unknowns sort alphabetically.
      expect(known.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(alpha.compareDocumentPosition(zeta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('renders the resolution table with no rows when pricing is omitted', () => {
      // Absent perSecondByResolution exercises the `?? {}` fallback → empty table.
      render(<ModelInfoPanel model={{ ...videoModel, pricing: {} }} />);
      expect(screen.getByText('Resolution')).toBeInTheDocument();
      expect(screen.getByText('$/second')).toBeInTheDocument();
      expect(screen.queryByText('720p')).not.toBeInTheDocument();
    });
  });

  describe('audio modality', () => {
    const audioModel: Model = {
      id: 'openai/tts-1',
      name: 'TTS 1',
      provider: 'OpenAI',
      modality: 'audio' as const,
      contextLength: 0,
      pricing: {},
      capabilities: [],
      description: 'Audio synthesis model.',
      supportedParameters: [],
    };

    it('renders provider', () => {
      render(<ModelInfoPanel model={audioModel} />);
      expect(screen.getByText('OpenAI')).toBeInTheDocument();
    });

    it('renders no price row (audio carries no wire pricing)', () => {
      render(<ModelInfoPanel model={audioModel} />);
      expect(screen.queryByText('Price per Second')).not.toBeInTheDocument();
    });

    it('renders description', () => {
      render(<ModelInfoPanel model={audioModel} />);
      expect(screen.getByText('Audio synthesis model.')).toBeInTheDocument();
    });

    it('does not render token-based pricing', () => {
      render(<ModelInfoPanel model={audioModel} />);
      expect(screen.queryByText('Input Price / Token')).not.toBeInTheDocument();
      expect(screen.queryByText('Output Price / Token')).not.toBeInTheDocument();
    });

    it('does not render capacity', () => {
      render(<ModelInfoPanel model={audioModel} />);
      expect(screen.queryByText('Capacity Limit')).not.toBeInTheDocument();
    });

    it('does not render expensive model warning', () => {
      render(<ModelInfoPanel model={audioModel} />);
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('renders compactly without a description', () => {
      render(<ModelInfoPanel model={audioModel} compact />);
      expect(screen.getByText('OpenAI')).toBeInTheDocument();
      expect(screen.queryByText('Audio synthesis model.')).not.toBeInTheDocument();
    });
  });
});
