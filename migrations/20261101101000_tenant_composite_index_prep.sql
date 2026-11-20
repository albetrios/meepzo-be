-- migration-transaction: none reason="CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction"
-- Migration: tenant_composite_index_prep
-- Created: 2026-11-01T10:10:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- B2-5: the database did not stop a row from pointing at another clinic's row. A composite
-- foreign key (organization_id, <column>) -> parent (organization_id, id) does — but it needs a
-- unique index on the parent's (organization_id, id) and an index on the child that leads with
-- (organization_id, <column>) for the ON DELETE / ON UPDATE action. This file builds those indexes
-- CONCURRENTLY, so no write waits; the foreign keys themselves are swapped in the next migration
-- (20261101101100_tenant_composite_foreign_keys.sql, transactional) once every index is valid.
--
-- Child indexes are partial (WHERE <column> IS NOT NULL), the shape the index hygiene gate accepts
-- for a foreign key.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_roles_organization_id_id ON tenancy.roles (organization_id, id);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memberships_organization_role ON tenancy.memberships (organization_id, role_id) WHERE role_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_membership_additional_roles_organization_membership ON tenancy.membership_additional_roles (organization_id, membership_id) WHERE membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_membership_additional_roles_organization_role ON tenancy.membership_additional_roles (organization_id, role_id) WHERE role_id IS NOT NULL;
