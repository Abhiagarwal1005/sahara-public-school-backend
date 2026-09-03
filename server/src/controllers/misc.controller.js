const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const expenseService = require('../services/expense.service');
const reportService = require('../services/report.service');
const uploadService = require('../services/upload.service');
const audit = require('../services/audit.service');

// ---- expenses ----

const listCategories = asyncHandler(async (_req, res) => {
    const data = await expenseService.listCategories();
    res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
    return res.status(200).json(new ApiResponse(200, data, 'Categories'));
});

const createCategory = asyncHandler(async (req, res) => {
    const data = await expenseService.createCategory(req.body, req.userId);
    return res.status(201).json(new ApiResponse(201, data, 'Category created'));
});

const updateCategory = asyncHandler(async (req, res) => {
    const data = await expenseService.updateCategory(req.params.id, req.body);
    return res.status(200).json(new ApiResponse(200, data, 'Category updated'));
});

const createExpense = asyncHandler(async (req, res) => {
    const data = await expenseService.create(req.body, req.userId);
    return res.status(201).json(new ApiResponse(201, data, 'Expense recorded'));
});

const listExpenses = asyncHandler(async (req, res) => {
    const data = await expenseService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Expenses'));
});

const getExpense = asyncHandler(async (req, res) => {
    const data = await expenseService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Expense'));
});

const updateExpense = asyncHandler(async (req, res) => {
    const data = await expenseService.update(req.params.id, req.body);
    return res.status(200).json(new ApiResponse(200, data, 'Expense updated'));
});

const deleteExpense = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await expenseService.remove(req.params.id, req.body.reason, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'expense.delete',
        entity: 'Expense',
        entityId: req.params.id,
        summary: `Delete: ${req.body.reason}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Expense deleted'));
});

const expensesByCategory = asyncHandler(async (req, res) => {
    const data = await expenseService.byCategory(req.query.month);
    return res.status(200).json(new ApiResponse(200, data, 'Category-wise expenses'));
});

// ---- reports ----

const dashboard = asyncHandler(async (_req, res) => {
    const data = await reportService.dashboard();
    // The dashboard may be 30 seconds stale — that is fine, and in an office
    // where four people refresh at once it saves a good number of queries.
    // 
    res.set('Cache-Control', 'private, max-age=30');
    return res.status(200).json(new ApiResponse(200, data, 'Dashboard'));
});

const daybook = asyncHandler(async (req, res) => {
    const data = await reportService.daybook(req.query.date);
    return res.status(200).json(new ApiResponse(200, data, 'Day book'));
});

const outstanding = asyncHandler(async (_req, res) => {
    const data = await reportService.outstanding();
    return res.status(200).json(new ApiResponse(200, data, 'Outstanding'));
});

const incomeVsExpense = asyncHandler(async (_req, res) => {
    const data = await reportService.incomeVsExpense();
    return res.status(200).json(new ApiResponse(200, data, 'Income vs expense'));
});

const feeTrend = asyncHandler(async (_req, res) => {
    const data = await reportService.feeTrend();
    return res.status(200).json(new ApiResponse(200, data, 'Fee trend'));
});

// ---- uploads ----

const uploadSignature = asyncHandler(async (req, res) => {
    const data = uploadService.getSignature(req.query.folder);
    return res.status(200).json(new ApiResponse(200, data, 'Upload signature'));
});

const destroyUpload = asyncHandler(async (req, res) => {
    const data = await uploadService.destroy(req.body.publicId);
    return res.status(200).json(new ApiResponse(200, data, 'Image deleted'));
});

module.exports = {
    listCategories,
    createCategory,
    updateCategory,
    createExpense,
    listExpenses,
    getExpense,
    updateExpense,
    deleteExpense,
    expensesByCategory,
    dashboard,
    daybook,
    outstanding,
    incomeVsExpense,
    feeTrend,
    uploadSignature,
    destroyUpload,
};
