/**
 * Human confirmation for destructive and credential-changing tools.
 *
 * Before 2026-11-01 these tools asked the CALLER to repeat the call with `confirm: true`. The
 * caller is the AI agent, and an agent steered by injected text can simply do that, so the gate
 * had no human in it. Now the server asks the person directly through MCP elicitation
 * (`elicitation/create`): the client shows them a prompt the model cannot answer for them.
 *
 * A client without elicitation support gets a refusal that sends the user to the BrainTube app.
 * Nothing the model puts in the tool arguments (`confirm: true` or anything else) can stand in for
 * the person's answer.
 */

import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';

/** Tools that must not run without a human saying yes. */
export const HUMAN_CONFIRM_REQUIRED = new Set([
  // batch / corpus-wide writes
  'bulk_ingest',
  'ingest_notion_database',
  'backfill_embeddings',
  'recompute_salience',
  'compute_centrality',
  // credentials: an injected agent could swap the user's Notion / Readwise account for an
  // attacker-controlled one and poison every later import, or mint itself a permanent key
  'generate_api_key',
  'set_notion_api_key',
  'connect_readwise',
]);

export const APP_URL = 'https://braintube.app';

export type ConfirmOutcome =
  | { ok: true }
  | { ok: false; status: 'confirmation_unavailable' | 'confirmation_declined'; message: string };

/** What secureWrap needs from the live session to ask the person. */
export interface ConfirmContext {
  clientCapabilities: () => ClientCapabilities | undefined;
  /** Sends `elicitation/create` tied to the current tool call. Absent outside a request. */
  sendRequest?: (req: { method: 'elicitation/create'; params: Record<string, unknown> }) => Promise<unknown>;
}

const TIMEOUT_MS = 10 * 60 * 1000;

function supportsFormElicitation(caps: ClientCapabilities | undefined): boolean {
  const e = (caps as { elicitation?: Record<string, unknown> } | undefined)?.elicitation;
  if (!e) return false;
  // Spec 2025-11-25: `{}` means form mode; an explicit `form` key also does.
  return Object.keys(e).length === 0 || 'form' in e;
}

export function unavailableMessage(toolName: string, preview: string): string {
  return [
    `🔒 \`${toolName}\` needs your confirmation, and this AI client cannot show a confirmation prompt.`,
    '',
    '**What it would do:**',
    preview,
    '',
    `To protect your account, BrainTube does not accept a confirmation from the AI itself. ` +
    `Do this in the BrainTube app instead (${APP_URL}), or use an AI client that supports MCP confirmation prompts (elicitation).`,
  ].join('\n');
}

export async function requestHumanConfirmation(
  ctx: ConfirmContext,
  toolName: string,
  preview: string,
): Promise<ConfirmOutcome> {
  if (!ctx.sendRequest || !supportsFormElicitation(ctx.clientCapabilities())) {
    return { ok: false, status: 'confirmation_unavailable', message: unavailableMessage(toolName, preview) };
  }

  let raw: unknown;
  try {
    raw = await Promise.race([
      ctx.sendRequest({
        method: 'elicitation/create',
        params: {
          message: `BrainTube: an AI assistant wants to run "${toolName}".\n\n${preview}\n\nOnly approve if YOU asked for this.`,
          requestedSchema: {
            type: 'object',
            properties: {
              approve: {
                type: 'boolean',
                title: 'Approve',
                description: `Run ${toolName} now`,
                default: false,
              },
            },
            required: ['approve'],
          },
        },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS).unref()),
    ]);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 'confirmation_unavailable',
      message: `${unavailableMessage(toolName, preview)}\n\n(Confirmation prompt failed: ${why})`,
    };
  }

  const parsed = ElicitResultSchema.safeParse(raw);
  if (parsed.success && parsed.data.action === 'accept' && parsed.data.content?.approve === true) {
    return { ok: true };
  }
  return {
    ok: false,
    status: 'confirmation_declined',
    message: `\`${toolName}\` was not run: the user did not approve it.`,
  };
}
