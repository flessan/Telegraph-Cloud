// Local-first IndexedDB persistence for staged items and the local album catalog.
import { DB_ALBUMS, DB_NAME, DB_STORE, DB_VERSION } from './constants.js';
import { serializeAlbum } from '../albums.js';
import { toRecord } from './items.js';

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  if (!('indexedDB' in window)) {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (_) { resolve(null); return; }
    req.onerror = () => resolve(null);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
      // v2 adds the local album catalog. Existing item records are untouched:
      // they simply gain an optional albumId field the next time they are saved.
      if (!db.objectStoreNames.contains(DB_ALBUMS)) {
        db.createObjectStore(DB_ALBUMS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

export async function idbAll() {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

export async function idbPut(item) {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(toRecord(item));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function idbDelete(id) {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function idbAlbumsAll() {
  const db = await openDb();
  if (!db || !db.objectStoreNames.contains(DB_ALBUMS)) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(DB_ALBUMS, 'readonly');
    const req = tx.objectStore(DB_ALBUMS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

export async function idbAlbumPut(album) {
  const db = await openDb();
  if (!db || !db.objectStoreNames.contains(DB_ALBUMS)) return;
  return new Promise((resolve) => {
    const tx = db.transaction(DB_ALBUMS, 'readwrite');
    tx.objectStore(DB_ALBUMS).put(serializeAlbum(album));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function idbAlbumDelete(id) {
  const db = await openDb();
  if (!db || !db.objectStoreNames.contains(DB_ALBUMS)) return;
  return new Promise((resolve) => {
    const tx = db.transaction(DB_ALBUMS, 'readwrite');
    tx.objectStore(DB_ALBUMS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
