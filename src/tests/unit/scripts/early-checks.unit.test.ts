import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportEarlyCheck } from '@/scripts/tooling/early-checks.util.js';
import { pushSemgrepTargets, SEMGREP_CONFIGS } from '@/scripts/tooling/run-push-semgrep.js';
import {
  buildRlsState,
  lintRlsTables,
  touchedTables,
} from '@/scripts/validators/migration/lint-rls-policies.js';
import { diffRouteAccess } from '@/scripts/validators/routes/validate-route-access-diff.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('early checks — a finding blocks', () => {
  it('passes with no finding and fails with one, naming the false-positive log', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(reportEarlyCheck({ check: 'x', findings: [] })).toBe(0);
    expect(reportEarlyCheck({ check: 'x', findings: ['f'] })).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('agent-os/evals/false-positives.md');
  });
});

const TENANT_USING =
  "USING (organization_id = current_setting('app.current_organization_public_id'))";
const TENANT_CHECK =
  "WITH CHECK (organization_id = current_setting('app.current_organization_public_id'))";

function migration(name: string, ...statements: string[]) {
  return { name, content: statements.join(';\n') };
}

const MIGRATIONS = [
  migration(
    '0001_init.sql',
    'CREATE TABLE IF NOT EXISTS "tenancy"."leads" ("id" bigserial, "organization_id" bigint NOT NULL)',
    'ALTER TABLE "tenancy"."leads" ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE "tenancy"."leads" FORCE ROW LEVEL SECURITY',
    `CREATE POLICY "leads_tenant_isolation" ON "tenancy"."leads" AS PERMISSIVE FOR ALL TO public ${TENANT_USING} ${TENANT_CHECK}`,
    'CREATE TABLE tenancy.notes (id bigserial, organization_id bigint)',
    'ALTER TABLE tenancy.notes ENABLE ROW LEVEL SECURITY',
    `CREATE POLICY notes_tenant ON tenancy.notes FOR ALL ${TENANT_USING}`,
    'CREATE TABLE tenancy.owned (id bigserial, organization_id bigint, user_id bigint)',
    'ALTER TABLE tenancy.owned ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE tenancy.owned FORCE ROW LEVEL SECURITY',
    "CREATE POLICY owned_by_user ON tenancy.owned FOR ALL USING (user_id = current_setting('app.current_user_id'))",
    'CREATE TABLE tenancy.leads_archive PARTITION OF tenancy.leads FOR VALUES IN (1)',
  ),
  migration(
    '0002_change.sql',
    'ALTER TABLE tenancy.notes FORCE ROW LEVEL SECURITY',
    `ALTER POLICY notes_tenant ON tenancy.notes ${TENANT_CHECK}`,
    'ALTER TABLE tenancy.owned NO FORCE ROW LEVEL SECURITY',
    '-- a comment; CREATE TABLE tenancy.ghost (id int)',
    "DO $$ BEGIN EXECUTE 'CREATE POLICY hidden ON tenancy.leads FOR ALL USING (true)'; END $$",
  ),
];

describe('RLS policy lint', () => {
  const { tables, touchedBy } = buildRlsState(MIGRATIONS);

  it('replays the migrations into each table’s final state', () => {
    expect(tables.get('tenancy.leads')).toMatchObject({
      isEnabled: true,
      isForced: true,
      isOrganizationScoped: true,
    });
    expect(tables.get('tenancy.notes')?.policies).toEqual([
      { name: 'notes_tenant', command: 'all', isTenantPolicy: true, hasWithCheck: true },
    ]);
    expect(tables.get('tenancy.owned')?.isForced).toBe(false);
    expect(tables.has('tenancy.ghost')).toBe(false);
    expect(tables.get('tenancy.leads')?.policies.map((policy) => policy.name)).toEqual([
      'leads_tenant_isolation',
    ]);
    expect([...(touchedBy.get('0002_change.sql') ?? [])].sort()).toEqual([
      'tenancy.notes',
      'tenancy.owned',
    ]);
  });

  it('flags a table without FORCE and a tenant write policy without WITH CHECK, not a user policy', () => {
    const before = buildRlsState(MIGRATIONS.slice(0, 1)).tables;
    expect(
      lintRlsTables({
        state: before,
        tables: ['tenancy.notes', 'tenancy.owned', 'tenancy.leads_archive'],
      }),
    ).toEqual([
      'tenancy.notes: no FORCE ROW LEVEL SECURITY',
      'tenancy.notes: tenant policy notes_tenant (FOR ALL) has no WITH CHECK',
    ]);
    expect(
      lintRlsTables({ state: tables, tables: ['tenancy.leads', 'tenancy.notes', 'tenancy.owned'] }),
    ).toEqual(['tenancy.owned: no FORCE ROW LEVEL SECURITY']);
  });

  it('checks the tables a changed migration touches and a changed schema declares', () => {
    const files: Record<string, string> = {
      'src/infrastructure/database/pg-schemas.ts':
        "export const tenancySchema = pgSchema('tenancy');",
      'src/domains/tenancy/x.schema.ts': "export const x = tenancySchema.table('drafts', {});",
    };
    const touched = touchedTables({
      changedFiles: ['migrations/0002_change.sql', 'src/domains/tenancy/x.schema.ts', 'docs/x.md'],
      touchedBy,
      readFile: (path) => files[path] ?? '',
    });
    expect(touched.sort()).toEqual(['tenancy.drafts', 'tenancy.notes', 'tenancy.owned']);
    expect(lintRlsTables({ state: tables, tables: ['tenancy.drafts'] })).toEqual([
      'tenancy.drafts: declared or changed, but no migration creates it',
    ]);
  });
});

