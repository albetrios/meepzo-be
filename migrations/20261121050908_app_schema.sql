-- Migration: app_schema
-- Created: 2026-11-21T05:09:08.009Z
-- Reference: docs/reference/data/migrations.md
--
-- launch-2026-11-20-ujai, ROUTE R1 (routes-final.md § 1, IA1 / IAC1): the empty Postgres schema
-- `app` for the new `app` domain (Instagram automation — decision D1 keeps every new table in `app`).
-- No tables yet: the Instagram account tables, their keys, RLS and the two resolvers land in a
-- later migration with the first sub-domain.
--
-- Grants: exactly what every existing domain schema has —
--   * owner `meepzo_be_owner` (role taxonomy, 20260827050000); `meepzo_be_operator` and
--     `meepzo_be_migrator` reach it as owner members;
--   * `meepzo_be_app`: USAGE + default table privileges (00000000000000_init.sql);
--   * `meepzo_be_maintenance`: USAGE + default table and sequence privileges
--     (20260827010000_meepzo_be_maintenance_role.sql).
-- The `ON ALL TABLES / ALL SEQUENCES` grants those files also ran have nothing to cover in an
-- empty schema; a table added later grants itself explicitly, as `user_bug_reports` does.
--
-- Not to be confused with the `app.*` session settings (`app.current_organization_public_id`, …):
-- those are GUCs, a separate namespace from this schema.

CREATE SCHEMA IF NOT EXISTS app;

ALTER SCHEMA app OWNER TO meepzo_be_owner;

GRANT USAGE ON SCHEMA app TO meepzo_be_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO meepzo_be_app;

GRANT USAGE ON SCHEMA app TO meepzo_be_maintenance;

ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO meepzo_be_maintenance;

ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO meepzo_be_maintenance;
