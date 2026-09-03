const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const vendorService = require('../services/vendor.service');
const purchaseService = require('../services/purchase.service');
const audit = require('../services/audit.service');

// ---- vendors ----

const listVendors = asyncHandler(async (req, res) => {
    const data = await vendorService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Vendors'));
});

const getVendor = asyncHandler(async (req, res) => {
    const data = await vendorService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Vendor'));
});

const createVendor = asyncHandler(async (req, res) => {
    const data = await vendorService.create(req.body, req.userId);
    return res.status(201).json(new ApiResponse(201, data, 'Vendor added'));
});

const updateVendor = asyncHandler(async (req, res) => {
    const data = await vendorService.update(req.params.id, req.body);
    return res.status(200).json(new ApiResponse(200, data, 'Vendor updated'));
});

const statement = asyncHandler(async (req, res) => {
    const data = await vendorService.statement(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Vendor statement'));
});

const ageing = asyncHandler(async (_req, res) => {
    const data = await vendorService.ageing();
    return res.status(200).json(new ApiResponse(200, data, 'Vendor ageing'));
});

const payVendor = asyncHandler(async (req, res) => {
    const data = await vendorService.pay(req.body, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'vendor.pay',
        entity: 'VendorPayment',
        entityId: data._id,
        summary: `${data.vendorName} ko ₹${data.amount} (${data.mode}) - bills: ${data.allocations
            .map((a) => a.billNo)
            .join(', ')}`,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Payment recorded'));
});

const listPayments = asyncHandler(async (req, res) => {
    const data = await vendorService.listPayments(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Payments'));
});

// ---- purchases ----

const createPurchase = asyncHandler(async (req, res) => {
    const data = await purchaseService.create(req.body, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'purchase.create',
        entity: 'Purchase',
        entityId: data._id,
        summary: `Bill ${data.billNo} - ${data.vendorName} - ₹${data.total} (due ₹${data.dueAmount})`,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Purchase recorded'));
});

const listPurchases = asyncHandler(async (req, res) => {
    const data = await purchaseService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Purchases'));
});

const getPurchase = asyncHandler(async (req, res) => {
    const data = await purchaseService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Purchase'));
});

const updatePurchase = asyncHandler(async (req, res) => {
    const data = await purchaseService.update(req.params.id, req.body);
    return res.status(200).json(new ApiResponse(200, data, 'Purchase updated'));
});

module.exports = {
    listVendors,
    getVendor,
    createVendor,
    updateVendor,
    statement,
    ageing,
    payVendor,
    listPayments,
    createPurchase,
    listPurchases,
    getPurchase,
    updatePurchase,
};
