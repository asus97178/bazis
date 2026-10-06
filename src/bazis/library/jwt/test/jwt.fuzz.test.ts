import { expect, test } from "bun:test";
import { runJwtFuzz } from "./fixtures/fuzz";

test("seeded malformed compact JWS, signed-invalid claims and authentic controls", async () => {
  const result = await runJwtFuzz(12_000);
  expect(result.rejected).toBe(12_000);
  expect(result.controls).toBe(400);
  expect(result.unexpected).toBe(0);
}, 20_000);
