import { RequestModel } from "bazis/core/http";
import { Validator } from "bazis/library/validation";

@RequestModel()
export class CreateProjectRequest {
  @Validator({ required: true, minLength: 2, maxLength: 100 })
  name!: string;
}

@RequestModel()
export class UpdateProjectRequest {
  @Validator({ minLength: 2, maxLength: 100 })
  name?: string;
}
