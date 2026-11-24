Status: draft
Kind: screen
Depends on: channel-connection, plans-billing-and-trial
Route review: [routes-final.md](../../routes-final.md) § 1B — routes 6–11 (with the one feature check, P50)

## Stories

- As any member I want an account menu listing the organization's connected accounts so that I can switch the whole app to one account.
- As an Owner or Admin I want to pause and resume an account so that it stops sending for a while without losing comments and taps.
- As an Owner or Admin I want to disconnect one account so that it stops at once while its automations, contacts and history stay.
- As an Owner or Admin whose plan holds fewer accounts than I have I want to choose which accounts are active so that the ones I care about send.
- As the team I want to suspend an account so that only we can let it send again.
- As the system I want one check that says whether an account may use a feature so that go-live, settings and the engine agree.

## Rules

- The account menu switches the whole app: automations, contacts, counters and banners belong to one account (operations.channel-account; D26)
- One Instagram account is live in at most one organization; held on the channel account while it is not revoked (operations.channel-account; P60)
- Pause stops all four lanes; comments, taps and tag events are still saved and sent after resume; resume clears only the owner's pause — error stops and a team suspend stay (operations.channel-account; plan §15.4)
- Disconnecting one account removes its starter questions and its webhook subscription (best effort), sets it `revoked`, stops its lanes and drops its short-lived copies; the token is erased only when no other account uses the connection; automations, contacts and history stay (operations.channel-account; D25)
- A revoked account comes back only by a new connect and pick, with its old settings (operations.channel-account-connect-multi)
- "Choose active accounts" makes a plan-stopped account active and stops a named active one in its place, under the organization's lock, so the active count always fits `channel_accounts_max` (operations.channel-account-choose-active; D57)
- A team suspend is set by the team only and the owner's resume never clears it (operations.channel-account; P18)
- One feature check — the channel supports it, the connection was granted its permission, the plan includes it, its Meta test passed — with four refusals, each with its own status (P61): `channel_lacks_feature`, `permission_not_granted`, `plan_lacks_feature`, `feature_not_offered` (operations.feature-check, operations.channel-capability-list; P36, P50, P61, P83)
- While the plan is read-only, pause, resume and disconnect stay open (billing.plan-states; P10)
- Owner and Admin manage accounts; Editor and Viewer read them (access.channel-account-codes; P59)
- Pause, resume, disconnect and choose-active each leave one audit entry (quality.audit)

## Acceptance criteria

- AC-2.1 — The account list shows each account of the organization with its channel, display name, Instagram username, picture and followers, status, paused or suspended, and any plan stop; reading another organization's account answers not found — intake-files/Instagram-DM-Sending-Plan-v8.md:2527
- AC-2.2 — A paused account sends nothing on any of its four lanes while its comments and taps are still saved; resume wakes every lane that has waiting messages — intake-files/Instagram-DM-Sending-Plan-v8.md:2599
- AC-2.3 — Resume clears only the owner's pause: an error stop and a team suspend stay — intake-files/Instagram-DM-Sending-Plan-v8.md:2600
- AC-2.4 — Disconnecting one account sets it `revoked`, stops its lanes, removes its starter questions and webhook subscription (best effort) and keeps its automations, contacts and history; the token stays while another account of the connection is connected and is erased with the last one — intake-files/Instagram-DM-Sending-Plan-v8.md:2623
- AC-2.5 — A revoked account is connected again only by a new connect and pick, and gets its earlier settings back — intake-files/Instagram-DM-Sending-Plan-v8.md:4672
- AC-2.6 — Choosing a plan-stopped account as active clears its `plan_downgrade` stop and sets that stop on the named active account in the same step; a choice that would exceed the plan's account limit is refused — intake-files/Instagram-DM-Sending-Plan-v8.md:2631
- AC-2.7 — A team-suspended account stays stopped after the owner presses resume — intake-files/Instagram-DM-Sending-Plan-v8.md:2657
- AC-2.8 — The feature check refuses with `channel_lacks_feature`, `permission_not_granted` (answer: reconnect to allow it), `plan_lacks_feature` or `feature_not_offered` as its reason says, with the statuses of P61 — plans/decisions.md P61
- AC-2.9 — While the plan is read-only, pause, resume and disconnect still succeed — plans/decisions.md P10
- AC-2.10 — An Editor or a Viewer can list and read accounts and is refused pause, resume, disconnect and choose-active with `missing_permission` — plans/decisions.md P59
- AC-2.11 — Pause, resume, disconnect and choose-active each write one audit entry with the account and the old and new value — intake-files/Instagram-DM-Sending-Plan-v8.md:2660
- AC-2.12 — A private account is flagged on its read so the editor can warn that comment automations cannot work — intake-files/Instagram-DM-Sending-Plan-v8.md:4642

## Work items

- operations.channel-account
- operations.channel-account-choose-active
- operations.feature-check
- operations.channel-capability-list
- data.instagram-account-extension
- access.channel-account-codes
- billing.plan-states
- quality.audit
