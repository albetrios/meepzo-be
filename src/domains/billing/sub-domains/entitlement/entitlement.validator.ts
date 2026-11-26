import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import {
  type ListEntitlementOverridesQueryInput,
  type SetEntitlementOverrideInput,
  SetEntitlementOverrideDto,
  listEntitlementOverridesQueryDto,
} from './entitlement.dto.js';

/**
 * Parses the admin set's body against {@link SetEntitlementOverrideDto} (P270), throwing
 * `ValidationError` with field-level details — `value` of the wrong type or out of the limit's
 * bounds, `expires_at` not in the future.
 */
export function validateSetEntitlementOverride(data: unknown): SetEntitlementOverrideInput {
  return parseWithSchema({ schema: SetEntitlementOverrideDto, data });
}

/** Parses the admin list's query against {@link listEntitlementOverridesQueryDto} (P270). */
export function validateListEntitlementOverridesQuery(
  data: unknown,
): ListEntitlementOverridesQueryInput {
  return parseWithSchema({ schema: listEntitlementOverridesQueryDto, data });
}
