import { z } from 'zod';

/**
 * Query of `GET /app/social/instagram/account` (route 2, routes-final § 1.A.8):
 * none — strict, so an unknown parameter is a `400`. The launch's connect body left with route 1
 * (feat-instagram-dm-sending RC-6); ROUTE row R5 moves both routes under
 * `/social/channel-accounts/{channel_account_id}` (CA2).
 */
export const InstagramAccountQueryDto = z.object({}).strict();
