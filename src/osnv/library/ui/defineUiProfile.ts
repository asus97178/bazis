import {
  UI_PROFILE_V1_API_VERSION,
  UI_PROFILE_V1_KIND,
  type UiActionProfileV1,
  type UiCustomPageProfileV1,
  type UiFieldProfileV1,
  type UiOperationRefV1,
  type UiProfileV1,
  type UiResourceProfileV1,
  type UiSchemaElementV1,
} from "./profile-v1";
import { normalizeUiJsonObject } from "./serialization";

const ACTION_PLACEMENTS = new Set([
  "list.header",
  "list.row",
  "detail.header",
]);
const ACTION_INTENTS = new Set(["primary", "secondary", "danger", "neutral"]);
const ACTION_REFRESH_MODES = new Set(["none", "resource", "page", "all"]);

export function defineUiProfile(profile: UiProfileV1): UiProfileV1 {
  validateProfile(profile);
  return normalizeUiJsonObject(profile, "uiProfile") as unknown as UiProfileV1;
}

function validateProfile(profile: UiProfileV1): void {
  assertKnownKeys(profile, ["apiVersion", "kind", "metadata", "spec"], "uiProfile");
  if (profile.apiVersion !== UI_PROFILE_V1_API_VERSION) {
    throw new TypeError("uiProfile.apiVersion must be " + UI_PROFILE_V1_API_VERSION + ".");
  }
  if (profile.kind !== UI_PROFILE_V1_KIND) {
    throw new TypeError("uiProfile.kind must be " + UI_PROFILE_V1_KIND + ".");
  }

  requiredText(profile.metadata.name, "uiProfile.metadata.name");
  requiredText(profile.metadata.surface, "uiProfile.metadata.surface");
  requiredText(profile.metadata.owner, "uiProfile.metadata.owner");
  assertKnownKeys(profile.metadata, ["name", "surface", "owner", "extensions"], "uiProfile.metadata");
  assertKnownKeys(
    profile.spec,
    ["resources", "customPages", "requiredRendererCapabilities", "extensions"],
    "uiProfile.spec",
  );

  for (let index = 0; index < profile.spec.resources.length; index += 1) {
    validateResource(profile.spec.resources[index] as UiResourceProfileV1, "uiProfile.spec.resources[" + index + "]");
  }
  for (let index = 0; index < (profile.spec.customPages?.length ?? 0); index += 1) {
    validateCustomPage(
      profile.spec.customPages?.[index] as UiCustomPageProfileV1,
      "uiProfile.spec.customPages[" + index + "]",
    );
  }
  for (let index = 0; index < (profile.spec.requiredRendererCapabilities?.length ?? 0); index += 1) {
    requiredText(
      profile.spec.requiredRendererCapabilities?.[index] as string,
      "uiProfile.spec.requiredRendererCapabilities[" + index + "]",
    );
  }
}

function validateCustomPage(page: UiCustomPageProfileV1, path: string): void {
  requiredText(page.id, path + ".id");
  requiredText(page.title, path + ".title");
  validateNavigation(page.navigation, path + ".navigation");
  switch (page.kind) {
    case "feature":
      assertKnownKeys(page, ["kind", "id", "title", "navigation", "renderer"], path);
      requiredText(page.renderer, path + ".renderer");
      return;
    case "settings":
      assertKnownKeys(page, ["kind", "id", "title", "navigation", "operations", "form"], path);
      assertKnownKeys(page.operations, ["read", "update"], path + ".operations");
      validateOperation(page.operations.read, path + ".operations.read");
      validateOperation(page.operations.update, path + ".operations.update");
      if (page.form !== undefined) {
        assertKnownKeys(page.form, ["title", "uiSchema"], path + ".form");
        optionalText(page.form.title, path + ".form.title");
        if (page.form.uiSchema !== undefined) {
          validateUiSchema(page.form.uiSchema, path + ".form.uiSchema");
        }
      }
      return;
    case "document":
      assertKnownKeys(page, ["kind", "id", "title", "navigation", "operation"], path);
      validateOperation(page.operation, path + ".operation");
      return;
    case "dashboard": {
      assertKnownKeys(page, ["kind", "id", "title", "navigation", "blocks"], path);
      if (page.blocks.length === 0) {
        throw new TypeError(path + ".blocks must contain at least one block.");
      }
      const ids = new Set<string>();
      for (let index = 0; index < page.blocks.length; index += 1) {
        const block = page.blocks[index] as (typeof page.blocks)[number];
        const blockPath = path + ".blocks[" + index + "]";
        assertKnownKeys(block, ["id", "kind", "title", "operation"], blockPath);
        requiredText(block.id, blockPath + ".id");
        if (ids.has(block.id)) {
          throw new TypeError(path + ".blocks must not contain duplicate id " + block.id + ".");
        }
        ids.add(block.id);
        if (block.kind !== "metric" && block.kind !== "document") {
          throw new TypeError(blockPath + ".kind is not supported.");
        }
        requiredText(block.title, blockPath + ".title");
        validateOperation(block.operation, blockPath + ".operation");
      }
      return;
    }
    default:
      throw new TypeError(path + ".kind is not a supported custom page kind.");
  }
}

