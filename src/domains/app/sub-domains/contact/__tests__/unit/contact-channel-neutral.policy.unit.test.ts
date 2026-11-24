import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Policy (routes-final § 3.B CTC12, CT18, P48): contacts are shared by every channel, so the
 * runtime code of `contact/` — the folder root and its nested `contact-tag-event/` — imports no
 * channel's own sub-domain (`instagram-*`). A channel's intake reaches contacts through the
 * contact service's channel-neutral entry points, never the other way round.
 *
 * Test code (`__tests__/`) is out of scope: its fixtures build Instagram accounts to own contacts.
 */

const CONTACT_FOLDER = 'src/domains/app/sub-domains/contact';
const CHANNEL_IMPORT = /from\s+'@\/domains\/app\/sub-domains\/instagram-[^']*'/g;

/** Every runtime `.ts` file under `directory`, skipping `__tests__/`. */
function runtimeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : runtimeFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('Policy: contacts import no channel sub-domain (CTC12)', () => {
  it('scans the folder root and the nested tag events', () => {
    const files = runtimeFiles(join(process.cwd(), CONTACT_FOLDER)).map((path) =>
      relative(process.cwd(), path),
    );
    expect(files).toContain(`${CONTACT_FOLDER}/contact.service.ts`);
    expect(files).toContain(`${CONTACT_FOLDER}/contact-tag-event/contact-tag-event.service.ts`);
  });

  it('finds no import of an instagram-* folder in the runtime code', () => {
    const offenders = runtimeFiles(join(process.cwd(), CONTACT_FOLDER)).flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(CHANNEL_IMPORT)].map(
        ([statement]) => `${relative(process.cwd(), path)}: ${statement}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
