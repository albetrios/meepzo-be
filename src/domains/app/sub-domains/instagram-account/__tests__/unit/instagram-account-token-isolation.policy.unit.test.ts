import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Policy (launch IA5, IAC5): the Instagram token stays ciphertext everywhere but the Instagram
 * client.
 *
 * Three rules over the runtime code of `src/`, `tooling/` and `scripts/`:
 *
 * 1. Only {@link TOKEN_SCHEMA_IMPORTERS} import the token schema
 *    (`instagram-account-token.schema.ts`, the table `app.instagram_account_tokens`).
 * 2. Only {@link TOKEN_REPOSITORY_IMPORTERS} import the token repository
 *    (`instagram-account-token.repository.ts`, the only code that reads the table). Everything
 *    else — the account service included — reaches the token through `InstagramAccountTokenService`
 *    and holds `encrypted_access_token` only.
 * 3. Only {@link TOKEN_DECRYPTERS} — the Instagram client
 *    (`src/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.ts`) and the secrets-key rotation script — call
 *    `decryptFieldSecret` on the token: no other file under the Instagram surface
 *    (`src/domains/app/`) references `decryptFieldSecret`, and no
 *    other file anywhere references it together with the token's names.
 *
 * Test code — anything under `src/tests/` or a `__tests__/` folder, and every `*.test.ts` — is out
 * of scope, as in `maintenance-context-confinement.policy.unit.test.ts`: the RLS matrix, the
 * resolvers' security test and the token's database tests write and read the table to prove these
 * rules, and the contract test decrypts to prove the client encrypts. They never ship.
 *
 * The allowlists are exact paths, each with its reason. The daily check's processor (launch R7,
 * IA8) is the one worker path in {@link TOKEN_REPOSITORY_IMPORTERS} — IA5's "only the token service
 * and the daily check"; any other addition is deliberate, never casual.
 * The secrets-key rotation script (D37) is in {@link TOKEN_SCHEMA_IMPORTERS} and
 * {@link TOKEN_DECRYPTERS}: it re-encrypts the column onto the current key version.
 */

const PROJECT_ROOT = process.cwd();
const SCAN_ROOTS = ['src', 'tooling', 'scripts'] as const;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '__tests__']);

const INSTAGRAM_ACCOUNT_FOLDER = 'src/domains/app/sub-domains/instagram-account';
const TOKEN_SCHEMA_FILE = `${INSTAGRAM_ACCOUNT_FOLDER}/instagram-account-token.schema.ts`;
const TOKEN_REPOSITORY_FILE = `${INSTAGRAM_ACCOUNT_FOLDER}/instagram-account-token.repository.ts`;
const TOKEN_SERVICE_FILE = `${INSTAGRAM_ACCOUNT_FOLDER}/instagram-account-token.service.ts`;
const INSTAGRAM_CLIENT_FILE =
  'src/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.ts';
const SECRETS_KEY_ROTATION_FILE = 'src/scripts/ops/secrets-key-rotate.ts';
const SECRETS_KEY_ROTATION_REASON =
  'the operator secrets-key rotation (pnpm ops:secrets:rotate) re-encrypts every stored token onto the current SECRETS_ENCRYPTION key version, as it does every encryptFieldSecret column (D37); it never logs or returns a token';

/** The runtime files that may import the token schema, each with why. */
const TOKEN_SCHEMA_IMPORTERS: ReadonlyArray<{ file: string; reason: string }> = [
  { file: TOKEN_REPOSITORY_FILE, reason: 'the only code that reads and writes the table' },
  {
    file: `${INSTAGRAM_ACCOUNT_FOLDER}/seed/instagram-account.bulk.seed.ts`,
    reason: 'writes a fake encryptFieldSecret token for each demo team; never reads one back',
  },
  { file: SECRETS_KEY_ROTATION_FILE, reason: SECRETS_KEY_ROTATION_REASON },
];

/** The runtime files that may import the token repository, each with why. */
const TOKEN_REPOSITORY_IMPORTERS: ReadonlyArray<{ file: string; reason: string }> = [
  { file: TOKEN_SERVICE_FILE, reason: 'the one service over the token table' },
  {
    file: 'src/domains/app/app.container.ts',
    reason: 'the composition root builds the repository for the token service, and nothing else',
  },
  {
    file: `${INSTAGRAM_ACCOUNT_FOLDER}/workers/instagram-account-daily-check.processor.ts`,
    reason:
      'the daily check (IA8): reads the ciphertext for the renewal, replaces it only while it is still the token renewed, and keeps a failed renewal error; it hands the ciphertext to the client and never decrypts it',
  },
];

