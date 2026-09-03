const { z } = require('zod');
const {
    objectId,
    monthKey,
    money,
    positiveMoney,
    paymentMode,
    imageRef,
    dateish,
    pagination,
    reason,
    phone,
} = require('./common');

// ---- fees ----

const generateFeesSchema = z.object({
    month: monthKey,
    // To run it for a single class
    classId: objectId.optional(),
});

const collectFeeSchema = z.object({
    studentId: objectId,
    amount: positiveMoney,
    mode: paymentMode,
    txnDate: dateish.optional(),
    note: z.string().trim().max(200).optional(),
});

const discountSchema = z.object({
    amount: positiveMoney,
    reason,
});

const voidSchema = z.object({ reason });

const listDemandsSchema = z.object({
    ...pagination,
    month: monthKey.optional(),
    class: objectId.optional(),
    student: objectId.optional(),
    status: z.enum(['Unpaid', 'Partial', 'Paid']).optional(),
});

// ---- expenses ----

const createExpenseSchema = z.object({
    categoryId: objectId,
    title: z.string().trim().min(2, 'Describe what this expense is for').max(120),
    amount: positiveMoney,
    date: dateish.optional(),
    mode: paymentMode,
    paidTo: z.string().trim().max(100).optional().or(z.literal('')),
    attachments: z.array(imageRef).max(5).optional(),
    note: z.string().trim().max(300).optional().or(z.literal('')),
});

const updateExpenseSchema = z.object({
    title: z.string().trim().min(2).max(120).optional(),
    paidTo: z.string().trim().max(100).optional().or(z.literal('')),
    note: z.string().trim().max(300).optional().or(z.literal('')),
    attachments: z.array(imageRef).max(5).optional(),
});

const categorySchema = z.object({
    name: z.string().trim().min(2, 'Enter the category name').max(60),
});

// ---- vendors ----

const createVendorSchema = z.object({
    name: z.string().trim().min(2, 'Enter the vendor name').max(120),
    phone: phone.optional().or(z.literal('')),
    gstin: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'GSTIN is not valid')
        .optional()
        .or(z.literal('')),
    address: z.string().trim().max(300).optional().or(z.literal('')),
});

const updateVendorSchema = createVendorSchema.partial();

const payVendorSchema = z.object({
    vendorId: objectId,
    amount: positiveMoney,
    mode: paymentMode,
    refNo: z.string().trim().max(60).optional().or(z.literal('')),
    date: dateish.optional(),
    // If omitted, it allocates oldest-first automatically
    allocations: z
        .array(z.object({ purchase: objectId, amount: positiveMoney }))
        .max(50)
        .optional(),
    attachment: imageRef.optional(),
    note: z.string().trim().max(200).optional().or(z.literal('')),
});

// ---- purchases ----

const purchaseLineSchema = z.object({
    item: objectId,
    variantId: objectId.optional().nullable(),
    qty: z.number().int().positive('Quantity must be at least 1'),
    rate: money,
});

const createPurchaseSchema = z.object({
    vendorId: objectId,
    billNo: z.string().trim().min(1, 'Enter the bill number').max(40),
    billDate: dateish,
    lines: z.array(purchaseLineSchema).min(1, 'At least one item is required').max(100),
    tax: money.optional(),
    otherCharges: money.optional(),
    paidAmount: money.optional(),
    mode: paymentMode.optional(),
    billImage: imageRef.optional(),
    note: z.string().trim().max(300).optional().or(z.literal('')),
});

const updatePurchaseSchema = z.object({
    note: z.string().trim().max(300).optional(),
    billImage: imageRef.optional(),
    billDate: dateish.optional(),
});

const listPurchasesSchema = z.object({
    ...pagination,
    vendor: objectId.optional(),
    status: z.enum(['Unpaid', 'Partial', 'Paid']).optional(),
    from: dateish.optional(),
    to: dateish.optional(),
});

module.exports = {
    generateFeesSchema,
    collectFeeSchema,
    discountSchema,
    voidSchema,
    listDemandsSchema,
    createExpenseSchema,
    updateExpenseSchema,
    categorySchema,
    createVendorSchema,
    updateVendorSchema,
    payVendorSchema,
    createPurchaseSchema,
    updatePurchaseSchema,
    listPurchasesSchema,
};
