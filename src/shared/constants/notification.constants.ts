/**
 * Canonical notification delivery channels.
 *
 * Single source of truth for the values enforced by the `chk_org_notif_channel`
 * and `chk_user_notif_prefs_channel` database check constraints. DTOs validate
 * against this list so an invalid channel is rejected as a 422 at the edge,
 * rather than slipping through to the database and surfacing the check
 * violation as an opaque 500.
 */
export const NOTIFICATION_CHANNELS = ['EMAIL', 'SMS', 'WEB_PUSH', 'IN_APP'] as const;

/** A delivery channel accepted by notification preference / policy endpoints. */
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Canonical notification-type vocabulary — a single source of truth shared by the surfaces that
 * key notifications: user notification preferences, organization notification policies, and the
 * emitted in-app notifications (via the bulk seeder today; the live dispatch path when wired).
 *
 * Types are namespaced `domain.event`. DTOs validate `notification_type` against this list so an
 * unknown type is rejected as a 422 at the edge (mirroring `NOTIFICATION_CHANNELS`), keeping the
 * three surfaces on one vocabulary — a prerequisite for a preference to ever gate a delivery.
 */
export const NOTIFICATION_TYPES = [
  'system.welcome',
  'system.maintenance',
  'security.alert',
  'billing.usage_threshold',
  'billing.payment_succeeded',
  'billing.payment_failed',
  'membership.invite_accepted',
  'membership.invite_declined',
  'subscription.updated',
  'webhook.delivery_failed',
  // The organization's Instagram account must be connected again (launch IA9, D10).
  'instagram.reconnect_required',
  // feat-instagram-dm-sending UN8 (P80): the nine types of the seven kinds below — 20 in all.
  'automation.stopped',
  'contact.details_left',
  'membership.role_changed',
  'membership.removed',
  'report.weekly_summary',
  'broadcast.done',
  'automation.backfill_done',
  'billing.trial_ending',
  'billing.plan_choice_required',
] as const;

/** A notification type accepted by notification preference / policy endpoints. */
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * The channels a person chooses per notification kind (feat-instagram-dm-sending UN10): email,
 * in-app and push. `SMS` stays in {@link NOTIFICATION_CHANNELS} for the organization policies but
 * is not offered here. Push is saved, never sent yet (plan §49).
 */
export const NOTIFICATION_PREFERENCE_CHANNELS = ['EMAIL', 'IN_APP', 'WEB_PUSH'] as const;

/** A channel of {@link NOTIFICATION_PREFERENCE_CHANNELS}. */
export type NotificationPreferenceChannel = (typeof NOTIFICATION_PREFERENCE_CHANNELS)[number];

/**
 * Who a kind's notifications go to (feat-instagram-dm-sending UN2) — decided by permission codes,
 * never by role names. The resolver over the membership service is `resolveNotificationRecipients`
 * (notify's `notification-dispatch.service.ts`).
 */
export const NOTIFICATION_RECIPIENTS_RULE = {
  /** Active members holding `automation:update` (Owner, Admin, Editor). */
  AUTOMATION_EDITORS: 'automation_editors',
  /** Holders of `membership:update` (Owner, Admin), plus the member the change is about. */
  MEMBERSHIP_MANAGERS_AND_MEMBER: 'membership_managers_and_member',
  /** Holders of `subscription:manage` (Owner, Admin). */
  BILLING_MANAGERS: 'billing_managers',
  /** Every active member. */
  EVERY_MEMBER: 'every_member',
  /** Whoever started the run or the broadcast, plus the `subscription:manage` holders. */
  STARTER_AND_BILLING_MANAGERS: 'starter_and_billing_managers',
} as const;

/** A value of {@link NOTIFICATION_RECIPIENTS_RULE}. */
export type NotificationRecipientsRule =
  (typeof NOTIFICATION_RECIPIENTS_RULE)[keyof typeof NOTIFICATION_RECIPIENTS_RULE];

/** One kind of {@link NOTIFICATION_KINDS}: its types, recipients, defaults and locked channels. */
export interface NotificationKindDefinition {
  kind: string;
  types: readonly NotificationType[];
  recipientsRule: NotificationRecipientsRule;
  /** The value a channel has while the person never chose one (no stored row). */
  defaults: Readonly<Record<NotificationPreferenceChannel, boolean>>;
  /** Channels always on: sent whatever a stored row says, and refused when set off (`422`). */
  lockedChannels: readonly NotificationPreferenceChannel[];
}

/**
 * The seven notification kinds a person switches per channel, in the settings screen's order
 * (feat-instagram-dm-sending UN9, D54, P87). Each type belongs to at most one kind; a type in no
 * kind (`system.*`, `security.alert`, `webhook.delivery_failed`) is not in the grid and always sent.
 * Preferences are stored one row per type of the kind (`auth.user_notification_preferences`).
 */
