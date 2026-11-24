import type { MetaSignedRequestPayload } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-signature.js';
import type { ChannelConnectionProvider } from './channel-connection-state.js';

/** Input of the Meta callback service's two operations: the provider and the verified signed request (MC14). */
export interface MetaCallbackInput {
  /** The `{provider}` path segment — `meta` (MC14). */
  provider: ChannelConnectionProvider;
  /** What Meta signed — the `user_id` (an account id or a business id, MC15) and `issued_at`. */
  signedRequest: MetaSignedRequestPayload;
  /** The request id, carried into the team alert of an unmatched id (MC16). */
  requestId?: string | undefined;
}

/**
 * How Meta's signed id was matched (routes-final § 1 MC15, P56): an account's
 * `provider_account_id` first, else a connection's `client_business_id`; `none` when neither
 * matched (MC16 — answered all the same, and the team alerted).
 */
export type MetaCallbackMatchKind = 'provider_account' | 'provider_business' | 'none';

/**
 * One organization a Meta callback changed (MC15, MC16) — the controller writes one audit entry
 * per such organization, after the commit (D36).
 *
 * @remarks
 * Only organizations where something was left to do are listed: one whose rows were already revoked
 * and erased (a repeat of Meta's request, or its own delete, D54), or were connected after Meta signed
 * (D53), is not.
 */
export interface MetaCallbackOrganizationChange {
  /** The organization the resolver named. */
  organizationPublicId: string;
  /** `cha_…` of every channel account something changed on. */
  channelAccountPublicIds: string[];
  /**
   * On a business match, `chc_…` of every connection of that business revoked now (its token
   * deleted with it); empty on an account match.
   */
  revokedChannelConnectionPublicIds: string[];
  /** Stored posts erased (`0` on a deauthorize). */
  erasedPostCount: number;
}

/** What Meta's deauthorize callback did (route 16, MC15). */
export interface MetaDeauthorizeResult {
  /** How the signed id was matched. */
  matchKind: MetaCallbackMatchKind;
  /** The organizations changed — empty for an id never stored, a repeat, or a newer connection. */
  changes: MetaCallbackOrganizationChange[];
}

/**
 * Meta's data-deletion answer (routes-final § 1.6) — Meta's documented shape, outside the
 * `{ data, meta }` envelope.
 */
export interface MetaDataDeletionAnswerOutput {
  /** The frontend's status page with the code: `<FRONTEND_URL>/instagram/data-deletion?code=…`. */
  url: string;
  /** 21 characters `[a-z0-9]`. */
  confirmation_code: string;
}

/** What Meta's data-deletion callback did (route 17, MC16). */
export interface MetaDataDeletionResult extends MetaDeauthorizeResult {
  /** Meta's answer — the same code (and link) for the same signed request. */
  answer: MetaDataDeletionAnswerOutput;
}

/**
 * The team alert of a Meta callback whose signed id matched neither an account nor a business
 * (routes-final § 1 MC16): the team handles the deletion by hand.
 */
export interface MetaCallbackUnmatchedAlert {
  /** Which callback: `deauthorize` (route 16) or `data_deletion` (route 17). */
  callback: 'deauthorize' | 'data_deletion';
  /** The provider of the path (`meta`). */
  provider: ChannelConnectionProvider;
  /** The id Meta signed. */
  providerId: string;
  /** Route 17's confirmation code; absent on route 16. */
  confirmationCode?: string;
  /** The request id, for the log line and the team's lookup. */
  requestId?: string | undefined;
}

/**
 * The team-alert port of an unmatched Meta callback (MC16): the email to the team is sub-domain 6's
 * team-alert path (WC-57's team part, ROUTE row R53), which implements this port and is passed to
 * {@link ChannelConnectionMetaCallbackService} then. Until it is, the service's log line
 * (`app.channel_connection.meta_callback.unmatched`, error level) is the alert.
 */
export interface ChannelConnectionMetaCallbackTeamAlertPort {
  /**
   * Tells the team about one unmatched callback. Called after the answer is decided; a failure is
   * logged by the service and never fails Meta's request.
   */
  alertUnmatchedMetaCallback(alert: MetaCallbackUnmatchedAlert): Promise<void>;
}
