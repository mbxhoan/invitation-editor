// Vercel catch-all for /api/* — all routing lives in server.js so the local
// dev server and the deployed function behave identically.
module.exports = require('../server').handler;
