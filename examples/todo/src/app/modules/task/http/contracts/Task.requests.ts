import { RequestModel } from "bazis/core/http";
import { Validator } from "bazis/library/validation";

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

  // No rule needed for the type: HTTP rejects a non-boolean JSON value (400).
  done?: boolean;
}
