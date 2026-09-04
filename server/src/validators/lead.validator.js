const { z } = require('zod');
const { phone, dateish, pagination } = require('./common');

const STATUS = z.enum(['New', 'Contacted', 'Visited', 'Interested', 'Admitted', 'Lost']);
const SOURCE = z.enum(['Walk-in', 'Phone', 'Reference', 'Online', 'Other']);

const optionalText = (max) => z.string().trim().max(max).optional().or(z.literal(''));

const createLeadSchema = z.object({
    name: z.string().trim().min(2, "Enter the child's name").max(80),
    guardianName: optionalText(80),
    phone,
    altPhone: z.union([phone, z.literal('')]).optional(),
    address: optionalText(200),
    // A plain string on purpose — see lead.model.js. The form offers the
    // school's classes, but a lead may name one that does not exist yet.
    classInterested: optionalText(60),
    source: SOURCE.optional(),
    note: optionalText(300),
    nextFollowUp: dateish.optional(),
});

const updateLeadSchema = z.object({
    name: z.string().trim().min(2).max(80).optional(),
    guardianName: optionalText(80),
    phone: phone.optional(),
    altPhone: z.union([phone, z.literal('')]).optional(),
    address: optionalText(200),
    classInterested: optionalText(60),
    source: SOURCE.optional(),
    note: optionalText(300),
    nextFollowUp: dateish.nullable().optional(),
    status: STATUS.optional(),
});

// Logging a call: what was said, where it leaves the lead, and when to ring
// again. The date is required unless the lead is being closed.
const followUpSchema = z
    .object({
        note: z.string().trim().min(2, 'Write what was discussed').max(300),
        outcome: STATUS,
        nextFollowUp: dateish.optional(),
    })
    .refine(
        (d) => d.outcome === 'Admitted' || d.outcome === 'Lost' || Boolean(d.nextFollowUp),
        { message: 'Set the next follow-up date, or close the lead', path: ['nextFollowUp'] }
    );

const listLeadsSchema = z.object({
    ...pagination,
    status: STATUS.optional(),
    open: z.enum(['true', 'false']).optional(),
    due: z.enum(['true', 'false']).optional(),
    on: dateish.optional(),
    search: z.string().trim().max(60).optional(),
});

const phoneQuerySchema = z.object({ phone });

module.exports = {
    createLeadSchema,
    updateLeadSchema,
    followUpSchema,
    listLeadsSchema,
    phoneQuerySchema,
};
