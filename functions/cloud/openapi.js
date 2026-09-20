// OpenAPI 3.1 document generation for the Telegraph Cloud developer API.
//
// Honesty contract: this module documents only routes that exist in this
// deployment. The catalog below is the single source for the generated
// document; the accuracy test (test/openapi.test.js) asserts that every
// documented path maps to a real function file in the repository.
//
// Two variants are generated from the same catalog:
//   - global:     GET /openapi.json (public) — the developer data plane.
//   - project:    GET /api/projects/{id}/openapi.json (dashboard session)
//                 — adds x-project and x-collections with example request
//                 bodies derived from each collection's schema.
//
// Dashboard control-plane routes (/api/projects/*, /api/manage/*) are
// operator surfaces authenticated by session, not developer credentials;
// they are documented in docs/ and the console, not in this document.
export const OPENAPI_VERSION = '3.1.0';
export const SERVICE_NAME = 'Telegraph Cloud';
export const API_VERSION = '1.0.0';
const AUDIENCE = 'telegraph-api';

// Developer data-plane routes. method/path/auth/scope mirror the real
// function files under functions/ (see test/openapi.test.js for the
// path-to-file accuracy mapping).
const DATA_PLANE = [
  { path: '/api/db/{collection}', methods: ['get', 'post'] },
  { path: '/api/db/{collection}/{recordId}', methods: ['get', 'patch', 'delete'] },
  { path: '/api/storage/{bucket}', methods: ['get'] },
  { path: '/api/storage/{bucket}/{key}', methods: ['put', 'get', 'head', 'delete'] },
  { path: '/s3/{bucket}', methods: ['get'] },
  { path: '/s3/{bucket}/{key}', methods: ['get', 'head', 'put', 'delete'] },
  { path: '/api/health', methods: ['get'] },
  { path: '/openapi.json', methods: ['get'] },
];

function scopeFor(method, kind) {
  if (kind === 'storage') {
    return ['put', 'delete'].includes(method) ? 'storage:write' : 'storage:read';
  }
  if (kind === 'db') {
    return ['post', 'patch', 'delete'].includes(method) ? 'db:write' : 'db:read';
  }
  return null;
}

function errorResponse(description) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            error: { type: 'string', description: 'Stable machine-readable error code.' },
            current_version: {
              type: 'integer',
              description: 'Present on version_conflict: the current record version.',
            },
          },
          required: ['error'],
        },
        examples: {
          version_conflict: {
            value: { error: 'version_conflict', current_version: 3 },
          },
        },
      },
    },
  };
}

function bearerSecurity(scope) {
  return { bearerApi: scope ? [scope] : [] };
}

