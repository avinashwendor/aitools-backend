/**
 * Additive catalog expansion.
 *
 * Unlike `seed.js` (which wipes every collection, including real users), this
 * upserts tools and categories by slug. Safe to run against a live database and
 * safe to re-run — existing rows are updated in place, nothing is deleted.
 *
 *   npm run catalog:expand
 *   npm run catalog:expand -- --dry-run
 */

import mongoose from 'mongoose';
import slugify from 'slugify';
import config from '../src/config/index.js';
import Tool from '../src/models/Tool.js';
import Category from '../src/models/Category.js';
import User from '../src/models/User.js';
import { extraTools, extraCategories } from '../src/data/catalogExpansion.js';

const dryRun = process.argv.includes('--dry-run');

const green = s => `\x1b[32m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
console.log(`Connected${dryRun ? green(' (dry run — nothing will be written)') : ''}\n`);

const admin = await User.findOne({ role: 'admin' }).select('_id').lean();

// ─── Categories ──────────────────────────────────────────────
let categoriesAdded = 0;
for (const category of extraCategories) {
  // Match on either key — `name` and `slug` are both unique indexes, and the
  // original seed and this file don't always agree on the slug for a name.
  const exists = await Category.findOne({
    $or: [{ slug: category.slug }, { name: category.name }],
  }).lean();
  if (exists) continue;
  categoriesAdded++;
  console.log(`  + category ${category.slug}`);
  if (!dryRun) await Category.create(category);
}

// ─── Tools ───────────────────────────────────────────────────
let created = 0;
let updated = 0;

for (const tool of extraTools) {
  const slug = slugify(tool.name, { lower: true, strict: true });
  const existing = await Tool.findOne({ slug }).lean();

  const doc = {
    ...tool,
    slug,
    isActive: tool.isActive !== false,
    ...(admin ? { createdBy: admin._id } : {}),
  };

  if (existing) {
    updated++;
    console.log(dim(`  ~ ${slug}`));
    // Never clobber engagement counters that real users generated.
    const { views, likes, ...safe } = doc;
    if (!dryRun) await Tool.updateOne({ slug }, { $set: safe });
  } else {
    created++;
    console.log(`  + ${slug} ${dim(`(${tool.category} · ${tool.pricing})`)}`);
    if (!dryRun) await Tool.create(doc);
  }
}

const total = await Tool.countDocuments({ isActive: true });
const byCategory = await Tool.aggregate([
  { $match: { isActive: true } },
  { $group: { _id: '$category', count: { $sum: 1 } } },
  { $sort: { count: -1 } },
]);

console.log(
  `\n${green('Done')} — ${created} tools created, ${updated} updated, ` +
  `${categoriesAdded} categories added`
);
console.log(`Catalog now holds ${green(total)} active tools across ${byCategory.length} categories:`);
console.log(dim(byCategory.map(c => `  ${c._id.padEnd(14)} ${c.count}`).join('\n')));

await mongoose.disconnect();
