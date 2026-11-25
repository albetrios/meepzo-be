/**
 * Statements that run inside an organization, read or change a tenant table, and name neither the
 * organization nor an internal id — so Postgres RLS is their only filter — keyed by
 * `statementFingerprint`, each with where it comes from and why RLS alone is right for it.
 *
 * @remarks
 * The audit (`organization-filter-audit.setup.ts`) fails a test file on any statement of this kind
 * that is not listed, so a filter dropped from a repository fails the push. The 20 Oct 2026 run
 * listed 21 shapes; 20 now name the organization (or an internal id). What is left is a lookup
 * whose answer IS the organization, by an id the server minted in the same unit of work — there is
 * no organization to compare it with yet.
 */
export const RLS_ONLY_STATEMENTS: Readonly<Record<string, string>> = {
  '1e6198482491':
    'webhook-delivery.repository.ts: the organization of a delivery attempt, by the public id the producer just inserted — the organization is what the read finds',
  '0d64a385e504':
    "channel-connection-usage.repository.ts findConnectionKey: the connection by its public id, filtered to the unit's own organization through the app.current_organization_public_id subquery — the usage target carries the organization's public id only (the scope), so the GUC is the organization filter, the same one RLS applies (found by the R54 send flow)",
};