function operationFor(route, method, { collectionExamples = [] } = {}) {
  const path = route.path;
  const kind = path.startsWith('/api/db') ? 'db' : path.startsWith('/api/storage') ? 'storage' : null;
  const isPublic = path === '/api/health' || path === '/openapi.json';
  const security = isPublic ? [] : kind === 'storage' || path.startsWith('/s3/')
    ? (path.startsWith('/s3/') ? [{ awsSigV4: [] }] : [bearerSecurity(scopeFor(method, kind))])
    : [bearerSecurity(scopeFor(method, kind))];

  const op = {
    operationId: `${method}_${path.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')}`,
    security,
    tags: [kind === 'db' ? 'Database' : kind === 'storage' ? 'Storage' : path.startsWith('/s3/') ? 'S3' : 'Platform'],
    responses: {},
  };

  if (isPublic && path === '/api/health') {
    op.summary = 'Deployment health signal.';
    op.responses = {
      200: {
        description: 'Health status of the deployment.',
        content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['ok', 'degraded'] } }, required: ['status'] } } },
      },
    };
    return op;
  }

  if (isPublic && path === '/openapi.json') {
    op.summary = 'This machine-readable API description.';
    op.responses = {
      200: {
        description: 'OpenAPI 3.1 document.',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
    };
    return op;
  }

  // ------------------------------------------------------------- database
  if (kind === 'db') {
    const collectionParam = {
      name: 'collection',
      in: 'path',
      required: true,
      schema: { type: 'string', pattern: '^[a-z][a-z0-9_-]*$', example: 'products' },
      description: 'Collection name.',
    };
    const recordIdParam = {
      name: 'recordId',
      in: 'path',
      required: true,
      schema: { type: 'string', example: 'rec_0123456789abcdef01234567' },
      description: 'Server-generated record ID.',
    };

    if (method === 'get' && !path.includes('{recordId}')) {
      op.summary = 'List documents in a collection.';
      op.parameters = [
        collectionParam,
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, description: 'Page size.' },
        { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque pagination cursor from the previous page.' },
        { name: '<field>', in: 'query', required: false, schema: { type: 'string' }, description: 'Exact-match filter: repeat <field>=<value> pairs for top-level string fields.' },
      ];
      op.responses = {
        200: {
          description: 'One page of records, ordered by ID ascending.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: { $ref: '#/components/schemas/Record' } },
                  order: { type: 'string', example: 'id:asc' },
                  limit: { type: 'integer' },
                  has_more: { type: 'boolean' },
                  next_cursor: { type: ['string', 'null'] },
                },
                required: ['data', 'order', 'limit', 'has_more'],
              },
            },
          },
        },
        ...errorMap(['400: invalid_query_filter', '401: unauthenticated or invalid_api_key', '403: api_key_scope_forbidden', '429: rate_limited', '500: internal_error']),
      };
      return op;
    }

    if (method === 'post') {
      op.summary = 'Create a document.';
      op.parameters = [
        collectionParam,
        {
          name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' },
          description: 'Retries with the same key and body return the original result without appending another revision.',
        },
      ];
      op.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: { type: 'object' },
              description: 'The JSON document. Collections with a schema enforce required fields, types, defaults, select options, and reject fields outside the schema; schema-less collections accept arbitrary JSON.',
            },
            examples: exampleBodies(collectionExamples, { method, path }),
          },
        },
      };
      op.responses = {
        201: {
          description: 'The created record at version 1.',
          headers: { Location: { description: 'URL of the created record.', schema: { type: 'string' } } },
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordResponse' } } },
        },
        ...errorMap(['400: document_too_large, schema_validation_failed, managed_field_not_allowed', '401: unauthenticated or invalid_api_key', '403: api_key_scope_forbidden', '413: document_too_large', '429: rate_limited', '500: internal_error']),
      };
      return op;
    }

    if (path.includes('{recordId}')) {
      op.parameters = [collectionParam, recordIdParam];
      if (method === 'get') {
        op.summary = 'Read one document.';
        op.responses = {
          200: {
            description: 'The current record.',
            headers: { ETag: { description: 'Opaque version tag.', schema: { type: 'string' } } },
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordResponse' } } },
          },
          ...errorMap(['401: unauthenticated or invalid_api_key', '403: api_key_scope_forbidden', '404: record_not_found', '500: internal_error']),
        };
        return op;
      }
      const preconditions = [
        collectionParam, recordIdParam,
      ];
      op.parameters = preconditions;
      if (method === 'patch') {
        op.summary = 'Update a document (creates a new revision).';
        op.requestBody = {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  _expected_version: { type: 'integer', minimum: 1, description: 'Optimistic concurrency precondition: the version the client last read.' },
                },
                additionalProperties: true,
                required: ['_expected_version'],
                description: 'The changed fields plus _expected_version.',
              },
              examples: exampleBodies(collectionExamples, { method, path }),
            },
          },
        };
        op.responses = {
          200: { description: 'The new record revision.', content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordResponse' } } } },
          ...errorMap(['400: schema_validation_failed, empty_patch, document_too_large', '401: unauthenticated or invalid_api_key', '403: api_key_scope_forbidden', '404: record_not_found', '409: version_conflict', '429: rate_limited', '500: internal_error']),
        };
        return op;
      }
      // delete
      op.summary = 'Delete a document (versioned tombstone; not a physical purge).';
      op.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { _expected_version: { type: 'integer', minimum: 1 } },
              required: ['_expected_version'],
            },
          },
        },
      };
      op.responses = {
        200: { description: 'The deletion revision.', content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordResponse' } } } },
        ...errorMap(['401: unauthenticated or invalid_api_key', '403: api_key_scope_forbidden', '404: record_not_found', '409: version_conflict', '429: rate_limited', '500: internal_error']),
      };
      return op;
    }
  }

  // -------------------------------------------------------------- storage
  if (kind === 'storage') {
    const bucketParam = {
      name: 'bucket', in: 'path', required: true,
      schema: { type: 'string', pattern: '^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$', example: 'assets' },
      description: 'Bucket name (created implicitly on first object upload).',
    };
    const keyParam = {
      name: 'key', in: 'path', required: true, schema: { type: 'string', example: 'notes/readme.txt' },
      description: 'Object key (path segments).',
    };

    if (method === 'get' && !path.includes('{key}')) {
      op.summary = 'List objects in a bucket.';
      op.parameters = [
        bucketParam,
        { name: 'prefix', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'delimiter', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000 } },
        { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      ];
      op.responses = {
        200: { description: 'One page of objects (and common prefixes).', content: { 'application/json': { schema: { $ref: '#/components/schemas/ObjectList' } } } },
        ...errorMap(['401: unauthenticated or invalid_api_key', '403: api_key_scope_forbidden', '404: bucket_not_found', '500: internal_error']),
      };
      return op;
    }

    op.parameters = [bucketParam, keyParam];
    if (method === 'put') {
      op.summary = 'Upload an object (same engine as Drive and S3).';
      op.requestBody = {
        required: true,
        content: {
          'application/octet-stream': {
            schema: { type: 'string', format: 'binary' },
            description: 'Raw object bytes. Content-Type is stored as metadata.',
          },
        },
      };
      op.responses = {
        200: { description: 'Object metadata after the write.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Object' } } } },
        ...errorMap(['400: invalid_object_key, object_too_large', '401: unauthenticated or invalid_api_key', '403: api_key_scope_forbidden', '413: object_too_large', '429: rate_limited', '500: internal_error']),
      };
      return op;
    }
    if (method === 'get') {
      op.summary = 'Download an object (byte ranges and conditional requests supported).';
      op.parameters = [
        ...op.parameters,
        { name: 'Range', in: 'header', required: false, schema: { type: 'string', example: 'bytes=0-1023' }, description: 'Byte range.' },
        { name: 'If-Match', in: 'header', required: false, schema: { type: 'string' }, description: 'Condition on the object ETag.' },
        { name: 'download', in: 'query', required: false, schema: { type: 'string', enum: ['1'] }, description: 'Force a content-disposition download name.' },
      ];
      op.responses = {
        200: { description: 'Object bytes.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        206: { description: 'Partial content.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        ...errorMap(['401: unauthenticated or invalid_api_key', '403: api_key_scope_forbidden', '404: object_not_found', '416: range_not_satisfiable', '500: internal_error']),
      };
      return op;
    }
    if (method === 'head') {
      op.summary = 'Object metadata without the body.';
      op.responses = {
        200: { description: 'Metadata headers (ETag, Content-Type, Content-Length, version).', headers: { ETag: { schema: { type: 'string' }, description: 'Object revision tag.' } } },
        ...errorMap(['401: unauthenticated or invalid_api_key', '403: api_key_scope_forbidden', '404: object_not_found', '500: internal_error']),
      };
      return op;
    }
    op.summary = 'Delete an object.';
    op.responses = {
      200: { description: 'Deletion result.', content: { 'application/json': { schema: { type: 'object' } } } },
      ...errorMap(['401: unauthenticated or invalid_api_key', '403: api_key_scope_forbidden', '404: object_not_found', '429: rate_limited', '500: internal_error']),
    };
    return op;
  }

  // ------------------------------------------------------------------- s3
  if (path.startsWith('/s3/')) {
    const bucketParam = { name: 'bucket', in: 'path', required: true, schema: { type: 'string' }, description: 'Bucket name.' };
    const keyParam = { name: 'key', in: 'path', required: true, schema: { type: 'string' }, description: 'Object key.' };
    op.security = [{ awsSigV4: [] }];
    op.description = 'AWS Signature Version 4 (header form), fixed region us-east-1, path-style addressing. The same object engine as Drive and the object API.';
    if (path === '/s3/{bucket}') {
      op.summary = 'S3 ListObjectsV2.';
      op.parameters = [
        bucketParam,
        { name: 'list-type', in: 'query', required: true, schema: { type: 'string', enum: ['2'] } },
        { name: 'prefix', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'delimiter', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'max-keys', in: 'query', required: false, schema: { type: 'integer' } },
        { name: 'continuation-token', in: 'query', required: false, schema: { type: 'string' } },
      ];
      op.responses = { 200: { description: 'S3 ListBucketResult XML.', content: { 'application/xml': { schema: { type: 'string' } } } } };
      return op;
    }
    op.parameters = [bucketParam, keyParam];
    if (method === 'put') {
      op.summary = 'S3 PutObject.';
      op.requestBody = { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
      op.responses = { 200: { description: 'Object written (ETag in response headers).', content: { 'application/xml': { schema: { type: 'string' } } } } };
      return op;
    }
    if (method === 'head') {
      op.summary = 'S3 HeadObject.';
      op.responses = { 200: { description: 'Object metadata headers.' } };
      return op;
    }
    if (method === 'delete') {
      op.summary = 'S3 DeleteObject.';
      op.responses = { 204: { description: 'Object deleted.' } };
      return op;
    }
    op.summary = 'S3 GetObject.';
    op.responses = { 200: { description: 'Object bytes.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } };
    return op;
  }

  return op;
}

function errorMap(entries) {
  const out = {};
  for (const entry of entries) {
    const [code, text] = entry.split(': ');
    out[code] = errorResponse(text);
  }
  return out;
}

/** Example request bodies derived from collection schemas (project variant). */
function exampleBodies(collectionExamples, { method, path }) {
  if (!collectionExamples.length) return undefined;
  const examples = {};
  for (const example of collectionExamples) {
    if (method === 'post') {
      examples[example.name] = { summary: `Example body for collection "${example.name}".`, value: example.createBody };
    }
    if (method === 'patch' && path.includes('{recordId}')) {
      examples[example.name] = { summary: `Example update for collection "${example.name}".`, value: example.patchBody };
    }
  }
  return Object.keys(examples).length ? examples : undefined;
}

function sampleValue(field) {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case 'number': return 0;
    case 'boolean': return false;
    case 'datetime': return '2026-09-20T00:00:00.000Z';
    case 'json': return {};
    case 'file': return 'assets/example.png';
    case 'select': return field.options?.[0] ?? '';
    default: return 'text';
  }
}

/**
 * Build the OpenAPI document.
 * @param {object} options
 * @param {string} options.origin  Absolute base URL (no trailing slash).
 * @param {object|null} options.project  { project_id, collections } for the
 *   project-aware variant, or null for the global document.
 */
export function buildOpenApiDocument({ origin, project = null }) {
  const baseUrl = origin.replace(/\/$/, '');
  const collectionExamples = project ? collectionExamplesFor(project.collections) : [];
  const paths = {};
  for (const route of DATA_PLANE) {
    const ops = {};
    for (const entry of route.methods) {
      const method = typeof entry === 'string' ? entry : entry;
      ops[method] = operationFor(route, method, { collectionExamples });
    }
    paths[route.path] = ops;
  }

  const document = {
    openapi: OPENAPI_VERSION,
    info: {
      title: `${SERVICE_NAME} API`,
      version: API_VERSION,
      description: [
        'Telegraph Cloud is a self-hosted data and storage platform: versioned JSON document collections, object storage with S3-compatible access, and scoped API keys.',
        '',
        'The document database is a document API backed by a Telegram/KV journal. It is NOT PostgreSQL: there is no SQL, no wire protocol, no Prisma/Drizzle compatibility. Records are JSON documents with immutable versioned revisions and optimistic concurrency (_expected_version).',
        '',
        'Objects uploaded through Drive, /api/storage, or /s3 are the same manifest and the same bytes. S3 is a deliberately scoped endpoint: GetObject, HeadObject, PutObject, DeleteObject, and ListObjectsV2 with SigV4. Multipart uploads, presigned URLs, and bucket policies are not implemented.',
        '',
        'All responses are JSON except object bytes and the S3 XML endpoint. Errors are { "error": "<code>" } with a stable code; version conflicts also include current_version.',
      ].join('\n'),
    },
    servers: [{ url: baseUrl, description: 'This deployment.' }],
    tags: [
      { name: 'Database', description: 'Versioned JSON document collections.' },
      { name: 'Storage', description: 'Object storage (Bearer developer keys).' },
      { name: 'S3', description: 'S3-compatible endpoint (SigV4 credentials).' },
      { name: 'Platform', description: 'Health and discovery endpoints.' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerApi: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API key',
          description: 'Developer API key (tg_live_…) with scopes: db:read, db:write, storage:read, storage:write. The key determines the project boundary; caller-supplied project IDs are never trusted.',
        },
        awsSigV4: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          description: 'AWS Signature Version 4 header (AWS4-HMAC-SHA256). Use S3 credentials (tgsk_live_…), which are separate from Bearer API keys. Fixed region us-east-1, path-style addressing.',
          'x-extended-type': 'aws-sigv4',
        },
      },
      schemas: {
        Record: {
          type: 'object',
          description: 'A stored document.',
          properties: {
            id: { type: 'string', description: 'Server-generated record ID.' },
            version: { type: 'integer', minimum: 1 },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
            data: { type: 'object', description: 'The document body.' },
          },
          required: ['id', 'version', 'created_at', 'updated_at', 'data'],
        },
        RecordResponse: {
          type: 'object',
          properties: {
            data: { type: 'object', description: 'The document body (id, version, created_at, updated_at included in data for records).' },
            version: { type: 'integer', minimum: 1 },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
          required: ['data', 'version', 'created_at', 'updated_at'],
        },
        Object: {
          type: 'object',
          properties: {
            bucket: { type: 'string' },
            key: { type: 'string' },
            size: { type: 'integer', minimum: 0 },
            content_type: { type: 'string' },
            etag: { type: 'string' },
            version: { type: 'integer', minimum: 1 },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
          required: ['bucket', 'key', 'size', 'content_type', 'etag', 'version', 'created_at', 'updated_at'],
        },
        ObjectList: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/Object' } },
            common_prefixes: { type: 'array', items: { type: 'string' } },
            has_more: { type: 'boolean' },
            next_cursor: { type: ['string', 'null'] },
            limit: { type: 'integer' },
            prefix: { type: 'string' },
            delimiter: { type: ['string', 'null'] },
          },
          required: ['data', 'has_more'],
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', description: 'Stable machine-readable error code.' },
            current_version: { type: 'integer', description: 'Only on version_conflict.' },
          },
          required: ['error'],
        },
      },
    },
    'x-service': {
      name: SERVICE_NAME,
      audience: AUDIENCE,
      jwks: `${baseUrl}/.well-known/jwks.json`,
      serviceMetadata: `${baseUrl}/.well-known/telegraph.json`,
      aiDocumentation: `${baseUrl}/llms.txt`,
    },
  };

  if (project) {
    document['x-project'] = {
      project_id: project.project_id,
      description: 'Project-aware document. Collections listed in x-collections belong to this project; their example bodies derive from the stored schemas.',
    };
    document['x-collections'] = project.collections.map((collection) => ({
      name: collection.name,
      description: collection.description || '',
      fields: collection.fields || [],
      has_schema: Array.isArray(collection.fields) && collection.fields.length > 0,
    }));
  }

  return document;
}

/** Derive example bodies for the project-aware variant from schemas. */
export function collectionExamplesFor(collections) {
  return (collections || []).map((collection) => {
    const fields = Array.isArray(collection.fields) ? collection.fields : [];
    const createBody = {};
    const patchBody = {};
    for (const field of fields) {
      const value = sampleValue(field);
      createBody[field.name] = value;
    }
    for (const field of fields) {
      if (field.required) patchBody[field.name] = sampleValue(field);
    }
    patchBody._expected_version = 1;
    return {
      name: collection.name,
      createBody,
      patchBody,
    };
  });
}
