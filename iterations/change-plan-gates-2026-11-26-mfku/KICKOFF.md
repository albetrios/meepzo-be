# KICKOFF — change-plan-gates-2026-11-26-mfku

## 1. Header

| Field | Value |
| --- | --- |
| Iteration | `change-plan-gates-2026-11-26-mfku` (type `change`, Process `full`, Owner Nikunj Mavani) |
| Mode | initial (Baseline `none`) |
| Intake | mode `brief` · note "2 received (BRIEF.md, Plan-Gates-Proposal.md) · from scratch" · placed 2026-11-26 · hash `26273bac1cb0` · Schema-routes — |
| Branch | `feat/instagram-automation` |
| Date | 2026-11-26 |

## 2. Goal and scope

**Goal:** every plan gate is declared once and answered by one billing entitlement module; every write route and
every job declares its gate; refusals come in one shape; a test makes a forgotten gate impossible to merge.
Behaviour stays identical except where a decision says otherwise (K1).

**In scope:** the key registry and the module (`resolve`, `can`, `limit`, `buildPlanRefusal`) · `sources` on the
entitlements read · the route declarations and the one `read_only` guard · the app, tenancy and job callers moved
onto the module · the coverage and policy tests · Free gets segments and broadcasts (P13, P27) · the read-only
flag defaults to `false` (P5) · docs.

**Out of scope:** namespaced keys (P17) · seat overrides (P18) · a `consume()` in billing (P23) · any entitlements
cache (BL2) · a shared entitlements service, bundles, pricing tables, an admin UI · rate limits as plan features ·
other price or plan changes · meepzo-fe changes (handed over in the frontend route map) (BRIEF:L129-L136).

## 3. Locked decisions

Full rows: [`plans/decisions.md`](plans/decisions.md).

- P1: the module is the existing `billing/sub-domains/entitlement/`.
- P17: keys stay bare; each registry entry records its product (supersedes P2).
- P21: the registry starts with every gated key: 11 switches, 2 limits, seats.
- P19: a registry default per key; merge override → plan → default (supersedes P15).
- P18, P26: seats are a declared limit, not overridable; unlimited on every plan today.
- P20: the channel feature check stays the composer and calls `can()`.
- P4, P29: the guard keeps today's position and enforces `read_only` only.
- P6, P7: one refusal builder; `feature` + `upgrade_required`; the month refusal gains `limit` / `used` / `resets_on`.
- P8, P23: counters keep their locks; no `consume()` in billing.
- P24: pass the snapshot, one read per request or job.
- P12, P33: every job declares; paid jobs meet their gate as today.
- P5: the read-only flag defaults to `false`.
- P13, P27: Free and the 3 switched-off plans get segments and broadcasts.
- P16: this session's line owns the plan.
- Route review: P25, P28, P30, P31, P32, P34 (all 6 parts final).

## 4. Features and order

1. [`entitlement-module`](plans/features/entitlement-module/story.md)
2. [`launch-defaults`](plans/features/launch-defaults/story.md)
3. [`route-gates`](plans/features/route-gates/story.md)
4. [`app-gate-users`](plans/features/app-gate-users/story.md)
5. [`seat-gate`](plans/features/seat-gate/story.md)
6. [`job-gates`](plans/features/job-gates/story.md)
7. [`clean-up-and-docs`](plans/features/clean-up-and-docs/story.md)

## 5. ROUTE

Spec for each `sub-domain` row: its section of [`plans/routes-final.md`](plans/routes-final.md), with its code
changes as the checklist. Parallel lanes once dependencies are done: rows 3 ∥ 4; rows 6 ∥ 7.

| # | Work item | Kind | Depends on | Skill/driver | Acceptance | Assignee | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | The pre-handler order test for go-live and broadcast send, **first** (§3 RGC1) | feature | — | `/be-build-requirement` (be-test-generator) | AC-10 | Claude | done |
| 2 | Entitlement module: registry, `resolve` with sources, `can` / `limit`, `buildPlanRefusal`, `sources` on the read (§1 ENC1–ENC5, ENC8) | sub-domain | — | `/be-build-requirement` (route 1 output: be-api-contract-guard → be-route-schema-doc-guard → be-openapi-multilingual) | AC-5, AC-6, AC-7, AC-8, AC-11 | Claude | done |
| 3 | Free plan data: data migration + seed, the two "on Free" tests flipped (§2 PLC1–PLC4) | table | 2 | `/be-build-requirement` (be-db-migration-maintainer → be-seed-maintainer) | AC-15 | Claude | done |
| 4 | Read-only flag default `false`: schema, `.env.example`, env catalog, schema comment (P5) | feature | — | `/be-build-requirement` (be-env-schema-add; if it refuses, stop and ask) | AC-14 | Claude | done |
| 5 | Route declarations and the one guard: type, shared reasons, 128 declarations (one commit per domain), the route hook, the snapshot hand-off, the live coverage test (§3 RGC2–RGC7) | sub-domain | 1, 2 | `/be-route-complete` chain per domain (be-api-contract-guard → be-route-schema-doc-guard → be-route-catalog) | AC-1, AC-10 | Claude | done |
| 6 | App gate users onto the module (§4 APC1–APC5) | sub-domain | 2, 5 | `/be-build-requirement` | AC-5, AC-9, AC-10 | Claude | done |
| 7 | Seats onto the module (§5 SEC1–SEC4) | sub-domain | 2, 5 | `/be-build-requirement` | AC-5, AC-9 | Claude | done |
| 8 | Job declarations for every job; the hand-kept model deleted (§6 JGC1–JGC5) | background | 5, 6 | `/be-worker-complete` (be-workers-events → be-test-generator → be-tsdoc-export-guard) | AC-2, AC-3 | Claude | done |
| 9 | Remaining plan-access callers (auth me context, Stripe webhook, subscription emits) and the policy test (§1 ENC6, ENC7) | feature | 6, 7, 8 | `/be-build-requirement` | AC-4 | Claude | done |
| 10 | Docs and close: the "plan gates" pattern in the system narratives, the refusal doc, the stale read-only flow line (P9), the frontend route map, acceptance (§3 RGC7) | flow | 3, 4, 9 | be-system-narrative-maintainer, be-docs-maintainer, `pnpm iteration:frontend-map` | AC-12, AC-13 | Claude | open |

