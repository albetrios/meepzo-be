/**
 * Runbook-as-code: re-encrypt field secrets onto the current SECRETS_ENCRYPTION key version
 * (pnpm ops:secrets:rotate).
 *
 * Walks every encrypted field-secret column ({@link FIELD_SECRET_ROTATION_COLUMNS}: MFA TOTP
 * seeds, webhook signing keys, the Instagram access token), decrypts each value using the key for
 * its OWN stored version prefix, and re-encrypts it with `SECRETS_ENCRYPTION_CURRENT_VERSION`.
 * Pair with a `SECRETS_ENCRYPTION_KEYS` keyring that holds both the old and new versions so
 * decryption of in-place rows keeps working during the cutover.
 *
 * DRY-RUN SAFE: the default never mutates anything. It reports how many rows would change. Pass
 * `--apply` to write the re-encrypted values back.
 *
 * Connection: it reads every row on the `DATABASE_URL` pool outside any database context, so it
 * must connect as a role that bypasses RLS. All three tables are FORCE RLS, and the Instagram token
 * table has no maintenance arm at all (launch IA5); as the RLS-subject `meepzo_be_app` role it
 * finds no rows and reports zero.
 *
 * Usage:
 *   pnpm ops:secrets:rotate                 # report-only (dry-run)
 *   pnpm ops:secrets:rotate --apply         # re-encrypt rows to the current version (mutates)
 *
 * Rotation procedure (zero downtime):
 *   1. Generate a new 64-hex key (e.g. `openssl rand -hex 32`).
 *   2. Set SECRETS_ENCRYPTION_KEYS to a JSON map containing both versions, e.g.
 *      {"v1":"<old-hex>","v2":"<new-hex>"} (v1 may also stay in SECRETS_ENCRYPTION_KEY).
 *   3. Deploy with SECRETS_ENCRYPTION_CURRENT_VERSION=v2 so new writes use v2 while v1 rows
 *      still decrypt via the keyring.
 *   4. Run `pnpm ops:secrets:rotate --apply` to migrate existing v1 rows to v2.
 *   5. Once no v1 rows remain, drop v1 from SECRETS_ENCRYPTION_KEYS (and SECRETS_ENCRYPTION_KEY).
 */
import '@/shared/config/load-env-files.js';
import { eq, isNotNull, sql as drizzleSql } from 'drizzle-orm';
import { database, closeDatabase } from '@/infrastructure/database/connection.js';
import { mfa_methods } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa-method.schema.js';
import { webhooks } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { instagram_account_tokens } from '@/domains/app/sub-domains/instagram-account/instagram-account-token.schema.js';
import { getEnv } from '@/shared/config/env.config.js';
import {
  decryptFieldSecret,
  encryptFieldSecret,
} from '@/shared/utils/security/field-secret-encryption.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { isMain, parseCommandLine } from '@tooling/setup/common/script.js';

interface RotateOptions {
  apply: boolean;
}

function parseOptions(): RotateOptions {
  const { values } = parseCommandLine({
    args: process.argv.slice(2),
    options: { apply: { type: 'boolean' } },
  });
  return { apply: values.apply === true };
}

/** Current write-version prefix (e.g. `v1:`) that fully-migrated rows already carry. */
function currentVersionPrefix(): string {
  return `${getEnv().SECRETS_ENCRYPTION_CURRENT_VERSION}:`;
}

/**
 * Re-encrypts one stored value onto the current version. Returns the rewritten value plus a
 * `changed` flag; rows already at the current version are left byte-for-byte untouched.
 */
function reencryptToCurrentVersion({
  stored,
  currentPrefix,
}: {
  stored: string | null;
  currentPrefix: string;
}): { next: string | null; changed: boolean } {
  if (stored === null || stored.length === 0) {
    return { next: stored, changed: false };
  }
  if (stored.startsWith(currentPrefix)) {
    return { next: stored, changed: false };
  }
  const next = encryptFieldSecret(decryptFieldSecret(stored));
  return { next, changed: next !== stored };
}

/** One stored value a rotation pass reads: its row id and its ciphertext. */
interface StoredFieldSecret {
  id: number;
  stored: string | null;
}

/**
 * One encrypted field-secret column the rotation walks: how to read every stored value, and how to
 * write one re-encrypted value back by row id.
 */
interface FieldSecretRotationColumn {
  /** `<schema>.<table>.<column>` — the name the report and the runbook use. */
  column: string;
  readStoredValues: () => Promise<StoredFieldSecret[]>;
  writeStoredValue: (row: { id: number; next: string }) => Promise<void>;
}

