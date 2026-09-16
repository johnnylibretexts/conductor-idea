export class IdeaError extends Error {
  constructor(public status: number, public code: string, message = code, public retryable = false) { super(message); }
}
export const notFound = () => new IdeaError(404, 'NOT_FOUND', 'IDEA resource not found');
export const conflict = () => new IdeaError(409, 'VERSION_CONFLICT', 'Reload the saved version before retrying');
export function bytesWithin(value: unknown, limit: number) {
  if (Buffer.byteLength(JSON.stringify(value)) > limit) throw new IdeaError(413, 'PAYLOAD_TOO_LARGE');
}
