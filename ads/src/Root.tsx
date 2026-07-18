import { Composition } from 'remotion';

import { Ad } from '../tools/remotion/index.js';
import { campaigns } from './campaigns.js';

/** One <Composition> per registered campaign, fed its spec as default props. */
export const Root: React.FC = () => (
  <>
    {campaigns.map((spec) => (
      <Composition
        key={spec.id}
        id={spec.id}
        component={Ad}
        durationInFrames={spec.durationInFrames}
        fps={spec.fps}
        width={spec.width}
        height={spec.height}
        defaultProps={{ spec }}
      />
    ))}
  </>
);
