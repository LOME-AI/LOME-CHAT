/**
 * The accepted image mime types for media I/O — the single allowlist shared by
 * the workflow engine's derived media ports and the chat media-turn definition.
 * Kept as a non-empty tuple so it satisfies the `readonly [string, ...string[]]`
 * shape those TypeTag mime sets require.
 */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
