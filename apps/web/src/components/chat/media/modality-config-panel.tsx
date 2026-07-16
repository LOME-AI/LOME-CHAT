import * as React from 'react';
import { Button } from '@hushbox/ui';
import {
  IMAGE_ASPECT_RATIOS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  MIN_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_DURATION_SECONDS,
  AUDIO_FORMATS,
  MAX_AUDIO_DURATION_SECONDS,
} from '@hushbox/shared';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models/models';
import { useMediaCostEstimate } from '@/hooks/billing/use-media-cost-estimate';
import { agreedOptions, snapToNearest } from '@/lib/multi-model-agreement';
import { AspectRatioPill } from '@/components/chat/media/aspect-ratio-pill';
import { DurationSnapSlider } from '@/components/chat/media/duration-snap-slider';
import type { Model } from '@hushbox/shared';

interface TogglePillProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
  /** Tailwind width class; defaults to `w-28` for long labels. */
  widthClass?: string;
}

function TogglePill({
  label,
  isActive,
  onClick,
  widthClass = 'w-28',
}: Readonly<TogglePillProps>): React.JSX.Element {
  return (
    <Button
      type="button"
      size="sm"
      variant={isActive ? 'default' : 'outline'}
      aria-pressed={isActive}
      onClick={onClick}
      className={`${widthClass} whitespace-nowrap`}
    >
      {label}
    </Button>
  );
}

interface AspectRatioGroupProps {
  ratios: readonly string[];
  activeRatio: string;
  onSelect: (ratio: string) => void;
  /** Pill size — `lg` for the mobile bottom sheet, `sm` for the inline desktop row. */
  pillSize?: 'sm' | 'lg';
}

function AspectRatioGroup({
  ratios,
  activeRatio,
  onSelect,
  pillSize = 'sm',
}: Readonly<AspectRatioGroupProps>): React.JSX.Element {
  return (
    <fieldset className="flex flex-wrap items-end gap-1.5 border-0 p-0">
      <legend className="sr-only">Aspect ratio</legend>
      {ratios.map((ratio) => (
        <AspectRatioPill
          key={ratio}
          ratio={ratio}
          isActive={activeRatio === ratio}
          size={pillSize}
          onClick={() => {
            onSelect(ratio);
          }}
        />
      ))}
    </fieldset>
  );
}

/**
 * Intersect each selected model's supported aspect ratios. When the intersection
 * is empty (no models selected, or no model declares the capability) fall back
 * to the canonical list so the UX stays functional for unannotated catalogs.
 * For today's ZDR set every Imagen model shares the same 5 ratios and every Veo
 * shares the same 2, so the fallback is the common path.
 */
function aspectRatiosFor(
  selectedModels: readonly { id: string }[],
  catalog: readonly Model[] | undefined,
  fallback: readonly string[]
): readonly string[] {
  const intersection = agreedOptions<Model, string>(
    selectedModels,
    catalog,
    (model) => model.supportedAspectRatios
  );
  if (intersection.length === 0) return fallback;
  return fallback.filter((r) => intersection.includes(r));
}

interface AspectRatioControlProps {
  /** Pill size — `lg` for the mobile bottom sheet, `sm` for the inline row. */
  pillSize?: 'sm' | 'lg';
}

export function ImageAspectRatioControl({
  pillSize = 'sm',
}: Readonly<AspectRatioControlProps> = {}): React.JSX.Element {
  const aspectRatio = useModelStore((s) => s.imageConfig.aspectRatio);
  const setImageConfig = useModelStore((s) => s.setImageConfig);
  const selectedModels = useModelStore((s) => s.selections.image);
  const { data } = useModels();
  const supportedRatios = aspectRatiosFor(selectedModels, data?.models, IMAGE_ASPECT_RATIOS);

  return (
    <AspectRatioGroup
      ratios={supportedRatios}
      activeRatio={aspectRatio}
      pillSize={pillSize}
      onSelect={(ratio) => {
        setImageConfig({ aspectRatio: ratio as (typeof IMAGE_ASPECT_RATIOS)[number] });
      }}
    />
  );
}

