import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

// ── security_dashboard ────────────────────────────────────────────────────────

export const securityDashboardSchema = z.object({});

export const securityDashboardOutputSchema = z.object({
  unacknowledged_alerts: z.array(z.unknown()),
  recent_security_events_24h: z.array(z.unknown()),
  taint_distribution: z.array(z.unknown()),
  active_canary_triggers: z.array(z.unknown()),
  active_suppressions: z.array(z.unknown()),
  retrieval_quality_7d: z.object({
    sample_count: z.number().optional(),
    avg_precision: z.number().nullable().optional(),
  }).passthrough(),
  firewall_summary: z.object({
    analytics_7d: z.unknown().optional(),
    active_rule_versions: z.array(z.unknown()).optional(),
  }).passthrough(),
  checked_at: z.string(),
});

export async function securityDashboard(
  _input: z.infer<typeof securityDashboardSchema>
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {

  // Unacknowledged alerts
  const { data: unacked } = await dbAdmin
    .from('security_alerts')
    .select('id, severity, alert_type, title, delivery_status, created_at')
    .eq('acknowledged', false)
    .order('created_at', { ascending: false })
    .limit(20);

  // Recent security events (last 24h)
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recentEvents } = await dbAdmin
    .from('security_events')
    .select('id, event_type, severity, user_id, created_at')
    .gte('created_at', cutoff24h)
    .order('created_at', { ascending: false })
    .limit(20);

  // Taint distribution via RPC
  const { data: taintDist } = await dbAdmin.rpc('get_taint_distribution');

  // Active canary triggers
  const { data: canaries } = await dbAdmin
    .from('session_canaries')
    .select('id, session_id, triggered_at, raw_evidence')
    .eq('triggered', true)
    .order('created_at', { ascending: false })
    .limit(5);

  // Active alert suppressions
  const { data: suppressions } = await dbAdmin
    .from('alert_suppressions')
    .select('id, alert_type, reason, suppressed_until')
    .gte('suppressed_until', new Date().toISOString());

  // Retrieval quality (last 7 days)
  const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: rqRows } = await dbAdmin
    .from('retrieval_quality')
    .select('precision_score, avg_grounding_score')
    .gte('created_at', cutoff7d);

  const avgPrecision = rqRows?.length
    ? rqRows.reduce((sum, r) => sum + (r.precision_score || 0), 0) / rqRows.length
    : null;

  // Firewall summary (7-day analytics + active rule versions)
  const { data: firewallAnalytics } = await dbAdmin.rpc('get_firewall_analytics', { p_days: 7 });
  const { data: firewallRuleVersions } = await dbAdmin
    .from('firewall_rule_versions')
    .select('version, rule_type, active, created_at')
    .eq('active', true)
    .order('rule_type');

  const payload = {
    unacknowledged_alerts:       unacked              ?? [],
    recent_security_events_24h:  recentEvents         ?? [],
    taint_distribution:          taintDist            ?? [],
    active_canary_triggers:      canaries             ?? [],
    active_suppressions:         suppressions         ?? [],
    retrieval_quality_7d: {
      sample_count:  rqRows?.length ?? 0,
      avg_precision: avgPrecision != null ? Number(avgPrecision.toFixed(3)) : null,
    },
    firewall_summary: {
      analytics_7d:          firewallAnalytics  ?? null,
      active_rule_versions:  firewallRuleVersions ?? [],
    },
    checked_at: new Date().toISOString(),
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

// ── acknowledge_security_alert ────────────────────────────────────────────────

export const acknowledgeAlertSchema = z.object({
  alert_id: z.string().uuid().describe('UUID of the alert to acknowledge'),
  notes:    z.string().optional().describe('Resolution notes'),
});

export const acknowledgeSecurityAlertOutputSchema = z.object({
  success: z.boolean(),
  alert_id: z.string().optional(),
  notes: z.string().optional(),
  error: z.string().optional(),
});

export async function acknowledgeSecurityAlert(
  input: z.infer<typeof acknowledgeAlertSchema>
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const { alert_id, notes } = input;

  const { error } = await dbAdmin.rpc('acknowledge_alert', {
    p_alert_id: alert_id,
    p_notes:    notes ?? null,
  });

  if (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
      structuredContent: { success: false, error: error.message } as unknown as Record<string, unknown>,
    };
  }

  const text = `Alert ${alert_id} acknowledged.${notes ? ` Notes: ${notes}` : ''}`;

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { success: true, alert_id, ...(notes ? { notes } : {}) } as unknown as Record<string, unknown>,
  };
}

// ── suppress_alert_type ───────────────────────────────────────────────────────

export const suppressAlertSchema = z.object({
  alert_type:     z.string().min(1).describe("Alert type to suppress (e.g. 'canonical_scan_failed', 'writeback_spike')"),
  duration_hours: z.number().min(1).max(168).describe('Hours to suppress (1–168, max 7 days)'),
  reason:         z.string().min(1).describe('Reason for suppression'),
});

export const suppressAlertTypeOutputSchema = z.object({
  success: z.boolean(),
  alert_type: z.string().optional(),
  suppressed_until: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

export async function suppressAlertType(
  input: z.infer<typeof suppressAlertSchema>
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const { alert_type, duration_hours, reason } = input;

  const suppressed_until = new Date(Date.now() + duration_hours * 60 * 60 * 1000).toISOString();

  const { error } = await dbAdmin
    .from('alert_suppressions')
    .insert({ alert_type, reason, suppressed_until });

  if (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
      structuredContent: { success: false, error: error.message } as unknown as Record<string, unknown>,
    };
  }

  const text = `Alert type "${alert_type}" suppressed for ${duration_hours}h until ${suppressed_until}. Reason: ${reason}`;

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { success: true, alert_type, suppressed_until, reason } as unknown as Record<string, unknown>,
  };
}
