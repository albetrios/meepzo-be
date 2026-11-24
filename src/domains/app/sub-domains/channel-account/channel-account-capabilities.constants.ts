import type { PlanFeatureKey } from '@/domains/billing/sub-domains/plan/plan.constants.js';
import type { ChannelAccountChannel } from './channel-account.constants.js';

/**
 * The per-channel capability list and the feature catalogue the one feature check reads
 * (feat-instagram-dm-sending routes-final § 1B CA11, P48, P50, P83).
 *
 * @remarks
 * Code constants (P4): a later channel adds its entry to {@link CHANNEL_CAPABILITIES} and nothing
 * else changes. Each feature of {@link CHANNEL_FEATURES} reads exactly one plan switch of billing's
 * `PLAN_FEATURE_KEYS` (P83) — a unit test pins that the two sets agree; a new feature key is a new
 * billing migration (P103).
 */

/** The features an automation, a broadcast or a setting may use (CA11) — one plan switch each (P83). */
export const CHANNEL_FEATURE_KEYS = [
  'email_ask',
  'phone_ask',
  'reply_like_person',
  'multiple_public_reply_lines',
  'message_versions',
  'broadcasts',
  'segments',
  'past_comments',
  'extra_delay',
  'starter_questions',
  'mark_seen',
] as const;

/** One value of {@link CHANNEL_FEATURE_KEYS}. */
export type ChannelFeature = (typeof CHANNEL_FEATURE_KEYS)[number];

/** What one channel can do (CA11 (1)). */
export interface ChannelCapability {
  /** Its ways to start an automation (`trigger_type`, AU8). */
  readonly triggerTypes: readonly string[];
  /** Its automation steps. */
  readonly steps: readonly string[];
  /** Its message kinds. */
  readonly messageKinds: readonly string[];
  /** The features of {@link CHANNEL_FEATURE_KEYS} it supports. */
  readonly features: readonly ChannelFeature[];
}

/** One entry per channel — `instagram` the only one now (D27). */
export const CHANNEL_CAPABILITIES: Readonly<Record<ChannelAccountChannel, ChannelCapability>> = {
  instagram: {
    triggerTypes: [
      'comment',
      'live_comment',
      'story_reply',
      'story_mention',
      'story_repost',
      'dm_keyword',
      'first_message',
      'shared_post',
      'starter_question',
      'ref_link',
      'default_reply',
      'ad_comment',
      'ad_message',
      'tag_added',
      'tag_removed',
    ],
    steps: [
      'hello',
      'follow',
      'email',
      'phone',
      'messages',
      'tags',
      'public_reply',
      'hide_comment',
    ],
    messageKinds: ['text', 'image', 'cards', 'quick_replies', 'audio', 'file', 'post'],
    features: CHANNEL_FEATURE_KEYS,
  },
};

/** What one feature needs (CA11 (1)). */
export interface ChannelFeatureRequirement {
  /** The connection permission it needs, or `null` when the connect's own permissions suffice. */
  readonly permission: string | null;
  /** The plan switch it reads (P83) — one of billing's `PLAN_FEATURE_KEYS`. */
  readonly planSwitch: PlanFeatureKey;
  /** Whether Meta's test must have passed first (P36) — checked against the sending settings file's `APP_UNTESTED_META_FEATURES` (P36). */
  readonly isMetaTestRequired: boolean;
}

/** Each feature's requirements (CA11 (1)); the PRO switches are off on Free (D35, D57). */
export const CHANNEL_FEATURES: Readonly<Record<ChannelFeature, ChannelFeatureRequirement>> = {
  email_ask: {
    permission: 'instagram_manage_messages',
    planSwitch: 'email_ask',
    isMetaTestRequired: false,
  },
  phone_ask: {
    permission: 'instagram_manage_messages',
    planSwitch: 'phone_ask',
    isMetaTestRequired: false,
  },
  reply_like_person: {
    permission: 'instagram_manage_comments',
    planSwitch: 'reply_like_person',
    isMetaTestRequired: false,
  },
  multiple_public_reply_lines: {
    permission: 'instagram_manage_comments',
    planSwitch: 'multiple_public_reply_lines',
    isMetaTestRequired: false,
  },
  message_versions: {
    permission: 'instagram_manage_messages',
    planSwitch: 'message_versions',
    isMetaTestRequired: false,
  },
  broadcasts: {
    permission: 'instagram_manage_messages',
    planSwitch: 'broadcasts',
    isMetaTestRequired: false,
  },
  segments: { permission: null, planSwitch: 'segments', isMetaTestRequired: false },
  past_comments: {
    permission: 'instagram_manage_comments',
    planSwitch: 'past_comments',
    isMetaTestRequired: false,
  },
  extra_delay: { permission: null, planSwitch: 'extra_delay', isMetaTestRequired: false },
  starter_questions: {
    permission: 'instagram_manage_messages',
    planSwitch: 'starter_questions',
    isMetaTestRequired: false,
  },
  mark_seen: {
    permission: 'instagram_manage_messages',
    planSwitch: 'mark_seen',
    isMetaTestRequired: true,
  },
};

/** The four reasons the one feature check refuses with, in its order (CA11 (2), P61). */
export const CHANNEL_FEATURE_REFUSAL_REASONS = [
  'channel_lacks_feature',
  'permission_not_granted',
  'plan_lacks_feature',
  'feature_not_offered',
] as const;

/** One value of {@link CHANNEL_FEATURE_REFUSAL_REASONS}. */
export type ChannelFeatureRefusalReason = (typeof CHANNEL_FEATURE_REFUSAL_REASONS)[number];
