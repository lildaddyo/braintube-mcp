/**
 * MCP Tool Description Sanitization — NEXT-6
 *
 * Defends against "tool-poisoning" attacks (CVE-2025-59944) where a malicious
 * MCP server or compromised tool registration injects adversarial instructions
 * into tool descriptions that get passed to the LLM in the tools array.
 *
 * Strategy:
 *   1. Strip zero-width / invisible Unicode characters
 *   2. Remove instruction blocks WITH their content (<IMPORTANT>…</IMPORTANT>, <system>…, the
 *      classic tool-poisoning carrier), then any remaining HTML/XML tags
 *   2b. Remove sentences that point at local secrets (~/.ssh, id_rsa, .env, mcp.json) or tell
 *      the model to hide something from the user
 *   3. Remove ChatML / special LLM control tokens
 *   4. Redact explicit instruction-override phrases
 *   5. Strip Markdown headings that start instruction-override keywords
 *
 * The sanitizeToolDescription() function is SAFE to call on legitimate tool
 * descriptions — it only removes content that has no place in a tool description.
 *
 * Exposure is low: BrainTube's tool metadata is first-party and lives in this repo. This is a
 * backstop that also makes findToolPoisoning() available to the startup audit.
 */

const INSTRUCTION_BLOCK_RE =
  /<\s*(important|system|instructions?|secret|hidden|admin|note|context|rules?|assistant)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const SENSITIVE_SENTENCE_RE =
  /[^.\n]*(~\/\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\/etc\/passwd|\.env\b|mcp\.json|\.cursor\/|claude_desktop_config|(do\s+not|don'?t|never)\s+(tell|mention|inform|reveal\s+to|show)\s+(the\s+)?user|without\s+(telling|informing)\s+the\s+user)[^.\n]*[.\n]?/gi;

/** Reasons a raw (unsanitised) tool description looks like tool poisoning. */
export function findToolPoisoning(description: string): string[] {
  const out: string[] = [];
  if (!description) return out;
  if (new RegExp(INSTRUCTION_BLOCK_RE.source, 'i').test(description)) out.push('hidden instruction block (<IMPORTANT>/<system>…)');
  if (new RegExp(SENSITIVE_SENTENCE_RE.source, 'i').test(description)) out.push('reference to local secrets or to hiding actions from the user');
  if (detectInjection(description)) out.push('instruction-override pattern');
  return out;
}

import { detectInjection } from './injection.js';

// ─── Sanitization ─────────────────────────────────────────────────────────────

/**
 * Clean a single tool or parameter description string.
 * Returns the sanitized string (may be identical to input for clean descriptions).
 */
export function sanitizeToolDescription(description: string): string {
  if (!description) return description;

  let clean = description;

  // 1. Zero-width and invisible Unicode steganography characters
  clean = clean.replace(/[\u0000\u00AD\u200B\u200C\u200D\u200E\u200F\u2028\u2029\u202A-\u202F\u2060\u2061\u2062\u2063\u2064\uFEFF\uFFF9\uFFFA\uFFFB\u180E]/g, '');

  // 2. Instruction blocks with their content, then any remaining HTML/XML tags
  clean = clean.replace(INSTRUCTION_BLOCK_RE, '[REMOVED]');
  clean = clean.replace(/<\/?[a-zA-Z][^>]{0,200}>/g, '');

  // 2b. Sentences that point at local secrets or ask to hide actions from the user
  clean = clean.replace(SENSITIVE_SENTENCE_RE, '[REMOVED] ');

  // 3. ChatML / special LLM control tokens
  clean = clean.replace(/<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|user\|>|<\|assistant\|>/gi, '');
  clean = clean.replace(/\[SYSTEM\]/gi, '');

  // 4. Instruction-override phrases
  clean = clean.replace(/\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?|constraints?)\b/gi, '[REMOVED]');
  clean = clean.replace(/\bdisregard\s+(all\s+)?(previous|prior|above|your|the)?\s*(instructions?|prompts?|rules?|constraints?)\b/gi, '[REMOVED]');
  clean = clean.replace(/\bforget\s+(all\s+)?(your\s+|previous\s+)?(instructions?|rules?|context)\b/gi, '[REMOVED]');
  clean = clean.replace(/\byou\s+are\s+now\s+/gi, '[REMOVED] ');
  clean = clean.replace(/\bact\s+as\s+(if\s+you\s+(are|were)|a|an|the)\b/gi, '[REMOVED]');
  clean = clean.replace(/\bpretend\s+(you\s+are|to\s+be|that\s+you)\b/gi, '[REMOVED]');
  clean = clean.replace(/\boverride\s+(your|all|previous|the|current)\s+(instructions?|rules?|constraints?)\b/gi, '[REMOVED]');
  clean = clean.replace(/\bfrom\s+now\s+on\s+(you\s+are|act|respond|behave)\b/gi, '[REMOVED]');
  clean = clean.replace(/\bDAN\s*[:|-]/gi, '[REMOVED]');

  // 5. Markdown headings introducing override keywords (e.g. "# system instruction:")
  clean = clean.replace(/#{1,6}\s*(system|instruction|prompt|override|directive)\b[^\n]*/gi, '');

  return clean.trim();
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export interface ToolMeta {
  name:        string;
  description: string;
}

export interface ToolDescriptionWarning {
  tool:    string;
  warning: string;
}

/**
 * Run detectInjection() against every registered tool description.
 * Returns an array of warnings for any tool whose description triggers injection detection.
 * Returns empty array if all descriptions are clean.
 *
 * Call this after all tools are registered (before returning the server) to
 * catch any injection pattern that survived sanitization.
 */
export function auditToolDescriptions(tools: ToolMeta[]): ToolDescriptionWarning[] {
  const warnings: ToolDescriptionWarning[] = [];
  for (const tool of tools) {
    const findings = findToolPoisoning(tool.description);
    if (findings.length > 0) {
      warnings.push({
        tool:    tool.name,
        warning: `Description still looks poisoned after sanitization: ${findings.join('; ')}`,
      });
    }
  }
  return warnings;
}
