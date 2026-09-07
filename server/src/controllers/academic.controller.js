const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const sessionService = require('../services/session.service');
const classService = require('../services/class.service');
const studentService = require('../services/student.service');
const audit = require('../services/audit.service');
// Only for the BEFORE snapshot on an edit — the write itself stays in the
// service. See audit.service.js for why the snapshot is taken here.
const AcademicSession = require('../models/academicSession.model');
const SchoolClass = require('../models/schoolClass.model');
const Student = require('../models/student.model');

// ---- academic session ----

const listSessions = asyncHandler(async (_req, res) => {
    const data = await sessionService.list();
    return res.status(200).json(new ApiResponse(200, data, 'Sessions'));
});

const getActiveSession = asyncHandler(async (_req, res) => {
    const data = await sessionService.getActiveSession();
    return res.status(200).json(new ApiResponse(200, data, 'Active session'));
});

const createSession = asyncHandler(async (req, res) => {
    const data = await sessionService.create(req.body);

    audit.logCreate(req, {
        action: 'session.create',
        entity: 'AcademicSession',
        entityId: data._id,
        label: `${data.name} created`,
        after: data,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Session created'));
});

const activateSession = asyncHandler(async (req, res) => {
    const data = await sessionService.activate(req.params.id);

    audit.log({
        ...audit.fromRequest(req),
        action: 'session.activate',
        entity: 'AcademicSession',
        entityId: data._id,
        summary: `${data.name} activated`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Session activated'));
});

const updateSession = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(AcademicSession, req.params.id, 'AcademicSession');
    const data = await sessionService.update(req.params.id, req.body);

    audit.logEdit(req, {
        action: 'session.update',
        entity: 'AcademicSession',
        entityId: data._id,
        label: data.name,
        before,
        after: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Session updated'));
});

// ---- classes ----

const listClasses = asyncHandler(async (req, res) => {
    const data = await classService.list(req.query);
    // Classes change rarely — let the browser cache briefly and serve a stale
    // copy while it refreshes in the background. Every screen's class
    // dropdown comes from this one call.
    res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
    return res.status(200).json(new ApiResponse(200, data, 'Classes'));
});

const createClass = asyncHandler(async (req, res) => {
    const data = await classService.create(req.body);

    audit.logCreate(req, {
        action: 'class.create',
        entity: 'SchoolClass',
        entityId: data._id,
        label: `${data.name} – ${data.section} created at ₹${data.monthlyFee}/month`,
        after: data,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Class created'));
});

// The monthly fee is edited straight from a cell on the Settings screen, so
// this is the one place that answers "who put this class on ₹1,200".
const updateClass = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(SchoolClass, req.params.id, 'SchoolClass');
    const data = await classService.update(req.params.id, req.body);

    audit.logEdit(req, {
        action: 'class.update',
        entity: 'SchoolClass',
        entityId: data._id,
        label: `${data.name} – ${data.section}`,
        before,
        after: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Class updated'));
});

const deactivateClass = asyncHandler(async (req, res) => {
    const data = await classService.deactivate(req.params.id);

    audit.logDelete(req, {
        action: 'class.deactivate',
        entity: 'SchoolClass',
        entityId: data._id,
        label: `${data.name} – ${data.section} deactivated`,
        before: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Class deactivated'));
});

// ---- students ----

const listStudents = asyncHandler(async (req, res) => {
    const data = await studentService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Students'));
});

const getStudent = asyncHandler(async (req, res) => {
    const data = await studentService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Student'));
});

const getStudentLedger = asyncHandler(async (req, res) => {
    const data = await studentService.getLedger(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Student ledger'));
});

const createStudent = asyncHandler(async (req, res) => {
    const data = await studentService.create(req.body, req.userId);

    audit.logCreate(req, {
        action: 'student.create',
        entity: 'Student',
        entityId: data._id,
        label: `${data.name} (${data.admissionNo}) admitted to ${data.className} at ₹${data.monthlyFee}/month`,
        after: data,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Student added'));
});

// A class change and a fee change both land here, and both are questions
// somebody gets asked later — "why is this child on ₹800" and "when did they
// move to 6-B". The before/after answers them with a name against it.
const updateStudent = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(Student, req.params.id, 'Student');
    const data = await studentService.update(req.params.id, req.body, req.userId);

    audit.logEdit(req, {
        action: 'student.update',
        entity: 'Student',
        entityId: data._id,
        label: `${data.name} (${data.admissionNo})`,
        before,
        after: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Student updated'));
});

const markStudentLeft = asyncHandler(async (req, res) => {
    const data = await studentService.markLeft(req.params.id);

    audit.log({
        ...audit.fromRequest(req),
        action: 'student.left',
        entity: 'Student',
        entityId: req.params.id,
        summary: `${data.student.name} (${data.student.admissionNo}) marked as Left — ₹${data.outstandingCarried} still outstanding`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Student marked as Left'));
});

// ---- ID cards ----

// Handing a card over and taking the money is one act, so it is one endpoint.
const issueIdCard = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await studentService.issueIdCard(req.params.id, req.body, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'student.idcard.issue',
        entity: 'Student',
        entityId: req.params.id,
        summary: data.amount > 0
            ? `${data.name} (${data.admissionNo}) — ID card issued, ₹${data.amount} (${data.mode})`
            : `${data.name} (${data.admissionNo}) — ID card issued free of charge`,
        after: { issued: true, amount: data.amount },
    });

    return res.status(201).json(new ApiResponse(201, data, 'ID card issued'));
});

const cancelIdCard = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await studentService.cancelIdCard(req.params.id, req.body.reason, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'student.idcard.cancel',
        entity: 'Student',
        entityId: req.params.id,
        summary: `${data.name} — ID card cancelled: ${req.body.reason}`
            + (data.refunded ? ` (₹${data.refunded} reversed)` : ''),
        before: { issued: true, amount: data.refunded },
        after: { issued: false },
    });

    return res.status(200).json(new ApiResponse(200, data, 'ID card cancelled'));
});

// Class-wise: taken, not taken, and what came in.
const idCardSummary = asyncHandler(async (_req, res) => {
    const data = await studentService.idCardSummary();
    return res.status(200).json(new ApiResponse(200, data, 'ID card summary'));
});

const defaulters = asyncHandler(async (req, res) => {
    const data = await studentService.defaulters(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Defaulters'));
});

module.exports = {
    listSessions,
    getActiveSession,
    createSession,
    activateSession,
    updateSession,
    listClasses,
    createClass,
    updateClass,
    deactivateClass,
    listStudents,
    getStudent,
    getStudentLedger,
    createStudent,
    updateStudent,
    markStudentLeft,
    issueIdCard,
    cancelIdCard,
    idCardSummary,
    defaulters,
};
