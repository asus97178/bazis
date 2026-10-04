import { KernelError } from "./KernelError";

export class StartupAbortedError extends KernelError {
  public constructor() {
    super("Application startup was aborted by a shutdown request.");
  }
}
