import type { SupportedLanguage } from '@/shared/constants/i18n.constants.js';

/**
 * Membership notices for people (feat-instagram-dm-sending UN8, UNC6) — emitted by
 * `MembershipService` inside the write's organization context when a live member's main role
 * changes or a manager removes a member, and turned into the `membership.role_changed` /
 * `membership.removed` notifications by the notify domain.
 *
 * @remarks
 * Separate from the webhook resource events (`MEMBERSHIP_EVENT`), whose payload is the public
 * membership JSON delivered to an organization's endpoints: the previous main role and the
 * recipients are for the notification only. Recipients are resolved by tenancy, as the invitation
 * notices are — the `membership:update` holders and the member, minus whoever made the change.
 */
export const MEMBERSHIP_NOTICE_EVENT = {
  ROLE_CHANGED: 'tenancy.membership.role_changed',
  REMOVED: 'tenancy.membership.removed',
} as const;

/** Union of literal event codes defined by {@link MEMBERSHIP_NOTICE_EVENT}. */
export type MembershipNoticeEventType =
  (typeof MEMBERSHIP_NOTICE_EVENT)[keyof typeof MEMBERSHIP_NOTICE_EVENT];

/** Payload common to both {@link MEMBERSHIP_NOTICE_EVENT} notices. */
export interface MembershipNoticePayload {
  /** Internal user ids to notify. */
  recipient_user_ids: number[];
  /** Internal id of the organization (the notification's `organization_id`). */
  organization_id: number;
  /** Display name of the organization, for the notification copy. */
  organization_name: string;
  /** The membership's public id (`mem_…`). */
  membership_public_id: string;
  /** The name the organization keeps for the member (K3), for the copy. */
  member_name: string;
  /** The organization's default language, which the notification is written in. */
  locale: SupportedLanguage;
  /** The notification's once key (UN11): one notice per change. */
  dedupe_key: string;
}

/** Payload of {@link MEMBERSHIP_NOTICE_EVENT.ROLE_CHANGED}: the main role before and after. */
export interface MembershipRoleChangedPayload extends MembershipNoticePayload {
  role_name: string;
  previous_role_name: string;
}

/** Payload of {@link MEMBERSHIP_NOTICE_EVENT.REMOVED}. */
export type MembershipRemovedPayload = MembershipNoticePayload;
