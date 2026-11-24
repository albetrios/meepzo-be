/**
 * The global sending row (feat-instagram-dm-sending routes-final § 6 SN7, P95): creates
 * `app.sending_states` with this server's `SENDING_ENVIRONMENT_ID` when it is missing (never
 * overwritten) and writes this build's settings versions — the step `prepareDatabase` runs on every
 * deploy — or, with `--minimum <version>`, sets the minimum compatible settings version: the rollback
 * step before rolling back past an incompatible release (be-path-to-production › Rollback).
 *
 * Usage:
 *   pnpm ops:sending-state                 # create the row when missing, write the versions
 *   pnpm ops:sending-state --minimum 3     # lower (or set) the minimum compatible version to 3
 *
 * Runs in its own process (as the migration runner does), so its database pools close with it.
 */
import { isMain, parseCommandLine } from '@tooling/setup/common/script.js';

/** Creates the row or sets the minimum; returns the line to print. */
export async function runSendingStateCommand({
  minimum,
}: {
  minimum: string | undefined;
}): Promise<string> {
  const { env } = await import('@/shared/config/env.config.js');
  const { SendingStateService } = await import(
    '@/domains/app/sub-domains/instagram-sending/sending-state.service.js'
  );
  const { closeDatabase } = await import('@/infrastructure/database/connection.js');
  const service = new SendingStateService();
  try {
    if (minimum !== undefined) {
      if (!/^[0-9]{1,32}$/.test(minimum)) throw new Error('--minimum must be a whole number');
      const state = await service.setMinimumCompatibleSettingsVersion(minimum);
      if (state === null)
        throw new Error('app.sending_states has no row — run it without --minimum first');
      return `minimum compatible settings version set to ${state.minimum_compatible_settings_version}`;
    }
    const environmentId = env.SENDING_ENVIRONMENT_ID;
    if (environmentId === undefined) return 'skipped — SENDING_ENVIRONMENT_ID is not set';
    const { created, state } = await service.ensureSendingState({ environmentId });
    const versions = `settings version ${state?.settings_version ?? '?'}, minimum ${state?.minimum_compatible_settings_version ?? '?'}`;
    if (created) return `created for environment ${environmentId}; ${versions}`;
    const match =
      state?.environment_id === environmentId ? 'matches' : `is ${state?.environment_id}`;
    return `kept (environment ${match}); ${versions}`;
  } finally {
    await closeDatabase();
  }
}

async function main(): Promise<void> {
  await import('@/shared/config/load-env-files.js');
  const { values } = parseCommandLine({
    args: process.argv.slice(2),
    options: { minimum: { type: 'string' } },
  });
  const line = await runSendingStateCommand({ minimum: values.minimum });
  process.stdout.write(`${line}\n`);
}

if (isMain(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
