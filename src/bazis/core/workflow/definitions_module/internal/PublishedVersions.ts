import type { VersionDetails } from "../services/IWorkflowDefinitions.service";

/** A process with a published version, as a list query reads it: no documents. */
export interface PublishedHead {
  readonly id: string;
  readonly key: string;
  readonly latestVersion: number;
}

/**
 * The latest published versions, kept between calls. Versions are immutable, so
 * what was read once is read no more: an event or a firing of a schedule costs
 * one query of the heads, and documents are loaded only for versions published
 * since. One per application instance; another instance sees a publication with
 * its next query of the heads.
 */
export class PublishedVersions {
  private readonly byProcess = new Map<string, VersionDetails>();

  /** The latest version of each head; `load` reads the documents this cache does not hold yet. */
  async resolve(heads: readonly PublishedHead[], load: (missing: readonly PublishedHead[]) => Promise<readonly VersionDetails[]>): Promise<readonly VersionDetails[]> {
    const current = new Set(heads.map((head) => head.id));
    for (const id of this.byProcess.keys()) if (!current.has(id)) this.byProcess.delete(id);
    const missing = heads.filter((head) => this.byProcess.get(head.id)?.version !== head.latestVersion);
    if (missing.length > 0) {
      const loaded = new Map((await load(missing)).map((version) => [version.key, version]));
      for (const head of missing) {
        const version = loaded.get(head.key);
        // A version another instance has just replaced is read on the next call.
        if (version?.version === head.latestVersion) this.byProcess.set(head.id, version);
        else this.byProcess.delete(head.id);
      }
    }
    return heads.flatMap((head) => {
      const version = this.byProcess.get(head.id);
      return version === undefined ? [] : [version];
    });
  }
}
