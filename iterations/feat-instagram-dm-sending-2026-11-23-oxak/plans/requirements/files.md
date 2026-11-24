# File requirements — feat-instagram-dm-sending-2026-11-23-oxak

Answers: uploads, images, prints, exports.

How to read the sources: `D<n>` is the plan's locked decision (plan:L210–L284), `P<n>` a row of
[decisions.md](../decisions.md); `§ n` and the ids UP…, SN… are in [routes-final.md](../routes-final.md);
RC-… are rows of [route-changes.md](../route-changes.md); `plan:L…` points into
`../../intake-files/Instagram-DM-Sending-Plan-v8.md`. "Before" is the platform's upload domain today.
There are no exports or prints this iteration: no contact export, and the ig.me QR code is drawn by the
frontend (D43). Post and story media stay on Instagram (links only).

### `files.message-file-upload` — CHANGED

A person uploads a file for an automation or broadcast message under a new purpose: PNG or JPEG up to 8 MB,
audio (AAC, M4A, WAV) up to 25 MB, PDF up to 25 MB — never WebP or SVG. The upload ceiling rises from 10 to
25 MB for this purpose.

**Sources:** D29, P28 · routes-final § 12 UP1–UP3 · RC-61 · plan:L8443–L8445

### `files.message-file-scan` — CHANGED

On confirm, every message file passes a type and content (magic-byte) check — now also for audio — and a
message-file type that cannot be checked is not accepted. The malware scan the plan asks for (D58) is **not**
built this iteration: checks now, scan later — a D58 deviation recorded in `AS-BUILT.md`.

**Sources:** D58, P34 · routes-final § 12 UP4, § 6.C SN21 · RC-111 · plan:L269, plan:L8443

### `files.message-file-reference` — NEW

A message names its file by the upload's public id only, read through the upload service (no reference
across domains); go-live and the send check that the file is still usable, and it is uploaded to Instagram
once per account (`background.attachment-upload`). Deleting an automation removes its file links.

**Sources:** P25 · routes-final § 6.C SN20, § 12 UP5 · WC-32, WC-47

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `files.message-file-upload` | images and PDF up to 10 MB, one size per purpose | a message-file purpose with a size per type (image 8 MB, audio and PDF 25 MB) | D29, UP2, UP3 |
| `files.message-file-scan` | magic bytes checked for PNG, JPEG, WebP and PDF only; no scan | + audio; every message-file type must be checkable; still no scan (P34) | P34, UP4 |
