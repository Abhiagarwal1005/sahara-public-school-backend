// This is the only error the app throws. The errorHandler middleware turns
// it into a consistent JSON response.

class ApiError extends Error {
    constructor(statusCode, message = 'Something went wrong', errors = []) {
        super(message);
        this.statusCode = statusCode;
        this.success = false;
        this.errors = errors; // field-level validation errors
        this.data = null;

        // Machine-readable reason. From the status code alone the frontend
        // cannot tell whether a 403 means "no permission" or "session
        // expired" — both arrive as 4xx, leaving the app to show a raw
        // message and nothing more.
        this.code = '';

        Error.captureStackTrace(this, this.constructor);
    }

    // Chainable, so the call site stays on one line:
    //   throw new ApiError(403, '...').withCode('PERMISSION_DENIED');
    withCode(code) {
        this.code = code;
        return this;
    }
}

module.exports = ApiError;
