import { DbContext } from "../../library/orm";

type EntityClass = new () => object;
type ContextClass = abstract new (...parameters: never[]) => DbContext;

/** The sets of a context class are read once: a class does not change. */
const sets = new WeakMap<ContextClass, readonly EntityClass[] | Error>();

function setsOf(context: ContextClass): readonly EntityClass[] | Error {
  let known = sets.get(context);
  if (known === undefined) {
    try {
      known = DbContext.entitiesOf(context as unknown as Parameters<typeof DbContext.entitiesOf>[0]);
    } catch (error) {
      known = error instanceof Error ? error : new Error(String(error));
    }
    sets.set(context, known);
  }
  return known;
}

/**
 * The entities of a context: the listed ones in their order, then those of its
 * sets (`this.set(...)`). A context whose constructor cannot run without its
 * dependencies has only the listed ones, and with none listed that is an error.
 */
export function contextEntities(config: { readonly context?: ContextClass; readonly entities?: readonly EntityClass[] }): readonly EntityClass[] {
  const listed = config.entities ?? [];
  if (!config.context) return listed;
  const ofSets = setsOf(config.context);
  if (ofSets instanceof Error) {
    if (listed.length === 0) throw ofSets;
    return listed;
  }
  return ofSets.length === 0 ? listed : [...new Set([...listed, ...ofSets])];
}
