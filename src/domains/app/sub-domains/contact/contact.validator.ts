import { INTERNATIONAL_PHONE_NUMBER_PATTERN } from '@/shared/constants/record-fields.constants.js';
import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import { queryInstantRange } from '@/shared/utils/validation/record-fields.util.js';
import { trimmedEmail } from '@/shared/utils/validation/validation.util.js';
import { CONTACT_TAG_MAX_LENGTH, CONTACT_TAGS_MAX_COUNT } from './contact.constants.js';
import { listContactsQueryDto } from './contact.dto.js';
import type { ContactListQuery } from './contact.types.js';

/** The separators a typed phone number may carry: spaces, dashes, dots and brackets (CT10). */
const PHONE_NUMBER_SEPARATORS = /[\s\-.()[\]]/g;

/** {@link INTERNATIONAL_PHONE_NUMBER_PATTERN}, compiled once. */
const INTERNATIONAL_PHONE_NUMBER = new RegExp(INTERNATIONAL_PHONE_NUMBER_PATTERN);

/** `true` / `false` query text as a boolean; absent stays `undefined`. */
function readQueryFlag(value: 'true' | 'false' | undefined): boolean | undefined {
  return value === undefined ? undefined : value === 'true';
}

/**
 * Parses the `GET /app/contacts` query (route 9) with the strict {@link listContactsQueryDto} and
 * reads it into the service's {@link ContactListQuery}: the tags split and trimmed, the flags as
 * booleans, the first-seen range as dates.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`, `errors[].field` the parameter) on a bad value, more
 * than ten tags, `first_seen_from` not before `first_seen_to`, a malformed `instagram_account_id`
 * or `automation_id`, or an unknown parameter.
 */
export function validateListContactsQuery(data: unknown): ContactListQuery {
  const parsed = parseWithSchema({ schema: listContactsQueryDto, data });
  const firstSeen = queryInstantRange({ from: parsed.first_seen_from, to: parsed.first_seen_to });
  return {
    limit: parsed.limit,
    after: parsed.after,
    q: parsed.q,
    sort: parsed.sort,
    order: parsed.order,
    tags:
      parsed.tags === undefined
        ? []
        : [...new Set(parsed.tags.split(',').map((tag) => tag.trim()))],
    hasEmail: readQueryFlag(parsed.has_email),
    hasPhone: readQueryFlag(parsed.has_phone),
    isFollowingAccount: readQueryFlag(parsed.is_following_account),
    firstSeenFrom: firstSeen.from,
    firstSeenTo: firstSeen.to,
    instagramAccountPublicId: parsed.instagram_account_id,
    automationPublicId: parsed.automation_id,
  };
}

/**
 * A typed email as a contact stores it (CT10) — `trimmedEmail()` as is: trimmed, lower case, an
 * email's shape, no Gmail plus address — or `null` when it is not one (the email step asks again).
 */
export function normalizeContactEmail(value: string): string | null {
  const parsed = trimmedEmail().safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A typed phone number as a contact stores it (CT10): spaces, dashes, dots and brackets dropped, a
 * leading `+` kept, then an optional `+` and 10–15 digits
 * ({@link INTERNATIONAL_PHONE_NUMBER_PATTERN}); `null` when it is not one (the phone step keeps
 * waiting).
 */
export function normalizeContactPhone(value: string): string | null {
  const normalized = value.trim().replace(PHONE_NUMBER_SEPARATORS, '');
  return INTERNATIONAL_PHONE_NUMBER.test(normalized) ? normalized : null;
}

/**
 * One tag as a contact stores it (CT10): a comma turned into a space, trimmed, cut to 255
 * characters; `null` when nothing is left.
 */
export function normalizeContactTag(value: string): string | null {
  const normalized = value.replaceAll(',', ' ').trim().slice(0, CONTACT_TAG_MAX_LENGTH).trim();
  return normalized === '' ? null : normalized;
}

/**
 * The tags a contact holds after a run adds `newTags` (CT10, `addContactTags`): the tags it held,
 * then each new one it does not hold yet, in order, up to 50; past 50 a new tag is dropped.
 *
 * @remarks
 * - **Algorithm:** each new tag through {@link normalizeContactTag}; an empty one and a repeat are
 *   skipped; the rest are appended while fewer than {@link CONTACT_TAGS_MAX_COUNT} are held.
 * - **Failure modes:** none — never throws, so a run never fails on its tags.
 * - **Side effects:** none; the caller logs `droppedTags`.
 */
export function mergeContactTags({
  heldTags,
  newTags,
}: {
  heldTags: readonly string[];
  newTags: readonly string[];
}): { tags: string[]; addedTags: string[]; droppedTags: string[] } {
  const tags = [...heldTags];
  const held = new Set(heldTags);
  const addedTags: string[] = [];
  const droppedTags: string[] = [];
  for (const newTag of newTags) {
    const tag = normalizeContactTag(newTag);
    if (tag === null || held.has(tag)) continue;
    held.add(tag);
    if (tags.length >= CONTACT_TAGS_MAX_COUNT) {
      droppedTags.push(tag);
      continue;
    }
    tags.push(tag);
    addedTags.push(tag);
  }
  return { tags, addedTags, droppedTags };
}
