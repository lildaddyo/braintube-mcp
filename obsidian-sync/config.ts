// Load .env if present (optional — env vars may already be set by shell)
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// ─── Validate required vars ───────────────────────────────────────────────────

function required(name: string): string {
  const val = process.env[name];
  if (!val || !val.trim()) {
    throw new Error(
      `Missing required env var: ${name}\n` +
      `Copy .env.example → .env and fill in your values.`
    );
  }
  return val.trim();
}

// ─── Config object ────────────────────────────────────────────────────────────

export const config = {
  vaultPath:  required('VAULT_PATH'),
  apiKey:     required('BRAINTUBE_API_KEY'),
  apiUrl:     (process.env.BRAINTUBE_API_URL ?? 'https://braintube-mcp-production.up.railway.app').replace(/\/$/, ''),
  batchSize:  parseInt(process.env.BATCH_SIZE ?? '20', 10) || 20,
  dryRun:     process.env.DRY_RUN === 'true',
};
