import { describe, expect, it } from 'vitest';
import {
  isNewCommentPlace,
  nextSlowPickPlace,
  openingBoxMilliseconds,
  pickReplyLineNumber,
  planNextOpeningTurn,
  replyBoxMilliseconds,
  replyBoxOffsetMilliseconds,
} from '@/domains/app/sub-domains/instagram-sending/instagram-send-pace.util.js';

/** A seeded random in [0, 1) (a small linear congruential generator) for repeatable runs. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/**
 * The lanes' pace arithmetic (feat-instagram-dm-sending routes-final § 6.10 WC-5, WC-6; plan §11,
 * §28.2, §28.3, §29.3; ROUTE row R43 — AC-17.1, AC-17.7).
 */
describe('instagram send pace', () => {
  it('makes 600 an hour 6-second boxes, holds the limit to 700 and doubles a slowed box', () => {
    expect(openingBoxMilliseconds({ hourLimit: 600, isSlowed: false })).toBe(6_000);
    expect(openingBoxMilliseconds({ hourLimit: 600, isSlowed: true })).toBe(12_000);
    expect(openingBoxMilliseconds({ hourLimit: 5_000, isSlowed: false })).toBeCloseTo(
      3_600_000 / 700,
    );
    expect(openingBoxMilliseconds({ hourLimit: 150, isSlowed: false })).toBe(24_000);
  });

  it('over an hour at 600: one DM per box at a random second, never two in a box, at least 1.5 s apart, never over 600 (AC-17.1)', () => {
    const box = openingBoxMilliseconds({ hourLimit: 600, isSlowed: false });
    const start = Date.UTC(2026, 10, 25, 10, 0, 0);
    const random = seededRandom(7);
    let now = new Date(start);
    let lane = { boxStart: null as Date | null, pickCount: 0 };
    const sends: number[] = [];
    while (now.getTime() < start + 3_600_000) {
      sends.push(now.getTime());
      const next = planNextOpeningTurn({ ...lane, boxMilliseconds: box, now, random });
      lane = { boxStart: next.boxStart ?? null, pickCount: next.pickCount ?? 0 };
      now = next.nextRunAt;
    }
    const boxes = sends.map((at) => Math.floor((at - start) / box));
    expect(new Set(boxes).size).toBe(boxes.length);
    for (let index = 1; index < sends.length; index += 1) {
      expect(sends[index]! - sends[index - 1]!).toBeGreaterThanOrEqual(1_500);
    }
    expect(sends.length).toBeLessThanOrEqual(600);
    expect(sends.length).toBeGreaterThan(550);
  });

  it('starts a new box now after an idle lane: missed boxes are never sent together (plan §28.3 rule 3)', () => {
    const now = new Date(Date.UTC(2026, 10, 25, 10, 0, 0));
    const next = planNextOpeningTurn({
      boxStart: new Date(now.getTime() - 60_000),
      pickCount: 5,
      boxMilliseconds: 6_000,
      now,
      random: () => 0,
    });
    expect(next.boxStart!.getTime()).toBe(now.getTime() + 6_000);
    expect(next.nextRunAt.getTime()).toBe(now.getTime() + 6_000);
    expect(next.pickCount).toBe(1);
  });

  it('mixes 4 new : 1 old, and 3 : 2 while the oldest is urgent (plan §28.2 rule 3)', () => {
    const places = [0, 1, 2, 3, 4].map((count) => nextSlowPickPlace(count));
    expect(places).toEqual([1, 2, 3, 4, 5]);
    expect(places.map((place) => isNewCommentPlace({ place, isUrgent: false }))).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(places.map((place) => isNewCommentPlace({ place, isUrgent: true }))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('hashes a reply box second the same each time, inside the box; doubles a slowed reply box (plan §29.3)', () => {
    const boxStart = new Date(Date.UTC(2026, 10, 25, 10, 0, 0));
    const box = replyBoxMilliseconds({ hourLimit: 60, isSlowed: false });
    expect(box).toBe(60_000);
    expect(replyBoxMilliseconds({ hourLimit: 60, isSlowed: true })).toBe(120_000);
    const offset = replyBoxOffsetMilliseconds({ automationId: 42, boxStart, boxMilliseconds: box });
    expect(offset).toBe(
      replyBoxOffsetMilliseconds({ automationId: 42, boxStart, boxMilliseconds: box }),
    );
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(box);
  });

  it('never picks the last reply line again, and only the first without PRO (AC-17.7, D57)', () => {
    const random = seededRandom(3);
    for (let draw = 0; draw < 200; draw += 1) {
      expect(
        pickReplyLineNumber({ lineCount: 3, lastLineNumber: 2, isFirstLineOnly: false, random }),
      ).not.toBe(2);
    }
    expect(
      pickReplyLineNumber({ lineCount: 3, lastLineNumber: 1, isFirstLineOnly: true, random }),
    ).toBe(1);
    expect(
      pickReplyLineNumber({ lineCount: 1, lastLineNumber: 1, isFirstLineOnly: false, random }),
    ).toBe(1);
  });
});
