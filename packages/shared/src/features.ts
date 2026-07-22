export interface Feature {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly emoji: string;
  readonly lucideIcon: string;
}

export interface PlannedFeature {
  readonly id: string;
  readonly name: string;
  readonly emoji: string;
  readonly lucideIcon: string;
}

export const SHIPPED_FEATURES: readonly Feature[] = [
  {
    id: 'multi-model-chat',
    name: 'Multi-Model Chat',
    description: 'Access GPT, Claude, Gemini, and dozens more from one place.',
    emoji: '💬',
    lucideIcon: 'MessagesSquare',
  },
  {
    id: 'model-switching',
    name: 'Model Switching',
    description: 'Change models mid-conversation. Compare outputs side by side.',
    emoji: '🔀',
    lucideIcon: 'ArrowLeftRight',
  },
  {
    id: 'document-panel',
    name: 'Document Panel',
    description: 'Code editing, rendering, and word processing in one unified panel.',
    emoji: '📄',
    lucideIcon: 'FileCode2',
  },
  {
    id: 'group-chats',
    name: 'Group Chats',
    description: 'Collaborate with others in real-time encrypted conversations.',
    emoji: '👥',
    lucideIcon: 'Users',
  },
  {
    id: 'two-factor-auth',
    name: 'Two-Factor Auth',
    description: 'TOTP-based 2FA for an extra layer of account security.',
    emoji: '🔐',
    lucideIcon: 'ShieldCheck',
  },
  {
    id: 'recovery-phrase',
    name: 'Recovery Phrase',
    description: '12-word mnemonic backup so you never lose access to your encrypted data.',
    emoji: '🔑',
    lucideIcon: 'KeyRound',
  },
  {
    id: 'smart-model-select',
    name: 'Smart Model Select',
    description: 'Auto-picks the best model for your task.',
    emoji: '⚡',
    lucideIcon: 'Sparkles',
  },
  {
    id: 'web-search',
    name: 'Web Search',
    description: 'Ground AI responses with real-time web results.',
    emoji: '🔍',
    lucideIcon: 'Globe',
  },
  {
    id: 'custom-instructions',
    name: 'Custom Instructions',
    description: 'Set persistent instructions that apply across all chats.',
    emoji: '⚙️',
    lucideIcon: 'Settings',
  },
  {
    id: 'chat-sharing',
    name: 'Chat Sharing + Sync',
    description: 'Share conversations and sync across all your devices.',
    emoji: '🔗',
    lucideIcon: 'Share2',
  },
  {
    id: 'forking',
    name: 'Conversation Forking',
    description: 'Branch conversations to explore different directions.',
    emoji: '🌿',
    lucideIcon: 'GitBranch',
  },
  {
    id: 'multi-model-response',
    name: 'Multi-Model Responses',
    description: 'Get answers from multiple models at once and compare.',
    emoji: '⚖️',
    lucideIcon: 'Layers',
  },
  {
    id: 'image-generation',
    name: 'Image Generation',
    description: 'Generate images from a text prompt.',
    emoji: '🖼️',
    lucideIcon: 'Image',
  },
  {
    id: 'video-generation',
    name: 'Video Generation',
    description: 'Create a short video from a text prompt.',
    emoji: '🎬',
    lucideIcon: 'Video',
  },
  {
    id: 'message-queue',
    name: 'Message Queue',
    description: 'Line up your next messages while a reply is still streaming.',
    emoji: '📥',
    lucideIcon: 'ListPlus',
  },
  {
    id: 'usage-dashboard',
    name: 'Usage Dashboard',
    description: 'See your spending, tokens, and cost per model on one page.',
    emoji: '📊',
    lucideIcon: 'LineChart',
  },
  {
    id: 'read-aloud',
    name: 'Read Aloud',
    description: 'Play any response as audio and listen hands-free.',
    emoji: '🔊',
    lucideIcon: 'Volume2',
  },
  {
    id: 'reasoning-effort',
    name: 'Reasoning Effort',
    description: 'Set thinking effort per message, let Auto decide, and watch the reasoning live.',
    emoji: '🧮',
    lucideIcon: 'BrainCircuit',
  },
  {
    id: 'notifications',
    name: 'Notifications',
    description: 'Email and push alerts for budgets, security, and account activity.',
    emoji: '🔔',
    lucideIcon: 'Bell',
  },
] as const;

export const COMING_SOON_FEATURES: readonly PlannedFeature[] = [
  { id: 'code-execution', name: 'Code Execution', emoji: '▶️', lucideIcon: 'Play' },
  { id: 'projects', name: 'Projects', emoji: '📁', lucideIcon: 'FolderOpen' },
  { id: 'custom-bots', name: 'Custom Bots', emoji: '🤖', lucideIcon: 'Bot' },
  { id: 'memory', name: 'Memory', emoji: '🧠', lucideIcon: 'Brain' },
  { id: 'file-handling', name: 'File Handling', emoji: '📎', lucideIcon: 'Paperclip' },
  { id: 'audio-generation', name: 'Audio Generation', emoji: '🎵', lucideIcon: 'Music' },
] as const;
