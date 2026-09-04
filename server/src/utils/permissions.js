// ---------------------------------------------------------------------------
// Permission catalogue.
//
// The keys are fixed in CODE, the grants live in the DATABASE. That split is
// deliberate: if the keys were data too, a typo would create a permission
// that matches no route — and "this permission doesn't work" is a miserable
// complaint to debug. Every grant is validated against this list instead, so
// an unknown key is never saved.
//
// Admin passes no check at all — they always have everything.
// ---------------------------------------------------------------------------

const PERMISSIONS = [
    // module, key, label (the label is what the Settings screen shows)
    { module: 'Students', key: 'student.view', label: 'View students' },
    { module: 'Students', key: 'student.create', label: 'Add a student' },
    { module: 'Students', key: 'student.edit', label: 'Edit student / change class' },
    { module: 'Students', key: 'student.delete', label: 'Mark student as left' },

    // Enquiries that have not become admissions. A module of its own
    // because a lead is connected to nothing else in the app.
    { module: 'Leads', key: 'lead.view', label: 'View enquiries & follow-ups' },
    { module: 'Leads', key: 'lead.manage', label: 'Add / update an enquiry, log follow-ups' },

    { module: 'Classes', key: 'class.view', label: 'View classes' },
    { module: 'Classes', key: 'class.manage', label: 'Create / edit classes' },

    { module: 'Fees', key: 'fee.view', label: 'View fees & dues' },
    { module: 'Fees', key: 'fee.generate', label: "Raise the month's fees" },
    { module: 'Fees', key: 'fee.collect', label: 'Collect fee, issue receipt' },
    { module: 'Fees', key: 'fee.discount', label: 'Give discount or waiver' },
    { module: 'Fees', key: 'fee.void', label: 'Void a receipt' },

    { module: 'Stock', key: 'stock.view', label: 'View stock' },
    { module: 'Stock', key: 'stock.manage', label: 'Add / edit items & prices' },
    { module: 'Stock', key: 'stock.sell', label: 'Sell to a student' },
    { module: 'Stock', key: 'stock.adjust', label: 'Stock adjustment' },

    { module: 'Purchases', key: 'purchase.view', label: 'View purchase bills' },
    { module: 'Purchases', key: 'purchase.create', label: 'Record a purchase bill' },
    { module: 'Purchases', key: 'purchase.edit', label: 'Edit a purchase bill' },

    { module: 'Vendors', key: 'vendor.view', label: 'View vendors & outstanding' },
    { module: 'Vendors', key: 'vendor.manage', label: 'Add / edit a vendor' },
    { module: 'Vendors', key: 'vendor.pay', label: 'Pay a vendor' },

    { module: 'Teachers', key: 'teacher.view', label: 'View teachers' },
    { module: 'Teachers', key: 'teacher.manage', label: 'Add / edit teachers & salary' },

    { module: 'Attendance', key: 'attendance.teacher.view', label: 'View teacher attendance' },
    { module: 'Attendance', key: 'attendance.teacher.mark', label: 'Mark teacher attendance' },
    { module: 'Attendance', key: 'attendance.class.view', label: 'View class attendance' },
    { module: 'Attendance', key: 'attendance.class.mark', label: 'Mark class attendance' },

    { module: 'Salary', key: 'salary.view', label: 'View salary slips' },
    { module: 'Salary', key: 'salary.generate', label: 'Generate monthly slips' },
    { module: 'Salary', key: 'salary.approve', label: 'Approve a slip' },
    { module: 'Salary', key: 'salary.pay', label: 'Pay salary' },

    { module: 'Expenses', key: 'expense.view', label: 'View expenses' },
    { module: 'Expenses', key: 'expense.create', label: 'Record an expense' },
    { module: 'Expenses', key: 'expense.edit', label: 'Edit an expense' },
    { module: 'Expenses', key: 'expense.delete', label: 'Delete an expense' },

    { module: 'Reports', key: 'report.dashboard', label: 'Dashboard' },
    { module: 'Reports', key: 'report.fee', label: 'Class-wise fee report' },
    { module: 'Reports', key: 'report.daybook', label: 'Day book' },
    { module: 'Reports', key: 'report.outstanding', label: 'Outstanding & ageing' },

    { module: 'System', key: 'user.manage', label: 'Create / deactivate users' },
    { module: 'System', key: 'session.manage', label: 'Manage academic session' },
    { module: 'System', key: 'permission.manage', label: 'Manage role permissions' },
];

const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

const ROLES = ['Admin', 'Principal', 'Accountant'];

// This permission stays with Admin — the UI shows it locked and the API
// refuses to grant it to any other role. A role that can widen its own
// permissions is not a permission system.
const ADMIN_ONLY = new Set(['permission.manage']);

// Defaults seeded at install. The Admin can change any of them from the UI.
const DEFAULT_GRANTS = {
    Principal: [
        'student.view', 'student.create', 'student.edit', 'student.delete',
        'lead.view', 'lead.manage',
        'class.view', 'class.manage',
        'fee.view', 'fee.generate', 'fee.collect', 'fee.discount', 'fee.void',
        // stock.manage is deliberately absent — the Accountant maintains
        // items and rates; the Principal views them and approves adjustments.
        'stock.view', 'stock.sell', 'stock.adjust',
        'purchase.view', 'purchase.create', 'purchase.edit',
        'vendor.view', 'vendor.manage', 'vendor.pay',
        'teacher.view', 'teacher.manage',
        'attendance.teacher.view', 'attendance.teacher.mark',
        'attendance.class.view', 'attendance.class.mark',
        'salary.view', 'salary.generate', 'salary.approve', 'salary.pay',
        'expense.view', 'expense.create', 'expense.edit', 'expense.delete',
        'report.dashboard', 'report.fee', 'report.daybook', 'report.outstanding',
    ],
    Accountant: [
        'student.view', 'student.create', 'student.edit',
        'lead.view', 'lead.manage',
        'class.view',
        'fee.view', 'fee.generate', 'fee.collect',
        'stock.view', 'stock.manage', 'stock.sell',
        'purchase.view', 'purchase.create',
        'vendor.view', 'vendor.manage', 'vendor.pay',
        'teacher.view',
        'attendance.teacher.view', 'attendance.teacher.mark',
        'attendance.class.view', 'attendance.class.mark',
        'expense.view', 'expense.create', 'expense.edit',
        'report.dashboard', 'report.daybook', 'report.outstanding',
    ],
};

module.exports = { PERMISSIONS, PERMISSION_KEYS, ROLES, ADMIN_ONLY, DEFAULT_GRANTS };
