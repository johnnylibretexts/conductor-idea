/** Deliberately rejects normal databases and remote servers before any test connects. */
export function assertTestDatabase(uri: string) {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      parsed.username || parsed.password || parsed.search || !/^\/idea_test_[a-z0-9_]+$/.test(parsed.pathname))
    throw new Error('IDEA tests require a dedicated loopback idea_test_* database without credentials/options');
}
