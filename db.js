/* Revisor Visual: o histórico mora no IndexedDB da extensão, e não no
   storage.local, porque cada escrita no storage.local chega a todo frame de toda
   aba aberta, e o histórico cresce. Três tabelas: as sessões guardadas, a foto
   de cada item no momento em que foi marcado, e a conferência de cada item
   (ficou ou não ficou). Usado pelo script de fundo e pela página do histórico. */
globalThis.RVDB = globalThis.RVDB || (() => {
  'use strict';
  let aberto = null;

  function open() {
    if (aberto) return aberto;
    aberto = new Promise((resolve, reject) => {
      const r = indexedDB.open('revisor-visual', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('sessoes', { keyPath: 'id' });
        db.createObjectStore('conferencia', { keyPath: 'id' });
        db.createObjectStore('fotos');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => { aberto = null; reject(r.error); };
    });
    return aberto;
  }

  function run(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      let out;
      const req = fn(t.objectStore(store));
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = t.onabort = () => reject(t.error);
    }));
  }

  return {
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    all: (store) => run(store, 'readonly', (s) => s.getAll()),
    keys: (store) => run(store, 'readonly', (s) => s.getAllKeys()),
    put: (store, val, key) => run(store, 'readwrite', (s) => (key === undefined ? s.put(val) : s.put(val, key))),
    del: (store, key) => run(store, 'readwrite', (s) => s.delete(key))
  };
})();
