Status: ready
Kind: screen
Depends on: instagram-connection
Route review: [routes-final.md](../../routes-final.md) § 2 — CT1–CT13, CQ1–CQ5
Tables: `app.contacts` (the automation filter reads `app.automation_runs`)

## Stories

- As an Owner, Admin or Member I want to see the Instagram users who commented, sent a DM, replied to a story or clicked a button, with the email and phone they shared, so that the team can follow up its leads.
- As an Owner, Admin or Member I want to search, filter and sort contacts so that I find the right people quickly.
- As an Owner or Admin I want to delete one contact so that we can honour that person's request to erase their data.
- As an Instagram user I want my data erased when I ask the team so that they no longer hold it.

## Rules

- Contacts are created and updated only from the events Instagram sends; nobody adds or edits one by hand (data.contact)
- Each contact belongs to the Instagram account it came from: the same person on another of the organization's accounts is another contact, and reconnecting the same account keeps its contacts (data.contact; D25)
- A new contact's name, picture and follower count are read from Instagram; when that read fails the contact is saved without them (data.contact; D25)
- The list searches username, full name and email in any case; filters by tags (holds all given, up to 10), has email, has phone, following (a never-checked contact matches neither value), first seen from / to, the automation it had a run of, and the Instagram account; sorts by last message (default, newest first), first seen or username (contacts without a username last), either way (operations.list-contacts; D25)
- Everyone who may view contacts sees their emails and phone numbers (operations.list-contacts; D2)
- Deleting a contact needs `contact:delete` (Owner and Admin); it wipes the personal data — Instagram id, username, name, picture, followers, follow status, email, phone and tags — and keeps the record, so its runs stay without personal data; it is never listed again, every later call on it is not found, and it cannot be restored (operations.delete-contact, data.erasure; D23, D25)
- A later comment or message from the same Instagram user starts a fresh contact (data.contact; D25)
- No plan limit counts contacts (quality.no-plan-limits; D12)
- A read-only plan never blocks deleting a contact, so a team can always erase personal data (quality.read-only-plan; D27)
- Contact personal data is masked in logs; the delete's audit entry names the contact's id only (quality.personal-data, quality.log-masking, quality.audit; D25)
- Another organization's contact is never shown and answers not found (data.organization-scope)
- The list is not live; a refresh shows new contacts (D11)

## Acceptance criteria

- AC-4.1 — The contact list shows each contact with its Instagram account, Instagram id, username, name, picture, followers, follow status, email, phone, tags, first seen, last message received and last message sent, newest last message first — intake-files/schema-routes.md:646
- AC-4.2 — Searching finds contacts by any word of their username, full name or email, in any case — intake-files/schema-routes.md:651
- AC-4.3 — Each filter narrows the list: tags (holds all given), has email, has phone, following (a never-checked contact matches neither value), first seen from / to (`to` exclusive), Instagram account; a bad value is refused — intake-files/schema-routes.md:372
- AC-4.4 — The automation filter lists only the contacts that had a run of that automation, a deleted automation included; an unknown automation gives an empty page — intake-files/schema-routes.md:378
- AC-4.5 — Sorting by last message, first seen or username works in both directions across pages; contacts without a username come last — intake-files/schema-routes.md:381
- AC-4.6 — A page holds 1–100 contacts (default 25) and the next page continues from it; the first page carries an estimated total — intake-files/schema-routes.md:83
- AC-4.7 — One Instagram user who interacts with two of the organization's Instagram accounts appears as two contacts, one per account; filtering by account shows each account's own — plans/decisions.md D25
- AC-4.8 — A new contact gets its name, picture and follower count from Instagram; when Instagram cannot be read, the contact is still saved without them — plans/decisions.md D25
- AC-4.9 — No operation adds or edits a contact — intake-files/schema-routes.md:646
- AC-4.10 — Deleting a contact removes it from the list and empties its Instagram id, username, name, picture, followers, follow status, email, phone and tags; the contact record and its runs stay — plans/decisions.md D25
- AC-4.11 — Deleting an already deleted contact, another organization's contact or an unknown id answers `contact_not_found` — intake-files/schema-routes.md:81
- AC-4.12 — A Member is refused with `missing_permission` when deleting a contact — plans/decisions.md D23
- AC-4.13 — After a delete, a new comment or DM from the same Instagram user creates a fresh contact — plans/decisions.md D25
- AC-4.14 — A contact delete leaves one audit entry naming the contact's id only, never the erased values — plans/decisions.md D25
- AC-4.15 — A Member sees the emails and phone numbers in the list — intake-files/schema-routes.md:149
- AC-4.16 — While the organization's plan is read-only, deleting a contact still works — plans/decisions.md D27

## Work items

- data.contact
- operations.list-contacts
- operations.delete-contact
- quality.no-plan-limits (contacts)
- quality.audit
