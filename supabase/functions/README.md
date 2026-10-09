# Edge functions in this repo

Only these functions are owned and deployed from braintube-mcp:

- `handle-notion-webhook`
- `connect-md`
- `backfill-embeddings` (not deployed as of 2026-10-09)

`chat` and `track` used to have copies here. They were stale: the live versions are owned by
`lildaddyo/dark-n-cozy` (credits, message caps, auth), and running `supabase functions deploy`
from this repo would have overwritten the hardened production code with an unmetered
Anthropic proxy and an unauthenticated tracker (fleet audit 2026-10-09, BTMCP-09). They were
removed on purpose. Change and deploy `chat` and `track` from dark-n-cozy only.

Deploy one function at a time by name (`supabase functions deploy <name>`), never the whole
folder.