function validateNavigation(navigation: UiCustomPageProfileV1["navigation"], path: string): void {
  if (navigation === undefined) {
    return;
  }
  assertKnownKeys(navigation, ["title", "group", "icon", "order", "hidden"], path);
  optionalText(navigation.title, path + ".title");
  optionalText(navigation.group, path + ".group");
  optionalText(navigation.icon, path + ".icon");
  optionalInteger(navigation.order, path + ".order");
}

function validateResource(resource: UiResourceProfileV1, path: string): void {
  assertKnownKeys(
    resource,
    ["id", "title", "singularTitle", "keyField", "navigation", "operations", "list", "detail", "forms", "actions", "extensions"],
    path,
  );
  requiredText(resource.id, path + ".id");
  optionalText(resource.title, path + ".title");
  optionalText(resource.singularTitle, path + ".singularTitle");
  optionalText(resource.keyField, path + ".keyField");
  optionalText(resource.navigation?.title, path + ".navigation.title");
  optionalText(resource.navigation?.group, path + ".navigation.group");
  optionalText(resource.navigation?.icon, path + ".navigation.icon");
  if (resource.navigation !== undefined) {
    assertKnownKeys(
      resource.navigation,
      ["title", "group", "icon", "order", "hidden"],
      path + ".navigation",
    );
    optionalInteger(resource.navigation.order, path + ".navigation.order");
  }

  const operations = resource.operations;
  if (operations !== undefined) {
    assertKnownKeys(operations, ["list", "read", "create", "update", "delete"], path + ".operations");
    validateOperation(operations.list, path + ".operations.list");
    validateOperation(operations.read, path + ".operations.read");
    validateOperation(operations.create, path + ".operations.create");
    validateOperation(operations.update, path + ".operations.update");
    validateOperation(operations.delete, path + ".operations.delete");
  }

  validateFields(resource.list?.columns, path + ".list.columns");
  validateFields(resource.list?.selectionFields, path + ".list.selectionFields");
  optionalText(resource.list?.defaultSort, path + ".list.defaultSort");
  optionalPositiveInteger(resource.list?.pageSize, path + ".list.pageSize");
  if (resource.list !== undefined) {
    assertKnownKeys(
      resource.list,
      ["title", "columns", "selectionFields", "defaultSort", "pageSize"],
      path + ".list",
    );
    optionalText(resource.list.title, path + ".list.title");
  }

  if (resource.detail !== undefined) {
    assertKnownKeys(
      resource.detail,
      ["titleField", "subtitleField", "statusField", "sections"],
      path + ".detail",
    );
    optionalText(resource.detail.titleField, path + ".detail.titleField");
    optionalText(resource.detail.subtitleField, path + ".detail.subtitleField");
    optionalText(resource.detail.statusField, path + ".detail.statusField");
  }
  for (let index = 0; index < (resource.detail?.sections?.length ?? 0); index += 1) {
    const section = resource.detail?.sections?.[index];
    if (section === undefined) {
      continue;
    }
    assertKnownKeys(section, ["id", "title", "fields"], path + ".detail.sections[" + index + "]");
    requiredText(section.id, path + ".detail.sections[" + index + "].id");
    requiredText(section.title, path + ".detail.sections[" + index + "].title");
    validateFields(section.fields, path + ".detail.sections[" + index + "].fields");
  }

  if (resource.forms?.create?.uiSchema !== undefined) {
    validateUiSchema(resource.forms.create.uiSchema, path + ".forms.create.uiSchema");
  }
  if (resource.forms?.edit?.uiSchema !== undefined) {
    validateUiSchema(resource.forms.edit.uiSchema, path + ".forms.edit.uiSchema");
  }
  if (resource.forms !== undefined) {
    assertKnownKeys(resource.forms, ["create", "edit"], path + ".forms");
  }
  if (resource.forms?.create !== undefined) {
    assertKnownKeys(resource.forms.create, ["title", "uiSchema"], path + ".forms.create");
    optionalText(resource.forms.create.title, path + ".forms.create.title");
  }
  if (resource.forms?.edit !== undefined) {
    assertKnownKeys(resource.forms.edit, ["title", "uiSchema"], path + ".forms.edit");
    optionalText(resource.forms.edit.title, path + ".forms.edit.title");
  }

  for (let index = 0; index < (resource.actions?.length ?? 0); index += 1) {
    validateAction(resource.actions?.[index] as UiActionProfileV1, path + ".actions[" + index + "]");
  }
}

