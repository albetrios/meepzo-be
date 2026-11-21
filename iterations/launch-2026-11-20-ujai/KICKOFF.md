# KICKOFF — launch-2026-11-20-ujai

## 1. Header

| Field | Value |
| --- | --- |
| Iteration | `launch-2026-11-20-ujai` (launch) |
| Mode | initial — Baseline `none` |
| Intake mode | `full` |
| Intake note | 2 received (`PRD.md`, `schema-routes.md` — the one drop file split in two, no words changed) |
| Drop placed | 2026-11-20 |
| Intake hash | `f91eaeb355eb` |
| Schema-routes | `b4fc53c41bfa` |
| Date | 2026-11-21 |
| Repositories | backend only (meepzo-fe is sibling work, not opened here) |

The plan proposes; agent-os decides. The route review ([plans/routes-final.md](plans/routes-final.md), final
2026-11-21) is built **ditto** — where agent-os cannot build it as written, kickoff stops and asks before anything
differs. Every other difference is recorded in `AS-BUILT.md` and synced back into the three change files.

## 2. Goal and scope

**Goal.** Bring the Instagram automation into meepzo: a team connects its Instagram professional account, builds
automations that answer comments, DMs and story replies with a step-by-step DM flow (opening message, follow check,
email, phone, final message), and sees the people who interacted as contacts — all inside a new `app` domain on the
platform's tenancy, permissions, workers and audit.

**In scope**

- The `app` domain with its ten tables and 18 routes ([route-changes.md](plans/route-changes.md)), the nine permission
  codes and a locked default Member role on every team (D1–D5, D22–D23).
- Connect, read, change settings, disconnect; Meta's deauthorize and data-deletion callbacks (D5, D22, D24).
- Posts, reels and stories read live for the post picker (D24).
- Contacts: list with search and filters, delete (wipe personal data, keep the row), per Instagram account (D25).
- Automations: list, create, show, edit, delete; one per Instagram account; the run engine with its comment-matching rule,
  reply safety, never-send-twice and queued automations (D26).
- The webhook: Meta's check, receiving and storing every event once, processing in order per account, the events list
  (D15, D28).
- Background work: the daily account check, the reconnect notice, five automation timers, the event pick-up and the
  clean-ups ([worker-changes.md](plans/worker-changes.md); D8–D10).

**Out of scope**

- Moving data from the legacy system ([D7](plans/decisions.md)).
- Live screen updates ([D11](plans/decisions.md)) and plan limits on automations or contacts ([D12](plans/decisions.md)).
- Read routes for runs and comment logs ([D13](plans/decisions.md)).
- A contact data export ([D25](plans/decisions.md), CQ4) and a backend status route for Meta's data deletion
  ([D24](plans/decisions.md), IQ2).
- The frontend (meepzo-fe): the callback page's OAuth `state` check, the Instagram page, the deletion status page — named
  in the route review for the sibling work only.

## 3. Locked decisions

Every RED answer, one line each; the full rows are in [plans/decisions.md](plans/decisions.md).

| # | Decision |
| --- | --- |
| D1 | The ten tables live in the `app` domain with the drop's names, and its routes in the `app` part of the API. |
| D2, D3 | A new default **Member** role — locked, on every team organization, existing ones included. |
| D4 | Instagram webhook events get their own permission code; `webhook:read` stays notify's. |
| D5 | Add read account, change settings and disconnect routes. |
| D7 | No import from the legacy system. |
| D8 | Runs and run history kept 180 days after they end; contacts and posts until the organization goes or the team deletes the contact; a run waits at most 7 days. |
| D9 | Daily token renewal and profile refresh; "next post" expiry every 15 minutes. |
| D10 | Reconnect notice in-app and by email to everyone who may manage the account. |
| D11, D12, D13 | No live updates, no plan limits, no run or comment-log read routes at launch. |
| D14 | The new design wins over the legacy behaviour in five flow rules. |
| D22 | (supersedes D6) Meta's deauthorize = disconnect; Meta's data deletion = disconnect + erase the account's token and profile; a team route deletes one contact. |
| D24 | Sub-domain 1 final — a disconnect cancels no run (your call); no deletion-request table; the frontend checks OAuth `state`. |
| D25 | Sub-domain 2 final — delete wipes personal data and keeps the row; a deleted contact's events expire after 30 days (your call); contacts per Instagram account (your call). |
| D26 | Sub-domain 3 final — your comment-matching rule (account + post + keyword, post-linked first, the oldest runs, others ignored); automations per Instagram account; button required on comment automations; read-only plan blocks automation writes. |
| D28 | Sub-domain 4 final — events of an unknown or revoked account are not stored; payload masked; a failing event holds back its account's later events. Route review final. |

