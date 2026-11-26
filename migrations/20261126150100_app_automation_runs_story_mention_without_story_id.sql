-- Migration: app_automation_runs_story_mention_without_story_id
-- Created: 2026-11-26T15:01:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- A story mention carries no story id: Meta's story-mention webhook has only `payload.url` in its
-- attachment (the id is readable only through a separate `GET <message id>?fields=story`). The
-- trigger-targets CHECK (20261121170217_app_automation_runs.sql) required
-- trigger_instagram_story_id for `story_mention` as well as `story_reply`, so every real story
-- mention that matched an automation failed its run insert. The id is required for `story_reply`
-- only now; a story mention keeps one only when Meta sends a digits-only id
-- (chk_automation_runs_instagram_ids still holds its shape).
--
-- The CHECK is widened, never narrowed: every existing row already passes it. Added NOT VALID, then
-- validated (a split table: the parent's constraint reaches every part).

ALTER TABLE app.automation_runs DROP CONSTRAINT IF EXISTS chk_automation_runs_trigger_targets;
--> statement-breakpoint

ALTER TABLE app.automation_runs ADD CONSTRAINT chk_automation_runs_trigger_targets CHECK (
  (trigger_type NOT IN ('comment', 'live_comment', 'ad_comment') OR (trigger_instagram_media_id IS NOT NULL AND trigger_instagram_comment_id IS NOT NULL))
  AND (trigger_type <> 'story_reply' OR trigger_instagram_story_id IS NOT NULL)
) NOT VALID;
--> statement-breakpoint

ALTER TABLE app.automation_runs VALIDATE CONSTRAINT chk_automation_runs_trigger_targets;
