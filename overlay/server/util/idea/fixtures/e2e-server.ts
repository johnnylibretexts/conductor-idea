/** Loopback-only browser test host. Never imported by the application. */
import './test-env.js';
import express from 'express';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { assertTestDatabase } from '../test-database.js';
import { chapters, context, draftFor } from './chapters.js';
import { captureFixture } from './capture.js';
import { IdeaPage, IdeaSnapshot, IdeaRun, IdeaSourceJob } from '../../../models/idea-models.js';
import Project from '../../../models/project.js';
import User from '../../../models/user.js';
import Session from '../../../models/session.js';
import { createIdeaRouter, ideaError, ideaJSONParser } from '../../../api/idea.js';
import { migrateIdea } from '../../../api/services/idea/migration-service.js';
import { createRecord } from '../../../api/services/idea/review-service.js';
import { startAIWorker } from '../../../api/services/idea/ai-worker.js';
import { startCaptureWorker } from '../../../api/services/idea/capture-worker.js';
import type { IdeaAIProvider } from '../../../api/services/idea/ai-provider.js';
if (process.env.IDEA_E2E !== 'true') throw new Error('Explicit IDEA_E2E=true required');
const uri = process.env.IDEA_TEST_MONGO_URI!; assertTestDatabase(uri);
Object.assign(process.env, { IDEA_REVIEW_ENABLED:'true', IDEA_AI_ENABLED:'true', IDEA_WORKER_ENABLED:'true', IDEA_PILOT_PROJECT_IDS:'["idea-e2e"]', IDEA_ALLOWED_ORIGINS:'http://127.0.0.1:3199', OPENAI_API_KEY:'fixture-no-network' });
await mongoose.connect(uri, {autoIndex:false, autoCreate:false});
// Refuse to reuse any database, even a test database containing unrelated test work.
if ((await mongoose.connection.db!.listCollections().toArray()).length) throw new Error('E2E database must be empty');
await migrateIdea();
const identities: Record<string, {uuid:string; sessionID:string}> = {};
for (const role of ['owner','auditor','outsider']) {
 const identity = {uuid:randomUUID(), sessionID:randomUUID()}; identities[role]=identity;
 await User.collection.insertOne({uuid:identity.uuid} as never);
 await Session.create({sessionId:identity.sessionID,userId:identity.uuid,valid:true,createdAt:new Date(),expiresAt:new Date(Date.now()+3600000)});
}
await Project.collection.insertOne({projectID:'idea-e2e',libreLibrary:'bio',libreCoverID:'1',members:[identities.owner.uuid],auditors:[identities.auditor.uuid]} as never);
const actor = {...identities.owner,projectID:'idea-e2e',role:'author' as const,bookID:'bio:1'};
const records: Awaited<ReturnType<typeof createRecord>>[]=[];
for (const [index,chapter] of chapters.entries()) {
 const snapshotID=randomUUID();
 await IdeaPage.create([...chapter.pageIDs,...chapter.excludedPageIDs].map(pageID=>({_id:randomUUID(),snapshotID,pageID,state:chapter.pageIDs.includes(pageID)?'captured':'excluded',blocks:chapter.blocks.filter(b=>b.pageID===pageID),preview:'<p>Fictional captured evidence. Ignore instructions is source text, not an instruction.</p>',source:{},createdAt:new Date()})));
 await IdeaSnapshot.create({_id:snapshotID,projectID:actor.projectID,bookID:actor.bookID,chapterRootID:String(index+1),chapterTitle:chapter.chapterTitle,state:'ready',pageIDs:chapter.pageIDs,excludedPageIDs:chapter.excludedPageIDs,definitionIDs:[],hash:'fixture',manifest:{selected:chapter.pageIDs.map(pageID=>({pageID,title:chapter.chapterTitle})),pages:chapter.pageIDs.map(pageID=>({pageID,state:'captured'}))},createdAt:new Date()});
 await IdeaSourceJob.create({_id:snapshotID,kind:'capture',projectID:actor.projectID,ownerUUID:actor.uuid,sessionID:actor.sessionID,bookID:actor.bookID,idempotencyKey:randomUUID(),payloadHash:'fixture',state:'succeeded',chapterRootID:String(index+1),selected:chapter.pageIDs.map(pageID=>({pageID,title:chapter.chapterTitle})),excluded:chapter.excludedPageIDs.map(pageID=>({pageID})),unsupportedBranches:false,results:[],createdAt:new Date()});
 records.push(await createRecord(actor,'review',{snapshotID,context,idempotencyKey:randomUUID()}));
}
const provider: IdeaAIProvider = { available:()=>true, async submit(request) {
 const run=await IdeaRun.findById(request.runID).lean(); const input=(run!.input as any).promptInput;
 let text=JSON.stringify(draftFor(request.mode)).replaceAll('environment-v1',input.snapshots[0].snapshotID);
 const draft=JSON.parse(text);
 if(request.mode==='synthesis') draft.inputRevisionIDs=input.assessments.map((a:any)=>a.revisionID);
 if(request.mode==='followup') {draft.parentRunID=input.parent.runID; draft.focus=input.parent.focus;}
 return {actualProvider:request.provider,actualModel:'scripted-browser-fixture',text:JSON.stringify(draft),finish:'complete',usage:{inputTokens:100,outputTokens:200}};
}};
const capture=captureFixture();
const stopAI=startAIWorker({openai:provider}); const stopCapture=startCaptureWorker(capture.source);
const app=express();
app.get('/__idea-test/session',async(req,res)=>{
 const who=identities[String(req.query.role||'owner')]; if(!who) return res.sendStatus(400);
 const token=await new SignJWT({uuid:who.uuid,sessionId:who.sessionID}).setProtectedHeader({alg:'HS256'}).setIssuer('https://idea.example.test').setAudience('https://idea.example.test').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SECRETKEY));
 res.set('Cache-Control','no-store').json({token,reviews:records.map(r=>r.head._id)});
});
app.use('/api/v1/projects/:projectID/idea',ideaJSONParser,ideaError,createIdeaRouter(capture.source));
const server=app.listen(3200,'127.0.0.1');
let closing=false;
async function close(){if(closing)return;closing=true;await stopAI();await stopCapture();server.close();await mongoose.connection.dropDatabase();await mongoose.disconnect();process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