/**
 * Every encrypted field-secret column, in the order the rotation walks them. A new
 * `encryptFieldSecret` column joins here, or a key rotation leaves its rows unreadable once the old
 * version leaves the keyring.
 *
 * @remarks
 * Each entry reads and writes its table directly on the `DATABASE_URL` pool (see the file header
 * for the role this needs). The Instagram access token (launch D37) is ciphertext everywhere but
 * the Instagram client (IA5); this script is the one other runtime file that decrypts it, pinned
 * by `instagram-account-token-isolation.policy.unit.test.ts`.
 */
export const FIELD_SECRET_ROTATION_COLUMNS: readonly FieldSecretRotationColumn[] = [
  {
    column: 'auth.mfa_methods.encrypted_secret',
    readStoredValues: async () =>
      database
        .select({ id: mfa_methods.id, stored: mfa_methods.encrypted_secret })
        .from(mfa_methods)
        .where(isNotNull(mfa_methods.encrypted_secret)),
    writeStoredValue: async ({ id, next }) => {
      await database
        .update(mfa_methods)
        .set({ encrypted_secret: next })
        .where(eq(mfa_methods.id, id));
    },
  },
  {
    column: 'notify.webhooks.encrypted_secret',
    readStoredValues: async () =>
      database.select({ id: webhooks.id, stored: webhooks.encrypted_secret }).from(webhooks),
    writeStoredValue: async ({ id, next }) => {
      await database.update(webhooks).set({ encrypted_secret: next }).where(eq(webhooks.id, id));
    },
  },
  {
    column: 'app.instagram_account_tokens.encrypted_access_token',
    readStoredValues: async () =>
      database
        .select({
          id: instagram_account_tokens.id,
          stored: instagram_account_tokens.encrypted_access_token,
        })
        .from(instagram_account_tokens),
    writeStoredValue: async ({ id, next }) => {
      await database
        .update(instagram_account_tokens)
        .set({ encrypted_access_token: next })
        .where(eq(instagram_account_tokens.id, id));
    },
  },
];

/** How many rows of each column were (or, on a dry run, would be) re-encrypted. */
export interface FieldSecretRotationReport {
  apply: boolean;
  currentVersion: string;
  /** Keyed by {@link FieldSecretRotationColumn.column}. */
  updatedByColumn: Record<string, number>;
}

/**
 * Re-encrypts every value of {@link FIELD_SECRET_ROTATION_COLUMNS} that is not on the current
 * `SECRETS_ENCRYPTION_CURRENT_VERSION` yet.
 *
 * @remarks
 * - **Algorithm:** per column, read every stored value; skip empty ones and ones already carrying
 *   the current version prefix; decrypt with the key of the value's own version and encrypt with
 *   the current one; write it back by row id when `apply` is set.
 * - **Failure modes:** throws on the first value that does not decrypt (a version missing from the
 *   keyring, a corrupt value) — the rows written before it stay rotated, and a rerun skips them.
 * - **Side effects:** with `apply`, one `UPDATE` per changed row; none on a dry run.
 * - **Notes:** idempotent — a second pass reports zero.
 */
export async function rotateFieldSecrets({
  apply,
}: {
  apply: boolean;
}): Promise<FieldSecretRotationReport> {
  const currentPrefix = currentVersionPrefix();
  const updatedByColumn: Record<string, number> = {};
  for (const { column, readStoredValues, writeStoredValue } of FIELD_SECRET_ROTATION_COLUMNS) {
    let updated = 0;
    for (const row of await readStoredValues()) {
      const { next, changed } = reencryptToCurrentVersion({ stored: row.stored, currentPrefix });
      if (!changed || next === null) continue;
      updated += 1;
      if (apply) await writeStoredValue({ id: row.id, next });
    }
    updatedByColumn[column] = updated;
  }
  return { apply, currentVersion: getEnv().SECRETS_ENCRYPTION_CURRENT_VERSION, updatedByColumn };
}

async function main(): Promise<void> {
  const options = parseOptions();

  await database.execute(drizzleSql`select 1`);

  const report = await rotateFieldSecrets({ apply: options.apply });
  logger.info(report, options.apply ? 'secrets-key-rotate.complete' : 'secrets-key-rotate.dry-run');

  await closeDatabase();
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    logger.error({ error }, 'secrets-key-rotate.failed');
    process.exitCode = 1;
  });
}
