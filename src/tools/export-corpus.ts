import { z } from 'zod';
import { edgeAuthHeaders } from '../lib/edge-auth.js';

const EXPORT_CORPUS_URL =
  'https://iqjnmmtvhyavgrsxpoao.supabase.co/functions/v1/export-corpus';

export const exportCorpusSchema = z.object({});

export const exportCorpusOutputSchema = z.object({}).passthrough();

export async function exportCorpus(
  _input: z.infer<typeof exportCorpusSchema>,
  userId: string,
  userJwt?: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const headers = edgeAuthHeaders(userId, userJwt);

  const res = await fetch(EXPORT_CORPUS_URL, {
    method:  'POST',
    headers,
    body:    JSON.stringify({}),
    signal:  AbortSignal.timeout(60_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`export-corpus returned ${res.status}: ${text.slice(0, 400)}`);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  const downloadUrl = data.download_url as string | undefined;
  const summary = downloadUrl
    ? `Corpus exported. Download your ZIP:\n${downloadUrl}`
    : `export-corpus completed: ${text.slice(0, 400)}`;

  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: data,
  };
}
