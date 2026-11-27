-- Migration: app_instagram_outgoing_messages_part_key_names
-- Created: 2026-11-27T04:00:00.000Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow rename_column_or_table reason="feat-instagram-inbox R1 follow-up: renames constraint copies only (no table or column), finishing 20261127010000's rename"
--
-- feat-instagram-inbox-2026-11-26-bcar, ROUTE row R1 follow-up: Postgres does not carry a foreign key's
-- rename down to the copies it made on each part of a partitioned table, and 20261127010000 renamed only
-- the parent's — so the parts of `app.instagram_outgoing_messages` (and of any table pointing at it) still
-- named their foreign-key copies `instagram_messages_…`, and a refused row reported that name. Renames only.

DO $$
DECLARE
  item RECORD;
  new_name TEXT;
BEGIN
  FOR item IN
    SELECT constraint_row.conname, owner.relname AS table_name
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS owner ON owner.oid = constraint_row.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = owner.relnamespace
     WHERE namespace.nspname = 'app'
       AND constraint_row.conname LIKE '%instagram\_messages%'
     ORDER BY owner.relname, constraint_row.conname
  LOOP
    new_name := replace(item.conname, 'instagram_messages', 'instagram_outgoing_messages');
    IF octet_length(new_name) > 63 THEN
      new_name := left(new_name, 54) || '_' || left(md5(new_name), 8);
    END IF;
    EXECUTE format(
      'ALTER TABLE app.%I RENAME CONSTRAINT %I TO %I',
      item.table_name,
      item.conname,
      new_name
    );
  END LOOP;
END $$;
