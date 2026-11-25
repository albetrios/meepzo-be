-- Migration: app_repair_sweep_arms
-- Created: 2026-11-25T21:00:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R47 fix at the source (merge round 2, P145):
-- two repair duties read across organizations under the retention sweep arm and join a table whose
-- policy had no such arm, so under the RLS-subject roles the join saw no row:
--
--   app.contact_activities       WC-17 (closed windows) LEFT JOINs her last DM time — with the row
--                                hidden every waiting DM read as "window closed" and was skipped
--   app.automation_reply_states  WC-18 (the reply trim) reads the automations over their limit —
--                                hidden, nothing was ever trimmed
--
-- Both get the sweep arm in USING only, bound to the maintenance role, as `app.contacts` and the
-- sending tables have it: the sweep reads every organization's rows and can write none (WITH CHECK
-- keeps the organization arm alone). No data change, no lock beyond the policy swap.

DROP POLICY IF EXISTS contact_activities_tenant_isolation ON app.contact_activities;
--> statement-breakpoint
CREATE POLICY contact_activities_tenant_isolation ON app.contact_activities
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
    OR (
      (SELECT current_setting('app.global_retention_cleanup', true)) = 'true'
      AND (SELECT current_user) = 'meepzo_be_maintenance'
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS automation_reply_states_tenant_isolation ON app.automation_reply_states;
--> statement-breakpoint
CREATE POLICY automation_reply_states_tenant_isolation ON app.automation_reply_states
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
    OR (
      (SELECT current_setting('app.global_retention_cleanup', true)) = 'true'
      AND (SELECT current_user) = 'meepzo_be_maintenance'
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
  );
