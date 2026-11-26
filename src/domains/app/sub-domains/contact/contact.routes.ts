import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import type { ContactService } from './contact.service.js';
import { createContactController } from './contact.controller.js';
import {
  contactActivityQueryDto,
  contactBulkActionBodyDto,
  contactIdParamsDto,
  emptyContactActionBodyDto,
  listContactTagsQueryDto,
  listContactsQueryDto,
  updateContactBodyDto,
} from './contact.dto.js';
import { PLAN_GATE_OPEN_REASON } from '@/domains/billing/sub-domains/entitlement/entitlement.constants.js';

/**
 * Returns the Fastify plugin that registers the contact routes (routes-final § 3.7, routes 18–26),
 * mounted under `/api/v1/app`: the list (18), open one (19), the owner's change (20), the bulk
 * action (21), the tag list (22), the erase (23), "what happened" (24) and her failed messages'
 * summary and retry (25–26, over sub-domain 6's message service — M6).
 *
 * @remarks
 * Gates (3.4): `contact:read` on 18, 19, 22, 24, 25; `contact:update` on 20, 21, 26 (Owner, Admin,
 * Editor — P20); `contact:delete` on 23 (Owner, Admin). Routes 21 and 26 start work, so they need
 * `X-Idempotency-Key` (`idempotencyRequired`); route 20 takes an optional `expected_updated_at`. The
 * writes carry the organization-scoped rate limit; the reads ride the global limiter.
 */
