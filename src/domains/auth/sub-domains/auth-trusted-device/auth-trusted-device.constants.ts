/**
 * How long a trusted device lasts after the person ticks "trust this device" (AT17): 30 days from the
 * tick — using it never extends it.
 *
 * @remarks
 * - **Notes:** a code constant, not an environment variable — it does not vary by deployment (P4).
 */
export const TRUSTED_DEVICE_DAYS = 30;

/**
 * The most live trusted devices one person may hold (AT17): an 11th revokes the oldest.
 *
 * @remarks
 * - **Notes:** bounded under a per-user advisory lock, like the live-session cap.
 */
export const TRUSTED_DEVICES_MAX = 10;

/** Random bytes in a trusted-device cookie value (base64url-encoded); only its SHA-256 is stored. */
export const TRUSTED_DEVICE_TOKEN_BYTES = 32;

/**
 * How long a revoked or expired trusted-device row is kept before the clean-up deletes it (WC-64): 30 days.
 *
 * @remarks
 * - **Notes:** read by {@link TrustedDeviceRepository.deleteEndedBefore}, which the hourly clean-up of
 *   ROUTE R50 calls; this row (R32) builds the table and the method only.
 */
export const TRUSTED_DEVICE_ENDED_KEEP_DAYS = 30;
