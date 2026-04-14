/**
 * Injection Detection — MCP Auth Hardening
 *
 * Detects prompt-injection attempts, zero-width character attacks, and
 * instruction-hijacking patterns in tool input strings before they are
 * processed or stored.
 *
 * Strategy:
 *   1. NFKD normalise (collapses homoglyphs and compatibility ligatures)
 *   2. Scan for zero-width / invisible Unicode control characters
 *   3. Match instruction-hijacking regex patterns against the normalised text
 */

import { dbAdmin } from '../db/supabase.js';

// ─── Zero-width and invisible control characters ──────────────────────────────
// These are the canonical Unicode steganography characters used to hide
// malicious instructions inside otherwise-innocent-looking text.
const ZERO_WIDTH_RE = /[\u0000\u00AD\u200B\u200C\u200D\u200E\u200F\u2028\u2029\u202A-\u202F\u2060\u2061\u2062\u2063\u2064\uFEFF\uFFF9\uFFFA\uFFFB]/;

// ─── Instruction-hijacking patterns (applied after NFKD normalisation) ────────
// Ordered from highest to lowest specificity to keep matching fast.
const INJECTION_PATTERNS: RegExp[] = [
  // Classic "ignore/disregard previous instructions" family
  /\bignore\s+(all\s+)?(previous|prior|above|your|the\s+above)\s+(instructions?|prompts?|context|rules?|constraints?|directives?)\b/i,
  /\bdisregard\s+(all\s+|your\s+|previous\s+|the\s+)?(instructions?|prompts?|context|rules?|constraints?|above)\b/i,
  /\bforget\s+(everything|all|your\s+instructions?|your\s+rules?|prior\s+context)\b/i,
  /\bdo\s+not\s+(follow|obey|adhere\s+to)\s+(your|the|previous)\b/i,
  /\boverride\s+(your|all|previous|the|current)\s+(instructions?|rules?|constraints?|directives?)\b/i,

  // Role-switching / persona injection
  /\byou\s+are\s+now\s+(a|an|the)?\s*\b/i,
  /\bact\s+as\s+(if\s+you\s+(are|were)|a|an|the)\b/i,
  /\bpretend\s+(you\s+are|to\s+be|that\s+you)\b/i,
  /\byou\s+(must\s+|shall\s+|should\s+)?respond\s+as\b/i,
  /\bfrom\s+now\s+on\s+(you\s+are|act|respond|behave)\b/i,
  /\byour\s+(new\s+)?(role|persona|identity|name)\s+is\b/i,

  // System prompt / hidden instruction patterns
  /\b(new|updated?|revised?|actual|real)\s+(system\s+)?prompt\s*:/i,
  /\b(system|hidden|secret|override)\s+(instruction|prompt|directive|command)\b/i,
  /\bDAN\s*[:|-]/i,                             // "DAN:" jailbreak prefix
  /\[SYSTEM\]/i,
  /<\|?(system|im_start|im_end)\|?>/i,          // ChatML / special token injection
  /\bjailbreak\b/i,

  // Data exfiltration probes
  /\b(print|output|reveal|show|display|repeat|echo)\s+(your\s+)?(system\s+prompt|instructions?|api\s+key|secret|token|password)\b/i,
  /\bwhat\s+(are|is)\s+your\s+(system\s+prompt|instructions?|rules?)\b/i,

  // Indirect / nested injection carriers
  /\bthe\s+(following|text|content)\s+(is\s+|are\s+)?(your\s+)?(new\s+)?(instructions?|directives?|rules?)\b/i,
  /\bbase64\s*:\s*[A-Za-z0-9+/]{20,}/,          // base64 blob (common obfuscation carrier)
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if the text appears to contain a prompt-injection attempt.
 * Normalises to NFKD first so homoglyph substitutions don't bypass detection.
 */
export function detectInjection(text: string): boolean {
  if (!text || text.length === 0) return false;

  // 1. Zero-width character scan (pre-normalisation — these survive NFKD)
  if (ZERO_WIDTH_RE.test(text)) return true;

  // 2. NFKD normalise then strip leftover combining diacritics that were
  //    only present as obfuscation (e.g. "ｉｇｎｏｒｅ" → "ignore")
  const normalised = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');    // strip combining diacritics

  // 3. Pattern scan on normalised text
  return INJECTION_PATTERNS.some(p => p.test(normalised));
}

/**
 * Log an injection attempt to the security_events table (fire-and-forget).
 * Never awaited — a failure here should never block the tool response.
 */
export function logInjectionAttempt(
  userId: string,
  toolName: string,
  fieldSnippet: string   // first 150 chars of the offending string, not the raw value
): void {
  void dbAdmin
    .from('security_events')
    .insert({
      user_id:    userId,
      event_type: 'mcp_injection_attempt',
      severity:   'high',
      evidence:   {
        tool:    toolName,
        snippet: fieldSnippet.slice(0, 150),
      },
    })
    .then(({ error }) => {
      if (error) console.error('[injection] failed to log security_event:', error.message);
    });
}
