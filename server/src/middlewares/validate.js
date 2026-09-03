const ApiError = require('../utils/ApiError');

// Turns a zod schema into middleware. On failure it returns a 400 with
// field-level errors, which the frontend shows directly on form fields.
//
//   router.post('/', validate(createStudentSchema), controller.create)
//   router.get('/', validate(listQuerySchema, 'query'), controller.list)
//
// The parsed data is assigned back, so defaults and type coercion
// (like "12" -> 12) reach the controller — that, not validation alone,
// is the real benefit of this layer.
const validate = (schema, source = 'body') => (req, _res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
        const errors = result.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
        }));
        throw new ApiError(400, 'Validation failed', errors).withCode('VALIDATION_FAILED');
    }

    req[source] = result.data;
    next();
};

module.exports = validate;
