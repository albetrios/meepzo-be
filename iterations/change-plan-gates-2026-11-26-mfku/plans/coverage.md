# Coverage — change-plan-gates-2026-11-26-mfku

Mode **initial** (Baseline `none`, Intake mode `brief`, from scratch) · Intake hash `26273bac1cb0` · 2026-11-26.
Sources: `intake-files/BRIEF.md` (`BRIEF:L…`, the cover and the acceptance criteria) and
`intake-files/Plan-Gates-Proposal.md` (`proposal:L…`, the source the brief was written from).
A brief from scratch has no `PRD.md` or `schema-routes.md`, so **Reconciliation** checks the brief against
**the code as it stands** (`feat/instagram-automation` at `e247c4a`) and against the frozen
`feat-instagram-dm-sending-2026-11-23-oxak` iteration's decisions and Standing deviations.

Step 4 answers: `decisions.md` P1–P22 (P2, P11, P15 are superseded by P17, P18, P19; P22 is open for Step 5).

Status: `covered` (a requirement reaches it) · `open` (waits for a RED answer in Step 4) · `out-of-scope` (with its reason).
Requirement identifiers are proposals until Step 6 writes `plans/requirements/`.

## Coverage

### What changes

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| BRIEF:L14 | Key registry: kind, type, global default, namespaced keys | `quality.entitlement-key-registry` | entitlement-module | BRIEF:L122 | covered — P21, P17 |
| BRIEF:L19 | One module: resolve, can, limit, consume, refusal | `access.entitlement-module-single-entry` | entitlement-module | BRIEF:L118 | covered — P1 |
| BRIEF:L21 | resolve wraps plan access + overrides, one uncached read | `quality.entitlement-single-read` | entitlement-module | BRIEF:L125 | covered (R4: the merge already exists; a per-request memo is NEW) |
| BRIEF:L24 | consume: atomic, month cap kept, account lock kept, idempotent | `operations.entitlement-consume` | limit-gates | BRIEF:L123 | covered — P8, P18, P23: counted limits stay with their counters and read `limit()` |
| BRIEF:L28 | Route declarations `config.planGate` on every write route | `access.route-plan-gate-declaration` | route-gates | BRIEF:L115 | covered (128 write routes, R1) |
| BRIEF:L29 | One global preHandler replaces the hand-added one | `access.route-plan-gate-enforcement` | route-gates | BRIEF:L124 | covered — P4 (order test first, R2) |
| BRIEF:L31 | Job gates declared in the job registry; worker checks at claim | `background.job-plan-gate-declaration` | job-gates | BRIEF:L116 | covered — P12 |
| BRIEF:L33 | One refusal shape built only by the module | `quality.plan-refusal-shape` | refusal-shape | BRIEF:L119 | covered (R10: statuses unchanged, body unified) |
| BRIEF:L36 | Coverage test reads the live declarations; the hand-kept model goes | `quality.plan-gate-coverage-test` | route-gates, job-gates | BRIEF:L115–117 | covered (R1, R2) |
| BRIEF:L39 | Entitlements GET: value + source + usage | `operations.entitlements-read-source` | entitlements-read | BRIEF:L121 | covered (R17: usage exists; source is NEW) |
| BRIEF:L41 | No `getPlanAccess` / `checkFeature` outside the module; policy test | `quality.no-direct-plan-reads` | clean-up | BRIEF:L118 | covered — P20 |

