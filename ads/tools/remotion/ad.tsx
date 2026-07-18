import { AbsoluteFill, Html5Audio, Img, OffthreadVideo, Sequence, staticFile } from 'remotion';

import { ReceiptCard } from './receipt-card.js';
import { ScreenReplace } from './screen-replace.js';
import { SubtitleLine } from './subtitle-line.js';
import { musicVolume } from './music-volume.js';
import type { AdScene, AdSpec, MusicBed } from './ad-spec.js';

const SceneLayer: React.FC<{ scene: AdScene }> = ({ scene }) => {
  if (scene.type === 'receipt') {
    return <ReceiptCard lines={scene.lines} />;
  }
  if (scene.type === 'screenReplace') {
    return <ScreenReplace scene={scene} />;
  }
  return (
    <OffthreadVideo
      src={staticFile(scene.src)}
      trimBefore={scene.trimStartFrames}
      muted={scene.muted}
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
    />
  );
};

/**
 * The music bed: enters at frame 0, swells per music-volume, and hard-cuts to
 * silence at `endAtFrame` via the Sequence duration. Sequence-local frame equals
 * the composition frame because it starts at 0, so the swell frames are absolute.
 */
const MusicBed: React.FC<{ music: MusicBed }> = ({ music }) => (
  <Sequence
    from={0}
    {...(music.endAtFrame === undefined ? {} : { durationInFrames: music.endAtFrame })}
  >
    <Html5Audio src={staticFile(music.src)} volume={(frame) => musicVolume(frame, music)} />
  </Sequence>
);

/**
 * Renders an AdSpec into a Remotion tree: scene plates, overlay subtitles (the
 * subtitles ARE the VO words), the voiceover track, a music bed, and a corner
 * logo. Every placement comes from the spec in frames, so an ad is authored as
 * data — this engine is the only code that turns that data into video.
 */
export const Ad: React.FC<{ spec: AdSpec }> = ({ spec }) => (
  <AbsoluteFill style={{ backgroundColor: '#0d0d0f' }}>
    {spec.scenes.map((scene) => (
      <Sequence key={scene.id} from={scene.from} durationInFrames={scene.durationInFrames}>
        <SceneLayer scene={scene} />
      </Sequence>
    ))}
    {spec.overlays.map((overlay) => (
      <Sequence
        key={`overlay-${String(overlay.from)}`}
        from={overlay.from}
        durationInFrames={overlay.durationInFrames}
      >
        <SubtitleLine
          text={overlay.text}
          durationInFrames={overlay.durationInFrames}
          {...(overlay.emphasis === undefined ? {} : { emphasis: overlay.emphasis })}
        />
      </Sequence>
    ))}
    {spec.voiceovers.map((voiceover) => (
      <Sequence key={`vo-${String(voiceover.from)}`} from={voiceover.from}>
        <Html5Audio src={staticFile(voiceover.src)} />
      </Sequence>
    ))}
    {spec.music ? <MusicBed music={spec.music} /> : null}
    {spec.logo ? (
      <Img
        src={staticFile(spec.logo)}
        style={{ position: 'absolute', top: 48, left: 48, width: 96, height: 'auto' }}
      />
    ) : null}
  </AbsoluteFill>
);
