import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { isAppPlanAccessPreHandler } from '@/domains/app/app-plan-access.js';
import { createAppContainer } from '@/domains/app/app.container.js';
import { appRoutesPlugin } from '@/domains/app/app.routes.js';
import { PLAN_FEATURE_KEYS } from '@/domains/billing/sub-domains/plan/plan.constants.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { routeModelKey } from '@/tests/helpers/route-authorization-model.js';
import { loadRouteRegistryFromCatalog } from '@/tests/helpers/route-catalog-registry.js';
import {
  isWriteRoute,
  JOB_PLAN_GATE_MODEL,
  type PlanGateEntry,
  PLAN_GATE_KINDS,
  ROUTE_PLAN_GATE_MODEL,
} from '@/tests/helpers/route-plan-gate-model.js';
import {
  buildPublicApiPrefix,
  PUBLIC_API_VERSION_SEGMENT_V1,
} from '@/shared/utils/http/api-versioning.util.js';

const APP_PREFIX = `${buildPublicApiPrefix(PUBLIC_API_VERSION_SEGMENT_V1)}/app`;
const DOMAINS_ROOT = join(process.cwd(), 'src', 'domains');

/** Every gate value the model may use: the fixed kinds and one `feature:<key>` per plan switch. */
const KNOWN_GATES: ReadonlySet<string> = new Set([
  ...PLAN_GATE_KINDS,
  ...PLAN_FEATURE_KEYS.map((key) => `feature:${key}`),
]);

function listInvalidEntries(model: Readonly<Record<string, PlanGateEntry>>): string[] {
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
      if (!KNOWN_GATES.has(gate)) invalid.push(`${key} → unknown gate ${gate}`);
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

/**
 * The app routes whose registered `preHandler` list carries the read-only guard — read from the
 * real routes plugin, so the model's `read_only_guard` is checked against what runs.
 */
async function listGuardedAppRoutes(): Promise<Set<string>> {
  const application = Fastify();
  application.setValidatorCompiler(validatorCompiler);
  application.setSerializerCompiler(serializerCompiler);
  application.decorate('authenticate', async () => undefined);
  application.decorate(
    'appDomain',
    createAppContainer({
      organizationService: {} as OrganizationService,
      planAccessService: { getPlanAccess: vi.fn() },
      trialPort: { assertAccountsMayTrial: vi.fn(), recordTrialAccounts: vi.fn() },
    }),
  );
  application.decorate('billingDomain', {
    subscriptionService: { assertOrganizationWritable: vi.fn() },
  } as never);
  const guarded = new Set<string>();
  application.addHook('onRoute', (route) => {
    const preHandlers = [route.preHandler ?? []].flat();
    if (route.method === 'HEAD' || !preHandlers.some(isAppPlanAccessPreHandler)) return;
    for (const method of [route.method].flat()) guarded.add(`${String(method)} ${route.url}`);
  });
  await application.register(appRoutesPlugin, { prefix: APP_PREFIX });
  await application.ready();
  await application.close();
  return guarded;
}

/**
 * Coverage gate for plan gating (owner 2026-11-26, plan-gating audit item 9).
 *
 * Every write route in docs/routes.txt declares its plan gates or why it is deliberately open in
 * `route-plan-gate-model.ts`; no entry outlives its route; every gate is known; and the read-only
 * guard the model declares is the one the registered routes really run. Every job that sends or
 * starts paid work declares its gates too, and no job entry outlives its job name.
 */
describe('Global: plan-gate coverage', () => {
  const routes = loadRouteRegistryFromCatalog();
  const writes = routes.filter(isWriteRoute);

  it('covers a meaningful number of write routes', () => {
    expect(writes.length).toBeGreaterThan(100);
  });

  it('every write route has a plan-gate entry', () => {
    const missing = writes.map(routeModelKey).filter((key) => !(key in ROUTE_PLAN_GATE_MODEL));
    expect(missing, `Write routes missing a plan-gate entry:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every plan-gate entry maps to a write route in the catalog (no stale entries)', () => {
    const writeKeys = new Set(writes.map(routeModelKey));
    const stale = Object.keys(ROUTE_PLAN_GATE_MODEL).filter((key) => !writeKeys.has(key));
    expect(stale, `Stale plan-gate entries:\n${stale.join('\n')}`).toEqual([]);
  });

  it('every route entry names known gates or a one-line reason', () => {
    expect(listInvalidEntries(ROUTE_PLAN_GATE_MODEL)).toEqual([]);
  });

  it('the read-only guard runs on exactly the routes the model declares it on', async () => {
    const declared = Object.entries(ROUTE_PLAN_GATE_MODEL)
      .filter(([, entry]) => entry.gates?.includes('read_only_guard'))
      .map(([key]) => key)
      .sort();
    const registered = [...(await listGuardedAppRoutes())].sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(registered).toEqual(declared);
  });

  it('every job entry names known gates and a job name the source still declares', () => {
    expect(listInvalidEntries(JOB_PLAN_GATE_MODEL)).toEqual([]);
    const source = readDomainSource().join('\n');
    const stale = Object.keys(JOB_PLAN_GATE_MODEL).filter((name) => !source.includes(`'${name}'`));
    expect(stale, `Job entries with no declared job name:\n${stale.join('\n')}`).toEqual([]);
  });
});
