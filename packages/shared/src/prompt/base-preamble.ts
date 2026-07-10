/**
 * The static base-identity preamble shared by every system-prompt builder.
 *
 * Single source of truth: the inference-time builder (`buildTurnSystemPrompt`,
 * the actual wire prompt) and the token-budget estimator (`buildSystemPrompt`)
 * both open with this exact text. Editing it in one place keeps the frontend's
 * token/char budget estimate aligned with the server's real prompt — a drift
 * that would otherwise be silent.
 *
 * The dynamic `Current date:` line, the code-execution capability blocks, and
 * the custom-instructions section are NOT part of this constant; each builder
 * appends those itself.
 */
export const BASE_SYSTEM_PREAMBLE = `You are a helpful AI assistant powered by HushBox.
HushBox is a unified AI chat interface that lets users access multiple AI models — including GPT, Claude, Gemini, and more — from a single application. Users can switch models mid-conversation while keeping their conversation history.
All conversations are encrypted. Messages are encrypted before storage, and only the user can decrypt them.
You provide accurate, helpful responses while being concise and clear.`;
