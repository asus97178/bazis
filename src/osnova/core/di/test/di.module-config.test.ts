import { describe, expect, test } from "bun:test";
import { Module, collectModuleConfigs } from "../index";

function fakeConfig(name: string) {
  return {
    name,
    calls: 0,
    ensureValid() {
      this.calls += 1;
    },
  };
}

describe("@Module config metadata", () => {
  test("collectModuleConfigs walks imports and de-duplicates config objects", () => {
    const shared = fakeConfig("shared");
    const feature = fakeConfig("feature");

    @Module({ config: shared })
    class SharedModule {}

    @Module({ imports: [SharedModule], config: [feature, shared] })
    class FeatureModule {}

    const configs = collectModuleConfigs([FeatureModule]);
    expect(configs).toEqual([feature, shared]);

    for (const config of configs) {
      config.ensureValid();
    }
    expect(feature.calls).toBe(1);
    expect(shared.calls).toBe(1);
  });
});
