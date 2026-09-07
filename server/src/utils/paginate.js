// ---------------------------------------------------------------------------
// There are two kinds of pagination here, and which one you use matters.
//
// fetchPage()             - fetches limit+1 rows and infers hasNextPage from
//                           the extra row. It does NOT count. Cheapest option,
//                           and the right one when the UI only needs
//                           Previous / Next.
//
// fetchPage(withTotal)    - the same page, PLUS the exact total, so the UI can
//                           draw numbered pages (1 2 3 … 25). The count is a
//                           second query, so it is opt-in per endpoint rather
//                           than the default.
//
// countedPage()           - kept for callers that want the total without the
//                           limit+1 probe.
//
// WHY THE COUNT IS RUN IN PARALLEL
//
// countDocuments re-matches the whole filter, so it is genuinely a second
// query — that has not changed. What matters is that it does not have to be a
// second WAIT: issued alongside the page with Promise.all, the request costs
// max(page, count) instead of page + count. On a shared-CPU M0 that is the
// difference between a list that feels instant and one that does not.
//
// The count uses the SAME filter object as the page, so it is served by the
// same index the page just used — an index-only COUNT_SCAN, never a fetch of
// the documents themselves.
// ---------------------------------------------------------------------------

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

const getPaginationParams = (query = {}) => {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || DEFAULT_LIMIT));
    return { page, limit, skip: (page - 1) * limit };
};

// Run the query builder with limit+1 and trim the extra row.
const fetchPage = async (queryBuilder, { page, limit, withTotal = false }) => {
    // Read the filter and model BEFORE the builder is executed — once a
    // mongoose Query has run, chaining another call to it throws.
    const Model = queryBuilder.model;
    const filter = queryBuilder.getFilter();

    const [rows, totalItems] = await Promise.all([
        queryBuilder.skip((page - 1) * limit).limit(limit + 1).lean(),
        withTotal ? Model.countDocuments(filter) : Promise.resolve(null),
    ]);

    const hasNextPage = rows.length > limit;
    if (hasNextPage) rows.pop();

    const pagination = {
        currentPage: page,
        pageSize: limit,
        hasNextPage,
        hasPrevPage: page > 1,
    };

    if (withTotal) {
        pagination.totalItems = totalItems;
        pagination.totalPages = Math.max(1, Math.ceil(totalItems / limit));
    }

    return { items: rows, pagination };
};

const buildPaginatedResponse = (items, totalCount, page, limit) => ({
    items,
    pagination: {
        totalItems: totalCount,
        totalPages: Math.ceil(totalCount / limit),
        currentPage: page,
        pageSize: limit,
        hasNextPage: page * limit < totalCount,
        hasPrevPage: page > 1,
    },
});

module.exports = { getPaginationParams, fetchPage, buildPaginatedResponse };