export function VideoAspectRatioControl({
  pillSize = 'sm',
}: Readonly<AspectRatioControlProps> = {}): React.JSX.Element {
  const aspectRatio = useModelStore((s) => s.videoConfig.aspectRatio);
  const setVideoConfig = useModelStore((s) => s.setVideoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  const supportedRatios = aspectRatiosFor(selectedModels, data?.models, VIDEO_ASPECT_RATIOS);

  return (
    <AspectRatioGroup
      ratios={supportedRatios}
      activeRatio={aspectRatio}
      pillSize={pillSize}
      onSelect={(ratio) => {
        setVideoConfig({ aspectRatio: ratio as (typeof VIDEO_ASPECT_RATIOS)[number] });
      }}
    />
  );
}

type SupportedResolution = (typeof VIDEO_RESOLUTIONS)[number];

/**
 * Intersect each selected model's supported resolutions, falling back to the
 * pricing-key view when a model doesn't declare `supportedVideoResolutions`
 * explicitly. Keeps multi-model dispatches honest — the backend rejects any
 * resolution that any selected model doesn't price, so the picker mirrors the
 * intersection rather than the primary's view.
 */
function videoResolutionsFor(
  selectedModels: readonly { id: string }[],
  catalog: readonly Model[] | undefined
): readonly SupportedResolution[] {
  const intersection = agreedOptions<Model, string>(selectedModels, catalog, (model) => {
    if (model.supportedVideoResolutions !== undefined) return model.supportedVideoResolutions;
    const keys = Object.keys(model.pricePerSecondByResolution);
    if (keys.length === 0) return;
    return keys;
  });
  return VIDEO_RESOLUTIONS.filter((r) => intersection.includes(r));
}

/**
 * Consumer-friendly label paired with the raw resolution. The pixel rows
 * provide the technical value; the primary label communicates quality tier
 * for users who recognize "HD/FHD/4K" but not the px-row notation.
 */
const RESOLUTION_LABELS: Record<string, { readonly primary: string; readonly secondary: string }> =
  {
    '720p': { primary: 'HD', secondary: '720p' },
    '1080p': { primary: 'FHD', secondary: '1080p' },
    '4k': { primary: '4K', secondary: '2160p' },
  };

interface ResolutionPillProps {
  res: string;
  isActive: boolean;
  onClick: () => void;
}

function ResolutionPill({
  res,
  isActive,
  onClick,
}: Readonly<ResolutionPillProps>): React.JSX.Element {
  /* v8 ignore next -- res is always one of VIDEO_RESOLUTIONS, all of which have a RESOLUTION_LABELS entry; the ?? fallback is unreachable */
  const labels = RESOLUTION_LABELS[res] ?? { primary: res, secondary: '' };
  return (
    <Button
      type="button"
      size="sm"
      variant={isActive ? 'default' : 'outline'}
      aria-pressed={isActive}
      aria-label={res}
      onClick={onClick}
      className="flex h-14 w-16 flex-col items-center justify-center gap-0.5 p-0"
    >
      <span className="text-sm leading-none font-semibold">{labels.primary}</span>
      {/* v8 ignore next 3 -- every RESOLUTION_LABELS entry has a non-empty secondary, so the null branch is unreachable */}
      {labels.secondary ? (
        <span className="text-xs leading-none opacity-75">{labels.secondary}</span>
      ) : null}
    </Button>
  );
}

export function VideoResolutionControl(): React.JSX.Element {
  const resolution = useModelStore((s) => s.videoConfig.resolution);
  const setVideoConfig = useModelStore((s) => s.setVideoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  const supportedResolutions = videoResolutionsFor(selectedModels, data?.models);

  React.useEffect(() => {
    const first = supportedResolutions[0];
    if (first === undefined) return;
    if (!supportedResolutions.includes(resolution)) {
      setVideoConfig({ resolution: first });
    }
  }, [supportedResolutions, resolution, setVideoConfig]);

  if (supportedResolutions.length === 0) {
    return (
      <div className="text-muted-foreground text-xs italic">
        Select a video model to see resolution options.
      </div>
    );
  }

  return (
    <fieldset className="flex flex-wrap gap-1.5 border-0 p-0">
      <legend className="sr-only">Resolution</legend>
      {supportedResolutions.map((res) => (
        <ResolutionPill
          key={res}
          res={res}
          isActive={resolution === res}
          onClick={() => {
            setVideoConfig({ resolution: res });
          }}
        />
      ))}
    </fieldset>
  );
}

/**
 * Discrete duration set agreed across all selected video models, or
 * `undefined` when no constraint can be derived (no model selected, or none
 * declare `supportedVideoDurationsSeconds`). When undefined the slider falls
 * back to the global MIN/MAX range with no snap, preserving legacy behavior.
 */
function videoDurationsFor(
  selectedModels: readonly { id: string }[],
  catalog: readonly Model[] | undefined
): readonly number[] | undefined {
  if (selectedModels.length === 0) return undefined;
  const intersection = agreedOptions<Model, number>(
    selectedModels,
    catalog,
    (model) => model.supportedVideoDurationsSeconds
  );
  return intersection.length === 0 ? undefined : intersection;
}

interface VideoDurationControlProps {
  /**
   * Hide the inline "Duration" label that sits to the left of the slider.
   * Set true when the surrounding container already has a "Duration" heading
   * (e.g. the mobile bottom sheet section), otherwise the word appears twice.
   */
  hideInlineLabel?: boolean;
}

export function VideoDurationControl({
  hideInlineLabel = false,
}: Readonly<VideoDurationControlProps> = {}): React.JSX.Element {
  const durationSeconds = useModelStore((s) => s.videoConfig.durationSeconds);
  const setVideoConfig = useModelStore((s) => s.setVideoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  const supportedDurations = videoDurationsFor(selectedModels, data?.models);

  const min = supportedDurations?.[0] ?? MIN_VIDEO_DURATION_SECONDS;
  const max = supportedDurations?.at(-1) ?? MAX_VIDEO_DURATION_SECONDS;

  // Snap onto the supported set when one exists so the user can't ship a
  // duration value the backend would reject. Without a set, the slider runs
  // freely between MIN/MAX_VIDEO_DURATION_SECONDS as before.
  React.useEffect(() => {
    if (supportedDurations === undefined) return;
    if (supportedDurations.includes(durationSeconds)) return;
    const snapped = snapToNearest(supportedDurations, durationSeconds);
    if (snapped !== undefined && snapped !== durationSeconds) {
      setVideoConfig({ durationSeconds: snapped });
    }
  }, [supportedDurations, durationSeconds, setVideoConfig]);

  const handleChange = (raw: number): void => {
    const value =
      supportedDurations === undefined
        ? raw
        : /* v8 ignore next -- supportedDurations is a non-empty set here (an empty intersection collapses to undefined upstream), so snapToNearest never returns undefined */
          (snapToNearest(supportedDurations, raw) ?? raw);
    setVideoConfig({ durationSeconds: value });
  };

  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      {hideInlineLabel ? null : (
        <span className="text-muted-foreground shrink-0 text-xs">Duration</span>
      )}
      <DurationSnapSlider
        value={durationSeconds}
        min={min}
        max={max}
        {...(supportedDurations !== undefined && { snapPoints: supportedDurations })}
        ariaLabel="Video duration in seconds"
        onChange={handleChange}
      />
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{`${String(durationSeconds)}s`}</span>
    </div>
  );
}

export function AudioFormatControl(): React.JSX.Element {
  const format = useModelStore((s) => s.audioConfig.format);
  const setAudioConfig = useModelStore((s) => s.setAudioConfig);

  return (
    <fieldset className="flex flex-wrap gap-1.5 border-0 p-0">
      <legend className="sr-only">Format</legend>
      {AUDIO_FORMATS.map((f) => (
        <TogglePill
          key={f}
          label={f}
          isActive={format === f}
          onClick={() => {
            setAudioConfig({ format: f });
          }}
        />
      ))}
    </fieldset>
  );
}

export function AudioDurationControl(): React.JSX.Element {
  const maxDurationSeconds = useModelStore((s) => s.audioConfig.maxDurationSeconds);
  const setAudioConfig = useModelStore((s) => s.setAudioConfig);

  return (
    <div className="flex flex-1 items-center gap-2">
      <span className="text-muted-foreground text-xs">Max duration</span>
      <input
        type="range"
        min={1}
        max={MAX_AUDIO_DURATION_SECONDS}
        value={maxDurationSeconds}
        onChange={(e) => {
          setAudioConfig({ maxDurationSeconds: Number(e.target.value) });
        }}
        aria-label="Audio max duration in seconds"
        aria-valuetext={`${String(maxDurationSeconds)} seconds`}
        className="accent-primary h-1 flex-1"
      />
      <span className="text-muted-foreground text-xs tabular-nums">{`${String(maxDurationSeconds)}s`}</span>
    </div>
  );
}

interface MediaCostLineProps {
  modality: 'image' | 'video' | 'audio';
}

function useImageCost(): number {
  const selectedModels = useModelStore((s) => s.selections.image);
  const { data } = useModels();
  const pricesPerImage = selectedModels.map(
    (m) => data?.models.find((dm) => dm.id === m.id)?.pricePerImage ?? 0
  );
  return useMediaCostEstimate({
    modality: 'image',
    imagePricing: { pricesPerImage },
  }).estimatedDollars;
}

function useVideoCost(): number {
  const videoConfig = useModelStore((s) => s.videoConfig);
  const selectedModels = useModelStore((s) => s.selections.video);
  const { data } = useModels();
  const pricesPerSecond = selectedModels.map(
    (m) =>
      data?.models.find((dm) => dm.id === m.id)?.pricePerSecondByResolution[
        videoConfig.resolution
      ] ?? 0
  );
  return useMediaCostEstimate({
    modality: 'video',
    videoPricing: { pricesPerSecond, durationSeconds: videoConfig.durationSeconds },
  }).estimatedDollars;
}

function useAudioCost(): number {
  const audioConfig = useModelStore((s) => s.audioConfig);
  const selectedModels = useModelStore((s) => s.selections.audio);
  const { data } = useModels();
  const pricesPerSecond = selectedModels.map(
    (m) => data?.models.find((dm) => dm.id === m.id)?.pricePerSecond ?? 0
  );
  return useMediaCostEstimate({
    modality: 'audio',
    audioPricing: { pricesPerSecond, durationSeconds: audioConfig.maxDurationSeconds },
  }).estimatedDollars;
}

function selectModalityDollars(
  modality: 'image' | 'video' | 'audio',
  imageDollars: number,
  videoDollars: number,
  audioDollars: number
): number {
  if (modality === 'image') return imageDollars;
  if (modality === 'video') return videoDollars;
  return audioDollars;
}

export function MediaCostLine({
  modality,
}: Readonly<MediaCostLineProps>): React.JSX.Element | null {
  const imageDollars = useImageCost();
  const videoDollars = useVideoCost();
  const audioDollars = useAudioCost();

  const dollars = selectModalityDollars(modality, imageDollars, videoDollars, audioDollars);
  if (dollars <= 0) return null;
  return (
    <div className="text-muted-foreground flex flex-col items-end leading-tight whitespace-nowrap">
      <span className="text-xs">{`≈ $${dollars.toFixed(3)}`}</span>
      <span className="text-[10px] opacity-75">(estimate)</span>
    </div>
  );
}
