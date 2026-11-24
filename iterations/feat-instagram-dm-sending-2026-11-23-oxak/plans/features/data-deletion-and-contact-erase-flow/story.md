Status: draft
Kind: flow
Depends on: channel-connection, contacts, automation-runs-and-messages, broadcasts-and-segments
Route review: [routes-final.md](../../routes-final.md) § 1 (routes 16–17, MC14–MC16), § 3.A (erase, CT11)

## Stories

- As a person who wrote to an account I want my data erased when I or Meta ask so that the business keeps nothing about me.
- As an Owner I want to delete one person so that I can honour a request myself.

## Rules

- A contact erase clears her personal data in place — also her copies in comment logs and runs — keeps the row, cancels her open runs and waiting messages, and removes her tag events and broadcast recipients (operations.contact-delete, quality.message-privacy; plan §41.11)
- Meta's data deletion runs the erasure for every account it matches (the account id first, else the business id): the token, the profile and the stored posts erased; an unmatched id still gets its confirmation code and the team an email (integrations.channel-connection-meta-callbacks; P56)
- A disconnect alone erases nothing: automations, contacts and history stay (operations.channel-account; plan §41.10)
- Contacts have no clean-up by age (quality.retention; D51)
- An erased contact answers not found everywhere (operations.contact-delete)
- Every erase leaves an audit entry without personal data (quality.audit)

## Acceptance criteria

- AC-26.1 — Deleting a contact clears her name, username, profile, email, phone and note, keeps the row, cancels her open runs and waiting messages, and removes her tag events — plans/routes-final.md § 3.A CT11
- AC-26.2 — Her copies in comment logs and runs are erased in the same step — intake-files/Instagram-DM-Sending-Plan-v8.md:7304
- AC-26.3 — After the erase the contact answers `contact_not_found` and appears in no list, segment count or broadcast — intake-files/Instagram-DM-Sending-Plan-v8.md:2628
- AC-26.4 — Meta's data deletion for an Instagram account erases its token, profile and stored posts in every organization that holds it, and answers a confirmation code; repeating it answers the same code — plans/decisions.md P56
- AC-26.5 — An unmatched id in Meta's callback still answers a confirmation code and the team gets an email — intake-files/Instagram-DM-Sending-Plan-v8.md:4703
- AC-26.6 — A disconnect without a deletion keeps the account's automations, contacts and history — intake-files/Instagram-DM-Sending-Plan-v8.md:7297
- AC-26.7 — The erase writes one audit entry that holds no email, phone or name — intake-files/Instagram-DM-Sending-Plan-v8.md:7328

## Work items

- operations.contact-delete
- integrations.channel-connection-meta-callbacks
- operations.channel-account
- quality.message-privacy
- quality.retention
- quality.audit
