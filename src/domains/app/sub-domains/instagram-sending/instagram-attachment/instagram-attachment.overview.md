`src/domains/app/sub-domains/instagram-sending/instagram-attachment/`

# Instagram attachment

Parent: [Instagram sending](../instagram-sending.overview.md)

## Purpose

Meta's id for a message file, uploaded **once per Instagram account** and reused by every later
message of that account with that file (feat-instagram-dm-sending routes-final § 6.C, SN20, SN21;
SNC15; AC-15.4; ROUTE row R20). A persistence module with no routes (the `auth/verification-token`
precedent): the send core (ROUTE row R42) asks it for a file's id just before a send, and the
`attachment-upload` task (WC-32, ROUTE row R46) uploads a live automation's files ahead of time.

## Layout

- `instagram-attachment.schema.ts` — `app.instagram_attachments`: the channel account (composite key,
  `CASCADE`), `upload_public_id` (`upl_…`, a value — no key into `upload.uploads`, P25), Meta's
  `attachment_id`; unique per organization, account and upload. FORCE RLS: the organization arm, plus
  the retention sweep arm in `USING` only (the deleted-automation purge, WC-47).
- `instagram-attachment.repository.ts` — the look-up, the first write (`ON CONFLICT DO NOTHING`, the
  kept id wins) and the delete on "gone".
- `instagram-attachment.service.ts` — `InstagramAttachmentService`: `findOrUploadAttachment` (kept →
  no call; else the upload service's usable-file read, the account's send access and the connection's
  usage pace, the Meta upload outside any unit of work, the row), `forgetAttachment`,
  `uploadAttachments` (WC-32's body) and `requestAttachmentUploads` (the task queue, once R46 wires it).
- `instagram-attachment.types.ts` — the file port (`UploadService.findUsableMessageFile`), the uploader,
  the `attachment-upload` queue port (R46) and the outcomes.

The Meta call is the channel connection's client, `uploadInstagramMessageAttachment`
(`POST /{instagram_user_id}/message_attachments`, `is_reusable`, `appsecret_proof`); the content type →
attachment type table and the upload tries (3) are in the sending settings file.

## Rules

- **Only a confirmed message file of this organization is ever uploaded** (SN21): the upload domain's
  read answers `null` for a pending, failed, deleted, other-purpose or other organization's upload, and
  the attachment answers `unusable` without a Meta call. No malware scan this iteration (P34, the D58
  deviation recorded in AS-BUILT).
- **One upload per account and file:** a kept row is reused; senders of the same file in one process
  share one upload; across processes the unique key keeps the first id.
- **Meta is never called inside a unit of work**, and not at all while the account is not sendable or
  the connection's usage says wait (SN23).
- **Meta says the file is gone** (`attachment_failed`): `forgetAttachment` deletes the row so the next
  send uploads it again; giving the counts back and the message back to `waiting` are the send core's
  (R42). Three failed tries end the message `failed` · `attachment_failed` (R42 counts them).

## Tests

- `__tests__/unit/instagram-attachment.service.db.unit.test.ts` — one upload per account and file
  (sequential and at the same moment), the sister account's own upload, the kept id under a race, no
  upload of an unconfirmed / failed / wrong-purpose / foreign file, no call when not sendable or at
  95 % usage, Meta's refusal and a forgotten file, the task body.
- `src/tests/contract/meta-graph.contract.test.ts` — the upload's wire shape and a malformed answer.
