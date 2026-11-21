import { z } from 'zod';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';

/** Longest authorization code a connect accepts (routes-final § 1.A.8). */
const INSTAGRAM_AUTHORIZATION_CODE_MAX_LENGTH = 2000;

/**
 * Body of `POST /app/social/instagram/connect` (route 1, routes-final § 1.A.8): the authorization
 * code Instagram sent to the frontend's `/auth/instagram/callback`.
 *
 * @remarks
 * `code` is 1–2000 characters, trimmed; a trailing `#_` stays — the Instagram client strips it
 * (IA12). Strict: an unknown field is a `400`.
 */
export const ConnectInstagramAccountDto = z
  .object({
    code: trimmedStringMinMax({ min: 1, max: INSTAGRAM_AUTHORIZATION_CODE_MAX_LENGTH }),
  })
  .strict();

/** The parsed body of {@link ConnectInstagramAccountDto}. */
export type ConnectInstagramAccountInput = z.infer<typeof ConnectInstagramAccountDto>;
