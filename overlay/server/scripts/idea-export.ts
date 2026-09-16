/** Authenticated read-only export. Identity/session stay in protected environment, never CLI history. */
import mongoose from 'mongoose';
import { writeFile } from 'node:fs/promises';
import { uuid } from '../api/validators/idea.js';
import { resolveActor } from '../api/services/idea/permission-service.js';
import { exportRecord, markdownExport } from '../api/services/idea/export-service.js';
const [projectID, kind, id, revisionID, format, output, ...extra] = process.argv.slice(2);
if (extra.length || !projectID || !['review', 'synthesis'].includes(kind) || !uuid.safeParse(id).success || !uuid.safeParse(revisionID).success || !['json', 'md'].includes(format) || !output)
  throw new Error('Usage: idea-export.ts PROJECT_ID review|synthesis RECORD_UUID REVISION_UUID json|md OUTPUT_PATH');
if (!process.env.MONGOOSEURI || !process.env.IDEA_EXPORT_ACTOR_UUID || !process.env.IDEA_EXPORT_SESSION_ID) throw new Error('Database URI and current export actor/session environment are required.');
try {
  await mongoose.connect(process.env.MONGOOSEURI, { autoIndex: false, autoCreate: false });
  const identity = { uuid: process.env.IDEA_EXPORT_ACTOR_UUID, sessionId: process.env.IDEA_EXPORT_SESSION_ID };
  const actor = await resolveActor(identity, projectID);
  const data = await exportRecord(actor, kind as 'review' | 'synthesis', id, revisionID);
  await resolveActor(identity, projectID);
  await writeFile(output, format === 'json' ? JSON.stringify(data, null, 2) + '\n' : markdownExport(data), { flag: 'wx', mode: 0o600 });
  console.log('IDEA export written.');
} catch { console.error('IDEA export failed. Check session, project access, revision and output path; existing files are never overwritten.'); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
