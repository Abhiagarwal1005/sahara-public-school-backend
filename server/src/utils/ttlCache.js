// ---------------------------------------------------------------------------
// A small in-memory TTL cache. Not Redis — for a single serverless instance
// that is overkill, and it adds another network hop.
//
// In serverless the hit rate is limited (each instance has its own cache),
// but the things cached here are read on every request and are tiny: the
// permission map (3 documents), the active session (1 document), and the
// logged-in user. A warm instance handling 50 requests goes to the database
// once instead of 50 times.
//
// The TTL is short so no cached value is more than 30 seconds stale, and
// critical mutations (permission update, user deactivate) invalidate
// explicitly — so those take effect immediately.
// ---------------------------------------------------------------------------

const createTTLCache = ({ ttlMs = 30_000, maxEntries = 500 } = {}) => {
    const store = new Map();

    const get = (key) => {
        const hit = store.get(key);
        if (!hit) return null;
        if (Date.now() > hit.expiresAt) {
            store.delete(key);
            return null;
        }
        return hit.value;
    };

    const set = (key, value) => {
        // delete-then-set: a Map preserves insertion order, so this entry
        // becomes the newest and eviction really does remove the oldest
        // (a rough LRU).
        store.delete(key);

        if (store.size >= maxEntries) {
            const oldest = store.keys().next().value;
            if (oldest !== undefined) store.delete(oldest);
        }
        store.set(key, { value, expiresAt: Date.now() + ttlMs });
    };

    const invalidate = (key) => {
        if (key === undefined || key === null) return;
        store.delete(String(key));
    };

    const clear = () => store.clear();

    return { get, set, invalidate, clear };
};

// User cache — isAuth used to run User.findById on every request; now most
// requests never reach the database. Deactivation and role changes
// invalidate it explicitly (auth.service).
const userCache = createTTLCache({ ttlMs: 30_000, maxEntries: 200 });

// Permission map — 3 tiny documents. Invalidated the moment an Admin saves.
const permissionCache = createTTLCache({ ttlMs: 60_000, maxEntries: 10 });

// Active academic session — changes once a year, hence the long TTL.
const sessionCache = createTTLCache({ ttlMs: 300_000, maxEntries: 5 });

module.exports = { createTTLCache, userCache, permissionCache, sessionCache };
