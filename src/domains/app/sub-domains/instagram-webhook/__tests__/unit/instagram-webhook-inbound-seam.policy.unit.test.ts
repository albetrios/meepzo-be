import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Policy (feat-instagram-dm-sending § 5 WHC17, WH27, P48): the inbound seam points one way —
 * Instagram's intake calls the shared contacts, run engine and broadcasts through their entry points
 * with normalized event kinds, and none of them imports anything from `instagram-webhook/`. A later
 * channel's intake then reuses the same entry points.
 *
 * Test code (`__tests__/`) is out of scope. `broadcast/` is scanned once it exists (ROUTE row R22).
 */

const SHARED_FOLDERS = [
  'src/domains/app/sub-domains/contact',
  'src/domains/app/sub-domains/automation',
  'src/domains/app/sub-domains/broadcast',
];
const INTAKE_IMPORT = /from\s+'@\/domains\/app\/sub-domains\/instagram-webhook\/[^']*'/g;

/** Every runtime `.ts` file under `directory`, skipping `__tests__/`. */
function runtimeFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : runtimeFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('Policy: the shared sub-domains import nothing from instagram-webhook/ (WHC17)', () => {
  it('scans contacts and the run engine', () => {
    const files = SHARED_FOLDERS.flatMap((folder) => runtimeFiles(join(process.cwd(), folder))).map(
      (path) => relative(process.cwd(), path),
    );
    expect(files).toContain('src/domains/app/sub-domains/contact/contact.service.ts');
    expect(files).toContain(
      'src/domains/app/sub-domains/automation/automation-run/automation-run.service.ts',
    );
  });

  it('finds no import of instagram-webhook/ in their runtime code', () => {
    const offenders = SHARED_FOLDERS.flatMap((folder) =>
      runtimeFiles(join(process.cwd(), folder)),
    ).flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(INTAKE_IMPORT)].map(
        ([statement]) => `${relative(process.cwd(), path)}: ${statement}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
