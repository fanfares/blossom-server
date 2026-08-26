const mutationTails = new Map<string, Promise<void>>();

/**
 * Serializes metadata and physical-storage mutations for one content hash in this server process.
 * Upload and prune paths invoke this around their final existence check and commit/delete sequence
 * so a stale prune decision cannot remove a blob that an overlapping upload just promised to retain.
 */
export async function withBlobMutationLock<T>(
  sha256: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = mutationTails.get(sha256) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  mutationTails.set(sha256, tail);

  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (mutationTails.get(sha256) === tail) mutationTails.delete(sha256);
  }
}
