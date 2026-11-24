import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import { startAutomationBackfillDto } from './automation-backfill.dto.js';

/**
 * Parses route 38's body (4.C.8, AU31): the days back.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`, field `days`) when it is missing, not a whole number or
 * outside 1–7; an unknown field is a `400` too. An absent body is an empty one (so `days` is missing).
 */
export function validateStartAutomationBackfill(data: unknown): { days: number } {
  return parseWithSchema({ schema: startAutomationBackfillDto, data: data ?? {} });
}
