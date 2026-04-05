import matter from 'gray-matter';

export interface ParsedNote {
  tags: string[];
  body: string;
}

/**
 * Parse YAML/TOML frontmatter from a markdown string.
 * Returns { tags, body } where:
 *   - tags: array of tag strings (from frontmatter `tags` or `tag` field)
 *   - body: content with frontmatter stripped
 * Falls back gracefully if no frontmatter or if tags field is missing/malformed.
 */
export function parseFrontmatter(raw: string): ParsedNote {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    // Malformed frontmatter — treat as plain body
    return { tags: [], body: raw };
  }

  const { data, content } = parsed;

  // Support both `tags:` and `tag:` frontmatter keys, as string or array
  const rawTags = data['tags'] ?? data['tag'] ?? [];
  const tags: string[] = Array.isArray(rawTags)
    ? rawTags.map(String).filter(Boolean)
    : typeof rawTags === 'string'
      ? rawTags.split(/[,\s]+/).map(t => t.trim()).filter(Boolean)
      : [];

  return { tags, body: content.trim() };
}
