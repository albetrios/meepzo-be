`src/domains/app/sub-domains/automation/automation-run/`

# Automation run

Parent: [Automation](../automation.overview.md)

## Purpose

What happens when an automation runs for a person (feat-instagram-dm-sending routes-final § 4.B, ROUTE
row R14): the run (`app.automation_runs`), its history (`app.automation_run_events`), the per-comment
step log (`app.automation_comment_logs`), the open-run keys (`app.automation_run_open_keys`) and the run
engine that writes them. Shared by every channel (P48). No routes: the channel's intake calls the
engine's entry points per event (the inbound seam), the channel's sending sub-domain reports each
message's result back (`recordMessageResult`, the outbound seam), and the engine registers its steps
with the automation delete and the contact erase and pause.

**The engine decides; it never sends** (AU24, WC-9 removed): every step is one waiting message saved
through the account's channel's `ChannelSendingPort` (`app.channel-ports.ts`, AU35) — content by
reference (the `steps` path and upload public ids, never text). Instagram's port is sub-domain 6's
message service (ROUTE rows R19–R20); until it is wired, `app.container.ts`'s `channelSendingPorts`
holds no Instagram port and an event of that channel throws.

## Layout

| File | Role |
| --- | --- |
| `automation-run.schema.ts` | runs, split by month of `started_at` (P96, AU36); keys carry the split key |
| `automation-run-event.schema.ts` | run events, split by their run's start month (`automation_run_started_at`) |
| `automation-comment-log.schema.ts` | comment logs, split by month of `created_at`; the run is a copy, no reference |
| `automation-run-open-key.schema.ts` | the open-run key table (AU37, P100), plain |
| `automation-run.repository.ts`, `automation-run-event.repository.ts`, `automation-comment-log.repository.ts`, `automation-run-open-key.repository.ts` | Drizzle access; every statement names the organization |
| `automation-run.service.ts` | the engine: entry points, steps, results, cancels, the open-key repair |
| `automation-run-matching.util.ts` | which automation an event starts (plan §4.3, §4.4) and the keyword matcher route 35 shares |
| `automation-run-step.util.ts` | once keys (AU22), PRO switches (AU26), versions and wordings (AU27) |
| `automation-run-button-payload.util.ts` | `<aut_…>::<run_…>` — the payload our buttons carry back |
| `automation-run.constants.ts`, `automation-run.types.ts` | value lists (mirror the CHECKs) and the seam's input shapes |
| `workers/automation-run-wait-expiry.*` | WC-45 — the hourly 7-day wait cancel |
| `seed/` | demo runs in every status with their events, logs and open keys |

## Key invariants

- **One unit of work per event**: the account and the plan's PRO switches are read once; then her
  contact is locked (`lockLiveContact`, `FOR KEY SHARE`), the automations of her open runs and the
  chosen one `FOR KEY SHARE` (D47), the runs `FOR UPDATE`. The run, its key, events, comment log, counts,
  contact changes and the waiting messages commit together — a retried event finds its work done
  (`last_instagram_event_key`, or the comment's logs in the last two month parts).
- **The once rule** (AU22, D13, D65): each way to start has its once key (`buildOnceKey`); a DM already
  sent for (automation, person, key) → `ignored` · `once_per_post`. The account's "once per person per
  post" switch off keys by the event's own id.
- **One open run per automation and person** (AU23, AU37, P100): the open key's insert is the guard; it
  is deleted in the commit that ends the run. An allowed comment (another post, or "every time")
  replaces her open run (`cancelled` · `replaced`, its waiting messages skipped through the port) in the
  same commit (P35); every other start while it is open is `run_in_progress`.
- **Results** (AU25, AU35): `sent` moves the run on; `unknown` is never sent again by itself — the run
  waits for `any` and only her next message or tap sends that step once more; `failed` fails the run;
  `skipped` cancels it with its reason (`window_closed`, `expired`, …) or fails it.
- **Counts** (AU27, AC-6.22): `runs_started` at the start, a hello tap `taps`, her first text while the
  run waits for the hello's tap `typed_answers` — per hello version — in the event's commit, through
  `AutomationCountService.increment`; they have no key to a run, so they outlive the part drops.
- **PRO at run time** (AU26, D57): without the plan's switch the email and phone asks are skipped,
  "Reply like a person" works as off, only version 1 is picked.
- **Channel-neutral** (AUC13): no import of an `instagram-*` folder — the account and its rules come from
  `ChannelAccountService.readAutomationRunAccount`, the sending through the port
  (`automation-channel-neutral.policy.unit.test.ts`).

## Lifecycle

`running` (a step's message waits for its channel) ⇄ `waiting` (for her tap, `any`, a follow, an email
or a phone) → `completed` (tags added, D45) · `failed` · `cancelled` (`automation_deleted`,
`wait_expired`, `contact_deleted`, `contact_excluded`, `opted_out`, `expired`, `window_closed`,
`replaced`). Step order: hello → (comments: public reply, then hide, after the first DM is `sent`) → her
tap or any text (a nudge after 60 min when she messaged first) → follow check → follow ask → email →
phone → messages 1–N (`not_before` = its wait) → tags.

## Events

None on the in-process bus. Run events are rows (`app.automation_run_events`).

## Failure modes

- A database error propagates: the intake retries the event; nothing of it was written.
- A channel without a wired sending port throws (`no sending port wired`).
- A result for a settled message or a run that moved on does nothing.

## Policy constants

`AUTOMATION_RUN_KEEP_DAYS` (90), `AUTOMATION_RUN_PART_DROP_AFTER_DAYS` (98),
`AUTOMATION_RUN_WAIT_MAX_DAYS` (7), `AUTOMATION_RUN_ASK_MAX_COUNT` (3),
`AUTOMATION_PUBLIC_REPLY_CHANCE_PERCENT` (80), `AUTOMATION_TAG_CHAIN_MAX` (3) in
`automation-run.constants.ts` — rationale in [`src/POLICIES.md`](../../../../../POLICIES.md).
