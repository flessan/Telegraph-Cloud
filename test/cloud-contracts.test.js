const assert = require('assert');

function incomplete(methods) {
  return Object.fromEntries(methods.slice(1).map((method) => [method, async () => null]));
}

describe('Telegraph Cloud service boundaries', function () {
  let contracts;
  let foundation;

  before(async function () {
    contracts = await import('../functions/cloud/contracts.js');
    foundation = await import('../functions/cloud/foundation.js');
  });

  it('rejects incomplete document and object adapters before a route can use them', function () {
    assert.throws(
      () => contracts.createDocumentDatabaseService(incomplete(contracts.DOCUMENT_DATABASE_METHODS)),
      (error) => error && error.code === 'cloud_adapter_incomplete',
    );
    assert.throws(
      () => contracts.createObjectStorageService(incomplete(contracts.OBJECT_STORAGE_METHODS)),
      (error) => error && error.code === 'cloud_adapter_incomplete',
    );
  });

  it('provides provider-neutral document and object service facades without implementing a provider', async function () {
    const documentCalls = [];
    const documentAdapter = Object.fromEntries(contracts.DOCUMENT_DATABASE_METHODS.map((method) => [
      method,
      async (...args) => {
        documentCalls.push({ method, args });
        return { method, args };
      },
    ]));
    const objectCalls = [];
    const objectAdapter = Object.fromEntries(contracts.OBJECT_STORAGE_METHODS.map((method) => [
      method,
      async (...args) => {
        objectCalls.push({ method, args });
        return { method, args };
      },
    ]));

    const documents = contracts.createDocumentDatabaseService(documentAdapter);
    const objects = contracts.createObjectStorageService(objectAdapter);
    const documentResult = await documents.getDocument({ projectId: 'prj_A1b2C3d4' }, 'users', 'usr_123');
    const objectResult = await objects.headObject({ projectId: 'prj_A1b2C3d4' }, 'assets', 'readme.txt');

    assert.deepStrictEqual(documentResult.method, 'getDocument');
    assert.deepStrictEqual(objectResult.method, 'headObject');
    assert.strictEqual(documentCalls.length, 1);
    assert.strictEqual(objectCalls.length, 1);
    assert.ok(Object.isFrozen(documents));
    assert.ok(Object.isFrozen(objects));
  });

  it('composes the Cloud index and immutable journal without constructing a database or storage API', function () {
    const index = { key: () => 'tc:v1:records' };
    const telegram = { sendFormData: async () => null };
    const journal = { appendJson: async () => null };

    const services = foundation.createCloudPersistenceFoundation({}, { index, telegram, journal });
    assert.strictEqual(services.index, index);
    assert.strictEqual(services.telegram, telegram);
    assert.strictEqual(services.journal, journal);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(services, 'database'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(services, 'storage'), false);
    assert.ok(Object.isFrozen(services));
  });
});
