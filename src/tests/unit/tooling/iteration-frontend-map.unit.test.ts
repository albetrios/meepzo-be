/**
 * Design-iteration tooling — `pnpm iteration:frontend-map` (`tooling/iterations/iteration-frontend-map.util.ts`).
 *
 * Pins the route catalog parser (its summary section skipped), the route review numbers and their
 * spellings (own path, without `/tenancy`, without `/app`, `/api/v1` and `{param}` normalised), the app module, the OpenAPI summaries with their fallbacks, the generated section (modules, gates,
 * flags, escaped pipes), the splice that keeps the hand-written sections, the arguments, and the
 * plan: a new map from the template, an unchanged one, and a frozen iteration refused.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeScratchFolders } from '@/tests/helpers/git-repository.helper.js';
import {
  addTestIteration,
  createIterationRepository,
} from '@/tests/helpers/iteration-repository.helper.js';
import {
  GENERATED_BLOCK_END,
  GENERATED_BLOCK_START,
  openApiSummaries,
  parseFrontendMapArguments,
  frontendMapRoutes,
  parseRouteReviewNumbers,
  planFrontendRouteMap,
  renderRouteSection,
  routeReviewNumber,
  spliceGeneratedBlock,
} from '@tooling/iterations/iteration-frontend-map.util.js';

afterEach(() => {
  removeScratchFolders();
});

const ITERATION = 'launch-2026-09-30-jxmr';

const CATALOG = `================================================================================
  DOMAIN: NOTIFY (/api/v1/notify)
  Routes: 3
================================================================================

  — Sub Domains —
  GET    /api/v1/notify/webhooks                                  200  -    both  PERM: webhook:read
  POST   /api/v1/notify/webhooks                                  200  req  both  PERM: webhook:create
  POST   /api/v1/tenancy/organization/roles                       200  req  team  PERM: role:create
  POST   /api/v1/auth/login                                       200  -    both  PUBLIC
  GET    /livez                                                   200  -    both  PUBLIC
  GET    /api/v1/app/social/channel-accounts/:channel_account_id  200  -    team  PERM: channel:read
  GET    /api/v1/app/contacts/:contact_id                         200  -    team  PERM: contact:read

================================================================================
  SUMMARY
================================================================================

  GET    /api/v1/notify/webhooks                                  200  -    both  PERM: webhook:read
`;

const REVIEW = `# Final routes

## 2. Team — final

| # | Method | Path | Operation | Access | Idem |
| --- | --- | --- | --- | --- | --- |
| 9 | POST | \`/organization/roles\` | Add a role | \`role:create\` | req |

## 5. Webhooks — final

| # | Method | Path | Operation | Access | Idem |
| --- | --- | --- | --- | --- | --- |
| 1 | GET | \`/notify/webhooks\` | List webhooks | \`webhook:read\` | |
| 3 | POST | \`/notify/webhooks\` | Add a webhook | \`webhook:create\` | req |
| 4 | GET | \`/notify/webhooks/{webhook_id}\` | Get a webhook | \`webhook:read\` | |

### 5.A Nested

| # | Method | Path | Operation | Access | Idem |
| --- | --- | --- | --- | --- | --- |
| 7 | GET | \`/notify/webhooks\` | Repeated in a nested table | \`webhook:read\` | |

## 6. Channel connection — final

| # | Method | Path | Operation | Access | Idem |
| --- | --- | --- | --- | --- | --- |
| 2 | GET | \`/social/channel-accounts/{channel_account_id}\` | Get a channel | \`channel:read\` | |
| 5 | GET | \`/api/v1/app/contacts/{contact_id}\` | Get a contact (full path) | \`contact:read\` | |
`;

describe('frontendMapRoutes', () => {
  it('reads the domain sections, drops /api/v1 and stops at the summary', () => {
    const routes = frontendMapRoutes(CATALOG);
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /notify/webhooks',
      'POST /notify/webhooks',
      'POST /tenancy/organization/roles',
      'POST /auth/login',
      'GET /livez',
      'GET /app/social/channel-accounts/:channel_account_id',
      'GET /app/contacts/:contact_id',
    ]);
    expect(routes[1]).toMatchObject({ isIdempotencyRequired: true, isTeamOnly: false });
    expect(routes[2]).toMatchObject({ isTeamOnly: true, gate: 'PERM: role:create' });
  });
});

describe('route review numbers', () => {
  it('numbers each route by its sub-domain, with :param segments; the first table wins', () => {
    const numbers = parseRouteReviewNumbers(REVIEW);
    expect(numbers.get('GET /notify/webhooks')).toBe('5.1');
    expect(numbers.get('GET /notify/webhooks/:webhook_id')).toBe('5.4');
    expect(numbers.get('POST /organization/roles')).toBe('2.9');
  });

  it('finds a route by its own path and a team route without /tenancy; blank when unnamed', () => {
    const numbers = parseRouteReviewNumbers(REVIEW);
    expect(
      routeReviewNumber({ numbers, route: { method: 'POST', path: '/notify/webhooks' } }),
    ).toBe('5.3');
    expect(
      routeReviewNumber({
        numbers,
        route: { method: 'POST', path: '/tenancy/organization/roles' },
      }),
    ).toBe('2.9');
    expect(routeReviewNumber({ numbers, route: { method: 'POST', path: '/auth/login' } })).toBe('');
  });

  it('finds an app route the review writes without /app, and one it writes in full with /api/v1', () => {
    const numbers = parseRouteReviewNumbers(REVIEW);
    expect(numbers.get('GET /app/contacts/:contact_id')).toBe('6.5');
    expect(
      routeReviewNumber({
        numbers,
        route: { method: 'GET', path: '/app/social/channel-accounts/:channel_account_id' },
      }),
    ).toBe('6.2');
    expect(
      routeReviewNumber({ numbers, route: { method: 'GET', path: '/app/contacts/:contact_id' } }),
    ).toBe('6.5');
    expect(
      routeReviewNumber({ numbers, route: { method: 'GET', path: '/app/contacts/:other_id' } }),
    ).toBe('');
  });
});

describe('openApiSummaries', () => {
  it('keys by method and catalog path, skips empty summaries and keeps the fallbacks', () => {
    const summaries = openApiSummaries({
      paths: {
        '/api/v1/notify/webhooks/{webhook_id}': {
          get: { summary: 'Get webhook' },
          patch: { summary: ' ' },
        },
        '/livez': { get: { summary: 'GET /livez' } },
      },
    });
    expect(summaries.get('GET /notify/webhooks/:webhook_id')).toBe('Get webhook');
    expect(summaries.has('PATCH /notify/webhooks/:webhook_id')).toBe(false);
    expect(summaries.get('GET /livez')).toBe('Liveness probe');
    expect(summaries.get('GET /metrics')).toBe('Prometheus metrics (operations only)');
  });
});

describe('renderRouteSection', () => {
  it('groups routes into modules with their gate, flags, review number and escaped summary', () => {
    const block = renderRouteSection({
      routes: frontendMapRoutes(CATALOG),
      summaries: new Map([
        ['POST /notify/webhooks', 'Create webhook | or endpoint'],
        ['POST /auth/login', 'Login with email and password'],
      ]),
      reviewNumbers: parseRouteReviewNumbers(REVIEW),
    });
    expect(block).toMatch(/^7 routes, from `docs\/routes.txt`/);
    expect(block).toContain('| [App (the product)](#app-the-product) | 2 |');
    expect(block).toContain(
      '| GET | `/app/social/channel-accounts/:channel_account_id` | `channel:read` |  | team | 6.2 |  |',
    );
    expect(block.indexOf('| GET | `/app/contacts/:contact_id` |')).toBeLessThan(
      block.indexOf('### Platform administration and operations'),
    );
    expect(block).toContain('| [Notifications and webhooks](#notifications-and-webhooks) | 2 |');
    expect(block).toContain(
      '| POST | `/notify/webhooks` | `webhook:create` | req |  | 5.3 | Create webhook \\| or endpoint |',
    );
    expect(block).toContain(
      '| POST | `/tenancy/organization/roles` | `role:create` | req | team | 2.9 |  |',
    );
    expect(block).toContain(
      '| POST | `/auth/login` | public |  |  |  | Login with email and password |',
    );
    expect(block.indexOf('### Platform administration and operations')).toBeLessThan(
      block.indexOf('| GET | `/livez` |'),
    );
  });
});

describe('renderRouteSection — a route that requires several codes (launch D83 (6))', () => {
  it('names each code in the gate column', () => {
    const catalog = `================================================================================
  DOMAIN: NOTIFY (/api/v1/notify)
  Routes: 1
================================================================================

  POST   /api/v1/notify/webhooks/:webhook_id/test                 200  req  both  PERM: webhook:update + webhook:read
`;
    const block = renderRouteSection({
      routes: frontendMapRoutes(catalog),
      summaries: new Map(),
      reviewNumbers: new Map(),
    });
    expect(block).toContain('`webhook:update` + `webhook:read`');
  });
});

describe('spliceGeneratedBlock', () => {
  it('replaces only what sits between the markers', () => {
    const document = `# Map\n\nhand\n\n${GENERATED_BLOCK_START}\nold\n${GENERATED_BLOCK_END}\n\nafter\n`;
    expect(spliceGeneratedBlock({ document, block: 'new' })).toBe(
      `# Map\n\nhand\n\n${GENERATED_BLOCK_START}\n\nnew\n\n${GENERATED_BLOCK_END}\n\nafter\n`,
    );
  });

  it('refuses a map without the markers', () => {
    expect(() => spliceGeneratedBlock({ document: '# Map\n', block: 'new' })).toThrow(
      /no <!-- GENERATED:START -->/,
    );
  });
});

describe('parseFrontendMapArguments', () => {
  it('takes one iteration and --check', () => {
    expect(parseFrontendMapArguments([ITERATION])).toEqual({
      iteration: ITERATION,
      isCheck: false,
    });
    expect(parseFrontendMapArguments([ITERATION, '--check'])).toEqual({
      iteration: ITERATION,
      isCheck: true,
    });
  });

  it('refuses no iteration, two, or an unknown option', () => {
    expect(() => parseFrontendMapArguments([])).toThrow(/Name one iteration/);
    expect(() => parseFrontendMapArguments([ITERATION, 'another'])).toThrow(/Name one iteration/);
    expect(() => parseFrontendMapArguments([ITERATION, '--write'])).toThrow(
      /Unknown option --write/,
    );
  });
});

describe('planFrontendRouteMap', () => {
  it('starts a missing map from the template, with the block in place', () => {
    const repositoryRoot = createIterationRepository();
    addTestIteration({ repositoryRoot, name: ITERATION });
    const plan = planFrontendRouteMap({
      repositoryRoot,
      iteration: ITERATION,
      block: 'the routes',
      isCheck: false,
    });
    expect(plan).toMatchObject({ isNew: true, isChanged: true });
    expect(plan.content).toContain(`# Frontend route map — ${ITERATION}`);
    expect(plan.content).toContain(
      `${GENERATED_BLOCK_START}\n\nthe routes\n\n${GENERATED_BLOCK_END}`,
    );
  });

  it('reports an up-to-date map as unchanged', () => {
    const repositoryRoot = createIterationRepository();
    const folder = addTestIteration({ repositoryRoot, name: ITERATION });
    mkdirSync(join(folder, 'plans'), { recursive: true });
    writeFileSync(
      join(folder, 'plans', 'frontend-route-map.md'),
      `# Map\n\n${GENERATED_BLOCK_START}\n\nthe routes\n\n${GENERATED_BLOCK_END}\n`,
    );
    const plan = planFrontendRouteMap({
      repositoryRoot,
      iteration: ITERATION,
      block: 'the routes',
      isCheck: true,
    });
    expect(plan).toMatchObject({ isNew: false, isChanged: false });
  });

  it('refuses to rewrite a frozen iteration, but still checks it', () => {
    const repositoryRoot = createIterationRepository();
    addTestIteration({ repositoryRoot, name: ITERATION, fields: { status: 'frozen' } });
    expect(() =>
      planFrontendRouteMap({ repositoryRoot, iteration: ITERATION, block: 'x', isCheck: false }),
    ).toThrow(/is frozen/);
    expect(
      planFrontendRouteMap({ repositoryRoot, iteration: ITERATION, block: 'x', isCheck: true })
        .isChanged,
    ).toBe(true);
  });
});
