// uuid@14 ships ESM only. Node >= 22.12 loads it through require(esm) at runtime,
// but Jest's CommonJS module loader cannot, so tests map `uuid` to this shim.
const { randomUUID } = require('node:crypto');

module.exports = { v4: () => randomUUID() };
