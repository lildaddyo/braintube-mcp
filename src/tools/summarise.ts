/**
 * Server-side conversation summarisation using the Anthropic API.
 * Reads ANTHROPIC_API_KEY from the environment — never exposed to clients.
 */

const ANTHROPIC_API   = 'https://api.anthropic.com/v1/messages';
const SUMMARIZE_MODEL = 'claude-sonnet-4-20250514';
const MAX_CHARS       = 50_000;

export interface SummariseResult {
  title: string;
  summary: string;
}

export async function summariseConversation(
  rawText: string,
  platform: 'claude' | 'chatgpt' | string
): Promise<SummariseResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured on the server.');
  }

  const truncated = rawText.length > MAX_CHARS
    ? rawText.slice(0, MAX_CHARS) + '\n\n[...conversation truncated at 50K chars...]'
    : rawText;

  const platformLabel = platform === 'claude' ? 'Claude' : 'ChatGPT';

  const prompt =
`You are summarizing a ${platformLabel} AI conversation for a personal knowledge base called BrainTube.

Create a concise digest (~300 tokens) with this structure:

**Title**: One-line topic summary
**Key Insights**: 3-5 bullet points of the most important ideas or findings
**Decisions**: Any choices, conclusions, or recommendations reached (omit section if none)
**Action Items**: Concrete next steps identified (omit section if none)
**Context**: 1-2 sentences of background/purpose

Be specific and preserve technical details. Skip pleasantries and filler.

Conversation:
---
${truncated}`;

  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: SUMMARIZE_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`Anthropic API error ${resp.status}: ${err?.error?.message ?? resp.statusText}`);
  }

  const data = await resp.json() as { content?: Array<{ text?: string }> };
  const summaryText = data.content?.[0]?.text?.trim() ?? '';
  if (!summaryText) throw new Error('Summarisation returned empty result.');

  // Extract title from the **Title**: line, fall back to first non-empty line
  const titleMatch = summaryText.match(/^\*\*Title\*\*:\s*(.+)/m);
  const title = (titleMatch?.[1]?.trim() ?? summaryText.split('\n').find(l => l.trim()) ?? 'AI Conversation')
    .slice(0, 120);

  return { title, summary: summaryText };
}
