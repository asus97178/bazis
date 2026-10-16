/**
 * Fixture for runApp.language.test.ts: the file is NOT *.test.ts, so
 * di:generate scans it and infers the argument bindings.
 */
import { DI, Module } from "@/core/di";
import { Authorize, Controller, Get, NotFoundError, Post, RequestModel, UnauthorizedError } from "@/core/http";
import { Validator } from "@/library/validation";

@RequestModel()
export class AddBook {
  @Validator({ required: true, minLength: 2 }) title!: string;
  @Validator({ required: true, integer: true }) year!: number;
  @Validator({ required: true, message: "Укажите автора" }) author!: string;
}

@Controller("books")
export class BooksController {
  @Get()
  search(q: string, limit = 10) {
    return { q, limit };
  }

  @Get(":id(int)")
  get(id: number) {
    if (id === 2) throw new NotFoundError("Книга 2 не найдена");
    throw new NotFoundError();
  }

  @Post()
  add(body: AddBook) {
    return body;
  }

  @Get("admin")
  @Authorize(() => false)
  admin() {
    return {};
  }

  @Get("me")
  @Authorize(() => {
    throw new UnauthorizedError();
  })
  me() {
    return {};
  }

  @Get("boom")
  boom() {
    throw new Error("lock timeout");
  }
}

DI.bindDeps(BooksController);

@Module({ controllers: [BooksController] })
export class BooksModule {}
