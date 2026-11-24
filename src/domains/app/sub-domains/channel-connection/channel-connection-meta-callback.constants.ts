/**
 * The frontend's data-deletion status page (meepzo-fe, launch IQ2): it says the data is deleted and
 * shows the confirmation code. Route 17's `url` is `FRONTEND_URL` + this path + `?code=<code>`.
 */
export const INSTAGRAM_DATA_DELETION_FRONTEND_PATH = '/instagram/data-deletion';

/**
 * `metadata.source` of the two Meta callbacks' audit entries (MC12): the change came from Meta's
 * signed request, not from a person signed in to the app.
 */
export const META_CALLBACK_AUDIT_SOURCE = 'meta';

/** The audit actions of routes 16 and 17 (MC12, K9): `<domain>.<resource>.<verb>`. */
export const META_CALLBACK_AUDIT_ACTIONS = {
  /** Route 16 — Meta: the app was removed. */
  deauthorize: 'app.channel_connection.deauthorize',
  /** Route 17 — Meta: the person asked for their data to be deleted. */
  dataDeletion: 'app.channel_connection.data_deletion',
} as const;

/**
 * The `application/x-www-form-urlencoded` media type Meta posts both callbacks with (MC14) — the
 * only body the two routes parse; any other answers `415`.
 */
export const META_CALLBACK_FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
