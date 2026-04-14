/**
 * compile_knowledge    — invoke the compile-knowledge edge function
 * get_concept_articles — query concept_articles with optional filters
 */

import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

const COMPILE_KNOWLEDGE_URL =
  'https://iqjnmmtvhyavgrsxpoao.supabase.co/functions/v1/compile-knowledge';

// ── compile_knowledge ─────────────────────────────────────────────────────────

export const compileKnowledgeSchema = z.object({
  cluster_id: z.string().uuid().optional().describe(
    'UUID of a topic_cluster to compile. Either cluster_id or brain_id must be provided.'
  ),
  brain_id: z.string().uuid().optional().describe(
    'UUID of a Brain to compile all its clusters. Either cluster_id or brain_id must be provided.'
  ),
}).refine(d => d.cluster_id || d.brain_id, {
  message: 'Provide cluster_id or brain_id',
});

export async function compileKnowledge(
  input: z.infer<typeof compileKnowledgeSchema>,
  userJwt?: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  const body: Record<string, string> = {};
  if (input.cluster_id) body.cluster_id = input.cluster_id;
  if (input.brain_id)   body.brain_id   = input.brain_id;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (userJwt) {
    headers['Authorization'] = `Bearer ${userJwt}`;
    headers['apikey'] = userJwt;
  }

  const res = await fetch(COMPILE_KNOWLEDGE_URL, {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(60_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`compile-knowledge returned ${res.status}: ${text.slice(0, 400)}`);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  const articlesCreated = (data.articles_created as number | undefined) ?? (data.created as number | undefined);
  const summary = articlesCreated != null
    ? `Compiled ${articlesCreated} concept article(s).`
    : `compile-knowledge completed: ${text.slice(0, 300)}`;

  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: data,
  };
}

// ── get_concept_articles ──────────────────────────────────────────────────────

export const getConceptArticlesSchema = z.object({
  cluster_id: z.string().uuid().optional().describe('Filter by topic_cluster UUID'),
  brain_id:   z.string().uuid().optional().describe('Filter by Brain UUID'),
  query:      z.string().min(1).max(300).optional().describe(
    'Optional text search against title and body'
  ),
  limit: z.number().int().min(1).max(50).default(10).describe(
    'Max articles to return (default 10)'
  ),
});

export async function getConceptArticles(
  input: z.infer<typeof getConceptArticlesSchema>,
  userId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> }> {
  let q = dbAdmin
    .from('concept_articles')
    .select('id, title, slug, word_count, backlinks, cluster_id, brain_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(input.limit);

  if (input.cluster_id) q = q.eq('cluster_id', input.cluster_id);
  if (input.brain_id)   q = q.eq('brain_id', input.brain_id);
  if (input.query) {
    const term = `%${input.query}%`;
    q = q.or(`title.ilike.${term},content.ilike.${term}`);
  }

  const { data, error } = await q;
  if (error) throw new Error(`get_concept_articles failed: ${error.message}`);

  const articles = (data ?? []) as Array<{
    id: string;
    title: string;
    slug: string;
    word_count: number | null;
    backlinks: string[] | null;
    cluster_id: string | null;
    brain_id: string | null;
    created_at: string;
  }>;

  if (articles.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No concept articles found.' }],
      structuredContent: { articles: [] },
    };
  }

  const lines = [
    `${articles.length} concept article(s):`,
    '',
    ...articles.map((a, i) =>
      `${i + 1}. **${a.title}** (${a.slug})\n` +
      `   Words: ${a.word_count ?? '?'} | Backlinks: ${a.backlinks?.length ?? 0} | ${a.created_at.slice(0, 10)}`
    ),
  ];

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: { articles } as unknown as Record<string, unknown>,
  };
}
