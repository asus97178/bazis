import { expect, test } from "bun:test";
import * as di from "osnv/core/di";

test("generated provider attachment mechanics are absent from the DI public barrel", () => {
  expect(Object.keys(di)).not.toContain("createGeneratedProviderAttachmentChannel");
  expect(Object.keys(di)).not.toContain("getGeneratedProviderAttachment");
  expect(Object.keys(di)).not.toContain("registerGeneratedProviderAttachments");
});
