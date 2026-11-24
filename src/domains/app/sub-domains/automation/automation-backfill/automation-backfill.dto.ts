import { z } from 'zod';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';
import { PAST_COMMENTS_MAX_DAYS, PAST_COMMENTS_MIN_DAYS } from './automation-backfill.constants.js';

/** Path of `POST /app/automations/{automation_id}/backfills` (route 38). */
export const automationBackfillsParamsDto = z
  .object({
    automation_id: trimmedStringMinMax({ min: 1, max: 28 }),
  })
  .strict();

/** Path of `GET /app/automations/{automation_id}/backfills/{automation_backfill_id}` (route 39). */
export const automationBackfillParamsDto = z
  .object({
    automation_id: trimmedStringMinMax({ min: 1, max: 28 }),
    automation_backfill_id: trimmedStringMinMax({ min: 1, max: 28 }),
  })
  .strict();

/**
 * Body of `POST /app/automations/{automation_id}/backfills` (route 38, 4.C.8, AU31): `days`, a whole
 * number from 1 to 7 (`PAST_COMMENTS_MAX_DAYS`); any other field is refused.
 */
export const startAutomationBackfillDto = z
  .object({
    days: z.number().int().min(PAST_COMMENTS_MIN_DAYS).max(PAST_COMMENTS_MAX_DAYS),
  })
  .strict();
