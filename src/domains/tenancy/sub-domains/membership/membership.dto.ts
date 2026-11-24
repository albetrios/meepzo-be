import { z } from 'zod';
import { listSearchSortSchema } from '@/shared/utils/http/list-query.util.js';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';
import {
  addEndAfterStartIssue,
  chipToneSchema,
  expectedUpdatedAtSchema,
  hourMinuteSchema,
  phoneNumberSchema,
  recordDeleteQuerySchema,
  recordIdSchema,
  workingDaysSchema,
} from '@/shared/utils/validation/record-fields.util.js';
import {
  INVITE_EMAILS_MAX,
  MEMBERSHIP_COMMISSION_PERCENT_MAX,
  MEMBERSHIP_INVITE_EMAIL_MAX_LENGTH,
  MEMBERSHIP_DISPLAY_NAME_MAX_LENGTH,
  MEMBERSHIP_ROLE_IDS_MAX,
  MEMBERSHIP_STATUS,
  MEMBERSHIP_STATUS_VALUES,
} from './membership.constants.js';

/** Zod schema for the `:membership_id` path param (get/get-permissions/update/delete membership). */
export const membershipIdParamsDto = z
  .object({
    membership_id: recordIdSchema,
  })
  .strict();

/** Up to {@link MEMBERSHIP_ROLE_IDS_MAX} distinct role ids, the main role first (D5). */
const roleIds = z
  .array(trimmedStringMinMax({ min: 1, max: 28 }))
  .min(1)
  .max(MEMBERSHIP_ROLE_IDS_MAX)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'errors:validation.eachRoleOnce' });

/** The staff profile fields an update accepts (launch ROUTE #4, D3). */
const staffProfileFields = {
  phone: phoneNumberSchema.nullable().optional(),
  tone: chipToneSchema.optional(),
  working_days: workingDaysSchema.optional(),
  work_starts_at: hourMinuteSchema.optional(),
  work_ends_at: hourMinuteSchema.optional(),
  commission_percent: z
    .number()
    .min(0)
    .max(MEMBERSHIP_COMMISSION_PERCENT_MAX)
    .multipleOf(0.01)
    .optional(),
};

/** Rejects working hours that end at or before they start, when both are given. */
function workEndsAfterStarts({
  value,
  context,
}: {
  value: { work_starts_at?: string | undefined; work_ends_at?: string | undefined };
  context: z.RefinementCtx;
}): void {
  addEndAfterStartIssue({
    start: value.work_starts_at,
    end: value.work_ends_at,
    endField: 'work_ends_at',
    message: 'errors:validation.workEndsBeforeStarts',
    context,
  });
}

/**
 * One address of an invite as sent (route 117, TN10): trimmed and lower-cased only. Whether it is
 * an email is checked per address by the service, so one bad address answers `invalid_email` in
 * its own line instead of refusing the whole invite.
 */
const inviteEmail = z.string().trim().toLowerCase().max(MEMBERSHIP_INVITE_EMAIL_MAX_LENGTH);

/**
 * Zod schema for the `POST /organization/memberships` request body — the "Invite" action
 * (feat-instagram-dm-sending route 117, TN10, P82): `emails` (1–{@link INVITE_EMAILS_MAX},
 * trimmed, lower-cased; a repeat is folded into its first by the service), `role_ids` with exactly
 * one role (the shape `PATCH` uses — a second role is refused `403 custom_roles_off` by the service
 * while custom roles are off, TN3), and an optional invitation `expires_in_days` (1–365, default 7).
 * The staff profile fields are not taken (one invite cannot carry one person's phone or hours — they
 * stay on `PATCH`). Each membership is created `invited`; its invitee is emailed a token and becomes
 * `active` on accept.
 */
export const createMembershipDto = z
  .object({
    emails: z.array(inviteEmail).min(1).max(INVITE_EMAILS_MAX),
    role_ids: roleIds,
    expires_in_days: z.number().int().min(1).max(365).optional().default(7),
  })
  .strict();

/**
 * Zod schema for the `PATCH /organization/memberships/:membership_id` request body (launch §2.B.8):
 * for a live member, the `status` (`active` ↔ `suspended` only, T10), its roles (`role_ids` replaces
 * the whole list, main first) and any staff profile field (`phone: null`
 * clears it); for an ended member, `display_name` only (K6, D58). At least one field
 * besides `expected_updated_at` (T14) must be provided — the service enforces which ones apply.
 */
export const updateMembershipDto = z
  .object({
    status: z.enum([MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.SUSPENDED]).optional(),
    role_ids: roleIds.optional(),
    display_name: trimmedStringMinMax({
      min: 1,
      max: MEMBERSHIP_DISPLAY_NAME_MAX_LENGTH,
    }).optional(),
    expected_updated_at: expectedUpdatedAtSchema,
    ...staffProfileFields,
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expected_updated_at'), {
    message: 'errors:validation.sendAtLeastOneField',
  })
  .superRefine((value, context) => workEndsAfterStarts({ value, context }));

/**
 * Query of `DELETE /organization/memberships/:membership_id` — why the member is removed
 * (`reason`, and a `note` when the reason is `other`).
 */
export const deleteMembershipQueryDto = recordDeleteQuerySchema;

/**
 * Zod schema for the `GET /organization/memberships` list query (launch §2.B.8): cursor pagination,
 * `q` (the member's name or email), `sort` (`name` — the membership's `display_name` — or
 * `created_at`, the default), `order`, and the filters `status`, `role_id` (main or extra role)
 * and `include_ended` (ended members too, D58). `sort` / `order` stay optional (a
 * defaulted param serializes as `required` in OpenAPI).
 */
export const listMembershipsQueryDto = listSearchSortSchema(['name', 'created_at'] as const)
  .extend({
    status: z.enum(MEMBERSHIP_STATUS_VALUES).optional(),
    role_id: recordIdSchema.optional(),
    include_ended: z.enum(['true', 'false']).optional().default('false'),
  })
  .strict();

/**
 * Zod schema for the `POST /organization/transfer-ownership` request
 * body. `new_owner_user_id` is the target user's public id; the optional `former_owner_role_id`
 * (`rol_…`) is the main role the current owner moves to — the organization's Admin role when
 * absent. It can never be the role the owner holds now (the Owner role passes to the new owner).
 */
export const transferOwnershipDto = z
  .object({
    new_owner_user_id: trimmedStringMinMax({ min: 1, max: 28 }),
    former_owner_role_id: trimmedStringMinMax({ min: 1, max: 28 }).optional(),
  })
  .strict();

/** Validated body inferred from {@link createMembershipDto}. */
export type CreateMembershipInput = z.infer<typeof createMembershipDto>;
/** Validated body inferred from {@link updateMembershipDto}. */
export type UpdateMembershipInput = z.infer<typeof updateMembershipDto>;
/** Validated query inferred from {@link deleteMembershipQueryDto}. */
export type DeleteMembershipQueryInput = z.infer<typeof deleteMembershipQueryDto>;
/** Validated query inferred from {@link listMembershipsQueryDto}. */
export type ListMembershipsQueryInput = z.infer<typeof listMembershipsQueryDto>;
/** Validated body inferred from {@link transferOwnershipDto}. */
export type TransferOwnershipInput = z.infer<typeof transferOwnershipDto>;
