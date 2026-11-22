# Field secrets management

Application-level encryption for short secrets at rest (MFA TOTP seeds, webhook signing keys).

## Key material

| Env var                              | Half     | Purpose                                                                 |
| ------------------------------------ | -------- | ----------------------------------------------------------------------- |
| `SECRETS_ENCRYPTION_KEY`             | Secret   | Single AES-256-GCM key (64 hex chars) — the `v1` key / default path      |
| `SECRETS_ENCRYPTION_KEYS`            | Secret   | **Optional** version→hex keyring (JSON) for zero-downtime rotation       |
| `SECRETS_ENCRYPTION_CURRENT_VERSION` | Variable | Version used when **encrypting** new values (`v1` or `v2`; default `v1`)  |

- Generate a key with `openssl rand -hex 32` (64 hex characters = 32 bytes).
- `SECRETS_ENCRYPTION_KEY` is **required in every runtime.** Boot fails when it is missing; `NODE_ENV` is metadata only.
- Generate this key independently — never derive it from another secret (`RESPONSE_ENCRYPTION_KEY`,
  the JWT key pair).
- Each stored value carries its own `<version>:` prefix; **decryption always resolves the key for that stored version**, while encryption uses `SECRETS_ENCRYPTION_CURRENT_VERSION`.

## Rotation

`SECRETS_ENCRYPTION_KEYS` is **additive and optional** — leaving it unset keeps the single-key (`v1`) behaviour unchanged.

### Zero-downtime rotation (versioned keyring)

1. Generate a new key (`NEW_KEY`).
2. Set the keyring to hold **both** versions and cut the write-version over to `v2`:

   ```bash
   SECRETS_ENCRYPTION_KEYS='{"v1":"<OLD_KEY>","v2":"<NEW_KEY>"}'
   SECRETS_ENCRYPTION_CURRENT_VERSION=v2
   ```

   Deploy API + worker. New secrets are written under `v2`; existing `v1` rows still decrypt via the keyring.
3. Re-encrypt existing rows onto `v2` (dry-run first):

   ```bash
   pnpm ops:secrets:rotate            # report-only (dry-run)
   pnpm ops:secrets:rotate --apply    # re-encrypt v1 rows to v2 (mutates)
   ```

4. Once no `v1` rows remain, drop `v1` from `SECRETS_ENCRYPTION_KEYS` (and rotate `SECRETS_ENCRYPTION_KEY` to the `v2` value).

The script walks every column in its `FIELD_SECRET_ROTATION_COLUMNS` list — `auth.mfa_methods.encrypted_secret`, `notify.webhooks.encrypted_secret` and `app.instagram_account_tokens.encrypted_access_token` (the Instagram access token) — decrypting each value by its stored version and re-encrypting with the current version. A new `encryptFieldSecret` column joins that list. The script reads the tables outside any database context, so it must connect as a role that bypasses RLS (`rolsuper` or `rolbypassrls`): all three are FORCE RLS, and the Instagram token table has no maintenance arm, so any other role finds no rows. It checks the connected role first and refuses to run — dry run included, exit code 1 — as a role subject to RLS (`meepzo_be_app`, `meepzo_be_maintenance`): reporting zero there would read as "nothing left to rotate" while every row is still on the old key.

## Envelope format

Values are stored as `<version>:` + base64(AES-256-GCM with random IV and auth tag), where `<version>` is `v1` or `v2`. A non-empty value without a recognised prefix is rejected — decryption throws; there is no plaintext fallback. The empty string is the canonical "no secret" value and round-trips unchanged.

## Related

- [`src/shared/utils/security/field-secret-encryption.util.ts`](../../../src/shared/utils/security/field-secret-encryption.util.ts)
- [`src/shared/utils/security/jwt.util.ts`](../../../src/shared/utils/security/jwt.util.ts) (single-key RS256 JWT signing/verification — separate from field secrets)
