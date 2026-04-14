/**
 * MCP Tool Description Sanitization — NEXT-6
 *
 * Defends against "tool-poisoning" attacks (CVE-2025-59944) where a malicious
 * MCP server or compromised tool registration injects adversarial instructions
 * into tool descriptions that get passed to the LLM in the tools array.
 *
 * Strategy:
 *   1. Strip zero-width / invisible Unicode characters
 *   2. Remove HTML/XML tags (could carry hidden content)
 *   3. Remove ChatML / special LLM control tokens
 *   4. Redact explicit instruction-override phrases
 *   5. Strip Markdown headings that start instruction-override keywords
 *
 * The sanitizeToolDescription() function is SAFE to call on legitimate tool
 * descriptions — it only removes content that has no place in a tool description.
 */

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

  // 2. HTML/XML tags (no legitimate use in tool descriptions)
  clean = clean.replace(/<\/?[a-zA-Z][^>]{0,200}>/g, '');

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
    if (detectInjection(tool.description)) {
      warnings.push({
        tool:    tool.name,
        warning: 'Description contains injection-like patterns after sanitization',
      });
    }
  }
  return warnings;
}
