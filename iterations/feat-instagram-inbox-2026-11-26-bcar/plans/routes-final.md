# Meepzo API — Instagram inbox, final routes, sub-domain by sub-domain

Started from branch `feat/instagram-automation` at `8f36d39`. Every decision reads **today → after** (`SD/` =
`src/domains/app/sub-domains/`). Sources: [`coverage.md`](coverage.md), [`decisions.md`](decisions.md) (I-D1–I-D14),
[`route-changes.md`](route-changes.md), [`db-changes.md`](db-changes.md), [`worker-changes.md`](worker-changes.md).

## File header — legend

Paths are under `/api/v1/app`; `{x_id}` is a public id; **Gate** is the permission the caller needs (contact codes,
[I-D4](decisions.md)); **Idem** `req` = `X-Idempotency-Key` required. New route numbers continue from **155**
(the connect flow ended at 154).

## File header — sub-domains (in build order)

| # | Sub-domain | Folder (`SD/…`) | Paths | Routes | Builds on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Instagram automation message (rename) | `instagram-sending/instagram-message/` → `instagram-sending/instagram-automation-message/` | none | 0 | — | **rev 1 — awaiting your OK** |
| 2 | Instagram conversation | `instagram-conversation/` (new) with nested `instagram-conversation-message/`, `instagram-conversation-note/` | `/social/instagram/conversations…` | new | 1, contacts, upload | draft |
| 3 | Saved reply | `saved-reply/` (new, shared across channels — [I-D2](decisions.md)) | `/saved-replies…` | new | — | draft |

## File header — code layout and tables without routes

| Sub-domain | Table | Lives in | Written by |
| --- | --- | --- | --- |
| 1 | `app.instagram_automation_messages` (renamed) | `instagram-sending/instagram-automation-message/` | the paced sender (unchanged) |
| 2 | `app.instagram_conversation_messages` | `instagram-conversation/instagram-conversation-message/` | the webhook intake (inbound), the result save (automation / broadcast), the team-reply route |

## File header — rules for every sub-domain

| # | Rule |
| --- | --- |
| K1 | **One write path per message source** (brief rule 11): inbound by the intake's event transaction, automation / broadcast by the sender's one result save, `team_member` by its route — never a second writer. |
| K2 | **Message text never reaches a log or Sentry** — only public ids, kinds and Meta codes. |
| K3 | **Every new tenant table** has FORCE RLS with USING and WITH CHECK on `organization_id`, the retention-sweep arm where the upkeep drops parts. |

---

## 1. Instagram automation message (rename) — rev 1 (2026-11-26) — no routes; awaiting your OK

Code: `SD/instagram-sending/instagram-message/` — the paced sender's ledger (one row per automation or broadcast DM;
no text; split by ISO week; ~30 days) and its nested send attempts. This sub-domain only **renames** it
([I-D13](decisions.md)); behaviour, columns and routes are unchanged.

### 1.1 Decisions (whole sub-domain)

| # | Decision |
| --- | --- |
| AM1 | **Table** `app.instagram_messages` → **`app.instagram_automation_messages`**, by one migration: the parent, its weekly parts and the DEFAULT part, its keys, checks, indexes and RLS policy names (`…_instagram_messages_…` → `…_instagram_automation_messages_…`), the composite foreign keys that point at it (`broadcast_id` link, send attempts), and the partition upkeep's CASE entry (`migrations/20261125190000_app_partition_upkeep.sql:95`). Expand-only is not possible for a rename: it runs in one transaction, and the release that ships it is the first to read the new name (the previous release stops before the migration — the deploy order the migration runner already enforces). |
| AM2 | **Code follows the table** (the repo's naming rule — a sub-domain is named for its table; reuse rule — never old and new side by side): the folder `instagram-message/` → `instagram-automation-message/`, files `instagram-message.*` → `instagram-automation-message.*`, the Drizzle table export, `InstagramMessageService` / `Repository` / types → `InstagramAutomationMessage…`, the FORCE-RLS list (`src/infrastructure/database/utils/force-rls-tables.constants.ts:42`), the partition upkeep spec (`src/domains/app/workers/app-partition-upkeep.constants.ts`), the RLS test matrix. Other option: rename the table only and keep the code names — rejected, the names would disagree for good. |
| AM3 | **What does not change**: the public id prefix `igm_` (ids already handed out stay valid), the routes that read it (24–26, 36–37 — failed-message summaries and retries), every behaviour. The nested `instagram_send_attempts` keeps its name (it is the attempt of a send, not of an automation). |
| AM4 | **Name note** — the table also holds broadcast sends ([I-D13](decisions.md)); the TSDoc and the overview say so on the first line. |

### 1.2 Open questions

None.

### 1.3 Tables and relations

| Table | Change |
| --- | --- |
| `app.instagram_messages` → `app.instagram_automation_messages` | renamed with every dependent name; columns unchanged |

### 1.4 Permissions

No change — the routes reading it keep their gates.

### 1.5 Common to every route

n/a — no routes.

### 1.6 Objects returned

No change (the `igm_` ids and response shapes stay).

### 1.7 Routes

None added or changed.

### 1.8 Request details

n/a.

### 1.9 Errors

n/a.

### 1.10 Rules worth knowing

- A conversation message of an automation or broadcast (sub-domain 2) links its ledger row by `instagram_automation_message_id`.

### 1.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| AMC1 | AM1: one migration renaming the table, parts, constraints, indexes, policy, foreign keys and the upkeep entry; `pnpm db:migrate:lint`; the restore smoke unaffected |
| AMC2 | AM2: folder, files, identifiers, the FORCE-RLS list, the upkeep spec, the public-id registry comment, overviews (`instagram-sending.overview.md`, `instagram-message.overview.md` → renamed), `src/domains/CLAUDE.md`'s domain map, docs mentioning the table |
| AMC3 | Tests: the whole instagram-sending, broadcast, channel-account and webhook suites pass unchanged in behaviour; the RLS matrix and the FORCE-RLS policy test name the new table; `pnpm test:rls-role:changed` |

### 1.12 Nested sub-domains

`instagram-send-attempt` (schema and repository inside the folder) — moves with the folder; its table name is unchanged.
