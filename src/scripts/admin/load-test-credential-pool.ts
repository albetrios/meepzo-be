/**
 * Load-test credential pool generator.
 *
 * Run AFTER `pnpm db:seed:bulk` (or via `pnpm db:seed:loadtest` which chains both).
 * Joins users → memberships → organizations to export `src/tests/load/k6/data/credential-pool.json`,
 * one entry per distinct user with an active bulk membership. k6 scenarios index into this pool by
 * `__VU` so each VU signs in as a distinct user — by email code (passwords are off, P84): the target
 * runs with `TEST_MODE`, so `POST /auth/email/send-code` echoes the code (`helpers/auth.js`).
 *
 * Usage:
 *   pnpm tool:load-test-credential-pool      (after bulk seed exists)
 *   pnpm db:seed:loadtest                    (runs bulk seed then this script)
 */
import { MEMBERSHIP_STATUS } from '@/domains/tenancy/sub-domains/membership/membership.constants.js';
import '@/shared/config/load-env-files.js';
import '@/scripts/seed/seed-runtime-url.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { closeDatabase } from '@/infrastructure/database/connection.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { assertBulkSeedAllowed } from '@/scripts/seed/production-guard.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { parseCommandLine } from '@tooling/setup/common/script.js';

parseCommandLine({ args: process.argv.slice(2) });

const BULK_EMAIL_PATTERN = 'bulk-user-%@seed.local';
const BULK_ORG_SLUG_PATTERN = 'bulk-organization-%';
const OUTPUT_PATH = join(process.cwd(), 'src/tests/load/k6/data/credential-pool.json');

/** One row in the exported credential pool. */
export interface CredentialPoolEntry {
  /** Deterministic bulk email; indexes the user across runs. */
  email: string;
  /** Public id of the organization this user is an active member of (used to scope tokens). */
  organizationPublicId: string;
  /** Public id of this user (for assertions in scenario checks). */
  userPublicId: string;
}

async function run(env: NodeJS.ProcessEnv): Promise<void> {
  assertBulkSeedAllowed(env);

  const database = getRequestDatabase();

  // Export one deterministic organization per distinct user. Reusing a user
  // across VUs can rebind its session and invalidate another VU's scoped token.
  //
  // MFA accounts are excluded, and the two exclusions below mirror `completeFirstFactorAuth`'s
  // gate exactly (`user.is_mfa_enabled || organizationRequiresMfa`). For such an account the
  // first factor succeeds with HTTP 200 but the body is an `mfa_required` envelope carrying an
  // `mfa_session_token` instead of an `access_token` — so a k6 VU that draws one reads no token
  // and silently abandons its journey partway. That does not fail loudly; it just removes VUs
  // from every route after login, quietly understating concurrency and skewing every number in
  // the run. The bulk seeder sets `security_policy.mfa_required` on a share of its organizations,
  // so without this filter a third of the pool is unusable.
  const rows = await database
    .select({
      email: users.email,
      userPublicId: users.public_id,
      organizationPublicId: organizations.public_id,
    })
    .from(users)
    .innerJoin(memberships, eq(memberships.user_id, users.id))
    .innerJoin(organizations, eq(organizations.id, memberships.organization_id))
    .where(
      and(
        like(users.email, BULK_EMAIL_PATTERN),
        like(organizations.slug, BULK_ORG_SLUG_PATTERN),
        eq(users.status, 'ACTIVE'),
        isNull(users.deleted_at),
        eq(organizations.status, 'ACTIVE'),
        isNull(organizations.deleted_at),
        eq(memberships.status, MEMBERSHIP_STATUS.ACTIVE),
        isNull(memberships.deleted_at),
        eq(users.is_mfa_enabled, false),
        // Same SECURITY DEFINER resolver the login path uses, so this can never drift from it.
        sql`NOT tenancy.user_has_organization_requiring_mfa(${users.id})`,
      ),
    )
    .orderBy(users.public_id, organizations.public_id);

  if (rows.length === 0) {
    throw new Error('No eligible bulk users found; run pnpm db:seed:bulk first');
  }

  const uniqueRows = [...new Map(rows.map((row) => [row.userPublicId, row])).values()];

  const pool: CredentialPoolEntry[] = uniqueRows.map((row) => ({
    email: row.email,
    organizationPublicId: row.organizationPublicId,
    userPublicId: row.userPublicId,
  }));

  // Write the pool JSON (gitignored).
  await mkdir(join(process.cwd(), 'src/tests/load/k6/data'), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(pool, null, 2));

  logger.info(
    { entries: pool.length, path: OUTPUT_PATH },
    'load-test-credential-pool: pool written — use helpers/pool.js in k6 scenarios for per-VU auth',
  );
}

run(process.env)
  .catch((error) => {
    logger.error({ error }, 'load-test-credential-pool: failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
