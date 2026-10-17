/**
 * Fixture for http.explicit-sources.test.ts: the file is NOT *.test.ts, so
 * di:generate scans it and infers the argument bindings from the markers.
 */
import { DI, Module } from "@/core/di";
import { Controller, FromBody, FromHeader, FromQuery, Get, Post, RequestModel, type FromRoute } from "@/core/http";
import { Validator } from "@/library/validation";

export enum SearchSort {
  New = "new",
  Popular = "popular",
  Price = "price",
}

// Framework fixtures register their models themselves; application models need no decorator.
@RequestModel()
export class SearchQuery {
  @Validator({ required: true, minLength: 2, maxLength: 100 })
  q!: string;

  /** Page size, 1–100. */
  @FromQuery("page_size") @Validator({ integer: true, range: [1, 100] })
  pageSize = 20;

  @Validator({ enumType: SearchSort })
  sort: string = SearchSort.New;

  @Validator({ maxLength: 3 })
  tags: string[] = [];

  onlyNew = false;
}

@RequestModel()
export class TenantHeaders {
  @FromHeader("x-tenant-id") @Validator({ required: true, uuid: true })
  tenantId!: string;

  @FromHeader("x-trace")
  trace?: string;
}

@RequestModel()
export class CreateItem {
  @Validator({ required: true, minLength: 1 })
  title!: string;
}

@Controller("catalog")
export class CatalogController {
  /** Calls that reached an action: an invalid request must never get here. */
  static calls = 0;

  @Get("search")
  search(query: FromQuery<SearchQuery>) {
    CatalogController.calls += 1;
    return { ...query, isSearchQuery: query instanceof SearchQuery };
  }

  @Get("tenant")
  tenant(headers: FromHeader<TenantHeaders>) {
    CatalogController.calls += 1;
    return { ...headers };
  }

  @Get("items/:id")
  item(id: FromRoute<number>, size: FromQuery<number, "page_size"> = 10, requestId?: FromHeader<string, "x-request-id">) {
    CatalogController.calls += 1;
    return { id, size, requestId: requestId ?? null };
  }

  @Post("items")
  create(body: FromBody<CreateItem>, requestId: FromHeader<string, "x-request-id">) {
    CatalogController.calls += 1;
    return { title: body.title, requestId };
  }
}

DI.bindDeps(CatalogController);

@Module({ controllers: [CatalogController] })
export class CatalogModule {}
