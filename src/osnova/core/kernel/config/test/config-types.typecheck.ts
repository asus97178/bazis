import { configEnum, defineConfig } from "../defineConfig";
interface Narrow { mode: "primary" | "replica" }
const typed = defineConfig<Narrow>({ default: { mode: configEnum(["primary", "replica"], "primary") } });
const mode: Narrow["mode"] = typed.get("mode");
void mode;
// @ts-expect-error literal unions need an explicit runtime enum
defineConfig<Narrow>({ default: { mode: "primary" } });
// @ts-expect-error values outside the declared union are invalid
defineConfig<Narrow>({ default: { mode: configEnum(["other"], "other") } });
// @ts-expect-error arbitrary objects cannot be synthesized from environment strings
defineConfig<{ endpoint: URL }>({ default: { endpoint: "https://example.invalid" } });
// @ts-expect-error numbers do not satisfy string fields
defineConfig<{ host: string }>({ default: { host: 1 } });
