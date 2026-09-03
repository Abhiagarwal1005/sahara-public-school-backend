const mongoose = require('mongoose');
const { ROLES } = require('../utils/permissions');

// The data behind the whole permission system. Just two documents (Principal, Accountant) —
// Admin has no row because Admin always has everything — and a row would
// imply somebody could take it away.
const rolePermissionSchema = new mongoose.Schema(
    {
        role: {
            type: String,
            enum: ROLES.filter((r) => r !== 'Admin'),
            required: true,
        },
        permissions: { type: [String], default: [] },
        // Bumped on every save. The cache can compare it to tell whether it holds
        // a stale copy, without reading the whole document.
        version: { type: Number, default: 1 },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true }
);

rolePermissionSchema.index({ role: 1 }, { unique: true });

module.exports =
    mongoose.models.RolePermission || mongoose.model('RolePermission', rolePermissionSchema);