export function contactRoutes(service: ContactService): FastifyPluginAsync {
  const controller = createContactController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get(
      '/contacts',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CONTACT_READ)],
        schema: {
          summary: 'List contacts',
          description:
            "Lists one channel account's contacts — the people who commented on, messaged, replied to a story of or tapped a button of it — each with its profile, the email and phone they shared, tags, whether they opted out or their automations are paused, how they came in, and their message, comment, story and broadcast times. channel_account_id is required (an unknown one gives an empty page). Search q (username, full name, email or phone, at least 3 characters, every word anywhere); filter by tags (holds all, up to 10), has_email, has_phone, is_following_account (a never-checked contact matches neither value), is_opted_out, is_automations_paused, came_in_via (one or more ways to start), first_automation_id, first_seen_from / first_seen_to (to exclusive) and automation_id (the contacts that had a run of that automation, a deleted one included; an unknown one gives an empty page); sort by last_message_received_at (default, newest first), first_seen_at or username (A to Z, contacts without a username last), order asc or desc. The first page carries an estimated total. A deleted contact is never listed. Team organizations only. Requires CONTACT_READ permission.",
          tags: ['Contact'],
          querystring: listContactsQueryDto,
        },
      },
      controller.listContacts,
    );
    zodApplication.get<{ Params: { contact_id: string } }>(
      '/contacts/:contact_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CONTACT_READ)],
        schema: {
          summary: 'Get a contact',
          description:
            "Opens one contact: the list's contact plus the team's private note, who paused her automations, her last opening message time, the automation she came in through (a deleted one keeps its name until purged) and how many of her automation runs are open. 404 contact_not_found when it is not this organization's or was deleted. Team organizations only. Requires CONTACT_READ permission.",
          tags: ['Contact'],
          params: contactIdParamsDto,
        },
      },
      controller.getContact,
    );
    zodApplication.patch<{ Params: { contact_id: string } }>(
      '/contacts/:contact_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CONTACT_UPDATE)],
        config: {
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.CONTACT },
        },
        schema: {
          summary: 'Update a contact',
          description:
            "Changes the team's side of one contact: note (1–2,000 characters; null clears it; nothing is sent to her), add_tags / remove_tags (1–20 tags each, 1–50 characters, a comma becomes a space; a tag may not be in both lists; at most 50 held — past it 422 contact_tag_limit) and is_automations_paused (true stops every automation for her: her open runs are cancelled and her waiting messages skipped in the same commit; false clears it and restarts nothing). Each tag change is recorded for tag-started automations. Send at least one field; optional expected_updated_at answers 409 record_changed when the contact changed since it was read. Her opt-out cannot be changed here. Answers the contact detail. Team organizations only. Requires CONTACT_UPDATE permission.",
          tags: ['Contact'],
          params: contactIdParamsDto,
          body: updateContactBodyDto,
        },
      },
      controller.updateContact,
    );
    zodApplication.post(
      '/contacts/bulk-actions',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CONTACT_UPDATE)],
        config: {
          idempotencyRequired: true,
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.CONTACT },
        },
        schema: {
          summary: 'Run a bulk action on contacts',
          description:
            "Adds or removes one tag, or pauses or resumes automations, for many contacts of one channel account: name them by contact_ids (1–500, no repeats) or select every match of filter (the list's filters, without sort and paging) — exactly one. tag is required for add_tag and remove_tag and absent for the pause actions. The matches are counted (more than 100,000 answer 422 contact_bulk_too_many) and the work is queued; it runs in pieces of 500, each change as on a single contact, and a contact that would pass 50 tags is skipped. Answers the action, matched_count and is_queued. 404 channel_account_not_found when the account is not this organization's. Needs X-Idempotency-Key. Team organizations only. Requires CONTACT_UPDATE permission.",
          tags: ['Contact'],
          body: contactBulkActionBodyDto,
        },
      },
      controller.startContactBulkAction,
    );
    zodApplication.get(
      '/contact-tags',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CONTACT_READ)],
        schema: {
          summary: 'List contact tags',
          description:
            "Lists one channel account's tags with how many live contacts hold each, most first, then A to Z — up to limit (1–1,000, default 1,000). The counts move in the same commit as every tag change. channel_account_id is required; 404 channel_account_not_found when it is not this organization's. Team organizations only. Requires CONTACT_READ permission.",
          tags: ['Contact'],
          querystring: listContactTagsQueryDto,
        },
      },
      controller.listContactTags,
    );
    zodApplication.get<{ Params: { contact_id: string } }>(
      '/contacts/:contact_id/activity',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CONTACT_READ)],
        schema: {
          summary: "List a contact's activity",
          description:
            "What happened with one contact, newest first: the messages the automations sent or planned for her in about the last 30 days (each with its type, list number, status, reason and how it was delivered) and her automation runs' history (started, step changes, her email or phone received, her taps, ended), each with its automation and run. Her own words and the email or phone values never appear (they are on the contact). Pages by limit (1–100, default 50) and after; meta.message_horizon_days (30) says why older entries show only run history. 404 contact_not_found when it is not this organization's or was deleted. Team organizations only. Requires CONTACT_READ permission.",
          tags: ['Contact'],
          params: contactIdParamsDto,
          querystring: contactActivityQueryDto,
        },
      },
      controller.listContactActivity,
    );
    zodApplication.get<{ Params: { contact_id: string } }>(
      '/contacts/:contact_id/failed-messages/summary',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CONTACT_READ)],
        schema: {
          summary: "Count a contact's failed messages",
          description:
            "Counts the messages to one contact that failed in about the last 30 days: how many can go again now, and how many cannot and why — too_old (an opening private reply past its comment's 7 days less 30 minutes, or a public reply or hide past 7 days), chat_closed (any other message while her 24-hour chat is closed), final_for_person (she blocked the account, cannot be found, gave no consent, another app answers her chat, or she opted out or her automations are paused), text_refused (the automation is still stopped for a refused text), broadcast (never retried) and already_retried (each message goes again at most once). Changes nothing. 404 contact_not_found when it is not this organization's or was deleted. Team organizations only. Requires CONTACT_READ permission.",
          tags: ['Contact'],
          params: contactIdParamsDto,
        },
      },
      controller.summarizeContactFailedMessages,
    );
    zodApplication.post<{ Params: { contact_id: string } }>(
      '/contacts/:contact_id/failed-messages/retry',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CONTACT_UPDATE)],
        config: {
          idempotencyRequired: true,
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { gates: ['limit:message_month_limit'] },
        },
        schema: {
          summary: "Retry a contact's failed messages",
          description:
            "Puts the failed messages to one contact that can go again now (as the summary counts them) back in line, each at most once; they go through the normal sending limits and count in the month's messages when sent. A message that fails again stays failed. An opted-out or paused contact has none to retry. Answers expected_retry_count and is_queued (false while the retry runs in the request). The body is empty. Needs X-Idempotency-Key. 404 contact_not_found when it is not this organization's or was deleted. Team organizations only. Requires CONTACT_UPDATE permission.",
          tags: ['Contact'],
          params: contactIdParamsDto,
          body: emptyContactActionBodyDto,
        },
      },
      controller.retryContactFailedMessages,
    );
    zodApplication.delete<{ Params: { contact_id: string } }>(
      '/contacts/:contact_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CONTACT_DELETE)],
        config: {
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.CONTACT },
        },
        schema: {
          summary: 'Delete a contact',
          description:
            "Erases one contact's personal data at the person's request: their provider id, username, name, picture, followers, follow status, email, phone, tags, the team's note, their opt-out and pause, how they came in and their activity times are cleared in one transaction, together with the copies other features hold; their open automation runs are cancelled. The record stays without personal data so its automation runs stay, is never listed again and cannot be restored; a later comment or message from the same person starts a fresh contact. A repeat answers 404 contact_not_found. Team organizations only. Requires CONTACT_DELETE permission.",
          tags: ['Contact'],
          params: contactIdParamsDto,
        },
      },
      controller.deleteContact,
    );
  };
}
