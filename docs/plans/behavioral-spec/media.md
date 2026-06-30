# Spec family: media

**v2 owner:** `media` slice (epoch-gated presign, R2 GC) + `chat` (media turn
orchestration as workflow definitions) + `models` (modality dispatch, premium gating).

## e2e behaviors

### `e2e/chat/image-generation.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Image modality switch generates and renders the image inline | `switches to image modality, generates, and renders inline` | chat + media |
| Aspect-ratio picker updates active state; the choice flows through to the `/api/chat` request payload | `changing aspect ratio updates the active button state`, `aspect ratio choice flows through to /api/chat request payload` | chat |
| Generated image displays a cost badge and model nametag | `generated image displays cost badge and model nametag` | chat + billing |
| Page reload re-renders the generated image (persisted, presigned, decrypted client-side) | `page reload re-renders the generated image` | media |
| Regenerate replaces the image; edit regenerates with edited prompt; retry regenerates with the same prompt | `regenerate replaces the image with a fresh response`, `edit on user prompt regenerates a new image with edited content`, `retry on user prompt regenerates the image with the same prompt` | chat |
| Trial users see the image modality icon disabled with a sign-up tooltip | `trial user sees image modality icon disabled with sign-up tooltip` | chat (tier gating) |
| Download link href is a blob URL pointing at the rendered (decrypted) image | `download link href is a blob URL that points at the rendered image` | web |
| Send button disabled while generating; empty prompt never enables send | `send button is disabled while image is generating`, `empty image prompt does not enable send button` | web |
| Rendered image fits viewport/message-bubble bounds; long prompts accepted | `rendered image fits within viewport and message bubble bounds`, `long image prompt is accepted` | web |
| Free-tier users see image models locked and cannot generate (media is paid-only) | `free-tier user sees image models locked and cannot generate` | models (premium gating) |
| R2 read failure on reload renders a media-error placeholder, never a broken `<img>` | `R2 read failure on reload renders media-error placeholder, never a broken img` | media + web |

### `e2e/chat/video-generation.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Video modality switch generates and renders inline; reload re-renders; regenerate/edit/retry semantics mirror image | `switches to video modality, generates, and renders inline`, `page reload re-renders the generated video`, `regenerate replaces the video with a fresh response`, `edit on user prompt regenerates a new video with edited content`, `retry on user prompt regenerates the video with the same prompt` | chat + media |
| Resolution buttons render with quality-tier label and pixel row; resolution + 9:16 aspect choices flow to the request | `resolution buttons render with quality-tier label and pixel row`, `resolution choice flows through to /api/chat request payload`, `9:16 aspect ratio choice flows through to /api/chat request` | chat |
| Duration slider drives a live cost preview; preview increases from 1080p to 4k at fixed duration | `duration slider drives the live cost preview`, `cost preview increases when switching from 1080p to 4k at fixed duration` | billing (estimate) |
| Cost badge + nametag, viewport fit, playback controls, blob download link | `generated video displays cost badge and model nametag`, `rendered video fits within viewport and message bubble bounds`, `rendered video has playback controls`, `download link href is a blob URL for the generated video` | chat + web |
| Trial users see video disabled with sign-up tooltip; free-tier users see video models locked | `trial user sees video modality icon disabled with sign-up tooltip`, `free-tier user sees video models locked and cannot generate` | chat + models |

### `e2e/group/realtime-media.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Another member sees a generated image render in real time without refresh (media events over WS) | `Bob sees Alice-generated image render without refresh` | media + realtime |

## Integration behaviors — epoch-gated presign (the §19 "epoch-gated media authz")

### `apps/api/src/routes/media.test.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Presign requires auth; missing item → 404; non-member → 404 | `returns 401 when not authenticated`, `returns 404 when the content item does not exist`, `returns 404 when the caller is not a conversation member` | media |
| **Epoch gate:** download URL is refused for media from an epoch the user wasn't in | `rejects download URL for media from an epoch the user wasn't in` | media |
| Text content items are not downloadable (400) | `returns 400 when the content item is text (not downloadable)` | media |
| Image/video/audio items return `downloadUrl` + `expiresAt` (TTL 300 s — `packages/shared/src/constants.ts:123`) | `returns 200 with downloadUrl and expiresAt for an image content item`, `returns 200 for video content items`, `returns 200 for audio content items` | media |
| Link guests with active membership + epoch access can presign; a guest whose public key matches no active link gets 401 | `returns 200 for a link guest who is an active member with epoch access`, `returns 401 for a link guest whose public key does not match any active link` | media + identity (link-guest principal) |
| Mint failure surfaces `STORAGE_READ_FAILED` (500) | `returns 500 with STORAGE_READ_FAILED when minting fails` | media |

### Modality strategies & pipeline

| Behavior area | Source | v2 slice |
| --- | --- | --- |
| Image/video/audio request shaping, ParamSpec handling, cost estimation per modality | `apps/api/src/lib/modality-strategies.test.ts`, `modality-strategies.image.integration.test.ts`, `.video.integration.test.ts`, `.audio.integration.test.ts` | models |
| Media pipeline (media-start/media-done events, keep-alives, R2 upload, encryption-before-storage) | `apps/api/src/lib/media-pipeline.test.ts` | chat + media |

Constants pinned: `MAX_MEDIA_OBJECT_BYTES` 250 MB, video duration 1–8 s, resolutions
720p/1080p/4k, image aspect ratios, `ESTIMATED_IMAGE_BYTES` 8 MB,
`ESTIMATED_VIDEO_BYTES_PER_SECOND` 5 MB — see `constants.md`.
