import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import {
  createSegmentBodyDto,
  listSegmentsQueryDto,
  segmentAudienceCountBodyDto,
  updateSegmentBodyDto,
} from './broadcast-segment.dto.js';
import type {
  SegmentAudienceCountInput,
  SegmentCreateInput,
  SegmentListQuery,
  SegmentUpdateInput,
} from './broadcast-segment.types.js';

/**
 * Parses route 77's query (7.B.8) with the strict {@link listSegmentsQueryDto}.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`, `errors[].field` the parameter) on a missing or malformed
 * `channel_account_id`, a bad `sort`, `order`, `limit` or `q`, or an unknown parameter.
 */
export function validateListSegmentsQuery(data: unknown): SegmentListQuery {
  const parsed = parseWithSchema({ schema: listSegmentsQueryDto, data });
  return {
    channelAccountPublicId: parsed.channel_account_id,
    q: parsed.q,
    sort: parsed.sort,
    order: parsed.order,
    limit: parsed.limit,
    after: parsed.after,
  };
}

/**
 * Parses route 78's body (BC12) with the strict {@link createSegmentBodyDto}.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on a malformed `channel_account_id`, a name empty or
 * over 255 after trim, conditions that are not the tree of BC12 (an unknown field or key, over 2
 * levels, over 20 conditions, a malformed id) or an unknown field.
 */
export function validateCreateSegmentBody(data: unknown): SegmentCreateInput {
  const parsed = parseWithSchema({ schema: createSegmentBodyDto, data });
  return {
    channelAccountPublicId: parsed.channel_account_id,
    name: parsed.name,
    conditions: parsed.conditions,
  };
}

/**
 * Parses route 80's body (BC15) with the strict {@link updateSegmentBodyDto}.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on an empty body, a bad name or conditions, a malformed
 * `expected_updated_at` or an unknown field.
 */
export function validateUpdateSegmentBody(data: unknown): SegmentUpdateInput {
  const parsed = parseWithSchema({ schema: updateSegmentBodyDto, data });
  return {
    name: parsed.name,
    conditions: parsed.conditions,
    expectedUpdatedAt: parsed.expected_updated_at,
  };
}

/**
 * Parses route 82's body (BC14) with the strict {@link segmentAudienceCountBodyDto}.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on a malformed `channel_account_id` or `segment_id`,
 * neither or both of `segment_id` and `conditions`, bad conditions or an unknown field.
 */
export function validateSegmentAudienceCountBody(data: unknown): SegmentAudienceCountInput {
  const parsed = parseWithSchema({ schema: segmentAudienceCountBodyDto, data });
  return {
    channelAccountPublicId: parsed.channel_account_id,
    segmentPublicId: parsed.segment_id,
    conditions: parsed.conditions,
  };
}
