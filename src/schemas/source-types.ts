import { z } from 'zod';

export const SOURCE_TYPES = [
  'youtube', 'article', 'note', 'tiktok', 'instagram', 'twitter',
  'linkedin', 'web', 'medium', 'substack', 'reddit', 'devto',
  'hashnode', 'github', 'wikipedia', 'notion', 'chatgpt', 'claude',
  'gemini', 'quora', 'spotify', 'soundcloud', 'apple_music', 'bandcamp',
  'apple_podcasts', 'ebook', 'pdf', 'document', 'screenshot',
  'youtube_music', 'work', 'research_paper', 'obsidian', 'manual',
  'bookmark', 'synthesis', 'meeting', 'audiobook', 'podcast',
  'readwise', 'email', 'rss', 'zotero', 'heptabase', 'voice_memo',
] as const;

export type SourceType = typeof SOURCE_TYPES[number];

export const sourceTypeEnum = z.enum(SOURCE_TYPES);
