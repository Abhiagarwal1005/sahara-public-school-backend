const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const leadService = require('../services/lead.service');
const audit = require('../services/audit.service');
// Only for the BEFORE snapshot on an edit — the write stays in the service.
const Lead = require('../models/lead.model');

const listLeads = asyncHandler(async (req, res) => {
    const data = await leadService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Leads'));
});

const leadSummary = asyncHandler(async (_req, res) => {
    const data = await leadService.summary();
    return res.status(200).json(new ApiResponse(200, data, 'Lead summary'));
});

const getLead = asyncHandler(async (req, res) => {
    const data = await leadService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Lead'));
});

const leadsByPhone = asyncHandler(async (req, res) => {
    const data = await leadService.findByPhone(req.query.phone);
    return res.status(200).json(new ApiResponse(200, data, 'Existing enquiries'));
});

const createLead = asyncHandler(async (req, res) => {
    const data = await leadService.create(req.body, req.userId);

    audit.logCreate(req, {
        action: 'lead.create',
        entity: 'Lead',
        entityId: data._id,
        label: `${data.name} (${data.phone}) — ${data.source}`,
        after: data,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Enquiry saved'));
});

const updateLead = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(Lead, req.params.id, 'Lead');
    const data = await leadService.update(req.params.id, req.body);

    audit.logEdit(req, {
        action: 'lead.update',
        entity: 'Lead',
        entityId: data._id,
        label: data.name,
        before,
        after: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Lead updated'));
});

// A follow-up is append-only inside the lead, so the lead itself already
// carries who said what. This row is what puts it on the ONE history screen
// alongside everything else that happened that day.
const addFollowUp = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name };
    const data = await leadService.addFollowUp(req.params.id, req.body, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'lead.followUp',
        entity: 'Lead',
        entityId: data._id,
        summary: `${data.name} → ${req.body.outcome}: ${req.body.note}`.slice(0, 300),
    });

    return res.status(201).json(new ApiResponse(201, data, 'Follow-up saved'));
});

const deleteLead = asyncHandler(async (req, res) => {
    const data = await leadService.remove(req.params.id);

    audit.log({
        ...audit.fromRequest(req),
        action: 'lead.delete',
        entity: 'Lead',
        entityId: req.params.id,
        summary: `Lead deleted: ${data.name}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Lead deleted'));
});

module.exports = {
    listLeads,
    leadSummary,
    getLead,
    leadsByPhone,
    createLead,
    updateLead,
    addFollowUp,
    deleteLead,
};
