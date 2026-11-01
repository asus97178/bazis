import type { ModuleNaming } from "../naming";

/** `processes/<Name>.process.ts`: a manual start and an end, to grow into the real process. */
export function buildProcessTemplate(process: ModuleNaming, moduleClass: string): string {
  const title = process.folder.split("-").map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(" ");
  return `import { defineProcess } from "bazis/core/workflow";

/**
 * ${title}: a process of ${moduleClass}. It is published when the application
 * starts and changes only here. Check it with \`bunx bazis workflow check\`,
 * draw it with \`bunx bazis workflow diagram ${process.folder}\`.
 */
export const ${process.module}Process = defineProcess({
  key: "${process.folder}",
  title: "${title}",
  document: {
    schemaVersion: "bazis.workflow/v2",
    nodes: {
      Start: { kind: "manualStart", title: "Start" },
      End: { kind: "end", title: "End" },
    },
    flows: {
      f1: { source: "Start", target: "End" },
    },
  },
});
`;
}
