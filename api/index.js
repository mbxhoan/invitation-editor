// Stable single Vercel entrypoint for all API paths. vercel.json rewrites
// /api/* here because some deployments only register one-level API files.
module.exports = require('../server').handler;
