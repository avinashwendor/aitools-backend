import mongoose from 'mongoose';
import config from './config/index.js';
import { User, Tool, Comment, Category, Conversation, UserProfile, WorkflowRun, SuggestedTool } from './models/index.js';
import {
  categories,
  seedUsers,
  seedComments,
  buildToolCatalog,
} from './data/seedCatalog.js';

async function seed() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(config.mongoUri);
    console.log('Connected\n');

    console.log('Clearing existing data...');
    await Promise.all([
      User.deleteMany({}),
      Tool.deleteMany({}),
      Comment.deleteMany({}),
      Category.deleteMany({}),
      Conversation.deleteMany({}),
      UserProfile.deleteMany({}),
      WorkflowRun.deleteMany({}),
      SuggestedTool.deleteMany({}),
    ]);

    console.log('Creating categories...');
    const createdCategories = await Category.insertMany(categories);
    console.log(`  ${createdCategories.length} categories`);

    console.log('Creating users...');
    const createdUsers = [];
    for (const userData of seedUsers) {
      const user = new User(userData);
      await user.save();
      createdUsers.push(user);
    }
    const adminUser = createdUsers.find(u => u.role === 'admin');
    const testUser = createdUsers.find(u => u.role === 'user');
    console.log(`  ${createdUsers.length} users`);

    const catalog = buildToolCatalog();
    console.log('Creating tools...');
    const createdTools = [];
    for (const toolData of catalog) {
      const tool = new Tool({ ...toolData, createdBy: adminUser._id });
      await tool.save();
      createdTools.push(tool);
    }
    const featured = createdTools.filter(t => t.isFeatured).length;
    console.log(`  ${createdTools.length} tools (${featured} featured)`);

    console.log('Creating comments...');
    let commentCount = 0;
    for (const entry of seedComments) {
      const tool = createdTools.find(t => t.name === entry.toolName);
      if (!tool) continue;
      await Comment.create({
        tool: tool._id,
        user: commentCount % 2 === 0 ? testUser._id : adminUser._id,
        rating: entry.rating,
        content: entry.content,
      });
      commentCount += 1;
    }
    console.log(`  ${commentCount} comments`);

    console.log('\n✅ Seed completed successfully\n');
    console.log('Test accounts:');
    console.log('  Admin : admin@aitools.com / admin123');
    console.log('  User  : user@example.com / user123\n');
    console.log(`Catalog: ${createdTools.length} tools across ${createdCategories.length} categories`);

    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }
}

seed();
