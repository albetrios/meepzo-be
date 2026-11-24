/**
 * Value lists every record table shares (launch-2026-09-30-jxmr): the chip tones, the weekdays and
 * the soft-delete reasons. Each is the single source for the schema CHECKs and the validators.
 *
 * @remarks
 * - **Algorithm:** each object literal is the authority; the derived `*_VALUES` arrays build the
 *   CHECK constraints, so adding a value is one edit here plus a migration that replaces the CHECKs.
 * - **Failure modes:** a value outside a list violates the table's CHECK (Postgres `23514`).
 * - **Notes:** the lowercase machine values are the launch drop's (`schema-routes.md` › Enum tone,
 *   weekday, delete_reason), which meepzo-fe already sends — except the lavender tone, written in
 *   full as `lavender` since feat-instagram-dm-sending (P81; migration
 *   `20261124062834_tenancy_chip_tone_lavender.sql` rewrote the stored `lav`).
 */
export const CHIP_TONE = {
  BUTTER: 'butter',
  LAVENDER: 'lavender',
  SKY: 'sky',
  SAGE: 'sage',
  BLUSH: 'blush',
  MINT: 'mint',
  PEACH: 'peach',
  PLUM: 'plum',
  LIME: 'lime',
  SLATE: 'slate',
  STONE: 'stone',
} as const;

/** Literal union of {@link CHIP_TONE} values. */
export type ChipTone = (typeof CHIP_TONE)[keyof typeof CHIP_TONE];

/** All chip tones, used to derive the `chk_<table>_tone` constraints. */
export const CHIP_TONE_VALUES = Object.values(CHIP_TONE) as ChipTone[];

/** Days of the week as the drop writes them (`working_days` lists). */
export const WEEKDAY = {
  MONDAY: 'mon',
  TUESDAY: 'tue',
  WEDNESDAY: 'wed',
  THURSDAY: 'thu',
  FRIDAY: 'fri',
  SATURDAY: 'sat',
  SUNDAY: 'sun',
} as const;

/** Literal union of {@link WEEKDAY} values. */
export type Weekday = (typeof WEEKDAY)[keyof typeof WEEKDAY];

/** All weekdays, Monday first, used to derive the `chk_<table>_working_days_allowed` constraints. */
export const WEEKDAY_VALUES = Object.values(WEEKDAY) as Weekday[];
/** The default working days: Monday to Saturday. */
export const DEFAULT_WORKING_DAYS: readonly Weekday[] = [
  WEEKDAY.MONDAY,
  WEEKDAY.TUESDAY,
  WEEKDAY.WEDNESDAY,
  WEEKDAY.THURSDAY,
  WEEKDAY.FRIDAY,
  WEEKDAY.SATURDAY,
];
/** A phone number: `+91` and ten digits (`chk_<table>_phone`). */
export const PHONE_NUMBER_PATTERN = '^\\+91\\d{10}$';
/**
 * A phone number from anywhere: an optional leading `+`, then 10–15 digits, stored normalised —
 * spaces, dashes, dots and brackets dropped (`chk_contacts_phone`). The India-only
 * {@link PHONE_NUMBER_PATTERN} stays for team members; an Instagram contact may live in any
 * country (routes-final § 2, CT10).
 */
export const INTERNATIONAL_PHONE_NUMBER_PATTERN = '^\\+?[0-9]{10,15}$';
/** The longest short text a record field holds — a `varchar(255)` name, an email, a tag. */
export const RECORD_SHORT_TEXT_MAX_LENGTH = 255;

/** Why an record was soft-deleted (the confirm drawer's choices). */
export const RECORD_DELETE_REASON = {
  MISTAKE: 'mistake',
  DUPLICATE: 'duplicate',
  NOT_NEEDED: 'not_needed',
  OTHER: 'other',
} as const;

/** Literal union of {@link RECORD_DELETE_REASON} values. */
export type RecordDeleteReason = (typeof RECORD_DELETE_REASON)[keyof typeof RECORD_DELETE_REASON];

/** All delete reasons, used to derive the `chk_<table>_delete_reason` constraints. */
export const RECORD_DELETE_REASON_VALUES = Object.values(
  RECORD_DELETE_REASON,
) as RecordDeleteReason[];

/** Longest note a soft delete may carry (required when the reason is `other`). */
export const RECORD_DELETE_NOTE_MAX_LENGTH = 280;

/**
 * The longest short text a record carries — a label, a file or display name.
 */
export const RECORD_SHORT_TEXT_MAX = 120;