### Rules

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| BRIEF:L81 | Gate order unchanged (CA11/P61) | `access.feature-gate-order` | feature-gates | BRIEF:L124 | covered — P20 |
| BRIEF:L84 | Read-only guard before the idempotency claim | `access.read-only-before-idempotency` | route-gates | BRIEF:L124 | covered (R2: the order test is NEW, not "unchanged") |
| BRIEF:L86 | BL2: no plan cache; per request/job memo only | `quality.entitlement-single-read` | entitlement-module | BRIEF:L125 | covered |
| BRIEF:L89 | Merge order override → plan → global default | `data.entitlement-merge-order` | entitlement-module | BRIEF:L122 | covered — P19 |
| BRIEF:L90 | Unknown keys fail at compile time; override writes read the registry | `quality.entitlement-key-registry` | entitlement-module | BRIEF:L122 | covered |
| BRIEF:L92 | Month-cap concurrency keeps lane C's logic | `operations.entitlement-consume` | limit-gates | BRIEF:L123 | covered (R7) |
| BRIEF:L94 | Downgrade rule per kind | `operations.entitlement-downgrade-rule` | feature-gates, limit-gates | — | covered (as built today; R13) |
| BRIEF:L97 | Product-first defaults; `LAPSED_PLAN_READ_ONLY_ENABLED=false` at launch | `quality.product-first-defaults` | entitlement-module | — | covered — P5, P13 |
| BRIEF:L98 | No plan names in feature code | `quality.no-direct-plan-reads` | clean-up | BRIEF:L118 | covered |
| BRIEF:L99 | Rate limits stay outside plans | — | — | — | out-of-scope: BRIEF:L134 |

### Open decisions in the brief

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| BRIEF:L103 | Module location | `access.entitlement-module-single-entry` | entitlement-module | — | covered — P1 |
| BRIEF:L105 | Starting keys | `quality.entitlement-key-registry` | entitlement-module | — | covered — P21 |
| BRIEF:L108 | Upgrade hint shape | `quality.plan-refusal-shape` | refusal-shape | — | covered — P7 |
| BRIEF:L109 | Namespacing + migrating stored keys | `data.entitlement-key-namespacing` | entitlement-module | — | covered — P17 |

### Acceptance criteria

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| BRIEF:L115 | Every write route declares; test fails on an undeclared one | `access.route-plan-gate-declaration` | route-gates | AC-1 | covered |
| BRIEF:L116 | Every paid job declares; test fails on an undeclared one | `background.job-plan-gate-declaration` | job-gates | AC-2 | covered |
| BRIEF:L117 | The hand-kept model is deleted | `quality.plan-gate-coverage-test` | clean-up | AC-3 | covered |
| BRIEF:L118 | No direct plan reads outside the module; policy test | `quality.no-direct-plan-reads` | clean-up | AC-4 | covered |
| BRIEF:L119 | One refusal body shape, asserted | `quality.plan-refusal-shape` | refusal-shape | AC-5 | covered |
| BRIEF:L120 | A limit change is one override row | `data.entitlement-override-row` | entitlement-module | AC-6 | covered — P18: the switches and the 2 limits; seats have no override |
| BRIEF:L121 | GET returns value, source, usage | `operations.entitlements-read-source` | entitlements-read | AC-7 | covered |
| BRIEF:L122 | Unit tests: merge order, expiry, typed registry | `data.entitlement-merge-order` | entitlement-module | AC-8 | covered |
| BRIEF:L123 | Month-cap DB tests, AC-22.4 and account-race tests pass unchanged | `operations.entitlement-consume` | limit-gates | AC-9 | covered |
| BRIEF:L124 | AC-2.8 and the read-only-before-idempotency order test pass | `access.feature-gate-order`, `access.read-only-before-idempotency` | feature-gates, route-gates | AC-10 | covered (R2: the order test is written first) |
| BRIEF:L125 | One database read per request or job, asserted | `quality.entitlement-single-read` | entitlement-module | AC-11 | covered |
| BRIEF:L126 | PATTERNS.md, refusal doc, frontend map | `quality.plan-gates-docs` | docs | AC-12 | covered (R15: FLOWS.md fixed too) |
| BRIEF:L127 | ci:local, test:rls-role, Sonar green | `quality.gates-green` | all | AC-13 | covered |

### Out of scope

| Source | Item | Status |
| --- | --- | --- |
| BRIEF:L131 | Shared entitlements service or package, bundles, pricing tables, admin UI | out-of-scope: BRIEF:L131 |
| BRIEF:L132 | Usage counters in a shared store | out-of-scope: BRIEF:L132 |
| BRIEF:L133 | Any entitlements cache | out-of-scope: BRIEF:L133 (BL2) |
| BRIEF:L134 | Rate limits as plan features | out-of-scope: BRIEF:L134 |
| BRIEF:L135 | Price or plan changes, new tiers | out-of-scope: BRIEF:L135, **except P13** (Free gets segments and broadcasts, now in scope) |
| BRIEF:L136 | meepzo-fe changes | out-of-scope: BRIEF:L136 (frontend route map only) |

