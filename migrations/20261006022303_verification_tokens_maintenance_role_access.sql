-- auth.verification_tokens' role policy (20260923120000) names only meepzo_be_app, but the
-- audit-retention job purges expired tokens on the maintenance pool, as meepzo_be_maintenance.
-- The purge worked only through that role's membership in meepzo_be_app (the GRANT in
-- 20260827020000), whereas the six other system tables name both runtime roles in their
-- *_app_access policies. Name both here as well, so the purge no longer hinges on role
-- inheritance; the grant stays for `SET LOCAL ROLE meepzo_be_app` on maintenance connections.
ALTER POLICY verification_tokens_app_access ON auth.verification_tokens
  TO meepzo_be_app, meepzo_be_maintenance;
