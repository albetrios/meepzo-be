import type { FastifyInstance } from 'fastify';
import { expect, vi } from 'vitest';
import { MILLISECONDS_PER_HOUR } from '@/shared/constants/ttl.constants.js';
import { AutomationRepository } from '@/domains/app/sub-domains/automation/automation.repository.js';
import {
  type AutomationFixtureRow,
  automationPath,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { nextInstagramObjectId } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { InstagramCommentFlow } from './instagram-comment-flow.helper.js';

/** The keyword every "next post" automation of the flow answers, unless the test names others. */
export const NEXT_POST_KEYWORD = 'guide';

/** The window of a "next post" automation, unless the test says otherwise: 2 hours ago to tomorrow. */
export const DEFAULT_WINDOW = { startHours: -2, endHours: 24 };

/** A point a test opens once something else has happened. */
export function createGate(): { opened: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Resolves once a session of this test's database waits for a lock another session holds. */
export async function untilASessionWaitsForALock(): Promise<void> {
  await vi.waitFor(
    async () => {
      const rows = await operatorQuery<Array<{ blocked: number }>>`
        SELECT count(*)::int AS blocked FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
      expect(rows[0]?.blocked).toBeGreaterThan(0);
    },
    { timeout: 5000, interval: 25 },
  );
}

/**
 * Runs `callback` as the worker process does (`MEEPZO_BE_RUNTIME=worker`): a query outside a
 * database context throws there. A link that fails is only logged, so the flow runs this way too —
 * else a link that fails in the worker alone would pass unseen.
 */
export async function inWorkerProcess<Result>(callback: () => Promise<Result>): Promise<Result> {
  vi.stubEnv('MEEPZO_BE_RUNTIME', 'worker');
  try {
    return await callback();
  } finally {
    vi.unstubAllEnvs();
  }
}

/** How many in-app notifications and emails exist, whoever they are for. */
export async function countToldPeople(): Promise<number> {
  const rows = await operatorQuery<Array<{ told: number }>>`
    SELECT ((SELECT count(*) FROM notify.notifications)
      + (SELECT count(*) FROM auth.mail_outbox))::int AS told`;
  return rows[0]?.told ?? 0;
}

/** Makes the next link fail inside its unit of work, as a real failure would. */
export function failNextLink(failure: 'refused_by_the_database' | 'after_the_rows_changed'): void {
  const linkNextPost = AutomationRepository.prototype.linkNextPost;
  vi.spyOn(AutomationRepository.prototype, 'linkNextPost').mockImplementationOnce(
    async function failLink(this: AutomationRepository, input) {
      if (failure === 'refused_by_the_database') {
        // Longer than the column: Postgres refuses the statement and the transaction is aborted.
        return linkNextPost.call(this, {
          ...input,
          instagramMediaId: '0'.repeat(65),
        });
      }
      await linkNextPost.call(this, input);
      throw new Error('the link broke after its rows were changed');
    },
  );
}

/**
 * One team's "next post" flow over the real app, on top of the comment flow (its team, account,
 * automations, signed deliveries, account job and fake Instagram): waiting automations made through
 * route 28's shape (written directly, R13), posts published at a chosen time, and the team's own
 * reads of what happened. A "next post" waits from its go-live (its window's start here) with no end
 * date (P12) — nothing expires.
 */
export class InstagramNextPostFlow {
  /** The moment every window and publish time of the test is counted from. */
  readonly now = new Date();

  private constructor(
    private readonly app: FastifyInstance,
    /** The comment flow underneath. */
    readonly comments: InstagramCommentFlow,
  ) {}

  /** A fresh team with its Instagram account connected. Needs the permission catalog seeded. */
  static async open(app: FastifyInstance): Promise<InstagramNextPostFlow> {
    return new InstagramNextPostFlow(app, await InstagramCommentFlow.open(app));
  }

  /** The moment this many hours after (negative: before) the flow's `now`. */
  hoursFromNow(hours: number): Date {
    return new Date(this.now.getTime() + hours * MILLISECONDS_PER_HOUR);
  }

  /** Publishes a new post on the account at this moment; its Instagram media id. */
  publishPost(publishedAt: Date): string {
    const postId = nextInstagramObjectId();
    this.comments.instagram.publishedAtByPost.set(postId, publishedAt);
    return postId;
  }

  /** The window's start (the go-live time now — P12 drops the end) as the launch fields name it. */
  windowBody({ startHours, endHours }: typeof DEFAULT_WINDOW): Record<string, unknown> {
    return {
      next_post_starts_at: this.hoursFromNow(startHours).toISOString(),
      next_post_ends_at: this.hoursFromNow(endHours).toISOString(),
    };
  }

  /** A live "next post" automation that waits from its window's start; any field may be overridden. */
  async createNextPostAutomation({
    name,
    window = DEFAULT_WINDOW,
    ...body
  }: {
    name: string;
    window?: typeof DEFAULT_WINDOW;
  } & Record<string, unknown>): Promise<AutomationFixtureRow> {
    const automation = await this.comments.createFinalMessageAutomation({
      name,
      keywords: [NEXT_POST_KEYWORD],
      target_scope: 'next',
      ...this.windowBody(window),
      ...body,
    });
    expect(automation).toMatchObject({
      next_post_status: 'waiting',
      target_instagram_media_id: null,
      next_post_linked_at: null,
    });
    return automation;
  }

  /** The automation's row as it is now. */
  async rowOf(automation: AutomationFixtureRow): Promise<AutomationFixtureRow> {
    return this.comments.readAutomation(automation.public_id);
  }

  /** Expects the automation to wait for its post still, with no post, no run and no comment log. */
  async expectStillWaiting(automation: AutomationFixtureRow): Promise<void> {
    expect(await this.rowOf(automation)).toMatchObject({
      next_post_status: 'waiting',
      target_instagram_media_id: null,
      next_post_linked_at: null,
      last_triggered_at: null,
    });
    await this.expectNeverAnswered(automation);
  }

  /** Expects the automation to be linked to the post. */
  async expectLinkedTo({
    automation,
    postId,
  }: {
    automation: AutomationFixtureRow;
    postId: string;
  }): Promise<void> {
    expect(await this.rowOf(automation)).toMatchObject({
      next_post_status: 'linked',
      target_instagram_media_id: postId,
      next_post_linked_at: expect.any(Date),
    });
  }

  /** Expects no run and no comment log of the automation. */
  async expectNeverAnswered(automation: AutomationFixtureRow): Promise<void> {
    expect(await this.comments.runsOf(automation)).toEqual([]);
    const rows = await operatorQuery<Array<{ logged: number }>>`
      SELECT count(*)::int AS logged FROM app.automation_comment_logs
      WHERE automation_id = ${automation.id}`;
    expect(rows).toEqual([{ logged: 0 }]);
  }

  /** The automation as the team reads it (route 29). */
  async readAsTheTeam(automation: AutomationFixtureRow): Promise<Record<string, unknown>> {
    const response = await this.request({ url: automationPath(automation.public_id) });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { data: Record<string, unknown> }).data;
  }

  /** The names of the team's automations in this "next post" status, oldest first. */
  async listedNames(nextPostStatus: 'waiting' | 'linked'): Promise<unknown[]> {
    const rows = await operatorQuery<Array<{ name: string }>>`
      SELECT name FROM app.automations
      WHERE organization_id = ${this.comments.team.organization.id}
        AND next_post_status = ${nextPostStatus} AND deleted_at IS NULL
      ORDER BY created_at, id`;
    return rows.map(({ name }) => name);
  }

  /** The team saves the automation (route 30); whatever the answer is. */
  async save({
    automation,
    body,
  }: {
    automation: AutomationFixtureRow;
    body: Record<string, unknown>;
  }): Promise<InjectHttpResult> {
    return this.request({
      method: 'PATCH',
      url: automationPath(automation.public_id),
      payload: body,
    });
  }

  /** Moves the automation's go-live time — time passing, seen from the database. */
  async passTheWindow({
    automation,
    startHours,
  }: {
    automation: AutomationFixtureRow;
  } & typeof DEFAULT_WINDOW): Promise<void> {
    await operatorQuery`
      UPDATE app.automations SET target_starts_at = ${this.hoursFromNow(startHours)}
      WHERE id = ${automation.id}`;
  }

  /** A request as the team's Owner. */
  private request({
    method = 'GET',
    url,
    payload,
  }: {
    method?: 'GET' | 'PATCH';
    url: string;
    payload?: unknown;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(this.app, {
      method,
      url,
      token: this.comments.team.ownerToken,
      ...(payload === undefined ? {} : { payload }),
    });
  }
}
