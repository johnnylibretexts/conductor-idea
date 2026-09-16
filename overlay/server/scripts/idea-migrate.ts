import mongoose from 'mongoose';
import { migrateIdea } from '../api/services/idea/migration-service.js';
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check')) throw new Error('Usage: tsx scripts/idea-migrate.ts [--check]');
if (!process.env.MONGOOSEURI) throw new Error('MONGOOSEURI is required');
try {
  await mongoose.connect(process.env.MONGOOSEURI, { autoIndex: false, autoCreate: false });
  console.log(JSON.stringify(await migrateIdea(args.includes('--check'))));
} catch { console.error('IDEA migration failed. Check indexes and immutable definitions using the documented isolated workflow.'); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
