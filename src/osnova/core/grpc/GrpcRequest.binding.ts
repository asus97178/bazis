import { bindModel } from "../http/Binding/modelBinder";
import type { ModelValidationIssue, ModelValidator } from "../http/Binding/modelValidator";
import type { RequestModelClass } from "../http/Binding/requestModelRegistry";
import { BadRequestError, ModelValidationError } from "../http/Errors/HttpError";
import { GrpcError } from "./GrpcError";
import { GrpcStatus } from "./GrpcStatus";
import { Metadata } from "./Metadata";

/** A route-owned binding; all per-message state remains local to bindModel. */
export class GrpcRequestBinding {
  constructor(private readonly model: RequestModelClass, private readonly validator: ModelValidator) {}

  bind(value: unknown): object {
    try {
      return bindModel(this.model, value, this.validator, { allowBinary: true });
    } catch (error) {
      if (!(error instanceof BadRequestError)) throw error;
      const issues = error instanceof ModelValidationError ? error.errors
        : [{ property: "$", message: "Invalid request structure.", code: "structure" }];
      throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, "Request validation failed.", validationMetadata(issues));
    }
  }
}

function validationMetadata(issues: readonly ModelValidationIssue[]): Metadata {
  const errors: ModelValidationIssue[] = [];
  let truncated = false;
  let size = Buffer.byteLength('{"errors":[],"truncated":false}');
  for (const issue of issues) {
    const bounded = (value: string, limit: number): string => {
      if (value.length > limit) truncated = true;
      return value.slice(0, limit);
    };
    const item = {
      property: bounded(issue.property, 256), message: bounded(issue.message, 512),
      ...(issue.code === undefined ? {} : { code: bounded(issue.code, 64) }),
    };
    size += Buffer.byteLength(JSON.stringify(item)) + (errors.length === 0 ? 0 : 1);
    if (size > 4096) { truncated = true; break; }
    errors.push(item);
  }
  const metadata = new Metadata();
  metadata.set("osnova-validation-errors-bin", Buffer.from(JSON.stringify({ errors, truncated })));
  return metadata;
}