/** The runtime files that may call `decryptFieldSecret` on the token, each with why. */
const TOKEN_DECRYPTERS: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: INSTAGRAM_CLIENT_FILE,
    reason: 'decrypts right before each Instagram call; the plain token never leaves it',
  },
  { file: SECRETS_KEY_ROTATION_FILE, reason: SECRETS_KEY_ROTATION_REASON },
];

/** Names that mark a file as handling the Instagram token. */
const TOKEN_NAME_PATTERN =
  /encrypted_access_token|encryptedAccessToken|instagram_account_tokens|instagram-account-token\./;

function isTestCode(file: string): boolean {
  return file.startsWith('src/tests/') || file.endsWith('.test.ts');
}

function collectRuntimeFiles(directory: string, accumulator: string[] = []): string[] {
  if (!existsSync(directory)) return accumulator;
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry)) collectRuntimeFiles(fullPath, accumulator);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    const file = relative(PROJECT_ROOT, fullPath);
    if (!isTestCode(file)) accumulator.push(file);
  }
  return accumulator;
}

/** An import or re-export specifier — static or dynamic — that names `moduleName`. */
function importsModule({ source, moduleName }: { source: string; moduleName: string }): boolean {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['"][^'"\\n]*/${escaped}(?:\\.js)?['"]`).test(source);
}

const runtimeSources = new Map(
  SCAN_ROOTS.flatMap((root) => collectRuntimeFiles(join(PROJECT_ROOT, root))).map(
    (file) => [file, readFileSync(join(PROJECT_ROOT, file), 'utf8')] as const,
  ),
);

function importersOf(moduleName: string): string[] {
  return [...runtimeSources]
    .filter(([, source]) => importsModule({ source, moduleName }))
    .map(([file]) => file)
    .sort();
}

describe('Instagram token isolation (policy, IA5)', () => {
  it('scans the token files and the Instagram client', () => {
    for (const file of [
      TOKEN_SCHEMA_FILE,
      TOKEN_REPOSITORY_FILE,
      TOKEN_SERVICE_FILE,
      INSTAGRAM_CLIENT_FILE,
    ]) {
      expect(runtimeSources.has(file), `${file} is not scanned`).toBe(true);
    }
    expect(runtimeSources.get(INSTAGRAM_CLIENT_FILE)).toContain('decryptFieldSecret(');
  });

  it('every allowlisted file exists', () => {
    for (const { file } of [
      ...TOKEN_SCHEMA_IMPORTERS,
      ...TOKEN_REPOSITORY_IMPORTERS,
      ...TOKEN_DECRYPTERS,
    ]) {
      expect(existsSync(join(PROJECT_ROOT, file)), `${file} does not exist`).toBe(true);
    }
  });

  it('only the allowlisted files import the token schema', () => {
    const allowed = new Set(TOKEN_SCHEMA_IMPORTERS.map(({ file }) => file));
    const offenders = importersOf('instagram-account-token.schema').filter(
      (file) => !allowed.has(file),
    );
    expect(
      offenders,
      `the Instagram token schema is imported outside its allowlist: ${offenders.join(', ')}. ` +
        'Reach the token through InstagramAccountTokenService (IA5).',
    ).toEqual([]);
  });

  it('only the allowlisted files import the token repository', () => {
    const allowed = new Set(TOKEN_REPOSITORY_IMPORTERS.map(({ file }) => file));
    const offenders = importersOf('instagram-account-token.repository').filter(
      (file) => !allowed.has(file),
    );
    expect(
      offenders,
      `the Instagram token repository is imported outside its allowlist: ${offenders.join(', ')}. ` +
        'Reach the token through InstagramAccountTokenService (IA5).',
    ).toEqual([]);
  });

  it('only the allowlisted files call decryptFieldSecret on the token', () => {
    const allowed = new Set(TOKEN_DECRYPTERS.map(({ file }) => file));
    const offenders = [...runtimeSources]
      .filter(([file]) => !allowed.has(file))
      .filter(([, source]) => source.includes('decryptFieldSecret'))
      .filter(
        ([file, source]) => file.startsWith('src/domains/app/') || TOKEN_NAME_PATTERN.test(source),
      )
      .map(([file]) => file)
      .sort();
    expect(
      offenders,
      `decryptFieldSecret used on the Instagram token outside the client: ${offenders.join(', ')}. ` +
        'Hand the client the ciphertext; it decrypts right before its call (IA5).',
    ).toEqual([]);
  });
});