function validateOperation(operation: UiOperationRefV1 | undefined, path: string): void {
  if (operation !== undefined) {
    assertKnownKeys(operation, ["operationId"], path);
    requiredText(operation.operationId, path + ".operationId");
  }
}

function validateFields(fields: readonly UiFieldProfileV1[] | undefined, path: string): void {
  for (let index = 0; index < (fields?.length ?? 0); index += 1) {
    const field = fields?.[index] as UiFieldProfileV1;
    requiredText(field, path + "[" + index + "]");
  }
}

function validateAction(action: UiActionProfileV1, path: string): void {
  assertKnownKeys(
    action,
    ["id", "title", "operation", "placements", "intent", "confirm", "refresh", "extensions"],
    path,
  );
  requiredText(action.id, path + ".id");
  requiredText(action.title, path + ".title");
  validateOperation(action.operation, path + ".operation");
  if (action.placements.length === 0) {
    throw new TypeError(path + ".placements must contain at least one placement.");
  }
  const seenPlacements = new Set<string>();
  for (const placement of action.placements) {
    if (!ACTION_PLACEMENTS.has(placement)) {
      throw new TypeError(path + ".placements contains unsupported placement " + placement + ".");
    }
    if (seenPlacements.has(placement)) {
      throw new TypeError(path + ".placements must not contain duplicate placement " + placement + ".");
    }
    seenPlacements.add(placement);
  }
  if (action.intent !== undefined && !ACTION_INTENTS.has(action.intent)) {
    throw new TypeError(path + ".intent contains unsupported intent " + action.intent + ".");
  }
  if (action.refresh !== undefined && !ACTION_REFRESH_MODES.has(action.refresh)) {
    throw new TypeError(path + ".refresh contains unsupported mode " + action.refresh + ".");
  }
  optionalText(action.confirm, path + ".confirm");
  if (action.intent === "danger" && action.confirm === undefined) {
    throw new TypeError(path + ".confirm is required for a danger action.");
  }
}

function validateUiSchema(element: UiSchemaElementV1, path: string): void {
  switch (element.type) {
    case "Control":
      assertKnownKeys(element, ["type", "scope", "label", "options"], path);
      requiredText(element.scope, path + ".scope");
      return;
    case "Label":
      assertKnownKeys(element, ["type", "text"], path);
      requiredText(element.text, path + ".text");
      return;
    case "VerticalLayout":
    case "HorizontalLayout":
    case "Group":
    case "Category":
      assertKnownKeys(
        element,
        element.type === "Category"
          ? ["type", "label", "elements"]
          : ["type", "label", "elements"],
        path,
      );
      if (element.type === "Category") {
        requiredText(element.label, path + ".label");
      }
      for (let index = 0; index < element.elements.length; index += 1) {
        validateUiSchema(element.elements[index] as UiSchemaElementV1, path + ".elements[" + index + "]");
      }
      return;
    case "Categorization":
      assertKnownKeys(element, ["type", "elements"], path);
      for (let index = 0; index < element.elements.length; index += 1) {
        validateUiSchema(element.elements[index] as UiSchemaElementV1, path + ".elements[" + index + "]");
      }
      return;
    default:
      throw new TypeError(path + ".type is not a supported UI Schema element.");
  }
}

function requiredText(value: string, path: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(path + " must be a non-empty string.");
  }
  if (normalized !== value) {
    throw new TypeError(path + " must not contain surrounding whitespace.");
  }
  return normalized;
}

function optionalText(value: string | undefined, path: string): void {
  if (value !== undefined) {
    requiredText(value, path);
  }
}

function optionalPositiveInteger(value: number | undefined, path: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new TypeError(path + " must be a positive integer.");
  }
}

function optionalInteger(value: number | undefined, path: string): void {
  if (value !== undefined && !Number.isInteger(value)) {
    throw new TypeError(path + " must be an integer.");
  }
}

function assertKnownKeys(value: object, allowed: readonly string[], path: string): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new TypeError(path + "." + key + " is not part of UiProfileV1.");
    }
  }
}
