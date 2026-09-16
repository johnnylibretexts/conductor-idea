import { createHash } from 'node:crypto';
import { IDEA_FRAMEWORK, RUBRIC_NA_TEXT, FRAMEWORK_ATTRIBUTION } from './vendor/oeri-framework.js';
export { IDEA_FRAMEWORK, RUBRIC_NA_TEXT, FRAMEWORK_ATTRIBUTION, categoryById } from './vendor/oeri-framework.js';

export const FRAMEWORK_VERSION = 'oeri-idea-2025-03';
export const CATEGORY_IDS = ['7.1', '7.2', '7.3', '7.4', '7.5', '7.6', '7.7', '7.8'] as const;
export const ROW_IDS = ['7.1.a', '7.1.b', '7.1.c', '7.2.a', '7.3.a', '7.4.a', '7.5.a', '7.6.a', '7.7.a', '7.8.a'] as const;
export const TASKS = [...CATEGORY_IDS, '7.7.1', 'rubric', 'followup', 'synthesis'] as const;
export const FRAMEWORK_HASH = createHash('sha256').update(JSON.stringify({
  version: FRAMEWORK_VERSION, attribution: FRAMEWORK_ATTRIBUTION,
  categories: IDEA_FRAMEWORK, notApplicable: RUBRIC_NA_TEXT,
})).digest('hex');

/** Prevent later callers from changing a definition whose hash has been recorded. */
function freeze(value: unknown): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
freeze(IDEA_FRAMEWORK);
freeze(FRAMEWORK_ATTRIBUTION);
freeze(CATEGORY_IDS);
freeze(ROW_IDS);
freeze(TASKS);
