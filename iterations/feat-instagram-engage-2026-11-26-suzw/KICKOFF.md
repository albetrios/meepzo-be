# KICKOFF — feat-instagram-engage-2026-11-26-suzw

## 1. Header

| Field | Value |
| --- | --- |
| Iteration | `feat-instagram-engage-2026-11-26-suzw` |
| Mode | initial (Baseline `none`) |
| Intake mode | brief — from scratch |
| Intake note | 1 received (`BRIEF.md`) · from scratch |
| Drop placed | 2026-11-26 |
| Intake hash | `98219bc48cfb` |
| Schema-routes | — (brief) |
| Date | 2026-11-27 |

## 2. Goal and scope

The team moderates Instagram comments and @mentions from our app: every comment on the account's posts and reels is
kept 90 days and listed with what the automation answered; the team replies, hides, unhides and deletes; mentions arrive
by webhook, are listed beside the posts the account is tagged in, and can start a `mention` automation. Route review:
[`plans/routes-final.md`](plans/routes-final.md) (final 2026-11-27).

- **In scope:** `app.instagram_comments`, `app.instagram_mentions`; routes 175–181 and the changes to routes 28 / 30
  (trigger `mention`); the permission `instagram-comment:manage`; the `mentions` webhook field and event kind; the
  comment store in the webhook processing; Meta's unhide, delete and tagged-media calls; 90-day retention; the contact
  erase of both tables.
- **Out of scope:** liking posts or comments (`instagram_manage_engagement`), Facebook Page comments, comment insights
  (→ `feat-instagram-insights`), deleting a mention (Meta has no call), a background queue for team writes (IC3: direct,
  gated), the frontend screens.

## 3. Locked decisions

| # | Summary |
| --- | --- |
| [E-D1](plans/decisions.md) | Engage planned first, Baseline none |
| [E-D2](plans/decisions.md) | Every comment stored, matched or not |
| [E-D3](plans/decisions.md) | 90 days for comments and mentions, dropped by the shared upkeep |
| [E-D4](plans/decisions.md) | Comment and caption mentions both start the `mention` trigger |
| [E-D5](plans/decisions.md) | `instagram-comment:manage` for Owner, Admin, Editor; tables `app.instagram_comments`, `app.instagram_mentions` |
| [E-D6](plans/decisions.md)–[E-D7](plans/decisions.md) | Route review sub-domains 1–2 confirmed |

## 4. Features and order

1 `comment-inbox` → 2 `comment-moderation` → 3 `mentions` ([stories](plans/features/)).

## 5. ROUTE

| # | Work item | Kind | Depends on | Skill/driver | Acceptance | Assignee | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | `app.instagram_comments` (monthly, 90 days, upkeep entry) — routes-final § 1.3 (ICC1 table part) | table | — | staged-build prompt (NEW table) | AC-1.3 | — | open |
| R2 | `app.instagram_mentions` (monthly, 90 days, upkeep entry) — § 2.3 (IMC1 table part) | table | — | staged-build prompt (NEW table) | AC-3.1 | — | open |
| R3 | 1 Instagram comment: routes 175–179, permission `instagram-comment:manage`, Meta unhide / delete — § 1 (ICC2, ICC3) | sub-domain | R1 | `/be-build-requirement` | AC-1.2, AC-2.1–AC-2.5 | — | open |
| R4 | 2 Instagram mention: routes 180–181, Meta tagged media, trigger `mention` on routes 28 / 30 — § 2 (IMC3 routes part, IMC4) | sub-domain | R2 | `/be-build-requirement` | AC-3.2, AC-3.3 | — | open |
| R5 | Background — the webhook comment processing stores every comment once (WC-1) — IC1 | background | R1 | `/be-worker-complete` | AC-1.1 | — | open |
| R6 | Background — `mentions` subscribed (WC-2), the mention event kind, store and text read, the run start per mention with its message path (WC-3) — IM1–IM4 (IMC2, IMC3) | background | R2, R4 | `/be-worker-complete` | AC-3.1, AC-3.4 | — | open |
| R7 | Privacy — the contact erase empties both tables' text and names; the organization delete; no text in logs — IC5, IM5, K2 | flow | R1, R2, R5, R6 | `/be-build-requirement` | AC-3.5 | — | open |
| R8 | Flow and close — every route's errors end to end; `docs/routes.txt`, OpenAPI, i18n, `plans/frontend-route-map.md` | flow | R1–R7 | `/be-build-requirement` | BRIEF-1–BRIEF-5 | — | open |

## 6. Requirements index

| File | Identifiers |
| --- | --- |
| [operations.md](plans/requirements/operations.md) | `operations.comment-list`, `operations.comment-moderation`, `operations.mention-list`, `operations.tagged-media`, `operations.mention-trigger` |
| [integrations.md](plans/requirements/integrations.md) | `integrations.mentions-webhook` |
| [access.md](plans/requirements/access.md) | `access.comment-moderation`, `access.tenant-404` |
| [quality.md](plans/requirements/quality.md) | `quality.comment-writes-paced`, `quality.tenant-isolation`, `quality.mention-privacy`, `quality.comment-retention` |
| [background.md](plans/requirements/background.md) | `background.comment-store`, `background.mention-store` |
| [data.md](plans/requirements/data.md) | `data.instagram-comment`, `data.instagram-mention`, `data.comment-delete` |

## 7. Open AMBER items

| # | Default | Settles when |
| --- | --- | --- |
| EO1 (owner test) | Meta's `mentions` payload, the `mentioned_media` / `mentioned_comment` text reads and the private reply to a comment mention, as routes-final IM2 / IM4 assume | the Meta dev app, before R6 closes |
| 1.8 (176) ⚠️ | a public reply of 1–2,200 characters (Meta's comment limit, unverified) | EO1 |
| WC-4 | team writes sent directly in the request, gated (IC3) — no background piece | settled at the route review; kept for the record |

## 8. Standing deviations

`n/a — initial` (Baseline `none`). The inbox iteration (`feat-instagram-inbox-2026-11-26-bcar`, implementing) shares the
webhook processing and the partition upkeep: R5 / R6 add their event handling beside the inbox's intake, and R1 / R2
add upkeep entries after the inbox's (eight tables today) — rebase on whichever lands first.

## 9. Definition of done

Every ROUTE row `done` (or `deferred` with the user's OK); `plans/acceptance.md` filled; the `AS-BUILT.md` summary and
Standing deviations written; the gates green.

## 10. Verification

Brief mode: every `BRIEF.md` acceptance line traced in `plans/acceptance.md`. Gates: `pnpm validate`, `pnpm tsdoc:check`,
`pnpm db:migrate:lint`, `pnpm routes:catalog:check`, `pnpm docs:check`, the touched suites, `pnpm test:rls-role:changed`,
`pnpm test:contract` (Meta client), `pnpm iteration:frontend-map <iteration> --check`.
