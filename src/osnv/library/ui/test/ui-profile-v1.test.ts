import { describe, expect, test } from "bun:test";
import {
  UI_PROFILE_V1_API_VERSION,
  UI_PROFILE_V1_KIND,
  canonicalUiJson,
  defineUiProfile,
  normalizeUiJsonValue,
  uiDocumentRevision,
  type UiProfileV1,
} from "../index";

describe("UiProfileV1", () => {
  test("defines a JSON-safe, deeply frozen presentation profile", () => {
    const profile = productProfile();
    const resource = profile.spec.resources[0];

    expect(profile.apiVersion).toBe(UI_PROFILE_V1_API_VERSION);
    expect(profile.kind).toBe(UI_PROFILE_V1_KIND);
    expect(resource?.id).toBe("products");
    expect(resource?.operations?.create?.operationId).toBe("products.create");
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.metadata)).toBe(true);
    expect(Object.isFrozen(profile.spec.resources)).toBe(true);
    expect(Object.isFrozen(resource?.forms?.create?.uiSchema)).toBe(true);
    expect(JSON.parse(JSON.stringify(profile))).toEqual(profile);
  });

  test("keeps validation and authorization out of the profile contract", () => {
    const invalid = {
      apiVersion: UI_PROFILE_V1_API_VERSION,
      kind: UI_PROFILE_V1_KIND,
      metadata: { name: "invalid", surface: "admin", owner: "ProductModule" },
      spec: {
        resources: [{
          id: "products",
          permissions: { delete: "products.delete" },
        }],
      },
    } as unknown as UiProfileV1;

    expect(() => defineUiProfile(invalid)).toThrow(
      "uiProfile.spec.resources[0].permissions is not part of UiProfileV1",
    );
  });

  test("requires explicit confirmation for danger actions", () => {
    const invalid = {
      apiVersion: UI_PROFILE_V1_API_VERSION,
      kind: UI_PROFILE_V1_KIND,
      metadata: { name: "invalid-action", surface: "admin", owner: "ProductModule" },
      spec: {
        resources: [{
          id: "products",
          actions: [{
            id: "delete",
            title: "Delete",
            operation: { operationId: "products.delete" },
            placements: ["list.row"],
            intent: "danger",
          }],
        }],
      },
    } as UiProfileV1;

    expect(() => defineUiProfile(invalid)).toThrow(
      "uiProfile.spec.resources[0].actions[0].confirm is required for a danger action",
    );
  });

  test("keeps feature pages transport-free and requires an explicit renderer", () => {
    const base = {
      apiVersion: UI_PROFILE_V1_API_VERSION,
      kind: UI_PROFILE_V1_KIND,
      metadata: { name: "feature", surface: "admin", owner: "FeatureModule" },
      spec: {
        resources: [],
        customPages: [{ id: "feature", title: "Feature", kind: "feature", renderer: "feature/v1" }],
      },
    } as const;

    expect(defineUiProfile(base).spec.customPages?.[0]).toEqual({
      id: "feature",
      title: "Feature",
      kind: "feature",
      renderer: "feature/v1",
    });
    expect(() => defineUiProfile({
      ...base,
      spec: { ...base.spec, customPages: [{ ...base.spec.customPages[0], renderer: " " }] },
    })).toThrow("uiProfile.spec.customPages[0].renderer must be a non-empty string");
    expect(() => defineUiProfile({
      ...base,
      spec: {
        ...base.spec,
        customPages: [{ ...base.spec.customPages[0], operation: { operationId: "feature.load" } }],
      },
    } as unknown as UiProfileV1)).toThrow(
      "uiProfile.spec.customPages[0].operation is not part of UiProfileV1",
    );
  });

  test("rejects an unknown runtime custom page discriminator", () => {
    const invalid = {
      apiVersion: UI_PROFILE_V1_API_VERSION,
      kind: UI_PROFILE_V1_KIND,
      metadata: { name: "unknown-page", surface: "admin", owner: "FeatureModule" },
      spec: {
        resources: [],
        customPages: [{ id: "unknown", title: "Unknown", kind: "magic" }],
      },
    } as unknown as UiProfileV1;

    expect(() => defineUiProfile(invalid)).toThrow(
      "uiProfile.spec.customPages[0].kind is not a supported custom page kind",
    );
  });
});

