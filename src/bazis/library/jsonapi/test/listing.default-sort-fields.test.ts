import { expect, test } from "bun:test";
import { ListOptions, ListRequest, Sortable, buildListDocument, optionsFromSchema, parseListQuery } from "../index";

// defaultSort applies when the request has no `sort`; `fields[type]` is
// applied to the items. Before, `fields` was parsed and only echoed in links.
interface Task { id: string; name: string; email: string; createdAt: Date }

@ListOptions({ defaultSize: 20, maxSize: 100, defaultSort: "-createdAt,name" })
class TaskListQuery extends ListRequest<Task> {
  @Sortable() name!: string;
  @Sortable() createdAt!: Date;
}

const parse = (query: string) => parseListQuery(new URLSearchParams(query), optionsFromSchema(TaskListQuery));

test("defaultSort is used without sort and replaced by an explicit one", () => {
  expect(parse("").sort).toEqual([{ field: "createdAt", dir: "desc" }, { field: "name", dir: "asc" }]);
  expect(parse("sort=name").sort).toEqual([{ field: "name", dir: "asc" }]);
});

test("a defaultSort field that is not @Sortable() fails when the class is declared", () => {
  expect(() => {
    @ListOptions({ defaultSort: "-email" })
    class Broken extends ListRequest<Task> {
      @Sortable() name!: string;
      email!: string;
    }
    return Broken;
  }).toThrow('@ListOptions on Broken: defaultSort field "email" is not @Sortable().');
});

const items: Task[] = [
  { id: "1", name: "Alice", email: "alice@example.com", createdAt: new Date(0) },
  { id: "2", name: "Bob", email: "bob@example.com", createdAt: new Date(0) },
];

test("fields[type] keeps id and the requested fields; the type comes from basePath", () => {
  const document = buildListDocument(items, parse("fields[tasks]=name"), 2, { basePath: "/api/tasks" });
  // With fields the items are partial at runtime; the document type stays T.
  expect(document.data as readonly unknown[]).toEqual([{ id: "1", name: "Alice" }, { id: "2", name: "Bob" }]);
  expect(document.links?.self).toContain("fields%5Btasks%5D=name");
});

test("an explicit type wins; another type and no fields leave items as they are", () => {
  expect(buildListDocument(items, parse("fields[todo]=email"), 2, { basePath: "/tasks", type: "todo" }).data as readonly unknown[])
    .toEqual([{ id: "1", email: "alice@example.com" }, { id: "2", email: "bob@example.com" }]);
  expect(buildListDocument(items, parse("fields[users]=name"), 2, { basePath: "/tasks" }).data).toEqual(items);
  expect(buildListDocument(items, parse(""), 2).data).toEqual(items);
});
