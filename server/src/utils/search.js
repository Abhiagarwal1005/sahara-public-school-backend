// ---------------------------------------------------------------------------
// Search that an index can actually use.
//
// { name: { $regex: 'sha', $options: 'i' } } scans the whole collection — a
// case-insensitive regex cannot use an index, and an unanchored pattern
// certainly cannot. At 400 students nobody notices; at 4000 they do, and on
// M0's shared CPU they notice sooner.
//
// So every searchable document carries a `nameLower` field and we use an
// anchored pattern (^) — Mongo walks the B-tree instead,
// exactly the way it would for a range query.
//
// The trade-off, stated honestly: this is prefix search. Typing "sharma"
// will not find "Aarav Sharma". A school office types a name from the start,
// and matching mid-string would need a separate text index — worth adding
// only if it turns out to be genuinely needed.
// ---------------------------------------------------------------------------

// Escape regex metacharacters — otherwise a user's "a.*" input would
// scan the whole collection (a small door into ReDoS).
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Anchored, index-friendly prefix matcher. Returns `null` when the search
// term was empty — the caller should add no filter at all.
const prefixMatch = (term) => {
    const clean = String(term || '').trim().toLowerCase();
    if (!clean) return null;
    return new RegExp('^' + escapeRegex(clean));
};

// Phone is always an exact match — prefix search on a 10-digit number is
// pointless, and an exact match hits the index directly.
const normalisePhone = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

const isPhoneLike = (term) => /^\d{4,}$/.test(String(term || '').trim());

module.exports = { escapeRegex, prefixMatch, normalisePhone, isPhoneLike };
