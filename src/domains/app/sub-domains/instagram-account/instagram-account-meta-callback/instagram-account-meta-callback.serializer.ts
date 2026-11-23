import { withoutTrailingSlashes } from '@/shared/utils/text/trailing-slash.util.js';
import { INSTAGRAM_DATA_DELETION_FRONTEND_PATH } from './instagram-account-meta-callback.constants.js';
import type { MetaDataDeletionAnswerOutput } from './instagram-account-meta-callback.types.js';

/**
 * Meta's data-deletion answer (route 8, routes-final § 1.D.6, IA20): the frontend's status page
 * with the code, and the code — Meta's documented shape, sent outside the `{ data, meta }`
 * envelope.
 *
 * @remarks
 * - **Algorithm:** `frontend_url` without a trailing slash + `/instagram/data-deletion` + the code
 *   as the `code` query parameter (IQ2: no status route — the frontend's page shows the code).
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 */
export function serializeMetaDataDeletionAnswer({
  confirmation_code,
  frontend_url,
}: {
  confirmation_code: string;
  frontend_url: string;
}): MetaDataDeletionAnswerOutput {
  const query = new URLSearchParams({ code: confirmation_code }).toString();
  return {
    url: `${withoutTrailingSlashes(frontend_url)}${INSTAGRAM_DATA_DELETION_FRONTEND_PATH}?${query}`,
    confirmation_code,
  };
}