## 6. Requirements index

| Identifier | File |
| --- | --- |
| `data.entitlement-merge-order`, `data.entitlement-key-namespacing`, `data.entitlement-override-row`, `data.free-plan-segments-broadcasts` | [data.md](plans/requirements/data.md) |
| `access.entitlement-module-single-entry`, `access.route-plan-gate-declaration`, `access.route-plan-gate-enforcement`, `access.read-only-before-idempotency`, `access.feature-gate-order` | [access.md](plans/requirements/access.md) |
| `operations.entitlements-read-source`, `operations.entitlement-consume`, `operations.entitlement-downgrade-rule` | [operations.md](plans/requirements/operations.md) |
| `background.job-plan-gate-declaration` | [background.md](plans/requirements/background.md) |
| `quality.entitlement-key-registry`, `quality.entitlement-single-read`, `quality.plan-refusal-shape`, `quality.plan-gate-coverage-test`, `quality.no-direct-plan-reads`, `quality.product-first-defaults`, `quality.read-only-flag-default`, `quality.plan-gates-docs`, `quality.gates-green` | [quality.md](plans/requirements/quality.md) |
| none (n/a) | [notifications.md](plans/requirements/notifications.md), [realtime.md](plans/requirements/realtime.md), [integrations.md](plans/requirements/integrations.md), [files.md](plans/requirements/files.md) |

## 7. Open AMBER items

- P26: seats are unlimited on every plan today (a correction to P18's note, from the plan seed). Confirm at row 7.
- P5 depends on be-env-schema-add accepting a `false` default; row 4 stops and asks if it refuses.
- Closed, kept for the record (`decisions.md` is add-only): P10 → P12, P14 → P20, P15 → P19, P22 → P27.

## 8. Standing deviations

From `feat-instagram-dm-sending-2026-11-23-oxak` (frozen; not edited, P9):

| Item | Design says | Built as | Since | Decision | Here |
| --- | --- | --- | --- | --- | --- |
| Read-only plan | go-live, broadcast send and turning a PRO part on answer `organization_read_only` | the guard is on go-live and broadcast send; turning a PRO part on answers `plan_lacks_feature` | oxak | P9 | **kept** as built; this iteration's `AS-BUILT.md` restates it |
| A picture with text | counts 2 DMs | counts 1 | oxak (P412) | — | **kept**: the month counter is untouched (P8) |
| Free's segments and broadcasts (pending #12) | AC-9.1 vs P76 / BC3 | off on Free | oxak | P13, P27 | **resolved**: on for Free |
| Read-only flag default (pending #27) | — | default `true`; two docs say `false` | oxak (P148) | P5 | **resolved**: default `false` |

## 9. Definition of done

- Every ROUTE row `done` (or `deferred` with the owner's OK).
- [`plans/acceptance.md`](plans/acceptance.md) filled: AC-1 to AC-15 with evidence.
- `AS-BUILT.md`: a row per ROUTE row, the summary, and the Standing deviations carried forward.
- The gates green: `pnpm ci:local`, `pnpm test:rls-role`, the SonarQube gate.
- Before the PR: `pnpm iteration:status … done`, then `frozen` in the branch's last commit, and `pnpm iteration:freeze-check` passes.

## 10. Verification

- **Brief mode:** each `BRIEF.md` acceptance criterion (BRIEF:L115-L127), plus the decision-added AC-14 and AC-15, traced in `plans/acceptance.md`.
- **Behaviour identical (K1):** the existing end-to-end and integration suites for every touched sub-domain pass unchanged, except the two "on Free" tests (PL4). Every plan refusal gains a body-shape assertion.
- **Gates:** `pnpm ci:local` · `pnpm test:rls-role` · SonarQube · `pnpm iteration:frontend-map change-plan-gates-2026-11-26-mfku --check` · `pnpm iteration:freeze-check`.