function catalog(...rows: string[]): string {
  return rows.map((row) => `  ${row}`).join('\n');
}

describe('route access diff', () => {
  it('lists every change and flags the ones that widen access', () => {
    const before = catalog(
      'GET    /api/v1/notify/webhooks        200  -    both  PERM: webhook:read',
      'POST   /api/v1/notify/webhooks        200  req  team  PERM: webhook:create',
      'DELETE /api/v1/notify/webhooks/:webhook_id 204  -    both  PERM: webhook:delete',
      'GET    /api/v1/me                     200  -    both  AUTH',
      'GET    /api/v1/uploads                200  -    both  AUTH',
    );
    const after = catalog(
      'GET    /api/v1/notify/webhooks        200  -    both  AUTH',
      'POST   /api/v1/notify/webhooks        200  -    both  PERM: webhook:write',
      'GET    /api/v1/me                     200  -    both  AUTH',
      'GET    /api/v1/uploads                200  -    both  PERM: upload:read',
      'GET    /api/v1/status                 200  -    both  PUBLIC',
    );
    const { changes, findings } = diffRouteAccess({ before, after });
    expect(findings).toEqual([
      'GET /notify/webhooks: weaker gate (PERM: webhook:read → AUTH)',
      'POST /notify/webhooks: permission changed (PERM: webhook:create → PERM: webhook:write)',
      'POST /notify/webhooks: team-only → both (personal accounts may call it now)',
      'POST /notify/webhooks: no longer requires X-Idempotency-Key',
      'GET /status: new route without a JWT (PUBLIC)',
    ]);
    expect(changes).toContain(
      '~ GET /uploads — AUTH · both · no idempotency → PERM: upload:read · both · no idempotency',
    );
    expect(changes).toContain(
      '- DELETE /notify/webhooks/:webhook_id — PERM: webhook:delete · both · no idempotency',
    );
    expect(changes).toHaveLength(5);
  });

  it('finds nothing when the catalog is unchanged', () => {
    const same = catalog('GET    /api/v1/me    200  -    both  AUTH');
    expect(diffRouteAccess({ before: same, after: same })).toEqual({ changes: [], findings: [] });
  });
});

describe('Semgrep at push', () => {
  it('scans every code file under src/ and tooling/, tests included, as PR SAST does', () => {
    expect(
      pushSemgrepTargets([
        'src/domains/auth/auth.service.ts',
        'src/domains/tenancy/sub-domains/membership/membership.validator.ts',
        'src/infrastructure/database/contexts/database-context.ts',
        'src/domains/auth/__tests__/unit/auth.service.unit.test.ts',
        'src/tests/unit/scripts/early-checks.unit.test.ts',
        'tooling/validate/pre-push-steps.ts',
        'docs/reference/commands.md',
      ]),
    ).toEqual([
      'src/domains/auth/auth.service.ts',
      'src/domains/tenancy/sub-domains/membership/membership.validator.ts',
      'src/infrastructure/database/contexts/database-context.ts',
      // #124's PR SAST failed on a test file the push had skipped (20 Oct 2026).
      'src/domains/auth/__tests__/unit/auth.service.unit.test.ts',
      'src/tests/unit/scripts/early-checks.unit.test.ts',
      'tooling/validate/pre-push-steps.ts',
    ]);
  });

  it('runs the same rules as the PR CI Semgrep SAST step', () => {
    const workflow = readFileSync(join(process.cwd(), '.github', 'workflows', 'pr-ci.yml'), 'utf8');
    const step = workflow.split('\n').find((line) => line.includes('run: semgrep scan'));
    for (const config of SEMGREP_CONFIGS) expect(step).toContain(`--config ${config}`);
    expect(existsSync(join(process.cwd(), 'tooling', 'semgrep', 'rules.yml'))).toBe(true);
  });
});
