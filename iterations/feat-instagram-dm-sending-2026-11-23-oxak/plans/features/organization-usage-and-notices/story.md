Status: draft
Kind: screen
Depends on: plans-billing-and-trial, instagram-sending-engine
Route review: [routes-final.md](../../routes-final.md) § 6 route 64 (usage), § 8 route 108 (the context), § 11.C (notifications)

## Stories

- As any member I want a meter "820 of 1,000 DMs used this month" so that I know how close we are to the limit.
- As an Owner or Admin I want notices at the top of the app — limit nearly reached, limit reached, payment failed, trial ends soon, plan ended, being set up, confirm your email — so that I act in time.
- As an Owner, Admin or Editor I want emails about account problems, grouped, so that I hear about a stop without being flooded.

## Rules

- The month is the calendar month in the organization's time zone; the limit is the plan's `message_month_limit` across every channel; the meter reads a short copy or Postgres (billing.plan-message-month-limit; D34, P14, P79)
- The context carries every notice's field: month usage with `ok` / `nearly` (from 80 %) / `reached`, plan access with its grace and trial end, plan choice required, connected-account count (operations.organization-notices; plan §47.8)
- Notice order: plan ended, limit reached, payment failed, trial ends soon, limit nearly reached, being set up, confirm your email; dismissing is kept by the browser (operations.organization-notices; P27)
- At 80 % and at 100 %: a notice and one email each, once per organization per month (notifications.owner-emails; D34)
- Owner emails go through the mail outbox with a dedupe key, at most one of a kind per account per 6 hours; the month emails once a month each (notifications.owner-emails, notifications.owner-email-defaults; D54)
- A reconnect-required email goes once per account or connection becoming `error` (notifications.owner-emails)
- Every role sees the meter (access.editor-viewer-roles)

## Acceptance criteria

- AC-10.1 — The usage read answers used, limit and the reset day of the organization's month, counted across every account — plans/decisions.md P14
- AC-10.2 — The context answers the month state `nearly` from 80 % and `reached` at 100 %, the plan state with its grace and trial end, whether a plan choice is required, and the connected-account count — intake-files/Instagram-DM-Sending-Plan-v8.md:8037
- AC-10.3 — Crossing 80 % sends one notice and one email per organization that month; crossing again the same month sends none — intake-files/Instagram-DM-Sending-Plan-v8.md:2027
- AC-10.4 — Reaching 100 % sends one "DM limit reached" notice and email per organization that month — intake-files/Instagram-DM-Sending-Plan-v8.md:2028
- AC-10.5 — Two servers crossing the same line at once send one email, not two — intake-files/Instagram-DM-Sending-Plan-v8.md:2666
- AC-10.6 — Owner problem emails (blocked, connection stopped, message access off, refused text, a stop over 1 hour, missed comments found) go at most once per kind per account per 6 hours — intake-files/Instagram-DM-Sending-Plan-v8.md:2667
- AC-10.7 — An account becoming `error` (alone or with its connection) produces one reconnect notice and email per account and break, never one per failed message — intake-files/Instagram-DM-Sending-Plan-v8.md:4657
- AC-10.8 — A Viewer sees the meter and the notices — intake-files/Instagram-DM-Sending-Plan-v8.md:8038
- AC-10.9 — The month resets at 00:00 on the 1st in the organization's time zone — intake-files/Instagram-DM-Sending-Plan-v8.md:2029

## Work items

- billing.plan-message-month-limit
- operations.organization-notices
- notifications.owner-emails
- notifications.owner-email-defaults
- access.editor-viewer-roles
