import { z } from 'zod';
import { writeNote } from '../db/supabase.js';

export const noteSchema = z.object({
  video_id: z.string().describe('Internal UUID of the item to annotate'),
  note: z.string().min(1).max(5000).describe('Note or AI-generated synthesis to save')
  // write_token REMOVED — JWT ownership check in db layer replaces it
});

export const addNoteOutputSchema = z.object({
  item_id: z.string(),
  note_length: z.number(),
});

export async function addNote(input: z.infer<typeof noteSchema>, userId: string) {
  await writeNote(input.video_id, input.note, userId);
  return {
    content: [{
      type: 'text' as const,
      text: `Note saved to item ${input.video_id}. Length: ${input.note.length} chars.`
    }],
    structuredContent: { item_id: input.video_id, note_length: input.note.length } as unknown as Record<string, unknown>
  };
}
