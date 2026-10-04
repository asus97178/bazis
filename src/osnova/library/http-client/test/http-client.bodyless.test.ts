import { expect, test } from "bun:test";
import { HttpClient } from "../HttpClient";
import { trackDownload } from "../progress";

// Some browser Fetch implementations expose an empty stream for bodyless
// statuses. Constructing a new Response(stream, {status: 204}) then throws.
for (const status of [204, 205, 304]) {
  test(`response limits preserve bodyless status ${status} without wrapping its stream`, async () => {
    const { response, reads } = bodyless(status);
    const client = new HttpClient({ maxResponseBytes: 1024, validateStatus: () => true,
      fetch: (async () => response) as unknown as typeof fetch });
    const result = await client.get("https://client.example.test/logout");
    expect(result.status).toBe(status);
    expect(reads()).toBe(0);
  });
  test(`progress preserves bodyless status ${status}`, async () => {
    const { response, reads } = bodyless(status);
    const result = await trackDownload(response, () => { throw new Error("Bodyless response cannot report progress"); });
    expect(result).toBe(response);
    expect(reads()).toBe(0);
  });
}

function bodyless(status: number) {
  const response = new Response(null, { status });
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  let count = 0;
  const original = body.getReader.bind(body);
  Object.defineProperty(body, "getReader", { value: () => { count++; return original(); } });
  Object.defineProperty(response, "body", { value: body });
  return { response, reads: () => count };
}
