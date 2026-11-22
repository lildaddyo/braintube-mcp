# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting ("Report a vulnerability" on this repository's
Security tab), or write to support@brain-tube.com. Please do not open a public issue for a
security problem. We reply within a few working days.

## How BrainTube treats saved content

BrainTube stores what you save (transcripts, articles, notes, imports) and gives it back to your
AI assistant through MCP. Saved text can contain instructions written by someone else and aimed
at the AI that reads it (prompt injection). BrainTube's position:

- **Saved content is data, not instructions.** Every tool that returns saved content wraps it in
  a clearly labelled envelope that the content itself cannot close, and says so in the tool
  description.
- **Every item records where it came from.** Only text you typed in the BrainTube app is treated
  as trusted; anything saved by an assistant, captured from a site or imported is untrusted.
- **Risky actions need you.** Batch writes and anything that changes a credential ask you for
  confirmation in your AI client. The AI cannot answer that prompt for you.
- **Tenant isolation.** Every request is scoped to the account behind a validated OAuth token or
  API key; you only ever see your own library.
- **No outbound fetches on your behalf.** BrainTube stores the text your client sends; it does not
  fetch URLs you ask it to save.

## Scope

In scope: `mcp.brain-tube.com`, `app.brain-tube.com`, `brain-tube.com` and the BrainTube apps
and browser extension. Please do not run automated scanners at volume, access other users' data,
or degrade the service while testing.
