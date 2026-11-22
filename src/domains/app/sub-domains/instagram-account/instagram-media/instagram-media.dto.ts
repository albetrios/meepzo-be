import { z } from 'zod';
import {
  INSTAGRAM_MEDIA_CURSOR_MAX_LENGTH,
  INSTAGRAM_MEDIA_PAGE_SIZE,
} from './instagram-media.constants.js';

/**
 * Query of `GET /app/social/instagram/media` and `GET /app/social/instagram/stories` (routes 5–6,
 * routes-final § 1.C.8): Instagram's own paging.
 *
 * @remarks
 * `limit` 1–50, default 25, passed on as Instagram's `limit`; `after` is Instagram's cursor from the
 * previous page's `meta.pagination.next`, 1–1000 characters, passed back untouched (never trimmed).
 * Strict: an unknown query field is a `400`.
 */
export const ListInstagramMediaQueryDto = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(INSTAGRAM_MEDIA_PAGE_SIZE.maximum)
      .default(INSTAGRAM_MEDIA_PAGE_SIZE.default),
    after: z.string().min(1).max(INSTAGRAM_MEDIA_CURSOR_MAX_LENGTH).optional(),
  })
  .strict();

/** The parsed query of {@link ListInstagramMediaQueryDto}. */
export type ListInstagramMediaQueryInput = z.infer<typeof ListInstagramMediaQueryDto>;
