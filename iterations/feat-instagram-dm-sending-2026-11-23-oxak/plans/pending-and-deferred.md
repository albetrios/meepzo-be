# Pending and deferred — feat-instagram-dm-sending-2026-11-23-oxak

Written at the freeze, 2026-11-26 (IST). This lists everything the iteration left open: work deferred to the next
iteration by the owner, questions only the owner can answer, deploy steps, and the sibling work in meepzo-fe.
The full text of each item is in [`../AS-BUILT.md`](../AS-BUILT.md) › Owner items (numbers below are those items)
and [`decisions.md`](decisions.md).

Gates on the frozen tree's code (725a733, see [`merge-log.md`](merge-log.md) › Close round 2): `pnpm ci:local` all
steps passed; `pnpm test:rls-role` 217 files / 1,844 tests passed; `pnpm sonar:scan` 0 issues / 0 hotspots.

## 1. Deferred to the next iteration (owner decisions)

| Item | Why deferred | Decision |
| --- | --- | --- |
| A reply to a reply answered under the top-level comment (needs the parent comment id on the run — a schema change) | Owner: next iteration | [P371](decisions.md); item 16 |
| DM backfill for an account shared without its Facebook Page (Meta `GET /{ig-user-id}/conversations?fields=messages{…}` after a reconnect with the Page) | Owner stopped it before any commit | [P372](decisions.md); item 22a |
| A follow or "any" tap that overtakes its own send result is still ignored (only the hello's early tap is kept) | Outside the owner's ask | [P264](decisions.md) |
| Drop the `lav` → `lavender` expand trigger | The release after this one | [P202](decisions.md) |
| Each Meta-gated feature ("Seen" after a reply and the others) as its §43 test passes; the malware scan of message files | Meta tests / a scanner not available yet | [P36](decisions.md), [P34](decisions.md) |
| Knip's unused `instagram-send-minute-count.repository.ts`; the flaky `request-lifecycle.middleware.unit.test.ts`; the `app.container.ts` split | Follow-ups (the split needs the owner's OK) | AS-BUILT › Summary |

## 2. Open owner questions (no code until answered)

| # | Question | Item |
| --- | --- | --- |
| 1 | The "Your DMs are safe" banner (AC-27.6) and restore step 4 (AC-27.10) | 1, 2 ([P452](decisions.md)) |
| 2 | A team-paused organization tied to its lanes and the `paused` notice (AC-12.10) | 3 |
| 3 | The message-access banner field and Meta's codes; the private flag and account type source | 4 ([P409](decisions.md), [P120](decisions.md)) |
| 4 | AC-17.17 (picture + text as two rows), `plan_feature_off` for the email / phone question after a move down, AC-17.15 | 5 ([P412](decisions.md)) |
| 5 | The 500-waiting cap reading; broadcast-tap run-start semantics | 6 ([P451](decisions.md), [P224](decisions.md)) |
| 6 | Password step-up stays removed; AC-25.3 proven through the token check | 7 ([P251](decisions.md), [P252](decisions.md)) |
| 7 | Intake's third Meta read kept beside the "next post" sweep | 8 ([P315](decisions.md)) |
| 8 | An ad comment's match to its ad; the stop test across lanes and the lane wake | 9 ([P313](decisions.md), [P411](decisions.md)) |
| 9 | Notice recipients (reconnect, UN9 Editor reach, role change, trial) and a move up reactivating accounts | 10 |
| 10 | An account in `error` still taken in | 11 ([P312](decisions.md)) |
| 11 | Wording conflicts: AC-9.1 vs P76 / BC3, AC-10.2, AC-1.1, AC-11.7 | 12 |
| 12 | R52's backup gap and the 7-day grace lookback | 13 ([P219](decisions.md)–[P221](decisions.md)) |
| 13 | A keep time for `app.instagram_send_day_counts` | 14 ([P414](decisions.md)) |
| 14 | Plan §33.2 rule 7 (a stopped automation's new comments) | 15 ([P351](decisions.md)) |
| 15 | `idleTurnSeconds` pushing a stop back 60 s | 17 |
| 16 | R54 / R55 acceptance readings (AC-19.10, AC-19.13, the ask-again wording) | 18 |
| 17 | Every AMBER decision of the build — confirm or change | 19 |
| 18 | Meta login cancel (`error=access_denied`) on meepzo-fe; reconnect wording by Meta's 190 subcode | 21 ([P357](decisions.md)) |
| 19 | Webhook leftovers: mTLS, `META_APP_SECRET` rotation, echoes from other apps, `standby` / handover, unsupported media and the window, shared stories, ad-post comments, an ad message held by its once key, edited messages | 22 ([P261](decisions.md)) |
| 20 | The webhook store's 8 connections per process and the API pool's headroom | 23 (c) ([P262](decisions.md)) |

Decided at the freeze (no longer open): the token's end — never-expiring configuration ([P359](decisions.md)); the
override routes keep an MFA-verified session, no step-up ([P370](decisions.md)).

## 3. Deploy and operations (owner steps)

1. `pnpm github:sync` — the hosted environments get `LAPSED_PLAN_READ_ONLY_ENABLED` (renamed from
   `BILLING_READ_ONLY_ENFORCED`, [P148](decisions.md)) and the optional `META_PAGE_CONFIG_ID`; rename the switch in
   every developer's local env file too.
2. `pnpm db:migrate` on existing databases — this iteration's later migrations: `20261125210000`, `20261125233000`,
   `20261126024021`, `20261126100000`, `20261126120000`, `20261126130000` (item 24).
3. Meta dashboard: the login configuration set to "never expires" ([P359](decisions.md)); exactly the six webhook
   fields selected with "Include values" on ([P260](decisions.md)); the second (Page) configuration created and App
   Review for `pages_show_list` before `with_page` is used live ([P358](decisions.md)).
4. Items 25–30: `DATABASE_POOL_MAX` headroom and the raised repair concurrency; `SESSION_PLACE_DATABASE_URL`;
   `PASSWORD_ROUTES_ENABLED` stays `false`; the unverified dashboard menu names, `btree_gin` on Neon, `pnpm deps:audit`
   once the registry is reachable; the route-access widenings named in the PR text; the re-proved engine e2e suites.
5. Raise the PR (the iteration is frozen in its last commit; a later change needs it unfrozen first).

## 4. meepzo-fe sibling work (item 31, [P30](decisions.md))

The frontend's own iteration on this contract, from [`frontend-route-map.md`](frontend-route-map.md); new since the
first Close: the `with_page` flag on connect / reconnect and `instagram.is_messages_webhook_missing`; the refusal
body fields (`feature`, `limit`, `used`, `grace_ends_at`, `upgrade_required`); `GET /api/v1/billing/entitlements`;
the `hono` / `@hono/node-server` overrides (a sibling PR, as the same task in both repositories).
