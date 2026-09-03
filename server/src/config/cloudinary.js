const crypto = require('crypto');
const { config } = require('./env');
const ApiError = require('../utils/ApiError');

// ---------------------------------------------------------------------------
// Cloudinary, without the SDK.
//
// We need exactly two things: build an upload signature, and delete an
// image. Both are plain crypto + fetch. The SDK pulls in ~2MB of
// dependencies that load on every cold start — not a cost a school office
// should pay.
//
// Why signed direct upload:
//   1. Vercel caps a request body at 4.5MB — a phone photo of a bill can
//      easily exceed that.
//   2. Proxying bytes through the server pays for the same bandwidth twice.
//   3. The API secret never reaches the browser — the browser only gets a
//      short-lived signature bound to a fixed set of params.
// ---------------------------------------------------------------------------

const API_BASE = `https://api.cloudinary.com/v1_1/${config.cloudinary.cloudName}`;

// Image upload is an optional feature. Without credentials the school simply
// records bills without a photo — everything else works unchanged.
const assertEnabled = () => {
    if (!config.cloudinary.enabled) {
        throw new ApiError(
            503,
            'Image upload is not set up on this system'
        ).withCode('UPLOADS_DISABLED');
    }
};

// Cloudinary's rule: sort all params alphabetically, join with &, append
// the api_secret, then SHA-1.
const sign = (params) => {
    const toSign = Object.keys(params)
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join('&');

    return crypto
        .createHash('sha1')
        .update(toSign + config.cloudinary.apiSecret)
        .digest('hex');
};

// The upload signature handed to the browser.
//
// `folder` and the transformation params are part of the signature, so the
// client cannot change them — otherwise any authenticated user could upload
// anything, of any size, anywhere in our account.
const buildUploadSignature = (subfolder = 'misc') => {
    assertEnabled();
    const timestamp = Math.floor(Date.now() / 1000);

    const params = {
        timestamp,
        folder: `${config.cloudinary.folder}/${subfolder}`,
        // Server-side safety net. The browser compresses too (which makes
        // the upload fast), but that cannot be trusted — anyone holding a
        // signature can craft their own request. This transformation is
        // applied at upload time, so the stored bytes stay bounded.
        transformation: 'c_limit,w_1600,h_1600,q_auto:eco',
    };

    return {
        signature: sign(params),
        timestamp,
        folder: params.folder,
        transformation: params.transformation,
        apiKey: config.cloudinary.apiKey,
        cloudName: config.cloudinary.cloudName,
        uploadUrl: `${API_BASE}/image/upload`,
    };
};

// Cleans up abandoned uploads and replaces a superseded image.
const destroyImage = async (publicId) => {
    if (!publicId) return { result: 'skipped' };
    assertEnabled();

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign({ public_id: publicId, timestamp });

    const body = new URLSearchParams({
        public_id: publicId,
        timestamp: String(timestamp),
        api_key: config.cloudinary.apiKey,
        signature,
    });

    const res = await fetch(`${API_BASE}/image/destroy`, { method: 'POST', body });

    if (!res.ok) {
        throw new ApiError(502, 'Could not delete the image — please try again shortly');
    }
    return res.json();
};

// The publicId the client sends back after an upload must be inside our own
// folder. Without this check anyone could store an arbitrary public_id — or
// delete somebody else's image through the destroy call.
const assertOwnedPublicId = (publicId) => {
    if (typeof publicId !== 'string' || !publicId.startsWith(`${config.cloudinary.folder}/`)) {
        throw new ApiError(400, 'Invalid image reference');
    }
};

module.exports = { buildUploadSignature, destroyImage, assertOwnedPublicId, assertEnabled };