## Delta

n/a — initial (Baseline `none`). The frozen `feat-instagram-dm-sending-2026-11-23-oxak` iteration's
Standing deviations are still read where they touch plan gates (below, R13, R14, R16).

## Reconciliation — the brief against the code

There's no PRD ↔ schema-routes pair, so each row sets the brief against the code. Evidence is on both sides.
Paths are cited as evidence only; the plan does not prescribe them.

| # | Item | BRIEF says | Code today | Verdict | Action |
| --- | --- | --- | --- | --- | --- |
| R1 | Number of write routes | "about 126" (BRIEF:L76) | 128 unique writes in `docs/routes.txt`; the gate model has 128 entries: 16 gated, 112 open (`src/tests/helpers/route-plan-gate-model.ts:82-324`) | code wins: 128 | route-changes counts 128 |
| R2 | The read-only-before-idempotency order test | "the existing order test stays" (BRIEF:L84, L124) | none exists. The order (authenticate → read-only guard → permission → idempotency claim) is only documented (`src/domains/app/app-plan-access.ts:37-40`, `src/FLOWS.md:369`); the coverage test checks presence, not position (`plan-gate-coverage.global.test.ts:89`) | finding | NEW work item: write the order test **before** the hook moves |
| R3 | Key names | `instagram.email_step`, `instagram.phone_step`, `core.seats`, … (BRIEF:L105) | 11 feature switches: `email_ask`, `phone_ask`, `reply_like_person`, `multiple_public_reply_lines`, `message_versions`, `broadcasts`, `segments`, `past_comments`, `extra_delay`, `starter_questions`, `mark_seen` (`plan.constants.ts:5-32`); 2 limits: `message_month_limit`, `channel_accounts_max` (`entitlement.constants.ts:7-28`); `has_priority_support` and seats are plan fields | code's names are the truth | Q2: which keys the registry starts with |
| R4 | Merge and global default | override → plan → global default (BRIEF:L89) | the merge already happens inside the one plan-access read: plan state first (paid plan, else the Free plan), then active overrides laid on top (`entitlement-override.util.ts:85-109`); expiry is checked at read (`:41`); no global-default layer, the Free plan is the fallback | brief partly met | Q4: is "global default" the Free plan or a code default per key |
| R5 | Seats as a limit | `core.seats` in the module, consumable, overridable (BRIEF:L24, L105, L120) | seats don't use plan access: an advisory lock, then the subscription row `FOR UPDATE`, then a count → 409 `seat_limit_reached` (`membership.service.ts:590-610`, `subscription.service.ts:665`); there's no seat override key | behaviour change if moved | Q5: move seats in (overridable) or leave them as they are |
| R6 | Stored override keys | namespaced `instagram.monthly_dms` (BRIEF:L109) | stored bare (`email_ask`), pinned by a database CHECK (`entitlement-override.schema.ts:80-83`); `GET /billing/entitlements` returns `overrides:[{key}]` with bare keys | a rename touches stored rows, the CHECK and two responses | Q4 |
| R7 | consume = one atomic statement | "atomic increment-and-check" (BRIEF:L24; proposal:L111) | month cap is read-then-write under an advisory lock and lane locks, in the send claim (`instagram-send-gate.service.ts:367-445`, add at `:520`); accounts: advisory lock → count → check (`channel-account.service.ts:516-533`) | brief's "keeps lane C's exact logic" (BRIEF:L92) wins over "one statement" | consume **wraps** today's locked logic; no SQL rewrite (Q5) |
| R8 | Gate order | channel → permission → plan → not offered; the module's `can()` keeps "not offered" (BRIEF:L81) | the order lives in `checkFeature` (`channel-account.service.ts:158-185`); "permission" is the Meta connection's granted scope, not organization RBAC; "not offered" is a channel fact | `can()` answers the plan step only | Q3: checkFeature stays the composer and calls `can()` for its plan step |
| R9 | preHandler position | "runs after the permission gate" (BRIEF:L81) | today the read-only guard runs **before** the RBAC permission check (`automation.routes.ts:130-133`, `broadcast.routes.ts:128-131`) | moving it changes which 403 a caller sees | Q6: keep today's position (behaviour identical) or move after RBAC |
| R10 | One refusal shape | one body (BRIEF:L33) | statuses differ by meaning: read-only 403, `plan_lacks_feature` 403, `plan_account_limit` 409, `seat_limit_reached` 409, `message_month_limit_reached` 409; bodies `{type, code, detail, reason, …fields}`, fields from `APP_ERROR_FIELD_KINDS` (`src/shared/errors/app.error.ts:40-47`); doc `docs/reference/api/response-codes.md:72-84` | unify the body, keep every status | Q9 settles the upgrade hint |
| R11 | Automation save and the run engine | refusals via `refusal()` (BRIEF:L33) | save has its own `planLacksFeatureError` (`automation.service.ts:153`, `:1449`); the run engine **skips** an off step silently (`automation-run-step.util.ts:24-58`) | the engine keeps skipping (the downgrade rule, BRIEF:L94) | save moves to `refusal()`; the engine calls `can()` and still skips |
| R12 | Job gates | worker calls can/consume at the claim (BRIEF:L31) | a hand-kept job model lists 12 jobs (`route-plan-gate-model.ts:341-360`); 10 meet the send claim (month + accounts); lane turns are held by the account's **stored** plan stop, not a live read (`instagram-send-lane.util.ts:25-61`); `automation-backfill-read` and `segment-count` check a switch live | a live read per lane turn would add a read per send | Q7: declarations name today's mechanism; no new live reads |
| R13 | Standing deviation "Read-only plan" (D26/D27/P10/P269) | — | turning a PRO part on answers `plan_lacks_feature`, not `organization_read_only`; the guard is on 2 routes only (oxak `AS-BUILT.md` › Standing deviations) | keep as built (behaviour identical) | KICKOFF § 8: kept |
| R14 | `LAPSED_PLAN_READ_ONLY_ENABLED=false` at launch | BRIEF:L97 | schema default `true` (`env-schema.ts:308`, `.env.example:1077`); the oxak pending item #27 | a production-safe default is the repo's rule; launch value is a hosted-env setting | Q8 |
| R15 | Stale narrative | — | `src/FLOWS.md:336` still says automation create / PATCH / DELETE are read-only guarded; P10 narrowed it to 2 routes | finding | docs row fixes it |
| R16 | Standing deviation "A picture with text" (P412) | — | counts 1 DM, design said 2 | keep as built | consume amount stays as built; KICKOFF § 8 |
| R17 | Entitlements GET | add usage and source (BRIEF:L39) | already returns `limits.{direct_messages, channel_accounts, seats}.{used, limit}` and `overrides:[{key, expires_at}]` (`entitlement.serializer.ts:47-80`) | usage exists; source is NEW | additive change only |
| R18 | Idempotent consume | "an idempotency key stops a retry counting twice" (BRIEF:L24) | the month count is added inside the send claim's transaction, once per claimed message (`instagram-send-gate.service.ts:520`); a re-claimed message doesn't reach the add again (checked at kickoff) | keep today's guarantee | AMBER: confirm at kickoff; no new key table |
| R19 | Oxak pending #12 | — | AC-9.1 vs P76/BC3: are segments and broadcasts on Free? (`plans/pending-and-deferred.md` #12) | touches product-first defaults | Q8 |

## Added by Step 4

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| decisions P5 | `LAPSED_PLAN_READ_ONLY_ENABLED` defaults to `false`; template, catalog and docs agree | `quality.read-only-flag-default` | launch-defaults | AC-14 | covered — P5 |
| decisions P13 | Free's segments and broadcasts switches on | `data.free-plan-segments-broadcasts` | launch-defaults | AC-15 | covered — P13 (P22 open for Step 5) |
| coverage R2 | the order test (authenticate → plan gate → permission → idempotency claim) is written first | `access.read-only-before-idempotency` | route-gates | AC-10 | covered — P4 |
