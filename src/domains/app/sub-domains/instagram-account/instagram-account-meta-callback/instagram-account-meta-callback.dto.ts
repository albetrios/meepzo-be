import { z } from 'zod';

/**
 * Body of Meta's deauthorize and data-deletion callbacks (routes 7–8, routes-final § 1.D.8): the
 * one form field Meta posts, `signed_request` = `<signature>.<payload>` (both base64url).
 *
 * @remarks
 * Posted `application/x-www-form-urlencoded`. The signed request is checked by the ingress plugin
 * before this schema runs (`preValidation`), so a missing or bad one answers
 * `400 instagram_signed_request_invalid`, never a field error. Not strict: the body is Meta's own
 * shape, and a field Meta adds later must not turn a verified request into a `400` (Meta would
 * retry it forever).
 */
export const MetaSignedRequestDto = z.object({
  signed_request: z.string().min(1).meta({
    description:
      'Set by Meta: `<signature>.<payload>`, both base64url — the HMAC-SHA256 of the payload with the Instagram app secret, and a JSON payload with `algorithm` (`HMAC-SHA256`), `issued_at` and `user_id` (the app-scoped id).',
    example:
      'aW49tm4qivgbua-FvTvgWmy4lR65zMoF8kOA8Dkv8AQ.eyJhbGdvcml0aG0iOiJITUFDLVNIQTI1NiIsImlzc3VlZF9hdCI6MTc2Mzc0MDAwMCwidXNlcl9pZCI6IjE3ODQxNDAwMDAwMDAwMDAxIn0',
  }),
});

/** The parsed body of {@link MetaSignedRequestDto}. */
export type MetaSignedRequestInput = z.infer<typeof MetaSignedRequestDto>;
