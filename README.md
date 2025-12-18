# LOME-CHAT

**One interface. Every AI model. Your data stays yours.**

LOME-CHAT is a unified AI chat interface that lets you access GPT, Claude, Gemini, Grok, and dozens of other models from a single application. Switch models mid-conversation. Keep your history forever. Never manage another AI subscription.

🌐 [lome-chat.com](https://lome-chat.com)

---

## The Problem

Every few months, a new "best AI model" launches. The cycle is exhausting:

```
1. New model releases, everyone says it's the best
         ↓
2. Sign up for new service, enter payment info
         ↓
3. Learn new interface, find the features
         ↓
4. Conversations stuck in old platform
         ↓
5. Managing multiple subscriptions
         ↓
6. Another new model releases...
         ↓
   (repeat forever)
```

Your AI history is fragmented across ChatGPT, Claude, Gemini, Perplexity, and whatever launched last week. Each has different features, different interfaces, different billing. You're locked into ecosystems that don't talk to each other.

---

## The Solution

LOME-CHAT ends the cycle. One interface, every model, forever.

When a new model launches, you don't migrate—you just select it from the dropdown. Your conversations, your projects, your workflow stay exactly where they are. The AI industry moves fast. Your tools shouldn't force you to move with it.

---

## Our Principles

### Privacy First

We believe your conversations with AI are deeply personal. They contain your ideas, your questions, your work.

**What we control (and guarantee):**
- We never sell your data
- We never train on your conversations
- We never share your information with data brokers
- Local-only conversations never touch our servers

**Pseudo-anonymity:**
When your messages reach AI providers, they see LOME-CHAT's credentials—not yours. Providers cannot link messages to your identity. However, avoid including personal information in messages (names, addresses, financial details) as message content is visible to model providers.

**What we cannot control:**
- Model providers (OpenAI, Anthropic, Google) have their own data policies
- We cannot guarantee providers don't log or train on message content
- Messages are not end-to-end encrypted

**For maximum privacy:**
- Use Local-Only mode (stored only in your browser)
- Avoid including personal information in messages

### Radical Transparency

We charge a **5% fee** on AI model usage. That's it. No hidden fees. No premium tiers that unlock basic features. No "free" tier subsidized by selling your data.

You pay for what you use. We take a small cut to keep the lights on. The math is simple and public.

### No Data Monetization

We will never:
- Sell your conversations to third parties
- Use your data for advertising
- Train AI models on your chats
- Share your information with data brokers

This isn't a marketing promise—it's our business model. We make money from the 5% fee. We have no incentive to monetize your data because we've built a sustainable business without it.

---

## Features

- **Multi-Model Chat** — GPT, Claude, Gemini, Grok, and more from one interface
- **Model Switching** — Change models mid-conversation, compare outputs
- **Unified Document Panel** — Code editing, rendering, and word processing in one place
- **Code Execution** — Run Python and JavaScript in secure sandboxes
- **Local-Only Mode** — Conversations that never leave your browser
- **Project Organization** — Group conversations, files, and context together

See [docs/FEATURES.md](./docs/FEATURES.md) for the complete feature list and development phases.

---

## Contributing

We welcome contributions from the community. To get started:

1. **Read the documentation**
    - [docs/TECH_STACK.md](./docs/TECH_STACK.md) — Complete technology decisions
    - [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) — Development setup and guidelines

2. **Set up local development**
   ```bash
   git clone https://github.com/ctf05/LOME-CHAT.git
   cd lome-chat
   pnpm install
   pnpm dev
   ```

3. **Pick something to work on**
    - Browse open issues or start a discussion with your idea
    - All contributions welcome—code, docs, bug reports, feedback

4. **Submit a PR**
    - All PRs require passing tests
    - Real API integration tests run when a LOME team member comments "pr test"

---

## License & Legal

This software is proprietary. The source code is visible for transparency, but usage rights require explicit permission from LOME-AI LLC. See [LICENSE](./LICENSE) for details.

All code in this repository, including all contributions, is the sole property of **LOME-AI LLC**.

### Contributor License Agreement

Contributors agree to our [Contributor License Agreement](./CLA.md) before pull requests can be merged. This is standard practice for projects that need clear ownership of contributions. A GitHub bot will prompt you when you open your first PR.

---

## Contact

- **Website:** [lome-chat.com](https://lome-chat.com)
- **Email:** hello@lome-chat.com
- **Security Issues:** security@lome-chat.com

---

*Built with privacy in mind by LOME-AI LLC.*