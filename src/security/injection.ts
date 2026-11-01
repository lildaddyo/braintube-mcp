/**
 * Injection detector — a SIGNAL, not a gate.
 *
 * Since the 2026-11-01 audit this never blocks a tool call. A regex list cannot tell a quoted
 * attack from a real one, misses paraphrases and most languages (it caught 21% of a labelled
 * attack corpus) and blocked 36% of benign inputs ("act as a mentor"). The security boundary is
 * provenance + taint (src/lib/ingest-gateway.ts), the untrusted-content envelope on retrieval
 * (src/security/untrusted-envelope.ts) and human confirmation for risky tools
 * (src/security/human-confirm.ts). A hit here only raises the taint of stored content to 2 and
 * writes a security_events row.
 *
 * Normalisation, in order:
 *   1. Zero-width / invisible control characters are a hit by themselves.
 *   2. NFKD + strip combining marks. This folds compatibility forms (fullwidth "ｉｇｎｏｒｅ",
 *      ligatures, accents). It does NOT fold cross-script look-alikes: Cyrillic "о" (U+043E)
 *      stays Cyrillic under NFKD.
 *   3. A confusables fold (subset of the Unicode TR39 skeleton for Cyrillic and Greek letters
 *      that look Latin), so "іgnоrе" written with Cyrillic letters is caught.
 *   4. A leetspeak + letter-spacing fold ("1gn0r3", "i g n o r e").
 * English patterns run over each variant; multilingual patterns run over the NFC text (NFKD would
 * split Korean syllables into jamo and strip the breve from Bulgarian "й").
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
  // "forget everything you know about goals" is a self-help sentence, so the object has to be
  // the model's own instructions or context.
  /\bforget\s+(everything|all)\s+(above|before|prior|you\s+(were|have\s+been)\s+told|in\s+(your|the)\s+(prompt|instructions?|context))\b/i,
  /\bforget\s+(your|all\s+your|all\s+previous|the\s+previous|prior)\s+(instructions?|rules?|guidelines?|context)\b/i,
  /\bdo\s+not\s+(follow|obey|adhere\s+to)\s+(your|the|previous)\b/i,
  /\boverride\s+(your|all|previous|the|current)\s+(instructions?|rules?|constraints?|directives?)\b/i,

  // Role-switching / persona injection. Narrow on purpose: "act as a mentor" and "pretend to be
  // calm" are ordinary requests; only an unrestricted / different-AI persona is a signal.
  /\byou\s+are\s+now\s+(a|an|the)?\s*(unrestricted|unfiltered|uncensored|jailbroken|evil|different|new)\b/i,
  /\byou\s+are\s+no\s+longer\s+(an?\s+)?(ai|assistant|claude|chatgpt|bound|restricted)\b/i,
  /\bact\s+as\s+if\s+you\s+(are|were|have)\s+no\s+(rules?|restrictions?|filters?|guidelines?)\b/i,
  /\b(act\s+as|pretend\s+(you\s+are|to\s+be))\s+(an?\s+)?(unrestricted|unfiltered|uncensored|jailbroken|evil)\b/i,
  /\byou\s+(must\s+|shall\s+|should\s+)?respond\s+as\b/i,
  /\bfrom\s+now\s+on\s+(you\s+are|act|respond|behave)\b/i,
  /\byour\s+(new\s+)?(role|persona|identity|name)\s+is\b/i,

  // System prompt / hidden instruction patterns
  /\b(new|updated?|revised?|actual|real)\s+(system\s+)?prompt\s*:/i,
  /\b(system|hidden|secret|override)\s+(instruction|prompt|directive|command)\b/i,
  /\bDAN\s*[:|-]/i,                             // "DAN:" jailbreak prefix
  /\[SYSTEM\]/i,
  /<\|?(system|im_start|im_end)\|?>/i,          // ChatML / special token injection
  // Jailbreak *instructions*, not the topic: a bare /\bjailbreak\b/ blocked ordinary
  // library searches such as "what did I save about jailbreak research" (EN and BG).
  /\b(enable|activate|enter|engage|switch\s+(on|to)|turn\s+on)\s+(the\s+)?(jailbreak|jailbroken|dan|developer)\s+mode\b/i,
  /\bjailbreak(ed)?\s+(mode|prompt)\s*[:\-]/i,
  /\byou\s+are\s+(now\s+)?jailbroken\b/i,

  // Data exfiltration probes
  /\b(print|output|reveal|show|display|repeat|echo)\s+(your\s+)?(system\s+prompt|instructions?|api\s+key|secret|token|password)\b/i,
  /\bwhat\s+(are|is)\s+your\s+(system\s+prompt|instructions?|rules?)\b/i,

  // Indirect / nested injection carriers
  /\bthe\s+(following|text|content)\s+(is\s+|are\s+)?(your\s+)?(new\s+)?(instructions?|directives?|rules?)\b/i,
  /\bbase64\s*:\s*[A-Za-z0-9+/]{20,}/,          // base64 blob (common obfuscation carrier)
  /\b(decode|base64\s*-?\s*decode)\s+(this|the\s+following)\s+and\s+(follow|execute|run|do)\b/i,

  // Paraphrased "the real instructions are elsewhere"
  /\b(previous|prior|earlier|above|original)\s+(instructions?|guidance|rules?|directions?)\s+(are|is|were|was)\s+(void|cancell?ed|obsolete|outdated|no\s+longer\s+(valid|apply|in\s+effect)|superseded)\b/i,
  /\b(set|put|leave)\s+aside\s+(everything|all|what)\s+(you\s+were|you've\s+been|that\s+was)\s+told\b/i,
  /\bnote\s+to\s+(the\s+)?(ai|assistant|llm|model|agent|claude|chatgpt)\b/i,
  /\b(ai|assistant|llm|model|agent)s?\s+reading\s+this\b/i,
  /\bif\s+you\s+are\s+an?\s+(ai|llm|language\s+model|assistant|agent)\b/i,
  /\bwithout\s+(telling|informing|notifying|asking)\s+the\s+user\b/i,
  /\bdo\s+not\s+(tell|inform|mention\s+(this|it)\s+to|alert)\s+the\s+user\b/i,

  // Tool-call / exfiltration instructions aimed at the reading agent
  /\b(call|invoke|use|run|trigger)\s+(the\s+)?[a-z]+(_[a-z]+)+\s*(tool|function)?\s*(with|using|\()/i,
  /\b(call|invoke|run|use|trigger|execute)\s+(the\s+)?`?(set_notion_api_key|connect_readwise|generate_api_key|bulk_ingest|ingest_content|add_note)\b/i,
  /\b(send|post|upload|forward|email|exfiltrate|transmit|leak)\s+(it|this|them|that|everything|all|the\s+[\w\s]{1,40}?)\s+to\s+(https?:\/\/|[\w.+-]+@[\w-]+\.)/i,
  /\b(fetch|open|visit|load|request|curl|navigate\s+to)\s+(the\s+url\s+)?https?:\/\/\S+[?&][\w-]+=\s*(\{|\$|<|\[)/i,
  /!\[[^\]]*\]\(https?:\/\/[^)]*[?&][\w-]+=\s*(\{|\$|<|\[)/i,  // markdown image beacon with a placeholder
  /~\/\.ssh|id_rsa|\.aws\/credentials|\/etc\/passwd/i,
];

// ─── Multilingual instruction-override patterns (run on NFC text, not folded) ──
const MULTILINGUAL_PATTERNS: RegExp[] = [
  // Spanish
  /\b(ignora|olvida|descarta)\s+(todas\s+)?(las\s+)?(instrucciones|indicaciones|reglas)\s+(anteriores|previas)/i,
  /\bolvida\s+(todo\s+)?lo\s+(anterior|que\s+te\s+(dijeron|han\s+dicho))/i,
  /\b(ahora\s+eres|a\s+partir\s+de\s+ahora\s+eres)\s+(un|una)\s+\S*\s*(sin\s+(restricciones|filtros|reglas))/i,
  /\b(nuevas\s+)?instrucciones\s+del\s+sistema\s*:/i,
  // German
  /\bignorier(e|en)?\s+(sie\s+)?(alle\s+)?(vorherigen|bisherigen|obigen|vorangegangenen)\s+(anweisungen|instruktionen|regeln|befehle)/i,
  /\bvergiss\s+(alle\s+)?(vorherigen|bisherigen|deine)\s+(anweisungen|regeln|instruktionen)/i,
  /\bdu\s+bist\s+(jetzt|nun|ab\s+sofort)\s+(ein|eine)\s+\S*\s*(ohne\s+(einschränkungen|regeln|filter))/i,
  /\bneue\s+systemanweisung/i,
  // Bulgarian
  /(игнорирай|игнорирайте|забрави|забравете|пренебрегни)\s+(всички\s+)?(предишни(те)?|горни(те)?|досегашни(те)?)\s+(инструкции|указания|правила)/i,
  /(от\s+сега\s+нататък|вече)\s+си\s+\S*\s*(без\s+(ограничения|правила|филтри))/i,
  /нови\s+системни\s+(инструкции|указания)/i,
  /не\s+казвай\s+на\s+потребителя/i,
  // Korean
  /(이전|위의|앞의|기존)\s*(의\s*)?(모든\s*)?(지시|지침|명령|규칙|instructions?)\S*\s*(을|를)?\s*(무시|잊어)/,
  /(시스템\s*프롬프트|시스템\s*지시)\S*\s*(을|를)?\s*(출력|보여|공개|알려)/,
  /사용자에게\s*(알리지|말하지)\s*(마|말)/,
  /제한\s*없는\s*(AI|ai|모델|어시스턴트)/,
];

// ─── Confusables fold (Unicode TR39 skeleton, Latin-looking subset) ───────────
const CONFUSABLES: Record<string, string> = {
  // Cyrillic lower / upper
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'һ': 'h', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k',
  'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's',
  'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'l', 'ɡ': 'g', 'ո': 'n', 'ս': 'u',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C',
  'Т': 'T', 'У': 'Y', 'Х': 'X', 'Ѕ': 'S', 'І': 'I', 'Ј': 'J', 'Ԁ': 'D', 'Ԛ': 'Q', 'Ԝ': 'W',
  // Greek
  'α': 'a', 'β': 'b', 'γ': 'y', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p',
  'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N',
  'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

/** Latin skeleton of a string: maps look-alike Cyrillic/Greek letters to the Latin they mimic. */
export function confusablesSkeleton(text: string): string {
  return text.replace(CONFUSABLE_RE, (ch) => CONFUSABLES[ch] ?? ch);
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '|': 'l' };

