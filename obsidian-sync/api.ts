export interface NotePayload {
  path: string;
  title: string;
  content: string;
  tags: string[];
  modified_at: string;
}

export interface SyncResult {
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export class BrainTubeClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;

  constructor(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async ingestBatch(notes: NotePayload[]): Promise<SyncResult> {
    const url = `${this.apiUrl}/api/obsidian-sync`;
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ notes }),
      });
    } catch (err) {
      throw new Error(`Network error reaching ${url}: ${err}`);
    }

    if (response.status === 401) {
      throw new Error('Invalid API key — run `generate_api_key` via the MCP server and update BRAINTUBE_API_KEY');
    }

    if (response.status === 429) {
      throw new Error('Rate limited — reduce BATCH_SIZE or add a delay between batches');
    }

    if (response.status >= 500) {
      const body = await response.text().catch(() => '(no body)');
      throw new Error(`Server error ${response.status}: ${body}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(no body)');
      throw new Error(`Unexpected response ${response.status}: ${body}`);
    }

    const result = await response.json() as SyncResult;
    return result;
  }
}
