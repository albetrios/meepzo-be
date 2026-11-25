import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Policy (feat-instagram-dm-sending routes-final § 4.C AUC13, AU34, P48): automations are shared by
 * every channel, so the runtime code of the `automation/` folder root imports no channel's own
 * sub-domain (`instagram-*`) — it reaches accounts and the one feature check through the channel
 * account (1B), and a channel's sending through `app.channel-ports.ts`.
 *
 * Since ROUTE row R14 the scan covers the nested `automation-run/` too — the run engine saves its
 * steps through `ChannelSendingPort` and reads the account's rules through the channel account
 * (AU35, AU34). Out of scope: test code (`__tests__/`).
 */

const AUTOMATION_FOLDER = 'src/domains/app/sub-domains/automation';
const CHANNEL_IMPORT = /from\s+'@\/domains\/app\/sub-domains\/instagram-[^']*'/g;

/** Every runtime `.ts` file under `directory`, skipping `__tests__/`. */
function runtimeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return name === '__tests__' ? [] : runtimeFiles(path);
    }
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('Policy: automations import no channel sub-domain (AUC13)', () => {
  it('scans the folder root, its persistence parts, the run engine, workers and seed', () => {
    const files = runtimeFiles(join(process.cwd(), AUTOMATION_FOLDER)).map((path) =>
      relative(process.cwd(), path),
    );
    expect(files).toContain(`${AUTOMATION_FOLDER}/automation.service.ts`);
    expect(files).toContain(`${AUTOMATION_FOLDER}/automation-count.service.ts`);
    expect(files).toContain(`${AUTOMATION_FOLDER}/seed/automation.bulk.seed.ts`);
    expect(files).toContain(`${AUTOMATION_FOLDER}/automation-run/automation-run.service.ts`);
    expect(files).toContain(`${AUTOMATION_FOLDER}/automation-run/seed/automation-run.bulk.seed.ts`);
  });

  it('finds no import of an instagram-* folder in the runtime code', () => {
    const offenders = runtimeFiles(join(process.cwd(), AUTOMATION_FOLDER)).flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(CHANNEL_IMPORT)].map(
        ([statement]) => `${relative(process.cwd(), path)}: ${statement}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
