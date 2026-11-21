Status: ready
Kind: screen
Depends on: instagram-connection
Route review: [routes-final.md](../../routes-final.md) § 4.B — WH16, WH17 (with § 4.2 WQ1, WQ2)
Tables: `app.instagram_webhook_events`

## Stories

- As an Owner or Admin I want to see every Instagram event received for our account and what happened to it so that I can find out why an automation did or did not answer.
- As an Owner or Admin I want to filter the events by status, kind and time so that I find the one I am looking for.
- As an Instagram user I want my messages, email and phone number masked in that list so that the team's debugging view does not expose them.

## Rules

- Every stored event shows its kind, key, status (`received`, `queued`, `processed`, `skipped`, `failed`), skip reason, error, number of attempts, payload, Meta's own time, and when it was received and finished (data.instagram-webhook-event; D19)
- The list is newest first, filtered by status, kind and received time (from inclusive, to exclusive); the next page continues only with the same filters; a total only on request (operations.list-webhook-events)
- The payload keeps its shape but personal data is masked: message and comment text cut to 40 characters, emails and phone numbers masked, media and attachment links replaced; ids, kinds and usernames stay (quality.personal-data; D28)
- Only Owner and Admin may open it (`instagram-webhook-event:read`) (access.permission-codes; D4)
- Only the organization's own events are listed; events of an Instagram account no team holds are never stored, so never listed (data.organization-scope; D28)
- Nothing in the list changes an event; only Meta's deliveries create them (operations.list-webhook-events; D13)
- Events are kept 30 days, whatever their status (data.retention; D8)
- The list is not live; a refresh shows new events (D11)

## Acceptance criteria

- AC-6.1 — The list shows the organization's received events newest first, each with kind, key, status, skip reason, error, attempts, Meta's time, received time and finished time — intake-files/schema-routes.md:575
- AC-6.2 — Filtering by status, kind and received time narrows the list; a value outside its list, or a `from` not before `to`, is refused; a next-page token reused with other filters is refused — intake-files/schema-routes.md:267
- AC-6.3 — Each event's payload keeps its shape, with message and comment text cut to its first 40 characters, emails and phone numbers masked and media links replaced — plans/decisions.md D28
- AC-6.4 — A Member is refused with `missing_permission`; an Owner and an Admin see the list — intake-files/schema-routes.md:150
- AC-6.5 — Another organization's events never appear, and events of an Instagram account no team holds are never listed — intake-files/schema-routes.md:582

## Work items

- data.instagram-webhook-event
- operations.list-webhook-events
