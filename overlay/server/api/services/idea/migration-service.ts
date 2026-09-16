import { IdeaDefinition, ideaModels, type Definition } from '../../../models/idea-models.js';
import { hash } from './revision-store.js';
import { FRAMEWORK_VERSION, IDEA_FRAMEWORK, FRAMEWORK_ATTRIBUTION, RUBRIC_NA_TEXT } from '../../../util/idea/framework.js';
import { CROSSWALK_REFERENCE, PROMPT_PACK_VERSION } from '../../../util/idea/references.js';
import { TASK_INSTRUCTIONS, SYSTEM } from '../../../util/idea/prompts.js';
export const definitions = [
  { kind: 'framework', id: FRAMEWORK_VERSION, content: { categories: IDEA_FRAMEWORK, notApplicable: RUBRIC_NA_TEXT }, attribution: FRAMEWORK_ATTRIBUTION, sourceVersion: FRAMEWORK_VERSION, modifications: 'Unmodified pinned framework; transport wrapper only' },
  { kind: 'reference', id: PROMPT_PACK_VERSION, content: CROSSWALK_REFERENCE, attribution: CROSSWALK_REFERENCE.attribution, sourceVersion: PROMPT_PACK_VERSION, modifications: 'Attributed paraphrase; see third-party notices' },
  { kind: 'prompt', id: PROMPT_PACK_VERSION, content: { system: SYSTEM, tasks: TASK_INSTRUCTIONS }, attribution: CROSSWALK_REFERENCE.attribution, sourceVersion: PROMPT_PACK_VERSION, modifications: 'Application task instructions adapted from Crosswalk guidance' },
].map((d) => { const digest = hash(d); return { ...d, hash: digest, _id: `${d.kind}:${d.id}:${digest}` }; });
export async function migrateIdea(check = false) {
  // Fail before writes if a shipped immutable definition has drifted.
  for (const expected of definitions) {
    const existing = await IdeaDefinition.find({ kind: expected.kind, id: expected.id }).lean();
    for (const row of existing) if (hash(row) !== hash(expected)) throw new Error(`IMMUTABLE_DEFINITION_MISMATCH:${expected.kind}:${expected.id}`);
  }
  const missing: string[] = [];
  for (const model of ideaModels) {
    if (!check) { await model.createCollection(); await model.createIndexes(); }
    let indexes: { key: unknown; unique?: boolean; partialFilterExpression?: unknown; expireAfterSeconds?: number }[] = [];
    try { indexes = await model.collection.indexes(); }
    catch (e) { if ((e as { code?: number }).code !== 26) throw e; }
    for (const [key, options] of model.schema.indexes()) {
      if (!indexes.some((index) => hash(index.key) === hash(key) && Boolean(index.unique) === Boolean(options.unique) && hash(index.partialFilterExpression || null) === hash(options.partialFilterExpression || null) && index.expireAfterSeconds === options.expireAfterSeconds)) missing.push(`${model.collection.name}:${JSON.stringify(key)}`);
    }
  }
  for (const definition of definitions) {
    if (!check) await IdeaDefinition.db.collection<Definition>(IdeaDefinition.collection.name).updateOne({ _id: definition._id }, { $setOnInsert: definition }, { upsert: true });
    const saved = await IdeaDefinition.findById(definition._id).lean();
    if (!saved || hash(saved) !== hash(definition)) missing.push(`definition:${definition._id}`);
  }
  if (missing.length) throw new Error(`MIGRATION_INCOMPLETE:${missing.join(',')}`);
  return { checked: true, definitions: definitions.length, collections: ideaModels.length };
}
