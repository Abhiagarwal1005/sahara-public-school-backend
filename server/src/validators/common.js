const { z } = require('zod');

// Reusable pieces for the whole app. Keeping them here means "what counts
// as a phone number" has one answer in every module.

const objectId = z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'Not a valid id');

// For query filters. An empty string means "apply no filter", not "invalid
// id" — so it is turned into undefined. Without this, a perfectly
// reasonable request like `?class=` returns a 400.
const optionalId = z
    .union([objectId, z.literal('')])
    .optional()
    .transform((v) => (v === '' ? undefined : v));

const monthKey = z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be in YYYY-MM format');

const phone = z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');

// Money: non-negative, at most 2 decimals. Floating-point noise (0.1 + 0.2) is
// stripped here and never reaches the database.
const money = z
    .number()
    .nonnegative('Amount cannot be negative')
    .refine((n) => Number.isFinite(n), 'Amount must be a valid number')
    .refine((n) => Math.round(n * 100) === Number((n * 100).toFixed(0)), 'Amount can have at most 2 decimal places');

const positiveMoney = money.refine((n) => n > 0, 'Amount must be greater than zero');

const paymentMode = z.enum(['Cash', 'UPI', 'Bank', 'Cheque']);

// A reference returned by Cloudinary. A full URL is never accepted — only
// the publicId, and even then with a folder check in the service layer.
const imageRef = z.object({
    publicId: z.string().min(1),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    format: z.string().optional(),
    bytes: z.number().int().nonnegative().optional(),
});

// A date string or a Date object both work — the frontend sends an ISO string
const dateish = z.coerce.date();

const pagination = {
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
};

const reason = z.string().trim().min(3, 'A reason is required').max(300);

module.exports = {
    objectId,
    optionalId,
    monthKey,
    phone,
    money,
    positiveMoney,
    paymentMode,
    imageRef,
    dateish,
    pagination,
    reason,
};
