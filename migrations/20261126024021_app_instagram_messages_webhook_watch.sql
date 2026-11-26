-- Migration: app_instagram_messages_webhook_watch
-- Created: 2026-11-26T02:40:21.834Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, owner decision 2026-11-26 "Detect + guide now" (P358):
-- Meta's temporary Unified Login limit — an Instagram account shared WITHOUT its linked Facebook
-- Page may receive no `messages` webhooks although `subscribed_apps` succeeded. Two marks on the
-- Instagram extension let the 10-minute subscription check (WC-25) see it:
--
--   messages_webhook_seen_at     the last time a messaging webhook item (a message, an echo, a
--                                postback, a reaction, …) arrived for the account; written by the
--                                webhook store at most once an hour (and whenever it clears the
--                                flag below); empty until the first one
--   messages_webhook_missing_at  set by the subscription check when the account was subscribed for
--                                more than 24 hours, no messaging item arrived since, and Meta's
--                                conversations read shows activity after the subscription — the
--                                owner is told once to reconnect sharing the linked Page; emptied
--                                by the next messaging item (and with the webhook stamp)
--
-- Two nullable columns, no default, no constraint, no index (both are read and written by the
-- account's key). RLS unchanged: the table's organization policy covers them.

ALTER TABLE app.instagram_accounts ADD COLUMN IF NOT EXISTS messages_webhook_seen_at TIMESTAMPTZ;
--> statement-breakpoint
ALTER TABLE app.instagram_accounts ADD COLUMN IF NOT EXISTS messages_webhook_missing_at TIMESTAMPTZ;
