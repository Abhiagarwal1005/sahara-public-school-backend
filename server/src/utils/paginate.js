// ---------------------------------------------------------------------------
// There are two kinds of pagination here, and which one you use matters.
//
// fetchPage()  - fetches limit+1 rows and infers hasNextPage from the extra
//                row. It does NOT count. This is the default: countDocuments
//                re-matches the entire filter, which means every page load
//                costs two queries. On a shared-CPU M0 cluster that is the most common
//                reason list APIs get slow.
//
// countedPage() - when the total genuinely matters (report screens that say
//                "147 students"). There, two queries are justified.
// ---------------------------------------------------------------------------

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

const getPaginationParams = (query = {}) => {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || DEFAULT_LIMIT));
    return { page, limit, skip: (page - 1) * limit };
};

// Run the query builder with limit+1 and trim the extra row.
const fetchPage = async (queryBuilder, { page, limit }) => {
    const rows = await queryBuilder.skip((page - 1) * limit).limit(limit + 1).lean();

    const hasNextPage = rows.length > limit;
    if (hasNextPage) rows.pop();

    return {
        items: rows,
        pagination: { currentPage: page, pageSize: limit, hasNextPage, hasPrevPage: page > 1 },
    };
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
