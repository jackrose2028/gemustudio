const connections = new Map();

/**
 * Opens (or reuses) a single IndexedDB connection per database name.
 * Resolves with null when IndexedDB is unavailable or fails to open.
 * @param {string} dbName
 * @param {string} storeName - Store that must exist; created on upgrade if missing.
 * @param {string[]|null} indexes - Index fields to create on the store.
 * @returns {Promise<IDBDatabase|null>}
 */
function openConnection(dbName, storeName, indexes) {
    if (!window.indexedDB) return Promise.resolve(null);
    const existing = connections.get(dbName);
    if (existing) return existing;
    const createStore = (db, transaction) => {
        let store;
        if (!db.objectStoreNames.contains(storeName)) {
            store = db.createObjectStore(storeName);
        } else {
            store = transaction.objectStore(storeName);
        }
        if (Array.isArray(indexes)) {
            for (const idx of indexes) {
                if (!store.indexNames.contains(idx)) {
                    store.createIndex(idx, idx, { unique: false });
                }
            }
        }
    };
    // Opens at whatever version exists; only upgrades when the store is missing
    const open = (version) => new Promise((resolve) => {
        let request;
        try {
            request = version ? indexedDB.open(dbName, version) : indexedDB.open(dbName);
        } catch (e) {
            resolve(null);
            return;
        }
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
        request.onupgradeneeded = () => createStore(request.result, request.transaction);
        request.onsuccess = () => resolve(request.result);
    });
    const pending = (async () => {
        let db = await open();
        if (db && !db.objectStoreNames.contains(storeName)) {
            const version = db.version + 1;
            db.close();
            db = await open(version);
        }
        if (db) {
            db.onversionchange = () => {
                db.close();
                connections.delete(dbName);
            };
            db.onclose = () => connections.delete(dbName);
        }
        return db;
    })();
    connections.set(dbName, pending);
    pending.then((db) => {
        if (!db) connections.delete(dbName);
    });
    return pending;
}

/**
 * Thin wrapper around one IndexedDB object store.
 * All instances that target the same database share one open connection.
 */
class EJS_STORAGE {
    /**
     * @param {string} dbName - The IndexedDB database name to open.
     * @param {string} storeName - The object store name to use within that database.
     * @param {string[]?} indexes - Optional field names to index (non-unique).
     */
    constructor(dbName, storeName, indexes = null) {
        this.dbName = dbName;
        this.storeName = storeName;
        this.indexes = indexes;
    }
    /**
     * Resolves with the shared connection, or null when storage is unavailable.
     * @returns {Promise<IDBDatabase|null>}
     */
    async getConnection() {
        const db = await openConnection(this.dbName, this.storeName, this.indexes);
        if (db && !db.objectStoreNames.contains(this.storeName)) return null;
        return db;
    }
    /**
     * Opens the store inside a new transaction.
     * @param {IDBTransactionMode} [mode="readwrite"]
     * @returns {Promise<IDBObjectStore|undefined>}
     */
    async getObjectStore(mode = "readwrite", retried = false) {
        const db = await this.getConnection();
        if (!db) return undefined;
        try {
            return db.transaction(this.storeName, mode).objectStore(this.storeName);
        } catch (e) {
            // The connection was closed (e.g. by another tab's upgrade): reopen once
            connections.delete(this.dbName);
            return retried ? undefined : this.getObjectStore(mode, true);
        }
    }
    /**
     * Runs one request and resolves with its result (undefined on any failure).
     * @param {IDBTransactionMode} mode
     * @param {(store: IDBObjectStore) => IDBRequest} makeRequest
     * @param {boolean} waitForCommit - Resolve only after the transaction commits.
     */
    async run(mode, makeRequest, waitForCommit) {
        const store = await this.getObjectStore(mode);
        if (!store) return undefined;
        return new Promise((resolve) => {
            let request;
            try {
                request = makeRequest(store);
            } catch (e) {
                resolve(undefined);
                return;
            }
            if (waitForCommit) {
                store.transaction.oncomplete = () => resolve(request.result);
                store.transaction.onerror = () => resolve(undefined);
                store.transaction.onabort = () => resolve(undefined);
            } else {
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(undefined);
            }
        });
    }
    /**
     * Get a value by primary key, or by index when indexName is given.
     * @param {string|any} key
     * @param {string|null} indexName
     * @returns {Promise<any>}
     */
    get(key, indexName = null) {
        return this.run("readonly", (store) => (indexName ? store.index(indexName).get(key) : store.get(key)), false);
    }
    /**
     * Stores a value under the given primary key.
     * @param {string} key
     * @param {*} data
     * @returns {Promise<void>}
     */
    async put(key, data) {
        await this.run("readwrite", (store) => store.put(data, key), true);
    }
    /**
     * Deletes the record for the given key.
     * @param {string} key
     * @returns {Promise<void>}
     */
    async remove(key) {
        await this.run("readwrite", (store) => store.delete(key), true);
    }
    /**
     * Walks every record in one read transaction. Skips the legacy key-index record.
     * @param {(key: IDBValidKey, value: any) => void} visit
     * @returns {Promise<void>}
     */
    async forEach(visit) {
        const store = await this.getObjectStore("readonly");
        if (!store) return;
        await new Promise((resolve) => {
            const request = store.openCursor();
            request.onerror = () => resolve();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                if (cursor.key !== "?EJS_KEYS!") visit(cursor.key, cursor.value);
                cursor.continue();
            };
        });
    }
    /**
     * Map of primary key to byte length for records that carry a `.data` buffer.
     * @returns {Promise<Object.<string, number>>}
     */
    async getSizes() {
        const sizes = {};
        await this.forEach((key, value) => {
            if (value && value.data && typeof value.data.byteLength === "number") {
                sizes[key] = value.data.byteLength;
            }
        });
        return sizes;
    }
    /**
     * Every stored value in one transaction.
     * @returns {Promise<any[]>}
     */
    async getAll() {
        const rv = [];
        await this.forEach((key, value) => {
            if (value) rv.push(value);
        });
        return rv;
    }
    /**
     * Every primary key in the store.
     * @returns {Promise<string[]>}
     */
    async getKeys() {
        const rv = [];
        await this.forEach((key) => rv.push(key));
        return rv;
    }
}

/**
 * No-op storage used when IndexedDB is disabled or unavailable.
 */
class EJS_DUMMYSTORAGE {
    async get() {}
    async put() {}
    async remove() {}
    async forEach() {}
    async getSizes() { return {}; }
    async getAll() { return []; }
    async getKeys() { return []; }
}

export { EJS_STORAGE, EJS_DUMMYSTORAGE };
