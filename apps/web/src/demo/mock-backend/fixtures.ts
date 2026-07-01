/**
 * The demo's canned conversations, authored as PLAINTEXT and organized by the
 * product feature each one showcases.
 *
 * Solo conversations carry a `script`: an ordered list of turns the typing
 * director replays live (it switches modality, types the prompt, sends, and the
 * store streams the reply). They are served EMPTY and rebuilt on every open, so
 * a conversation never "comes pre-done". The group conversation carries a
 * pre-built `messages` transcript (multi-party messages arrive over the
 * websocket in the real app).
 *
 * The store encrypts everything at boot with real `@hushbox/crypto` so the
 * unmodified app decrypt path renders it.
 */
import { DEMO_SCENE_IMAGE, DEMO_GENERATED_VIDEO, type DemoAsset } from './media-assets';

export const DEMO_USER = {
  id: 'demo-user',
  username: 'demo',
  email: 'demo@hushbox.ai',
} as const;

/** Composer modality a conversation showcases; the director switches to it. */
export type DemoModality = 'text' | 'image' | 'video';

export interface DemoTextContent {
  readonly type: 'text';
  readonly text: string;
}

/** A bundled media asset the store encrypts and serves at a `data:` URL. */
export interface DemoMediaContent {
  readonly type: 'image' | 'video';
  readonly asset: DemoAsset;
  /** Playback duration for video assets (drives the media chrome). */
  readonly durationMs?: number;
}

export type DemoContent = DemoTextContent | DemoMediaContent;

/**
 * One scripted exchange the director replays: it types `user` into the composer
 * and sends; the store streams `ai` back. `ai` may be text and/or media.
 */
export interface DemoTurn {
  readonly user: string;
  readonly ai: readonly DemoContent[];
  /** AI model id (drives the nametag). */
  readonly modelName?: string;
  /** Renders the "Smart" chip and smart-routing nametag. */
  readonly isSmartModel?: boolean;
}

export interface DemoMessage {
  readonly sender: 'user' | 'ai';
  readonly content: readonly DemoContent[];
  readonly modelName?: string;
  readonly isSmartModel?: boolean;
  /** Group-chat participant id (matches a member's userId). */
  readonly senderId?: string;
}

/** A group-chat participant. The store expands these into wire members. */
export interface DemoParticipant {
  readonly userId: string;
  readonly username: string;
  readonly privilege: 'owner' | 'admin' | 'write' | 'read';
}

export interface DemoConversation {
  readonly id: string;
  readonly title: string;
  /** Composer modality; the director switches to it before replaying. Defaults to text. */
  readonly modality?: DemoModality;
  /** Solo conversations: the turns the director replays live (served empty until then). */
  readonly script?: readonly DemoTurn[];
  /** Group conversations: a pre-built transcript plus the member roster. */
  readonly messages?: readonly DemoMessage[];
  readonly members?: readonly DemoParticipant[];
}

const t = (text: string): DemoTextContent => ({ type: 'text', text });
const image = (asset: DemoAsset): DemoMediaContent => ({ type: 'image', asset });
const video = (asset: DemoAsset): DemoMediaContent => ({
  type: 'video',
  asset,
  ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
});

/**
 * The conversation the demo auto-opens first on boot — a normal listed sidebar
 * conversation, just the one the director plays before the user clicks anything.
 */
export const DEMO_BOOT_ID = 'demo-welcome';

