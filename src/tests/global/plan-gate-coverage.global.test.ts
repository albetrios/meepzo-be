import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
import { PLAN_FEATURE_KEYS } from '@/domains/billing/sub-domains/plan/plan.constants.js';
import type { RegisteredRouteCapture } from '@/app.js';
import { routeModelKey } from '@/tests/helpers/route-authorization-model.js';
import { loadRouteRegistryFromCatalog } from '@/tests/helpers/route-catalog-registry.js';
import {
  JOB_PLAN_GATE_KINDS,
  JOB_PLAN_GATE_MODEL,
  type JobPlanGateEntry,
} from '@/tests/helpers/route-plan-gate-model.js';
import { createTestApp } from '@/tests/helpers/test-app.js';

const DOMAINS_ROOT = join(process.cwd(), 'src', 'domains');
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The Bull Board dashboard (`ENABLE_QUEUE_DASHBOARD`, `/admin/queues`): a third-party plugin's own
 * operator routes, outside the API catalog — no route of ours, so no plan-gate declaration.
 */
const QUEUE_DASHBOARD_PREFIX = '/admin/queues';

/** Every gate a route may declare — read from the entitlement registry at run time (RG6). */
const KNOWN_ROUTE_GATES: ReadonlySet<string> = new Set([
  'read_only',
  ...ENTITLEMENT_SWITCH_KEYS.map((key) => `feature:${key}`),
  ...ENTITLEMENT_LIMIT_KEYS.map((key) => `limit:${key}`),
]);

/** Every gate the job model may use: the fixed kinds and one `feature:<key>` per plan switch. */
const KNOWN_JOB_GATES: ReadonlySet<string> = new Set([
  ...JOB_PLAN_GATE_KINDS,
  ...PLAN_FEATURE_KEYS.map((key) => `feature:${key}`),
]);

/** What is wrong with one route's live declaration — empty when it is valid. */
function listDeclarationProblems(planGate: PlanGateDeclaration): string[] {
  const hasGates = Array.isArray(planGate.gates) && planGate.gates.length > 0;
  const reason = planGate.open;
  const hasReason = typeof reason === 'string' && reason.trim().length > 0;
  if (hasGates === hasReason) return ['exactly one of gates / a non-empty open reason'];
  const problems: string[] = [];
  for (const gate of planGate.gates ?? []) {
    if (!KNOWN_ROUTE_GATES.has(gate)) problems.push(`unknown gate ${gate}`);
  }
  if (hasReason && /[\r\n]/.test(reason)) problems.push('the open reason is one line');
  return problems;
}

function listInvalidJobEntries(model: Readonly<Record<string, JobPlanGateEntry>>): string[] {
  const invalid: string[] = [];
  for (const [key, entry] of Object.entries(model)) {
    const hasGates = Array.isArray(entry.gates) && entry.gates.length > 0;
    const reason = entry.deliberatelyOpen;
    const hasReason = typeof reason === 'string' && reason.trim().length > 0;
    if (hasGates === hasReason) {
      invalid.push(`${key} → exactly one of gates / deliberatelyOpen`);
      continue;
    }
    for (const gate of entry.gates ?? []) {
      if (!KNOWN_JOB_GATES.has(gate)) invalid.push(`${key} → unknown gate ${gate}`);
    }
    if (hasReason && reason.includes('\n')) invalid.push(`${key} → the reason is one line`);
  }
  return invalid;
}

/** The non-test TypeScript source under `src/domains/`, joined — where a job name is declared. */
function readDomainSource(directory: string = DOMAINS_ROOT, parts: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      if (entry === '__tests__') continue;
      readDomainSource(fullPath, parts);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      parts.push(readFileSync(fullPath, 'utf8'));
    }
  }
  return parts;
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
 * job that sends or starts paid work declares its gates too (the hand-kept job model, until part 6).
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
      return listDeclarationProblems(planGate).map((problem) => `${routeKey(route)} → ${problem}`);
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

  it('every job entry names known gates and a job name the source still declares', () => {
    expect(listInvalidJobEntries(JOB_PLAN_GATE_MODEL)).toEqual([]);
    const source = readDomainSource().join('\n');
    const stale = Object.keys(JOB_PLAN_GATE_MODEL).filter((name) => !source.includes(`'${name}'`));
    expect(stale, `Job entries with no declared job name:\n${stale.join('\n')}`).toEqual([]);
  });
});