## 4. Features and order

Screen features before the flow features that involve them. Each story is in `plans/features/<feature>/story.md`.

| # | Feature | Kind | Depends on |
| --- | --- | --- | --- |
| F1 | [app-permissions](plans/features/app-permissions/story.md) | screen | none |
| F2 | [instagram-connection](plans/features/instagram-connection/story.md) | screen | F1 |
| F3 | [instagram-content-picker](plans/features/instagram-content-picker/story.md) | screen | F2 |
| F4 | [contacts](plans/features/contacts/story.md) | screen | F2 |
| F5 | [automations](plans/features/automations/story.md) | screen | F2, F3 |
| F6 | [webhook-events](plans/features/webhook-events/story.md) | screen | F2 |
| F7 | [webhook-intake](plans/features/webhook-intake/story.md) | flow | F2, F6 |
| F8 | [comment-automation-flow](plans/features/comment-automation-flow/story.md) | flow | F7, F4, F5 |
| F9 | [dm-and-story-flow](plans/features/dm-and-story-flow/story.md) | flow | F7, F4, F5 |
| F10 | [next-post-linking](plans/features/next-post-linking/story.md) | flow | F8 |
| F11 | [instagram-account-health](plans/features/instagram-account-health/story.md) | flow | F2 |
| F12 | [data-retention-and-erasure](plans/features/data-retention-and-erasure/story.md) | flow | F4, F5, F6 |

## 5. ROUTE

One row per work item, in build order. A `sub-domain` row's spec is its route-review section and its checklist is that
section's code changes. Drivers: a NEW table → the staged-build prompt
([docs/getting-started/staged-build-prompt.md](../../docs/getting-started/staged-build-prompt.md)); background work and
flows → `/be-build-requirement`. Assignee: Rimeet Mavani.

