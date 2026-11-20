import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSelectorFixtures } from '@tooling/vitest/selector-fixtures.check.js';
import {
  changedOnly,
  ESCALATION_GLOBS,
  isAlwaysRunOnly,
  selectTests,
  SOURCE_SCAN_POLICIES,
  TEST_SOURCE_POLICIES,
  withoutTests,
} from '@tooling/vitest/test-selection.util.js';

const PLAN = 'src/domains/billing/sub-domains/plan';
const WEBHOOK = 'src/domains/notify/sub-domains/webhook';
const UPLOAD = 'src/domains/upload';
const MEMBERSHIP = 'src/domains/tenancy/sub-domains/membership';
/** A wiring file: it imports three areas other than its own, so the domain-map walk stops there. */
const WIRING_ROUTES = 'src/domains/tenancy/wiring.routes.ts';
/** A wiring file named for a container: the tests that load it are selected for a change it wires. */
const RECORDS_CONTAINER = 'src/domains/tenancy/records.container.ts';

/**
 * `from '<path>'` for a fixture import line. Built from the path so the from-alias sequence never
 * appears verbatim in compiled dist (it would false-positive the `check-dist-imports` pre-push
 * gate, which greps dist for it) — the same way as `worker-database-guard.unit.test.ts`.
 */
const from = (path: string): string => `from '${path}'`;

/**
 * A small repository: three domains (the webhook service imports the plan service), wiring, and
 * one test per rule.
 */
const FIXTURE: Record<string, string> = {
  'package.json': '{}',
  'docs/reference/commands.md': '# Commands',
  'agent-os/hooks/guard.sh': '#!/usr/bin/env bash',
  'src/app.ts': `import { routes } ${from('@/domains/tenancy/wiring.routes.js')};\nexport { routes };`,
  [WIRING_ROUTES]: [
    `import { plan } ${from('@/domains/billing/sub-domains/plan/plan.controller.js')};`,
    `import { webhook } ${from('@/domains/notify/sub-domains/webhook/webhook.controller.js')};`,
    `import { upload } ${from('@/domains/upload/upload.controller.js')};`,
    'export const routes = [plan, webhook, upload];',
  ].join('\n'),
  [`${PLAN}/plan.service.ts`]: 'export const planService = {};',
  [`${PLAN}/plan.controller.ts`]:
    "import { planService } from './plan.service.js';\nexport const plan = planService;",
  [`${WEBHOOK}/webhook.service.ts`]: `import { planService } ${from('@/domains/billing/sub-domains/plan/plan.service.js')};\nexport const webhookService = planService;`,
  [`${WEBHOOK}/webhook.controller.ts`]:
    "import { webhookService } from './webhook.service.js';\nexport const webhook = webhookService;",
  [`${UPLOAD}/upload.service.ts`]: 'export const uploadService = {};',
  [`${UPLOAD}/upload.dto.ts`]: 'export const uploadBody = {};',
  [`${UPLOAD}/upload.controller.ts`]:
    "import { uploadService } from './upload.service.js';\nexport const upload = uploadService;",
  [`${PLAN}/__tests__/unit/plan.service.unit.test.ts`]: `import { planService } ${from('@/domains/billing/sub-domains/plan/plan.service.js')};`,
  [`${PLAN}/__tests__/integration/plan.integration.test.ts`]: `import { routes } ${from('@/app.js')};`,
  [`${WEBHOOK}/__tests__/integration/webhook.integration.test.ts`]: `import { routes } ${from('@/app.js')};`,
  [`${UPLOAD}/__tests__/integration/upload.integration.test.ts`]: `import { routes } ${from('@/app.js')};`,
  'src/domains/billing/__tests__/e2e/plan-flow.e2e.test.ts': `import { routes } ${from('@/app.js')};\nconst path = '/api/v1/billing/plans';`,
  [`${UPLOAD}/__tests__/e2e/upload-flow.e2e.test.ts`]: `import { routes } ${from('@/app.js')};\nconst path = '/api/v1/uploads';`,
  'src/tests/unit/routes-wiring.unit.test.ts': `import { routes } ${from('@/domains/tenancy/wiring.routes.js')};`,
  'src/tests/unit/hooks-policy.unit.test.ts':
    "import { join } from 'node:path';\nconst hooks = join(process.cwd(), 'agent-os', 'hooks');",
  'src/tests/unit/docs-policy.unit.test.ts': `import { uploadService } ${from('@/domains/upload/upload.service.js')};\nconst doc = 'docs/reference/commands.md';`,
  // A unit test that reads the migrations folder, as the migration lints and RLS scans do.
  'migrations/00000000000000_init.sql': '-- init',
  'src/tests/unit/migration-lint.unit.test.ts': `import { uploadService } ${from('@/domains/upload/upload.service.js')};\nconst folder = join(process.cwd(), 'migrations');`,
  'src/tests/unit/dto-glob.unit.test.ts': `import { uploadService } ${from('@/domains/upload/upload.service.js')};\nconst dtos = 'src/domains/**/*.dto.ts';`,
  'src/tests/security/tenant.security.test.ts': `import { routes } ${from('@/app.js')};`,
  'src/tests/global/layers.global.test.ts': "const roots = ['src'];",
  'src/tests/helpers/fake.helper.ts': `import { uploadService } ${from('@/domains/upload/upload.service.js')};\nexport const fake = uploadService;`,
  'src/tests/integration/api-contract.integration.test.ts': `import { routes } ${from('@/app.js')};`,
  'src/tests/unit/harness-only.unit.test.ts': `import { fake } ${from('@/tests/helpers/fake.helper.js')};`,
  // A contract test that builds every service through a container, as the composition-root tests
  // do through worker-containers.
  [RECORDS_CONTAINER]: [
    `import { planService } ${from('@/domains/billing/sub-domains/plan/plan.service.js')};`,
    `import { webhookService } ${from('@/domains/notify/sub-domains/webhook/webhook.service.js')};`,
    `import { uploadService } ${from('@/domains/upload/upload.service.js')};`,
    'export const services = { planService, webhookService, uploadService };',
  ].join('\n'),
  'src/tests/helpers/record-contract.helper.ts': `import { services } ${from('@/domains/tenancy/records.container.js')};\nexport const contract = services;`,
  [`${UPLOAD}/__tests__/unit/upload.contract.unit.test.ts`]: `import { contract } ${from('@/tests/helpers/record-contract.helper.js')};`,
  'src/tests/unit/records-wiring.unit.test.ts': `import { services } ${from('@/domains/tenancy/records.container.js')};`,
  // A tenancy sub-domain: off the escalation list, so judged by its imports like any other.
  [`${MEMBERSHIP}/membership.service.ts`]: 'export const membershipService = {};',
  [`${MEMBERSHIP}/__tests__/unit/membership.service.unit.test.ts`]: `import { membershipService } ${from('@/domains/tenancy/sub-domains/membership/membership.service.js')};`,
};