export const DEMO_CONVERSATIONS: readonly DemoConversation[] = [
  {
    id: DEMO_BOOT_ID,
    title: 'Welcome to HushBox',
    modality: 'text',
    script: [
      {
        user: 'What is HushBox?',
        modelName: 'anthropic/claude-sonnet-4',
        ai: [
          t(
            'HushBox is one encrypted chat app for every major AI model: GPT, Claude, Gemini, ' +
              'and 100+ others, all behind a single interface.\n\n' +
              '- Switch models in the middle of a conversation\n' +
              '- No separate subscriptions; you only pay for what you use\n' +
              '- Everything you write is encrypted before it is saved\n\n' +
              'When a newer model launches, you just pick it from the dropdown. No migrating.'
          ),
        ],
      },
      {
        user: "If it's encrypted, how can the AI still read my messages?",
        modelName: 'anthropic/claude-sonnet-4',
        ai: [
          t(
            'Good question. Your messages are encrypted in your browser, so HushBox ' +
              'servers only ever store scrambled data they cannot read.\n\n' +
              'When you send a message, it is decrypted just long enough for the AI ' +
              'model to answer it, and we only work with providers who promise never to ' +
              'log it or train on it. The AI sees the question, never who is asking.'
          ),
        ],
      },
    ],
  },
  {
    id: 'demo-smart-model',
    title: 'Smart model routing',
    modality: 'text',
    script: [
      {
        user: 'There are so many AI models. How do I know which one to use?',
        isSmartModel: true,
        modelName: 'openai/gpt-4o',
        ai: [
          t(
            "That's what **Smart Model** is for. It is the default: it reads each " +
              'message and automatically picks the model that fits.\n\n' +
              '- Quick lookups go to a fast, lightweight model\n' +
              '- Hard reasoning goes to a frontier model\n\n' +
              'You never have to touch the dropdown. Smart Model chooses for you.'
          ),
        ],
      },
      {
        user: 'What if I want to choose the model myself?',
        isSmartModel: true,
        modelName: 'openai/gpt-4o',
        ai: [
          t(
            'You still can. Pick any model from the dropdown and resend, and Smart Model steps ' +
              'aside. It is the default that saves you guessing, never a lock-in.'
          ),
        ],
      },
    ],
  },
  {
    id: 'demo-code-math',
    title: 'Code, math & diagrams',
    modality: 'text',
    script: [
      {
        user: 'Show me binary search in TypeScript and its complexity.',
        modelName: 'anthropic/claude-sonnet-4',
        ai: [
          t(
            'Binary search halves the range each step:\n\n' +
              '```ts\n' +
              'function search(xs: number[], target: number): number {\n' +
              '  let lo = 0;\n' +
              '  let hi = xs.length - 1;\n' +
              '  while (lo <= hi) {\n' +
              '    const mid = (lo + hi) >> 1;\n' +
              '    if (xs[mid] === target) return mid;\n' +
              '    if (xs[mid] < target) lo = mid + 1;\n' +
              '    else hi = mid - 1;\n' +
              '  }\n' +
              '  return -1;\n' +
              '}\n' +
              '```\n\n' +
              'It runs in `O(log n)` time and `O(1)` space.'
          ),
        ],
      },
    ],
  },
  {
    id: 'demo-image',
    title: 'Image generation',
    modality: 'image',
    script: [
      {
        user: 'Generate a surreal jellyfish drifting through a moonlit sky.',
        modelName: 'black-forest-labs/flux-1.1-pro',
        ai: [image(DEMO_SCENE_IMAGE)],
      },
    ],
  },
  {
    id: 'demo-video',
    title: 'Video generation',
    modality: 'video',
    script: [
      {
        user: 'Generate a short flight through a glowing fractal tunnel.',
        modelName: 'google/veo-3',
        ai: [video(DEMO_GENERATED_VIDEO)],
      },
    ],
  },
  {
    id: 'demo-group',
    title: 'Group chat',
    members: [
      { userId: DEMO_USER.id, username: 'demo', privilege: 'owner' },
      { userId: 'demo-user-amir', username: 'amir', privilege: 'write' },
      { userId: 'demo-user-sana', username: 'sana', privilege: 'write' },
    ],
    // The demo user opens the group ("starts with us"); the others reply over
    // the socket. Sana's encryption line stays last as the showcase.
    messages: [
      {
        sender: 'user',
        senderId: DEMO_USER.id,
        content: [
          t(
            'Welcome to the group! This is a shared chat we can all use together, with AI right here in it.'
          ),
        ],
      },
      {
        sender: 'user',
        senderId: 'demo-user-amir',
        content: [
          t('Nice. And since this is HushBox, it stays private even with a few of us in here?'),
        ],
      },
      {
        sender: 'user',
        senderId: 'demo-user-sana',
        content: [t('Every message here is end-to-end encrypted, even in a group like this one.')],
      },
    ],
  },
];
