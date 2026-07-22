# Legacy System — File Index

Every file under `legacy/` worth reading to compile the full behavior report. All files are TypeScript (no non-.ts files exist in the tree). Generated as the first step before compiling `legacy/LEGACY-BEHAVIOR-REPORT.md`.

Total files: 374

## legacy/apps/api/src/legacy

- app.test.ts
- app.ts
- scheduled.integration.test.ts
- scheduled.test.ts
- scheduled.ts
- types.ts

## legacy/apps/api/src/legacy/constants

- auth.test.ts
- auth.ts

## legacy/apps/api/src/legacy/lib

- billing-reservation.test.ts
- billing-reservation.ts
- billing-types.ts
- broadcast.test.ts
- broadcast.ts
- classify-stream-error.test.ts
- classify-stream-error.ts
- client-ip.test.ts
- client-ip.ts
- db-helpers.test.ts
- db-helpers.ts
- error-diagnostics.test.ts
- error-diagnostics.ts
- error-response.test.ts
- error-response.ts
- evidence-config.test.ts
- evidence-config.ts
- fire-and-forget.test.ts
- fire-and-forget.ts
- gateway-config.test.ts
- gateway-config.ts
- get-user.test.ts
- get-user.ts
- media-pipeline.test.ts
- media-pipeline.ts
- modality-strategies.audio.integration.test.ts
- modality-strategies.image.integration.test.ts
- modality-strategies.test.ts
- modality-strategies.ts
- modality-strategies.video.integration.test.ts
- multi-stream.test.ts
- multi-stream.ts
- opaque-step-up.test.ts
- opaque-step-up.ts
- processed-catalog.test.ts
- processed-catalog.ts
- rate-limit.test.ts
- rate-limit.ts
- redis-registry.test.ts
- redis-registry.ts
- redis.test.ts
- redis.ts
- safe-execution-ctx.test.ts
- safe-execution-ctx.ts
- safe-json.test.ts
- safe-json.ts
- session.test.ts
- session.ts
- speculative-balance.test.ts
- speculative-balance.ts
- stream-handler.test.ts
- stream-handler.ts
- stream-pipeline.billing-mismatch.test.ts
- stream-pipeline.test.ts
- stream-pipeline.ts
- totp-step-up.test.ts
- totp-step-up.ts
- unique-violation.test.ts
- unique-violation.ts
- version-override.test.ts
- version-override.ts

## legacy/apps/api/src/legacy/lib/pre-inference

- executor.test.ts
- executor.ts
- index.ts
- smart-model-stage.test.ts
- smart-model-stage.ts
- stage-resolver.test.ts
- stage-resolver.ts
- types.ts

## legacy/apps/api/src/legacy/middleware

- constants.ts
- cors.test.ts
- cors.ts
- csrf.test.ts
- csrf.ts
- dependencies.test.ts
- dependencies.ts
- dev-only.test.ts
- dev-only.ts
- error.test.ts
- error.ts
- index.ts
- iron-session.test.ts
- iron-session.ts
- platform.test.ts
- platform.ts
- rate-limit.routes.test.ts
- rate-limit.test.ts
- rate-limit.ts
- request-log.test.ts
- request-log.ts
- require-auth.test.ts
- require-auth.ts
- require-link-guest.test.ts
- require-link-guest.ts
- require-privilege.test.ts
- require-privilege.ts
- resolve-link-guest.test.ts
- resolve-link-guest.ts
- security.test.ts
- security.ts
- version-check.test.ts
- version-check.ts

## legacy/apps/api/src/legacy/routes

- billing.test.ts
- billing.ts
- budgets.test.ts
- budgets.ts
- chat.billing-integration.test.ts
- chat.parent-chain.integration.test.ts
- chat.test.ts
- chat.ts
- conversations.test.ts
- conversations.ts
- delete-account.test.ts
- delete-account.ts
- dev.test.ts
- dev.ts
- device-tokens.test.ts
- device-tokens.ts
- forks.test.ts
- forks.ts
- health.test.ts
- health.ts
- index.ts
- keys.test.ts
- keys.ts
- links.test.ts
- links.ts
- media.test.ts
- media.ts
- members-rotation.integration.test.ts
- members.test.ts
- members.ts
- message-shares.test.ts
- message-shares.ts
- models.test.ts
- models.ts
- opaque-auth.test.ts
- opaque-auth.ts
- roadmap.test.ts
- roadmap.ts
- token-login.test.ts
- token-login.ts
- trial-chat.test.ts
- trial-chat.ts
- updates.test.ts
- updates.ts
- usage.test.ts
- usage.ts
- user-preferences.test.ts
- user-preferences.ts
- users.test.ts
- users.ts
- webhooks.test.ts
- webhooks.ts
- websocket.test.ts
- websocket.ts

## legacy/apps/api/src/legacy/services/account-deletion

- delete-user.integration.test.ts
- delete-user.test.ts
- delete-user.ts

## legacy/apps/api/src/legacy/services/ai

- billing.integration.test.ts
- e2e-catalog.fixture.ts
- image-generation.integration.test.ts
- index.test.ts
- index.ts
- integration-setup.ts
- media-assertions.ts
- mock.test.ts
- mock.ts
- model-mapping.test.ts
- model-mapping.ts
- model-view.test.ts
- model-view.ts
- real.integration.test.ts
- real.test.ts
- real.ts
- smart-model.integration.test.ts
- stream-consumer.ts
- test-model-picker.ts
- test-utilities.test.ts
- test-utilities.ts
- types.ts
- video-generation.integration.test.ts

## legacy/apps/api/src/legacy/services/ai/cassette

- canonical-request.test.ts
- canonical-request.ts
- cassette-store.test.ts
- cassette-store.ts
- recording-fetch.test.ts
- recording-fetch.ts