| # | Work item | Kind | Depends on | Skill/driver | Acceptance | Assignee | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | The `app` domain, the nine codes, the locked Member role and the backfill, the team-only guards — `routes-final.md` § 1 IA1–IA3 (IAC1–IAC3) | sub-domain | — | staged-build prompt | AC-1.* | Rimeet Mavani | open |
| R2 | The one Instagram client and its settings — § 1 IA4 (IAC4) | sub-domain | R1 | `/be-build-requirement` | AC-2.* (connect) | Rimeet Mavani | open |
| R3 | 1.A Instagram account and token: routes 1, 2, 4, the two resolvers, token isolation, audit — § 1.A, IA5–IA7, IA10 (IAC5–IAC7) | sub-domain | R1, R2 | staged-build prompt | AC-2.* | Rimeet Mavani | open |
| R4 | 1.B Instagram account settings: route 3 — § 1.B | sub-domain | R3 | staged-build prompt | AC-2.* (settings) | Rimeet Mavani | open |
| R5 | 1.C Instagram media: routes 5–6 and the stored posts — § 1.C | sub-domain | R3 | staged-build prompt | AC-3.* | Rimeet Mavani | open |
| R6 | 1.D Meta callbacks: routes 7–8 — § 1.D | sub-domain | R3, R5 | `/be-build-requirement` | AC-2.* (Meta) | Rimeet Mavani | open |
| R7 | The daily account check and the reconnect notice — § 1 IA8, IA9 (IAC8, IAC9) | background | R3 | `/be-build-requirement` | AC-11.* | Rimeet Mavani | open |
| R8 | Contacts: routes 9–10, the contacts table, the erasure-step hook — § 2 (CTC1–CTC9) | sub-domain | R3 | staged-build prompt | AC-4.* | Rimeet Mavani | open |
| R9 | 3.A Automations: routes 11–15, the automations table, the read-only guard — § 3.A | sub-domain | R5, R8 | staged-build prompt | AC-5.* | Rimeet Mavani | open |
| R10 | 3.B Automation runs: the run engine, runs, run events, comment logs, the contacts list's automation filter — § 3.B | sub-domain | R9 | staged-build prompt | AC-8.*, AC-9.* | Rimeet Mavani | open |
| R11 | The five automation timers: "next post" expiry, waiting-run cancel, run and comment-log retention, deleted-automation purge — § 3 AU6 | background | R10 | `/be-build-requirement` | AC-10.*, AC-12.* | Rimeet Mavani | open |
| R12 | 4.B Instagram webhook events: route 18, the webhook-events table, the 30-day clean-up — § 4.B | sub-domain | R3 | staged-build prompt | AC-6.* | Rimeet Mavani | open |
| R13 | 4.A Instagram webhook receiver: routes 16–17, the raw request body shared with the Stripe receiver, the rate limit — § 4.A | sub-domain | R12 | `/be-build-requirement` | AC-7.* | Rimeet Mavani | open |
| R14 | Event processing: dispatch per event kind, order per account, the stuck-event pick-up, retries — § 4.A | background | R10, R13 | `/be-build-requirement` | AC-7.* | Rimeet Mavani | open |
| R15 | Flow — a comment runs its automation end to end | flow | R14 | `/be-build-requirement` | AC-8.* | Rimeet Mavani | open |
| R16 | Flow — a DM, a story reply and a button click run end to end | flow | R14 | `/be-build-requirement` | AC-9.* | Rimeet Mavani | open |
| R17 | Flow — a waiting "next post" automation links to a new post, or expires | flow | R11, R15 | `/be-build-requirement` | AC-10.* | Rimeet Mavani | open |
| R18 | Flow — retention and erasure: contact delete, Meta's data deletion, every clean-up | flow | R6, R8, R11, R12 | `/be-build-requirement` | AC-12.* | Rimeet Mavani | open |
| R19 | Close — `plans/acceptance.md` filled, the gates green, `AS-BUILT.md` summary and Standing deviations | flow | R1–R18 | be-kickoff-iteration › Close | every AC | Rimeet Mavani | open |

## 6. Requirements index

Each identifier is defined in its file under [plans/requirements/](plans/requirements/).

- [data.md](plans/requirements/data.md): `data.app-domain`, `data.organization-scope`, `data.instagram-account`,
  `data.instagram-account-settings`, `data.instagram-account-token`, `data.instagram-media`, `data.contact`,
  `data.automation`, `data.automation-run`, `data.automation-run-event`, `data.automation-comment-log`,
  `data.instagram-webhook-event`, `data.retention`, `data.erasure`
- [access.md](plans/requirements/access.md): `access.permission-codes`, `access.member-role`, `access.owner-admin-grants`,
  `access.existing-team-backfill`, `access.team-only`, `access.public-meta-routes`, `access.cross-organization-lookups`,
  `access.token-isolation`
- [operations.md](plans/requirements/operations.md): `operations.connect-instagram`, `operations.read-instagram-account`,
  `operations.change-account-settings`, `operations.disconnect-instagram`, `operations.browse-media`,
  `operations.browse-stories`, `operations.meta-deauthorize`, `operations.meta-data-deletion`, `operations.list-contacts`,
  `operations.delete-contact`, `operations.list-automations`, `operations.create-automation`,
  `operations.read-automation`, `operations.edit-automation`, `operations.delete-automation`, `operations.webhook-verify`,
  `operations.webhook-receive`, `operations.list-webhook-events`
