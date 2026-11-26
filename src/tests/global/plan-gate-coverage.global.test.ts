import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_LIMIT_KEYS,
  ENTITLEMENT_SWITCH_KEYS,
} from '@/domains/billing/sub-domains/entitlement/entitlement.constants.js';
import {
  declaresReadOnlyPlanGate,
  isPlanReadOnlyGuard,
} from '@/domains/billing/sub-domains/entitlement/entitlement-plan-guard.util.js';
import type { PlanGateDeclaration } from '@/domains/billing/sub-domains/entitlement/entitlement.types.js';
import {
  INSTAGRAM_DATABASE_TASK_QUEUE,
  INSTAGRAM_META_TASK_QUEUE,
} from '@/domains/app/sub-domains/instagram-sending/workers/instagram-tasks.processor.js';
import { getWorkerQueueRegistrationDefinitions } from '@/infrastructure/queue/worker-runtime/worker-registration.registry.js';
import type { RegisteredRouteCapture } from '@/app.js';
import { routeModelKey } from '@/tests/helpers/route-authorization-model.js';
import { loadRouteRegistryFromCatalog } from '@/tests/helpers/route-catalog-registry.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { listWorkerJobNamesFromCode } from '@/tests/helpers/worker-job-names.js';

const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The Bull Board dashboard (`ENABLE_QUEUE_DASHBOARD`, `/admin/queues`): a third-party plugin's own
 * operator routes, outside the API catalog — no route of ours, so no plan-gate declaration.
 */
const QUEUE_DASHBOARD_PREFIX = '/admin/queues';

/** Every gate a job may declare — the entitlement registry's switches and limits (JGC3). */
const KNOWN_JOB_GATES: ReadonlySet<string> = new Set([
  ...ENTITLEMENT_SWITCH_KEYS.map((key) => `feature:${key}`),
  ...ENTITLEMENT_LIMIT_KEYS.map((key) => `limit:${key}`),
]);

/**
 * Every gate a route may declare — read from the entitlement registry at run time (RG6): a job's
 * gates, plus `read_only` (a route's guard; a job has no request to refuse).
 */
const KNOWN_ROUTE_GATES: ReadonlySet<string> = new Set(['read_only', ...KNOWN_JOB_GATES]);

/** The two Instagram task queues: their job names are the registered task handlers' (JGC3). */
const TASK_HANDLER_QUEUE_NAMES: ReadonlySet<string> = new Set([
  INSTAGRAM_META_TASK_QUEUE.queueName,
  INSTAGRAM_DATABASE_TASK_QUEUE.queueName,
]);

/** What is wrong with one route's or job's declaration — empty when it is valid. */
function listDeclarationProblems({
  planGate,
  knownGates,
}: {
  planGate: PlanGateDeclaration;
  knownGates: ReadonlySet<string>;
}): string[] {
  const hasGates = Array.isArray(planGate.gates) && planGate.gates.length > 0;
  const reason = planGate.open;
  const hasReason = typeof reason === 'string' && reason.trim().length > 0;
  if (hasGates === hasReason) return ['exactly one of gates / a non-empty open reason'];
  const problems: string[] = [];
  for (const gate of planGate.gates ?? []) {
    if (!knownGates.has(gate)) problems.push(`unknown gate ${gate}`);
  }
  if (hasReason && /[\r\n]/.test(reason)) problems.push('the open reason is one line');
  return problems;
}

function routeKey(route: RegisteredRouteCapture): string {
  return `${route.method} ${route.url}`;
}

/** The route's final `preHandler` list, as Fastify built it (after every `onRoute` hook). */
function listPreHandlers(route: RegisteredRouteCapture): unknown[] {
  return [route.routeOptions.preHandler ?? []].flat();
}

/**
 * Coverage gate for route plan gates (change-plan-gates RG6, owner 2026-11-26).
 *
 * Reads the LIVE routes — the fully built app, every route plugin, the MCP and ops routes — never a
 * hand list: every registered write route declares `config.planGate` (its gates, or the one-line
 * reason it meets none); every gate is a registry key; and the routes declaring `read_only` are
 * exactly the routes the one plan guard was attached to, first in their `preHandler` list. Every
 * job of every registered queue declares too, in the worker registry (`jobPlanGates`, JG1, P33):
 * the test walks the registry and checks it against the job names the code itself puts on each
 * queue (`listWorkerJobNamesFromCode`) — never a hand list, so a forgotten paid job fails.
 */