export const NOTIFICATION_KINDS = [
  {
    kind: 'automation_problem',
    types: ['automation.stopped', 'instagram.reconnect_required'],
    recipientsRule: NOTIFICATION_RECIPIENTS_RULE.AUTOMATION_EDITORS,
    defaults: { EMAIL: true, IN_APP: true, WEB_PUSH: false },
    lockedChannels: [],
  },
  {
    kind: 'direct_message_limit',
    types: ['billing.usage_threshold'],
    recipientsRule: NOTIFICATION_RECIPIENTS_RULE.AUTOMATION_EDITORS,
    defaults: { EMAIL: true, IN_APP: true, WEB_PUSH: false },
    lockedChannels: [],
  },
  {
    kind: 'contact_details_left',
    types: ['contact.details_left'],
    recipientsRule: NOTIFICATION_RECIPIENTS_RULE.AUTOMATION_EDITORS,
    defaults: { EMAIL: false, IN_APP: true, WEB_PUSH: false },
    lockedChannels: [],
  },
  {
    kind: 'team_change',
    types: [
      'membership.invite_accepted',
      'membership.invite_declined',
      'membership.role_changed',
      'membership.removed',
    ],
    recipientsRule: NOTIFICATION_RECIPIENTS_RULE.MEMBERSHIP_MANAGERS_AND_MEMBER,
    defaults: { EMAIL: true, IN_APP: true, WEB_PUSH: false },
    lockedChannels: [],
  },
  {
    kind: 'billing',
    types: [
      'billing.payment_failed',
      'billing.payment_succeeded',
      'subscription.updated',
      'billing.trial_ending',
      'billing.plan_choice_required',
    ],
    recipientsRule: NOTIFICATION_RECIPIENTS_RULE.BILLING_MANAGERS,
    defaults: { EMAIL: true, IN_APP: true, WEB_PUSH: false },
    lockedChannels: ['EMAIL'],
  },
  {
    kind: 'weekly_summary',
    types: ['report.weekly_summary'],
    recipientsRule: NOTIFICATION_RECIPIENTS_RULE.EVERY_MEMBER,
    defaults: { EMAIL: true, IN_APP: false, WEB_PUSH: false },
    lockedChannels: [],
  },
  {
    kind: 'broadcast_or_past_comments_done',
    types: ['broadcast.done', 'automation.backfill_done'],
    recipientsRule: NOTIFICATION_RECIPIENTS_RULE.STARTER_AND_BILLING_MANAGERS,
    defaults: { EMAIL: false, IN_APP: true, WEB_PUSH: false },
    lockedChannels: [],
  },
] as const satisfies readonly NotificationKindDefinition[];

/** A kind name of {@link NOTIFICATION_KINDS}. */
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]['kind'];

/** Every kind name of {@link NOTIFICATION_KINDS}, in the screen's order (the DTO's enum). */
export const NOTIFICATION_KIND_NAMES = NOTIFICATION_KINDS.map(
  (definition) => definition.kind,
) as unknown as readonly [NotificationKind, ...NotificationKind[]];

/** The kind a notification type belongs to, or `undefined` for a type outside the grid. */
export function findNotificationKindForType(type: string): NotificationKindDefinition | undefined {
  return NOTIFICATION_KINDS.find((definition) =>
    (definition.types as readonly string[]).includes(type),
  );
}

/**
 * The effective value of one kind × channel for one person (feat-instagram-dm-sending UN10, UN11).
 *
 * @remarks
 * A locked channel is always on. Otherwise the person's stored rows for the kind's types decide —
 * all of them must be on (they are written together; a stray `false` from an older per-type write
 * keeps the channel off) — and with no stored row the kind's default applies. Both the
 * preferences read and the check before each send use this one rule.
 */
export function resolveNotificationKindChannel({
  definition,
  channel,
  storedValues,
}: {
  definition: NotificationKindDefinition;
  channel: NotificationPreferenceChannel;
  storedValues: readonly boolean[];
}): { isEnabled: boolean; isDefault: boolean; isLocked: boolean } {
  if (definition.lockedChannels.includes(channel)) {
    return { isEnabled: true, isDefault: storedValues.length === 0, isLocked: true };
  }
  if (storedValues.length === 0) {
    return { isEnabled: definition.defaults[channel], isDefault: true, isLocked: false };
  }
  return { isEnabled: storedValues.every(Boolean), isDefault: false, isLocked: false };
}

/**
 * Maximum rows a single `markAllReadForUser` UPDATE touches before looping
 * (audit #39). Bounds the lock footprint and the RETURNING id set so a user with
 * a very large unread backlog cannot turn "mark all read" into one unbounded,
 * long-held write that blocks concurrent notification inserts for that user.
 */
export const NOTIFICATION_MARK_ALL_READ_BATCH_SIZE = 1000;
