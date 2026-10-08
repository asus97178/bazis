import { expect, test } from "bun:test";
import { HttpSetupError } from "../Errors/HttpError";
import { Router } from "../Routing/Router";
import { parseTemplate } from "../Routing/template";

// The duplicate-route error names the path of both routes. It used to read
// `Duplicate route: GET (version "-") already mapped to ...` without a path.
const action = (name: string) => ({ chain: [], name });

test("routes that differ only in parameter names are reported with both paths", () => {
  const router = new Router();
  router.register(parseTemplate("/tasks/:id"), "GET", "", action("TasksController.byId"));
  expect(() => router.register(parseTemplate("/tasks/:taskId"), "GET", "", action("TasksController.again"))).toThrow(new HttpSetupError(
    "Duplicate route: GET /tasks/:taskId is mapped to both TasksController.byId (/tasks/:id) and TasksController.again. "
      + "Routes that differ only in parameter names are the same route; change one of the paths.",
  ));
});

test("constraints, wildcards and versions appear in the message", () => {
  const router = new Router();
  router.register(parseTemplate("/files/:id(int)/*path"), "GET", "2", action("FilesController.get"));
  expect(() => router.register(parseTemplate("/files/:n(int)/*rest"), "GET", "2", action("FilesController.other")))
    .toThrow("Duplicate route: GET /files/:n(int)/*rest (version 2) is mapped to both FilesController.get (/files/:id(int)/*path) and FilesController.other.");
});
