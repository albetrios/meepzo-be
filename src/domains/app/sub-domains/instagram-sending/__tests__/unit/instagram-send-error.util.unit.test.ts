import { describe, expect, it } from 'vitest';
import { ExternalServiceError } from '@/infrastructure/outbound/outbound-error.js';
import {
  type MetaGraphApiError,
  readMetaGraphErrorResponse,
  toMetaGraphApiError,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import {
  classifyInstagramSendError,
  decideInstagramSendOutcome,
  ladderStep,
  stopDurationOf,
} from '@/domains/app/sub-domains/instagram-sending/instagram-send-error.util.js';
import { decideInARowStop } from '@/domains/app/sub-domains/instagram-sending/instagram-send-core.service.js';
import {
  INSTAGRAM_SEND_ERROR_CODE_GROUPS,
  INSTAGRAM_SEND_RESULT_GROUPS,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import { INSTAGRAM_PERSON_FINAL_ERRORS } from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.constants.js';

/** Meta's error answer for a code and subcode, as the client reads it. */
function metaError({
  code,
  subcode,
  httpStatus = 400,
}: {
  code: number;
  subcode?: number;
  httpStatus?: number;
}): MetaGraphApiError {
  return readMetaGraphErrorResponse({
    httpStatus,
    body: JSON.stringify({
      error: { code, ...(subcode === undefined ? {} : { error_subcode: subcode }) },
    }),
    retryAfterHeader: null,
  });
}

function groupOf(error: unknown, channel: 'direct' | 'comment_hide' | null = 'direct') {
  return classifyInstagramSendError({ error, channel }).group;
}

/**
 * The send core's error groups (feat-instagram-dm-sending routes-final § 6 SN5, SNC4; plan §33.1,
 * §33.3): every Meta code maps to exactly one group from the one constants table, and each group's
 * outcome — a stop never fails a DM, "no answer" is `unknown` (D17), a sure "not sent" gives the
 * counts back.
 */
describe('instagram send error groups (SNC4)', () => {
  it('names one group per code and subcode, every group a known result group', () => {
    const keys = INSTAGRAM_SEND_ERROR_CODE_GROUPS.map((entry) => `${entry.code}/${entry.subcode}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of INSTAGRAM_SEND_ERROR_CODE_GROUPS) {
      expect(INSTAGRAM_SEND_RESULT_GROUPS).toContain(entry.group);
    }
    // The retry summary's "final for her" list is read from the same table (P136 → R42).
    expect(INSTAGRAM_PERSON_FINAL_ERRORS).toHaveLength(7);
    expect(INSTAGRAM_PERSON_FINAL_ERRORS).toContainEqual({ code: 551, subcode: null });
    expect(INSTAGRAM_PERSON_FINAL_ERRORS).toContainEqual({ code: 10, subcode: 2_018_300 });
  });

  it.each([
    [{ code: 190, subcode: 463 }, 'login_expired'],
    [{ code: 368 }, 'blocked'],
    [{ code: 613, subcode: 2_018_338 }, 'blocked'],
    [{ code: 613 }, 'too_fast'],
    [{ code: 80_002 }, 'too_fast'],
    [{ code: 4, subcode: 1_390_008 }, 'account_flagged'],
    [{ code: 4 }, 'app_limit'],
    [{ code: 341 }, 'app_limit'],
    [{ code: 200, subcode: 2_534_041 }, 'access_off'],
    [{ code: 200, subcode: 2_018_028 }, 'app_not_approved'],
    [{ code: 10, subcode: 2_018_278 }, 'window_closed'],
    [{ code: 10, subcode: 2_534_022 }, 'window_closed'],
    [{ code: 551 }, 'person'],
    [{ code: 10, subcode: 2_018_300 }, 'other_app'],
    [{ code: 100, subcode: 33 }, 'comment_gone'],
    [{ code: 10, subcode: 1 }, 'wrong_permission'],
    [{ code: 230 }, 'wrong_permission'],
    [{ code: 100, subcode: 9 }, 'bad_text'],
    [{ code: 1 }, 'try_later'],
    [{ code: 999_999 }, 'try_later'],
  ] as const)('maps %o to %s', (codes, group) => {
    expect(groupOf(metaError(codes))).toBe(group);
  });

  it('reads the answers without a code: 429 too fast, 5xx try later, a cut call no answer, an open circuit never connected', () => {
    expect(groupOf(metaError({ code: 0, httpStatus: 429 }))).toBe('try_later');
    const tooMany = toMetaGraphApiError(
      new ExternalServiceError({ integration: 'meta-graph', category: 'http_4xx', status: 429 }),
    );
    expect(groupOf(tooMany)).toBe('too_fast');
    const serverError = toMetaGraphApiError(
      new ExternalServiceError({ integration: 'meta-graph', category: 'http_5xx', status: 502 }),
    );
    expect(groupOf(serverError)).toBe('try_later');
    const timeout = toMetaGraphApiError(
      new ExternalServiceError({ integration: 'meta-graph', category: 'timeout' }),
    );
    expect(groupOf(timeout)).toBe('no_answer');
    const open = toMetaGraphApiError(
      new ExternalServiceError({ integration: 'meta-graph', category: 'circuit_open' }),
    );
    expect(groupOf(open)).toBe('never_connected');
    const refused = toMetaGraphApiError(
      new ExternalServiceError({
        integration: 'meta-graph',
        category: 'network',
        cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
      }),
    );
    expect(groupOf(refused)).toBe('never_connected');
    expect(groupOf(new Error('our own failure'))).toBe('never_connected');
  });

  it('keeps a stop a stop, but a hide or a follow check refusal is its own group', () => {
    expect(groupOf(metaError({ code: 368 }), 'comment_hide')).toBe('blocked');
    expect(groupOf(metaError({ code: 100, subcode: 9 }), 'comment_hide')).toBe('hide_failed');
    // A hide of a comment that is gone is skipped, not failed (plan §33.7 rule 4, R43).
    expect(groupOf(metaError({ code: 100, subcode: 33 }), 'comment_hide')).toBe('comment_gone');
    expect(groupOf(metaError({ code: 100, subcode: 9 }), null)).toBe('check_not_possible');
  });

  const reading = (
    group: Parameters<typeof decideInstagramSendOutcome>[0]['reading']['group'],
  ) => ({
    group,
    httpStatus: null,
    errorCode: null,
    errorSubcode: null,
    retryAfterMilliseconds: null,
  });

  it('puts a stopped DM back with no try used and its counts given back (plan §33.2 rule 1)', () => {
    const outcome = decideInstagramSendOutcome({
      reading: reading('blocked'),
      lane: 'slow',
      messageType: 'opening_message',
      channel: 'private_reply',
      tries: 0,
    });
    expect(outcome).toMatchObject({ status: 'waiting', isTryUsed: false, isGivenBack: true });
    expect(outcome.stop).toMatchObject({ kind: 'lanes', reason: 'blocked', lanes: 'all' });
    const reply = decideInstagramSendOutcome({
      reading: reading('blocked'),
      lane: 'reply',
      messageType: 'public_reply',
      channel: 'comment_reply',
      tries: 0,
    });
    expect(reply.stop).toMatchObject({ lanes: ['reply'] });
  });

  it("holds the broadcast lane with a slow or fast too fast, and doubles Meta's time on a broadcast (plan §30.14 rule 3, R45)", () => {
    const tooFast = ({
      lane,
      retryAfterMilliseconds,
    }: {
      lane: 'slow' | 'fast' | 'reply' | 'broadcast';
      retryAfterMilliseconds: number;
    }) =>
      decideInstagramSendOutcome({
        reading: { ...reading('too_fast'), retryAfterMilliseconds },
        lane,
        messageType: lane === 'broadcast' ? 'broadcast' : 'message',
        channel: 'direct',
        tries: 0,
      }).stop;
    expect(tooFast({ lane: 'slow', retryAfterMilliseconds: 0 })).toMatchObject({
      lanes: ['slow', 'broadcast'],
    });
    expect(tooFast({ lane: 'fast', retryAfterMilliseconds: 0 })).toMatchObject({
      lanes: ['fast', 'broadcast'],
    });
    expect(tooFast({ lane: 'reply', retryAfterMilliseconds: 0 })).toMatchObject({
      lanes: ['reply'],
    });
    const broadcast = tooFast({ lane: 'broadcast', retryAfterMilliseconds: 0 });
    expect(broadcast).toMatchObject({ lanes: ['broadcast'] });
    // Meta's time beyond the ladder: as it is on the slow lane, twice on the broadcast lane.
    const slowStop = tooFast({ lane: 'slow', retryAfterMilliseconds: 40 * 60_000 });
    const broadcastStop = tooFast({ lane: 'broadcast', retryAfterMilliseconds: 40 * 60_000 });
    if (slowStop?.kind !== 'lanes' || broadcastStop?.kind !== 'lanes') {
      throw new Error('expected lane stops');
    }
    expect(slowStop.durationMilliseconds?.(0)).toBe(40 * 60_000);
    expect(broadcastStop.durationMilliseconds?.(0)).toBe(80 * 60_000);
  });

  it('never sends an unclear result again: no answer is unknown (D17), a sure "not sent" waits again', () => {
    expect(
      decideInstagramSendOutcome({
        reading: reading('no_answer'),
        lane: 'fast',
        messageType: 'message',
        channel: 'direct',
        tries: 0,
      }),
    ).toMatchObject({ status: 'unknown', isGivenBack: false });
    expect(
      decideInstagramSendOutcome({
        reading: reading('never_connected'),
        lane: 'fast',
        messageType: 'message',
        channel: 'direct',
        tries: 0,
      }),
    ).toMatchObject({
      status: 'waiting',
      isTryUsed: false,
      isGivenBack: true,
      notBeforeDelayMilliseconds: 5000,
    });
  });

  it('tries a follow check twice — a time-out too — the second try after 2–5 s, then "following" (AC-17.14, plan §30.9)', () => {
    const timeout = toMetaGraphApiError(
      new ExternalServiceError({ integration: 'meta-graph', category: 'timeout' }),
    );
    // A follow check sends her nothing: a time-out is a failed try, never `unknown` (rule 6).
    expect(groupOf(timeout, null)).toBe('check_not_possible');
    expect(groupOf(metaError({ code: 368 }), null)).toBe('blocked');
    const first = decideInstagramSendOutcome({
      reading: reading('check_not_possible'),
      lane: 'fast',
      messageType: 'follow_check',
      channel: null,
      tries: 0,
    });
    expect(first).toMatchObject({ status: 'waiting', isTryUsed: true, isGivenBack: true });
    expect(first.notBeforeDelayMilliseconds).toBeGreaterThanOrEqual(2_000);
    expect(first.notBeforeDelayMilliseconds).toBeLessThanOrEqual(5_000);
    expect(
      decideInstagramSendOutcome({
        reading: reading('check_not_possible'),
        lane: 'fast',
        messageType: 'follow_check',
        channel: null,
        tries: 1,
      }),
    ).toMatchObject({ status: 'sent', reason: 'assumed_following' });
  });

  it('tries an opening private reply later 3 times, then fails it; other DMs are unknown', () => {
    const tryLater = (tries: number, messageType = 'opening_message') =>
      decideInstagramSendOutcome({
        reading: reading('try_later'),
        lane: 'slow',
        messageType,
        channel: 'private_reply',
        tries,
      });
    expect(tryLater(0)).toMatchObject({
      status: 'waiting',
      isTryUsed: true,
      notBeforeDelayMilliseconds: 60_000,
    });
    expect(tryLater(2)).toMatchObject({ status: 'waiting', notBeforeDelayMilliseconds: 900_000 });
    expect(tryLater(3)).toMatchObject({ status: 'failed', reason: 'tries_used_up' });
    expect(tryLater(0, 'message')).toMatchObject({ status: 'unknown' });
  });

  it('uploads a refused file 3 times, then fails it, never counted', () => {
    const attachment = (tries: number) =>
      decideInstagramSendOutcome({
        reading: reading('attachment'),
        lane: 'fast',
        messageType: 'message',
        channel: 'direct',
        tries,
      });
    expect(attachment(0)).toMatchObject({ status: 'waiting', isTryUsed: true });
    expect(attachment(2)).toMatchObject({
      status: 'failed',
      reason: 'attachment_failed',
      isGivenBack: true,
    });
  });

  it('ends person and window refusals as skipped, permission and text as failed', () => {
    const settle = (group: Parameters<typeof reading>[0]) =>
      decideInstagramSendOutcome({
        reading: reading(group),
        lane: 'fast',
        messageType: 'message',
        channel: 'direct',
        tries: 0,
      });
    expect(settle('person')).toMatchObject({ status: 'skipped', reason: 'person_error' });
    expect(settle('window_closed')).toMatchObject({ status: 'skipped', reason: 'window_closed' });
    expect(settle('wrong_permission')).toMatchObject({
      status: 'failed',
      reason: 'wrong_permission',
    });
    expect(settle('bad_text')).toMatchObject({ status: 'failed', reason: 'bad_text' });
    expect(settle('live_ended')).toMatchObject({ status: 'expired', reason: 'live_ended' });
  });

  it('times the stops by their ladders (6.A.10)', () => {
    expect(ladderStep({ ladder: [15, 30], stopCount: 9 })).toBe(30);
    expect(stopDurationOf({ reason: 'too_fast', stopCount: 0, lane: 'slow' })).toBe(15 * 60_000);
    expect(stopDurationOf({ reason: 'too_fast', stopCount: 0, lane: 'broadcast' })).toBe(
      30 * 60_000,
    );
    expect(stopDurationOf({ reason: 'blocked', stopCount: 1, lane: 'slow' })).toBe(48 * 3_600_000);
    expect(stopDurationOf({ reason: 'instagram_down', stopCount: 3, lane: 'slow' })).toBe(
      40 * 60_000,
    );
    expect(stopDurationOf({ reason: 'login_expired', stopCount: 0, lane: 'slow' })).toBeNull();
  });

  it('stops every lane after 3 unclear results in a row, or wrong permission for 3 different people', () => {
    const result = (resultGroup: string, contactId: number, countGroup = 'fast') => ({
      resultGroup,
      contactId,
      countGroup,
    });
    expect(
      decideInARowStop({
        group: 'no_answer',
        lastResults: [result('no_answer', 1), result('try_later', 2), result('no_answer', 3)],
      }),
    ).toMatchObject({ kind: 'lanes', reason: 'instagram_down', lanes: 'all' });
    expect(
      decideInARowStop({
        group: 'no_answer',
        lastResults: [result('no_answer', 1), result('sent', 2), result('no_answer', 3)],
      }),
    ).toBeNull();
    expect(
      decideInARowStop({
        group: 'wrong_permission',
        lastResults: [
          result('wrong_permission', 1),
          result('wrong_permission', 2, 'none'),
          result('wrong_permission', 2),
          result('wrong_permission', 3),
        ],
      }),
    ).toMatchObject({ reason: 'wrong_permission', durationMilliseconds: null });
    expect(
      decideInARowStop({
        group: 'wrong_permission',
        lastResults: [
          result('wrong_permission', 1),
          result('wrong_permission', 1),
          result('wrong_permission', 3),
        ],
      }),
    ).toBeNull();
  });
});
