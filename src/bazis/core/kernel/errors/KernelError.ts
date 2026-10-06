/** Base class for all kernel errors. */
export class KernelError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
