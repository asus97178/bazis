import { RequestModel } from "osnv/core/http";
import { Validator } from "osnv/library/validation";

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
