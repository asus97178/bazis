/**
 * Fixture for the binding conventions e2e test: the file is NOT *.test.ts, so
 * di:generate scans it and infers bindings from the method signatures.
 */
import { Validator } from "@/library/validation";
import { Controller, Get, HttpCode, Post, RequestModel, type HttpContext, type ResponseBuilder } from "@/core/http";

@RequestModel()
export class ConventionOrderDto {
  @Validator({ required: true, minLength: 2 })
  product!: string;

  @Validator({ required: true, positive: true })
  quantity!: number;
}

@Controller("conv")
export class ConventionController {
  // :code(int) is already converted by the constraint; flag is inferred as a query bool.
  @Get("items/:code(int)")
  item(code: number, flag = false) {
    return { code, flag, codeType: typeof code };
  }

  // Primitives -> query: required q (no default) and optional page.
  @Get("search")
  search(q: string, page?: number) {
    return { q, page: page ?? null };
  }

  // A class with @RequestModel -> request body with validation.
  @Post("orders")
  @HttpCode(201)
  createOrder(dto: ConventionOrderDto) {
    return { accepted: dto.product, quantity: dto.quantity };
  }

  // Special types: HttpContext and ResponseBuilder are recognized by type.
  @Get("special/:name")
  special(name: string, ctx: HttpContext, res: ResponseBuilder) {
    res.header("x-conv", "yes");
    return { name, path: ctx.path };
  }
}