let repositoryRoot = '';

beforeAll(() => {
  repositoryRoot = mkdtempSync(join(tmpdir(), 'test-selection-'));
  for (const [path, content] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(repositoryRoot, path)), { recursive: true });
    writeFileSync(join(repositoryRoot, path), content);
  }
});

afterAll(() => {
  rmSync(repositoryRoot, { recursive: true, force: true });
});

function select(...changedFiles: string[]) {
  return selectTests({ changedFiles, repositoryRoot });
}

function selected(...changedFiles: string[]): string[] {
  return Object.values(select(...changedFiles).projects)
    .flat()
    .sort();
}

/**
 * Locks in the selection rules of `pnpm test:select`: a sub-domain change picks its own tests, the
 * app-booting tests of the domains whose code imports it and the always-run set — and nothing else; documents pick only the tests that name them; the escalation list, an
 * unknown path, a deleted file nothing imports and any error run everything — except a migration
 * in a unit-level selection (pre-push), which picks the tests that read migrations.
 */
describe('selectTests', () => {
  it('selects a sub-domain change small: its tests, connected areas, always-run', () => {
    const selection = select(`${PLAN}/plan.service.ts`);
    expect(selection.mode).toBe('selected');
    expect(selection.projects).toEqual({
      e2e: ['src/domains/billing/__tests__/e2e/plan-flow.e2e.test.ts'],
      global: ['src/tests/global/layers.global.test.ts'],
      integration: [
        `${PLAN}/__tests__/integration/plan.integration.test.ts`,
        `${WEBHOOK}/__tests__/integration/webhook.integration.test.ts`,
        'src/tests/integration/api-contract.integration.test.ts',
      ],
      security: ['src/tests/security/tenant.security.test.ts'],
      unit: [
        `${PLAN}/__tests__/unit/plan.service.unit.test.ts`,
        // Load records.container, which wires the plan service (through the harness, and directly).
        `${UPLOAD}/__tests__/unit/upload.contract.unit.test.ts`,
        'src/tests/unit/harness-only.unit.test.ts',
        'src/tests/unit/hooks-policy.unit.test.ts',
        'src/tests/unit/records-wiring.unit.test.ts',
      ],
    });
    expect(selection.why[`${WEBHOOK}/__tests__/integration/webhook.integration.test.ts`]).toEqual([
      `boots the app, in area notify (${PLAN}/plan.service.ts)`,
    ]);
    expect(selection.why['src/tests/unit/hooks-policy.unit.test.ts']).toEqual([
      'always run (imports nothing from the repository)',
    ]);
  });

  it('always runs the tests no single source change selects', () => {
    const { why } = select(`${UPLOAD}/upload.service.ts`);
    for (const test of [
      'src/tests/integration/api-contract.integration.test.ts',
      'src/tests/unit/harness-only.unit.test.ts',
    ]) {
      expect(why[test], test).toEqual(['always run (no single source change selects it)']);
    }
  });

  it('holds its generated fixtures: each sub-domain file selects every test in its folder', () => {
    expect(checkSelectorFixtures(repositoryRoot)).toEqual({
      problems: [],
      fixtures: 4,
      unreachable: 2,
    });
  });

  it('judges a tenancy or user change by its imports: neither domain is on the escalation list', () => {
    expect(ESCALATION_GLOBS).not.toContain('src/domains/tenancy/**');
    expect(ESCALATION_GLOBS).not.toContain('src/domains/user/**');
    const selection = select(`${MEMBERSHIP}/membership.service.ts`);
    expect(selection.mode).toBe('selected');
    expect(selection.projects.unit).toContain(
      `${MEMBERSHIP}/__tests__/unit/membership.service.unit.test.ts`,
    );
    expect(selection.projects.unit).not.toContain(
      `${PLAN}/__tests__/unit/plan.service.unit.test.ts`,
    );
  });

  it('selects the tests that load a container, directly or through the harness, for a change it wires', () => {
    // The 18 Oct planted-break proof: a top-level throw in one service failed every other
    // sub-domain's service contract test (all services built through one container) and the
    // composition-root test (worker-containers).
    const contract = `${UPLOAD}/__tests__/unit/upload.contract.unit.test.ts`;
    expect(selected(`${PLAN}/plan.service.ts`)).toContain(contract);
    expect(selected(`${PLAN}/plan.service.ts`)).toContain(
      'src/tests/unit/records-wiring.unit.test.ts',
    );
    // A change the container does not wire (a controller reaches only the routes) is not one.
    expect(selected(`${WEBHOOK}/webhook.controller.ts`)).not.toContain(contract);
    // A wiring file that is not a container still stops the walk (the routes-wiring case below).
  });

  it('does not follow a change through a wiring file', () => {
    expect(selected(`${PLAN}/plan.service.ts`)).not.toContain(
      'src/tests/unit/routes-wiring.unit.test.ts',
    );
    expect(selected(WIRING_ROUTES)).toContain('src/tests/unit/routes-wiring.unit.test.ts');
  });

  it('selects a document only for the tests that name it, a folder above it or a glob over it', () => {
    expect(selected('docs/reference/commands.md')).toEqual([
      'src/tests/unit/docs-policy.unit.test.ts',
    ]);
    expect(selected('agent-os/hooks/guard.sh')).toEqual([
      'src/tests/unit/hooks-policy.unit.test.ts',
    ]);
    expect(selected(`${UPLOAD}/upload.dto.ts`)).toContain('src/tests/unit/dto-glob.unit.test.ts');
    expect(select('docs/other.md').mode).toBe('none');
  });

  it('runs a changed test alone, without the always-run set', () => {
    expect(selected(`${PLAN}/__tests__/unit/plan.service.unit.test.ts`)).toEqual([
      `${PLAN}/__tests__/unit/plan.service.unit.test.ts`,
    ]);
  });

  it('runs the test-source policies with a changed test, when the repository has them', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-selection-policies-'));
    try {
      for (const path of [
        `${PLAN}/__tests__/unit/plan.rules.unit.test.ts`,
        ...TEST_SOURCE_POLICIES,
      ]) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), 'export {};\n');
      }
      const selection = selectTests({
        changedFiles: [`${PLAN}/__tests__/unit/plan.rules.unit.test.ts`],
        repositoryRoot: root,
      });
      expect(Object.values(selection.projects).flat().sort()).toEqual(
        [`${PLAN}/__tests__/unit/plan.rules.unit.test.ts`, ...TEST_SOURCE_POLICIES].sort(),
      );
      for (const policy of TEST_SOURCE_POLICIES) {
        expect(selection.why[policy]).toEqual([
          `reads every test's source (${PLAN}/__tests__/unit/plan.rules.unit.test.ts)`,
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs the source-scan policies with a changed code file, when the repository has them', () => {
    // The planted-bug drill (A8-4S, 20 Oct 2026) added a second docs/routes.txt parser in a new
    // tooling file: nothing imports a new file, so only this rule selects the policy that finds it.
    const root = mkdtempSync(join(tmpdir(), 'test-selection-source-scan-'));
    const added = 'tooling/openapi/route-catalog/another-reader.ts';
    try {
      for (const path of [added, ...SOURCE_SCAN_POLICIES]) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), 'export {};\n');
      }
      const selection = selectTests({ changedFiles: [added], repositoryRoot: root });
      for (const policy of SOURCE_SCAN_POLICIES) {
        expect(Object.values(selection.projects).flat()).toContain(policy);
        expect(selection.why[policy]).toEqual([`reads every source file (${added})`]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('narrows a migration to the tests that read migrations, for a unit-level selection only', () => {
    const migration = 'migrations/20261020000000_add_column.sql';
    expect(select(migration).reasons[0]).toContain('escalation list');
    const unitLevel = selectTests({ changedFiles: [migration], repositoryRoot, unitLevel: true });
    expect(unitLevel.mode).toBe('selected');
    expect(unitLevel.projects).toEqual({ unit: ['src/tests/unit/migration-lint.unit.test.ts'] });
    expect(unitLevel.why['src/tests/unit/migration-lint.unit.test.ts']).toEqual([
      `reads migrations (${migration})`,
    ]);
    const withAuth = selectTests({
      changedFiles: [migration, 'src/domains/auth/x.ts'],
      repositoryRoot,
      unitLevel: true,
    });
    expect(withAuth.reasons[0]).toContain('escalation list');
  });

  it('fails closed: the escalation list, an unknown path, an untraceable deletion, any error', () => {
    expect(select('package.json')).toMatchObject({ mode: 'all' });
    expect(select('src/domains/auth/x.ts').reasons[0]).toContain('escalation list');
    expect(select('weird/thing.txt').reasons[0]).toContain('outside the known roots');
    expect(select(`${PLAN}/gone.ts`).reasons[0]).toContain('was deleted');
    const broken = selectTests({
      changedFiles: ['docs/reference/commands.md'],
      repositoryRoot,
      graph: {
        files: [],
        tests: ['src/missing.test.ts'],
        imports: new Map(),
        importers: new Map(),
      },
    });
    expect(broken.mode).toBe('all');
    expect(broken.reasons[0]).toContain('selector error');
  });
});

/**
 * Locks in the early-signal view of a selection (PR CI's affected database tests):
 * `--changed-only` keeps the tests picked for the change and leaves the always-run set and a
 * select-everything change to the full suite; `--exclude` drops the matching tests.
 */
describe('changedOnly and withoutTests', () => {
  it('keeps only the tests picked for the change', () => {
    const selection = changedOnly(select(`${PLAN}/plan.service.ts`));
    expect(selection.mode).toBe('selected');
    expect(selection.projects).toEqual({
      e2e: ['src/domains/billing/__tests__/e2e/plan-flow.e2e.test.ts'],
      integration: [
        `${PLAN}/__tests__/integration/plan.integration.test.ts`,
        `${WEBHOOK}/__tests__/integration/webhook.integration.test.ts`,
      ],
      unit: [
        `${PLAN}/__tests__/unit/plan.service.unit.test.ts`,
        `${UPLOAD}/__tests__/unit/upload.contract.unit.test.ts`,
        'src/tests/unit/records-wiring.unit.test.ts',
      ],
    });
    expect(Object.keys(selection.why).sort()).toEqual(
      Object.values(selection.projects).flat().sort(),
    );
    expect(selection.reasons.at(-1)).toBe(
      `the always-run tests left to the full suite (${Object.keys(selection.why).length} test files left)`,
    );
    expect(
      isAlwaysRunOnly(['always run', 'always run (imports nothing from the repository)']),
    ).toBe(true);
    expect(isAlwaysRunOnly(['always run', `next to the code (${PLAN}/plan.service.ts)`])).toBe(
      false,
    );
  });

  it('runs nothing early when everything is selected, or nothing is left', () => {
    const everything = changedOnly(select('package.json'));
    expect(everything.mode).toBe('none');
    expect(everything.reasons.at(-1)).toBe(
      'everything is selected, so the full suite is the signal',
    );
    const onlyAlwaysRun = changedOnly({
      mode: 'selected',
      reasons: ['1 of 1 test files'],
      projects: { security: ['src/tests/security/tenant.security.test.ts'] },
      why: { 'src/tests/security/tenant.security.test.ts': ['always run'] },
    });
    expect(onlyAlwaysRun).toMatchObject({ mode: 'none', projects: {}, why: {} });
  });

  it('drops the tests an --exclude glob matches', () => {
    const selection = withoutTests({
      selection: select(`${PLAN}/plan.service.ts`),
      globs: [`${WEBHOOK}/**`, 'src/tests/security/**'],
    });
    expect(Object.values(selection.projects).flat()).not.toContain(
      `${WEBHOOK}/__tests__/integration/webhook.integration.test.ts`,
    );
    expect(selection.projects.security).toBeUndefined();
    expect(selection.reasons.at(-1)).toBe(
      `excluded ${WEBHOOK}/**, src/tests/security/** (${Object.values(selection.projects).flat().length} test files left)`,
    );
    const all = select('package.json');
    expect(withoutTests({ selection: all, globs: ['src/**'] })).toBe(all);
  });
});
