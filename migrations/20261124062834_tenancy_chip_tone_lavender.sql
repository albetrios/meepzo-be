-- Migration: tenancy_chip_tone_lavender
-- Created: 2026-11-24T06:28:34.503Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R27 (routes-final.md § 9.2 TNQ1, § 9.A.11 TNC4;
-- decision P81): the shared chip tone `lav` is renamed `lavender` everywhere — one tone list
-- (`CHIP_TONE`) serves the roles' and members' `tone` and the organization's new tile colour.
--
--   tenancy.roles.tone, tenancy.memberships.tone   every `lav` row becomes `lavender`; both CHECKs
--                                                  list `lavender` in place of `lav`.
--
-- Expand / contract (docs/reference/data/migrations.md): the previous release keeps writing `lav`
-- (its Admin role tone) while this file applies and after a rollback, so a BEFORE INSERT / UPDATE
-- trigger rewrites a written `lav` to `lavender` before the CHECK sees it. The release after this
-- one, which writes only `lavender`, may drop the two triggers and the function (contract).
--
-- The fill reads and writes two FORCE RLS tables, so each sits between NO FORCE and FORCE ROW LEVEL
-- SECURITY (lint rule force_rls_data_migration_without_owner_bracket). Both tables hold a few rows
-- per organization: one UPDATE each.

ALTER TABLE tenancy.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.memberships NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.roles DROP CONSTRAINT IF EXISTS chk_roles_tone;
--> statement-breakpoint
ALTER TABLE tenancy.memberships DROP CONSTRAINT IF EXISTS chk_memberships_tone;
--> statement-breakpoint
UPDATE tenancy.roles SET tone = 'lavender' WHERE tone = 'lav';
--> statement-breakpoint
UPDATE tenancy.memberships SET tone = 'lavender' WHERE tone = 'lav';
--> statement-breakpoint
-- The expand-phase rewrite: a `lav` the previous release writes is stored as `lavender`.
CREATE OR REPLACE FUNCTION tenancy.fn_chip_tone_lavender() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.tone = 'lav' THEN
    NEW.tone := 'lavender';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Not PUBLIC-executable (20261010135529 default privileges); the runtime roles write both tables.
REVOKE EXECUTE ON FUNCTION tenancy.fn_chip_tone_lavender() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenancy.fn_chip_tone_lavender() TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_roles_tone_lavender ON tenancy.roles;
--> statement-breakpoint
CREATE TRIGGER trg_roles_tone_lavender
BEFORE INSERT OR UPDATE OF tone ON tenancy.roles
FOR EACH ROW EXECUTE FUNCTION tenancy.fn_chip_tone_lavender();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_memberships_tone_lavender ON tenancy.memberships;
--> statement-breakpoint
CREATE TRIGGER trg_memberships_tone_lavender
BEFORE INSERT OR UPDATE OF tone ON tenancy.memberships
FOR EACH ROW EXECUTE FUNCTION tenancy.fn_chip_tone_lavender();
--> statement-breakpoint
ALTER TABLE tenancy.roles ADD CONSTRAINT chk_roles_tone CHECK (tone IN ('butter', 'lavender', 'sky', 'sage', 'blush', 'mint', 'peach', 'plum', 'lime', 'slate', 'stone')) NOT VALID;
--> statement-breakpoint
ALTER TABLE tenancy.roles VALIDATE CONSTRAINT chk_roles_tone;
--> statement-breakpoint
ALTER TABLE tenancy.memberships ADD CONSTRAINT chk_memberships_tone CHECK (tone IN ('butter', 'lavender', 'sky', 'sage', 'blush', 'mint', 'peach', 'plum', 'lime', 'slate', 'stone')) NOT VALID;
--> statement-breakpoint
ALTER TABLE tenancy.memberships VALIDATE CONSTRAINT chk_memberships_tone;
--> statement-breakpoint
ALTER TABLE tenancy.roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.memberships FORCE ROW LEVEL SECURITY;
