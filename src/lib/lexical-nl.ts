// PGroonga lexical leg for non-Latin queries (Korean retrieval brief v2, Phase 2; dark-n-cozy migration
// 20261025010000_ko_pgroonga_lexical). The hybrid search RPCs have _nl twins (adaptive_search_nl, hybrid_search_nl,
// search_segments_nl): same arguments and columns, but their lexical list also holds PGroonga (bigram, TF-IDF) matches on
// non-Latin segment text, where the English to_tsvector only matches whole words. A query uses the twin only when
// KO_PGROONGA=on (default off) AND the shared script detector says it is non-Latin, so with the flag off, and for every
// Latin query (including the English translation of a Korean query), the RPC is exactly the one called before.
// Same rule as dark-n-cozy supabase/functions/_shared/lexical-nl.ts.
import { detectScript } from './script.js';

export type NlRpc = 'adaptive_search' | 'hybrid_search' | 'search_segments';

export function koPgroongaOn(): boolean {
  return process.env.KO_PGROONGA === 'on';
}

/** The RPC to call for this query: the _nl twin when the flag is on and the query is non-Latin, else the name itself. */
export function lexicalRpc<T extends NlRpc>(name: T, query: string | null | undefined, on: boolean = koPgroongaOn()): T | `${T}_nl` {
  return on && detectScript(query).nonLatin ? `${name}_nl` : name;
}
