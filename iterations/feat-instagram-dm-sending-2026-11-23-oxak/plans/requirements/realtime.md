# Realtime requirements — feat-instagram-dm-sending-2026-11-23-oxak

Answers: what must update on screen without a refresh.

n/a — the plan has no live screen updates. Every screen of this iteration — connections and accounts,
the sending banners, the month meter, contacts, automations, broadcasts and past-comment reads — shows new
data when it is read again; background work only changes the database. Where a read is costly, it is
served from a short copy that is refreshed on read, never pushed: the sending status through a 10-second
copy (routes-final § 6 SN11, SN14), the waiting estimate made every 10 minutes (WC-24), the tag list
cached 60 seconds (P64). Dismissing an organization notice is remembered by the browser (P27); the undo
toast is the client's replay (P15). The launch had no live updates either (launch D11).

## Before → after

none — every requirement here is NEW (this file has none).
