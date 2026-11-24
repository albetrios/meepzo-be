-- Migration: auth_sessions_place
-- Created: 2026-11-24T12:00:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R33 (routes-final.md § 10.D AT18, ATC11; P86):
-- each session's place. When a session is made, and when a refresh comes from a new IP, the city
-- and country of its IP are looked up in a local IP-to-place file (DB-IP "IP to City Lite") and
-- kept here; GET /auth/me/sessions answers them as `place`. Both columns stay null when the file
-- has no match or there is no file.
--
-- Two nullable columns with no default: a catalog-only change, no table rewrite. The country CHECK
-- is added NOT VALID and validated in its own step (every existing row is null, so the scan only
-- reads). No new index — the place is never filtered on. Row-level security is unchanged (the
-- sessions_user_access policy, as built).

ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS place_city VARCHAR(100);
--> statement-breakpoint
ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS place_country VARCHAR(2);
--> statement-breakpoint
ALTER TABLE auth.sessions ADD CONSTRAINT chk_sessions_place_country CHECK (place_country ~ '^[A-Z]{2}$') NOT VALID;
--> statement-breakpoint
ALTER TABLE auth.sessions VALIDATE CONSTRAINT chk_sessions_place_country;
