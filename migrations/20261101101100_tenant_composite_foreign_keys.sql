-- Migration: tenant_composite_foreign_keys
-- Created: 2026-11-01T10:11:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- B2-5: each single-column foreign key from a clinic record to another clinic's record is replaced by
-- a composite one, so the referenced row must belong to the SAME organization:
--   (organization_id, <column>) -> <parent> (organization_id, id)
-- The indexes it needs were built CONCURRENTLY by 20261101101000_tenant_composite_index_prep.sql.
-- Delete actions keep their meaning: RESTRICT and CASCADE are unchanged; SET NULL clears only the
-- referencing column (`ON DELETE SET NULL (<column>)`, PostgreSQL 15+), because clearing
-- organization_id as well would violate its NOT NULL.
--
-- Existing data: each constraint is added NOT VALID and then VALIDATEd, all in this one transaction.
-- VALIDATE reads every row as the table owner with row security set aside, so it sees every clinic's
-- rows even though the migrator is subject to FORCE ROW LEVEL SECURITY (a plain SELECT pre-check run by
-- the migrator would see none of them and pass on any data). A row that already points at another
-- organization's record stops the migration with
--   ERROR: insert or update on table "<child>" violates foreign key constraint "<name>"
--   DETAIL: Key (organization_id, <column>)=(<organization>, <id>) is not present in table "<parent>".
-- and the transaction rolls back: every old key is still in place and nothing is half-converted. Fix or
-- clear that row through the operator login, then run the migration again.
--
-- Locks: DROP CONSTRAINT takes ACCESS EXCLUSIVE on the child and the parent, held until commit, so these
-- tables wait for the whole file, including the VALIDATE scans. The runner caps each lock wait (5 s) and
-- retries the file; RLS policies and FORCE ROW LEVEL SECURITY are not touched.
--
-- Converted (3): tenancy.memberships.role_id; tenancy.membership_additional_roles.membership_id and
-- .role_id.
-- audit.logs.actor_api_key_id is not converted: the audit trail is append-only.
ALTER TABLE tenancy.memberships DROP CONSTRAINT "memberships_role_id_roles_id_fk";
--> statement-breakpoint
ALTER TABLE tenancy.memberships ADD CONSTRAINT "memberships_role_fk" FOREIGN KEY (organization_id, role_id) REFERENCES tenancy.roles (organization_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE tenancy.memberships VALIDATE CONSTRAINT "memberships_role_fk";
--> statement-breakpoint
ALTER TABLE tenancy.membership_additional_roles DROP CONSTRAINT "membership_additional_roles_membership_id_memberships_id_fk";
--> statement-breakpoint
ALTER TABLE tenancy.membership_additional_roles ADD CONSTRAINT "membership_additional_roles_membership_fk" FOREIGN KEY (organization_id, membership_id) REFERENCES tenancy.memberships (organization_id, id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE tenancy.membership_additional_roles VALIDATE CONSTRAINT "membership_additional_roles_membership_fk";
--> statement-breakpoint
ALTER TABLE tenancy.membership_additional_roles DROP CONSTRAINT "membership_additional_roles_role_id_roles_id_fk";
--> statement-breakpoint
ALTER TABLE tenancy.membership_additional_roles ADD CONSTRAINT "membership_additional_roles_role_fk" FOREIGN KEY (organization_id, role_id) REFERENCES tenancy.roles (organization_id, id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE tenancy.membership_additional_roles VALIDATE CONSTRAINT "membership_additional_roles_role_fk";
