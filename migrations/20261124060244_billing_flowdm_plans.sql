-- Migration: billing_flowdm_plans
-- Created: 2026-11-24T06:02:44.345Z
-- Reference: docs/reference/data/migrations.md
--
-- The Flowdm plans (iteration feat-instagram-dm-sending-2026-11-23-oxak, routes-final § 8.A BL11–BL13,
-- P37, P79, P80, P83, D55). A new billing migration — no merged migration is edited (AC-11.14).
--
--   1. Every existing row: typed features (the two limits, priority support, one switch per feature key),
--      seats empty (unlimited members). Free keeps $0 and gets Free's features; any other row but
--      Creator and Studio — Starter, Growth, Pro — is turned off and holds Free's features and limits,
--      so an organization still on one is held to Free until it picks Creator or Studio (P80). Billing
--      rows are never deleted; Stripe is not touched.
--   2. Free, Creator and Studio inserted when missing (a fresh database; Creator and Studio everywhere),
--      prices are placeholders (P37); Stripe product and price ids stay empty until go-live.
--   3. The `features` default `{}` dropped and `chk_plans_features` added (NOT VALID, then VALIDATE).
--
-- billing.plans is FORCE RLS (plans_deny_all / plans_app_access), so the data statements sit between
-- NO FORCE and FORCE in this transactional file. The previous release never writes plan rows (only the
-- seed CLI and the test factory do), so the new CHECK refuses nothing it writes at runtime.

ALTER TABLE billing.plans NO FORCE ROW LEVEL SECURITY;

UPDATE billing.plans
SET
  features = CASE name
    WHEN 'Creator' THEN '{"message_month_limit": 10000, "channel_accounts_max": 3, "has_priority_support": false, "feature_switches": {"email_ask": true, "phone_ask": true, "reply_like_person": true, "multiple_public_reply_lines": true, "message_versions": true, "broadcasts": true, "segments": true, "past_comments": true, "extra_delay": true, "starter_questions": true, "mark_seen": true}}'::jsonb
    WHEN 'Studio' THEN '{"message_month_limit": 50000, "channel_accounts_max": 10, "has_priority_support": true, "feature_switches": {"email_ask": true, "phone_ask": true, "reply_like_person": true, "multiple_public_reply_lines": true, "message_versions": true, "broadcasts": true, "segments": true, "past_comments": true, "extra_delay": true, "starter_questions": true, "mark_seen": true}}'::jsonb
    ELSE '{"message_month_limit": 1000, "channel_accounts_max": 1, "has_priority_support": false, "feature_switches": {"email_ask": false, "phone_ask": false, "reply_like_person": false, "multiple_public_reply_lines": false, "message_versions": false, "broadcasts": false, "segments": false, "past_comments": false, "extra_delay": false, "starter_questions": true, "mark_seen": true}}'::jsonb
  END,
  is_active = name IN ('Free', 'Creator', 'Studio'),
  included_seats = NULL,
  updated_at = GREATEST(now(), created_at);

INSERT INTO billing.plans (public_id, name, price_monthly, price_yearly, currency, features, is_active)
VALUES ('pln_' || (SELECT string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + floor(random() * 36)::int, 1), '') FROM generate_series(1, 21)), 'Free', 0.00, 0.00, 'USD', '{"message_month_limit": 1000, "channel_accounts_max": 1, "has_priority_support": false, "feature_switches": {"email_ask": false, "phone_ask": false, "reply_like_person": false, "multiple_public_reply_lines": false, "message_versions": false, "broadcasts": false, "segments": false, "past_comments": false, "extra_delay": false, "starter_questions": true, "mark_seen": true}}'::jsonb, true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO billing.plans (public_id, name, price_monthly, price_yearly, currency, features, is_active)
VALUES ('pln_' || (SELECT string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + floor(random() * 36)::int, 1), '') FROM generate_series(1, 21)), 'Creator', 29.00, 276.00, 'USD', '{"message_month_limit": 10000, "channel_accounts_max": 3, "has_priority_support": false, "feature_switches": {"email_ask": true, "phone_ask": true, "reply_like_person": true, "multiple_public_reply_lines": true, "message_versions": true, "broadcasts": true, "segments": true, "past_comments": true, "extra_delay": true, "starter_questions": true, "mark_seen": true}}'::jsonb, true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO billing.plans (public_id, name, price_monthly, price_yearly, currency, features, is_active)
VALUES ('pln_' || (SELECT string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + floor(random() * 36)::int, 1), '') FROM generate_series(1, 21)), 'Studio', 79.00, 756.00, 'USD', '{"message_month_limit": 50000, "channel_accounts_max": 10, "has_priority_support": true, "feature_switches": {"email_ask": true, "phone_ask": true, "reply_like_person": true, "multiple_public_reply_lines": true, "message_versions": true, "broadcasts": true, "segments": true, "past_comments": true, "extra_delay": true, "starter_questions": true, "mark_seen": true}}'::jsonb, true)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE billing.plans ALTER COLUMN features DROP DEFAULT;

ALTER TABLE billing.plans
  ADD CONSTRAINT chk_plans_features
  CHECK (
    CASE WHEN jsonb_typeof(features) = 'object' THEN
      features ?& ARRAY['message_month_limit', 'channel_accounts_max', 'has_priority_support', 'feature_switches']
      AND (features - ARRAY['message_month_limit', 'channel_accounts_max', 'has_priority_support', 'feature_switches']) = '{}'::jsonb
      AND jsonb_typeof(features -> 'message_month_limit') = 'number'
      AND jsonb_typeof(features -> 'channel_accounts_max') = 'number'
      AND jsonb_typeof(features -> 'has_priority_support') = 'boolean'
      AND jsonb_typeof(features -> 'feature_switches') = 'object'
      AND NOT jsonb_path_exists(features, '$.feature_switches.* ? (@.type() != "boolean")')
    ELSE false END
  )
  NOT VALID;

ALTER TABLE billing.plans VALIDATE CONSTRAINT chk_plans_features;

ALTER TABLE billing.plans FORCE ROW LEVEL SECURITY;
