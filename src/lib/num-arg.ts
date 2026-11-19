import { z } from 'zod';

/**
 * Numeric tool arguments that also accept a whole-number string ("196"). A client whose cached tool schema predates an
 * argument still passes it through, but as a string: on 2026-11-19 claude.ai sent fetch's from_passage and max_chars
 * as "196" / "2000" and the call failed validation. Anything that is not a plain number string is left as is, so the
 * number schema still rejects it with its normal message. The published JSON schema stays a number.
 */
export function fromNumericString(v: unknown): unknown {
  return typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v.trim()) : v;
}

export function numArg<T extends z.ZodType>(schema: T) {
  return z.preprocess(fromNumericString, schema);
}
