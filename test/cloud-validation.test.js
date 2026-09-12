const assert = require('assert');

function rejects(action, code) {
  assert.throws(action, (error) => error && error.code === code, `expected ${code}`);
}

describe('Telegraph Cloud validation foundations', function () {
  let validation;

  before(async function () {
    validation = await import('../functions/cloud/validation.js');
  });

  it('accepts stable future project, collection, document, and bucket identities', function () {
    assert.strictEqual(validation.assertProjectId('prj_A1b2C3d4-E5_f6'), 'prj_A1b2C3d4-E5_f6');
    assert.strictEqual(validation.assertCollectionName('user_profiles-v2'), 'user_profiles-v2');
    assert.strictEqual(validation.assertDocumentId('usr_123.v2'), 'usr_123.v2');
    assert.strictEqual(validation.assertBucketName('project-assets.example'), 'project-assets.example');
  });

  it('rejects ambiguous identifiers before they can become index or route paths', function () {
    rejects(() => validation.assertProjectId('my-portfolio'), 'invalid_project_id');
    rejects(() => validation.assertCollectionName('Users'), 'invalid_collection_name');
    rejects(() => validation.assertCollectionName('users/admin'), 'invalid_collection_name');
    rejects(() => validation.assertDocumentId('../admin'), 'invalid_document_id');
    rejects(() => validation.assertDocumentId('usr%2F123'), 'invalid_document_id');
    rejects(() => validation.assertBucketName('UPPERCASE'), 'invalid_bucket_name');
    rejects(() => validation.assertBucketName('192.168.1.1'), 'invalid_bucket_name');
    rejects(() => validation.assertBucketName('bad..bucket'), 'invalid_bucket_name');
  });

  it('bounds opaque idempotency keys and safe equality-query components', function () {
    assert.strictEqual(validation.assertIdempotencyKey('retry-2026.09_12~a'), 'retry-2026.09_12~a');
    assert.strictEqual(validation.assertDocumentQueryField('account_role'), 'account_role');
    assert.strictEqual(validation.assertDocumentQueryValue('admin'), 'admin');
    rejects(() => validation.assertIdempotencyKey('contains a space'), 'invalid_idempotency_key');
    rejects(() => validation.assertIdempotencyKey('x'.repeat(validation.CLOUD_LIMITS.MAX_IDEMPOTENCY_KEY_BYTES + 1)), 'invalid_idempotency_key');
    rejects(() => validation.assertDocumentQueryField('__proto__'), 'invalid_query_filter');
    rejects(() => validation.assertDocumentQueryField('password'), 'invalid_query_filter');
    rejects(() => validation.assertDocumentQueryField('profile.name'), 'invalid_query_filter');
    rejects(() => validation.assertDocumentQueryValue('x'.repeat(validation.CLOUD_LIMITS.MAX_DOCUMENT_QUERY_VALUE_BYTES + 1)), 'invalid_query_filter');
  });

  it('accepts canonical hierarchical object keys but rejects traversal and URL ambiguity', function () {
    assert.strictEqual(validation.assertObjectKey('assets/2026/résumé-猫.txt'), 'assets/2026/résumé-猫.txt');

    for (const unsafe of [
      '../secret.txt',
      'assets/../secret.txt',
      'assets//secret.txt',
      '/assets/secret.txt',
      'assets/secret.txt/',
      'assets%2Fsecret.txt',
      'assets?token=secret',
      'assets#fragment',
      'assets\\secret.txt',
      'assets/\u0000secret.txt',
      'assets/re\u0301sume\u0301.txt',
    ]) {
      rejects(() => validation.assertObjectKey(unsafe), 'invalid_object_key');
    }
  });

  it('keeps legacy file ids compatibility-conscious while blocking upstream URL injection', function () {
    assert.strictEqual(validation.isSafeLegacyFileId('AgACAgEAAxkDAAMDZt1Gzs4W8dQPWiQJxO5YSH5X-gsAAt-sMRuWNelGOS.png'), true);
    assert.strictEqual(validation.isSafeLegacyFileId('old file 名.png'), true);
    for (const unsafe of ['../secret', 'file%2Fname.png', 'file?token=secret', 'file#hash', 'file\\name', 'a\u0000b']) {
      assert.strictEqual(validation.isSafeLegacyFileId(unsafe), false, unsafe);
    }
  });

  it('normalizes safe MIME types and bounded custom metadata', function () {
    assert.strictEqual(validation.assertMimeType('Text/Plain; charset=utf-8'), 'text/plain');
    assert.strictEqual(validation.assertMimeType(null), 'application/octet-stream');
    rejects(() => validation.assertMimeType('text/plain\r\nX-Injected: yes'), 'invalid_mime_type');
    rejects(() => validation.assertMimeType('not a MIME type'), 'invalid_mime_type');

    assert.deepStrictEqual(validation.normalizeCustomMetadata({ Owner: 'Thio', 'build-id': '2026-09-12' }), {
      owner: 'Thio',
      'build-id': '2026-09-12',
    });
    rejects(() => validation.normalizeCustomMetadata({ 'bad name': 'value' }), 'invalid_custom_metadata_name');
    rejects(() => validation.normalizeCustomMetadata({ owner: 'line\nbreak' }), 'invalid_custom_metadata_value');
    rejects(() => validation.normalizeCustomMetadata({ Owner: 'a', owner: 'b' }), 'invalid_custom_metadata_name');
  });

  it('enforces declared object-size limits before future adapters buffer content', function () {
    assert.strictEqual(validation.assertDeclaredContentLength('1048576'), 1048576);
    assert.strictEqual(validation.assertDeclaredContentLength(null), null);
    rejects(() => validation.assertDeclaredContentLength('-1'), 'invalid_content_length');
    rejects(() => validation.assertDeclaredContentLength('20.5'), 'invalid_content_length');
    rejects(() => validation.assertDeclaredContentLength(String(validation.CLOUD_LIMITS.MAX_OBJECT_BYTES + 1)), 'object_too_large');
  });

  it('accepts arbitrary JSON objects while rejecting prototype keys and non-JSON values', function () {
    const source = {
      id: 'usr_123',
      profile: { name: 'Thio', roles: ['admin', 'member'] },
      active: true,
      score: null,
    };
    const serialized = validation.serializeJsonDocument(source);
    assert.deepStrictEqual(serialized.value, source);
    assert.notStrictEqual(serialized.value, source, 'returns an isolated JSON clone');
    assert.ok(serialized.byteLength > 0);

    rejects(() => validation.serializeJsonDocument(['not', 'a', 'document']), 'document_must_be_object');
    rejects(() => validation.serializeJsonDocument(JSON.parse('{"__proto__":{"polluted":true}}')), 'invalid_document_property');
    rejects(() => validation.serializeJsonDocument({ count: Number.NaN }), 'invalid_json_document');
    rejects(() => validation.serializeJsonDocument({ createdAt: new Date() }), 'invalid_json_document');
  });

  it('bounds document depth and validates Telegram pointers for later journal use', function () {
    let deep = { leaf: true };
    for (let index = 0; index <= validation.CLOUD_LIMITS.MAX_DOCUMENT_DEPTH; index++) {
      deep = { child: deep };
    }
    rejects(() => validation.serializeJsonDocument(deep), 'document_too_deep');

    assert.strictEqual(validation.assertTelegramFileId('AgACAgEAAxkDAA_1-2'), 'AgACAgEAAxkDAA_1-2');
    assert.strictEqual(validation.assertTelegramMessageId(42), 42);
    rejects(() => validation.assertTelegramFileId('file/id'), 'invalid_telegram_file_id');
    rejects(() => validation.assertTelegramMessageId(0), 'invalid_telegram_message_id');
  });
});
