/**
 * Strip known secret patterns from a string. Used by the runtime_events
 * audit pipeline so plaintext connection strings + bearer tokens never
 * land in the SQLite log.
 *
 * Pure function — table-driven, deterministic.
 *
 * Slice 1: agent receives the unredacted value (intentional path-a from
 * the plugin spec gotcha #2). Audit log + UI raw-event view see only
 * <REDACTED>. Slice 2 ships the substitution-pipeline (path-b) so even
 * the agent sees opaque references.
 */
export function redactSecrets(input) {
  if (typeof input !== 'string') return input;
  return input
    // postgres / postgresql / mysql / mongodb / redis URLs — strip password
    .replace(
      /((?:postgres(?:ql)?|mysql|redis|rediss|mongodb(?:\+srv)?):\/\/[^:@\s]+):([^@\s]+)@/gi,
      '$1:<REDACTED>@',
    )
    // generic authorization header value (anything after "authorization:" or
    // "x-api-key:" etc up to whitespace/comma/semicolon — but not "Bearer ..."
    // which is handled below so its two-word form collapses correctly)
    .replace(/(\bauthorization:\s*)(?!Bearer\s)([^\s,;]+)/gi, '$1<REDACTED>')
    // explicit Authorization: Bearer <long token> header
    .replace(/(\bBearer\s+)([A-Za-z0-9_\-.]{16,})/gi, '$1<REDACTED>')
    .replace(/(\bx-api-key:\s*)([^\s,;]+)/gi, '$1<REDACTED>')
    // env-var-shaped secret keys in JSON: {"DATABASE_URL":"..."} → redact
    .replace(
      /("(?:DATABASE_URL|API_KEY|SECRET_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|CLIENT_SECRET)"\s*:\s*)"[^"]*"/gi,
      '$1"<REDACTED>"',
    );
}
