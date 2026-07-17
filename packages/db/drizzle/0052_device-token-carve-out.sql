-- Carve-out: device_tokens.token is push credential material (an APNs/FCM
-- device token lets a holder address a user's device), so it is never
-- panel-readable — packages/db credential-carve-out rule; precedent:
-- users.opaque_registration in 0050. device_tokens predates this migration,
-- so the 0050 blanket GRANT SELECT ON ALL TABLES (not ALTER DEFAULT
-- PRIVILEGES, which covers only future tables) is what gave the panel its
-- read; the table-level REVOKE removes it, then column-scoped SELECT restores
-- the non-credential columns. Consequence: SELECT * on device_tokens is
-- refused through the panel role (star expands to the unreadable token column).
REVOKE SELECT ON device_tokens FROM admin_sql_panel;--> statement-breakpoint
GRANT SELECT (id, user_id, platform, created_at, updated_at)
  ON device_tokens TO admin_sql_panel;
