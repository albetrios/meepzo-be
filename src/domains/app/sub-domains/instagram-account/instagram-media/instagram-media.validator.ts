import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import {
  ListInstagramMediaQueryDto,
  type ListInstagramMediaQueryInput,
} from './instagram-media.dto.js';

/**
 * Parses the query of the post and story pickers (routes 13–14) with the strict
 * {@link ListInstagramMediaQueryDto}; throws `ValidationError` (400, `errors[].field` = `limit`,
 * `after` or the unknown field's name) on a `limit` outside 1–50, an empty or over-long `after`, or
 * an unknown field.
 */
export function validateListInstagramMediaQuery(query: unknown): ListInstagramMediaQueryInput {
  return parseWithSchema({ schema: ListInstagramMediaQueryDto, data: query });
}
