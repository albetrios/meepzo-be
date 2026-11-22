# Frontend route map — launch-2026-11-20-ujai

For the frontend: what changed in the API for this iteration's design drop, each design operation's
route, every route the API has, and the design features the backend dropped.

Section 3 is generated — `pnpm iteration:frontend-map launch-2026-11-20-ujai` rewrites it from `docs/routes.txt`, the
OpenAPI document and `plans/routes-final.md`. Write sections 1, 2 and 4 by hand.

## 1. What changes on every call

The launch adds **18 routes, all new**. No existing route changed its path, method or answer fields
([route-changes.md](route-changes.md): 18 new, 0 changed, 0 removed). `#n` is the route's number in
[routes-final.md](routes-final.md). Paths here go after `/api/v1`.

### 1.1 Basics

| Topic | Rule |
| --- | --- |
| Base path | `/app/automations…`, `/app/contacts…`, `/app/social/instagram/…` |
| Sign-in | `Authorization: Bearer <access token>` on 14 routes. Meta calls the other 4 (#7, #8, #16, #17); the frontend never does |
| Active organization | Comes from the access token. Never send an organization id. Switch with `POST /auth/switch-to-organization` or `POST /auth/switch-to-personal`, take the new token and load the data again. An id of another organization answers `404`, never `403` |
| Success | `200` for `GET`, `POST` and `PATCH` (a create too, never `201`); `204` with no body for `DELETE` |
| Field names | `snake_case` in requests and answers. The id of a record is always `id` |
| Unknown fields | A body field or query parameter the route does not know answers `400`. A read-only field sent back (for example `completed_run_count`) is an unknown field |
| One record | `{ "data": { … }, "meta": { "request_id": "…" } }` |
| Times | Returned as ISO 8601 in UTC: `2026-11-20T10:00:00.000Z`. Show them in the user's time zone. Send ISO 8601 **with an offset** (`Z` or `+05:30`); without one → `400` |
| Language | `error.detail` and `errors[].message` follow `Accept-Language` (`en`, `es`) |
| Live updates | None ([D11](decisions.md)). Load again after a write or on refresh |
| Rate limit | `429`, `code: rate_limited`, with `Retry-After` in seconds |

**Ids.** A public id is a prefix, `_` and 21 characters `[a-z0-9]`.

| Prefix | Record | Where the frontend meets it |
| --- | --- | --- |
| `iga_` | Instagram account | the account's `id`; `instagram_account_id` on automations and contacts; the list filter of both |
| `aut_` | Automation | its `id`; the path `:automation_id`; the contacts filter `automation_id` |
| `con_` | Contact | its `id`; the path `:contact_id` |
| `iwe_` | Instagram webhook event | its `id`; no route takes it |
| `usr_` | User (existing) | `connected_by_user_id`, `created_by_user_id`, `updated_by_user_id`; each may be `null` |
| `run_`, `acl_` | Automation run, comment log | no route returns or takes them ([D13](decisions.md)) |

Instagram's own ids (`instagram_user_id`, `instagram_media_id`, `instagram_story_id`, …) are strings of digits.
Keep them as strings.

### 1.2 Team only, and permissions

`GET /auth/me/context` has all you need: `active_organization.type`, `my_permissions` and
`active_organization.plan_access`.

- Show these screens only when `active_organization.type` is `TEAM`.
- On a personal organization every signed-in call answers `403 missing_permission`, because a personal owner never
  holds these codes. Behind that check, a write answers `422` (no `reason`) and a read `404 team_organization_required`.
- Show each button by its permission code. A call without the code answers `403 missing_permission`.

| Permission code | Allows | Owner | Admin | Member |
| --- | --- | --- | --- | --- |
| `instagram-account:read` | see the account, posts, reels and stories (#2, #5, #6) | yes | yes | yes |
| `instagram-account:manage` | connect, change settings, disconnect (#1, #3, #4) | yes | yes | no |
| `instagram-webhook-event:read` | see received webhook events (#18) | yes | yes | no |
| `automation:read` | list and open automations (#11, #13) | yes | yes | yes |
| `automation:create` | create, and Duplicate (#12) | yes | yes | yes |
| `automation:update` | edit, turn on and off (#14) | yes | yes | yes |
| `automation:delete` | delete (#15) | yes | yes | no |
| `contact:read` | list contacts, with emails and phones (#9) | yes | yes | yes |
| `contact:delete` | delete one contact (#10) | yes | yes | no |

### 1.3 Read-only plan

Only **three calls** are refused, with `403 organization_read_only`, while `active_organization.plan_access.state`
is `read_only`: `POST /app/automations`, `PATCH /app/automations/:automation_id` and
`DELETE /app/automations/:automation_id` ([D27](decisions.md)). In the states `active` and `grace` they work. Reads,
connecting, settings, disconnecting and deleting a contact stay open, and running automations go on.

### 1.4 Idempotency key

`X-Idempotency-Key` is **required on two calls**: `POST /app/social/instagram/connect` and `POST /app/automations`.
No other new call needs it. A key is 16–255 characters of `A-Z a-z 0-9 . _ : ~ + / = -` (a UUID is fine). Make one new
key per user action; a retry of that action sends the same key and the same body.

| What happens | Answer |
| --- | --- |
| Same key, same body, the first call worked | The first answer again (`200`) with the header `X-Idempotency-Replay: true`, for 24 hours. Nothing is made twice |
| The first call failed (`4xx` or `5xx`) | Failures are not kept: send the same key again (connect: see 1.8, step 5) |
| Key missing or not well formed | `422`, `code: unprocessable_entity` |
| Same key, another body | `422`, `code: idempotency_key_reuse` |
| Same key, the first call still runs | `409`, `code: conflict_in_flight` or `conflict`: wait, then send the same key again |
| The key store is down | `503`, `code: service_unavailable`, with `Retry-After`: send the same key again |

These answers have a `code` but no `reason`.

### 1.5 Saving over a newer version

`PATCH /app/automations/:automation_id` and `PATCH /app/social/instagram/account/settings` take an optional
`expected_updated_at`.

- Send the exact `updated_at` the form was opened with. For settings that is `settings.updated_at`, not the account's.
- When the saved value differs, the answer is `409 record_changed` and nothing is saved. Say that the record changed
  and load it again. `detail` names the editor by user id (`usr_…`) or "someone", so write your own text.
- Without the field the last save wins. After a save, keep the `updated_at` of the answer.
- The counters (`completed_run_count`, `last_triggered_at`) do not move `updated_at`. A "next post" link or expiry does.

### 1.6 Lists

```json
{
  "data": [{ "id": "aut_…" }],
  "meta": {
    "request_id": "…",
    "pagination": { "per_page": 25, "next": "…", "has_more": true, "estimated_total": 42 }
  }
}
```

Send `next` back as `after`; it is `null` on the last page. Drop `after` whenever a filter, the search or the sort
changes.

| List | `limit` | `estimated_total` | `after` with other filters |
| --- | --- | --- | --- |
| Automations (#11), contacts (#9) | 1–100, default 25 | on the first page only (no `after`); it stops at 10,000 (= "10,000 or more") | starts again at the first page |
| Webhook events (#18) | 1–100, default 25 | only with `include_total=true`; it stops at 10,000 | `400` on `after` |
| Posts (#5), stories (#6) | 1–50, default 25 | never | it is Instagram's own cursor; there are no filters |

### 1.7 Errors

```json
{
  "error": {
    "type": "validation_error",
    "code": "invalid_field",
    "detail": "…",
    "errors": [{ "field": "body.keywords", "message": "…" }]
  },
  "meta": { "request_id": "…" }
}
```

- In general `code` follows the status: `400 invalid_field` · `401 unauthorized` · `403 forbidden` · `404 not_found` ·
  `409 conflict` · `413 payload_too_large` · `415 unsupported_media_type` · `422 unprocessable_entity` ·
  `429 rate_limited` · `500 internal_error` · `503 service_unavailable`. The idempotency codes of 1.4 are the exception.
- Branch on the status and `reason` (when present). Never on `detail`, and never on `type`.
- `errors[]` comes only with `400`. `field` starts with the place: `body.`, `querystring.` or `params.`. A flow rule names a
  nested field with a dot (`body.opening_message.button_title`); a shape error uses a slash and the item number
  (`body.final_message/text`, `body.public_reply_texts/1`). Three names have no prefix: `after` (a bad webhook-events
  cursor), `automation_id` and `contact_id` (an id that is not well formed).
- `Retry-After` (seconds) comes with every `429` and with `503 instagram_unavailable` (there at most 900).

**Every `reason` of the new routes the frontend can meet:**

| `reason` | Status | Comes from | In the frontend |
| --- | --- | --- | --- |
| `missing_permission` | 403 | every signed-in route | Say "you cannot do this"; load `GET /auth/me/context` again |
| `mfa_required` | 403 | every signed-in route, when the organization requires MFA (existing) | The existing step-up flow |
| `organization_read_only` | 403 | #12, #14, #15 | Ask to choose a plan; keep the screen readable |
| `team_organization_required` | 404 | #2, #5, #6, #9, #11, #13, #18 | Say that a team organization is needed |
| `instagram_not_connected` | 404 | #2, #3, #4, #5, #6 | Show the Connect card |
| `instagram_not_connected` | 409 | #12 | Ask to connect Instagram first; keep what was typed |
| `instagram_reconnect_required` | 404 | #5, #6 | Show the Reconnect card; load #2 again (its status is now `expired` or `error`) |
| `instagram_code_invalid` | 422 | #1 | Start the Instagram login again (the code works once) |
| `instagram_account_not_professional` | 422 | #1 | Ask to switch to a business or creator account, then log in again |
| `instagram_scopes_missing` | 422 | #1 | Ask to log in again and allow every permission |
| `organization_already_has_instagram_account` | 409 | #1 | Ask to disconnect the current account first, then log in again |
| `instagram_account_connected_elsewhere` | 409 | #1 | Say that another organization holds this account |
| `instagram_connect_restart_required` | 409 | #1 | Instagram failed after it took the one-time code, and nothing was connected. Start the Instagram login again; do not retry the call (it has no `Retry-After`) |
| `instagram_unavailable` | 503 | #1, #5, #6 | Try again after `Retry-After` seconds; on #1 send the same call (1.8, step 5) |
| `instagram_not_configured` | 503 | #1, #5, #6 | Say that Instagram is not set up; do not retry |
| `automation_not_found` | 404 | #13, #14, #15 | Go back to the list |
| `next_post_window_overlap` | 409 | #12, #14 | Show `detail` beside the keywords and the dates (no `errors[]`) |
| `next_post_already_linked` | 409 | #14 | Load the automation again and lock its target and dates |
| `record_changed` | 409 | #3, #14 | See 1.5 |
| `contact_not_found` | 404 | #10 | Treat it as already deleted; load the list again |

A `422` without a `reason` is a personal organization (1.2) or the idempotency key (1.4). Only Meta meets
`instagram_signed_request_invalid`, `invalid_webhook_verify_token`, `invalid_webhook_signature` and
`instagram_webhook_not_configured`.

### 1.8 Connect Instagram: the redirect

1. **The frontend builds Instagram's login link.** No API route builds it or returns the app id. It needs the settings
   below and a random `state`, kept in session storage.
2. Instagram sends the user to `/auth/instagram/callback` with `code` and `state`. If `state` differs from the kept one,
   stop and call nothing. The API does not check `state` ([D24](decisions.md), IQ6).
3. The callback page calls `POST /app/social/instagram/connect` (#1) with `{ "code": "…" }` and a new
   `X-Idempotency-Key`. `code` is 1–2000 characters; a trailing `#_` may stay, the API strips it.
4. The answer is `{ is_new_connection, instagram_account }`. `is_new_connection` is `false` when the organization had
   this account before; its settings come back.
5. When #1 fails: after `503 instagram_unavailable` the code may still work, so wait `Retry-After` seconds and send the
   same call (same key, same code). After any `409` or `422` with a `reason` the code cannot be used again: go back to
   step 1 with a new `state` and a new key. A failed connect stores nothing; an account connected before stays as it is.

| Setting | Value in the frontend |
| --- | --- |
| App id (`client_id`) | the same value as the API's `INSTAGRAM_APP_ID` (public, not a secret) |
| Redirect address | this frontend's `/auth/instagram/callback`, the same text as the API's `INSTAGRAM_REDIRECT_URI`, also listed in the Meta app. Local: `http://localhost:5173/auth/instagram/callback` |
| Scopes, all three | `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments` |

The app secret stays in the API. Until the API has `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` and
`INSTAGRAM_REDIRECT_URI`, #1 answers `503 instagram_not_configured`; so do #5 and #6 for a connected account. The env template ships without the
app secret, so a new local API answers this until one is set.

The API also links to two frontend pages under `FRONTEND_URL`:

| Page | Who opens it | What it shows |
| --- | --- | --- |
| `/instagram` | people who get the reconnect notice (1.9) | the Instagram page |
| `/instagram/data-deletion?code=<code>` | the Instagram owner, signed out, from Meta | that the data is deleted, and the code. It calls no route ([D24](decisions.md), IQ2) |

### 1.9 Existing routes with new values or effects

| Route | New value or effect |
| --- | --- |
| `GET /tenancy/permissions` | the nine codes of 1.2, in the categories `instagram`, `automations` and `contacts` |
| `GET /tenancy/organization/roles` | a locked system role **Member** in every team; it also holds `organization:read` ([D31](decisions.md)). Changing its codes answers `403 role_locked`; renaming or deleting it `403 system_role_fixed`. A team's own "Member" role is now "Member (custom)" |
| `GET /notify/notifications`, notification preferences and policies | the type `instagram.reconnect_required` (in-app and email), sent to every active member with `instagram-account:manage`, once per break; `action_url` opens `/instagram` |
| `GET /tenancy/organization/audit-logs` | the actions `app.instagram_account.connect`, `.disconnect`, `.deauthorize`, `.data_deletion`, `app.instagram_account_settings.update`, `app.automation.create`, `.update`, `.delete`, `app.contact.delete` |
| `DELETE /tenancy/organization` | also disconnects the team's Instagram account and erases its token, profile and stored posts; another team may connect that account at once ([D54](decisions.md)). Say so in the confirm text. Its audit entry then names `erased_instagram_account_public_ids` and `erased_instagram_post_count` |
| any route | a `503` may carry a `reason` ([D34](decisions.md)); a `500` never does |

## 2. Each design operation → its route

The drop has no screens, so the tables follow its 12 operations (`schema-routes.md` §1 and §6), grouped by screen. Each
operation appears once, under its §6 name. `#n` is the route review number. "Read-only fields" means the fields only the
server sets.

### 2.1 Instagram connection (the Instagram page and `/auth/instagram/callback`)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| 6.1 `POST /app/social/instagram/connect`: finishes "Connect Instagram" | `POST /app/social/instagram/connect` (#1) | Needs `instagram-account:manage` (design: `instagram_account:manage`) and `X-Idempotency-Key`. Field renamed: `token_expires_at` → `access_expires_at`. Fields added: `is_webhook_subscribed`, `updated_at`, `settings.updated_by_user_id`. Status changed: `instagram_code_invalid` and `instagram_account_not_professional` are `422` (design: `409`). Added: `422 instagram_scopes_missing`, `409 instagram_connect_restart_required`, `503 instagram_not_configured`. `503 instagram_unavailable` now comes only before Instagram takes the one-time code; after that it is `409 instagram_connect_restart_required` (1.8, step 5). Connecting an account the organization disconnected earlier also gives `is_new_connection: false`, with its old settings. `username` and `profile_url` are typed nullable, but every account shown has them. When `is_webhook_subscribed` is `false`, warn that no events arrive: the API tries again on the next connect and once a day |
| new, not in the design: read the connected account | `GET /app/social/instagram/account` (#2) | The same account object. `connection_status` is `connected`, `expired` or `error`; the last two show the Reconnect card. No account, or a disconnected one → `404 instagram_not_connected`. Never asks Instagram |
| new, not in the design: change the account settings | `PATCH /app/social/instagram/account/settings` (#3) | At least one of the six fields of `InstagramAccountSettings`, whole numbers in the design's ranges. Maximum gap below the minimum → `400` on `body.public_reply_gap_max_seconds`, also when only one of the two is sent. Optional `expected_updated_at` (1.5). Works while the account is `expired` or `error`. Answers the settings object |
| new, not in the design: disconnect | `DELETE /app/social/instagram/account` (#4) | `204`; no body, no query. The settings and profile are kept for a later reconnect. Automations stay `live` but nothing runs; waiting runs are not cancelled ([D24](decisions.md)). Needed before another account can be connected, also when the account is `expired` or `error`. Deleting the team disconnects too, and erases more (1.9) |

### 2.2 Content picker (posts, reels, stories)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| 6.2 `GET /app/social/instagram/media`: posts and reels for the post picker | `GET /app/social/instagram/media` (#5) | Needs `instagram-account:read`. Status changed: `instagram_reconnect_required` is `404` (design: `409`). May be `null` when Instagram leaves it out: `media_type`, `permalink`, `published_at`, `children[].media_type`. Any Instagram failure but a refused token → `503 instagram_unavailable`. `limit` over 50 → `400` |
| 6.3 `GET /app/social/instagram/stories`: live stories for story-reply automations | `GET /app/social/instagram/stories` (#6) | As 6.2. May be `null`: `media_type`, `permalink`, `published_at`, `expires_at`. `expires_at` is `published_at` + 24 hours |

### 2.3 Automations: list

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| 6.7 `GET /app/automations`: lists automations | `GET /app/automations` (#11) | `search` → `q` (1–200 characters; the name, as one phrase, any case). `sort=-field` → `sort` + `order`: `sort` is `created_at` (default), `name`, `last_triggered_at` or `completed_run_count`; `order` is `asc` or `desc`. Without `order`: newest or most first, `name` A→Z. Never-triggered automations come last both ways. New filter `instagram_account_id` (an unknown one gives an empty page). `status`, `trigger_type`, `target_scope` and `next_post_status` as the design. Each item has a new field `instagram_account_id` |
| 6.11 `DELETE /app/automations/:automation_id`: deletes an automation and stops its open runs | `DELETE /app/automations/:automation_id?reason=…&note=…` (#15) | Moved: body `delete_reason` / `delete_note` → query `reason` / `note`; send no body. `reason` is **required** (`mistake`, `duplicate`, `not_needed`, `other`); `note` (1–280 characters) is required for `other`. `204`. No restore. A repeat → `404 automation_not_found` |

### 2.4 Automations: editor (create, open, edit, duplicate, on/off)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| 6.8 `POST /app/automations`: creates an automation | `POST /app/automations` (#12) | Body as the design, with `X-Idempotency-Key`. The server sets `instagram_account_id` to the connected account (`expired` or `error` counts); none → `409 instagram_not_connected`. More rules in 2.4.1. **Duplicate**: 2.4.2 |
| 6.9 `GET /app/automations/:automation_id`: returns one automation | `GET /app/automations/:automation_id` (#13) | New field `instagram_account_id`. `final_message` is never `null`; its `links` is always an array; `opening_message.button_title` is always present (`null` = no button) |
| 6.10 `PATCH /app/automations/:automation_id`: edits an automation, turns it on or off | `PATCH /app/automations/:automation_id` (#14) | Send only what changed, at least one field; the list's on/off switch sends `{ "status": "live" }` or `{ "status": "inactive" }`. Optional `expected_updated_at` (1.5). A message object is replaced whole. `null` clears a message or an id; `final_message` may not be `null`. `instagram_account_id` never changes. More rules in 2.4.1 |

#### 2.4.1 Rules for the form

| Rule | What the API does |
| --- | --- |
| Every save is complete, drafts too | The same checks run for `live` and `inactive` |
| Opening message | On by default. Send `opening_message`, or `is_opening_message_enabled: false`. On a `comment` automation its `button_title` is required (`400` on `body.opening_message.button_title`); on `story_reply` and `dm` it is optional. It is sent on every trigger |
| Follow request | On → `follow_request_message` is required |
| Email and phone question | The message may be `null`: the default English text is used |
| `dm` trigger | `target_scope` is `any`, at least one keyword, and `is_dm_keyword_trigger_enabled` is `true` |
| Public reply | Only on `comment`, with 1–20 texts of 1–300 characters. When the trigger leaves `comment`, send `is_public_reply_enabled: false` in the same call |
| Final message | Always required; 0–3 links; a `url` starts with `https://` and has at most 2,048 characters |
| Target ids | `specific` needs the post id (`comment`) or the story id (`story_reply`), and not the other. When the scope becomes `any`, or the trigger changes, send the old id as `null` in the same call |
| "Next post" | Only on `comment`; both dates; never send the media id. Dates sent with another scope are dropped without an error |
| "Next post", linked | The dates, `target_scope` and the target ids are fixed (`409 next_post_already_linked`), and so is the trigger: lock them |
| "Next post", expired | New dates make it `waiting` again. Turned `live` without new dates it stays `expired` |
| Overlap | Checked only when the automation is `live` and `waiting`, against the same Instagram account's others. A draft is checked when it turns `live` |
| Messages kept | The text of a step that is off stays saved |
| Cleaned by the server | Keywords: trimmed, lowercase, each once. Tags: trimmed, each once |
| Open runs | An edit reaches them from their next step; `inactive` stops new runs only |

#### 2.4.2 Duplicate

1. Read the automation with #13.
2. Leave out `id`, `instagram_account_id` and the read-only fields: `next_post_status`, `next_post_linked_at`,
   `completed_run_count`, `last_triggered_at`, `created_by_user_id`, `updated_by_user_id`, `created_at`, `updated_at`.
   On a `next` automation also leave out `target_instagram_media_id`.
3. Send the rest to #12 with a new key and `"status": "inactive"`. A live copy of a live, waiting "next post" automation
   answers `409 next_post_window_overlap`.
4. Dates that are too old answer `400` on the date fields: ask for new ones. The copy belongs to the account connected
   now, not to the original's.

### 2.5 Contacts

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| 6.12 `GET /app/contacts`: the Contacts page list | `GET /app/contacts` (#9) | `search` → `q` (1–200 characters; every word anywhere in username, full name and email, any case). `tag` (repeated) → `tags=vip,giveaway` (up to 10; the contact holds all). `sort=-field` → `sort` + `order`: `sort` is `last_message_received_at` (default), `first_seen_at` or `username`; without `order` newest first, `username` A→Z; no username comes last both ways. New filter `instagram_account_id`. `has_email`, `has_phone`, `is_following_account` are `true` or `false`; a person never checked matches neither value of `is_following_account`. `first_seen_to` is not included in the range. `automation_id` also finds contacts of a deleted automation. Fields added: `instagram_account_id`, `follow_checked_at`, `last_direct_message_received_at`. `last_message_received_at` is never `null`. Deleted contacts are never listed |
| new, not in the design: delete one contact | `DELETE /app/contacts/:contact_id` (#10) | `204`; no body, no query. Wipes the person's data for good and stops their open runs; no restore. A later comment or message makes a new contact with a new `id`. Their webhook events stay, masked, until 30 days have passed ([D25](decisions.md)) |

### 2.6 Webhook events

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| 6.6 `GET /app/social/instagram/webhook-events`: received events and what happened to each | `GET /app/social/instagram/webhook-events` (#18) | Needs `instagram-webhook-event:read` (design: `webhook:read`). `payload` is masked (text cut to 40 characters, emails and phone numbers masked, links shown as `[link]`). Fields added: `instagram_user_id`, `contact_instagram_user_id`, `attempt_count`, `occurred_at` (Meta's time, may be `null`). New query `include_total` (`true` or `false`, default `false`). `received_from` is included, `received_to` is not; `received_from` must be earlier. `skip_reason` has no `unknown_account`. `error_message` is a code and a short reason (`instagram_api:190/463`), never Instagram's own text. No search and no sort: newest first. Events are kept 30 days |

### 2.7 Called by Meta (no screen)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| 6.4 `GET /app/social/instagram/webhook`: Meta's subscription check | `GET /app/social/instagram/webhook` (#16) | Nothing in the frontend. A wrong token is `400 invalid_webhook_verify_token` (design: `403` text) |
| 6.5 `POST /app/social/instagram/webhook`: receives Instagram events and runs the matching automations | `POST /app/social/instagram/webhook` (#17) | Nothing in the frontend. A bad signature is `400 invalid_webhook_signature` (design: `403`); it has a rate limit (design: none). What running automations does differently: section 4 |
| new, not in the design: the owner removed the app | `POST /app/social/instagram/deauthorize` (#7) | Nothing in the frontend. The account is then disconnected and #2 answers `404`, unless it was connected again after Meta signed the request ([D53](decisions.md)) |
| new, not in the design: the owner asked to delete their data | `POST /app/social/instagram/data-deletion` (#8) | The frontend has only the page `/instagram/data-deletion` (1.8) |

## 3. Every available route

<!-- GENERATED:START -->

155 routes, from `docs/routes.txt`.
Paths drop `/api/v1`; the health and operations routes in the last module sit outside it.
**Gate**: a permission code, `signed in`, `public`, `platform admin` or a token. **Idem** `req`:
`X-Idempotency-Key` required. **Team** `team`: team organizations only (`422` on a personal one).
**#**: the route review number (blank where the review does not name the route). Success is `200`,
or `204` for a `DELETE`. **What it does** is the OpenAPI summary.

| Module | Routes |
| --- | --- |
| [Session and account](#session-and-account) | 49 |
| [Organization and team](#organization-and-team) | 43 |
| [Files](#files) | 4 |
| [Notifications and webhooks](#notifications-and-webhooks) | 14 |
| [Subscription billing (the platform)](#subscription-billing-the-platform) | 13 |
| [Platform administration and operations](#platform-administration-and-operations) | 32 |

### Session and account

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/auth/email/login` | public |  |  |  | Log in with an email verification code |
| POST | `/auth/email/send-code` | public |  |  |  | Send email sign-in code |
| POST | `/auth/login` | public |  |  |  | Login with email and password |
| POST | `/auth/logout` | token (access-token) |  |  |  | Logout current session |
| GET | `/auth/me/auth-methods` | signed in |  |  |  | List my auth methods |
| POST | `/auth/me/auth-methods` | signed in |  |  |  | Add auth method |
| DELETE | `/auth/me/auth-methods/:auth_method_id` | signed in |  |  |  | Remove auth method |
| GET | `/auth/me/context` | signed in |  |  |  | Get my session context |
| GET | `/auth/me/mfa` | signed in |  |  |  | List enrolled MFA methods |
| DELETE | `/auth/me/mfa/:mfa_method_id` | signed in |  |  |  | Remove MFA method |
| POST | `/auth/me/mfa/enroll` | signed in |  |  |  | Begin MFA enrollment (phase 1 of 2) |
| POST | `/auth/me/mfa/enroll/confirm` | signed in |  |  |  | Confirm MFA enrollment (phase 2 of 2) |
| POST | `/auth/me/mfa/verify` | signed in |  |  |  | Verify MFA code |
| GET | `/auth/me/sessions` | signed in |  |  |  | List my active sessions |
| DELETE | `/auth/me/sessions` | signed in |  |  |  | Revoke all sessions |
| DELETE | `/auth/me/sessions/:session_id` | signed in |  |  |  | Revoke a specific session |
| GET | `/auth/me/webauthn/credentials` | signed in |  |  |  | List registered passkeys |
| DELETE | `/auth/me/webauthn/credentials/:credential_id` | signed in |  |  |  | Revoke a passkey |
| POST | `/auth/me/webauthn/register/options` | signed in |  |  |  | Begin passkey registration |
| POST | `/auth/me/webauthn/register/verify` | signed in |  |  |  | Complete passkey registration |
| POST | `/auth/mfa/login` | public |  |  |  | Complete MFA during login |
| GET | `/auth/oauth/:provider` | public |  |  |  | Initiate OAuth flow |
| GET | `/auth/oauth/:provider/callback` | public |  |  |  | OAuth callback |
| GET | `/auth/oauth/providers` | public |  |  |  | List available OAuth providers |
| POST | `/auth/password/change` | signed in |  |  |  | Change current password |
| POST | `/auth/password/forgot` | public |  |  |  | Request password reset |
| POST | `/auth/password/reset` | public |  |  |  | Reset password with token |
| POST | `/auth/refresh` | token (session-cookie) |  |  |  | Refresh access token |
| POST | `/auth/step-up` | signed in |  |  |  | Step-up (re-authenticate) |
| POST | `/auth/switch-to-organization` | signed in |  |  |  | Switch active organization |
| POST | `/auth/switch-to-personal` | signed in |  |  |  | Switch to personal organization |
| POST | `/auth/webauthn/authenticate/options` | public |  |  |  | Begin passkey authentication |
| POST | `/auth/webauthn/authenticate/verify` | public |  |  |  | Complete passkey authentication |
| GET | `/users/me` | signed in |  |  |  | Get current user profile |
| PATCH | `/users/me` | signed in |  |  |  | Update current user profile |
| DELETE | `/users/me` | signed in |  |  |  | Delete my account |
| PUT | `/users/me/avatar` | signed in |  |  |  | Upload avatar |
| DELETE | `/users/me/avatar` | signed in |  |  |  | Remove avatar |
| POST | `/users/me/bug-reports` | signed in |  |  |  | Report a bug |
| POST | `/users/me/data-export` | signed in |  |  |  | Request GDPR data export |
| GET | `/users/me/data-export/:data_export_id` | signed in |  |  |  | Get GDPR data export status |
| GET | `/users/me/membership-invitations` | signed in |  |  |  | List my invitations |
| GET | `/users/me/notification-preferences` | signed in |  |  |  | Get my notification preferences |
| PUT | `/users/me/notification-preferences` | signed in |  |  |  | Replace notification preferences |
| POST | `/users/me/onboarding/complete` | signed in |  |  |  | Mark onboarding complete |
| GET | `/users/me/organizations` | signed in |  |  |  | List my organizations |
| PUT | `/users/me/presence` | signed in |  |  |  | Set my presence |
| GET | `/users/me/settings` | signed in |  |  |  | Get my settings |
| PATCH | `/users/me/settings` | signed in |  |  |  | Update my settings |

### Organization and team

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/tenancy/membership-invitations/:membership_invitation_id/accept` | signed in | req |  |  | Accept invitation |
| POST | `/tenancy/membership-invitations/:membership_invitation_id/decline` | signed in | req |  |  | Decline invitation |
| GET | `/tenancy/organization` | signed in |  |  |  | Get active organization |
| PATCH | `/tenancy/organization` | `organization:update` |  |  |  | Update organization |
| DELETE | `/tenancy/organization` | `organization:delete` |  | team |  | Delete organization |
| GET | `/tenancy/organization/api-keys` | `api-key:read` |  |  |  | List API keys |
| POST | `/tenancy/organization/api-keys` | `api-key:manage` | req |  |  | Create API key |
| GET | `/tenancy/organization/api-keys/:api_key_id` | `api-key:read` |  |  |  | Get API key |
| PATCH | `/tenancy/organization/api-keys/:api_key_id` | `api-key:manage` |  |  |  | Update API key |
| DELETE | `/tenancy/organization/api-keys/:api_key_id` | `api-key:manage` |  |  |  | Delete API key |
| POST | `/tenancy/organization/api-keys/:api_key_id/rotate` | `api-key:manage` |  |  |  | Rotate API key |
| GET | `/tenancy/organization/audit-logs` | `audit-log:read` |  |  |  | List organization audit logs |
| POST | `/tenancy/organization/leave` | signed in |  |  |  | Leave organization |
| PUT | `/tenancy/organization/logo` | `organization:update` |  |  |  | Upload organization logo |
| DELETE | `/tenancy/organization/logo` | `organization:update` |  |  |  | Remove organization logo |
| GET | `/tenancy/organization/memberships` | `membership:read` |  |  |  | List memberships |
| POST | `/tenancy/organization/memberships` | `membership:create` | req | team |  | Add member by email |
| GET | `/tenancy/organization/memberships/:membership_id` | `membership:read` |  |  |  | Get membership |
| PATCH | `/tenancy/organization/memberships/:membership_id` | `membership:update` |  |  |  | Update membership |
| DELETE | `/tenancy/organization/memberships/:membership_id` | `membership:delete` |  |  |  | Remove membership |
| DELETE | `/tenancy/organization/memberships/:membership_id/invitation` | `membership:delete` |  |  |  | Revoke invitation |
| POST | `/tenancy/organization/memberships/:membership_id/invitation/resend` | `membership:update` | req |  |  | Resend invitation |
| GET | `/tenancy/organization/memberships/:membership_id/permissions` | `membership:read` |  |  |  | Get membership permissions |
| POST | `/tenancy/organization/memberships/:membership_id/restore` | `membership:delete` | req | team |  | Restore membership |
| GET | `/tenancy/organization/notification-policies` | `notification-policy:read` |  |  |  | List notification policies |
| POST | `/tenancy/organization/notification-policies` | `notification-policy:manage` | req |  |  | Create notification policy |
| GET | `/tenancy/organization/notification-policies/:notification_policy_id` | `notification-policy:read` |  |  |  | Get notification policy |
| PATCH | `/tenancy/organization/notification-policies/:notification_policy_id` | `notification-policy:manage` |  |  |  | Update notification policy |
| DELETE | `/tenancy/organization/notification-policies/:notification_policy_id` | `notification-policy:manage` |  |  |  | Delete notification policy |
| GET | `/tenancy/organization/roles` | `role:read` |  |  |  | List roles |
| POST | `/tenancy/organization/roles` | `role:create` | req | team |  | Create role |
| GET | `/tenancy/organization/roles/:role_id` | `role:read` |  |  |  | Get role |
| PATCH | `/tenancy/organization/roles/:role_id` | `role:update` |  |  |  | Update role |
| DELETE | `/tenancy/organization/roles/:role_id` | `role:delete` |  |  |  | Delete role |
| GET | `/tenancy/organization/roles/:role_id/permissions` | `role:read` |  |  |  | List role permissions |
| PUT | `/tenancy/organization/roles/:role_id/permissions` | `role:update` |  |  |  | Replace role permissions |
| POST | `/tenancy/organization/roles/:role_id/restore` | `role:delete` | req |  |  | Restore role |
| GET | `/tenancy/organization/settings` | `organization:read` |  |  |  | Get organization settings |
| PATCH | `/tenancy/organization/settings` | `organization:update` |  |  |  | Update organization settings |
| POST | `/tenancy/organization/transfer-ownership` | signed in | req | team |  | Transfer organization ownership |
| POST | `/tenancy/organizations` | signed in | req |  |  | Create organization |
| GET | `/tenancy/organizations/by-slug/:slug` | signed in |  |  |  | Get organization by slug |
| GET | `/tenancy/permissions` | signed in |  |  |  | List all permissions |

### Files

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/uploads` | signed in | req |  |  | Request pre-signed upload URL |
| GET | `/uploads/:upload_id` | signed in |  |  |  | Get upload metadata |
| DELETE | `/uploads/:upload_id` | signed in |  |  |  | Delete upload |
| POST | `/uploads/:upload_id/confirm` | signed in |  |  |  | Confirm uploaded object |

### Notifications and webhooks

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/notify/notifications` | signed in |  |  |  | List my notifications |
| GET | `/notify/notifications/:notification_id` | signed in |  |  |  | Get notification |
| DELETE | `/notify/notifications/:notification_id` | signed in |  |  |  | Delete notification |
| PATCH | `/notify/notifications/:notification_id/read` | signed in |  |  |  | Mark notification as read |
| POST | `/notify/notifications/mark-all-read` | signed in |  |  |  | Mark all notifications as read |
| GET | `/notify/notifications/unread-count` | signed in |  |  |  | Get unread notification count |
| GET | `/notify/webhook-events` | `webhook:read` |  |  |  | List dispatchable webhook event types |
| GET | `/notify/webhooks` | `webhook:read` |  |  |  | List webhooks |
| POST | `/notify/webhooks` | `webhook:manage` | req |  |  | Create webhook |
| GET | `/notify/webhooks/:webhook_id` | `webhook:read` |  |  |  | Get webhook |
| PATCH | `/notify/webhooks/:webhook_id` | `webhook:manage` |  |  |  | Update webhook |
| DELETE | `/notify/webhooks/:webhook_id` | `webhook:manage` |  |  |  | Delete webhook |
| GET | `/notify/webhooks/:webhook_id/delivery-attempts` | `webhook:read` |  |  |  | List webhook delivery attempts |
| POST | `/notify/webhooks/:webhook_id/test` | `webhook:manage` |  |  |  | Send test webhook |

### Subscription billing (the platform)

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/billing/invoices` | `subscription:read` |  |  |  | List billing invoices |
| GET | `/billing/payment-methods` | `subscription:read` |  |  |  | List payment methods |
| POST | `/billing/payment-methods/setup` | `subscription:manage` | req | team |  | Create payment method setup |
| GET | `/billing/plans` | public |  |  |  | List available plans |
| GET | `/billing/plans/:plan_id` | public |  |  |  | Get plan details |
| GET | `/billing/subscriptions` | `subscription:read` |  |  |  | List subscriptions |
| POST | `/billing/subscriptions` | `subscription:manage` | req | team |  | Create subscription |
| GET | `/billing/subscriptions/:subscription_id` | `subscription:read` |  |  |  | Get subscription |
| POST | `/billing/subscriptions/:subscription_id/cancel` | `subscription:manage` | req | team |  | Cancel subscription |
| POST | `/billing/subscriptions/:subscription_id/change-plan` | `subscription:manage` | req | team |  | Change subscription plan |
| GET | `/billing/subscriptions/:subscription_id/payment-setup` | `subscription:read` |  |  |  | Get payment setup for incomplete subscription |
| POST | `/billing/subscriptions/:subscription_id/resume` | `subscription:manage` | req | team |  | Resume cancelled subscription |
| POST | `/billing/webhook` | public |  |  |  | Stripe webhook receiver |

### Platform administration and operations

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/app/automations` | `automation:read` |  | team |  | List automations |
| POST | `/app/automations` | `automation:create` | req | team |  | Create an automation |
| GET | `/app/automations/:automation_id` | `automation:read` |  | team |  | Get an automation |
| PATCH | `/app/automations/:automation_id` | `automation:update` |  | team |  | Edit an automation |
| DELETE | `/app/automations/:automation_id` | `automation:delete` |  | team |  | Delete an automation |
| GET | `/app/contacts` | `contact:read` |  | team |  | List contacts |
| DELETE | `/app/contacts/:contact_id` | `contact:delete` |  | team |  | Delete a contact |
| GET | `/app/social/instagram/account` | `instagram-account:read` |  | team |  | Get the connected Instagram account |
| DELETE | `/app/social/instagram/account` | `instagram-account:manage` |  | team |  | Disconnect Instagram |
| PATCH | `/app/social/instagram/account/settings` | `instagram-account:manage` |  | team |  | Change the Instagram account settings |
| POST | `/app/social/instagram/connect` | `instagram-account:manage` | req | team |  | Connect Instagram |
| POST | `/app/social/instagram/data-deletion` | public |  |  |  | Meta: delete the Instagram owner's data (data deletion) |
| POST | `/app/social/instagram/deauthorize` | public |  |  |  | Meta: Instagram app removed (deauthorize) |
| GET | `/app/social/instagram/media` | `instagram-account:read` |  | team |  | List Instagram posts and reels |
| GET | `/app/social/instagram/stories` | `instagram-account:read` |  | team |  | List live Instagram stories |
| GET | `/app/social/instagram/webhook` | public |  |  |  | Verify the Instagram webhook subscription |
| POST | `/app/social/instagram/webhook` | public |  |  |  | Receive an Instagram webhook delivery |
| GET | `/app/social/instagram/webhook-events` | `instagram-webhook-event:read` |  | team |  | List received Instagram webhook events |
| GET | `/audit/logs` | platform admin |  |  |  | List audit logs (admin) |
| GET | `/mcp` | platform admin |  |  |  | MCP streamable HTTP (GET) |
| POST | `/mcp` | platform admin |  |  |  | MCP streamable HTTP (POST) |
| GET | `/users` | platform admin |  |  |  | List all users (admin) |
| GET | `/users/:user_id` | platform admin |  |  |  | Get user by ID (admin) |
| PATCH | `/users/:user_id` | platform admin |  |  |  | Update user (admin) |
| DELETE | `/users/:user_id` | platform admin |  |  |  | Delete user (admin) |
| POST | `/users/:user_id/suspend` | platform admin |  |  |  | Suspend user (admin) |
| POST | `/users/:user_id/unsuspend` | platform admin |  |  |  | Unsuspend user (admin) |
| GET | `/internal/ops/circuit-breakers` | token (metrics) |  |  |  | List the outbound circuit breakers (operations only) |
| POST | `/internal/ops/circuit-breakers/:circuit_name/reset` | token (ops-admin) |  |  |  | Reset one circuit breaker (operations only) |
| GET | `/livez` | public |  |  |  | Liveness probe |
| GET | `/readyz` | public |  |  |  | Readiness probe |
| GET | `/metrics` | token (metrics) |  |  |  | Prometheus metrics (operations only) |

<!-- GENERATED:END -->

## 4. In the design, dropped — remove from the frontend

"Where in the design": `§` is a section of `schema-routes.md`; `PRD` is `PRD.md`. "Decision" names the row of
[decisions.md](decisions.md), with the rule of [routes-final.md](routes-final.md) in brackets.

### 4.1 Dropped or changed

| # | Design feature | Where in the design | Decision | In the frontend |
| --- | --- | --- | --- | --- |
| 1 | The query `search` on automations and contacts | §5.4, §5.5, §6.12 | D25 (CT4), D26 (AU13) | Send `q`; `search` answers `400` |
| 2 | Sorting with `sort=-field` | §5.4, §5.5 | D25 (CT6), D26 (AU13, AQ9) | Send `sort` and `order`: `-created_at` becomes `sort=created_at&order=desc` |
| 3 | The repeated query `tag` | §5.5 | D25 (CT4) | One `tags` value, comma-separated, up to 10 |
| 4 | Deleting an automation with a body and an optional reason (default `not_needed`) | §5.4, §6.11 | D26 (AQ6) | Ask for a reason with no default; send `reason` and `note` in the query, no body |
| 5 | `token_expires_at` on the account | §5.2 | D35 | Read `access_expires_at` |
| 6 | The status `revoked` on the account | §5.2, §9 | D5, D24 (IA13) | Remove that state: a disconnected account is `404 instagram_not_connected` |
| 7 | `409` for a bad code and for a personal Instagram account | §6.1, §7 | D24 (IA10) | Expect `422`, same `reason` |
| 8 | `409 instagram_reconnect_required` | §6.2, §6.3, §7 | D24 (IA10) | Expect `404`, same `reason` |
| 9 | `422` on every call of a personal workspace | §2 | D24–D26, D28 (K1, IA3) | Expect `403` first, then `404` on reads and `422` on writes (1.2) |
| 10 | Permission codes `instagram_account:read` and `instagram_account:manage` | §3 | D20 | Use `instagram-account:read` and `instagram-account:manage` |
| 11 | `webhook:read` opening the Instagram webhook events | §3, §6.6 | D4 | Use `instagram-webhook-event:read`; `webhook:read` is only for the outgoing webhooks |
| 12 | The webhook payload "as received" | §5.3, §6.6 | D28 (WQ2), D53 | Show it as masked; no "show full" button. Characters that cannot be stored are cleaned out |
| 13 | The skip reason `unknown_account`; events of an unknown account kept | §6.5, §8.7, §9 | D28 (WQ1) | Remove the label: such events are never stored, and neither are new events of a disconnected account. `account_disconnected` stays: the account was `expired` or `error`, or was disconnected while the event waited |
| 14 | Every matching comment automation runs | §6.5 | D26 (AQ1) | Say that one answers: first an automation for that post, then an "any post" one, the oldest of them. You may warn when two can match the same comment |
| 15 | An opening message without a button on a comment automation | §5.4, §10 | D26 (AQ2) | Make the button title required there |
| 16 | The opening message only as a reply to a comment | §6.5 step 3 | D26 (AQ3) | Show the step for `dm` and `story_reply` too |
| 17 | A `dm` automation with its DM keyword switch off | §5.4, §8.8 | D26 (AU8) | Keep the switch on and locked for `dm` |
| 18 | A complete flow needed only for `live` | §6.10 | D26 (AU8) | Check the whole form on every save; no half-filled drafts |
| 19 | An empty `final_message` | §5.4, §8.8 | D19 | Remove that state: it is never `null` |
| 20 | Automations and contacts of the whole workspace | §5.4, §5.5, §8.8, §8.9 | D25 (CQ5, CT13), D26 (AU27) | Each belongs to one Instagram account. Compare `instagram_account_id` with the connected account: automations of another one stay listed and editable but never run. One person on two accounts is two contacts. No route names an account that is no longer connected |
| 21 | "Next post" overlap checked across the workspace; only one automation gets the post | §6.5, §6.8 | D26 (AU9, AQ4, AU27) | The check is per Instagram account; two waiting automations with different keywords may get the same post (then row 14) |
| 22 | Only the window of a linked "next post" is fixed | §6.10 | D26 (AU9) | Also lock the scope, the target ids and the trigger |
| 23 | `next_post_window_overlap` as a `400` with `errors[]` | §2 (the error example) | D26 (3.A.10) | It is a `409` without `errors[]` |
| 24 | The error types `rate_limit_error` and `service_error` | §2 | K2 (the shared error answer) | Do not branch on `type`: `429` and `503` come as `request_error`, except from the idempotency key check |
| 25 | `errors[].field` without its place | §2 | K2 (the shared error answer) | Expect `body.next_post_ends_at`, `querystring.limit` (1.7) |
| 26 | `last_message_received_at` may be empty | §5.5 | D25 (CT10) | Remove the "never" state |
| 27 | Post and story fields that always have a value | §5.3 | D24 (IA16); AS-BUILT R5 | Handle `null` (2.2) |
| 28 | The audit names `instagram_account.connected`, `automation.created`, `.updated`, `.deleted` | §6.1, §6.8, §6.10, §6.11 | D20 (K9) | Label the names of 1.9 |
| 29 | The legacy flow rules that differ from §6.5: a comment while a run is open, a new trigger after a finished run, the DM keyword switch, empty keywords, the 24-hour opening message | PRD §7–§9 | D14 | Help texts follow §6.5, with rows 14–17 |
| 30 | `403` and no rate limit on Meta's two webhook routes | §2, §6.4, §6.5, §7 | D28 (WH7, WH8, WH11) | Nothing to do: Meta only. Remove `invalid_webhook_signature` from the frontend's list |
| 31 | `503 instagram_unavailable` whenever Instagram does not answer a connect | §6.1, §7 | D56 (IA12) | After Instagram took the code expect `409 instagram_connect_restart_required`: start the login again, no retry |
| 32 | Deleting the workspace only removes its rows | §8.1 | D54 | Say in the confirm text that Instagram is disconnected and its data erased at once |

### 4.2 No route at launch: build no screen for these

Rows 33–34 are tables of the design. The other rows are no operation of the design; they are listed so that nobody adds
them.

| # | Design feature | Where in the design | Decision | In the frontend |
| --- | --- | --- | --- | --- |
| 33 | Runs and run history (`run_…`) | §4, §8.10, §8.11 | D13 | No page. An automation shows only `completed_run_count` and `last_triggered_at` |
| 34 | Comment logs (`acl_…`) | §4, §8.12 | D13, D53 | No page. The webhook-events list is the debugging view; it does not show what a run did. The stored logs hold no text of Instagram's errors |
| 35 | Importing from the legacy system | PRD (that system); no operation | D7 | No import: teams connect and build again |
| 36 | Resending or opening one webhook event | not in the design | D13, D28 (4.B.10) | No resend button and no detail call; show the list row |
| 37 | Live updates | not in the design | D11 | Refresh |
| 38 | Plan limits on automations or contacts | not in the design | D12 | No limit counters; only the read-only plan blocks (1.3) |
| 39 | Exporting a contact's data | not in the design | D25 (CQ4) | No export button |
| 40 | Restoring a deleted automation or contact | not in the design | D25 (CT7), D26 (AU12) | Confirm before deleting; no undo |
| 41 | Adding or editing a contact by hand | §6.12 (says there is none) | D25 (CT2) | No form |
| 42 | A route for the login link, or to check `state` | not in the design | D24 (IQ6) | The frontend does both (1.8) |
| 43 | A status route for Meta's data deletion | not in the design | D24 (IQ2) | The page shows the code from its address |
