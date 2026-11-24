-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file"
-- Migration: billing_trial_accounts
-- Created: 2026-11-24T14:02:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- One 7-day trial per Instagram account, ever, across organizations (iteration
-- feat-instagram-dm-sending-2026-11-23-oxak, routes-final § 8.B BL7, BL18, BLC7; D73). A new billing
-- migration — no merged migration is edited.
--
--   billing.trial_accounts   every Instagram account that had the trial, in any organization:
--                            the trial start's accounts (route 102) and an account picked during a trial
--                            (sub-domain 1's pick, through billing's trial port). Append-only — no
--                            updated_*, no soft delete.
--
-- Deletion: the row must outlive its organization — an account that trialled in a deleted organization
-- must not trial again — so `organization_id` and `subscription_id` are nullable with ON DELETE SET NULL
-- (the one documented exception to "every row goes with its organization", db-changes). A row with no
-- organization matches no request's policy; only the resolver below still sees it.
--
-- RLS: the organization arm in USING and WITH CHECK, enabled and FORCED (no sweep arm — nothing sweeps it).
-- The cross-organization "had a trial anywhere" read is the SECURITY DEFINER resolver
-- `billing.resolve_trialled_instagram_user_ids(text[])` — it answers only which of the given ids already
-- had a trial (no organization), the launch's resolver form (`app.resolve_organization_public_id_for_instagram_user`);
-- the unique key on `instagram_user_id` is the final guard.

CREATE TABLE IF NOT EXISTS billing.trial_accounts (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT,
  instagram_user_id VARCHAR(30) NOT NULL,
  plan_id BIGINT NOT NULL,
  subscription_id BIGINT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trial_accounts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE SET NULL,
  CONSTRAINT trial_accounts_plan_id_plans_id_fk FOREIGN KEY (plan_id) REFERENCES billing.plans (id) ON DELETE RESTRICT,
  CONSTRAINT trial_accounts_subscription_id_subscriptions_id_fk FOREIGN KEY (subscription_id) REFERENCES billing.subscriptions (id) ON DELETE SET NULL,
  CONSTRAINT chk_trial_accounts_instagram_user_id CHECK (instagram_user_id ~ '^[0-9]{1,30}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_accounts_public_id ON billing.trial_accounts (public_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_accounts_instagram_user_id ON billing.trial_accounts (instagram_user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_trial_accounts_organization_started ON billing.trial_accounts (organization_id, started_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_trial_accounts_subscription ON billing.trial_accounts (subscription_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_trial_accounts_plan ON billing.trial_accounts (plan_id);
--> statement-breakpoint
ALTER TABLE billing.trial_accounts OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.trial_accounts TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE billing.trial_accounts_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE billing.trial_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE billing.trial_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS trial_accounts_tenant_isolation ON billing.trial_accounts;
--> statement-breakpoint
CREATE POLICY trial_accounts_tenant_isolation ON billing.trial_accounts
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
  );
--> statement-breakpoint
-- BL18: which of the given Instagram user ids already had a trial, in any organization (yes / no only).
CREATE OR REPLACE FUNCTION billing.resolve_trialled_instagram_user_ids (
  instagram_user_ids_param TEXT[]
) RETURNS SETOF TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = billing, public
AS $$
  SELECT t.instagram_user_id::text
  FROM billing.trial_accounts AS t
  WHERE t.instagram_user_id = ANY (instagram_user_ids_param);
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION billing.resolve_trialled_instagram_user_ids (TEXT[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing.resolve_trialled_instagram_user_ids (TEXT[]) TO meepzo_be_app, meepzo_be_maintenance;
