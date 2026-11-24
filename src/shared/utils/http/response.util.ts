/** Paddle-style: single resource. Include meta.request_id (e.g. request.id). */
export function successResponse<T>({
  data,
  request_id,
  extraMeta = {},
}: {
  data: T;
  request_id: string;
  /** Extra `meta` fields beside `request_id` (e.g. the ad picker's `ad_access`). */
  extraMeta?: Readonly<Record<string, unknown>> | undefined;
}) {
  return {
    data,
    meta: { ...extraMeta, request_id },
  };
}

/** Paddle-style: list with pagination. next_url optional (cursor or page-based). */
export function paginatedResponse<T>({
  data,
  request_id,
  pagination,
  extraMeta = {},
}: {
  data: T[];
  request_id: string;
  pagination: {
    per_page: number;
    next: string | null;
    has_more: boolean;
    estimated_total?: number;
  };
  /** Extra `meta` fields a list carries beside its page (e.g. a count the room shows). */
  extraMeta?: Readonly<Record<string, unknown>> | undefined;
}) {
  return {
    data,
    meta: {
      ...extraMeta,
      request_id,
      pagination,
    },
  };
}
