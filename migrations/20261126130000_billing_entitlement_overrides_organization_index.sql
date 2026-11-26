-- migration-safety: allow create_index_without_concurrently reason="billing.organization_entitlement_overrides is new and empty (created in 20261126120000, not yet deployed)"
-- Migration: billing_entitlement_overrides_organization_index
-- Created: 2026-11-26T13:00:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- Plan-gating close (P270): the organization foreign key's ON DELETE CASCADE needs an index it can use.
-- The live-key unique index is partial (WHERE deleted_at IS NULL), so it cannot serve the cascade over
-- soft-deleted rows; this full index on organization_id does (index-hygiene integration test).

CREATE INDEX IF NOT EXISTS idx_organization_entitlement_overrides_organization_id
  ON billing.organization_entitlement_overrides (organization_id);
