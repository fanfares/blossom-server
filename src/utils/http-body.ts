/** Read small provider responses with a byte limit and a deadline covering the body. */
export async function readBoundedJson(
  response: Response,
  maxBytes = 64 * 1024,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("Provider returned an empty response");
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        throw new Error("Provider response exceeds byte limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Provider returned invalid JSON fields");
    }
    return parsed as Record<string, unknown>;
  };
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Provider response body timed out")),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