- [background.md](plans/requirements/background.md): `background.per-account-order`, `background.never-send-twice`,
  `background.retry-policy`, `background.organization-scope`, `background.event-processing`,
  `background.stuck-event-pickup`, `background.message-sends`, `background.next-post-linking`,
  `background.queued-automations`, `background.next-post-expiry`, `background.daily-account-check`,
  `background.reconnect-notice`, `background.waiting-run-cancel`, `background.run-retention`,
  `background.comment-log-retention`, `background.webhook-event-retention`, `background.deleted-automation-purge`
- [notifications.md](plans/requirements/notifications.md): `notifications.reconnect-required`
- [realtime.md](plans/requirements/realtime.md): n/a — no live updates at launch (D11)
- [integrations.md](plans/requirements/integrations.md): `integrations.instagram-graph-api`,
  `integrations.instagram-login`, `integrations.webhook-subscription`, `integrations.meta-signed-requests`,
  `integrations.instagram-messaging`, `integrations.send-pause`
- [files.md](plans/requirements/files.md): n/a — no uploads or exports
- [quality.md](plans/requirements/quality.md): `quality.audit`, `quality.log-masking`, `quality.idempotency`,
  `quality.error-reasons`, `quality.reply-safety`, `quality.rate-limit`, `quality.read-only-plan`,
  `quality.no-plan-limits`, `quality.personal-data`

## 7. Open AMBER items

Safe defaults taken and still open — any can change before or during kickoff (a new decision row).

| # | Default |
| --- | --- |
| D15 | Event intake: store each event once before answering Meta; skip single events with a reason; process in order per account; a store failure is not a success. |
| D16 | Failures: capped retries, then `failed` with the error; never send a message twice. |
| D17 | Public reply safety order: duplicate → random → hour limit → gap; reply sent when the counts cannot be read. |
| D18 | Flow details: ask for the email again on a new comment; ignore clicks on finished runs; accept the email from a quick reply, an attachment or typed text; unknown events skipped. |
| D19 | Fixes inside schema-routes: one button-wait name; `unsupported` skip; the final message always required. |
| D20 | Naming and settings: the repository's route, permission-code and audit styles, one app-secret setting, Graph API `v24.0`, English default DM texts. |
| D21 | Left to agent-os, with the requirement stated: background topology, unit of work, token isolation, cross-organization lookups, the webhook rate limit, logs. |
| D23 | `contact:delete` held by Owner and Admin, not Member. |
| D27 | The read-only plan blocks automation writes only; connect, settings, disconnect and contact delete stay open. |
| D29 | Acceptance criteria cite `PRD.md`, else `schema-routes.md`, else a decision. |

Smaller timing defaults (the clean-ups' hour, the hourly waiting-run check) are marked open in
[plans/worker-changes.md](plans/worker-changes.md).

## 8. Standing deviations

n/a — the launch has no Baseline and no earlier `AS-BUILT.md`; its own Standing deviations start empty and are written
during implementation.

## 9. Definition of done

- Every ROUTE row `done`, or `deferred` with your OK.
- [plans/acceptance.md](plans/acceptance.md) filled — every `AC-*` row with its Result and Evidence.
- `AS-BUILT.md` written: one row per ROUTE row, the closing summary, and the Standing deviations.
- The repository's gates green: `pnpm validate`, `pnpm ci:local` (the build and the full test suite), `pnpm tsdoc:check`,
  `pnpm routes:catalog:check`, `pnpm docs:check`.

## 10. Verification

- **Gates** — `pnpm iteration:intake launch-2026-11-20-ujai --check`, `pnpm validate`, `pnpm ci:local`,
  `pnpm test:rls-role` (every new table read and written as the row-level-security role), `pnpm routes:catalog:check`.
- **Acceptance (Intake mode `full`)** — the acceptance criteria traced in [plans/acceptance.md](plans/acceptance.md), each
  to its `PRD.md` / `schema-routes.md` line or decision (D29), with a test or command as evidence.
- **Review** — `/be-pre-merge-review` at Close (review only).
