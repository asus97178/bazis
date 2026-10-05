/**
 * Фикстура для e2e-теста конвенций привязки: файл НЕ *.test.ts, поэтому
 * di:generate сканирует его и выводит привязки из сигнатур методов.
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
  // :code(int) уже конвертирован ограничением; flag выводится в query bool.
  @Get("items/:code(int)")
  item(code: number, flag = false) {
    return { code, flag, codeType: typeof code };
  }

  // Примитивы -> query: обязательный q (без default) и опциональный page.
  @Get("search")
  search(q: string, page?: number) {
    return { q, page: page ?? null };
  }

  // Класс с @RequestModel -> тело запроса с валидацией.
  @Post("orders")
  @HttpCode(201)
  createOrder(dto: ConventionOrderDto) {
    return { accepted: dto.product, quantity: dto.quantity };
  }

  // Спец-типы: HttpContext и ResponseBuilder распознаются по типу.
  @Get("special/:name")
  special(name: string, ctx: HttpContext, res: ResponseBuilder) {
    res.header("x-conv", "yes");
    return { name, path: ctx.path };
  }
}