describe("UI profile JSON serialization", () => {
  test("canonicalizes object keys and creates deterministic revisions", () => {
    const left = { z: 3, nested: { b: 2, a: 1 }, a: true };
    const right = { a: true, nested: { a: 1, b: 2 }, z: 3 };

    expect(canonicalUiJson(left)).toBe('{"a":true,"nested":{"a":1,"b":2},"z":3}');
    expect(canonicalUiJson(right)).toBe(canonicalUiJson(left));
    expect(uiDocumentRevision(right)).toBe(uiDocumentRevision(left));
    expect(uiDocumentRevision(left)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(uiDocumentRevision({ ...left, z: 4 })).not.toBe(uiDocumentRevision(left));
  });

  test("rejects values that JSON.stringify would silently change", () => {
    expect(() => normalizeUiJsonValue({ missing: undefined })).toThrow("non-JSON undefined");
    expect(() => normalizeUiJsonValue({ action: () => undefined })).toThrow("non-JSON function");
    expect(() => normalizeUiJsonValue({ value: Number.NaN })).toThrow("finite JSON number");
    expect(() => normalizeUiJsonValue({ date: new Date() })).toThrow("plain JSON object");

    const sparse = new Array(1);
    expect(() => normalizeUiJsonValue(sparse)).toThrow("must not be an array hole");

    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => normalizeUiJsonValue(circular)).toThrow("circular reference");
  });

  test("allows repeated non-circular values and freezes independent copies", () => {
    const shared = { value: 1 };
    const normalized = normalizeUiJsonValue({ left: shared, right: shared }) as {
      readonly left: { readonly value: number };
      readonly right: { readonly value: number };
    };

    expect(normalized.left).toEqual({ value: 1 });
    expect(normalized.right).toEqual({ value: 1 });
    expect(normalized.left).not.toBe(normalized.right);
    expect(Object.isFrozen(normalized.left)).toBe(true);
  });
});

function productProfile(): UiProfileV1 {
  return defineUiProfile({
    apiVersion: UI_PROFILE_V1_API_VERSION,
    kind: UI_PROFILE_V1_KIND,
    metadata: {
      name: "product-admin",
      surface: "admin",
      owner: "ProductModule",
    },
    spec: {
      resources: [{
        id: "products",
        title: "Products",
        singularTitle: "Product",
        navigation: {
          group: "Catalog",
          icon: "package",
          order: 50,
        },
        operations: {
          list: { operationId: "products.list" },
          read: { operationId: "products.get" },
          create: { operationId: "products.create" },
          update: { operationId: "products.update" },
          delete: { operationId: "products.delete" },
        },
        list: {
          columns: [
            "id",
            "name",
            "email",
            "createdAt",
          ],
          selectionFields: ["name", "email"],
          defaultSort: "name",
          pageSize: 20,
        },
        detail: {
          titleField: "name",
          sections: [
            { id: "main", title: "Main", fields: ["id", "name", "email"] },
            { id: "system", title: "System fields", fields: ["createdAt", "updatedAt"] },
          ],
        },
        forms: {
          create: {
            title: "Create product",
            uiSchema: {
              type: "VerticalLayout",
              elements: [
                { type: "Control", scope: "#/properties/name" },
                { type: "Control", scope: "#/properties/email" },
              ],
            },
          },
          edit: {
            title: "Edit product",
            uiSchema: {
              type: "VerticalLayout",
              elements: [
                { type: "Control", scope: "#/properties/name" },
                { type: "Control", scope: "#/properties/email" },
              ],
            },
          },
        },
        actions: [{
          id: "delete",
          title: "Delete",
          operation: { operationId: "products.delete" },
          placements: ["list.row", "detail.header"],
          intent: "danger",
          confirm: "Delete the product?",
          refresh: "resource",
        }],
      }],
    },
  });
}
