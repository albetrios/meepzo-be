import type { MetaSignedRequestPayload } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-signature.js';
import type { InstagramAccountErasure } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';

/** Input of the Meta callback service's two operations: the verified signed request (IA18). */
export interface MetaCallbackInput {
  /** What Meta signed — the app-scoped `user_id` (IQ3) and `issued_at`. */
  signedRequest: MetaSignedRequestPayload;
}

/**
 * One organization a Meta callback changed (IA19, IA20) — the controller writes one audit entry
 * per such organization, after the commit (D36).
 *
 * @remarks
 * Only organizations where something was left to do are listed: one whose rows were already revoked
 * and erased (a repeat of Meta's request, or its own delete, D54), or were connected after Meta signed
 * (D53), is not.
 */
export interface MetaCallbackOrganizationChange extends InstagramAccountErasure {
  /** The organization the resolver named (IA6). */
  organizationPublicId: string;
}

/** What Meta's deauthorize callback did (route 7, IA19). */
export interface MetaDeauthorizeResult {
  /** The organizations changed — empty for a person we never stored, a repeat, or a newer connection. */
  changes: MetaCallbackOrganizationChange[];
}

/**
 * Meta's data-deletion answer (routes-final § 1.D.6) — Meta's documented shape, outside the
 * `{ data, meta }` envelope.
 */
export interface MetaDataDeletionAnswerOutput {
  /** The frontend's status page with the code: `<FRONTEND_URL>/instagram/data-deletion?code=…`. */
  url: string;
  /** 21 characters `[a-z0-9]`. */
  confirmation_code: string;
}

/** What Meta's data-deletion callback did (route 8, IA20). */
export interface MetaDataDeletionResult {
  /** The organizations changed — empty for a person we never stored, a repeat, or a newer connection. */
  changes: MetaCallbackOrganizationChange[];
  /** Meta's answer — the same code (and link) for the same signed request (IA20). */
  answer: MetaDataDeletionAnswerOutput;
}
