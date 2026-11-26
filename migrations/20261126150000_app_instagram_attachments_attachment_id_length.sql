-- migration-safety: allow alter_column_type reason="widening varchar(128) to varchar(1024) is binary-coercible: Postgres changes only the catalog, with no table rewrite and no index rebuild"
-- Migration: app_instagram_attachments_attachment_id_length
-- Created: 2026-11-26T15:00:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- Meta documents a message file's `attachment_id` only as a string — no format, no maximum — the
-- same as the message id (`mid`) whose 167-character real value overflowed its varchar(128)
-- (20261126140000_app_instagram_messages_message_id_length.sql). The attachment id had the same
-- 128 (20261125121530_app_instagram_attachments.sql), so it is widened to the same 1024
-- (INSTAGRAM_OPAQUE_ID_MAX_LENGTH) before a long one fails the save after Meta already took the upload. The
-- non-empty CHECK stays; no format CHECK is added.

ALTER TABLE app.instagram_attachments ALTER COLUMN attachment_id TYPE VARCHAR(1024);
