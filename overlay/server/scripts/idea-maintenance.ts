import mongoose from 'mongoose';
import { maintainIdea } from '../api/services/idea/maintenance-service.js';
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--apply')) throw new Error('Usage: tsx scripts/idea-maintenance.ts [--apply]');
if (!process.env.MONGOOSEURI) throw new Error('MONGOOSEURI is required');
try {
  await mongoose.connect(process.env.MONGOOSEURI, { autoIndex: false, autoCreate: false });
  console.log(JSON.stringify(await maintainIdea(args.includes('--apply'))));
} catch { console.error('IDEA maintenance failed; no committed evidence is intentionally removed. Run dry-run and inspect chain integrity.'); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
