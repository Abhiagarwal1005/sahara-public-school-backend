const mongoose = require('mongoose');

const allocationSchema = new mongoose.Schema(
    {
        purchase: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', required: true },
        billNo: { type: String, required: true },
        amount: { type: Number, required: true, min: 0 },
    },
    { _id: false }
);

// Money paid to a vendor — always against a specific bill.
//
// `allocations` is not optional: a floating payment tied to no bill is
// impossible to explain six months later, and impossible to reconcile
// against the vendor's own ledger. The service allocates oldest-first
// automatically if the user did not choose.
const vendorPaymentSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
        vendorName: { type: String, required: true },

        amount: { type: Number, required: true, min: 0 },
        mode: { type: String, enum: ['Cash', 'UPI', 'Bank', 'Cheque'], required: true },
        refNo: { type: String, default: '' }, // UTR / cheque number
        date: { type: Date, required: true },

        allocations: { type: [allocationSchema], default: [] },

        attachment: {
            publicId: { type: String, default: '' },
            width: Number,
            height: Number,
        },
        note: { type: String, default: '' },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

vendorPaymentSchema.index({ vendor: 1, date: -1 });
vendorPaymentSchema.index({ session: 1, date: -1 });

module.exports =
    mongoose.models.VendorPayment || mongoose.model('VendorPayment', vendorPaymentSchema);