/** "1gn0r3 4ll" → "ignore all"; "i g n o r e" / "i.g.n.o.r.e" → "ignore". */
function leetAndSpacingFold(text: string): string {
  const leet = text.replace(/[013457@$!|]/g, (ch) => LEET[ch] ?? ch);
  // Join runs of single letters separated by one space/dot/dash/underscore/asterisk.
  return leet.replace(/\b(?:[A-Za-z][ .\-_*]){2,}[A-Za-z]\b/g, (run) => run.replace(/[ .\-_*]/g, ''));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if the text appears to contain a prompt-injection attempt.
 * Normalises to NFKD first so homoglyph substitutions don't bypass detection.
 */
export function detectInjection(text: string): boolean {
  if (!text || text.length === 0) return false;

  // 1. Zero-width character scan (pre-normalisation — these survive NFKD)
  if (ZERO_WIDTH_RE.test(text)) return true;

  // 2. NFKD folds compatibility forms ("ｉｇｎｏｒｅ" → "ignore") and accents. It does not fold
  //    Cyrillic/Greek look-alikes; step 3 does that.
  const normalised = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');    // strip combining diacritics

  // Multilingual patterns run on NFC, not on `normalised`: NFKD splits Korean Hangul syllables
  // into jamo and the mark strip turns Bulgarian "й" into "и", so they could never match there.
  const composed = text.normalize('NFC');
  if (MULTILINGUAL_PATTERNS.some(p => p.test(composed))) return true;

  // 3. Confusables skeleton, then 4. leetspeak / spaced-letter fold.
  const skeleton = confusablesSkeleton(normalised);
  const variants = [normalised, skeleton, leetAndSpacingFold(skeleton)];
  return variants.some(v => INJECTION_PATTERNS.some(p => p.test(v)));
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
      severity:   'medium',   // a detector signal, not a confirmed attack
      evidence:   {
        tool:    toolName,
        snippet: fieldSnippet.slice(0, 150),
      },
    })
    .then(({ error }) => {
      if (error) console.error('[injection] failed to log security_event:', error.message);
    });
}
