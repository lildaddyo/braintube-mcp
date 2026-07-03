import { z } from 'zod';

/**
 * Envelope for secureWrap's cross-cutting short-circuits (role/tier denial,
 * injection rejection, confirm-required preview). These bypass the tool's own
 * handler entirely, so their result can never conform to a tool-specific
 * outputSchema. The MCP SDK's validateToolOutput() throws if a tool declares
 * outputSchema but a non-error result has no structuredContent — so every
 * declared outputSchema must be unioned with this envelope via withEnvelope().
 *
 * shortCircuitResult() in server.ts is the ONLY place that should construct
 * this shape — scripts/verify-server-card-parity.ts asserts no other
 * short-circuit return inside secureWrap bypasses it.
 */
export const shortCircuitEnvelopeSchema = z.object({
  status: z.enum(['access_denied', 'injection_blocked', 'confirmation_required']),
  message: z.string(),
});

export type ShortCircuitStatus = z.infer<typeof shortCircuitEnvelopeSchema>['status'];

export function withEnvelope<T extends z.ZodTypeAny>(schema: T) {
  return z.union([schema, shortCircuitEnvelopeSchema]);
}