describe('Global: plan-gate coverage', () => {
  let app: FastifyInstance | undefined;
  let routes: RegisteredRouteCapture[] = [];
  let writes: RegisteredRouteCapture[] = [];

  beforeAll(async () => {
    const testApp = await createTestApp({ connectRedisClients: false });
    app = testApp.app;
    routes = testApp.registeredRoutes;
    writes = routes.filter(
      (route) => WRITE_METHODS.has(route.method) && !route.url.startsWith(QUEUE_DASHBOARD_PREFIX),
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reads every write route of the catalog from the live app', () => {
    const catalogWrites = loadRouteRegistryFromCatalog()
      .filter((route) => route.method !== 'GET')
      .map(routeModelKey);
    const liveWrites = new Set(writes.map(routeKey));
    expect(catalogWrites.length).toBeGreaterThan(100);
    const unregistered = catalogWrites.filter((key) => !liveWrites.has(key));
    expect(unregistered, `Catalog writes not registered:\n${unregistered.join('\n')}`).toEqual([]);
  });

  it('every write route declares config.planGate', () => {
    const missing = writes
      .filter((route) => route.routeOptions.config?.planGate === undefined)
      .map(routeKey);
    expect(missing, `Write routes without a planGate:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every declaration names registry gates or a one-line open reason', () => {
    const invalid = writes.flatMap((route) => {
      const planGate = route.routeOptions.config?.planGate;
      if (planGate === undefined) return [];
      return listDeclarationProblems({ planGate, knownGates: KNOWN_ROUTE_GATES }).map(
        (problem) => `${routeKey(route)} → ${problem}`,
      );
    });
    expect(invalid).toEqual([]);
  });

  it('the plan guard runs first on exactly the routes that declare read_only', () => {
    const declared = writes
      .filter((route) => declaresReadOnlyPlanGate(route.routeOptions.config?.planGate))
      .map(routeKey)
      .sort();
    const guarded = routes.filter((route) => listPreHandlers(route).some(isPlanReadOnlyGuard));
    const notFirst = guarded
      .filter((route) => !isPlanReadOnlyGuard(listPreHandlers(route)[0]))
      .map(routeKey);
    expect(declared.length).toBeGreaterThan(0);
    expect(guarded.map(routeKey).sort()).toEqual(declared);
    expect(notFirst, `Guard attached but not first:\n${notFirst.join('\n')}`).toEqual([]);
  });

  describe('jobs (the worker registry)', () => {
    const registrations = getWorkerQueueRegistrationDefinitions();
    const fromCode = listWorkerJobNamesFromCode();

    it('reads job names for every registered queue from the code', () => {
      const queuesWithoutJobs = registrations
        .filter(
          (registration) => (fromCode.jobNamesByQueue.get(registration.queueName)?.size ?? 0) === 0,
        )
        .map((registration) => registration.queueName);
      expect(
        queuesWithoutJobs,
        `Queues the code puts no job on:\n${queuesWithoutJobs.join('\n')}`,
      ).toEqual([]);
      const unreadable = fromCode.unresolved
        .filter((entry) => !TASK_HANDLER_QUEUE_NAMES.has(entry.queueName))
        .map((entry) => `${entry.file} → ${entry.queueName}: ${entry.expression}`);
      expect(unreadable, `Job names the test cannot read:\n${unreadable.join('\n')}`).toEqual([]);
    });

    it('every job a registered queue runs declares its plan gate', () => {
      const missing = registrations.flatMap((registration) =>
        [...(fromCode.jobNamesByQueue.get(registration.queueName) ?? [])]
          .filter((jobName) => registration.jobPlanGates[jobName] === undefined)
          .map((jobName) => `${registration.queueName} → ${jobName}`),
      );
      expect(missing, `Jobs without a plan-gate declaration:\n${missing.join('\n')}`).toEqual([]);
    });

    it('every declaration names registry gates or a one-line open reason', () => {
      const invalid = registrations.flatMap((registration) =>
        Object.entries(registration.jobPlanGates).flatMap(([jobName, planGate]) =>
          listDeclarationProblems({ planGate, knownGates: KNOWN_JOB_GATES }).map(
            (problem) => `${registration.queueName} → ${jobName} → ${problem}`,
          ),
        ),
      );
      expect(invalid).toEqual([]);
    });

    it('every declared job is a job name the code puts on that queue', () => {
      const stale = registrations.flatMap((registration) =>
        Object.keys(registration.jobPlanGates)
          .filter((jobName) => !fromCode.jobNamesByQueue.get(registration.queueName)?.has(jobName))
          .map((jobName) => `${registration.queueName} → ${jobName}`),
      );
      expect(stale, `Declarations for jobs the queue never runs:\n${stale.join('\n')}`).toEqual([]);
    });
  });
});
