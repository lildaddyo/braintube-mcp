// Matches the `items` table in Supabase (BrainTube's main content table)
export interface Item {
  id: string;
  video_id: string | null;    // YouTube video ID (e.g. "dQw4w9WgXcQ")
  source_type: string;        // youtube | instagram | web | screenshot | linkedin | twitter | ...
  title: string;
  channel: string;
  url: string;
  description?: string;
  full_transcript?: string;
  summary?: string;
  core_thesis?: string;
  key_takeaways?: string[];
  tags?: string[];            // resolved from item_tags → tags join
  taint_level: number;        // 0 = clean, 1 = low, 2 = medium, 3 = high
  created_at: string;
  updated_at: string;
}

export interface SearchResult {
  id: string;
  video_id: string | null;
  source_type: string;
  title: string;
  channel: string;
  url: string;
  description?: string;
  summary?: string;
  taint_level: number;
  created_at: string;
}

export interface TaintedResponse<T> {
  data: T;
  taint_level: number;
  taint_warning?: string;
}

export interface Stats {
  total_items: number;
  top_sources: Array<{ source_type: string; count: number }>;
  taint_distribution: Record<string, number>;
  last_updated: string;
}

export interface AuthContext {
  userId: string;
  email?: string;
  authMethod: 'jwt' | 'apikey';
}
