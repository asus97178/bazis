import { describe, expect, test } from "bun:test";
import { BadRequestError, ModelValidationError } from "../Errors/HttpError";
import { bindModel } from "../Binding/modelBinder";
import { registerRequestModelShape } from "../Binding/requestModelRegistry";
import { Validator, modelValidatorAdapter } from "@/library/validation";

class CreateAccountRequest {
  name = "";
  enabled = false;
}

describe("HTTP model binding security", () => {
  test("strips unknown over-posted properties", () => {
    const request = bindModel(CreateAccountRequest, {
      name: "Eve",
      enabled: true,
      role: "admin",
      isRoot: true,
    });

    expect(request).toEqual({ name: "Eve", enabled: true });
    expect("role" in request).toBe(false);
    expect("isRoot" in request).toBe(false);
  });

  test("keeps explicitly declared prototype setters bindable", () => {
    class SetterRequest {
      value = "";

      set normalized(input: string) {
        this.value = input.trim();
      }
    }

    const request = bindModel(SetterRequest, { normalized: "  safe  ", ignored: true });
    expect(request.value).toBe("safe");
    expect("ignored" in request).toBe(false);
  });

  test("strips unknown properties from initialized nested DTOs", () => {
    class ProfileRequest {
      displayName = "";
    }
    class AccountRequest {
      profile = new ProfileRequest();
    }

    const request = bindModel(AccountRequest, {
      profile: { displayName: "Ada", elevated: true },
    });
    expect(request.profile).toEqual({ displayName: "Ada" });
    expect("elevated" in request.profile).toBe(false);
  });

  test("applies generated shapes below an initialized nested DTO fallback", () => {
    class AddressRequest {
      city = "";
    }
    class ProfileRequest {
      address!: AddressRequest;
    }
    class AccountRequest {
      profile = new ProfileRequest();
    }
    registerRequestModelShape(ProfileRequest, {
      address: { model: AddressRequest },
    });

    const request = bindModel(AccountRequest, {
      profile: { address: { city: "Moscow", elevated: true } },
    });
    expect(request.profile).toBeInstanceOf(ProfileRequest);
    expect(request.profile.address).toBeInstanceOf(AddressRequest);
    expect(request.profile.address).toEqual({ city: "Moscow" });
  });

  test("fails closed when nested validation receives a plain object without hydration metadata", () => {
    class AddressRequest {
      @Validator({ required: true })
      city!: string;
    }
    class AccountRequest {
      @Validator({ required: true, nested: true })
      address!: AddressRequest;
    }

    expect(() => bindModel(AccountRequest, { address: {} }, modelValidatorAdapter)).toThrow(ModelValidationError);
    try {
      bindModel(AccountRequest, { address: {} }, modelValidatorAdapter);
    } catch (error) {
      expect(error).toBeInstanceOf(ModelValidationError);
      expect((error as ModelValidationError).errors).toContainEqual({
        property: "address",
        message: 'Field "address" must be a hydrated DTO instance',
        code: "nestedModel",
      });
    }
  });

  test("hydrates uninitialized nested DTOs and validates missing nested fields", () => {
    class AddressRequest {
      @Validator({ required: true, minLength: 2 })
      city!: string;
    }
    class AccountRequest {
      @Validator({ required: true, nested: true })
      address!: AddressRequest;
    }
    registerRequestModelShape(AccountRequest, {
      address: { model: AddressRequest },
    });

    try {
      bindModel(AccountRequest, { address: { elevated: true } }, modelValidatorAdapter);
      throw new Error("expected nested validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelValidationError);
      expect((error as ModelValidationError).errors.some((issue) => issue.property === "address.city")).toBe(true);
    }

    const request = bindModel(AccountRequest, {
      address: { city: "Moscow", elevated: true },
    }, modelValidatorAdapter);
    expect(request.address).toBeInstanceOf(AddressRequest);
    expect(request.address.city).toBe("Moscow");
    expect("elevated" in request.address).toBe(false);
  });

  test("hydrates nested DTO arrays recursively and strips dangerous/unknown keys at every level", () => {
    class GeoRequest {
      @Validator({ required: true })
      latitude!: number;
    }
    class AddressRequest {
      @Validator({ required: true, nested: true })
      geo!: GeoRequest;

      @Validator({ required: true })
      city!: string;
    }
    class BatchRequest {
      @Validator({ required: true, nested: true })
      addresses!: AddressRequest[];
    }
    registerRequestModelShape(BatchRequest, {
      addresses: { model: AddressRequest, array: true },
    });
    registerRequestModelShape(AddressRequest, {
      geo: { model: GeoRequest },
    });

    const body = JSON.parse(
      '{"addresses":[{"city":"Moscow","extra":true,"geo":{"latitude":55.75,"__proto__":{"polluted":true},"constructor":{"polluted":true},"extra":true}}]}',
    ) as unknown;
    const request = bindModel(BatchRequest, body, modelValidatorAdapter);
    expect(request.addresses[0]).toBeInstanceOf(AddressRequest);
    expect(request.addresses[0]!.geo).toBeInstanceOf(GeoRequest);
    expect(request.addresses[0]!.geo.latitude).toBe(55.75);
    expect("extra" in request.addresses[0]!).toBe(false);
    expect("extra" in request.addresses[0]!.geo).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(request.addresses[0]!.geo, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(request.addresses[0]!.geo, "constructor")).toBe(false);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("rejects malformed values for generated nested object and array shapes", () => {
    class ChildRequest {}
    class ParentRequest {
      child?: ChildRequest;
      children: ChildRequest[] = [];
    }
    registerRequestModelShape(ParentRequest, {
      child: { model: ChildRequest },
      children: { model: ChildRequest, array: true },
    });

    expect(() => bindModel(ParentRequest, { child: "not-an-object" })).toThrow(ModelValidationError);
    expect(() => bindModel(ParentRequest, { children: [{} as object, 1] })).toThrow(ModelValidationError);
  });

  test("preserves source-declared nullable nested fields and array elements", () => {
    class ChildRequest {
      @Validator({ required: true })
      value!: string;
    }
    class ParentRequest {
      @Validator({ nested: true })
      child!: ChildRequest | null;

      @Validator({ nested: true })
      children!: (ChildRequest | null)[];
    }
    registerRequestModelShape(ParentRequest, {
      child: { model: ChildRequest, nullable: true },
      children: { model: ChildRequest, array: true, elementNullable: true },
    });

    const request = bindModel(ParentRequest, {
      child: null,
      children: [null, { value: "ok" }],
    }, modelValidatorAdapter);
    expect(request.child).toBeNull();
    expect(request.children[0]).toBeNull();
    expect(request.children[1]).toBeInstanceOf(ChildRequest);
  });

  test("recursively sanitizes open object bags and unknown arrays without dropping ordinary JSON keys", () => {
    class OpenPayloadRequest {
      data: Record<string, unknown> = {};
      items: unknown[] = [];
    }

    const body = JSON.parse(`{
      "data": {
        "label": "kept",
        "nested": {
          "value": 1,
          "__proto__": { "polluted": true },
          "constructor": { "prototype": { "polluted": true } },
          "prototype": { "polluted": true }
        },
        "list": [{ "safe": true, "__proto__": { "polluted": true } }]
      },
      "items": [
        { "name": "one", "constructor": { "prototype": { "polluted": true } } },
        [{ "value": 2, "prototype": { "polluted": true } }]
      ]
    }`) as unknown;

    const request = bindModel(OpenPayloadRequest, body);
    expect(request.data).toEqual({
      label: "kept",
      nested: { value: 1 },
      list: [{ safe: true }],
    });
    expect(request.items).toEqual([{ name: "one" }, [{ value: 2 }]]);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("rejects cycles, excessive depth and excessive JSON node counts in open bags", () => {
    class OpenPayloadRequest {
      data: Record<string, unknown> = {};
      items: unknown[] = [];
    }

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => bindModel(OpenPayloadRequest, { data: cyclic })).toThrow(BadRequestError);

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 70; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() => bindModel(OpenPayloadRequest, { data: deep })).toThrow(BadRequestError);

    expect(() => bindModel(OpenPayloadRequest, {
      items: new Array<unknown>(100_000).fill(0),
    })).toThrow(BadRequestError);
  });
});
