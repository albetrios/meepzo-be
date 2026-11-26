# Worker changes — feat-meta-connect-flow-2026-11-26-bqmw

What must happen without a click — never how. Kickoff names the queues and jobs.

| Field | Value |
| --- | --- |
| Iteration | `feat-meta-connect-flow-2026-11-26-bqmw` |
| Mode | initial |
| Baseline | none |
| Intake mode | brief — from scratch |
| Intake hash | `f1ff32a8eb81` |
| Date | 2026-11-26 |
| Stage | Step 4 — C-D3 (7 days), C-D6 (Page id waits for O6) |

| Change | Count |
| --- | --- |
| NEW | 0 |
| CHANGED | 3 |
| DEFERRED | 1 |
| **Total** | **4** |

| # | Change | Work | What must be true | Brief |
| --- | --- | --- | --- | --- |
| WC-1 | CHANGED | the daily token check also revokes unpicked connections (routes-final CN9 — reuse, no new job) | a `connected` connection with no not-revoked account for more than 7 days since `connected_at` ([C-D3](decisions.md)) is revoked and its token deleted; tenant-scoped, idempotent, paced | L54, L104 |
| WC-2 | CHANGED | the account set-up job's message-access probe (`instagram-account-tasks.processor.ts:751-773`) | also stores DB-1; the on-demand re-check (RC-8) runs the same probe | L85 |
| WC-3 | DEFERRED | the account profile read | no change in this iteration — `linked_page_id` waits for owner test O6 (routes-final IG3) | L87 |
| WC-4 | CHANGED | the daily token check (`channel-connection-token-check.processor.ts`) | refreshes per-account `scopes` (DB-3) from `/debug_token` `granular_scopes` once owner test O1 passes; until then leaves them `null` | L89 |

Built: WC-2 in ROUTE R5 (the probe stored; a send's own `access_off` stores `off` too); WC-1 in ROUTE R6
(`revoked_unpicked`, one guarded statement); WC-4 left `null` behind owner test O1 (R6); WC-3 deferred (O6).
