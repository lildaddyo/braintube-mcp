import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, extname, basename } from 'path';

export interface VaultFile {
  path: string;       // relative to vault root, using forward slashes
  title: string;      // filename without .md extension
  content: string;    // raw file content
  mtime: string;      // ISO-8601 modification time
}

// Folders to always skip regardless of name
const SKIP_FOLDERS = new Set(['.obsidian', '.trash', '.git']);

/**
 * Recursively walk vaultPath and return all .md files.
 * Skips:
 *   - any file or folder whose name starts with "."
 *   - the .obsidian/ config folder
 */
export function readVault(vaultPath: string): VaultFile[] {
  const results: VaultFile[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      console.warn(`[vault] Cannot read directory "${dir}": ${err}`);
      return;
    }

    for (const entry of entries) {
      // Skip hidden files/folders
      if (entry.startsWith('.')) continue;

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (SKIP_FOLDERS.has(entry)) continue;
        walk(fullPath);
      } else if (stat.isFile() && extname(entry).toLowerCase() === '.md') {
        let content: string;
        try {
          content = readFileSync(fullPath, 'utf8');
        } catch (err) {
          console.warn(`[vault] Cannot read file "${fullPath}": ${err}`);
          continue;
        }

        // Normalise path separator to forward slash for cross-platform consistency
        const relPath = relative(vaultPath, fullPath).replace(/\\/g, '/');
        const title = basename(entry, '.md');

        results.push({
          path: relPath,
          title,
          content,
          mtime: stat.mtime.toISOString(),
        });
      }
    }
  }

  walk(vaultPath);
  return results;
}
