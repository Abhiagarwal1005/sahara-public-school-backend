const { z } = require('zod');
const {
    objectId,
    money,
    positiveMoney,
    paymentMode,
    imageRef,
    dateish,
    pagination,
    reason,
} = require('./common');

const variantSchema = z.object({
    _id: objectId.optional(),
    label: z.string().trim().min(1, 'Enter a label for the size').max(40),
    sku: z.string().trim().max(40).optional().or(z.literal('')),
    costPrice: money.optional(),
    sellPrice: money,
    currentStock: z.number().int().nonnegative().optional(),
    lowStockAt: z.number().int().nonnegative().optional(),
});

const createItemSchema = z
    .object({
        name: z.string().trim().min(2, 'Enter the item name').max(120),
        category: z.enum(['Uniform', 'Book', 'Notebook', 'Stationery', 'Other']),
        unit: z.string().trim().max(20).optional(),
        hasVariants: z.boolean().optional(),
        costPrice: money.optional(),
        sellPrice: money.optional(),
        currentStock: z.number().int().nonnegative().optional(),
        lowStockAt: z.number().int().nonnegative().optional(),
        variants: z.array(variantSchema).max(30).optional(),
        image: imageRef.optional(),
    })
    // hasVariants and variants must agree — otherwise the sell screen shows an
    // item that cannot actually be sold.
    .refine(
        (d) => !d.hasVariants || (d.variants && d.variants.length > 0),
        'An item with variants needs at least one size'
    )
    .refine(
        (d) => d.hasVariants || d.sellPrice !== undefined,
        'An item without variants needs a sell price'
    );

const updateItemSchema = z.object({
    name: z.string().trim().min(2).max(120).optional(),
    category: z.enum(['Uniform', 'Book', 'Notebook', 'Stationery', 'Other']).optional(),
    unit: z.string().trim().max(20).optional(),
    costPrice: money.optional(),
    sellPrice: money.optional(),
    lowStockAt: z.number().int().nonnegative().optional(),
    variants: z.array(variantSchema).max(30).optional(),
    image: imageRef.optional(),
    isActive: z.boolean().optional(),
});

const adjustSchema = z.object({
    itemId: objectId,
    variantId: objectId.optional().nullable(),
    // A whole number, and never zero. Minus reduces, plus adds.
    delta: z.number().int().refine((n) => n !== 0, 'Adjustment cannot be zero'),
    reason,
});

const saleLineSchema = z.object({
    item: objectId,
    variantId: objectId.optional().nullable(),
    qty: z.number().int().positive('Quantity must be at least 1'),
    // If omitted, the item's sell price applies
    rate: money.optional(),
});

const createSaleSchema = z.object({
    studentId: objectId.optional().nullable(),
    lines: z.array(saleLineSchema).min(1, 'At least one item is required').max(50),
    discount: money.optional(),
    paidAmount: money.optional(),
    mode: paymentMode,
    date: dateish.optional(),
    note: z.string().trim().max(200).optional().or(z.literal('')),
});

const listItemsSchema = z.object({
    ...pagination,
    category: z.enum(['Uniform', 'Book', 'Notebook', 'Stationery', 'Other']).optional(),
    search: z.string().trim().max(60).optional(),
    includeInactive: z.enum(['true', 'false']).optional(),
});

const listSalesSchema = z.object({
    ...pagination,
    student: objectId.optional(),
    date: dateish.optional(),
    from: dateish.optional(),
    to: dateish.optional(),
});

// Receiving money against credit sales. `paymentMode` has no 'Credit' in it,
// which is exactly right — you cannot pay off a credit bill with more credit.
const collectStockDuesSchema = z.object({
    studentId: objectId,
    amount: positiveMoney,
    mode: paymentMode,
    txnDate: dateish.optional(),
    note: z.string().trim().max(200).optional().or(z.literal('')),
});

module.exports = {
    createItemSchema,
    updateItemSchema,
    adjustSchema,
    createSaleSchema,
    listItemsSchema,
    listSalesSchema,
    collectStockDuesSchema,
};
