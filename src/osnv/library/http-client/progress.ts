import type { ProgressListener } from "./types";

/**
 * Drains `response.body`, reporting download progress, and returns a fresh
 * {@link Response} backed by the collected bytes (so it can still be decoded by
 * the usual `responseType` path). No-op when there is no readable body.
 */
export async function trackDownload(
  response: Response,
  onProgress: ProgressListener,
  rejectRead?: (error: unknown) => never,
): Promise<Response> {
  if (!response.body || response.status === 204 || response.status === 205 || response.status === 304) {
    return response;
  }
  const totalHeader = response.headers.get("content-length");
  const total = totalHeader !== null && Number.isFinite(Number(totalHeader)) ? Number(totalHeader) : undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      // Only transport reads are normalized; exceptions from onProgress below
      // remain the caller's errors and still trigger producer cleanup.
      const { done, value } = await reader.read().catch(rejectRead);
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        onProgress({
          loaded,
          total,
          progress: total !== undefined && total > 0 ? loaded / total : undefined,
          bytes: value.byteLength,
        });
      }
    }
  } catch (error) {
    // Initiate cleanup without awaiting an unbounded producer cancel hook.
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  return new Response(concat(chunks, loaded), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array<ArrayBuffer> {
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
