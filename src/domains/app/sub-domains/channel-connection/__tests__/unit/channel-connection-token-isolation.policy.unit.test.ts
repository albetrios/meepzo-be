import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Policy (launch IA5, IAC5; moved to the channel connection by feat-instagram-dm-sending MC9,
 * MCC1, MCC11): the connection's token stays ciphertext everywhere but the Meta client.
 *
 * Three rules over the runtime code of `src/`, `tooling/` and `scripts/`:
 *
 * 1. Only {@link TOKEN_SCHEMA_IMPORTERS} import the token schema
 *    (`channel-connection-token.schema.ts`, the table `app.channel_connection_tokens` — its
 *    `encrypted_access_token` and `encrypted_refresh_token`).
 * 2. Only {@link TOKEN_REPOSITORY_IMPORTERS} import the token repository
 *    (`channel-connection-token.repository.ts`, the only code that reads the table). Everything
 *    else — the account and connection services included — reaches the token through
 *    `ChannelConnectionTokenService` and holds ciphertext only.
 * 3. Only {@link TOKEN_DECRYPTERS} — the Meta client
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
 * The allowlists are exact paths, each with its reason. The daily account check's processor (launch
 * R7, IA8) is the one worker path in {@link TOKEN_REPOSITORY_IMPORTERS} today — MC9's "the token
 * service, the sender and the token check" (the sender lands at ROUTE row R42, the token check at
 * R51); any other addition is deliberate, never casual.
 * The secrets-key rotation script (D37) is in {@link TOKEN_SCHEMA_IMPORTERS} and
 * {@link TOKEN_DECRYPTERS}: it re-encrypts the column onto the current key version.
 */

const PROJECT_ROOT = process.cwd();
const SCAN_ROOTS = ['src', 'tooling', 'scripts'] as const;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '__tests__']);

const INSTAGRAM_ACCOUNT_FOLDER = 'src/domains/app/sub-domains/instagram-account';
const CHANNEL_CONNECTION_FOLDER = 'src/domains/app/sub-domains/channel-connection';
const TOKEN_SCHEMA_FILE = `${CHANNEL_CONNECTION_FOLDER}/channel-connection-token.schema.ts`;
const TOKEN_REPOSITORY_FILE = `${CHANNEL_CONNECTION_FOLDER}/channel-connection-token.repository.ts`;
const TOKEN_SERVICE_FILE = `${CHANNEL_CONNECTION_FOLDER}/channel-connection-token.service.ts`;
const INSTAGRAM_CLIENT_FILE =
  'src/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.ts';
const SECRETS_KEY_ROTATION_FILE = 'src/scripts/ops/secrets-key-rotate.ts';
const SECRETS_KEY_ROTATION_REASON =
  'the operator secrets-key rotation (pnpm ops:secrets:rotate) re-encrypts every stored token onto the current SECRETS_ENCRYPTION key version, as it does every encryptFieldSecret column (D37); it never logs or returns a token';

/** The runtime files that may import the token schema, each with why. */
const TOKEN_SCHEMA_IMPORTERS: ReadonlyArray<{ file: string; reason: string }> = [
  { file: TOKEN_REPOSITORY_FILE, reason: 'the only code that reads and writes the table' },
  {
    file: `${CHANNEL_CONNECTION_FOLDER}/seed/channel-connection.bulk.seed.ts`,
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
      "the daily account check (IA8): reads the account's connection ciphertext for its Meta calls and hands it to the client; it never decrypts or writes it (no renewal since WC-35)",
  },
  {
    file: `${INSTAGRAM_ACCOUNT_FOLDER}/workers/instagram-account-tasks.processor.ts`,
    reason:
      "the account jobs (IA6, R40 — set-up, subscription check, starter-question sync): read the account's connection ciphertext in the job's scope and hand it to the client; they never decrypt or write it",
  },
];

/** The runtime files that may call `decryptFieldSecret` on the token, each with why. */
const TOKEN_DECRYPTERS: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: INSTAGRAM_CLIENT_FILE,
    reason: 'decrypts right before each Meta call; the plain token never leaves it',
  },
  { file: SECRETS_KEY_ROTATION_FILE, reason: SECRETS_KEY_ROTATION_REASON },
];

/** Names that mark a file as handling the connection's token. */
const TOKEN_NAME_PATTERN =
  /encrypted_access_token|encryptedAccessToken|encrypted_refresh_token|encryptedRefreshToken|channel_connection_tokens|channel-connection-token\./;

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

describe('Channel connection token isolation (policy, MC9)', () => {
  it('scans the token files and the Meta client', () => {
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
    const offenders = importersOf('channel-connection-token.schema').filter(
      (file) => !allowed.has(file),
    );
    expect(
      offenders,
      `the channel connection token schema is imported outside its allowlist: ${offenders.join(', ')}. ` +
        'Reach the token through ChannelConnectionTokenService (MC9).',
    ).toEqual([]);
  });

  it('only the allowlisted files import the token repository', () => {
    const allowed = new Set(TOKEN_REPOSITORY_IMPORTERS.map(({ file }) => file));
    const offenders = importersOf('channel-connection-token.repository').filter(
      (file) => !allowed.has(file),
    );
    expect(
      offenders,
      `the channel connection token repository is imported outside its allowlist: ${offenders.join(', ')}. ` +
        'Reach the token through ChannelConnectionTokenService (MC9).',
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
