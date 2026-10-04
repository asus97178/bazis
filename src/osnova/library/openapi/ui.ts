export function serveOpenApiDocs(
  docs: { readonly uiPath: string; readonly specPath: string; readonly json: string; readonly html: string },
  pathname: string,
  method: string,
): Response | undefined {
  if (pathname !== docs.uiPath && pathname !== `${docs.uiPath}/` && pathname !== docs.specPath) {
    return undefined;
  }
  if (method !== "GET" && method !== "HEAD") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: {
        allow: "GET, HEAD",
        "content-type": "application/json; charset=utf-8",
      },
    });
  }
  if (pathname === docs.specPath) {
    return new Response(docs.json, {
      headers: openApiDocsHeaders("application/json; charset=utf-8"),
    });
  }
  return new Response(docs.html, {
    headers: openApiDocsHeaders("text/html; charset=utf-8"),
  });
}

export function openApiDocsHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline';",
  };
}

export function renderOpenApiHtml(title: string, specPath: string): string {
  const titleJson = JSON.stringify(title);
  const specPathJson = JSON.stringify(specPath);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} Docs</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    header { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: 1fr minmax(180px, 320px) auto; gap: 12px; align-items: center; padding: 16px 20px; border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent); background: color-mix(in srgb, Canvas 94%, CanvasText 6%); }
    h1 { margin: 0; font-size: 18px; line-height: 1.2; letter-spacing: 0; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) 360px; min-height: calc(100vh - 69px); }
    #operations { padding: 18px 20px 40px; }
    #raw { padding: 18px; border-left: 1px solid color-mix(in srgb, CanvasText 12%, transparent); background: color-mix(in srgb, CanvasText 4%, Canvas); overflow: auto; }
    input { width: 100%; min-height: 36px; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 6px; padding: 8px 10px; background: Canvas; color: CanvasText; font: inherit; }
    a, button { color: inherit; }
    .spec-link { white-space: nowrap; font-size: 13px; text-decoration: none; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 6px; padding: 8px 10px; }
    .path { margin: 0 0 18px; border: 1px solid color-mix(in srgb, CanvasText 13%, transparent); border-radius: 8px; overflow: hidden; background: Canvas; }
    .path h2 { margin: 0; padding: 12px 14px; font-size: 14px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: color-mix(in srgb, CanvasText 5%, Canvas); overflow-wrap: anywhere; letter-spacing: 0; }
    .operation { border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent); padding: 12px 14px; }
    .line { display: flex; gap: 10px; align-items: center; min-width: 0; }
    .method { width: 68px; flex: 0 0 68px; text-align: center; border-radius: 5px; padding: 5px 7px; font-weight: 700; font-size: 12px; color: white; background: #64748b; }
    .GET { background: #087f5b; } .POST { background: #1c64b7; } .PUT { background: #9a5b00; } .PATCH { background: #7c3aed; } .DELETE { background: #b42318; }
    .summary { min-width: 0; overflow-wrap: anywhere; font-size: 14px; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0 78px; }
    .pill { border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 999px; padding: 3px 7px; font-size: 12px; color: color-mix(in srgb, CanvasText 72%, Canvas); }
    pre { margin: 0; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    .empty { color: color-mix(in srgb, CanvasText 60%, Canvas); }
    @media (max-width: 900px) {
      header { grid-template-columns: 1fr; }
      main { grid-template-columns: 1fr; }
      #raw { border-left: 0; border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); max-height: 45vh; }
    }
  </style>
</head>
<body>
  <header>
    <h1></h1>
    <input id="filter" type="search" placeholder="Filter operations">
    <a class="spec-link" href="">Open JSON</a>
  </header>
  <main>
    <section id="operations"></section>
    <aside id="raw"><pre></pre></aside>
  </main>
  <script>
    const docsTitle = ${titleJson};
    const specPath = ${specPathJson};
    const state = { spec: null, rows: [] };
    document.querySelector("h1").textContent = docsTitle;
    document.querySelector(".spec-link").href = specPath;
    fetch(specPath)
      .then((response) => response.json())
      .then((spec) => {
        state.spec = spec;
        state.rows = flatten(spec);
        document.querySelector("#raw pre").textContent = JSON.stringify(spec, null, 2);
        render();
      })
      .catch((error) => {
        document.querySelector("#operations").innerHTML = '<p class="empty">Unable to load OpenAPI document.</p>';
        document.querySelector("#raw pre").textContent = String(error);
      });
    document.querySelector("#filter").addEventListener("input", render);
    function flatten(spec) {
      const methods = ["get", "post", "put", "patch", "delete", "options", "head"];
      const rows = [];
      for (const [path, item] of Object.entries(spec.paths || {})) {
        for (const method of methods) {
          if (item && item[method]) rows.push({ path, method: method.toUpperCase(), operation: item[method] });
        }
      }
      return rows;
    }
    function render() {
      const filter = document.querySelector("#filter").value.trim().toLowerCase();
      const grouped = new Map();
      for (const row of state.rows) {
        const haystack = [row.method, row.path, row.operation.summary, row.operation.operationId, ...(row.operation.tags || [])].join(" ").toLowerCase();
        if (filter && !haystack.includes(filter)) continue;
        if (!grouped.has(row.path)) grouped.set(row.path, []);
        grouped.get(row.path).push(row);
      }
      const root = document.querySelector("#operations");
      if (grouped.size === 0) {
        root.innerHTML = '<p class="empty">No operations found.</p>';
        return;
      }
      root.innerHTML = "";
      for (const [path, rows] of grouped) {
        const block = document.createElement("article");
        block.className = "path";
        const heading = document.createElement("h2");
        heading.textContent = path;
        block.appendChild(heading);
        for (const row of rows) block.appendChild(operationNode(row));
        root.appendChild(block);
      }
    }
    function operationNode(row) {
      const node = document.createElement("section");
      node.className = "operation";
      const line = document.createElement("div");
      line.className = "line";
      const method = document.createElement("span");
      method.className = "method " + row.method;
      method.textContent = row.method;
      const summary = document.createElement("span");
      summary.className = "summary";
      summary.textContent = row.operation.operationId || row.operation.summary || "";
      line.append(method, summary);
      node.appendChild(line);
      const meta = document.createElement("div");
      meta.className = "meta";
      for (const parameter of row.operation.parameters || []) {
        meta.appendChild(pill(parameter.in + ":" + parameter.name + (parameter.required ? " required" : "")));
      }
      if (row.operation.requestBody) meta.appendChild(pill("body"));
      if (row.operation.security) meta.appendChild(pill("auth"));
      for (const status of Object.keys(row.operation.responses || {})) meta.appendChild(pill(status));
      if (meta.children.length > 0) node.appendChild(meta);
      return node;
    }
    function pill(text) {
      const item = document.createElement("span");
      item.className = "pill";
      item.textContent = text;
      return item;
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
