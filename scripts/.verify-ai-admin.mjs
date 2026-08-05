import mongoose from 'mongoose';
import config from '../src/config/index.js';
import { getRouting, listModels, testModels, updateRouting } from '../src/controllers/adminAiController.js';
import { overrideFor, initModelRouting } from '../src/ai/modelRouting.js';
import ModelRouting from '../src/models/ModelRouting.js';

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15_000 });
await initModelRouting();

const fakeUser = { _id: new mongoose.Types.ObjectId() };
const call = (fn, body = {}) => new Promise((resolve, reject) => {
  fn({ body, query: {}, user: fakeUser }, {
    status(code) { this._code = code; return this; },
    json(payload) { resolve({ code: this._code || 200, payload }); },
  }, reject);
});

console.log('\n=== GET /admin/ai/routing ===');
const r = await call(getRouting);
for (const p of r.payload.data.providers) {
  console.log(`provider ${p.name}  singleProvider=${r.payload.data.singleProvider}`);
  for (const role of p.roles) {
    console.log(`  ${role.role.padEnd(10)} active=${String(role.active).padEnd(30)} source=${role.source}`);
  }
}

console.log('\n=== GET /admin/ai/models ===');
const m = await call(listModels);
for (const p of m.payload.data.providers) {
  console.log(`${p.provider}: ${p.error ? 'ERROR ' + p.error : p.models.length + ' models'}`);
}

console.log('\n=== POST /admin/ai/test (role models) ===');
const t = await call(testModels, {});
for (const res of t.payload.data.results) {
  console.log(`  ${res.ok ? 'OK  ' : 'FAIL'} ${res.model.padEnd(32)} ${res.ms}ms  ${res.error || res.sample || ''}`);
}

console.log('\n=== PUT /admin/ai/routing (bad model must be refused) ===');
const bad = await call(updateRouting, {
  provider: config.ai.providers[0].name,
  roles: { fast: 'definitely-not-a-real-model' },
});
console.log(`  status=${bad.code}  ${bad.payload.message}`);

console.log('\n=== PUT /admin/ai/routing (valid model must save + go live) ===');
const good = config.ai.providers[0].plannerModel;
const ok = await call(updateRouting, {
  provider: config.ai.providers[0].name,
  roles: { utility: good },
});
console.log(`  status=${ok.code}  ${ok.payload.data?.message || ok.payload.message}`);
console.log(`  overrideFor(utility) = ${overrideFor(config.ai.providers[0].name, 'utility')}`);

console.log('\n=== cleanup: clearing the test override ===');
await call(updateRouting, { provider: config.ai.providers[0].name, roles: { utility: '' } });
const after = await ModelRouting.findOne({ key: 'default' }).lean();
console.log('  overrides now:', JSON.stringify(after?.overrides));
console.log('  health keys:', Object.keys(after?.health || {}).join(',') || 'none');

await mongoose.disconnect();
process.exit(0);
