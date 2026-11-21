Status: ready
Kind: flow
Depends on: contacts, automations, webhook-events
Route review: [routes-final.md](../../routes-final.md) § 2 — CT7–CT9, CT11; § 3.B — AU25, AU26 (with § 3.2 AQ7); § 4.B — WH18, WH19
Tables: `app.contacts`, `app.automations`, `app.automation_runs`, `app.automation_run_events`, `app.automation_comment_logs`, `app.instagram_webhook_events`, `app.instagram_media`

## Stories

- As an Instagram user I want my personal data removed from every copy when the team deletes me as a contact so that my request is fully honoured.
- As an Owner I want a run that waits too long to be cancelled after 7 days so that a stale flow does not fire weeks later.
- As an Owner I want old runs, comment logs, webhook events and deleted automations removed on a fixed schedule so that we keep only what we need.
- As an Owner I want contacts and stored posts kept until we delete them or the organization goes so that our lead list stays complete.

## Rules

- A run waiting more than 7 days is cancelled with a history entry; its comment log is marked cancelled; its saved automations never start; the contact may then trigger that automation again; a run that got its answer just before is not cancelled (background.waiting-run-cancel; D8)
- A disconnect cancels no run; the 7-day limit ends the waits that are never answered (background.waiting-run-cancel; D24)
- Runs and their history go 180 days after the run ended; open runs never go; their comment logs stay without the run (background.run-retention, data.retention; D8)
- Comment logs go 180 days after they were written (background.comment-log-retention, data.retention; D8)
- Webhook events go 30 days after they arrived, whatever their status (background.webhook-event-retention, data.retention; D8)
- A deleted automation goes for good 180 days after its delete, once no run or comment log points at it; one still pointed at waits for a later day (background.deleted-automation-purge; D26)
- Contacts and stored posts have no clean-up timer: they stay until the organization is deleted, the team deletes the contact, or Meta's data deletion erases the posts (data.retention; D8, D22)
- Deleting a contact reaches every copy in the same step, all or nothing: its running and waiting runs are cancelled (one history entry each, saved automations dropped), the trigger text of all its runs is cleared, and its comment logs lose the comment text, the commenter's id and username, and the email and phone received; the ids of posts, stories and comments stay (data.erasure; D25)
- A deleted contact's webhook events are not erased then: they stay, payload masked in the list, until the 30-day clean-up (data.erasure; D25)
- A run whose contact was deleted meanwhile stops before it messages anyone (quality.personal-data; D25)
- Deleting an organization removes all its Instagram, contact, automation and webhook-event data (data.erasure, data.organization-scope)
- Every clean-up is safe to skip or repeat, and changes each organization's data inside that organization only (background.organization-scope)
- Contact personal data — email, phone, name, username, picture, message text — is masked in logs (quality.personal-data, quality.log-masking)

## Acceptance criteria

- AC-12.1 — A run waiting more than 7 days becomes `cancelled` with a history entry, its comment log `cancelled`, and its saved automations never start; the contact can then trigger that automation again — plans/decisions.md D8
- AC-12.2 — A run that got its answer just before the check is not cancelled, and running the check twice changes nothing — plans/decisions.md D8
- AC-12.3 — Runs that ended more than 180 days ago are removed with their history; open runs are never removed; their comment logs stay without a run — plans/decisions.md D8
- AC-12.4 — Comment logs written more than 180 days ago are removed; younger ones stay — intake-files/schema-routes.md:953
- AC-12.5 — Webhook events received more than 30 days ago are removed whatever their status; younger ones stay — intake-files/schema-routes.md:808
- AC-12.6 — A deleted automation is removed for good 180 days after its delete once nothing points at it; one still pointed at stays and is tried again the next day — plans/decisions.md D26
- AC-12.7 — Contacts and stored posts are not removed by time: they stay until the organization is deleted, the contact is deleted, or Meta's data deletion erases the posts — plans/decisions.md D8
- AC-12.8 — Deleting a contact cancels its running and waiting runs (one history entry each, saved automations dropped), clears the trigger text of all its runs, and clears the comment text, commenter id and username, and the email and phone received on its comment logs; post, story and comment ids stay — plans/decisions.md D25
- AC-12.9 — When any part of a contact delete fails, nothing is erased and the contact stays as it was — plans/decisions.md D25
- AC-12.10 — A deleted contact's webhook events stay in the list, payload masked, until the 30-day clean-up removes them — plans/decisions.md D25
- AC-12.11 — A run whose contact is deleted while it runs sends no further message — plans/decisions.md D25
- AC-12.12 — Deleting the organization removes all its Instagram, contact, automation and webhook-event data — intake-files/schema-routes.md:684
- AC-12.13 — No log line carries a contact's email, phone number, name, username or picture, or a message's text — intake-files/PRD.md:176

## Work items

- data.retention
- data.erasure
- background.waiting-run-cancel
- background.run-retention
- background.comment-log-retention
- background.webhook-event-retention
- background.deleted-automation-purge
- background.organization-scope
- quality.personal-data
- quality.log-masking
