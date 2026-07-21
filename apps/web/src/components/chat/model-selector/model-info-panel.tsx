import * as React from 'react';
import {
  formatNumber,
  isExpensiveModelNano,
  nanoPricePer1k,
  nanoPriceRangePer1k,
  nanoUnitPriceUsd,
  TEST_IDS,
} from '@hushbox/shared';
import type { Model } from '@hushbox/shared';

interface ModelInfoPanelProps {
  model: Model;
  compact?: boolean;
}

/**
 * A Smart-Model pool price range from the min/max BASE nano wire rates, or
 * `Varies` when either bound is absent. Both bounds must be present to render.
 */
function priceRangeOrVaries(minRate: string | undefined, maxRate: string | undefined): string {
  return minRate !== undefined && maxRate !== undefined
    ? nanoPriceRangePer1k(BigInt(minRate), BigInt(maxRate))
    : 'Varies';
}

function SmartModelPanel({
  model,
  compact,
}: Readonly<{ model: Model; compact: boolean }>): React.JSX.Element {
  const valueClass = compact ? 'text-sm font-medium' : 'text-lg font-medium';

  return (
    <div className={compact ? 'space-y-3' : 'space-y-6'}>
      {!compact && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
            How It Works
          </div>
          <div className="text-sm">
            Analyzes each message and picks the best model automatically. Simple questions use
            affordable models. Complex tasks get the most capable models.
          </div>
        </div>
      )}

      <div>
        <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
          Input Price Range
        </div>
        <div className={valueClass}>
          {priceRangeOrVaries(model.minPricing?.inputPerToken, model.maxPricing?.inputPerToken)}
        </div>
      </div>

      <div>
        <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
          Output Price Range
        </div>
        <div className={valueClass}>
          {priceRangeOrVaries(model.minPricing?.outputPerToken, model.maxPricing?.outputPerToken)}
        </div>
      </div>

      <div>
        <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
          Capacity Limit
        </div>
        <div className={valueClass}>{formatNumber(model.contextLength)} tokens</div>
      </div>
    </div>
  );
}

function LabeledValue({
  label,
  valueClass,
  children,
}: Readonly<{
  label: string;
  valueClass?: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div>
      <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">{label}</div>
      {valueClass === undefined ? children : <div className={valueClass}>{children}</div>}
    </div>
  );
}

function ProviderRow({
  provider,
  valueClass,
}: Readonly<{ provider: string; valueClass: string }>): React.JSX.Element {
  return (
    <LabeledValue label="Provider" valueClass={`${valueClass} break-words`}>
      {provider}
    </LabeledValue>
  );
}

function DescriptionRow({ description }: Readonly<{ description: string }>): React.JSX.Element {
  return (
    <LabeledValue label="Description" valueClass="overflow-hidden text-sm break-words">
      {description}
    </LabeledValue>
  );
}

function TextStandardPanel({
  model,
  compact,
}: Readonly<{ model: Model; compact: boolean }>): React.JSX.Element {
  const valueClass = compact ? 'text-sm font-medium' : 'text-lg font-medium';

  return (
    <>
      <ProviderRow provider={model.provider} valueClass={valueClass} />

      <LabeledValue label="Input Price / Token" valueClass={valueClass}>
        {nanoPricePer1k(BigInt(model.pricing.inputPerToken ?? '0'))} / 1k
      </LabeledValue>

      <LabeledValue label="Output Price / Token" valueClass={valueClass}>
        {nanoPricePer1k(BigInt(model.pricing.outputPerToken ?? '0'))} / 1k
      </LabeledValue>

      {!compact &&
        isExpensiveModelNano(
          BigInt(model.pricing.inputPerToken ?? '0'),
          BigInt(model.pricing.outputPerToken ?? '0')
        ) && (
          <p
            className="-mt-6 mb-1 text-sm text-amber-500"
            data-testid={TEST_IDS.expensiveModelWarning}
          >
            Long chats with this model can be costly
          </p>
        )}

      <LabeledValue label="Capacity Limit" valueClass={valueClass}>
        {formatNumber(model.contextLength)} tokens
      </LabeledValue>

      {!compact && <DescriptionRow description={model.description} />}
    </>
  );
}

function ImagePanel({
  model,
  compact,
}: Readonly<{ model: Model; compact: boolean }>): React.JSX.Element {
  const valueClass = compact ? 'text-sm font-medium' : 'text-lg font-medium';

  return (
    <>
      <ProviderRow provider={model.provider} valueClass={valueClass} />
      <LabeledValue label="Price per Image" valueClass={valueClass}>
        {nanoUnitPriceUsd(BigInt(model.pricing.perImage ?? '0'), 3)}/image
      </LabeledValue>
      {!compact && <DescriptionRow description={model.description} />}
    </>
  );
}

const RESOLUTION_ORDER = ['480p', '720p', '1080p', '2k', '4k', '8k'];

function compareResolutions(a: string, b: string): number {
  const ai = RESOLUTION_ORDER.indexOf(a);
  const bi = RESOLUTION_ORDER.indexOf(b);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.localeCompare(b);
}

function VideoPanel({
  model,
  compact,
}: Readonly<{ model: Model; compact: boolean }>): React.JSX.Element {
  const valueClass = compact ? 'text-sm font-medium' : 'text-lg font-medium';
  const entries = Object.entries(model.pricing.perSecondByResolution ?? {}).toSorted(([a], [b]) =>
    compareResolutions(a, b)
  );

  return (
    <>
      <ProviderRow provider={model.provider} valueClass={valueClass} />
      <LabeledValue label="Pricing by Resolution">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-xs font-medium uppercase">
              <th className="pb-1 text-left">Resolution</th>
              <th className="pb-1 text-right">$/second</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([resolution, cost]) => (
              <tr key={resolution}>
                <td className={`${valueClass} py-1`}>{resolution}</td>
                <td className={`${valueClass} py-1 text-right`}>
                  {nanoUnitPriceUsd(BigInt(cost), 2)}/s
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </LabeledValue>
      {!compact && <DescriptionRow description={model.description} />}
    </>
  );
}

function AudioPanel({
  model,
  compact,
}: Readonly<{ model: Model; compact: boolean }>): React.JSX.Element {
  const valueClass = compact ? 'text-sm font-medium' : 'text-lg font-medium';

  // Audio inference is deferred and carries no wire pricing dimension
  // (`WireModelPricing` exposes no audio rate), so no per-second price is shown.
  return (
    <>
      <ProviderRow provider={model.provider} valueClass={valueClass} />
      {!compact && <DescriptionRow description={model.description} />}
    </>
  );
}

function StandardPanel({
  model,
  compact,
}: Readonly<{ model: Model; compact: boolean }>): React.JSX.Element {
  let inner: React.JSX.Element;
  switch (model.modality) {
    case 'text': {
      inner = <TextStandardPanel model={model} compact={compact} />;
      break;
    }
    case 'image': {
      inner = <ImagePanel model={model} compact={compact} />;
      break;
    }
    case 'video': {
      inner = <VideoPanel model={model} compact={compact} />;
      break;
    }
    case 'audio': {
      inner = <AudioPanel model={model} compact={compact} />;
      break;
    }
  }
  return <div className={compact ? 'space-y-3' : 'space-y-6'}>{inner}</div>;
}

export function ModelInfoPanel({
  model,
  compact = false,
}: Readonly<ModelInfoPanelProps>): React.JSX.Element {
  if (model.isSmartModel === true) {
    return <SmartModelPanel model={model} compact={compact} />;
  }
  return <StandardPanel model={model} compact={compact} />;
}
