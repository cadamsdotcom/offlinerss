'use strict';

// Vercel entrypoint: the exported Express app is invoked as the serverless
// handler. All routes are funnelled here by the rewrite in vercel.json.
module.exports = require('../server.js');
