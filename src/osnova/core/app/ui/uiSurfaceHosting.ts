import type { UiLabels } from "./uiProfileResolver";
import type { AuthorizeCheck, HttpContext } from "../../http";
import type {
  UiSurfacePolicyDecision,
  UiSurfacePolicyInput,
  UiSurfaceSessionUser,
} from "./uiSurfaceHttp";

export interface RunAppUiAppInfo {
  readonly name?: string;
  readonly version?: string;
}

/** One explicitly published and protected UI surface. */
export interface RunAppUiSurfaceOptions {
  readonly surface: string;
  readonly authorize: AuthorizeCheck;
  readonly policy: (
    ctx: HttpContext,
    input: UiSurfacePolicyInput,
  ) => UiSurfacePolicyDecision | Promise<UiSurfacePolicyDecision>;
  readonly session: (ctx: HttpContext) => UiSurfaceSessionUser | Promise<UiSurfaceSessionUser>;
}

/** Declarative UI hosting options accepted by `runApp`. */
export interface RunAppUiOptions {
  readonly app?: RunAppUiAppInfo;
  readonly surfaces: readonly RunAppUiSurfaceOptions[];
  /** Texts of generated profiles; default English, `RU_UI_LABELS` for Russian. */
  readonly labels?: UiLabels;
}

/** Fully normalized options used by the UI surface HTTP runtime. */
export interface UiSurfaceHostingOptions {
  readonly app: Required<RunAppUiAppInfo>;
  readonly apiBasePath: string;
  readonly surfaces: readonly RunAppUiSurfaceOptions[];
}
