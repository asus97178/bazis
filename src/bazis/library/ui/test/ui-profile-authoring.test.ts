import { describe, expect, test } from "bun:test";
import {
  UiProfile,
  isUiProfileAuthoringClass,
  uiOperation,
  uiEndpoint,
  uiProfileAuthoringMetadataOf,
  type UiProfileAuthoringOptions,
} from "../UiProfile";

class ProductListRequest {
  name!: string;
  createdAt!: Date;
}

class CreateProductRequest {
  name!: string;
  email!: string;
}

class UpdateProductRequest {
  name?: string;
  email?: string;
}

class ProductResponse {
  id!: string;
  name!: string;
  email!: string;
  createdAt!: Date;
}

class ProductController {
  list(_query: ProductListRequest): ProductResponse[] {
    return [];
  }

  create(_request: CreateProductRequest): ProductResponse {
    throw new Error("not executed");
  }

  update(_id: string, _request: UpdateProductRequest): ProductResponse {
    throw new Error("not executed");
  }

  delete(_id: string): void {}
}

describe("@UiProfile authoring metadata", () => {
  test("preserves direct controller, request and method references without JSON normalization", () => {
    const listOperation = uiOperation(ProductController, ProductController.prototype.list);
    const deleteOperation = uiOperation(ProductController, ProductController.prototype.delete);
    const options = {
      surface: "admin",
      controller: ProductController,
      response: ProductResponse,
      title: "Products",
      singularTitle: "Product",
      navigation: { group: "Catalog", icon: "package", order: 20 },
      operations: {
        list: listOperation,
        delete: deleteOperation,
      },
      list: {
        request: ProductListRequest,
        columns: { id: {}, email: {} },
        filters: { name: {} },
        defaultSort: "-createdAt",
        pageSize: 25,
      },
      create: {
        request: CreateProductRequest,
        fields: { name: {}, email: {} },
      },
      edit: {
        request: UpdateProductRequest,
        fields: { name: {}, email: {} },
      },
      delete: {
        title: "Delete",
        intent: "danger",
        confirm: "Delete product?",
        placements: ["list.row", "detail.header"],
      },
    } as const satisfies UiProfileAuthoringOptions<
      typeof ProductController,
      typeof ProductResponse,
      typeof ProductListRequest,
      typeof CreateProductRequest,
      typeof UpdateProductRequest
    >;

    @UiProfile(options)
    class ProductAdminUiProfile {}

    const metadata = uiProfileAuthoringMetadataOf(ProductAdminUiProfile);
    expect(metadata?.target).toBe(ProductAdminUiProfile);
    expect(metadata?.targetName).toBe("ProductAdminUiProfile");
    expect(metadata?.profile).toBe(options);
    expect(Object.isFrozen(metadata?.profile)).toBe(true);
    expect(Object.isFrozen(metadata?.profile.navigation)).toBe(true);
    expect(metadata?.profile.controller).toBe(ProductController);
    expect(metadata?.profile.list?.request).toBe(ProductListRequest);
    expect(metadata?.profile.create?.request).toBe(CreateProductRequest);
    expect(metadata?.profile.edit?.request).toBe(UpdateProductRequest);
    expect(metadata?.profile.operations?.list).toBe(listOperation);
    expect(metadata?.profile.operations?.delete).toBe(deleteOperation);
    expect(metadata?.profile.surface).toBe("admin");
    expect(isUiProfileAuthoringClass(ProductAdminUiProfile)).toBe(true);
  });

  test("accepts a response class and identifies only decorated profile classes", () => {
    class ProductResponseClass {
      id!: string;
      name!: string;
    }

    @UiProfile({
      surface: "admin",
      controller: ProductController,
      response: ProductResponseClass,
      readonly: true,
      list: {
        columns: { id: {}, name: {} },
      },
    })
    class ReadonlyProductUiProfile {}

    class PlainClass {}

    expect(uiProfileAuthoringMetadataOf(ReadonlyProductUiProfile)?.profile.response).toBe(ProductResponseClass);
    expect(uiProfileAuthoringMetadataOf(PlainClass)).toBeUndefined();
    expect(isUiProfileAuthoringClass(PlainClass)).toBe(false);
  });

  test("operation references retain exact controller-action identity", () => {
    const operation = uiOperation(ProductController, ProductController.prototype.create);
    expect(operation).toEqual({
      kind: "ui-controller-method",
      controller: ProductController,
      action: ProductController.prototype.create,
    });
    expect(Object.isFrozen(operation)).toBe(true);
  });

  test("endpoint and CRUD references prefer exact prototype function identity", () => {
    const endpoint = uiEndpoint(ProductController, ProductController.prototype.create, {
      request: CreateProductRequest,
    });
    const operation = uiOperation(ProductController, ProductController.prototype.delete);

    expect(endpoint).toMatchObject({
      kind: "ui-endpoint",
      controller: ProductController,
      action: ProductController.prototype.create,
      request: CreateProductRequest,
    });
    expect(operation).toEqual({
      kind: "ui-controller-method",
      controller: ProductController,
      action: ProductController.prototype.delete,
    });
  });

  test("stores feature-local custom page endpoints without serializing them", () => {
    @UiProfile({
      surface: "admin",
      customPages: [{
        kind: "document",
        id: "product-preview",
        title: "Product preview",
        load: uiEndpoint(ProductController, ProductController.prototype.list),
      }],
    })
    class ProductPreviewUiProfile {}

    const profile = uiProfileAuthoringMetadataOf(ProductPreviewUiProfile)?.profile;
    expect(profile?.customPages?.[0]).toMatchObject({ id: "product-preview", kind: "document" });
  });

  test("contextually types response, list and form fields from direct contracts", () => {
    @UiProfile({
      surface: "admin",
      controller: ProductController,
      response: ProductResponse,
      list: {
        request: ProductListRequest,
        columns: { id: {}, createdAt: {} },
        filters: { name: {} },
      },
      create: {
        request: CreateProductRequest,
        fields: {
          name: {},
          // @ts-expect-error createdAt belongs to ProductResponse, not CreateProductRequest.
          createdAt: {},
        },
      },
    })
    class TypedProductUiProfile {}

    expect(isUiProfileAuthoringClass(TypedProductUiProfile)).toBe(true);
  });
});
