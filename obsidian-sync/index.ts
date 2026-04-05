import { config } from './config.ts';
import { readVault } from './vault.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { BrainTubeClient } from './api.ts';
import type { NotePayload } from './api.ts';

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = config.dryRun || args.includes('--dry-run');
const vaultOverride = args.find(a => a.startsWith('--vault='))?.slice('--vault='.length);
const vaultPath = vaultOverride ?? config.vaultPath;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\nBrainTube Obsidian Sync`);
  console.log(`Vault: ${vaultPath}`);
  console.log(`API:   ${config.apiUrl}`);
  console.log(`Mode:  ${dryRun ? 'DRY RUN (no data sent)' : 'LIVE'}\n`);

  // ── Read vault ──────────────────────────────────────────────────────────────
  console.log('Reading vault...');
  const files = readVault(vaultPath);
  console.log(`Found ${files.length} markdown files.\n`);

  if (files.length === 0) {
    console.log('Nothing to sync.');
    process.exit(0);
  }

  // ── Dry-run: print sample and exit ─────────────────────────────────────────
  if (dryRun) {
    console.log('Sample files (first 3):');
    for (const f of files.slice(0, 3)) {
      const { tags } = parseFrontmatter(f.content);
      console.log(`  • ${f.title}  [${f.path}]${tags.length ? `  tags: ${tags.join(', ')}` : ''}`);
    }
    console.log(`\nDry-run complete. ${files.length} files would be synced.`);
    process.exit(0);
  }

  // ── Build payloads ──────────────────────────────────────────────────────────
  const payloads: NotePayload[] = files.map(f => {
    const { tags, body } = parseFrontmatter(f.content);
    return {
      path: f.path,
      title: f.title,
      content: body,
      tags,
      modified_at: f.mtime,
    };
  });

  // ── Batch and send ──────────────────────────────────────────────────────────
  const client = new BrainTubeClient(config.apiUrl, config.apiKey);
  const batchSize = config.batchSize;
  const batches: NotePayload[][] = [];
  for (let i = 0; i < payloads.length; i += batchSize) {
    batches.push(payloads.slice(i, i + batchSize));
  }

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  const allErrors: string[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    process.stdout.write(`Batch ${i + 1}/${batches.length} (${batch.length} notes)... `);

    try {
      const result = await client.ingestBatch(batch);
      totalInserted += result.inserted;
      totalUpdated += result.updated;
      totalSkipped += result.skipped;
      allErrors.push(...result.errors);
      console.log(`✓  inserted: ${result.inserted}, updated: ${result.updated}, skipped: ${result.skipped}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗  ${msg}`);
      // Abort on auth/fatal errors, continue on others
      if (msg.includes('Invalid API key') || msg.includes('Network error')) {
        console.error('\nFatal error — aborting.');
        process.exit(1);
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n─── Sync complete ─────────────────────────────────────────');
  console.log(`  Inserted : ${totalInserted}`);
  console.log(`  Updated  : ${totalUpdated}`);
  console.log(`  Skipped  : ${totalSkipped}`);
  console.log(`  Errors   : ${allErrors.length}`);
  if (allErrors.length > 0) {
    console.log('\nErrors:');
    for (const e of allErrors) console.log(`  • ${e}`);
  }
  console.log('───────────────────────────────────────────────────────────\n');
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
