-- migration-safety: allow alter_column_type reason="widening varchar(128) to varchar(1024) is binary-coercible: Postgres changes only the catalog, with no table rewrite and no index rebuild"
-- Migration: app_instagram_messages_message_id_length
-- Created: 2026-11-26T14:00:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- Meta's real message id (`mid`) is 167 characters, past the 128 the column allowed
-- (20261125090000_app_instagram_messages.sql). Every result save of a sent message failed with
-- `value too long for type character varying(128)`, so no message was ever recorded `sent`, and the
-- steps that wait on `sent` (the public reply, the follow check's tap proof, the final message, the
-- tag) never ran. Meta documents no maximum, so the column is widened to a generous 1024
-- (INSTAGRAM_MESSAGE_ID_MAX_LENGTH). Widening a varchar is binary-coercible: catalog-only on the
-- split table and its parts, the (channel_account_id, instagram_message_id) index is kept as is.

ALTER TABLE app.instagram_messages ALTER COLUMN instagram_message_id TYPE VARCHAR(1024);
