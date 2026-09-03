const ApiError = require('../utils/ApiError');
const { config } = require('../config/env');

// The last middleware in the app. Every error — our own ApiError or an
// unexpected Mongoose/JS error — arrives here and leaves in a single
// JSON shape.

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
    let error = err;

    if (!(error instanceof ApiError)) {
        let statusCode = error.statusCode || 500;
        let message = error.message || 'Internal Server Error';
        let errors = [];

        // Turn the common Mongoose errors into something readable
        if (error.name === 'CastError') {
            statusCode = 400;
            message = `Invalid ${error.path}`;
        } else if (error.code === 11000) {
            // Duplicate key. In this design that is usually a feature, not a bug —
            // it is what makes re-running fee generation safe, and what stops a
            // duplicate bill number. So we name the field that clashed.
            statusCode = 409;
            const field = Object.keys(error.keyValue || {}).join(', ');
            message = `This record already exists (${field})`;
        } else if (error.name === 'ValidationError') {
            statusCode = 400;
            errors = Object.values(error.errors).map((e) => ({
                field: e.path,
                message: e.message,
            }));
            message = 'Validation failed';
        } else if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            statusCode = 401;
            message = 'Session expired — please sign in again';
        } else if (error.name === 'MongooseError' && /buffering timed out/i.test(message)) {
            // With bufferCommands:false this is rare, but if the connection really
            // is down, a clear 503 beats a 500.
            statusCode = 503;
            message = 'The database is unavailable right now — please try again shortly';
        }

        error = new ApiError(statusCode, message, errors);
        error.stack = err.stack;
        if (err.code === 11000) error.code = 'DUPLICATE';
    }

    // Only 5xx is logged. A 4xx is the client's mistake and logging it just
    // spams — on Vercel those lines cost both money and attention.
    if (error.statusCode >= 500) {
        console.error(
            `[500] ${req.method} ${req.originalUrl} :: ${error.message}\n${error.stack}`
        );
    }

    return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        errors: error.errors,
        ...(error.code && { code: error.code }),
        ...(!config.isProd && { stack: error.stack }),
    });
};

module.exports = errorHandler;
