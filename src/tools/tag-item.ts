import { z } from 'zod';
import { dbAdmin } from '../db/supabase.js';

export const tagItemSchema = z.object({
  item_id: z.string().uuid().describe('UUID of the item to tag'),
  add: z.array(z.string().min(1).max(50)).default([]).describe('Tags to add (e.g. ["ai", "productivity"])'),
  remove: z.array(z.string().min(1).max(50)).default([]).describe('Tags to remove')
});

export async function tagItem(input: z.infer<typeof tagItemSchema>, userId: string) {
  const { item_id, add, remove } = input;

  if (add.length === 0 && remove.length === 0) {
    throw new Error('Provide at least one tag in add[] or remove[]');
  }

  // Ownership check + fetch current tags
  const { data: item, error: fetchErr } = await dbAdmin
    .from('items')
    .select('id, tags')
    .eq('id', item_id)
    .eq('user_id', userId)
    .single();

  if (fetchErr || !item) throw new Error('Item not found or does not belong to this user');

  const current: string[] = (item.tags as string[] | null) ?? [];

  // Apply add / remove
  const normalized = (tags: string[]) => tags.map(t => t.trim().toLowerCase()).filter(Boolean);
  const toAdd = normalized(add);
  const toRemove = new Set(normalized(remove));

  const updated = [
    ...new Set([...current.filter(t => !toRemove.has(t)), ...toAdd])
  ];

  const { error: updateErr } = await dbAdmin
    .from('items')
    .update({ tags: updated })
    .eq('id', item_id)
    .eq('user_id', userId);

  if (updateErr) throw new Error(`Failed to update tags: ${updateErr.message}`);

  const added = toAdd.filter(t => !current.includes(t));
  const removed = current.filter(t => toRemove.has(t));

  return {
    content: [{
      type: 'text' as const,
      text: [
        `Tags updated for item ${item_id}.`,
        added.length ? `Added: ${added.join(', ')}` : null,
        removed.length ? `Removed: ${removed.join(', ')}` : null,
        `Current tags: ${updated.length ? updated.join(', ') : '(none)'}`
      ].filter(Boolean).join('\n')
    }],
    structuredContent: { item_id, tags: updated, added, removed } as unknown as Record<string, unknown>
  };
}