## legacy/apps/api/src/legacy/services/ai/mock-fixtures

- index.ts
- test-audio.ts
- test-image.ts
- test-video.ts

## legacy/apps/api/src/legacy/services/billing

- balance.test.ts
- balance.ts
- budgets.test.ts
- budgets.ts
- cost-calculator.test.ts
- cost-calculator.ts
- index.ts
- resolve.test.ts
- resolve.ts
- transaction-writer.test.ts
- transaction-writer.ts
- trial-usage.test.ts
- trial-usage.ts
- wallet-provisioning.test.ts
- wallet-provisioning.ts

## legacy/apps/api/src/legacy/services/chat

- index.ts
- max-tokens.test.ts
- max-tokens.ts
- media-strategy-test-helpers.ts
- message-deletion.test.ts
- message-deletion.ts
- message-helpers.test.ts
- message-helpers.ts
- message-persistence.test.ts
- message-persistence.ts
- regeneration-guard.test.ts
- regeneration-guard.ts
- tree-action.test.ts
- tree-action.ts
- validation.test.ts
- validation.ts

## legacy/apps/api/src/legacy/services/conversations

- conversations.test.ts
- conversations.ts
- index.ts

## legacy/apps/api/src/legacy/services/dev

- dev.test.ts
- dev.ts
- index.ts

## legacy/apps/api/src/legacy/services/email

- console.test.ts
- console.ts
- factory.ts
- index.test.ts
- index.ts
- mock.test.ts
- mock.ts
- resend.test.ts
- resend.ts
- types.test.ts
- types.ts

## legacy/apps/api/src/legacy/services/email/templates

- account-deleted.test.ts
- account-deleted.ts
- account-locked.test.ts
- account-locked.ts
- base.ts
- builder.test.ts
- builder.ts
- index.ts
- password-changed.test.ts
- password-changed.ts
- two-factor-disabled.test.ts
- two-factor-disabled.ts
- two-factor-enabled.test.ts
- two-factor-enabled.ts
- verification.test.ts
- verification.ts
- welcome.test.ts
- welcome.ts

## legacy/apps/api/src/legacy/services/forks

- forks.test.ts
- forks.ts

## legacy/apps/api/src/legacy/services/gc

- r2-gc.test.ts
- r2-gc.ts

## legacy/apps/api/src/legacy/services/helcim

- helcim.test.ts
- helcim.ts
- index.test.ts
- index.ts
- mock-webhook.test.ts
- mock-webhook.ts
- mock.test.ts
- mock.ts
- types.ts

## legacy/apps/api/src/legacy/services/keys

- index.ts
- keys.test.ts
- keys.ts

## legacy/apps/api/src/legacy/services/linear

- index.test.ts
- index.ts
- mock.test.ts
- mock.ts
- real.integration.test.ts
- real.test.ts
- real.ts
- types.ts

## legacy/apps/api/src/legacy/services/linear/mock-fixtures

- roadmap.ts

## legacy/apps/api/src/legacy/services/links

- index.ts
- links.test.ts
- links.ts

## legacy/apps/api/src/legacy/services/prompt

- builder.test.ts
- builder.ts
- types.ts

## legacy/apps/api/src/legacy/services/prompt/modules

- javascript.ts
- python.ts

## legacy/apps/api/src/legacy/services/push

- console.test.ts
- console.ts
- dispatch.test.ts
- dispatch.ts
- factory.test.ts
- factory.ts
- fcm.test.ts
- fcm.ts
- index.ts
- mock.test.ts
- mock.ts
- trigger.test.ts
- trigger.ts
- types.test.ts
- types.ts

## legacy/apps/api/src/legacy/services/roadmap

- cache.test.ts
- cache.ts
- normalize.test.ts
- normalize.ts
- pipeline.test.ts
- pipeline.ts
- types.ts

## legacy/apps/api/src/legacy/services/storage

- index.test.ts
- index.ts
- media-storage.integration.test.ts
- media-storage.test.ts
- media-storage.ts
- types.ts

## legacy/apps/api/src/legacy/services/users

- user-search.test.ts
- user-search.ts

## legacy/packages/db/src

- legacy_account-deletion-events.test.ts
- legacy_account-deletion-events.ts
- legacy_client.integration.test.ts
- legacy_client.test.ts
- legacy_client.ts

## legacy/packages/db/src/factories

- legacy_content-item.test.ts
- legacy_content-item.ts
- legacy_conversation-fork.ts
- legacy_conversation-member.test.ts
- legacy_conversation-member.ts
- legacy_conversation.test.ts
- legacy_conversation.ts
- legacy_epoch-member.test.ts
- legacy_epoch-member.ts
- legacy_epoch.test.ts
- legacy_epoch.ts
- legacy_factories.integration.test.ts
- legacy_ledger-entry.test.ts
- legacy_ledger-entry.ts
- legacy_llm-completion.test.ts
- legacy_llm-completion.ts
- legacy_media-generation.test.ts
- legacy_media-generation.ts
- legacy_message.test.ts
- legacy_message.ts
- legacy_payment.test.ts
- legacy_payment.ts
- legacy_project.test.ts
- legacy_project.ts
- legacy_shared-link.test.ts
- legacy_shared-link.ts
- legacy_usage-record.test.ts
- legacy_usage-record.ts
- legacy_user.test.ts
- legacy_user.ts
- legacy_wallet.test.ts
- legacy_wallet.ts

## legacy/packages/db/src/legacy-zod

- index.test.ts
- index.ts

## legacy/packages/realtime/src

- legacy_conversation-room.test.ts
- legacy_conversation-room.ts

## legacy/scripts

- legacy_seed-cache.test.ts
- legacy_seed-cache.ts
- legacy_seed.test.ts
- legacy_seed.ts
