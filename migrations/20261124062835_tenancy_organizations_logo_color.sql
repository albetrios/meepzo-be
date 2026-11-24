-- Migration: tenancy_organizations_logo_color
-- Created: 2026-11-24T06:28:35.000Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow set_not_null_on_existing_column reason="filled above in this file; tenancy.organizations is small (one row per organization)"
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R27 (routes-final.md § 9.A.3, TN8, TNC4;
-- decision P81): the organization's tile colour.
--
--   tenancy.organizations.logo_color   one of five chip tones — sky · lavender · sage · peach ·
--                                      slate (`ORGANIZATION_LOGO_COLORS`, a subset of
--                                      `CHIP_TONE`); required; chk_organizations_logo_color.
--
-- The default is the name's colour: tenancy.fn_organization_logo_color(name) — the first 32 bits of
-- the SHA-256 of the lower-cased name, mod 5, so one name always gets one colour. It is the one
-- definition of that rule: the backfill below uses it, the application's insert names it
-- (`organizationLogoColorFromName`), and a BEFORE INSERT trigger fills a row written without a
-- colour — the previous release, which knows no `logo_color`, keeps inserting while this file
-- applies and after a rollback (expand / contract, docs/reference/data/migrations.md).
--
-- The fill writes a FORCE RLS table, so it sits between NO FORCE and FORCE ROW LEVEL SECURITY.
-- Indexes and the organization policy are unchanged.

ALTER TABLE tenancy.organizations ADD COLUMN IF NOT EXISTS logo_color varchar(10);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION tenancy.fn_organization_logo_color(name_param text) RETURNS varchar
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT (ARRAY['sky', 'lavender', 'sage', 'peach', 'slate'])[
    1 + (('x' || substr(encode(sha256(convert_to(lower(name_param), 'UTF8')), 'hex'), 1, 8))::bit(32)::bigint % 5)::int
  ]::varchar;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION tenancy.fn_fill_organization_logo_color() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.logo_color IS NULL THEN
    NEW.logo_color := tenancy.fn_organization_logo_color(NEW.name);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Functions are not PUBLIC-executable here (20261010135529: ALTER DEFAULT PRIVILEGES REVOKE EXECUTE
-- ON FUNCTIONS FROM PUBLIC); the runtime roles insert organizations, so they run both.
REVOKE EXECUTE ON FUNCTION tenancy.fn_organization_logo_color(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenancy.fn_organization_logo_color(text) TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION tenancy.fn_fill_organization_logo_color() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenancy.fn_fill_organization_logo_color() TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_organizations_logo_color ON tenancy.organizations;
--> statement-breakpoint
CREATE TRIGGER trg_organizations_logo_color
BEFORE INSERT ON tenancy.organizations
FOR EACH ROW EXECUTE FUNCTION tenancy.fn_fill_organization_logo_color();
--> statement-breakpoint
ALTER TABLE tenancy.organizations NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE tenancy.organizations SET logo_color = tenancy.fn_organization_logo_color(name) WHERE logo_color IS NULL;
--> statement-breakpoint
ALTER TABLE tenancy.organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.organizations ADD CONSTRAINT chk_organizations_logo_color CHECK (logo_color IN ('sky', 'lavender', 'sage', 'peach', 'slate')) NOT VALID;
--> statement-breakpoint
ALTER TABLE tenancy.organizations VALIDATE CONSTRAINT chk_organizations_logo_color;
--> statement-breakpoint
ALTER TABLE tenancy.organizations ALTER COLUMN logo_color SET NOT NULL;
