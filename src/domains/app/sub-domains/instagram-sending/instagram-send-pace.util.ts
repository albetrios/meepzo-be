import { createHash } from 'node:crypto';
import { MILLISECONDS_PER_HOUR } from '@/shared/constants/ttl.constants.js';
import {
  OPENING_HOUR_LIMIT_MAX,
  REPLY_LANE_SETTINGS,
  SLOW_LANE_SETTINGS,
} from './instagram-sending.constants.js';
import type { InstagramSendNextTurn } from './instagram-sending.types.js';

/** A random number in `[0, 1)` (tests pass a fixed one). */
export type InstagramPaceRandom = () => number;

/**
 * One opening box (plan §28.3 rule 1): 3600 ÷ the hour limit seconds, the limit held to
 * `OPENING_HOUR_LIMIT_MAX`, twice as long at half speed or at Meta's 80 % (SN23).
 *
 * @remarks
 * Pure.
 */
export function openingBoxMilliseconds({
  hourLimit,
  isSlowed,
}: {
  hourLimit: number;
  /** Half speed after a passed test, or the connection at Meta's 80 %. */
  isSlowed: boolean;
}): number {
  const limit = Math.min(Math.max(hourLimit, 1), OPENING_HOUR_LIMIT_MAX);
  const box = MILLISECONDS_PER_HOUR / limit;
  return isSlowed ? box * SLOW_LANE_SETTINGS.halfSpeedFactor : box;
}

/**
 * The slow lane's next turn after an opening DM went (plan §28.3, WC-5): the box this send fell in
 * is the lane's `box_start` while that box still runs, else a new one starting now; the next box
 * follows it, and the next turn is a random millisecond inside it, at least
 * `SLOW_LANE_SETTINGS.minimumGapMilliseconds` after this send. Missed boxes are never sent together.
 *
 * @remarks
 * Pure. The answer's `boxStart` and `lastSentAt` are written in the release's commit, and
 * `pickCount` is the mix place this turn used ({@link nextSlowPickPlace}).
 */
export function planNextOpeningTurn({
  boxStart,
  pickCount,
  boxMilliseconds,
  now,
  random,
}: {
  /** The lane's `box_start` before this send. */
  boxStart: Date | null;
  /** The lane's `pick_count` before this send. */
  pickCount: number;
  boxMilliseconds: number;
  now: Date;
  random: InstagramPaceRandom;
}): InstagramSendNextTurn {
  const current =
    boxStart !== null && boxStart.getTime() + boxMilliseconds > now.getTime()
      ? boxStart.getTime()
      : now.getTime();
  const nextBoxStart = current + boxMilliseconds;
  const randomSecond = nextBoxStart + Math.floor(random() * boxMilliseconds);
  return {
    nextRunAt: new Date(
      Math.max(randomSecond, now.getTime() + SLOW_LANE_SETTINGS.minimumGapMilliseconds),
    ),
    boxStart: new Date(nextBoxStart),
    lastSentAt: now,
    pickCount: nextSlowPickPlace(pickCount),
  };
}

/**
 * The mix place of the slow lane's next pick (plan §28.2 rule 3): 1 to 5, round and round.
 *
 * @remarks
 * Pure.
 */
export function nextSlowPickPlace(pickCount: number): number {
  return (pickCount % SLOW_LANE_SETTINGS.mixPlaces) + 1;
}

/**
 * Whether a mix place takes a new comment (plan §28.2 rule 3): places 1–4 of 5 (4 : 1), only 1–3
 * (3 : 2) while the oldest waiting comment has under `urgentHoursLeft` hours left.
 *
 * @remarks
 * Pure.
 */
export function isNewCommentPlace({
  place,
  isUrgent,
}: {
  place: number;
  isUrgent: boolean;
}): boolean {
  return (
    place <= (isUrgent ? SLOW_LANE_SETTINGS.newPlacesUrgent : SLOW_LANE_SETTINGS.newPlacesNormal)
  );
}

/**
 * The milliseconds into an automation's reply box its one reply goes (plan §29.3 rule 2): a hash of
 * the automation and the box start, so a lost ticket finds the same second and no column keeps it.
 *
 * @remarks
 * Pure.
 */
export function replyBoxOffsetMilliseconds({
  automationId,
  boxStart,
  boxMilliseconds,
}: {
  automationId: number;
  boxStart: Date;
  boxMilliseconds: number;
}): number {
  const digest = createHash('sha256').update(`${automationId}:${boxStart.getTime()}`).digest();
  return digest.readUIntBE(0, 6) % Math.max(Math.floor(boxMilliseconds), 1);
}

/**
 * One "Reply like a person" box (plan §29.3 rule 1): 3600 ÷ the automation's hour limit seconds,
 * twice as long at Meta's 80 % (rule 5) or at half speed (§33.4).
 *
 * @remarks
 * Pure.
 */
export function replyBoxMilliseconds({
  hourLimit,
  isSlowed,
}: {
  hourLimit: number;
  isSlowed: boolean;
}): number {
  const box = MILLISECONDS_PER_HOUR / Math.max(hourLimit, 1);
  return isSlowed ? box * REPLY_LANE_SETTINGS.usageSlowFactor : box;
}

/**
 * The reply line a public reply uses (plan §29.2 rule 7, D57): one of the automation's lines at
 * random, never its last one when it has two or more; only the first on a plan without PRO.
 * Answers the line's number (1-based).
 *
 * @remarks
 * Pure.
 */
export function pickReplyLineNumber({
  lineCount,
  lastLineNumber,
  isFirstLineOnly,
  random,
}: {
  lineCount: number;
  lastLineNumber: number | null;
  isFirstLineOnly: boolean;
  random: InstagramPaceRandom;
}): number {
  if (isFirstLineOnly || lineCount <= 1) return 1;
  const choices: number[] = [];
  for (let number = 1; number <= lineCount; number += 1) {
    if (number !== lastLineNumber) choices.push(number);
  }
  return choices[Math.floor(random() * choices.length)] ?? 1;
}
