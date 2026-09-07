const { z } = require('zod');
const { objectId, optionalId, monthKey, phone, money, paymentMode, dateish, pagination, reason } = require('./common');

// ---- session ----

const createSessionSchema = z.object({
    name: z
        .string()
        .trim()
        .regex(/^\d{4}-\d{2}$/, 'Session must be in 2026-27 format'),
    startDate: dateish,
    endDate: dateish,
    feeMonths: z.array(monthKey).max(12).optional(),
    idCardFee: money.optional(),
});

const updateSessionSchema = z.object({
    startDate: dateish.optional(),
    endDate: dateish.optional(),
    feeMonths: z.array(monthKey).max(12).optional(),
    idCardFee: money.optional(),
});

// ---- class ----

const createClassSchema = z.object({
    name: z.string().trim().min(1, 'Enter the class name'),
    section: z.string().trim().min(1, 'Enter the section').max(4).toUpperCase(),
    monthlyFee: money,
    order: z.number().int().nonnegative().optional(),
});

const updateClassSchema = z.object({
    name: z.string().trim().min(1).optional(),
    section: z.string().trim().min(1).max(4).toUpperCase().optional(),
    monthlyFee: money.optional(),
    order: z.number().int().nonnegative().optional(),
    isActive: z.boolean().optional(),
});

// ---- student ----

const createStudentSchema = z.object({
    name: z.string().trim().min(2, "Enter the student's name"),
    guardianName: z.string().trim().max(100).optional().or(z.literal('')),
    phone,
    altPhone: phone.optional().or(z.literal('')),
    address: z.string().trim().max(300).optional().or(z.literal('')),
    class: objectId,
    // If omitted, the class default applies
    monthlyFee: money.optional(),
    admissionDate: dateish,
});

const updateStudentSchema = z
    .object({
        name: z.string().trim().min(2).optional(),
        guardianName: z.string().trim().max(100).optional().or(z.literal('')),
        phone: phone.optional(),
        altPhone: phone.optional().or(z.literal('')),
        address: z.string().trim().max(300).optional().or(z.literal('')),
        class: objectId.optional(),
        monthlyFee: money.optional(),
    })
    .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

const listStudentsSchema = z.object({
    ...pagination,
    class: optionalId,
    status: z.enum(['Active', 'Left']).optional(),
    search: z.string().trim().max(60).optional(),
    hasDues: z.enum(['true', 'false']).optional(),
    // 'issued' / 'pending' — who has taken their ID card and who has not
    idCard: z.enum(['issued', 'pending']).optional().or(z.literal('')).transform((v) => v || undefined),
});

// Amount is optional: left out, the session's idCardFee applies. 0 is valid and
// means a free card — the flag is set and no ledger row is written.
const issueIdCardSchema = z.object({
    amount: money.optional(),
    mode: paymentMode.optional(),
    date: dateish.optional(),
    note: z.string().trim().max(200).optional().or(z.literal('')),
});

const cancelIdCardSchema = z.object({ reason });

const idParamSchema = z.object({ id: objectId });

module.exports = {
    createSessionSchema,
    updateSessionSchema,
    createClassSchema,
    updateClassSchema,
    createStudentSchema,
    updateStudentSchema,
    listStudentsSchema,
    issueIdCardSchema,
    cancelIdCardSchema,
    idParamSchema,
};
