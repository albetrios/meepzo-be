import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { git } from '@tooling/setup/common/git-environment.js';
import { isMain, parseCommandLine } from '@tooling/setup/common/script.js';

/** How a test lane is called: the options before `--`, the command after it. */
const USAGE = 'pnpm test:lane [--serial] -- <command…>';

/** The highest Redis logical database a lane may take (Redis has 16, 0 is the dev stack's). */
const HIGHEST_REDIS_DATABASE = 15;

/** How often a waiting `--serial` run looks at the lock again. */
const SERIAL_LOCK_POLL_MILLISECONDS = 1_000;

/** The lane settings a worktree's test run gets, as environment variables. */
export interface TestLane {
  /** `TEST_DATABASE_NAME_SUFFIX`; `undefined` for the main checkout (the plain names). */
  readonly databaseNameSuffix: string | undefined;
  /** `TEST_REDIS_DATABASE`; `undefined` for the main checkout (the database of `REDIS_URL`). */
  readonly redisDatabase: number | undefined;
}

/**
 * The lane a checkout's test run is isolated to (feat-instagram-dm-sending P139; be-kickoff-iteration
 * › Parallel lanes).
 *
 * @remarks
 * - **Algorithm:** the main checkout (the first entry of `git worktree list`) runs with the plain names —
 *   nothing set. Every other worktree gets a database-name suffix from its folder name (lower case,
 *   every other character an underscore, at most 32) and the Redis database of its position among the
 *   worktrees (the first extra worktree 1, the next 2, …). A suffix or Redis database already set in the
 *   environment wins.
 * - **Failure modes:** throws when there are more extra worktrees than Redis databases 1–15, or when the
 *   folder name leaves no usable suffix.
 * - **Side effects:** none — pure.
 */
export function resolveTestLane({
  topLevel,
  worktreePaths,
  environment,
}: {
  topLevel: string;
  worktreePaths: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
}): TestLane {
  const presetSuffix = environment.TEST_DATABASE_NAME_SUFFIX;
  const presetRedis = environment.TEST_REDIS_DATABASE;
  const mainPath = worktreePaths[0];
  if (mainPath === undefined || resolve(topLevel) === resolve(mainPath)) {
    return {
      databaseNameSuffix: presetSuffix || undefined,
      redisDatabase: presetRedis ? Number(presetRedis) : undefined,
    };
  }
  const position = worktreePaths.slice(1).findIndex((path) => resolve(path) === resolve(topLevel));
  const redisDatabase = position + 1;
  if (position < 0 || redisDatabase > HIGHEST_REDIS_DATABASE) {
    throw new Error(
      `No free test lane for ${topLevel}: lanes use Redis databases 1–${HIGHEST_REDIS_DATABASE}, one per worktree.`,
    );
  }
  const suffix = basename(topLevel)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(-32);
  if (suffix === '') throw new Error(`The worktree folder ${topLevel} gives no test lane name.`);
  return {
    databaseNameSuffix: presetSuffix || suffix,
    redisDatabase: presetRedis ? Number(presetRedis) : redisDatabase,
  };
}

/**
 * Reads `test:lane`'s command line: `--serial`, then `--` and the command to run.
 *
 * @remarks
 * Failure modes: throws on an unknown option before the command, and when no command follows `--`.
 * Side effects: none.
 */
export function parseLaneArguments(args: readonly string[]): {
  serial: boolean;
  command: string[];
} {
  // A leading `--` is the separator pnpm may forward; when a second `--` follows, the first is that
  // separator and the second starts the command. Everything after the starting `--` is the command,
  // its own options included (`node -e …`, `vitest run --project unit`).
  const given = args[0] === '--' && args.indexOf('--', 1) > 0 ? args.slice(1) : [...args];
  const separator = given.indexOf('--');
  const ownArguments = separator < 0 ? given : given.slice(0, separator);
  const command = separator < 0 ? [] : given.slice(separator + 1);
  const { values } = parseCommandLine({
    args: ownArguments,
    options: { serial: { type: 'boolean' } },
    usage: USAGE,
  });
  if (command.length === 0) throw new Error(`No command to run — ${USAGE}`);
  return { serial: values.serial === true, command };
}

function worktreePaths(): string[] {
  return git({ args: ['worktree', 'list', '--porcelain'] })
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Holds the one lock every worktree of this repository shares, so `--serial` runs (and the commits whose
 * pre-commit hook runs database tests) go one at a time across lanes. A directory is created atomically
 * in the repository's common git folder; a lock whose holder process is gone is taken over.
 */
async function acquireSerialLock(): Promise<() => void> {
  const lockPath = join(
    resolve(git({ args: ['rev-parse', '--git-common-dir'] })),
    'test-lane.lock',
  );
  const holderFile = join(lockPath, 'holder');
  let announced = false;
  for (;;) {
    try {
      mkdirSync(lockPath);
      writeFileSync(holderFile, String(process.pid));
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch {
      const holder = Number.parseInt(readHolder(holderFile), 10);
      if (Number.isInteger(holder) && holder > 0 && !isProcessAlive(holder)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (!announced) {
        process.stderr.write(
          `[test:lane] waiting for the serial lock (held by pid ${holder || '?'})…\n`,
        );
        announced = true;
      }
      await sleep(SERIAL_LOCK_POLL_MILLISECONDS);
    }
  }
}

function readHolder(holderFile: string): string {
  try {
    return readFileSync(holderFile, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Runs a command in this checkout's test lane: its own test databases and Redis database, so worktrees
 * building in parallel never wipe each other's test data (be-kickoff-iteration › Parallel lanes).
 *
 * @remarks
 * - **Algorithm:** resolves the lane ({@link resolveTestLane}), sets `TEST_DATABASE_NAME_SUFFIX` and
 *   `TEST_REDIS_DATABASE`, then runs the command. With `--serial` it first waits for the one lock all
 *   worktrees share — for commits (the pre-commit hook runs database tests) and for runs that must not
 *   share the machine.
 * - **Failure modes:** exits with the command's exit code; 2 on a bad command line or no free lane.
 * - **Side effects:** spawns the command; with `--serial`, a lock directory in the common git folder
 *   while it runs.
 */
export async function runInLane(args: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parseLaneArguments>;
  let lane: TestLane;
  try {
    parsed = parseLaneArguments(args);
    lane = resolveTestLane({
      topLevel: git({ args: ['rev-parse', '--show-toplevel'] }),
      worktreePaths: worktreePaths(),
      environment: process.env,
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const environment: NodeJS.ProcessEnv = { ...process.env };
  if (lane.databaseNameSuffix !== undefined) {
    environment.TEST_DATABASE_NAME_SUFFIX = lane.databaseNameSuffix;
  }
  if (lane.redisDatabase !== undefined)
    environment.TEST_REDIS_DATABASE = String(lane.redisDatabase);
  process.stderr.write(
    `[test:lane] lane ${lane.databaseNameSuffix ?? 'main'} · Redis database ${lane.redisDatabase ?? 'default'}${parsed.serial ? ' · serial' : ''}\n`,
  );
  const release = parsed.serial ? await acquireSerialLock() : () => undefined;
  try {
    const [command = '', ...commandArguments] = parsed.command;
    const result = spawnSync(command, commandArguments, { stdio: 'inherit', env: environment });
    return result.status ?? 1;
  } finally {
    release();
  }
}

if (isMain(import.meta.url)) {
  process.exit(await runInLane(process.argv.slice(2)));
}
