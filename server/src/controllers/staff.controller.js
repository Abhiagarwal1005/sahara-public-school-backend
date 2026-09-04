const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const teacherService = require('../services/teacher.service');
const attendanceService = require('../services/attendance.service');
const salaryService = require('../services/salary.service');
const audit = require('../services/audit.service');

// ---- teachers ----

const listTeachers = asyncHandler(async (req, res) => {
    const data = await teacherService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Teachers'));
});

const getTeacher = asyncHandler(async (req, res) => {
    const data = await teacherService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Teacher'));
});

const createTeacher = asyncHandler(async (req, res) => {
    const data = await teacherService.create(req.body, req.userId);
    return res.status(201).json(new ApiResponse(201, data, 'Teacher added'));
});

const updateTeacher = asyncHandler(async (req, res) => {
    const data = await teacherService.update(req.params.id, req.body);

    if (req.body.monthlySalary !== undefined) {
        audit.log({
            ...audit.fromRequest(req),
            action: 'teacher.salaryChange',
            entity: 'Teacher',
            entityId: data._id,
            summary: `${data.name} ki salary ab ₹${data.monthlySalary}`,
        });
    }

    return res.status(200).json(new ApiResponse(200, data, 'Teacher updated'));
});

const markTeacherLeft = asyncHandler(async (req, res) => {
    const data = await teacherService.markLeft(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Teacher marked as Left'));
});

// ---- attendance ----

const teacherSheet = asyncHandler(async (req, res) => {
    const data = await attendanceService.getTeacherSheet(req.query.date);
    return res.status(200).json(new ApiResponse(200, data, 'Attendance sheet'));
});

const markTeacherAttendance = asyncHandler(async (req, res) => {
    const data = await attendanceService.markTeachers(req.body, req.userId);
    return res.status(200).json(new ApiResponse(200, data, 'Attendance saved'));
});

const teacherGrid = asyncHandler(async (req, res) => {
    const data = await attendanceService.teacherMonthlyGrid(req.query.month);
    return res.status(200).json(new ApiResponse(200, data, 'Monthly attendance'));
});

const classSheet = asyncHandler(async (req, res) => {
    const data = await attendanceService.getClassSheet(req.query.date);
    return res.status(200).json(new ApiResponse(200, data, 'Class attendance sheet'));
});

const markClassAttendance = asyncHandler(async (req, res) => {
    const data = await attendanceService.markClasses(req.body, req.userId);
    return res.status(200).json(new ApiResponse(200, data, 'Attendance saved'));
});

const classMonthly = asyncHandler(async (req, res) => {
    const data = await attendanceService.classMonthly(req.query.month);
    return res.status(200).json(new ApiResponse(200, data, 'Monthly class attendance'));
});

// ---- salary ----

const generateSalary = asyncHandler(async (req, res) => {
    const data = await salaryService.generate(req.body, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'salary.generate',
        entity: 'SalarySlip',
        summary: `${data.month}: ${data.created} slips generated`,
    });

    return res.status(200).json(new ApiResponse(200, data, `${data.created} slips ban gayin`));
});

const listSlips = asyncHandler(async (req, res) => {
    const data = await salaryService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Salary slips'));
});

const getSlip = asyncHandler(async (req, res) => {
    const data = await salaryService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Slip'));
});

const updateSlip = asyncHandler(async (req, res) => {
    const data = await salaryService.update(req.params.id, req.body);
    return res.status(200).json(new ApiResponse(200, data, 'Slip updated'));
});

const addAdjustment = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name };
    const data = await salaryService.addAdjustment(req.params.id, req.body, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'salary.adjust',
        entity: 'SalarySlip',
        entityId: req.params.id,
        summary: `${req.body.kind === 'Add' ? '+' : '-'}₹${req.body.amount} ${req.body.label}`,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Adjustment added'));
});

const removeAdjustment = asyncHandler(async (req, res) => {
    const data = await salaryService.removeAdjustment(req.params.id, req.params.adjustmentId);
    return res.status(200).json(new ApiResponse(200, data, 'Adjustment removed'));
});

const discardSlip = asyncHandler(async (req, res) => {
    const data = await salaryService.discard(req.params.id);

    audit.log({
        ...audit.fromRequest(req),
        action: 'salary.discard',
        entity: 'SalarySlip',
        entityId: req.params.id,
        summary: `Draft slip discarded: ${data.teacherName} ${data.month}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Draft discarded — generate again to rebuild it'));
});

const approveSlip = asyncHandler(async (req, res) => {
    const data = await salaryService.approve(req.params.id, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'salary.approve',
        entity: 'SalarySlip',
        entityId: data._id,
        summary: `${data.teacherName} ${data.month}: ₹${data.netPayable} approved`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Slip approved'));
});

const paySlip = asyncHandler(async (req, res) => {
    const data = await salaryService.pay(req.params.id, req.body, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'salary.pay',
        entity: 'SalarySlip',
        entityId: req.params.id,
        summary: `₹${data.paid} paid (₹${data.remaining})`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Salary paid'));
});

module.exports = {
    listTeachers,
    getTeacher,
    createTeacher,
    updateTeacher,
    markTeacherLeft,
    teacherSheet,
    markTeacherAttendance,
    teacherGrid,
    classSheet,
    markClassAttendance,
    classMonthly,
    generateSalary,
    listSlips,
    getSlip,
    updateSlip,
    addAdjustment,
    removeAdjustment,
    discardSlip,
    approveSlip,
    paySlip,
};
