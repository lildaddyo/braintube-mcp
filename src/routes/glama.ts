/**
 * GET /.well-known/glama.json
 *
 * Glama connector ownership verification — per Glama's own documented
 * mechanism (see the "How do I verify ownership of this connector?" panel
 * on https://glama.ai/mcp/connectors/io.github.lildaddyo/braintube-mcp),
 * a server claims its Glama connector listing by publishing this file at
 * /.well-known/glama.json on the server's own domain — not as a repo file.
 * Schema: https://glama.ai/mcp/schemas/connector.json (fetched directly;
 * the only documented field is `maintainers`, an array of { email }).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';

export const glamaRouter = Router();

glamaRouter.get('/.well-known/glama.json', (_req: Request, res: Response) => {
  res.json({
    $schema: 'https://glama.ai/mcp/schemas/connector.json',
    maintainers: [{ email: 'ilian@vrexpress.io' }],
  });
});
