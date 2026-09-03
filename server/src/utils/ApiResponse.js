// Every success response has the same shape, so the frontend can rely on a
// structure from every endpoint.

class ApiResponse {
    constructor(statusCode, data = null, message = 'Success') {
        this.statusCode = statusCode;
        this.data = data;
        this.message = message;
        this.success = statusCode < 400;
    }
}

module.exports = ApiResponse;
