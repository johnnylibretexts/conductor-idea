import Project from '../../../models/project.js';
import User from '../../../models/user.js';
import Session from '../../../models/session.js';
import { IdeaError, notFound } from './errors.js';
import type { Head } from '../../../models/idea-models.js';
export type Membership = { leads?: string[]; liaisons?: string[]; members?: string[]; auditors?: string[] };
export interface Actor { uuid: string; projectID: string; role: 'lead' | 'author' | 'auditor'; bookID: string; sessionID?: string }
export function membershipRole(project: Membership, uuid: string): Actor['role'] | null {
  if (project.leads?.includes(uuid)) return 'lead';
  if (project.liaisons?.includes(uuid) || project.members?.includes(uuid)) return 'author';
  if (project.auditors?.includes(uuid)) return 'auditor';
  return null;
}
export async function resolveActor(decoded: { uuid?: unknown; sessionId?: unknown } | undefined, projectID: string): Promise<Actor> {
  if (typeof decoded?.uuid !== 'string' || typeof decoded.sessionId !== 'string') throw new IdeaError(401, 'INVALID_SESSION');
  const session = await Session.exists({ sessionId: decoded.sessionId, userId: decoded.uuid, valid: true, expiresAt: { $gt: new Date() } });
  const user = session && await User.exists({ uuid: decoded.uuid });
  if (!user) throw new IdeaError(401, 'INVALID_SESSION');
  const project = await Project.findOne({ projectID }).select('projectID leads liaisons members auditors libreLibrary libreCoverID').lean();
  const role = project && membershipRole(project, decoded.uuid);
  if (!project || !role) throw notFound();
  return { uuid: decoded.uuid, sessionID: decoded.sessionId, projectID, role, bookID: `${project.libreLibrary || ''}:${project.libreCoverID || ''}` };
}
export function requireWrite(actor: Actor, head?: Head, archive = false) {
  if (actor.role === 'auditor' || (head && head.ownerUUID !== actor.uuid && !(archive && actor.role === 'lead')))
    throw new IdeaError(403, 'FORBIDDEN', 'Your project membership does not permit this action');
}
export function recordCapabilities(actor: Actor, head: Head) {
  return { read: true, write: actor.role !== 'auditor' && head.ownerUUID === actor.uuid,
    archive: actor.role === 'lead' || (actor.role === 'author' && head.ownerUUID === actor.uuid) };
}
