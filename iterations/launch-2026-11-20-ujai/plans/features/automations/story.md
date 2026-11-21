Status: ready
Kind: screen
Depends on: instagram-connection, instagram-content-picker
Route review: [routes-final.md](../../routes-final.md) § 3.A — AU7–AU15, AU27 (with § 3.1 AU2–AU4, AQ2, AQ6, AQ8, AQ9)
Tables: `app.automations` (reads `app.instagram_accounts`; a delete cancels runs in `app.automation_runs`)

## Stories

- As an Owner, Admin or Member I want to create an automation for comments, DMs or story replies, with the message of each step, so that Instagram users are answered without us typing.
- As an Owner, Admin or Member I want to list, search, filter and sort automations so that I can manage many of them.
- As an Owner, Admin or Member I want to edit an automation and switch it on or off so that I change its behaviour without building it again.
- As an Owner, Admin or Member I want to duplicate an automation so that I can start from one that works.
- As an Owner, Admin or Member I want a "next post" automation so that the next post I publish gets the automation without picking it.
- As an Owner or Admin I want to delete an automation with a reason so that it stops and its open runs end.
- As an Owner of a team on a read-only plan I want to keep seeing and running our automations while changes are blocked so that our replies do not stop.

## Rules

- An automation belongs to the Instagram account connected when it was created — an `expired` or `error` account counts, a revoked one does not; creating one without such an account is refused; its account never changes (data.automation; D26)
- Every save is a complete flow, whatever the status: the final message always; the opening and follow messages when their step is on; the email and phone questions may fall back to the default text (operations.create-automation, operations.edit-automation; D19)
- Trigger and target: "next post" only on comment automations; DM automations answer any DM only, need at least one keyword and the DM keyword trigger on; "specific" needs its post (comment) or its story (story reply), never the other; public replies only on comment automations, with 1–20 texts (operations.create-automation)
- A comment automation with the opening message on must have a button on it (operations.create-automation; D26)
- Keywords are trimmed, lowercased and deduplicated (up to 50, each 1–100 characters); tags trimmed and deduplicated (up to 20, each 1–50) (data.automation)
- "Next post" window: both dates, valid, the end after the start; the start not earlier than 24 hours ago and the end not in the past, each checked only when new or changed; a started window may move later, never earlier (operations.create-automation, operations.edit-automation)
- Two live, waiting "next post" automations of the same Instagram account may not overlap in time when they share a keyword or either has none; two saves at the same moment never both pass (operations.create-automation; D26)
- A linked automation's window and target are fixed; changing an expired one's window puts it back to waiting (operations.edit-automation)
- A new automation is `inactive` unless sent `live`; the completed-run count, the last-triggered time, the "next post" status and link time, and the Instagram account are set by the system only (data.automation)
- An edit may carry the time of the version it was based on; a save based on an older version is refused (operations.edit-automation; D26)
- An edit reaches open runs from their next step; switching an automation `inactive` stops new runs and lets open runs finish (operations.edit-automation; D26)
- Delete needs a reason — mistake, duplicate, not needed, other (with a note); the automation is hidden, its running and waiting runs are cancelled in the same step, its runs and comment logs stay; there is no restore (operations.delete-automation; D26)
- Deleted automations are never listed or read (operations.list-automations, operations.read-automation)
- While the organization's plan is read-only, creating, editing and deleting automations are refused; reading and running them go on (quality.read-only-plan; D27)
- No plan limit counts automations (quality.no-plan-limits; D12)
- Create needs an idempotency key (quality.idempotency)
- Create, edit (with the changed fields) and delete (with the reason and the number of runs it cancelled) each leave an audit entry (quality.audit)
- After a switch to another Instagram account, the old account's automations stay listed, editable and deletable, but never run (data.automation; D26)
- The list is not live; counters update on refresh (D11)

## Acceptance criteria

