/**
 * Auth headers for MCP → BrainTube edge function calls.
 *
 * Edge functions identify the caller either from a user JWT or, for server-to-server calls,
 * from the service-role key plus x-bt-acting-user — which they honour only when the key
 * matches (dark-n-cozy _shared/acting-user.ts, constant-time compare), so a client can't
 * forge it. The service key is only ever sent to our own Supabase project's functions.
 */

/** Service key + acting user. `fairUseCounted` = this server already charged the call. */
export function actingUserHeaders(
  userId: string,
  opts: { fairUseCounted?: boolean } = {}
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceKey) {
    headers.Authorization = `Bearer ${serviceKey}`;
    headers['x-bt-acting-user'] = userId;
    if (opts.fairUseCounted) headers['x-bt-fair-use'] = 'counted';
  }
  return headers;
}

/**
 * The user's own JWT when they signed in with one (OAuth / Supabase JWT), else the
 * acting-user headers — API-key (bt_…) callers have no JWT, so before this they reached
 * JWT-only functions (compile-knowledge, export-corpus, readwise-sync) unauthenticated
 * and got 401.
 */
export function edgeAuthHeaders(userId: string, userJwt?: string): Record<string, string> {
  if (userJwt) {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${userJwt}`, apikey: userJwt };
  }
  return actingUserHeaders(userId);
}
