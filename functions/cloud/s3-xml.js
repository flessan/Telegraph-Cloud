// Small structured XML serializer for the S3 compatibility route. Values are
// never concatenated into XML markup by callers: element/attribute names are
// validated here and every text/attribute value is escaped before serialization.

const XML_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;

function assertXmlName(value) {
  if (typeof value !== 'string' || !XML_NAME.test(value)) {
    throw new TypeError('Invalid XML name.');
  }
  return value;
}

function assertXmlScalar(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  throw new TypeError('Invalid XML scalar.');
}

function assertXmlCharacters(value) {
  // XML 1.0 permits TAB/LF/CR plus the listed Unicode scalar ranges. Iterate
  // by code point so surrogate pairs are handled correctly and lone surrogates
  // are rejected rather than serialized as invalid XML.
  for (let offset = 0; offset < value.length;) {
    const codePoint = value.codePointAt(offset);
    if (
      codePoint === undefined
      || (codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d
        && (codePoint < 0x20 || codePoint > 0xd7ff)
        && (codePoint < 0xe000 || codePoint > 0xfffd)
        && (codePoint < 0x10000 || codePoint > 0x10ffff))
    ) {
      throw new TypeError('Invalid XML character.');
    }
    offset += codePoint > 0xffff ? 2 : 1;
  }
  return value;
}

export function escapeXmlText(value) {
  const text = assertXmlCharacters(assertXmlScalar(value));
  // Escaping quotes in text nodes is not strictly required by XML, but doing
  // so keeps all user-controlled values safe if a future response moves a
  // field between a text node and an attribute.
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function escapeXmlAttribute(value) {
  return escapeXmlText(value);
}

function normalizeChildren(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  const items = Array.isArray(value) ? value : [value];
  return Object.freeze(items.map((item) => {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      return Object.freeze({ type: 'text', value: assertXmlScalar(item) });
    }
    if (!item || typeof item !== 'object' || item.type !== 'element') {
      throw new TypeError('Invalid XML child.');
    }
    return item;
  }));
}

/** Build a validated XML element node from trusted tag names and scalar values. */
export function xmlElement(name, children, attributes = {}) {
  const safeName = assertXmlName(name);
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    throw new TypeError('Invalid XML attributes.');
  }
  const safeAttributes = Object.freeze(Object.entries(attributes).map(([attributeName, value]) => Object.freeze({
    name: assertXmlName(attributeName),
    value: assertXmlScalar(value),
  })));
  return Object.freeze({
    type: 'element',
    name: safeName,
    attributes: safeAttributes,
    children: normalizeChildren(children),
  });
}

function serializeNode(node) {
  const attributes = node.attributes
    .map((attribute) => ` ${attribute.name}="${escapeXmlAttribute(attribute.value)}"`)
    .join('');
  if (node.children.length === 0) return `<${node.name}${attributes}/>`;
  const children = node.children.map((child) => {
    if (child.type === 'text') return escapeXmlText(child.value);
    return serializeNode(child);
  }).join('');
  return `<${node.name}${attributes}>${children}</${node.name}>`;
}

/** Serialize a structured XML document with the S3-compatible UTF-8 declaration. */
export function serializeXmlDocument(root) {
  if (!root || typeof root !== 'object' || root.type !== 'element') {
    throw new TypeError('Invalid XML root.');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>${serializeNode(root)}`;
}

/** Create a no-store XML Response without exposing any serializer internals. */
export function xmlResponse(root, { status = 200, headers = {} } = {}) {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has('Content-Type')) responseHeaders.set('Content-Type', 'application/xml; charset=utf-8');
  return new Response(serializeXmlDocument(root), { status, headers: responseHeaders });
}
