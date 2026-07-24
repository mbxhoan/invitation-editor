// Vercel catch-all for every route — all logic lives in server.js so the local
// dev server and the deployed function behave identically.
module.exports = require('../server').handler;
