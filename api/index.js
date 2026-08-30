// Vercel function entrypoint.
//
// Plain CommonJS on purpose: it re-exports the tsup build output, which has
// already resolved the project's TypeScript path aliases (@api/*, @config/*).
// Pointing Vercel at a .ts file here would make it compile the source itself,
// without that alias resolution.
module.exports = require('../dist/vercel.js');
