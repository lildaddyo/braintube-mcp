import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

// ── firewall_status ────────────────────────────────────────────────────────────

export const firewallStatusSchema = z.object({});

export const firewallStatusOutputSchema = z.object({
  analytics_7d: z.unknown().optional(),
  active_rule_versions: z.array(z.unknown()).optional(),
  threshold_analysis_30d: z.unknown().optional(),
  recent_firewall_events_24h: z.array(z.unknown()).optional(),
  checked_at: z.string().optional(),
}).passthrough();

export async function firewallStatus(
  _input: z.infer<typeof firewallStatusSchema>
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {

  // Firewall analytics (7-day)
  const { data: analytics } = await dbAdmin.rpc('get_firewall_analytics', { p_days: 7 });

  // Active rule versions
  const { data: ruleVersions } = await dbAdmin
    .from('firewall_rule_versions')
    .select('version, rule_type, change_description, active, created_at')
    .eq('active', true)
    .order('rule_type');

  // Adaptive threshold recommendations (30-day window for richer signal)
  const { data: thresholdAnalysis } = await dbAdmin.rpc('analyze_firewall_thresholds', { p_days: 30 });

  // Recent firewall events (last 24h)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recentEvents } = await dbAdmin
    .from('security_events')
    .select('event_type, severity, created_at')
    .like('event_type', 'firewall_%')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(20);

  const payload = {
    analytics_7d:                analytics,
    active_rule_versions:        ruleVersions          ?? [],
    threshold_analysis_30d:      thresholdAnalysis,
    recent_firewall_events_24h:  recentEvents          ?? [],
    checked_at:                  new Date().toISOString(),
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

// ── firewall_promote_check ─────────────────────────────────────────────────────

export const firewallPromoteCheckSchema = z.object({
  check_name: z.string().describe(
    'Check to promote/demote: toxicity, topic_boundary, conversation_risk, token_budget, ingress_probe, exfiltration, policy_compliance'
  ),
  action: z.enum(['promote', 'demote']).describe(
    "'promote' = enforce (block/modify), 'demote' = shadow (log only)"
  ),
});

export const firewallPromoteCheckOutputSchema = z.object({
  check_name: z.string().optional(),
  action: z.enum(['promote', 'demote']).optional(),
  shadow_checks: z.array(z.string()).optional(),
  rule_version: z.number().optional(),
  error: z.string().optional(),
}).passthrough();

export async function firewallPromoteCheck(
  input: z.infer<typeof firewallPromoteCheckSchema>
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const { check_name, action } = input;

  // Get current shadow config snapshot
  const { data: currentConfig } = await dbAdmin.rpc('get_active_firewall_rules', {
    p_rule_type: 'shadow_config',
  });

  if (!currentConfig) {
    return {
      content: [{ type: 'text' as const, text: 'Error: No active shadow_config found.' }],
      structuredContent: { error: 'No active shadow_config found.' } as unknown as Record<string, unknown>,
    };
  }

  // RPC returns the rules_snapshot jsonb — may arrive as object or string
  const config = typeof currentConfig === 'string' ? JSON.parse(currentConfig) : currentConfig;
  let checks: string[] = Array.isArray(config.checks) ? config.checks : [];

  if (action === 'promote') {
    // Remove from shadow list → now enforcing
    checks = checks.filter((c: string) => c !== check_name);
  } else {
    // Add to shadow list → log-only
    if (!checks.includes(check_name)) checks.push(check_name);
  }

  const newConfig = { ...config, checks };
  const { data: versionId, error } = await dbAdmin.rpc('snapshot_firewall_rules', {
    p_rule_type:   'shadow_config',
    p_rules:       newConfig,
    p_description: `${action === 'promote' ? 'Promoted' : 'Demoted'} "${check_name}" — ${action === 'promote' ? 'now enforcing' : 'now shadow only'}`,
    p_changed_by:  'mcp_admin',
  });

  if (error) {
    return {
      content: [{ type: 'text' as const, text: `Error snapshotting config: ${error.message}` }],
      structuredContent: { error: error.message } as unknown as Record<string, unknown>,
    };
  }

  const shadowList = checks.length > 0 ? checks.join(', ') : 'none (all enforcing)';
  const text = action === 'promote'
    ? `✅ Promoted "${check_name}" — now enforcing (will block/modify).\nShadow checks remaining: ${shadowList}\nRule version: ${versionId}`
    : `⬇️ Demoted "${check_name}" — now shadow mode (log only).\nShadow checks: ${shadowList}\nRule version: ${versionId}`;

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: {
      check_name,
      action,
      shadow_checks: checks,
      rule_version: versionId,
    } as unknown as Record<string, unknown>,
  };
}

// ── firewall_update_threshold ──────────────────────────────────────────────────

export const firewallUpdateThresholdSchema = z.object({
  threshold_name: z.string().describe(
    'Threshold to update: conversation_risk_warn, conversation_risk_block, grounding_minimum, grounding_writeback_gate, exfiltration_entity_limit, exfiltration_yesno_ratio'
  ),
  new_value: z.number().describe('New threshold value'),
  reason:    z.string().min(1).describe('Why this threshold is being changed'),
});

export const firewallUpdateThresholdOutputSchema = z.object({
  threshold_name: z.string().optional(),
  old_value: z.unknown().optional(),
  new_value: z.number().optional(),
  rule_version: z.number().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

export async function firewallUpdateThreshold(
  input: z.infer<typeof firewallUpdateThresholdSchema>
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const { threshold_name, new_value, reason } = input;

  // Get current thresholds snapshot
  const { data: currentThresholds } = await dbAdmin.rpc('get_active_firewall_rules', {
    p_rule_type: 'thresholds',
  });

  if (!currentThresholds) {
    return {
      content: [{ type: 'text' as const, text: 'Error: No active thresholds found.' }],
      structuredContent: { error: 'No active thresholds found.' } as unknown as Record<string, unknown>,
    };
  }

  const thresholds = typeof currentThresholds === 'string'
    ? JSON.parse(currentThresholds)
    : { ...(currentThresholds as Record<string, unknown>) };

  const oldValue = thresholds[threshold_name];
  thresholds[threshold_name] = new_value;

  const { data: versionId, error } = await dbAdmin.rpc('snapshot_firewall_rules', {
    p_rule_type:   'thresholds',
    p_rules:       thresholds,
    p_description: `${threshold_name}: ${oldValue} → ${new_value}. Reason: ${reason}`,
    p_changed_by:  'mcp_admin',
  });

  if (error) {
    return {
      content: [{ type: 'text' as const, text: `Error snapshotting thresholds: ${error.message}` }],
      structuredContent: { error: error.message } as unknown as Record<string, unknown>,
    };
  }

  return {
    content: [{
      type: 'text' as const,
      text: `Updated "${threshold_name}": ${oldValue} → ${new_value}\nReason: ${reason}\nRule version: ${versionId}\n\nTo rollback: use firewall_rollback_rules with rule_type "thresholds"`,
    }],
    structuredContent: {
      threshold_name,
      old_value: oldValue,
      new_value,
      rule_version: versionId,
      reason,
    } as unknown as Record<string, unknown>,
  };
}

// ── firewall_rollback_rules ────────────────────────────────────────────────────

export const firewallRollbackRulesSchema = z.object({
  rule_type:  z.string().describe(
    'Rule type: thresholds, shadow_config, injection_patterns, pii_patterns, toxicity_patterns'
  ),
  to_version: z.number().int().positive().describe('Version number to rollback to'),
});

export const firewallRollbackRulesOutputSchema = z.object({
  success: z.boolean().optional(),
  rule_type: z.string().optional(),
  to_version: z.number().optional(),
  rolled_back_from: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

export async function firewallRollbackRules(
  input: z.infer<typeof firewallRollbackRulesSchema>
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const { rule_type, to_version } = input;

  // Verify target version exists before rolling back
  const { data: targetVersion, error: fetchError } = await dbAdmin
    .from('firewall_rule_versions')
    .select('version, change_description, created_at')
    .eq('rule_type', rule_type)
    .eq('version', to_version)
    .single();

  if (fetchError || !targetVersion) {
    return {
      content: [{
        type: 'text' as const,
        text: `Error: Version ${to_version} not found for rule type "${rule_type}".`,
      }],
      structuredContent: {
        error: `Version ${to_version} not found for rule type "${rule_type}".`,
      } as unknown as Record<string, unknown>,
    };
  }

  const { data: success, error: rollbackError } = await dbAdmin.rpc('rollback_firewall_rules', {
    p_rule_type:   rule_type,
    p_to_version:  to_version,
  });

  if (rollbackError) {
    return {
      content: [{ type: 'text' as const, text: `Rollback error: ${rollbackError.message}` }],
      structuredContent: { error: rollbackError.message } as unknown as Record<string, unknown>,
    };
  }

  const text = success
    ? `✅ Rolled back "${rule_type}" to version ${to_version} (from ${targetVersion.created_at}).\nOriginal description: ${targetVersion.change_description || 'none'}`
    : `Error: Rollback failed for "${rule_type}" version ${to_version}.`;

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: (success
      ? {
          success: true,
          rule_type,
          to_version,
          rolled_back_from: targetVersion.created_at,
        }
      : {
          success: false,
          error: `Rollback failed for "${rule_type}" version ${to_version}.`,
        }) as unknown as Record<string, unknown>,
  };
}

// ── firewall_rule_history ──────────────────────────────────────────────────────

export const firewallRuleHistorySchema = z.object({
  rule_type: z.string().describe(
    'Rule type: thresholds, shadow_config, injection_patterns, pii_patterns, toxicity_patterns, homoglyph_map, token_limits'
  ),
});

export const firewallRuleHistoryOutputSchema = z.object({
  rule_type: z.string().optional(),
  versions: z.array(z.object({
    version: z.number().optional(),
    rule_type: z.string().optional(),
    rules_hash: z.string().optional(),
    change_description: z.string().optional(),
    changed_by: z.string().optional(),
    active: z.boolean().optional(),
    created_at: z.string().optional(),
  }).passthrough()).optional(),
  total: z.number().optional(),
}).passthrough();

export async function firewallRuleHistory(
  input: z.infer<typeof firewallRuleHistorySchema>
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const { rule_type } = input;

  const { data: versions, error } = await dbAdmin
    .from('firewall_rule_versions')
    .select('version, rule_type, rules_hash, change_description, changed_by, active, created_at')
    .eq('rule_type', rule_type)
    .order('version', { ascending: false })
    .limit(20);

  if (error) {
    return {
      content: [{ type: 'text' as const, text: `Error fetching history: ${error.message}` }],
      structuredContent: { error: error.message } as unknown as Record<string, unknown>,
    };
  }

  const payload = {
    rule_type,
    versions: versions ?? [],
    total:    versions?.length ?? 0,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}
