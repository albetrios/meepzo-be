Status: draft
Kind: screen
Depends on: roles-and-organization
Route review: [routes-final.md](../../routes-final.md) § 12 — routes 140, 150; sub-domain 6.C for the attachment step

## Stories

- As an Owner, Admin or Editor I want to upload a picture, a voice note or a PDF for a message so that my automation can send files.
- As the system I want every message file checked by its type and content so that nothing but the promised kind of file is sent.
- As the system I want each file uploaded to Instagram once per account so that sending stays fast.

## Rules

- A new upload purpose for message files: images (png, jpeg) up to 8 MB, voice notes (aac, m4a, wav) up to 25 MB, PDFs up to 25 MB; the upload ceiling rises to 25 MB (files.message-file-upload; plan §5.9)
- Confirm checks the content's magic bytes for every message-file type, audio included (files.message-file-upload; P34)
- No malware scan this iteration — a D58 deviation recorded in AS-BUILT (files.message-file-scan; P34)
- A message points at the upload by its public id only, read through the upload service (operations.automation-message-attachments; P25)
- A file is uploaded to Instagram once per account and reused; it is uploaded at go-live, at a file change of a live automation, or just before a send that needs it (background.attachment-upload; plan §30.4)
- Uploading needs `upload:manage` (Owner, Admin, Editor) (access.editor-viewer-roles)

## Acceptance criteria

- AC-15.1 — A message-file upload of a png or jpeg up to 8 MB, a voice note up to 25 MB or a PDF up to 25 MB is accepted; a bigger file or another type is refused — plans/routes-final.md route 140
- AC-15.2 — Confirming a file whose bytes do not match its declared type (audio included) is refused and the file cannot be used in a message — plans/routes-final.md route 150
- AC-15.3 — Go-live of an automation whose message file is not uploaded or not confirmed is refused — intake-files/Instagram-DM-Sending-Plan-v8.md:706
- AC-15.4 — A file used by several messages of one account is uploaded to Instagram once and reused — intake-files/Instagram-DM-Sending-Plan-v8.md:5512
- AC-15.5 — A Viewer is refused the upload with `missing_permission`; an Editor may upload — intake-files/Instagram-DM-Sending-Plan-v8.md:7866
- AC-15.6 — No scan runs and the AS-BUILT records the D58 deviation — plans/decisions.md P34

## Work items

- files.message-file-upload
- files.message-file-scan
- operations.automation-message-attachments
- background.attachment-upload
- access.editor-viewer-roles
- files.message-file-reference