- AC-5.1 — Creating a complete automation stores it on the organization's connected Instagram account, `inactive` unless sent `live`, with keywords trimmed, lowercased and deduplicated, tags deduplicated, and the caller as creator and editor; the answer shows its Instagram account — intake-files/schema-routes.md:614
- AC-5.2 — Creating an automation while the organization has no account that is not revoked is refused with `instagram_not_connected` — plans/decisions.md D26
- AC-5.3 — Create without an idempotency key is refused; repeated with the same key, it returns the first automation and creates no second one — intake-files/schema-routes.md:77
- AC-5.4 — "Next post" on a story-reply or DM automation, anything but "any" on a DM automation, and "specific" without its post or story id are each refused on that field — intake-files/schema-routes.md:602
- AC-5.5 — A DM automation without a keyword, or with the DM keyword trigger off, is refused — intake-files/schema-routes.md:604
- AC-5.6 — A public reply on a story-reply or DM automation, or switched on without 1–20 texts, is refused — intake-files/schema-routes.md:605
- AC-5.7 — A save without the final message, or with a step switched on and its message missing, is refused with one error item per missing message — intake-files/schema-routes.md:606
- AC-5.8 — A comment automation with the opening message on and no button title is refused — plans/decisions.md D26
- AC-5.9 — "Next post" dates that are missing, invalid, with the end not after the start, the start earlier than 24 hours ago or the end in the past (when new or changed) are each refused with their own message — intake-files/schema-routes.md:607
- AC-5.10 — A window that has started may move later; moving its start earlier is refused — intake-files/schema-routes.md:610
- AC-5.11 — Saving a live, waiting "next post" automation whose window overlaps another live, waiting one of the same Instagram account and shares a keyword, or where either has none, is refused with `next_post_window_overlap` naming the other automation, the keyword and its dates; two such saves at the same moment never both pass; automations of two different accounts never clash — intake-files/schema-routes.md:612
- AC-5.12 — An edit runs every create rule on the automation as it will be after the edit; switching it `live` needs the same complete flow — intake-files/schema-routes.md:626
- AC-5.13 — Changing the window of an `expired` automation puts it back to `waiting`; changing the window, scope or target of a `linked` one is refused with `next_post_already_linked` — intake-files/schema-routes.md:629
- AC-5.14 — Sending a field the system sets (counts, last triggered, "next post" status or link time, the Instagram account) is refused, and so is an empty edit — intake-files/schema-routes.md:631
- AC-5.15 — An edit sent with an `expected_updated_at` older than the stored automation is refused with `record_changed` — plans/decisions.md D26
- AC-5.16 — The list shows only automations that are not deleted, filtered by status, trigger, scope, "next post" status and Instagram account, searched by name in any case, and sorted by created (default, newest first), name, last triggered (never-triggered last) or completed runs, either way, across pages — intake-files/schema-routes.md:586
- AC-5.17 — Reading a missing, deleted or another organization's automation answers `automation_not_found` — intake-files/schema-routes.md:622
- AC-5.18 — Deleting needs a reason, and a note with "other"; afterwards the automation is gone from the list and from reads, each of its running and waiting runs is `cancelled` with one history entry, and its runs and comment logs remain — intake-files/schema-routes.md:640
- AC-5.19 — A Member can list, read, create, edit and switch automations on and off, and is refused with `missing_permission` on delete — intake-files/schema-routes.md:147
- AC-5.20 — While the plan is read-only, create, edit and delete are refused with `organization_read_only`; list and read still answer and live automations keep running — plans/decisions.md D27
- AC-5.21 — An organization can create automations with no plan limit on their number — plans/decisions.md D12
- AC-5.22 — Create, edit (with the changed field names) and delete (with the reason and the number of runs cancelled) each leave one audit entry — intake-files/schema-routes.md:632
- AC-5.23 — Duplicating — reading one automation and creating from it — gives a copy on the account connected now; a copied linked "next post" automation arrives `waiting` — intake-files/schema-routes.md:616
- AC-5.24 — An edit reaches the automation's open runs from their next step and a step switched off meanwhile is skipped; switching it `inactive` starts no new run but lets open runs finish — plans/decisions.md D26
- AC-5.25 — After the organization switches to another Instagram account, the old account's automations stay listed, editable and deletable, and never run — plans/decisions.md D26

## Work items

- data.automation
- operations.list-automations
- operations.create-automation
- operations.read-automation
- operations.edit-automation
- operations.delete-automation
- quality.read-only-plan
- quality.no-plan-limits
- quality.idempotency
- quality.audit
