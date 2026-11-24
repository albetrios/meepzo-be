import { z } from 'zod';
import { PAGINATION } from '@/shared/constants/pagination.constants.js';
import { trimmedString, trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';

/** The most channel accounts a move down may keep — Studio's limit (routes-final § 8.B.8). */
const KEEP_CHANNEL_ACCOUNT_IDS_MAX = 10;

/** Zod schema for the `:subscription_id` path param (get/update/change-plan/cancel/resume). */
export const subscriptionIdParamsDto = z
  .object({
    subscription_id: trimmedStringMinMax({ min: 1, max: 28 }),
  })
  .strict();

/**
 * Zod schema for `POST /api/v1/billing/subscriptions` request body — with `is_trial: true` it starts
 * the 7-day no-card trial of a paid plan (routes-final § 8.B BL14).
 */
export const CreateSubscriptionDto = z
  .object({
    plan_id: trimmedString().max(255),
    billing_cycle: z.enum(['monthly', 'yearly']),
    is_trial: z.boolean().optional(),
  })
  .strict();

/** Inferred input type from {@link CreateSubscriptionDto}. */
export type CreateSubscriptionInput = z.infer<typeof CreateSubscriptionDto>;

/**
 * Zod schema for `POST /api/v1/billing/subscriptions/:subscription_id/change-plan` — the target plan's
 * `public_id` and, on a move down, the channel accounts to keep active after the period end
 * (`keep_channel_account_ids`: 0–10 `cha_…` ids, no repeats — routes-final § 8.B BL6, BL15).
 */
export const ChangePlanDto = z
  .object({
    plan_id: trimmedString().max(255),
    keep_channel_account_ids: z
      .array(
        z.string().regex(publicIdPatternFor('channelAccount'), 'errors:validation.invalidPublicId'),
      )
      .max(KEEP_CHANNEL_ACCOUNT_IDS_MAX)
      .refine((identifiers) => new Set(identifiers).size === identifiers.length, {
        message: 'errors:validation.eachValueOnce',
      })
      .optional(),
  })
  .strict();

/** Inferred input type from {@link ChangePlanDto}. */
export type ChangePlanInput = z.infer<typeof ChangePlanDto>;

/**
 * Zod schema for the `GET /api/v1/billing/invoices` cursor pagination query. Invoices are proxied
 * from Stripe, so `after` is a Stripe invoice id (`in_*`) fed to Stripe's `starting_after`, and
 * `limit` is capped at Stripe's page maximum (MAX_LIMIT = 100).
 *
 * @remarks
 * `limit` is `.optional()` (not `.default`): a defaulted param serializes as `required` in the
 * OpenAPI document, which misdescribes an optional parameter. The default is applied in the
 * service instead.
 */
export const listInvoicesQueryDto = z
  .object({
    after: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).optional(),
  })
  .strict();

/** Validated query inferred from {@link listInvoicesQueryDto}. */
export type ListInvoicesQueryInput = z.infer<typeof listInvoicesQueryDto>;
