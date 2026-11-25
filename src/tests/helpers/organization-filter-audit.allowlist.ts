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
 * no organization to compare it with yet — and two job-scope lookups by public id the broadcast
 * flow (R56) first ran.
 */
export const RLS_ONLY_STATEMENTS: Readonly<Record<string, string>> = {
  '1e6198482491':
    'webhook-delivery.repository.ts: the organization of a delivery attempt, by the public id the producer just inserted — the organization is what the read finds',
  d70319b2051c:
    "broadcast-recipient.repository.ts lockLiveBroadcastByPublicId: the broadcast-audience task (R46) names only the job's organization (its scope's GUC) and the broadcast's public id — the organization is what the read finds; every later statement of the piece names it (feat-instagram-dm-sending R56, P451)",
  '0d64a385e504':
    "channel-connection-usage.repository.ts findConnectionKey: the connection's key by its public id, filtered on the scope's own organization GUC — the organization is what the read finds; the usage reads after it name it (feat-instagram-dm-sending R56, P451)",
};
