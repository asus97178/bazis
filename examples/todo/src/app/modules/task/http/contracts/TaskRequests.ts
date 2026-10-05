import { RequestModel } from "osnv/core/http";
import { Validator } from "osnv/library/validation";

@RequestModel()
export class CreateTaskRequest {
  @Validator({ required: true, uuid: true })
  projectId!: string;

  @Validator({ required: true, minLength: 1, maxLength: 200 })
  title!: string;
}

@RequestModel()
export class UpdateTaskRequest {
  @Validator({ minLength: 1, maxLength: 200 })
  title?: string;

  // Validation is opt-in: without a rule the field would accept any JSON value.
  @Validator({ type: "boolean" })
  done?: boolean;
}
