import { RequestModel } from "bazis/core/http";
import { Validator } from "bazis/library/validation";

@RequestModel()
export class PlaceOrderRequest {
  @Validator({ required: true, min: 1 })
  amount!: number;
}
