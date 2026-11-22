import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import type { MetaSignedRequestPayload } from '@/infrastructure/social/meta-signature.util.js';
import { readInstagramAppSecret } from '@/infrastructure/social/instagram.client.js';
import { getEnv } from '@/shared/config/env.config.js';
import { DEFAULT_FRONTEND_URL } from '@/shared/constants/index.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramAccountErasureService } from '@/domains/app/sub-domains/instagram-account/instagram-account-erasure.service.js';
import { deriveMetaDataDeletionConfirmationCode } from './instagram-account-meta-callback-confirmation-code.util.js';
import { serializeMetaDataDeletionAnswer } from './instagram-account-meta-callback.serializer.js';
import type {
  MetaCallbackInput,
  MetaCallbackOrganizationChange,
  MetaDataDeletionResult,
  MetaDeauthorizeResult,
} from './instagram-account-meta-callback.types.js';

/**
 * Meta's two callbacks for the connected account's owner (routes-final § 1.D): deauthorize — the
 * owner removed the app (route 7, IA19) — and data deletion — the owner asked for their data to be
 * deleted (route 8, IA20).
 *
 * @remarks
 * Algorithm:
 * - The caller is Meta, proved by the signed request the ingress plugin verified (IA18); no
 *   organization comes with it. The resolver (IA6) names every organization holding a row of the
 *   signed app-scoped id (IQ3), then each is changed inside its own `PRINCIPAL_SCOPE.VERIFIED`
 *   scope, one transaction per organization — no other organization's row is read
 *   (`verified-scope-usage.policy.unit.test.ts` ledgers this file).
 * - Deauthorize: in each organization, the disconnect of route 4 without the unsubscribe call
 *   (the app is already removed) — `revoked`, the token erased.
 * - Data deletion: the same, plus in the same transaction the profile erased and the account's
 *   stored posts deleted (IQ4) — revoked rows of the same id too. Contacts are not touched (D22).
 * - Both through {@link InstagramAccountErasureService.eraseForMeta}, the erase an organization's
 *   delete shares (D54). An account connected — or connected again — after Meta signed the request
 *   (`issued_at`) is left alone (D53): Meta retries a request it got no answer for, and the new
 *   connection was never part of it.
 *
 * Failure modes:
 * - `503 instagram_not_configured` when the app secret is unset (data deletion's code needs it;
 *   the ingress plugin answers it first on both routes). A database failure fails the request and
 *   Meta retries it — safe, as below.
 *
 * Side effects:
 * - Writes `app.instagram_accounts`, deletes `app.instagram_account_tokens` and
 *   `app.instagram_media` rows through the owners' services. No Instagram call. The audit entries
 *   are the controller's, after the commits (D36).
 *
 * Notes:
 * - Safe to repeat: a second call finds what the first changed already done, leaves a connection
 *   made since alone (D53), lists no change and still answers — data deletion with the same code. A
 *   person we never stored, or whose organization was deleted (its delete erased the account, D54),
 *   gets the same answer (1.D.10).
 * - No run is cancelled and automations stay `live` (IQ1, D24).
 */
export class InstagramAccountMetaCallbackService {
  constructor(
    private readonly accountService: InstagramAccountService,
    private readonly erasureService: InstagramAccountErasureService,
  ) {}

  /**
   * Meta's deauthorize (route 7, IA19): every organization holding the signed app-scoped id gets
   * its account — connected before Meta signed (D53) — revoked and its token erased.
   *
   * @remarks
   * Algorithm: the resolver, then per organization one transaction in its verified scope
   * ({@link InstagramAccountErasureService.eraseForMeta}). Failure modes: as the class lists. Side
   * effects: the revokes and token erases; returns only the organizations where something changed.
   */
  async deauthorize({ signedRequest }: MetaCallbackInput): Promise<MetaDeauthorizeResult> {
    const changes = await this.changeEveryOrganization({ signedRequest, shouldEraseData: false });
    return { changes };
  }

  /**
   * Meta's data deletion (route 8, IA20): as the deauthorize, plus each account's profile and
   * stored posts erased; returns Meta's answer — the confirmation code derived from the signed
   * request and the frontend's status page with it.
   *
   * @remarks
   * Algorithm: the code first (`503 instagram_not_configured` without an app secret, before any
   * write), then the resolver, then per organization one transaction in its verified scope — the
   * disconnect and profile erase, then the stored posts of each account; the answer's link is
   * `FRONTEND_URL` (or the local default) + `/instagram/data-deletion?code=…` (IQ2). Failure modes:
   * as the class lists. Side effects: the revokes, token, profile and post erases; returns only the
   * organizations where something changed, and the answer (the same for the same signed request).
   */
  async deleteData({ signedRequest }: MetaCallbackInput): Promise<MetaDataDeletionResult> {
    const confirmationCode = deriveMetaDataDeletionConfirmationCode({
      signedRequest,
      appSecret: readInstagramAppSecret(),
    });
    const changes = await this.changeEveryOrganization({ signedRequest, shouldEraseData: true });
    const answer = serializeMetaDataDeletionAnswer({
      confirmation_code: confirmationCode,
      frontend_url: getEnv().FRONTEND_URL ?? DEFAULT_FRONTEND_URL,
    });
    return { changes, answer };
  }

  /**
   * The resolver, then one transaction per organization it names, each in that organization's
   * verified scope; keeps the organizations where something changed.
   */
  private async changeEveryOrganization({
    signedRequest,
    shouldEraseData,
  }: {
    signedRequest: MetaSignedRequestPayload;
    shouldEraseData: boolean;
  }): Promise<MetaCallbackOrganizationChange[]> {
    const organizationPublicIds =
      await this.accountService.resolveOrganizationPublicIdsForInstagramAppUser(
        signedRequest.userId,
      );
    const changes: MetaCallbackOrganizationChange[] = [];
    for (const organizationPublicId of organizationPublicIds) {
      const erasure = await this.erasureService.eraseForMeta({
        // The organization was named by the SECURITY DEFINER resolver for the app-scoped id Meta
        // signed (IA6, IA18) — this flow proved it, so the scope is VERIFIED (ledgered).
        scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId }),
        instagramAppUserId: signedRequest.userId,
        issuedAt: signedRequest.issuedAt,
        shouldEraseData,
      });
      if (erasure !== null) changes.push({ organizationPublicId, ...erasure });
    }
    return changes;
  }
}
