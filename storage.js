// storage.js — ココロカメラの永続保存（IndexedDB）

const DB_NAME = 'kokoro-camera';
const DB_VER  = 1;
const STORE   = 'photos';

// ---- DBを開く／初期化 ----
function openDB() {
  return new Promise((resolve, reject) => {
    // Safariのプライベートブラウズ等でindexedDBが無効な場合に備える
    if (!('indexedDB' in window)) {
      return reject(new Error('このブラウザでは IndexedDB が利用できません'));
    }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt'); // 新しい順ソート用
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ---- 1枚保存（Blob + メタ）----
export async function savePhoto(
  blob,
  { fValue = null, bpm = null, shutterSec = null, when = Date.now(), who = '', room = '', note = '' } = {}
) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const id = (crypto?.randomUUID?.() || `id_${Date.now()}_${Math.random().toString(16).slice(2)}`);

  await new Promise((res, rej) => {
    const putReq = store.put({
      id,
      createdAt: typeof when === 'number' ? when : +when,
      fValue, bpm, shutterSec, who, room, note,
      blob, // 画像本体はBlobで格納（DataURL変換は不要&非推奨）
    });
    putReq.onsuccess = () => res();
    putReq.onerror   = () => rej(putReq.error);
  });

  await new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
    tx.onabort    = () => rej(tx.error);
  });

  return id;
}

// ---- 新しい順で全件取得 ----
export async function listPhotos() {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  const index = store.index('createdAt');

  return await new Promise((res, rej) => {
    const items = [];
    const cursorReq = index.openCursor(null, 'prev'); // 新しい順
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        items.push(cursor.value);
        cursor.continue();
      } else {
        res(items);
      }
    };
    cursorReq.onerror = () => rej(cursorReq.error);
  });
}

// ---- 1件取得 ----
export async function getPhoto(id) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  return await new Promise((res, rej) => {
    const req = store.get(id);
    req.onsuccess = () => res(req.result || null);
    req.onerror   = () => rej(req.error);
  });
}

// ---- 1件削除 ----
export async function deletePhoto(id) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  await new Promise((res, rej) => {
    const req = store.delete(id);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

// ---- 全削除（必要なら）----
export async function clearAllPhotos() {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  await new Promise((res, rej) => {
    const req = store.clear();
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

// ---- ストレージ使用量の目安取得 ----
export async function estimateStorage() {
  if (!('storage' in navigator) || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota }; // bytes
  } catch {
    return null;
  }
}

// ---- 永続化（自動掃除されにくくする）リクエスト ----
export async function requestPersistence() {
  if (!('storage' in navigator) || !navigator.storage.persist) return null;
  try {
    const already = await navigator.storage.persisted?.();
    if (already) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}
