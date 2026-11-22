import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import type { ContactService } from './contact.service.js';
import { createContactController } from './contact.controller.js';
import { contactIdParamsDto, listContactsQueryDto } from './contact.dto.js';

/**
 * Returns the Fastify plugin that registers the contact routes (routes-final § 2.7), mounted under
 * `/api/v1/app`: the list (route 9, `GET /contacts`) and the erase (route 10,
 * `DELETE /contacts/{contact_id}`).
 *
 * @remarks
 * Gates: `contact:read` on 9, `contact:delete` on 10 (2.4 — a Member holds the first only). No
 * route adds or edits a contact (CT2), so neither takes a body or `X-Idempotency-Key` (K3). The
 * erase carries the organization-scoped rate limit; the list rides the global limiter, as every
 * plain authenticated read does.
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
            "Lists the people who commented on, messaged, replied to a story of or clicked a button of one of the organization's Instagram accounts — each with its Instagram account, profile, follow status, the email and phone they shared, tags and message times. Search q (username, full name or email, any case, every word anywhere); filter by tags (holds all, up to 10), has_email, has_phone, is_following_account (a never-checked contact matches neither value), first_seen_from / first_seen_to (to exclusive), instagram_account_id (an unknown one gives an empty page) and automation_id (the contacts that had a run of that automation, a deleted one included; an unknown one gives an empty page); sort by last_message_received_at (default, newest first), first_seen_at or username (A to Z, contacts without a username last), order asc or desc. The first page carries an estimated total. A deleted contact is never listed. Team organizations only. Requires CONTACT_READ permission.",
          tags: ['Contact'],
          querystring: listContactsQueryDto,
        },
      },
      controller.listContacts,
    );
    zodApplication.delete<{ Params: { contact_id: string } }>(
      '/contacts/:contact_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CONTACT_DELETE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Delete a contact',
          description:
            "Erases one contact's personal data at the person's request: their Instagram id, username, name, picture, followers, follow status, email, phone and tags are cleared in one transaction, together with the copies other features hold. The record stays without personal data so its automation runs stay, is never listed again and cannot be restored; a later comment or message from the same Instagram user starts a fresh contact. A repeat answers 404 contact_not_found. Team organizations only. Requires CONTACT_DELETE permission.",
          tags: ['Contact'],
          params: contactIdParamsDto,
        },
      },
      controller.deleteContact,
    );
  };
}
