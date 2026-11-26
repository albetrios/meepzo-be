import { z } from 'zod';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import {
  ENTITLEMENT_OVERRIDE_KEYS,
  ENTITLEMENT_OVERRIDE_REASON_MAX_LENGTH,
} from './entitlement.constants.js';
import { entitlementOverrideValueSchema } from './entitlement-override.util.js';

const organizationIdSchema = z
  .string()
  .regex(publicIdPatternFor('organization'), 'errors:validation.invalidPublicId');

/** Zod schema for the `:entitlement_override_id` path param (the admin remove, P270). */
export const entitlementOverrideIdParamsDto = z
  .object({
    entitlement_override_id: z
      .string()
      .regex(
        publicIdPatternFor('organizationEntitlementOverride'),
        'errors:validation.invalidPublicId',
      ),
  })
  .strict();

/** Query of `GET /api/v1/billing/entitlement-overrides` (P270): the organization whose overrides. */
export const listEntitlementOverridesQueryDto = z
  .object({ organization_id: organizationIdSchema })
  .strict();

/** Validated query inferred from {@link listEntitlementOverridesQueryDto}. */
export type ListEntitlementOverridesQueryInput = z.infer<typeof listEntitlementOverridesQueryDto>;

/**
 * Body of `POST /api/v1/billing/entitlement-overrides` (P270): sets one organization's override of
 * one key — a plan feature switch (`value` boolean) or a limit (`value` an integer in the plan
 * limit's bounds) — until `expires_at` (in the future; absent or `null` = no end), with a `reason`.
 */
export const SetEntitlementOverrideDto = z
  .object({
    organization_id: organizationIdSchema,
    key: z.enum(ENTITLEMENT_OVERRIDE_KEYS),
    value: z.union([z.boolean(), z.number().int()]),
    expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
    reason: trimmedStringMinMax({ min: 1, max: ENTITLEMENT_OVERRIDE_REASON_MAX_LENGTH }),
  })
  .strict()
  .superRefine((body, context) => {
    if (!entitlementOverrideValueSchema(body.key).safeParse(body.value).success) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'errors:validation.entitlementOverrideValueInvalid',
      });
    }
    if (
      body.expires_at !== undefined &&
      body.expires_at !== null &&
      new Date(body.expires_at).getTime() <= Date.now()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expires_at'],
        message: 'errors:validation.entitlementOverrideExpiresAtPast',
      });
    }
  });

/** Inferred input type from {@link SetEntitlementOverrideDto}. */
export type SetEntitlementOverrideInput = z.infer<typeof SetEntitlementOverrideDto>;
