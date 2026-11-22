/**
 * The frontend's data-deletion status page (meepzo-fe, IQ2): it says the data is deleted and shows
 * the confirmation code. Route 8's `url` is `FRONTEND_URL` + this path + `?code=<code>`.
 */
export const INSTAGRAM_DATA_DELETION_FRONTEND_PATH = '/instagram/data-deletion';

/**
 * `metadata.source` of the two Meta callbacks' audit entries (IA7): the change came from Meta's
 * signed request, not from a person signed in to the app.
 */
export const META_CALLBACK_AUDIT_SOURCE = 'meta';

/** The audit actions of routes 7 and 8 (IA7, K9): `<domain>.<resource>.<verb>`. */
export const META_CALLBACK_AUDIT_ACTIONS = {
  /** Route 7 — Meta: the account's owner removed the app. */
  deauthorize: 'app.instagram_account.deauthorize',
  /** Route 8 — Meta: the account's owner asked for their data to be deleted. */
  dataDeletion: 'app.instagram_account.data_deletion',
} as const;

/**
 * The `application/x-www-form-urlencoded` media type Meta posts both callbacks with (IA18) — the
 * only body the two routes parse; any other answers `415`.
 */
export const META_CALLBACK_FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
