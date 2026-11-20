-- Migration: user_erasure_attribution_set_null
-- Created: 2026-11-01T10:00:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- G2-2: a departed clinician's account data was never erased. Every attribution column that
-- records who created or last changed a row (created_by_user_id / updated_by_user_id) referenced
-- auth.users with NO ACTION, so the tombstone purge of a user row failed on the first record that
-- user had touched, and the retention job skipped the row: the account (email, name, password
-- hash) was kept forever. The record outlives the person who touched it, so each such reference
-- becomes ON DELETE SET NULL — the same meaning as the attribution columns already converted by
-- 20261010152248_user_erasure_foreign_keys.sql. Each column is nullable, so no NOT NULL changes.
--
-- The one NO ACTION reference left on auth.users is tenancy.organizations.owner_user_id: a user
-- who owns a team organization cannot be deleted until ownership is transferred, and the personal
-- organization is tombstoned with its owner. The policy test
-- src/tests/integration/database/user-erasure-foreign-keys.integration.test.ts pins this set.
--
-- Constraint names are kept; each is re-added NOT VALID and validated (no long lock).

ALTER TABLE tenancy.membership_additional_roles DROP CONSTRAINT "membership_additional_roles_created_by_user_id_users_id_fk", ADD CONSTRAINT "membership_additional_roles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES auth.users ("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE tenancy.membership_additional_roles VALIDATE CONSTRAINT "membership_additional_roles_created_by_user_id_users_id_fk";
