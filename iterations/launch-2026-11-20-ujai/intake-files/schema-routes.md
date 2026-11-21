# API_ENDPOINTS_V7

# IG Automation — API endpoints and database design

The endpoints of IG Automation, what each one does, who can call it, its request and response data, its errors, and the database tables behind them.

## Contents

1. [Endpoint list](about:blank#1-endpoint-list)
2. [API rules](about:blank#2-api-rules)
3. [Permissions](about:blank#3-permissions)
4. [Public ids](about:blank#4-public-ids)
5. [Data objects](about:blank#5-data-objects)
6. [Endpoint details](about:blank#6-endpoint-details)
7. [Error reasons](about:blank#7-error-reasons)
8. [Database design](about:blank#8-database-design)
9. [Allowed values](about:blank#9-allowed-values)
10. [JSON column shapes](about:blank#10-json-column-shapes)

---

## 1. Endpoint list

12 endpoints, all under `/app`. The Instagram endpoints are under `/app/social/instagram`; automations and contacts are under `/app`.

| # | Method | Route | Access | I | What it does |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/app/social/instagram/connect` | `PERM: instagram_account:manage` | req | Finishes “Connect Instagram”: swaps the OAuth code for a token and attaches the Instagram business account to the active workspace |
| 2 | GET | `/app/social/instagram/media` | `PERM: instagram_account:read` |  | Lists the account’s posts and reels from Instagram, for the post picker |
| 3 | GET | `/app/social/instagram/stories` | `PERM: instagram_account:read` |  | Lists the account’s live stories from Instagram, for story-reply automations |
| 4 | GET | `/app/social/instagram/webhook` | `PUBLIC` (verify token) |  | Answers Meta’s webhook subscription check |
| 5 | POST | `/app/social/instagram/webhook` | `PUBLIC` (`X-Hub-Signature-256`) |  | Receives comments, DMs, story replies and button clicks from Meta and runs the matching automations |
| 6 | GET | `/app/social/instagram/webhook-events` | `PERM: webhook:read` |  | Lists the webhook events received for the workspace and what happened to each |
| 7 | GET | `/app/automations` | `PERM: automation:read` |  | Lists automations |
| 8 | POST | `/app/automations` | `PERM: automation:create` | req | Creates an automation |
| 9 | GET | `/app/automations/:automation_id` | `PERM: automation:read` |  | Returns one automation |
| 10 | PATCH | `/app/automations/:automation_id` | `PERM: automation:update` |  | Edits an automation, turns it on or off |
| 11 | DELETE | `/app/automations/:automation_id` | `PERM: automation:delete` |  | Deletes an automation and stops its open runs |
| 12 | GET | `/app/contacts` | `PERM: contact:read` |  | Lists the Instagram users who interacted with the account, with the emails and phone numbers they shared |

`I` = `X-Idempotency-Key` header required (`req`).

**Folder and route layout**

`social` is a sub-domain of the `app` domain and holds only `instagram`, which serves `/app/social/instagram`. `automations` and `contacts` are their own sub-domains of `app`. Each folder has the same layer files (`*.routes.ts`, `*.controller.ts`, `*.service.ts`, `*.repository.ts`, `*.schema.ts`, `*.dto.ts`, `*.validator.ts`, `*.serializer.ts`, `*.types.ts`, `__tests__/`).

```
src/domains/app/sub-domains/
  social/                              /app/social
    social.routes.ts                   mounts instagram
    instagram/                         /app/social/instagram        connect, media, stories
      instagram-webhook/               /app/social/instagram/webhook          GET, POST
      instagram-webhook-event/         /app/social/instagram/webhook-events   list
  automations/                         /app/automations             list, create, show, edit, delete
  contacts/                            /app/contacts                list
```

| Folder | Endpoints | Tables it owns |
| --- | --- | --- |
| `social/instagram/` | connect, media, stories (3) | `instagram_accounts`, `instagram_account_settings`, `instagram_account_tokens`, `instagram_media` |
| `social/instagram/instagram-webhook/` | `GET`/`POST /app/social/instagram/webhook` (2) | — (stores events through `instagram-webhook-event`) |
| `social/instagram/instagram-webhook-event/` | webhook events (1) | `instagram_webhook_events` |
| `automations/` | list, create, show, edit, delete (5) | `automations`, `automation_runs`, `automation_run_events`, `automation_comment_logs` |
| `contacts/` | list (1) | `contacts` |

---

## 2. API rules

| Rule | Value |
| --- | --- |
| Base path | `/app/…`; Instagram endpoints under `/app/social/instagram/…` |
| Workspace | The active workspace (organization) comes from the signed access token. No workspace id in the path, query or body. Switching workspace gives a new token |
| Workspace type | Team workspaces only; a personal workspace gets `422` |
| Auth header | `Authorization: Bearer <access token>` on every route except `GET`/`POST /app/social/instagram/webhook` |
| Success status | `200` for GET, POST, PATCH (creates and idempotent replays too); `204` for DELETE |
| Idempotency | `X-Idempotency-Key` required on `POST /app/social/instagram/connect` and `POST /app/automations`. Missing or reused with another body → `422`; same key still running → `409` |
| Field names | `snake_case` in request and response bodies. The resource id is always `id` |
| Path params | `snake_case` and named after the resource (`:automation_id`) |
| Ids | Every id in the API is a public id `<prefix>_<21 [a-z0-9]>` ([§4](about:blank#4-public-ids)). Internal row ids never leave the server |
| Ids of another workspace | `404`, never `403` |
| Unknown fields | Rejected with `400` |
| Lists | Keyset paging: `limit` (default 25, max 100) and `after` (the `next` value of the previous page) |
| Webhooks | Provider payloads are read as received (not `snake_case`). The raw body is kept for the signature check. No auth, no CSRF check, no rate limit |
| Non-JSON success bodies | The `GET /app/social/instagram/webhook` challenge (`text/plain`) and the `POST /app/social/instagram/webhook` answer (`text/plain`) |

**Success body**

```json
{ "data": { "id": "aut_7g9i1k3m5o7q9s1u3w5y8" }, "meta": { "request_id": "req_…" } }
```

**List body**

```json
{
  "data": [ { "id": "aut_…" } ],
  "meta": { "request_id": "req_…", "pagination": { "per_page": 25, "next": "eyJ…", "has_more": true, "estimated_total": 42 } }
}
```

**Error body**

```json
{
  "error": {
    "type": "validation_error",
    "code": "invalid_field",
    "detail": "The end date must be after the start date.",
    "reason": "next_post_window_overlap",
    "errors": [ { "field": "next_post_ends_at", "message": "The end date must be after the start date." } ]
  },
  "meta": { "request_id": "req_…" }
}
```

| `type` | `code` (status) |
| --- | --- |
| `request_error` | `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `payload_too_large` (413), `unsupported_media_type` (415), `unprocessable_entity` (422) |
| `validation_error` | `invalid_field` (400) |
| `rate_limit_error` | `rate_limited` (429, with `Retry-After`) |
| `service_error` | `internal_error` (500), `service_unavailable` (503, with `Retry-After`) |

`reason` is a stable `snake_case` code the frontend can branch on ([§7](about:blank#7-error-reasons)). `errors[]` is only on `400`.

---

## 3. Permissions

| Code | Name | Allows |
| --- | --- | --- |
| `instagram_account:read` | View Instagram content | Browse posts, reels and stories |
| `instagram_account:manage` | Manage the Instagram account | Connect Instagram to the workspace |
| `automation:read` | View automations |  |
| `automation:create` | Create automations |  |
| `automation:update` | Edit automations | Edit, turn on, turn off |
| `automation:delete` | Delete automations |  |
| `contact:read` | View contacts |  |
| `webhook:read` | View webhooks | See received webhook events |

**Who gets what**

| Code | Owner | Admin | Member |
| --- | --- | --- | --- |
| `instagram_account:read` | ✓ | ✓ | ✓ |
| `instagram_account:manage` | ✓ | ✓ |  |
| `automation:read`, `automation:create`, `automation:update` | ✓ | ✓ | ✓ |
| `automation:delete` | ✓ | ✓ |  |
| `contact:read` | ✓ | ✓ | ✓ |
| `webhook:read` | ✓ | ✓ |  |

A call without the code gets `403` with `reason: missing_permission`.

---

## 4. Public ids

| Entity | Prefix | Table | Route param |
| --- | --- | --- | --- |
| Instagram account | `iga` | `app.instagram_accounts` | — (one per workspace) |
| Instagram webhook event | `iwe` | `app.instagram_webhook_events` | — |
| Automation | `aut` | `app.automations` | `:automation_id` |
| Contact | `con` | `app.contacts` | — |
| Automation run | `run` | `app.automation_runs` | — (used in DM button payloads) |
| Automation comment log | `acl` | `app.automation_comment_logs` | — |
| User | `usr` | `users` | — (in `*_by_user_id` fields) |

Tables without a public id: `instagram_account_settings`, `instagram_account_tokens` (1:1 with the account), `instagram_media` (addressed by its Instagram media id), `automation_run_events` (append-only ledger).

Instagram and Meta ids (user, media, comment, story) are digit strings, validated with `^[0-9]{1,64}$`.

---

## 5. Data objects

TypeScript shapes. Request bodies are validated with Zod; unknown keys are rejected.

### 5.1 Shared

```tsx
type PublicId<P extends string> = `${P}_${string}`;   // 21 [a-z0-9] after the underscore
type Timestamp = string;                               // ISO 8601 UTC, "2026-11-20T10:00:00Z"
type DateOnly = string;                                // "YYYY-MM-DD"
type InstagramId = string;                             // ^[0-9]{1,64}$

interface ListQuery { limit?: number; after?: string }  // limit 1–100, default 25
interface Pagination { per_page: number; next: string | null; has_more: boolean; estimated_total?: number }
interface ListResponse<T> { data: T[]; meta: { request_id: string; pagination: Pagination } }
interface ItemResponse<T> { data: T; meta: { request_id: string } }
```

### 5.2 Instagram account

```tsx
// POST /app/social/instagram/connect
interface InstagramConnectBody { code: string }        // 1–2000 chars; a trailing "#_" is stripped

interface InstagramAccountSettings {
  is_automation_enabled: boolean;
  is_public_reply_safety_enabled: boolean;
  public_reply_chance_percent: number;                  // 0–100
  public_reply_hour_limit: number;                      // 1–1000
  public_reply_gap_min_seconds: number;                 // 5–3600
  public_reply_gap_max_seconds: number;                 // 5–3600, ≥ min
  updated_at: Timestamp;
}

interface InstagramAccount {
  id: PublicId<'iga'>;
  instagram_user_id: InstagramId;
  username: string;
  name: string | null;
  biography: string | null;
  website: string | null;
  profile_picture_url: string | null;
  profile_url: string;                                  // https://instagram.com/{username}
  followers_count: number;
  follows_count: number;
  media_count: number;
  scopes: string[];
  connection_status: 'connected' | 'expired' | 'revoked' | 'error';
  token_expires_at: Timestamp | null;                   // the token itself is never returned
  settings: InstagramAccountSettings;
  connected_by_user_id: PublicId<'usr'> | null;
  connected_at: Timestamp;
  profile_synced_at: Timestamp | null;
}

interface InstagramConnectResponse {
  is_new_connection: boolean;                           // false = the same Instagram account reconnected
  instagram_account: InstagramAccount;
}
```

### 5.3 Instagram content and webhook events

```tsx
// GET /app/social/instagram/media
interface InstagramMediaQuery extends ListQuery {}      // limit 1–50, default 25; after = Instagram cursor
interface InstagramMediaItem {
  instagram_media_id: InstagramId;
  caption: string | null;
  media_type: 'image' | 'video' | 'carousel_album';
  media_product_type: 'feed' | 'reels' | 'story' | 'ad' | null;
  media_url: string | null;
  thumbnail_url: string | null;
  permalink: string;
  published_at: Timestamp;
  comments_count: number | null;
  like_count: number | null;
  children: { instagram_media_id: InstagramId; media_type: 'image' | 'video'; media_url: string | null }[] | null;
}

// GET /app/social/instagram/stories
interface InstagramStoryQuery extends ListQuery {}      // limit 1–50, default 25; after = Instagram cursor
interface InstagramStory {
  instagram_story_id: InstagramId;
  media_type: 'image' | 'video';
  media_url: string | null;
  thumbnail_url: string | null;
  permalink: string;
  published_at: Timestamp;
  expires_at: Timestamp;                                // published_at + 24 h
}

// GET /app/social/instagram/webhook-events
interface InstagramWebhookEventQuery extends ListQuery {
  status?: 'received' | 'queued' | 'processed' | 'skipped' | 'failed';
  event_kind?: 'comment' | 'message' | 'postback' | 'story_reply' | 'echo' | 'read' | 'reaction' | 'edit' | 'unknown';
  received_from?: Timestamp;
  received_to?: Timestamp;
}
interface InstagramWebhookEvent {
  id: PublicId<'iwe'>;
  event_kind: string;
  event_key: string;
  status: string;
  skip_reason: string | null;
  error_message: string | null;
  payload: Record<string, unknown>;                    // the event as received
  received_at: Timestamp;
  processed_at: Timestamp | null;
}
```

### 5.4 Automations

```tsx
interface OpeningMessage { text: string; button_title: string | null }
interface FollowRequestMessage { text: string; following_button_title: string; profile_button_title: string }
interface TextMessage { text: string }
interface FinalMessage { text: string; links: { title: string; url: string }[] }

// POST /app/automations (PATCH takes Partial<AutomationCreateBody>)
interface AutomationCreateBody {
  name: string;                                         // 1–255
  status?: 'live' | 'inactive';                         // default 'inactive'
  trigger_type: 'comment' | 'story_reply' | 'dm';
  target_scope?: 'any' | 'specific' | 'next';           // default 'any'
  target_instagram_media_id?: InstagramId | null;       // comment + specific
  target_instagram_story_id?: InstagramId | null;       // story_reply + specific
  next_post_starts_at?: Timestamp | null;               // next
  next_post_ends_at?: Timestamp | null;                 // next
  is_dm_keyword_trigger_enabled?: boolean;              // default true
  keywords?: string[];                                  // ≤ 50, each 1–100; at least 1 for dm
  tags?: string[];                                      // ≤ 20, each 1–50
  is_public_reply_enabled?: boolean;                    // comment only
  public_reply_texts?: string[];                        // 1–20 items, each 1–300, when enabled
  is_opening_message_enabled?: boolean;                 // default true
  opening_message?: OpeningMessage | null;
  is_follow_required?: boolean;
  follow_request_message?: FollowRequestMessage | null;
  is_email_collection_enabled?: boolean;
  email_request_message?: TextMessage | null;
  is_phone_collection_enabled?: boolean;
  phone_request_message?: TextMessage | null;
  final_message: FinalMessage;
}

// DELETE /app/automations/:automation_id (optional body)
interface AutomationDeleteBody { delete_reason?: 'mistake' | 'duplicate' | 'not_needed' | 'other'; delete_note?: string }

// GET /app/automations
interface AutomationListQuery extends ListQuery {
  status?: 'live' | 'inactive';
  trigger_type?: 'comment' | 'story_reply' | 'dm';
  target_scope?: 'any' | 'specific' | 'next';
  next_post_status?: 'waiting' | 'linked' | 'expired';
  search?: string;                                      // name, case-insensitive
  sort?: '-created_at' | 'created_at' | 'name' | '-name' | '-last_triggered_at' | '-completed_run_count';  // default -created_at
}

interface Automation {
  id: PublicId<'aut'>;
  name: string;
  status: 'live' | 'inactive';
  trigger_type: 'comment' | 'story_reply' | 'dm';
  target_scope: 'any' | 'specific' | 'next';
  target_instagram_media_id: InstagramId | null;
  target_instagram_story_id: InstagramId | null;
  next_post_starts_at: Timestamp | null;
  next_post_ends_at: Timestamp | null;
  next_post_status: 'waiting' | 'linked' | 'expired' | null;
  next_post_linked_at: Timestamp | null;
  is_dm_keyword_trigger_enabled: boolean;
  keywords: string[];
  tags: string[];
  is_public_reply_enabled: boolean;
  public_reply_texts: string[];
  is_opening_message_enabled: boolean;
  opening_message: OpeningMessage | null;
  is_follow_required: boolean;
  follow_request_message: FollowRequestMessage | null;
  is_email_collection_enabled: boolean;
  email_request_message: TextMessage | null;
  is_phone_collection_enabled: boolean;
  phone_request_message: TextMessage | null;
  final_message: FinalMessage | null;
  completed_run_count: number;
  last_triggered_at: Timestamp | null;
  created_by_user_id: PublicId<'usr'> | null;
  updated_by_user_id: PublicId<'usr'> | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
```

### 5.5 Contacts

```tsx
// GET /app/contacts
interface ContactListQuery extends ListQuery {
  search?: string;                                      // username, full name or email, case-insensitive
  tag?: string | string[];                              // has all the given tags
  has_email?: boolean;
  has_phone?: boolean;
  is_following_account?: boolean;
  automation_id?: PublicId<'aut'>;                      // had a run of this automation
  first_seen_from?: Timestamp;
  first_seen_to?: Timestamp;
  sort?: '-last_message_received_at' | '-first_seen_at' | 'first_seen_at' | 'username';  // default -last_message_received_at
}

interface Contact {
  id: PublicId<'con'>;
  instagram_user_id: InstagramId;
  username: string | null;
  full_name: string | null;
  profile_picture_url: string | null;
  followers_count: number | null;
  is_following_account: boolean | null;
  email: string | null;
  email_collected_at: Timestamp | null;
  phone: string | null;
  phone_collected_at: Timestamp | null;
  tags: string[];
  first_seen_at: Timestamp;
  last_message_received_at: Timestamp | null;
  last_message_sent_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
```

### 5.6 Webhook payload (read as received)

```tsx
// POST /app/social/instagram/webhook (Meta)
interface MetaWebhookBody {
  object: 'instagram';
  entry: {
    id: InstagramId;                                    // = instagram_accounts.instagram_user_id
    time: number;
    changes?: { field: 'comments' | string; value: { id: string; text?: string; from?: { id: string; username?: string }; media?: { id: string; media_product_type?: string } } }[];
    messaging?: {
      sender: { id: string };
      recipient: { id: string };
      timestamp: number;
      message?: {
        mid: string; text?: string; is_echo?: boolean; is_deleted?: boolean;
        quick_reply?: { payload: string };
        attachments?: { type: string; payload?: { email?: string } }[];
        reply_to?: { story?: { id: string; url?: string } };
      };
      postback?: { mid?: string; title?: string; payload: string };   // "<aut_…>::<run_…>"
      read?: { mid: string };
      reaction?: Record<string, unknown>;
      message_edit?: Record<string, unknown>;
    }[];
  }[];
}
```

---

## 6. Endpoint details

### 6.1 POST /app/social/instagram/connect

Finishes “Connect Instagram” for the active workspace. The frontend page `/auth/instagram/callback` posts the code Instagram sent back.

| Item | Value |
| --- | --- |
| Access | `PERM: instagram_account:manage` |
| Headers | `X-Idempotency-Key` required |
| Body | `InstagramConnectBody` |

Steps (Instagram calls first, then one transaction):

1. Exchange the code for a short-lived token, then for a long-lived token (about 60 days).
2. Read `/me`: `user_id`, `id`, `username`, `name`, `account_type`, `profile_picture_url`, `followers_count`, `follows_count`, `media_count`, `biography`, `website`.
3. Decide:
    - The workspace has no Instagram account and this one is not connected anywhere: insert `instagram_accounts`, `instagram_account_settings` (defaults) and `instagram_account_tokens`. `is_new_connection: true`.
    - The workspace already has **this** Instagram account: update profile, token and scopes, `connection_status = connected`, settings kept. `is_new_connection: false`.
    - The workspace has a **different** Instagram account: 409 `organization_already_has_instagram_account`.
    - This Instagram account belongs to **another** workspace: 409 `instagram_account_connected_elsewhere`.
4. Subscribe the account to the webhook fields `comments`, `messages`, `messaging_postbacks` (`POST /{instagram_app_user_id}/subscribed_apps`) when not yet subscribed. A failure is logged and does not fail the connect; connecting again retries it.
5. Write the audit entry `instagram_account.connected`.

`200` → `ItemResponse<InstagramConnectResponse>`

| Status | `reason` | When |
| --- | --- | --- |
| 400 |  | `code` missing or too long; unknown field |
| 403 | `missing_permission` | Not Owner/Admin |
| 409 | `instagram_code_invalid` | Code expired or already used, redirect URI mismatch |
| 409 | `instagram_account_not_professional` | Personal Instagram account |
| 409 | `organization_already_has_instagram_account` | Step 3 |
| 409 | `instagram_account_connected_elsewhere` | Step 3 |
| 422 |  | Personal workspace, or idempotency key problem |
| 503 | `instagram_unavailable` | Instagram did not answer |

### 6.2 GET /app/social/instagram/media

Posts and reels of the account, read live from Instagram (`/{instagram_app_user_id}/media`) for the post picker. Nothing is stored.

| Item | Value |
| --- | --- |
| Access | `PERM: instagram_account:read` |
| Query | `InstagramMediaQuery`: `limit` 1–50 (default 25), `after` (Instagram cursor) |
| Instagram fields | `id, caption, media_type, media_product_type, media_url, thumbnail_url, permalink, timestamp, comments_count, like_count, children{id,media_type,media_url}` |

`200` → `ListResponse<InstagramMediaItem>`; `meta.pagination` has no `estimated_total`.

| Status | `reason` | When |
| --- | --- | --- |
| 404 | `instagram_not_connected` | No Instagram account in this workspace |
| 409 | `instagram_reconnect_required` | Instagram auth error (code 190, subcodes 463/467); sets `connection_status` to `expired` or `error` |
| 503 | `instagram_unavailable` | Instagram down or rate-limited (`Retry-After`) |

### 6.3 GET /app/social/instagram/stories

Stories that are live now (`/{instagram_app_user_id}/stories`), for story-reply automations. Same access and errors as media.

| Item | Value |
| --- | --- |
| Query | `InstagramStoryQuery`: `limit` 1–50 (default 25), `after` (Instagram cursor) |
| Instagram fields | `id, media_type, media_url, thumbnail_url, permalink, timestamp` |

`200` → `ListResponse<InstagramStory>`; no `estimated_total`.

### 6.4 GET /app/social/instagram/webhook

Meta’s subscription check.

| Query | Rule |
| --- | --- |
| `hub.mode` | `subscribe` |
| `hub.verify_token` | Equals the configured verify token (constant-time compare) |
| `hub.challenge` | Echoed back |

`200` `text/plain` with the challenge · `403` `text/plain` `Forbidden`.

### 6.5 POST /app/social/instagram/webhook

Receives Instagram events from Meta and runs the matching automations.

| Item | Value |
| --- | --- |
| Access | `PUBLIC`. `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256 of the **raw** body with the Instagram app secret, constant-time compare |
| Body | `MetaWebhookBody` |

Handling:

1. Signature missing or wrong → 403 `invalid_webhook_signature`. App secret not configured → 503.
2. For each `entry`, find the workspace by `instagram_accounts.instagram_user_id = entry.id`.
3. For each event, insert one `instagram_webhook_events` row with `ON CONFLICT (event_key) DO NOTHING`. A conflict is a repeat delivery and is dropped.
4. Mark single events `skipped` with a reason: `unknown_account`, `account_disconnected`, `automation_disabled`, `echo`, `read_receipt`, `reaction`, `edit`.
5. Hand the rest to event processing (below), in order per Instagram account, and mark them `queued`.
6. Answer `200` `text/plain` `OK` straight away, so Meta does not retry. Events left in `received` or `queued` for more than 5 minutes are picked up again.

**What event processing does**

| Event | Recognised by | Action |
| --- | --- | --- |
| Comment | `changes[].field = comments` | Create or update the contact. Store the post in `instagram_media` if missing. Link waiting `next` automations: the post’s `published_at` is inside the window, and no other automation already targets that post; the link is one conditional update, so only one wins. Run **every** `live` `comment` automation for this post (`any`, `specific`, linked `next`) whose keywords match |
| DM | `message.text`, no `reply_to.story` | A run of this contact waiting for an email or phone takes it first (`quick_reply.payload` or `attachments[0].payload.email` is read as the answer). Otherwise the **first** `live` automation with `is_dm_keyword_trigger_enabled` and at least one matching keyword, oldest first |
| Story reply | `message.reply_to.story.id` | The first `live` `story_reply` automation, `any` or `specific` with that story id, whose keywords match |
| Button click | `postback.payload` = `<aut_…>::<run_…>` | Continues that run (opening button, “I’m following”). A `completed` run ignores it. If another run of the contact waits for an email, the email question is asked again and that run goes first |

A keyword matches when the lowercased text contains it. An automation with no keywords matches every comment and story reply, but no DM.

**Run steps**

1. Keyword match → start a run (one open run per automation and contact). Comment log `started`.
2. Public reply (comments only), when reply safety allows it:
    - skip a comment already handled (`duplicate`)
    - skip at random by `public_reply_chance_percent` (`random`)
    - skip when `public_reply_hour_limit` replies were sent in the last 60 minutes (`hour_limit`)
    - skip inside a random gap between `public_reply_gap_min_seconds` and `public_reply_gap_max_seconds` after the last reply (`gap`)
    - never repeat the last reply text of the automation
    - Reply safety off ⇒ always reply.
3. Opening DM (a private reply to the comment). Skipped when the contact got a DM in the last 24 hours. With a button, the run waits for `opening_message_button`.
4. Follow check: waits for `follow` until the contact confirms and Instagram reports them as following.
5. Email: waits for `email`; the answer is trimmed, lowercased and checked; a wrong one gets the question again. Other automations triggered meanwhile are saved in `queued_automations` (comment log `ignored_reason = waiting_for_other_email`) and start after the email arrives. Skipped when the contact already has an email.
6. Phone: waits for `phone`; at least 10 digits, stored normalised. Skipped when the contact already has a phone.
7. Final DM with up to 3 link buttons → run `completed`, `completed_run_count + 1`, the automation’s tags (or its name when it has none) added to the contact.
8. Every status change writes an `automation_run_events` row; a collected email or phone writes `email_received` / `phone_received`. `last_message_sent_at` is updated after every DM.

**Comment arriving while a run exists**

| Existing run | Comment log `ignored_reason` |
| --- | --- |
| Another automation waits for this contact’s email | `waiting_for_other_email` (queued) |
| This automation is waiting | `already_waiting` |
| This automation is running | `run_in_progress` |
| This automation’s last run is `completed` or `failed` | `previous_run_final` |

**Default texts** (when the saved message has none): email question “Please share your email to continue!”; phone question “Please share your phone number to continue!”; wrong email “Please provide a valid email address. Use the button below to share your email.”; button template text “What do you want to do next?”; link button title “Visit Link”. The email and phone questions carry a `user_email` / `user_phone_number` quick reply; if Instagram refuses it (code 100, subcode 2534015) the question is sent as plain text.

**Sends:** `POST /{instagram_app_user_id}/messages` (DMs; `recipient.comment_id` for private replies) and `POST /{comment_id}/replies` (public replies), with a random 200–1000 ms pause. Errors are saved on the comment log (`error_type`, `error_code`, `error_subcode`, `fbtrace_id`, `error_reason`). A token error sets `connection_status = error`.

### 6.6 GET /app/social/instagram/webhook-events

The workspace’s received webhook events, newest first.

| Item | Value |
| --- | --- |
| Access | `PERM: webhook:read` |
| Query | `InstagramWebhookEventQuery` |

`200` → `ListResponse<InstagramWebhookEvent>`. Events that matched no workspace are never listed.

### 6.7 GET /app/automations

`PERM: automation:read`. Query `AutomationListQuery`. Deleted automations are left out.

`200` → `ListResponse<Automation>`.

### 6.8 POST /app/automations

| Item | Value |
| --- | --- |
| Access | `PERM: automation:create` |
| Headers | `X-Idempotency-Key` required |
| Body | `AutomationCreateBody` |

Validation:

| Rule | Error |
| --- | --- |
| `target_scope = next` only with `comment`; `dm` only with `any` | 400 on `target_scope` |
| `specific` needs the media id (`comment`) or the story id (`story_reply`); the other id must be empty | 400 on the id field |
| `dm` needs at least 1 keyword | 400 on `keywords` |
| Public reply only for `comment`; when on, 1–20 texts | 400 |
| Each enabled step has its message object; `final_message` always | 400, one `errors[]` item per missing object |
| `next`: both dates given | 400 “Select both a start date and an end date for the next post.” |
| `next`: valid dates | 400 “The next post start and end dates are not valid.” |
| `next`: end after start | 400 “The end date must be after the start date.” |
| `next`: start not in the past. Checked only when the start is new or changed. Allowed back to 24 hours before now (the frontend sends local midnight). A window that has started may move later, never earlier | 400 “The start date cannot be in the past.” |
| `next`: end not in the past. Checked only when the end is new or changed | 400 “The end date cannot be in the past.” |
| `next` overlap: another `live`, waiting, unlinked automation of the workspace whose window overlaps and that shares a keyword, or where either has no keywords | 409 `next_post_window_overlap`: “Another automation”(name)” is already waiting for the keyword “(word)” between (date) and (date). Change the keyword or the dates.” With no keywords on either side: “…is already waiting for any comment (it has no keywords)…” |

Set by the server: `next_post_status = waiting` for `next`; keywords trimmed, lowercased and deduplicated; tags trimmed and deduplicated; `created_by_user_id` and `updated_by_user_id` from the token. Audit entry `automation.created`.

The frontend’s “Duplicate” button reads an automation and creates a new one from it with this endpoint.

`200` → `ItemResponse<Automation>`.

### 6.9 GET /app/automations/:automation_id

`PERM: automation:read`. `200` → `ItemResponse<Automation>` · `404` `automation_not_found` (missing, deleted or another workspace’s id).

### 6.10 PATCH /app/automations/:automation_id

`PERM: automation:update`. Body `Partial<AutomationCreateBody>`. All create rules run on the merged automation.

- `status = live` needs a complete flow (the same message rules as create).
- Changing the window of an `expired` automation puts it back to `waiting`.
- The window of a `linked` automation cannot change: 409 `next_post_already_linked`.
- Read-only: `completed_run_count`, `last_triggered_at`, `next_post_status`, `next_post_linked_at`.
- Audit entry `automation.updated` with the changed field names.

`200` → `ItemResponse<Automation>` · `404` `automation_not_found`.

### 6.11 DELETE /app/automations/:automation_id

`PERM: automation:delete`. Optional body `AutomationDeleteBody` (default reason `not_needed`; `delete_note` 1–280 required with `other`).

Soft delete. Its `running` and `waiting` runs are cancelled, each with a `status_changed` event. Runs and comment logs stay. Audit entry `automation.deleted`.

`204` · `404` `automation_not_found`.

### 6.12 GET /app/contacts

The Contacts page list: Instagram users who commented, sent a DM or replied to a story, with the email and phone they shared. Contacts are created and updated by event processing; there is no endpoint to add or edit them.

| Item | Value |
| --- | --- |
| Access | `PERM: contact:read` |
| Query | `ContactListQuery`. `search` is case-insensitive over username, full name and email (the page’s search box) |

`200` → `ListResponse<Contact>` · `400` on a bad filter value.

---

## 7. Error reasons

| `reason` | Status | Endpoints |
| --- | --- | --- |
| `missing_permission` | 403 | Every `PERM` endpoint |
| `instagram_code_invalid` | 409 | Connect |
| `instagram_account_not_professional` | 409 | Connect |
| `organization_already_has_instagram_account` | 409 | Connect |
| `instagram_account_connected_elsewhere` | 409 | Connect |
| `instagram_not_connected` | 404 | Media, stories |
| `instagram_reconnect_required` | 409 | Media, stories |
| `instagram_unavailable` | 503 | Connect, media, stories |
| `invalid_webhook_signature` | 403 | `POST /app/social/instagram/webhook` |
| `automation_not_found` | 404 | Automation show, edit, delete |
| `next_post_window_overlap` | 409 | Automation create, edit |
| `next_post_already_linked` | 409 | Automation edit |

---

## 8. Database design

### 8.1 Rules for every table

| Rule | Detail |
| --- | --- |
| Schema | Every table is in schema `app` |
| Ids | `id bigserial` primary key, internal only. Tables with a public id add `public_id varchar(28) NOT NULL` with the unique index `idx_<table>_public_id` |
| Workspace | `organization_id bigint NOT NULL` → `organizations.id ON DELETE CASCADE` (the one nullable exception is noted on its table). Parent tables have a unique index on `(organization_id, id)` |
| Child FKs | A child points at its parent with a composite FK `(organization_id, <parent>_id)` → `(organization_id, id)`, so a row can never point at another workspace’s row |
| Row-level security | Enabled and forced on every table: a session sees and writes only the rows of its active workspace |
| Times | `timestamp with time zone`. `created_at`, `updated_at` `NOT NULL DEFAULT now()`; check `chk_<table>_updated` (`updated_at >= created_at`); the app sets `updated_at` on every change |
| People | `created_by_user_id`, `updated_by_user_id`, `connected_by_user_id` → `users.id ON DELETE SET NULL`, each with a partial index `WHERE <col> IS NOT NULL` |
| Soft delete | `deleted_at`, `delete_reason varchar(20)` (`mistake`, `duplicate`, `not_needed`, `other`), `delete_note varchar(280)`; checks `chk_<table>_delete_reason_when_deleted` and `chk_<table>_delete_note_when_other`; unique indexes add `WHERE deleted_at IS NULL` |
| Value lists | `varchar(n)` with a CHECK of lowercase values; no database enums |
| String lists | `text[]` with `cardinality` checks. A GIN index only where a query uses `&&` or `@>` |
| Text search | `pg_trgm` GIN indexes (`gin_trgm_ops`) |
| Names | Index `idx_<table>_<cols>`, check `chk_<table>_<rule>`, FK `<table>_<col>_fk` |

### 8.2 Tables

| Table | One row is | Public id | Soft delete | Written by |
| --- | --- | --- | --- | --- |
| `instagram_accounts` | The Instagram business account of one workspace (1:1) | `iga` | — (status) | Connect |
| `instagram_account_settings` | Its automation switch and public reply safety (1:1), read by event processing | — | — | Connect (created with the defaults) |
| `instagram_account_tokens` | Its encrypted Instagram token (1:1) | — | — | Connect; renewed before it expires |
| `instagram_media` | A post or reel an automation ran on | — | — | Event processing |
| `instagram_webhook_events` | One received Meta webhook event | `iwe` | — | Webhook, event processing |
| `automations` | An automation | `aut` | yes | Automation endpoints, event processing (counters) |
| `contacts` | An Instagram user who interacted | `con` | — | Event processing |
| `automation_runs` | One automation flow for one contact | `run` | — | Event processing |
| `automation_run_events` | One status change, or a collected email/phone, of a run | — | — (append-only) | Event processing |
| `automation_comment_logs` | The step results of one comment × automation | `acl` | — | Event processing |

```
organizations ─┬─ instagram_accounts ─┬─ instagram_account_settings (1:1)
               │                      └─ instagram_account_tokens  (1:1)
               ├─ instagram_media
               ├─ instagram_webhook_events
               ├─ automations ─┬─ automation_runs ── automation_run_events
               │               └─ automation_comment_logs
               └─ contacts ──── automation_runs
```

### 8.3 `instagram_accounts`

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `bigserial` | NO |  | PK |
| `public_id` | `varchar(28)` | NO |  | `iga_…` |
| `organization_id` | `bigint` | NO |  | FK, one account per workspace |
| `instagram_user_id` | `varchar(64)` | NO |  | `/me` `user_id`; equals the webhook `entry.id` |
| `instagram_app_user_id` | `varchar(64)` | NO |  | `/me` `id`; used in send URLs |
| `username` | `varchar(64)` | NO |  |  |
| `name` | `varchar(255)` | yes |  |  |
| `biography` | `text` | yes |  |  |
| `website` | `varchar(500)` | yes |  |  |
| `profile_picture_url` | `text` | yes |  |  |
| `followers_count`, `follows_count`, `media_count` | `integer` | NO | `0` |  |
| `scopes` | `text[]` | NO | `'{}'` | Granted OAuth scopes |
| `connection_status` | `varchar(20)` | NO | `'connected'` | `connected`, `expired`, `revoked`, `error` |
| `connected_by_user_id` | `bigint` | yes |  | FK `users`, SET NULL |
| `connected_at` | `timestamptz` | NO | `now()` |  |
| `profile_synced_at` | `timestamptz` | yes |  |  |
| `created_at`, `updated_at` | `timestamptz` | NO | `now()` |  |
- Indexes: `idx_instagram_accounts_public_id` (unique), `idx_instagram_accounts_organization_unique` (unique `organization_id`), `idx_instagram_accounts_organization_id_id` (unique `(organization_id, id)`), `idx_instagram_accounts_instagram_user_unique` (unique `instagram_user_id` WHERE `connection_status <> 'revoked'`), `idx_instagram_accounts_connected_by_user_id` (WHERE NOT NULL).
- Checks: `chk_instagram_accounts_connection_status`, counts ≥ 0, `chk_instagram_accounts_updated`.

### 8.4 `instagram_account_settings`

Created with the defaults in the same transaction as the first connect; a reconnect keeps it. Event processing reads it for the master switch and public reply safety.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `bigserial` | NO |  | PK |
| `organization_id` | `bigint` | NO |  | FK |
| `instagram_account_id` | `bigint` | NO |  | Composite FK → `instagram_accounts`, CASCADE; unique |
| `is_automation_enabled` | `boolean` | NO | `true` | Master switch |
| `is_public_reply_safety_enabled` | `boolean` | NO | `false` |  |
| `public_reply_chance_percent` | `smallint` | NO | `80` | 0–100 |
| `public_reply_hour_limit` | `smallint` | NO | `60` | 1–1000 |
| `public_reply_gap_min_seconds` | `smallint` | NO | `20` | 5–3600 |
| `public_reply_gap_max_seconds` | `smallint` | NO | `60` | 5–3600, ≥ min |
| `created_at`, `updated_at` | `timestamptz` | NO | `now()` |  |
| `updated_by_user_id` | `bigint` | yes |  | FK `users`, SET NULL |
- Indexes: `idx_instagram_account_settings_account_unique` (unique `instagram_account_id`), `idx_instagram_account_settings_updated_by_user_id` (WHERE NOT NULL).
- Checks: `chk_instagram_account_settings_chance` (0–100), `chk_instagram_account_settings_hour_limit` (1–1000), `chk_instagram_account_settings_gap_min` and `chk_instagram_account_settings_gap_max` (5–3600), `chk_instagram_account_settings_gap_order` (min ≤ max), `chk_instagram_account_settings_updated`.

### 8.5 `instagram_account_tokens`

Never returned by any endpoint. Not readable by the normal app session; only the Instagram client reads it.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `bigserial` | NO |  | PK |
| `organization_id` | `bigint` | NO |  | FK |
| `instagram_account_id` | `bigint` | NO |  | Composite FK → `instagram_accounts`, CASCADE; unique |
| `access_token_ciphertext` | `text` | NO |  | Encrypted with the server’s secrets key |
| `token_type` | `varchar(20)` | NO | `'long_lived'` | `long_lived` |
| `expires_at` | `timestamptz` | yes |  | About 60 days after issue or renewal |
| `last_refreshed_at` | `timestamptz` | yes |  |  |
| `last_refresh_error` | `text` | yes |  |  |
| `created_at`, `updated_at` | `timestamptz` | NO | `now()` |  |

Indexes: `idx_instagram_account_tokens_account_unique`, `idx_instagram_account_tokens_expires_at`.

### 8.6 `instagram_media`

Stored when a comment arrives on a post not stored yet, and when a “next post” automation links to a post. `GET /app/social/instagram/media` reads Instagram live and does not write here.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `bigserial` | NO |  | PK |
| `organization_id` | `bigint` | NO |  | FK |
| `instagram_media_id` | `varchar(64)` | NO |  |  |
| `shortcode` | `varchar(64)` | yes |  |  |
| `media_type` | `varchar(20)` | yes |  | `image`, `video`, `carousel_album` |
| `media_product_type` | `varchar(20)` | yes |  | `feed`, `reels`, `story`, `ad` |
| `caption` | `text` | yes |  |  |
| `media_url`, `thumbnail_url`, `permalink` | `text` | yes |  |  |
| `published_at` | `timestamptz` | NO |  |  |
| `owner_username` | `varchar(64)` | yes |  |  |
| `comments_count`, `like_count` | `integer` | NO | `0` |  |
| `is_comment_enabled` | `boolean` | NO | `true` |  |
| `graph_data` | `jsonb` | NO | `'{}'` | The full Instagram object |
| `synced_at` | `timestamptz` | NO | `now()` |  |
| `created_at`, `updated_at` | `timestamptz` | NO | `now()` |  |

Indexes: `idx_instagram_media_organization_media_unique` (unique `(organization_id, instagram_media_id)`), `idx_instagram_media_organization_published` (`(organization_id, published_at DESC)`).

### 8.7 `instagram_webhook_events`

One row per event inside a Meta webhook delivery. Its unique `event_key` stops a repeated delivery from running twice. Kept 30 days.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `bigserial` | NO |  | PK |
| `public_id` | `varchar(28)` | NO |  | `iwe_…` |
| `organization_id` | `bigint` | yes |  | Empty when no workspace has this Instagram account; such rows are never shown |
| `instagram_user_id` | `varchar(64)` | NO |  | `entry.id` |
| `event_kind` | `varchar(20)` | NO |  | [§9](about:blank#9-allowed-values) |
| `event_key` | `varchar(200)` | NO |  | Comment id, message `mid`, or `postback:{mid}`; unique |
| `status` | `varchar(10)` | NO | `'received'` | `received`, `queued`, `processed`, `skipped`, `failed` |
| `skip_reason` | `varchar(30)` | yes |  | [§9](about:blank#9-allowed-values) |
| `payload` | `jsonb` | NO |  | The event as received |
| `error_message` | `text` | yes |  | When `failed` |
| `received_at` | `timestamptz` | NO | `now()` | Meta’s `entry.time` is in `payload` |
| `processed_at` | `timestamptz` | yes |  |  |
| `created_at`, `updated_at` | `timestamptz` | NO | `now()` |  |
- Indexes: `idx_instagram_webhook_events_public_id`, `idx_instagram_webhook_events_event_key_unique`, `idx_instagram_webhook_events_organization_received` (`(organization_id, received_at DESC, id)`), `idx_instagram_webhook_events_organization_status` (`(organization_id, status)`), `idx_instagram_webhook_events_pending` (`(received_at)` WHERE `status IN ('received','queued')`).
- Checks: `chk_instagram_webhook_events_kind`, `chk_instagram_webhook_events_status`, `chk_instagram_webhook_events_skipped` (`(status = 'skipped') = (skip_reason IS NOT NULL)`), `chk_instagram_webhook_events_payload` (a JSON object).

### 8.8 `automations`

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `bigserial` | NO |  | PK |
| `public_id` | `varchar(28)` | NO |  | `aut_…` |
| `organization_id` | `bigint` | NO |  | FK |
| `name` | `varchar(255)` | NO |  |  |
| `status` | `varchar(10)` | NO | `'inactive'` | `live`, `inactive` |
| `trigger_type` | `varchar(15)` | NO |  | `comment`, `story_reply`, `dm` |
| `target_scope` | `varchar(10)` | NO | `'any'` | `any`, `specific`, `next` |
| `target_instagram_media_id` | `varchar(64)` | yes |  | The `specific` post, or the post a `next` automation linked to |
| `target_instagram_story_id` | `varchar(64)` | yes |  | The `specific` story |
| `next_post_starts_at`, `next_post_ends_at` | `timestamptz` | yes |  | The “next post” window |
| `next_post_status` | `varchar(10)` | yes |  | `waiting`, `linked`, `expired` |
| `next_post_linked_at` | `timestamptz` | yes |  |  |
| `is_dm_keyword_trigger_enabled` | `boolean` | NO | `true` | Also run on DMs that contain a keyword |
| `keywords` | `text[]` | NO | `'{}'` | Lowercase |
| `tags` | `text[]` | NO | `'{}'` | Added to the contact on completion |
| `is_public_reply_enabled` | `boolean` | NO | `false` |  |
| `public_reply_texts` | `text[]` | NO | `'{}'` | One is picked at random |
| `is_opening_message_enabled` | `boolean` | NO | `true` |  |
| `opening_message` | `jsonb` | yes |  | [§10](about:blank#10-json-column-shapes) |
| `is_follow_required` | `boolean` | NO | `false` |  |
| `follow_request_message` | `jsonb` | yes |  |  |
| `is_email_collection_enabled` | `boolean` | NO | `false` |  |
| `email_request_message` | `jsonb` | yes |  |  |
| `is_phone_collection_enabled` | `boolean` | NO | `false` |  |
| `phone_request_message` | `jsonb` | yes |  |  |
| `final_message` | `jsonb` | yes |  |  |
| `completed_run_count` | `integer` | NO | `0` | Incremented in SQL |
| `last_triggered_at` | `timestamptz` | yes |  |  |
| `deleted_at`, `delete_reason`, `delete_note` |  | yes |  | Soft delete |
| `created_at`, `updated_at` | `timestamptz` | NO | `now()` |  |
| `created_by_user_id`, `updated_by_user_id` | `bigint` | yes |  | FK `users`, SET NULL |
- Indexes:
    - `idx_automations_public_id` (unique), `idx_automations_organization_id_id` (unique).
    - `idx_automations_live_triggers` on `(organization_id, trigger_type)` WHERE `status = 'live' AND deleted_at IS NULL`.
    - `idx_automations_next_post_waiting` on `(organization_id, next_post_ends_at)` WHERE `next_post_status = 'waiting' AND deleted_at IS NULL`.
    - `idx_automations_next_post_keywords` `USING gin (keywords)` WHERE `next_post_status = 'waiting' AND deleted_at IS NULL` (the overlap check’s `keywords && $1`).
    - `idx_automations_target_media` on `(organization_id, target_instagram_media_id)` WHERE `target_instagram_media_id IS NOT NULL AND deleted_at IS NULL` (the “post already used” check).
    - `idx_automations_organization_created` on `(organization_id, created_at DESC, id)` WHERE `deleted_at IS NULL`.
    - `idx_automations_name_trgm` `USING gin (name gin_trgm_ops)` WHERE `deleted_at IS NULL`.
    - `idx_automations_created_by_user_id`, `idx_automations_updated_by_user_id` (WHERE NOT NULL).
- Checks:
    - `chk_automations_status`, `chk_automations_trigger_type`, `chk_automations_target_scope`, `chk_automations_next_post_status`.
    - `chk_automations_name`: 1–255 characters after trim.
    - `chk_automations_next_only_comment`: `target_scope <> 'next' OR trigger_type = 'comment'`.
    - `chk_automations_dm_scope`: `trigger_type <> 'dm' OR target_scope = 'any'`.
    - `chk_automations_specific_target`: `specific` needs the media id (`comment`) or the story id (`story_reply`).
    - `chk_automations_next_post_fields`: `next` ⇔ status and both window ends set.
    - `chk_automations_next_post_window`: end > start.
    - `chk_automations_next_post_linked`: `linked` needs `target_instagram_media_id`.
    - `chk_automations_dm_needs_keywords`: `trigger_type <> 'dm' OR cardinality(keywords) >= 1`.
    - `chk_automations_keywords` ≤ 50; `chk_automations_tags` ≤ 20.
    - `chk_automations_public_reply`: on ⇒ at least one text.
    - `chk_automations_message_objects`: each message column is null or a JSON object.
    - `chk_automations_completed_run_count` ≥ 0.
    - The two soft-delete checks, `chk_automations_updated`.

### 8.9 `contacts`

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `bigserial` | NO |  | PK |
| `public_id` | `varchar(28)` | NO |  | `con_…` |
| `organization_id` | `bigint` | NO |  | FK |
| `instagram_user_id` | `varchar(64)` | NO |  | Webhook `sender.id` / `from.id` |
| `username` | `varchar(64)` | yes |  | Refreshed from every event that carries it |
| `full_name` | `varchar(255)` | yes |  |  |
| `profile_picture_url` | `text` | yes |  |  |
| `followers_count` | `integer` | yes |  | Empty = unknown |
| `is_following_account` | `boolean` | yes |  | Last follow-check result |
| `email` | `varchar(255)` | yes |  | Lowercase |
| `email_collected_at` | `timestamptz` | yes |  |  |
| `phone` | `varchar(20)` | yes |  | `+` and 10–15 digits |
| `phone_collected_at` | `timestamptz` | yes |  |  |
| `tags` | `text[]` | NO | `'{}'` |  |
| `first_seen_at` | `timestamptz` | NO | `now()` |  |
| `last_message_received_at` | `timestamptz` | yes |  |  |
| `last_message_sent_at` | `timestamptz` | yes |  | Drives the 24-hour opening-DM rule |
| `created_at`, `updated_at` | `timestamptz` | NO | `now()` |  |
- Indexes: `idx_contacts_public_id`, `idx_contacts_organization_id_id` (unique), `idx_contacts_organization_instagram_user_unique` (unique `(organization_id, instagram_user_id)`, the upsert target), `idx_contacts_organization_last_message` (`(organization_id, last_message_received_at DESC NULLS LAST, id)`), `idx_contacts_search_trgm` (`USING gin ((coalesce(username,'') || ' ' || coalesce(full_name,'') || ' ' || coalesce(email,'')) gin_trgm_ops)`), `idx_contacts_tags` (`USING gin (tags)`, for `tags @> $1`).
- Checks: `chk_contacts_email` (lowercase and email shape), `chk_contacts_phone` (`^\+?[0-9]{10,15}$`), `chk_contacts_email_collected` and `chk_contacts_phone_collected` (value ⇔ time), `chk_contacts_tags` ≤ 50, `chk_contacts_updated`.

### 8.10 `automation_runs`

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `bigserial` | NO |  | PK |
| `public_id` | `varchar(28)` | NO |  | `run_…`; used in button payloads |
| `organization_id` | `bigint` | NO |  | FK |
| `automation_id` | `bigint` | NO |  | Composite FK → `automations`, RESTRICT |
| `contact_id` | `bigint` | NO |  | Composite FK → `contacts`, RESTRICT |
| `trigger_type` | `varchar(15)` | NO |  | `comment`, `story_reply`, `dm` |
| `trigger_instagram_media_id`, `trigger_instagram_comment_id`, `trigger_instagram_story_id` | `varchar(64)` | yes |  |  |
| `trigger_text` | `text` | yes |  |  |
| `status` | `varchar(10)` | NO | `'running'` | `running`, `waiting`, `completed`, `failed`, `cancelled` |
| `current_step` | `varchar(20)` | NO | `'keyword_match'` | [§9](about:blank#9-allowed-values) |
| `waiting_for` | `varchar(25)` | yes |  | `opening_message_button`, `follow`, `email`, `phone` |
| `queued_automations` | `jsonb` | NO | `'[]'` | Automations to start after the email arrives ([§10](about:blank#10-json-column-shapes)) |
| `error_message` | `text` | yes |  |  |
| `started_at`, `last_step_at` | `timestamptz` | NO | `now()` |  |
| `waiting_since_at`, `completed_at`, `failed_at`, `cancelled_at` | `timestamptz` | yes |  |  |
| `created_at`, `updated_at` | `timestamptz` | NO | `now()` |  |
- Indexes: `idx_automation_runs_public_id`, `idx_automation_runs_organization_id_id` (unique), `idx_automation_runs_one_open` (unique `(automation_id, contact_id)` WHERE `status IN ('running','waiting')`), `idx_automation_runs_contact_waiting` (`(contact_id, waiting_since_at)` WHERE `status = 'waiting'`), `idx_automation_runs_organization_started` (`(organization_id, started_at)`).
- Checks: the value lists; `waiting` ⇔ `waiting_for` and `waiting_since_at`; `completed` ⇔ `completed_at`; `failed` ⇔ `failed_at`; `cancelled` ⇔ `cancelled_at`; `queued_automations` is an array; `chk_automation_runs_updated`.

### 8.11 `automation_run_events`

Append-only, written in the same transaction as each run change.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `bigserial` | NO |  | PK |
| `organization_id` | `bigint` | NO |  | FK |
| `automation_run_id` | `bigint` | NO |  | Composite FK → `automation_runs`, CASCADE |
| `event_type` | `varchar(20)` | NO |  | `status_changed`, `email_received`, `phone_received` |
| `status` | `varchar(10)` | yes |  | The new status, for `status_changed` |
| `occurred_at` | `timestamptz` | NO | `now()` |  |

Indexes: `idx_automation_run_events_run` (`(automation_run_id, occurred_at)`), `idx_automation_run_events_organization_time` (`(organization_id, occurred_at)`). Checks: the type list; `status` set ⇔ `status_changed`.

### 8.12 `automation_comment_logs`

One row per comment × automation (comment triggers only, ignored comments included). It is saved outside the run’s transaction so a failed step still leaves its log; for that reason `automation_run_id` and `contact_id` have no FK (the run or contact may not be committed when the log is written). Kept 180 days.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | `bigserial` | NO |  | PK |
| `public_id` | `varchar(28)` | NO |  | `acl_…` |
| `organization_id` | `bigint` | NO |  | FK |
| `automation_id` | `bigint` | NO |  | Composite FK → `automations`, RESTRICT (automations are only soft-deleted) |
| `automation_name` | `varchar(255)` | NO |  | Name at the time |
| `automation_run_id` | `bigint` | yes |  | No FK |
| `contact_id` | `bigint` | yes |  | No FK |
| `instagram_media_id` | `varchar(64)` | NO |  |  |
| `instagram_comment_id` | `varchar(64)` | NO |  |  |
| `comment_text` | `text` | yes |  |  |
| `commenter_instagram_user_id` | `varchar(64)` | yes |  |  |
| `commenter_username` | `varchar(64)` | yes |  |  |
| `public_reply_status` | `varchar(10)` | NO | `'off'` | Step status list |
| `public_reply_text` | `text` | yes |  |  |
| `public_reply_skip_reason` | `varchar(20)` | yes |  | `random`, `gap`, `hour_limit`, `duplicate` |
| `public_reply_at` | `timestamptz` | yes |  |  |
| `opening_dm_status` | `varchar(10)` | NO | `'off'` |  |
| `opening_dm_at`, `button_clicked_at` | `timestamptz` | yes |  |  |
| `follow_status` | `varchar(10)` | NO | `'off'` |  |
| `follow_at`, `follow_confirmed_at` | `timestamptz` | yes |  |  |
| `email_status` | `varchar(10)` | NO | `'off'` |  |
| `email_at` | `timestamptz` | yes |  |  |
| `email_received` | `varchar(255)` | yes |  |  |
| `phone_status` | `varchar(10)` | NO | `'off'` |  |
| `phone_at` | `timestamptz` | yes |  |  |
| `phone_received` | `varchar(50)` | yes |  |  |
| `final_dm_status` | `varchar(10)` | NO | `'off'` |  |
| `final_dm_at` | `timestamptz` | yes |  |  |
| `overall_status` | `varchar(10)` | NO | `'started'` | `started`, `waiting`, `completed`, `failed`, `ignored` |
| `current_step`, `failed_step` | `varchar(15)` | yes |  | [§9](about:blank#9-allowed-values) |
| `waiting_for` | `varchar(10)` | yes |  | `button`, `follow`, `email`, `phone` |
| `ignored_reason` | `varchar(30)` | yes |  | [§9](about:blank#9-allowed-values) |
| `error_type` | `varchar(15)` | yes |  | `instagram_api`, `token`, `network`, `code` |
| `http_status`, `error_code`, `error_subcode` | `integer` | yes |  |  |
| `error_message`, `error_reason` | `text` | yes |  |  |
| `fbtrace_id` | `varchar(100)` | yes |  |  |
| `error_response` | `jsonb` | yes |  |  |
| `error_stack` | `text` | yes |  | Never returned |
| `error_at` | `timestamptz` | yes |  |  |
| `created_at`, `updated_at` | `timestamptz` | NO | `now()` |  |
- Indexes: `idx_automation_comment_logs_public_id`, `idx_automation_comment_logs_comment_automation_unique` (`(instagram_comment_id, automation_id)`), `idx_automation_comment_logs_organization_created` (`(organization_id, created_at)`), `idx_automation_comment_logs_automation_created` (`(automation_id, created_at)`), `idx_automation_comment_logs_run` (`(automation_run_id)` WHERE NOT NULL), `idx_automation_comment_logs_media` (`(organization_id, instagram_media_id)`).
- Checks: each status list; `ignored` ⇔ `ignored_reason`; `failed` ⇒ `error_at`; `chk_automation_comment_logs_updated`.

---

## 9. Allowed values

| Column | Values |
| --- | --- |
| `instagram_accounts.connection_status` | `connected`, `expired`, `revoked`, `error` |
| `instagram_account_tokens.token_type` | `long_lived` |
| `instagram_media.media_type` | `image`, `video`, `carousel_album` |
| `instagram_media.media_product_type` | `feed`, `reels`, `story`, `ad` |
| `instagram_webhook_events.event_kind` | `comment`, `message`, `postback`, `story_reply`, `echo`, `read`, `reaction`, `edit`, `unknown` |
| `instagram_webhook_events.status` | `received`, `queued`, `processed`, `skipped`, `failed` |
| `instagram_webhook_events.skip_reason` | `unknown_account`, `automation_disabled`, `account_disconnected`, `echo`, `read_receipt`, `reaction`, `edit`, `unsupported` |
| `automations.status` | `live`, `inactive` |
| `automations.trigger_type`, `automation_runs.trigger_type` | `comment`, `story_reply`, `dm` |
| `automations.target_scope` | `any`, `specific`, `next` |
| `automations.next_post_status` | `waiting`, `linked`, `expired` |
| `delete_reason` | `mistake`, `duplicate`, `not_needed`, `other` |
| `automation_runs.status` | `running`, `waiting`, `completed`, `failed`, `cancelled` |
| `automation_runs.current_step` | `keyword_match`, `comment_reply`, `follow_check`, `email_collect`, `phone_collect`, `final_dm` |
| `automation_runs.waiting_for` | `opening_message_button`, `follow`, `email`, `phone` |
| `automation_run_events.event_type` | `status_changed`, `email_received`, `phone_received` |
| `automation_comment_logs.*_status` | `off`, `sent`, `waiting`, `done`, `skipped`, `failed` |
| `automation_comment_logs.public_reply_skip_reason` | `random`, `gap`, `hour_limit`, `duplicate` |
| `automation_comment_logs.overall_status` | `started`, `waiting`, `completed`, `failed`, `ignored` |
| `automation_comment_logs.current_step`, `failed_step` | `public_reply`, `opening_dm`, `follow_check`, `email_collect`, `phone_collect`, `final_dm` |
| `automation_comment_logs.waiting_for` | `button`, `follow`, `email`, `phone` |
| `automation_comment_logs.ignored_reason` | `waiting_for_other_email`, `already_waiting`, `run_in_progress`, `previous_run_final` |
| `automation_comment_logs.error_type` | `instagram_api`, `token`, `network`, `code` |

---

## 10. JSON column shapes

Checked before saving. Unknown keys are rejected.

| Column | Shape | Rules |
| --- | --- | --- |
| `automations.opening_message` | `{ "text": string, "button_title": string \| null }` | `text` 1–1000; `button_title` 1–20. With a button, the run waits for the click |
| `automations.follow_request_message` | `{ "text": string, "following_button_title": string, "profile_button_title": string }` | `text` 1–1000; titles 1–20. The profile link is built from the account’s username when sending |
| `automations.email_request_message` | `{ "text": string }` or null | 1–1000. Null → the default email question |
| `automations.phone_request_message` | `{ "text": string }` or null | 1–1000. Null → the default phone question |
| `automations.final_message` | `{ "text": string, "links": [{ "title": string, "url": string }] }` | `text` 1–1000; 0–3 links; `title` 1–20; `url` starts with `https://` |
| `automation_runs.queued_automations` | `[{ "automation_id": "aut_…", "queued_at": timestamp, "trigger": { "type", "instagram_media_id"?, "instagram_comment_id"?, "instagram_story_id"?, "text" } }]` | Started in order after the email arrives |