import { randomBytes } from 'node:crypto';

/** 21-char URL-safe core id length (NanoID-compatible) appended after the entity prefix. */
export const PUBLIC_ID_LENGTH = 21;

/**
 * Per-entity public-id prefixes (Paddle-style typed identifiers): every
 * externally visible id is `<prefix>_<21 chars of [a-z0-9]>`, e.g.
 * `org_4f9c2k7d1m3p5q8r2t0vx`. The prefix makes ids self-describing in logs,
 * docs, and support tickets, and lets validators reject an id of the wrong
 * entity before any lookup.
 */
export const PUBLIC_ID_PREFIXES = {
  user: 'usr',
  organization: 'org',
  membership: 'mem',
  membershipInvitation: 'inv',
  memberRole: 'rol',
  organizationApiKey: 'key',
  organizationNotificationPolicy: 'pol',
  authSession: 'ses',
  authMethod: 'am',
  webauthnCredential: 'wac',
  /** A browser a person trusted for 30 days after a right 2FA code (`auth.trusted_devices`, AT17). */
  trustedDevice: 'tdv',
  notification: 'ntf',
  webhook: 'whk',
  plan: 'pln',
  subscription: 'sub',
  upload: 'upl',
  userDataExport: 'exp',
  userBugReport: 'bug',
  webhookDeliveryAttempt: 'wda',
  /** The `id` of an outbound webhook event envelope, shared by every endpoint it is delivered to. */
  webhookEvent: 'evt',
  auditLog: 'aud',
  /**
   * One provider login of an organization for one business (`app.channel_connections`,
   * feat-instagram-dm-sending MC1; prefix chosen at kickoff, P22).
   */
  channelConnection: 'chc',
  /**
   * One connected inbox of an organization, whatever its channel (`app.channel_accounts`,
   * feat-instagram-dm-sending CA1; prefix chosen at kickoff, P22).
   */
  channelAccount: 'cha',
  /** One Instagram user who interacted with one of the organization's Instagram accounts (`app.contacts`, CT1). */
  contact: 'con',
  /** One stored event of a Meta webhook delivery (`app.instagram_webhook_events`, WH1). */
  instagramWebhookEvent: 'iwe',
  /** One automation of one of the organization's Instagram accounts (`app.automations`, AU1). */
  automation: 'aut',
  /** One automation flow for one contact (`app.automation_runs`, AU1) — carried in DM button payloads. */
  automationRun: 'run',
  /** One comment × automation log (`app.automation_comment_logs`, AU1) — unused until a read route (D13). */
  automationCommentLog: 'acl',
  /**
   * One Instagram account that had the 7-day trial, in any organization (`billing.trial_accounts`,
   * feat-instagram-dm-sending BL7; prefix chosen at kickoff, P22).
   */
  trialAccount: 'tra',
  /**
   * One message the sending engine sends or plans to send to a person (`app.instagram_messages`,
   * feat-instagram-dm-sending SN1; prefix chosen at kickoff, P22) — carried in fast tickets.
   */
  instagramMessage: 'igm',
} as const;

/** Entity keys of {@link PUBLIC_ID_PREFIXES}. */
export type PublicIdEntity = keyof typeof PUBLIC_ID_PREFIXES;

/** Union of the prefix strings themselves (`'usr' | 'org' | …`). */
export type PublicIdPrefix = (typeof PUBLIC_ID_PREFIXES)[PublicIdEntity];

/**
 * Matches any well-formed public id: a known-style lowercase prefix plus the
 * 21-char `[a-z0-9]` core (e.g. `org_a1b2c3d4e5f6g7h8i9j0k`). Used by the
 * tenant header check and generic param validation; entity-specific
 * validation should additionally pin the exact prefix.
 */
export const PUBLIC_ID_REGEX = /^[a-z]{2,5}_[a-z0-9]{21}$/;

/** Builds the strict per-entity pattern (e.g. `^org_[a-z0-9]{21}$`) for validators and docs. */
export function publicIdPatternFor(entity: PublicIdEntity): RegExp {
  return new RegExp(`^${PUBLIC_ID_PREFIXES[entity]}_[a-z0-9]{21}$`);
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ALPHABET_SIZE = ALPHABET.length; // 36

/**
 * Cryptographically random `[a-z0-9]` text of `length` characters — the public-id core, and a short
 * unique-ish suffix (an organization slug made from a taken name, `acme-x7k2p9`).
 *
 * @remarks
 * Rejection sampling removes modulo bias: floor(256 / 36) * 36 = 252, so bytes >= 252 are dropped.
 */
export function generateRandomLowercaseAlphanumeric(length: number): string {
  const maxByte = Math.floor(256 / ALPHABET_SIZE) * ALPHABET_SIZE; // 252
  const result: string[] = [];

  while (result.length < length) {
    const bytes = randomBytes(length - result.length + 4); // extra buffer
    for (const byte of bytes) {
      if (byte >= maxByte) continue; // reject biased bytes
      result.push(ALPHABET[byte % ALPHABET_SIZE]!);
      if (result.length === length) break;
    }
  }

  return result.join('');
}

/**
 * Generate a cryptographically secure, entity-prefixed public ID
 * (`<prefix>_<21 chars>`). Uses rejection sampling to eliminate modulo bias:
 * floor(256 / 36) * 36 = 252, so bytes >= 252 are rejected.
 */
export function generatePublicId(entity: PublicIdEntity): string {
  return `${PUBLIC_ID_PREFIXES[entity]}_${generateRandomLowercaseAlphanumeric(PUBLIC_ID_LENGTH)}`;
}

/**
 * Route path-param name → public-id entity. Single source for entity-strict
 * param validation, materialized test placeholders, and the per-param
 * OpenAPI documentation (description, `^pfx_[a-z0-9]{21}$` pattern, example).
 */
export const PARAM_NAME_TO_ENTITY = {
  user_id: 'user',
  membership_id: 'membership',
  membership_invitation_id: 'membershipInvitation',
  role_id: 'memberRole',
  api_key_id: 'organizationApiKey',
  notification_policy_id: 'organizationNotificationPolicy',
  session_id: 'authSession',
  mfa_method_id: 'authMethod',
  credential_id: 'webauthnCredential',
  notification_id: 'notification',
  webhook_id: 'webhook',
  plan_id: 'plan',
  subscription_id: 'subscription',
  upload_id: 'upload',
  data_export_id: 'userDataExport',
  auth_method_id: 'authMethod',
  contact_id: 'contact',
  automation_id: 'automation',
  channel_connection_id: 'channelConnection',
  channel_account_id: 'channelAccount',
} as const satisfies Record<string, PublicIdEntity>;

/** Deterministic placeholder id for an entity (valid shape, never a real row). */
export function publicIdPlaceholderFor(entity: PublicIdEntity): string {
  return `${PUBLIC_ID_PREFIXES[entity]}_${'0'.repeat(PUBLIC_ID_LENGTH)}`;
}
