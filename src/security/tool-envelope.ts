import { z } from 'zod';

/**
 * Shape of the structuredContent built by shortCircuitResult() in server.ts
 * for secureWrap's cross-cutting short-circuits (role/tier denial, injection
 * rejection, confirm-required preview). These bypass the tool's own handler
 * entirely, so their result can never conform to a tool-specific outputSchema.
 *
 * shortCircuitResult() marks these results `isError: true` so the MCP SDK's
 * validateToolOutput() skips structuredContent validation for them entirely
 * (it returns early when result.isError is true — see
 * node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js).
 *
 * Do NOT union this schema into a tool's declared outputSchema. The SDK's
 * zod-compat layer (normalizeObjectSchema in zod-compat.js) only recognizes
 * ZodObject/raw-shape schemas via `.shape` — a top-level z.union(...) has no
 * `.shape`, so normalizeObjectSchema silently returns undefined and the next
 * call, safeParseAsync(undefined, ...), throws "Cannot read properties of
 * undefined (reading '_zod')" on every successful tool call. This is exactly
 * what broke production in commit 0cbcf01 — server-card.ts's zodToJsonSchema
 * path handles unions fine (so /.well-known/mcp/server-card.json looked
 * correct), but the SDK's runtime output validator does not.
 */
export const shortCircuitEnvelopeSchema = z.object({
  status: z.enum(['access_denied', 'injection_blocked', 'confirmation_required']),
  message: z.string(),
});

export type ShortCircuitStatus = z.infer<typeof shortCircuitEnvelopeSchema>['status'];
