import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { describe, expect, it } from 'vitest';
import { envSchemaDefaults, envSchemaKeys } from '@/shared/config/env-schema.js';
import * as sendingConstants from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';

/**
 * The engine's numbers live in the one sending constants file and the one environment-varying
 * switch is `SENDING_ENABLED`, off by default and on in the template (AC-17.25, P4, P74).
 */
describe('the sending settings file and the sending switch (AC-17.25)', () => {
  it('defaults SENDING_ENABLED to false in the env schema and ships it on in .env.example', () => {
    expect(envSchemaDefaults.SENDING_ENABLED).toBe('false');
    const template = dotenv.parse(readFileSync(join(process.cwd(), '.env.example'), 'utf8'));
    expect(template.SENDING_ENABLED).toBe('true');
  });

  it('keeps the limits, the stop words and the core settings in the constants file, not in env', () => {
    expect(sendingConstants).toMatchObject({
      OPENING_HOUR_LIMIT_DEFAULT: expect.any(Number),
      FAST_HOUR_LIMIT_DEFAULT: expect.any(Number),
      PERSON_HOUR_LIMIT_DEFAULT: expect.any(Number),
      BROADCAST_HOUR_LIMIT_DEFAULT: expect.any(Number),
      STOP_WORDS: expect.any(Array),
      SENDING_SETTINGS_VERSION: expect.any(String),
      INSTAGRAM_SEND_CORE_SETTINGS: expect.objectContaining({
        leaseSeconds: expect.any(Number),
        halfSpeedHours: expect.any(Number),
        appLimitWindowMinutes: expect.any(Number),
      }),
    });
    // The only env vars of the sending engine are the switch and the environment id (SN7).
    expect(envSchemaKeys.filter((key) => key.startsWith('SENDING_')).sort()).toEqual([
      'SENDING_ENABLED',
      'SENDING_ENVIRONMENT_ID',
    ]);
    const engineNames = [
      ...Object.keys(sendingConstants),
      ...Object.keys(sendingConstants.INSTAGRAM_SEND_CORE_SETTINGS).map((name) =>
        name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase(),
      ),
    ];
    for (const name of engineNames) expect(envSchemaKeys).not.toContain(name);
  });
});
