import { z } from 'zod';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';

/**
 * Zod schema validating the path params for `GET /api/v1/billing/plans/{plan_id}` — `plan_id` must be a
 * well-formed `pln_…` id (routes-final 8.A.9: `400` · `plan_id` otherwise).
 */
export const getPlanParamsDto = z
  .object({
    plan_id: z.string().regex(publicIdPatternFor('plan'), 'errors:validation.invalidPublicId'),
  })
  .strict();

/** Inferred type from {@link getPlanParamsDto}. */
export type GetPlanParamsInput = z.infer<typeof getPlanParamsDto>;
