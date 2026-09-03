// Wrap controllers in this instead of writing try/catch in each one. Any
// error — a thrown ApiError or something unexpected — reaches the
// errorHandler via next(error).
//
//   const create = asyncHandler(async (req, res) => { ... });

const asyncHandler = (handler) => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

module.exports = asyncHandler;
