# feat-instagram-dm-sending-2026-11-23-oxak — as built

Baseline: none (changes `launch-2026-11-20-ujai` in place, P29) · KICKOFF.md approved 2026-11-24 · kickoff started 2026-11-24

Run mode ([P102](plans/decisions.md)): the whole ROUTE R1–R63 without a per-row stop, at the owner's word. Each row ends
with its row below and a one-line report; the `Reviewed` cells stay `—` until the owner reviews at Close. Where agent-os
cannot build `plans/routes-final.md` exactly as written, the row follows agent-os, records the difference here and in
`plans/decisions.md` (AMBER, "user delegated 2026-11-24") and syncs `routes-final.md`; a scope change is parked as
`deferred` for the owner, never decided. Commits stay local (no push).

## Rows

| # | Planned | Actually built | Difference | Why | Decision | Commit | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R12 | 12 Upload — message files: the `message-media` purpose, per-type caps, the 25 MB ceiling, the audio magic bytes, the usable-file read; routes 140, 150 — routes-final § 12 UP1–UP5 (UPC1–UPC4) | No table, no migration. `UPLOAD_PURPOSES.MESSAGE_MEDIA` (`message-media`, organization target, key prefix `message-media/`, png/jpeg ≤ `MESSAGE_IMAGE_MAX_BYTES` 8 MB, `audio/aac` · `audio/mp4` · `audio/x-m4a` · `audio/wav` ≤ `MESSAGE_AUDIO_MAX_BYTES` 25 MB, pdf ≤ `MESSAGE_FILE_MAX_BYTES` 25 MB); `UploadPurposeConfig.maxSizeByContentType` + `getUploadMaxSizeForContentType` read by the validator and the presigned POST `content-length-range`; `magicByteVerifiedTypesOnly` (no SVG under `UPLOAD_ALLOW_SVG`); `UPLOAD_DTO_FILE_SIZE_MAX_BYTES` 10 → 25 MB; audio extensions in `upload-content-type.util.ts`; `file-magic.util.ts` reworked to several signatures per type + a format marker (AAC ADTS `FF F1/F9/F0/F8`, ADIF, `ftyp` at 4 for mp4/x-m4a, RIFF+`WAVE`). **The usable-file read: `UploadService.findUsableMessageFile({ scope: OrganizationPrincipalDatabaseScope, uploadPublicId })` → `UsableMessageFile` `{ upload_public_id, content_type, file_size, download_url }` or `null`** (on `app.uploadDomain.uploadService` — R13's go-live check and R20's attachment task call it). OpenAPI copy of routes 140/150, `upload.overview.md`, the upload-storage runbook. Tests: `upload-message-media.unit.test.ts` (every type verifiable, caps, no SVG, validator), `file-magic.util.unit.test.ts` (+ audio), `file-magic.util.property.unit.test.ts` (new), `upload.service.find-usable-message-file.db.unit.test.ts` (another organization's, another purpose, pending, failed, deleted → `null`), `upload-message-media.integration.test.ts` (each type at its cap / one byte over, webp and ogg refused, no `upload:manage` → 403 `missing_permission`, with it → 200, a fake `.m4a` refused on confirm and marked FAILED, a real one confirmed). No public-id prefix (no table) | (1) § 12.3/UP5 assume a `purpose` column — there is none; the purpose is read from the key prefix. (2) Over the 25 MB ceiling the refusal's field is `body.file_size` (route schema), not `file_size`. (3) The upload property "no shared extension within a purpose" now allows the one alias `audio/x-m4a` ↔ `audio/mp4` (`.m4a`), which UP2 asks for. (4) AC-15.5 is proven with a role without / with `upload:manage`; the named Viewer and Editor roles land at R28. AC-15.3 (go-live refuses an unusable file) is R13's check over this read. (5) The scan is not built — the D58 Standing deviation below (AC-15.6) | (1) no column exists and § 12 asks for no migration; the key prefix is how every purpose is already encoded. (2) the existing DTO ceiling answers first, as built for every purpose. (3) Safari/macOS send `audio/x-m4a` for the same `.m4a` file. (4)–(5) build order and P34 | [P103](plans/decisions.md), [P34](plans/decisions.md), [P25](plans/decisions.md) | this row's commit | — |

## Kickoff choices

- P22 — public-id prefixes of the new tables: recorded per row as each table lands.
- worker-changes note 1 — the launch's "start the automations queued behind an email" kept unchanged.
- R12 — no new table, so no public-id prefix; the message-file read for later rows is `UploadService.findUsableMessageFile` (R13, R20).

## Revisions to upcoming rows

- none yet

## Summary

- Planned, not built (deferred — user OK): …
- Built, not planned: …
- Follow-ups for the next iteration: …

## Standing deviations

The starting list is the launch's (`../launch-2026-11-20-ujai/AS-BUILT.md` › Standing deviations), as planned against in
KICKOFF.md section 8; this table is completed at Close — the launch's list, minus what this iteration resolved, plus its
new ones (the D58 file scan, P34, among them).

| Item | Design says | Built as | Since iteration | Decision |
| --- | --- | --- | --- | --- |
| Malware scan of message files | Scanned before use (plan D58) | Type and content checks only | feat-instagram-dm-sending-2026-11-23-oxak | [P34](plans/decisions.md) |
