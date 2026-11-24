import { INTERNATIONAL_PHONE_NUMBER_PATTERN } from '@/shared/constants/record-fields.constants.js';
import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import { queryInstantRange } from '@/shared/utils/validation/record-fields.util.js';
import {
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_EMAIL_PATTERN,
  CONTACT_TAG_LIST_MAX_COUNT,
  CONTACT_TAG_MAX_LENGTH,
  CONTACT_TAGS_MAX_COUNT,
} from './contact.constants.js';
import {
  contactBulkActionBodyDto,
  listContactTagsQueryDto,
  listContactsQueryDto,
  updateContactBodyDto,
} from './contact.dto.js';
import type {
  ContactBulkActionFilter,
  ContactBulkActionInput,
  ContactListQuery,
  ContactUpdateInput,
} from './contact.types.js';

/** {@link CONTACT_EMAIL_PATTERN}, compiled once. */
const CONTACT_EMAIL = new RegExp(CONTACT_EMAIL_PATTERN);

/** The separators a typed phone number may carry: spaces, dashes, dots and brackets (CT10). */
const PHONE_NUMBER_SEPARATORS = /[\s\-.()[\]]/g;

/** {@link INTERNATIONAL_PHONE_NUMBER_PATTERN}, compiled once. */
const INTERNATIONAL_PHONE_NUMBER = new RegExp(INTERNATIONAL_PHONE_NUMBER_PATTERN);

/** `true` / `false` query text as a boolean; absent stays `undefined`. */
function readQueryFlag(value: 'true' | 'false' | undefined): boolean | undefined {
  return value === undefined ? undefined : value === 'true';
}

/** The filter part of route 18's query and route 21's `filter`, as parsed. */
interface ParsedContactFilter {
  q?: string | undefined;
  tags?: string | undefined;
  has_email?: 'true' | 'false' | undefined;
  has_phone?: 'true' | 'false' | undefined;
  is_following_account?: 'true' | 'false' | undefined;
  is_opted_out?: 'true' | 'false' | undefined;
  is_automations_paused?: 'true' | 'false' | undefined;
  came_in_via?: string | undefined;
  first_automation_id?: string | undefined;
  first_seen_from?: string | undefined;
  first_seen_to?: string | undefined;
  automation_id?: string | undefined;
}

/** A comma-separated list, each entry trimmed, repeats dropped; absent → empty. */
function splitList(value: string | undefined): string[] {
  return value === undefined ? [] : [...new Set(value.split(',').map((entry) => entry.trim()))];
}

/** The parsed filters as the service reads them (CT12): lists split, flags as booleans, dates. */
function readContactFilter(parsed: ParsedContactFilter): ContactBulkActionFilter {
  const firstSeen = queryInstantRange({ from: parsed.first_seen_from, to: parsed.first_seen_to });
  return {
    q: parsed.q,
    tags: splitList(parsed.tags),
    hasEmail: readQueryFlag(parsed.has_email),
    hasPhone: readQueryFlag(parsed.has_phone),
    isFollowingAccount: readQueryFlag(parsed.is_following_account),
    firstSeenFrom: firstSeen.from,
    firstSeenTo: firstSeen.to,
    automationPublicId: parsed.automation_id,
    isOptedOut: readQueryFlag(parsed.is_opted_out),
    isAutomationsPaused: readQueryFlag(parsed.is_automations_paused),
    cameInVia: splitList(parsed.came_in_via),
    firstAutomationPublicId: parsed.first_automation_id,
  };
}

/**
 * Parses the `GET /app/contacts` query (route 18) with the strict {@link listContactsQueryDto} and
 * reads it into the service's {@link ContactListQuery}.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`, `errors[].field` the parameter) on a missing or malformed
 * `channel_account_id`, a `q` under 3 characters, a bad value, more than ten tags, an unknown way to
 * start, `first_seen_from` not before `first_seen_to`, a malformed id or an unknown parameter.
 */
export function validateListContactsQuery(data: unknown): ContactListQuery {
  const parsed = parseWithSchema({ schema: listContactsQueryDto, data });
  return {
    limit: parsed.limit,
    after: parsed.after,
    sort: parsed.sort,
    order: parsed.order,
    channelAccountPublicId: parsed.channel_account_id,
    ...readContactFilter(parsed),
  };
}

/**
 * Parses route 20's body (CT5) with the strict {@link updateContactBodyDto}: the note (`null`
 * clears), the tags to add and remove (normalised, repeats dropped), the pause and the optional
 * `expected_updated_at`.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on an empty body, a note over 2,000 characters, more than
 * 20 tags, a tag over 50 characters, a tag in both lists or an unknown field.
 */
export function validateUpdateContactBody(data: unknown): ContactUpdateInput {
  const parsed = parseWithSchema({ schema: updateContactBodyDto, data });
  return {
    note: parsed.note,
    addTags: [...new Set(parsed.add_tags ?? [])],
    removeTags: [...new Set(parsed.remove_tags ?? [])],
    isAutomationsPaused: parsed.is_automations_paused,
    expectedUpdatedAt:
      parsed.expected_updated_at === undefined ? undefined : new Date(parsed.expected_updated_at),
  };
}

/**
 * Parses route 21's body (CT7, P66) with the strict {@link contactBulkActionBodyDto}.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on both or neither of `contact_ids` and `filter`, more
 * than 500 ids, a repeated id, a tag on a pause action or none on a tag action, a bad filter or an
 * unknown field.
 */
export function validateContactBulkActionBody(data: unknown): ContactBulkActionInput {
  const parsed = parseWithSchema({ schema: contactBulkActionBodyDto, data });
  return {
    channelAccountPublicId: parsed.channel_account_id,
    action: parsed.action,
    tag: parsed.tag ?? null,
    contactPublicIds: parsed.contact_ids ?? null,
    filter: parsed.filter === undefined ? null : readContactFilter(parsed.filter),
  };
}

/**
 * Parses route 22's query (CT8): the account and the page size (default and most 1,000).
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on a missing or malformed `channel_account_id`, a `limit`
 * out of 1–1,000 or an unknown parameter.
 */
export function validateListContactTagsQuery(data: unknown): {
  channelAccountPublicId: string;
  limit: number;
} {
  const parsed = parseWithSchema({ schema: listContactTagsQueryDto, data });
  return {
    channelAccountPublicId: parsed.channel_account_id,
    limit: parsed.limit ?? CONTACT_TAG_LIST_MAX_COUNT,
  };
}

/**
 * A typed email as a contact stores it (CT9): trimmed, lower case, at most 254 characters and the
 * strict shape `chk_contacts_email` holds — plus addresses accepted (P19) — or `null` when it is not
 * one (the email step asks again).
 */
export function normalizeContactEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized.length <= CONTACT_EMAIL_MAX_LENGTH && CONTACT_EMAIL.test(normalized)
    ? normalized
    : null;
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
 * One tag as a contact stores it (CT9): a comma turned into a space, trimmed, cut to 50 characters;
 * `null` when nothing is left.
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
