// Collection schema validation (telegraph-cloud.collection.v1).
//
// A defined schema is authoritative for future record writes:
//   - required fields must be present
//   - field types are enforced (text / number / boolean / datetime / json /
//     file / select)
//   - select values must be one of the declared options
//   - defaults are applied for missing fields on create
//   - fields outside the schema are rejected (on create: all fields; on
//     patch: fields introduced by the patch — pre-existing legacy fields
//     remain readable but can no longer be added or rewritten)
//
// Collections without a schema (legacy) are never validated: they remain
// fully writable with arbitrary JSON, exactly as before. Existing records
// are never rewritten by this module; enforcement happens on the next
// explicit write only.
//
// Error messages quote field names (bounded, caller-controlled identifiers)
// and static problem categories only — never values.
import { CloudValidationError } from './errors.js';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_PROBLEMS = 10;

function fieldTypeProblem(field, value) {
  switch (field.type) {
    case 'text':
      return typeof value === 'string' ? null : 'must be a string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'datetime':
      return typeof value === 'string' && ISO_DATE_PATTERN.test(value) && Number.isFinite(Date.parse(value))
        ? null
        : 'must be an ISO 8601 datetime (e.g. 2026-09-20T00:00:00.000Z)';
    case 'json':
      return null;
    case 'file':
      // A file field stores an object key reference (bucket/key), not bytes.
      return typeof value === 'string' ? null : 'must be a string object key reference';
    case 'select':
      if (typeof value !== 'string') return 'must be a string';
      // A select field declared without options can never match; report the
      // controlled problem instead of dereferencing the missing options list.
      if (!Array.isArray(field.options) || field.options.length === 0) {
        return 'must be one of the declared options (none are declared)';
      }
      return field.options.includes(value)
        ? null
        : `must be one of: ${field.options.join(', ')}`;
    default:
      return null;
  }
}

/**
 * Apply declared defaults for missing fields. Returns a new object; the
 * input is not mutated. Fields already present are never overwritten.
 */
export function applySchemaDefaults(document, definition) {
  if (!definition || !Array.isArray(definition.fields)) return document;
  const out = { ...document };
  for (const field of definition.fields) {
    if (field.default !== undefined && !Object.prototype.hasOwnProperty.call(out, field.name)) {
      out[field.name] = field.default;
    }
  }
  return out;
}

/**
 * Validate a document against a collection schema.
 *
 * @param {object} document  The document to validate (create: the full
 *   document after defaults; patch: the merged current+patch document).
 * @param {object} definition  Normalized collection definition.
 * @param {object} options  { operation: 'create' | 'patch', patch?: object }
 *   For patch, `patch` is the raw patch used to detect fields introduced by
 *   the write (so legacy fields that predate the schema are not rejected).
 */
export function validateDocumentAgainstSchema(document, definition, { operation = 'create', patch = null } = {}) {
  if (!definition || !Array.isArray(definition.fields) || definition.fields.length === 0) return;
  const fieldsByName = new Map(definition.fields.map((field) => [field.name, field]));
  const problems = [];

  const note = (field, problem) => {
    if (problems.length < MAX_PROBLEMS) problems.push(`"${field}" ${problem}`);
  };

  for (const [key, value] of Object.entries(document)) {
    const field = fieldsByName.get(key);
    if (!field) {
      if (operation === 'create' && problems.length < MAX_PROBLEMS) {
        problems.push(`"${key}" is not defined in the schema`);
      }
      continue;
    }
    const problem = fieldTypeProblem(field, value);
    if (problem) note(key, problem);
  }

  if (operation === 'patch' && patch && typeof patch === 'object') {
    for (const key of Object.keys(patch)) {
      if (!fieldsByName.has(key) && problems.length < MAX_PROBLEMS) {
        problems.push(`"${key}" is not defined in the schema and cannot be added by an update`);
      }
    }
  }

  for (const field of definition.fields) {
    if (!field.required) continue;
    if (!Object.prototype.hasOwnProperty.call(document, field.name) && problems.length < MAX_PROBLEMS) {
      problems.push(`"${field.name}" is required`);
    }
  }

  if (problems.length) {
    throw new CloudValidationError(
      'schema_validation_failed',
      `Document does not match the collection schema: ${problems.join('; ')}`,
    );
  }
}

/**
 * Validate a schema field list (used by createCollection and
 * patchCollection). Enforces the same rules as the original
 * normalizeCollectionDefinition: name charset, reserved names, known types,
 * unique names, bounded select options. Returns the normalized fields.
 */
export function normalizeSchemaFields(rawFields, reservedNames) {
  if (!Array.isArray(rawFields) || rawFields.length > 100) {
    throw new CloudValidationError('invalid_collection_fields', 'Collection fields are invalid.');
  }
  const allowedTypes = new Set(['text', 'number', 'boolean', 'datetime', 'json', 'file', 'select']);
  const fields = rawFields.map((field) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw new CloudValidationError('invalid_collection_field', 'Collection field is invalid.');
    }
    const fieldName = typeof field.name === 'string' ? field.name.trim() : '';
    if (!/^[a-z][a-z0-9_]*$/.test(fieldName) || reservedNames.has(fieldName)) {
      throw new CloudValidationError('invalid_collection_field', 'Collection field name is invalid.');
    }
    const type = String(field.type || 'text');
    if (!allowedTypes.has(type)) {
      throw new CloudValidationError('invalid_collection_field_type', 'Collection field type is invalid.');
    }
    const normalizedField = {
      name: fieldName,
      type,
      required: Boolean(field.required),
      ...(type === 'select' && Array.isArray(field.options)
        ? { options: field.options.map(String).slice(0, 100) }
        : {}),
    };
    if (field.default !== undefined) {
      // The default must itself satisfy the field type; otherwise every
      // create that relies on it would fail with a confusing error.
      const problem = fieldTypeProblem(normalizedField, field.default);
      if (problem) {
        throw new CloudValidationError('invalid_collection_field_default', `Default for field "${fieldName}" ${problem}.`);
      }
      normalizedField.default = structuredCloneSafe(field.default);
    }
    return normalizedField;
  });
  const names = new Set();
  for (const field of fields) {
    if (names.has(field.name)) {
      throw new CloudValidationError('duplicate_collection_field', 'Collection field names must be unique.');
    }
    names.add(field.name);
  }
  return fields;
}

// JSON-safe deep clone that matches the value space of JSON documents.
function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}
