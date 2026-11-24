-- migration-transaction: none reason="CREATE INDEX CONCURRENTLY cannot run inside a transaction"
--
-- Back the segments' account key with an index its ON DELETE CASCADE can use
-- (feat-instagram-dm-sending R21, BC1 — found by the lane B merge of R21).
--
--   app.segments (organization_id, channel_account_id) → app.channel_accounts  ON DELETE CASCADE
--
-- 20261124184321_app_segments.sql leads both route-77 indexes with (organization_id,
-- channel_account_id), but both are partial on `deleted_at IS NULL`; the cascade deletes every
-- segment of the account, soft-deleted ones included, so it cannot use them and scans the table
-- per deleted account (src/tests/integration/database/index-hygiene.integration.test.ts). A full
-- two-column index, the shape of 20260923152433_index_uncovered_foreign_keys.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_segments_channel_account
  ON app.segments USING btree (organization_id, channel_account_id);
