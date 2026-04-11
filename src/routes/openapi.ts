/**
 * OpenAPI 3.0 specification for the BrainTube REST API.
 * Served at GET /openapi.json (no auth required).
 */

export function buildOpenApiSpec(baseUrl: string) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'BrainTube REST API',
      version: '3.9.0',
      description: 'Personal knowledge corpus API. All endpoints require a Supabase JWT via `Authorization: Bearer <token>`. Mirrors the BrainTube MCP tool set over plain HTTP for use by web apps, mobile clients, and chat widgets.',
      contact: { url: 'https://brain-tube.com' },
    },
    servers: [{ url: baseUrl, description: 'BrainTube MCP Server' }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Supabase JWT or BrainTube API key (bt_...)',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string' } },
          required: ['error'],
        },
        SearchResult: {
          type: 'object',
          properties: {
            id:          { type: 'string', format: 'uuid' },
            video_id:    { type: 'string', nullable: true },
            source_type: { type: 'string', example: 'youtube' },
            title:       { type: 'string' },
            channel:     { type: 'string' },
            url:         { type: 'string', format: 'uri' },
            description: { type: 'string', nullable: true },
            summary:     { type: 'string', nullable: true },
            taint_level: { type: 'integer', minimum: 0, maximum: 3 },
            created_at:  { type: 'string', format: 'date-time' },
          },
        },
        TaintedSearchResponse: {
          type: 'object',
          properties: {
            data:          { type: 'array', items: { $ref: '#/components/schemas/SearchResult' } },
            taint_level:   { type: 'integer' },
            taint_warning: { type: 'string', nullable: true },
          },
        },
        Stats: {
          type: 'object',
          properties: {
            total_items:        { type: 'integer' },
            top_sources:        { type: 'array', items: { type: 'object', properties: { source_type: { type: 'string' }, count: { type: 'integer' } } } },
            taint_distribution: { type: 'object', additionalProperties: { type: 'integer' } },
            last_updated:       { type: 'string', format: 'date-time' },
          },
        },
        IngestRequest: {
          type: 'object',
          required: ['title', 'content'],
          properties: {
            title:       { type: 'string', maxLength: 500 },
            content:     { type: 'string', description: 'Full text body of the content' },
            source_url:  { type: 'string', format: 'uri' },
            source_type: { type: 'string', enum: ['note','manual','article','web','document','pdf','ebook','research_paper','work','reddit','medium','substack','github','notion','chatgpt','claude','gemini','wikipedia'] },
            tags:        { type: 'array', items: { type: 'string' }, maxItems: 20 },
            force_new:   { type: 'boolean', default: false },
          },
        },
        IngestResponse: {
          type: 'object',
          properties: {
            id:     { type: 'string', format: 'uuid' },
            title:  { type: 'string' },
            action: { type: 'string', enum: ['inserted', 'updated'] },
          },
        },
        BulkIngestRequest: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              maxItems: 50,
              items: { $ref: '#/components/schemas/IngestRequest' },
            },
            force_new: { type: 'boolean', default: false },
          },
        },
        BulkIngestResponse: {
          type: 'object',
          properties: {
            inserted: { type: 'integer' },
            updated:  { type: 'integer' },
            skipped:  { type: 'integer' },
            errors:   { type: 'array', items: { type: 'string' } },
          },
        },
        Bookmark: {
          type: 'object',
          properties: {
            id:           { type: 'string', format: 'uuid' },
            title:        { type: 'string' },
            source_url:   { type: 'string', format: 'uri', nullable: true },
            source_type:  { type: 'string', nullable: true },
            tags:         { type: 'array', items: { type: 'string' } },
            is_read:      { type: 'boolean' },
            bookmarked_at:{ type: 'string', format: 'date-time' },
          },
        },
      },
    },
    paths: {
      '/api/search': {
        get: {
          operationId: 'search',
          summary: 'Search knowledge corpus',
          description: 'Full-text and semantic search across the user\'s entire corpus.',
          tags: ['Search'],
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 20, default: 5 } },
          ],
          responses: {
            200: { description: 'Search results', content: { 'application/json': { schema: { $ref: '#/components/schemas/TaintedSearchResponse' } } } },
            400: { description: 'Missing query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/search/source': {
        get: {
          operationId: 'searchBySource',
          summary: 'Search filtered by source type',
          tags: ['Search'],
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'type', in: 'query', required: true, schema: { type: 'string' }, description: 'Source type e.g. youtube, notion, web' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 5 } },
          ],
          responses: {
            200: { description: 'Filtered search results', content: { 'application/json': { schema: { $ref: '#/components/schemas/TaintedSearchResponse' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/search/date': {
        get: {
          operationId: 'searchByDate',
          summary: 'Search within a date range',
          tags: ['Search'],
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'after', in: 'query', schema: { type: 'string', format: 'date' }, description: 'ISO 8601 date (inclusive)' },
            { name: 'before', in: 'query', schema: { type: 'string', format: 'date' }, description: 'ISO 8601 date (inclusive)' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 5 } },
          ],
          responses: {
            200: { description: 'Date-scoped search results', content: { 'application/json': { schema: { $ref: '#/components/schemas/TaintedSearchResponse' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/stats': {
        get: {
          operationId: 'getStats',
          summary: 'Corpus statistics',
          description: 'Returns total items, source type breakdown, and taint distribution.',
          tags: ['Corpus'],
          responses: {
            200: { description: 'Corpus stats', content: { 'application/json': { schema: { $ref: '#/components/schemas/Stats' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/recent': {
        get: {
          operationId: 'listRecent',
          summary: 'Recently saved items',
          tags: ['Corpus'],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
          ],
          responses: {
            200: { description: 'Recent items', content: { 'application/json': { schema: { $ref: '#/components/schemas/TaintedSearchResponse' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/related/{item_id}': {
        get: {
          operationId: 'getRelated',
          summary: 'Semantically related items',
          description: 'Vector similarity search relative to the given item.',
          tags: ['Corpus'],
          parameters: [
            { name: 'item_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 20, default: 5 } },
          ],
          responses: {
            200: { description: 'Related items', content: { 'application/json': { schema: { $ref: '#/components/schemas/TaintedSearchResponse' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/resurface': {
        get: {
          operationId: 'resurface',
          summary: 'Random resurface (spaced repetition)',
          description: 'Surface forgotten items using weighted randomness.',
          tags: ['Corpus'],
          parameters: [
            { name: 'n', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 20, default: 5 } },
          ],
          responses: {
            200: { description: 'Resurfaced items', content: { 'application/json': { schema: { $ref: '#/components/schemas/TaintedSearchResponse' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/expertise': {
        get: {
          operationId: 'getExpertise',
          summary: 'Knowledge expertise profile',
          description: 'Topics classified as expert / intermediate / surface / blind spot.',
          tags: ['Profile'],
          responses: {
            200: { description: 'Expertise profile', content: { 'application/json': { schema: { type: 'object' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/conversations': {
        get: {
          operationId: 'getConversations',
          summary: 'Recent AI conversations',
          description: 'Most recently saved Claude and ChatGPT conversations.',
          tags: ['Profile'],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 20, default: 5 } },
          ],
          responses: {
            200: { description: 'Recent conversations', content: { 'application/json': { schema: { type: 'object' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/session-brief': {
        get: {
          operationId: 'getSessionBrief',
          summary: 'Session bootstrap (expertise + conversations + stats)',
          description: 'One-shot payload for initialising a chat session with full user context.',
          tags: ['Profile'],
          responses: {
            200: { description: 'Session brief', content: { 'application/json': { schema: { type: 'object' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/bookmarks': {
        get: {
          operationId: 'listBookmarks',
          summary: 'List bookmarks',
          tags: ['Bookmarks'],
          parameters: [
            { name: 'filter', in: 'query', schema: { type: 'string', enum: ['all', 'unread', 'read'], default: 'unread' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          ],
          responses: {
            200: { description: 'Bookmark list', content: { 'application/json': { schema: { type: 'object', properties: { bookmarks: { type: 'array', items: { $ref: '#/components/schemas/Bookmark' } } } } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/bookmark/{item_id}': {
        post: {
          operationId: 'toggleBookmark',
          summary: 'Bookmark / unbookmark / mark read',
          tags: ['Bookmarks'],
          parameters: [
            { name: 'item_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: { type: 'string', enum: ['bookmark', 'unbookmark', 'mark_read', 'mark_unread'] },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Toggle result', content: { 'application/json': { schema: { type: 'object' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/ingest': {
        post: {
          operationId: 'ingestContent',
          summary: 'Ingest a single item',
          description: 'Deduplicates by source_url then title. Generates embedding immediately.',
          tags: ['Ingest'],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/IngestRequest' } } },
          },
          responses: {
            201: { description: 'Item inserted or updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/IngestResponse' } } } },
            400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/bulk-ingest': {
        post: {
          operationId: 'bulkIngest',
          summary: 'Ingest up to 50 items',
          tags: ['Ingest'],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/BulkIngestRequest' } } },
          },
          responses: {
            200: { description: 'Bulk result', content: { 'application/json': { schema: { $ref: '#/components/schemas/BulkIngestResponse' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/tag/{item_id}': {
        post: {
          operationId: 'tagItem',
          summary: 'Add or remove tags',
          tags: ['Items'],
          parameters: [
            { name: 'item_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    add:    { type: 'array', items: { type: 'string' }, default: [] },
                    remove: { type: 'array', items: { type: 'string' }, default: [] },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Updated tag list', content: { 'application/json': { schema: { type: 'object' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/brains': {
        get: {
          operationId: 'listBrains',
          summary: 'List user\'s Brains',
          description: 'Returns all Brains owned by the authenticated user, ordered by item count descending.',
          tags: ['Brains'],
          responses: {
            200: {
              description: 'Brain list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      brains: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            slug:        { type: 'string' },
                            name:        { type: 'string' },
                            description: { type: 'string', nullable: true },
                            item_count:  { type: 'integer' },
                            tier:        { type: 'string' },
                            is_public:   { type: 'boolean' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/brain-chat/{slug}': {
        post: {
          operationId: 'chatWithBrain',
          summary: 'Chat with a public Brain',
          description: 'Ask a question to a BrainTube Brain. Returns an answer with source citations. No extra auth required beyond the standard bearer token.',
          tags: ['Brains'],
          parameters: [
            { name: 'slug', in: 'path', required: true, schema: { type: 'string' }, description: 'Brain slug from its URL' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['question'],
                  properties: {
                    question:     { type: 'string', minLength: 1 },
                    chat_history: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['role', 'content'],
                        properties: {
                          role:    { type: 'string', enum: ['user', 'assistant'] },
                          content: { type: 'string' },
                        },
                      },
                    },
                    session_id: { type: 'string', description: 'Continue an existing conversation thread' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Brain answer',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      answer:     { type: 'string' },
                      sources:    { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string', nullable: true } } } },
                      session_id: { type: 'string', nullable: true },
                    },
                  },
                },
              },
            },
            400: { description: 'Missing question', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/note/{item_id}': {
        post: {
          operationId: 'addNote',
          summary: 'Add or update a note on an item',
          tags: ['Items'],
          parameters: [
            { name: 'item_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['note'],
                  properties: {
                    note: { type: 'string', minLength: 1, maxLength: 5000 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Note saved', content: { 'application/json': { schema: { type: 'object' } } } },
            401: { description: 'Unauthorized' },
          },
        },
      },
    },
  } as const;
}
