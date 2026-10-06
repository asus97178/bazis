import { describe, expect, test } from "bun:test";
import {
  DI,
  createContainer,
  createInstance,
  createToken,
  keyedDependency,
  type BazisModuleRef,
} from "../index";

interface IGreeting {
  text(): string;
}
const GREETING = createToken<IGreeting>("IGreeting");

class FormalGreeting implements IGreeting {
  text(): string {
    return "Good day";
  }
}

class CasualGreeting implements IGreeting {
  text(): string {
    return "Hey";
  }
}

class Letter {
  public constructor(
    private readonly greeting: IGreeting,
    private readonly recipient: string,
  ) {}

  render(): string {
    return `${this.greeting.text()}, ${this.recipient}`;
  }
}

describe("createInstance (ActivatorUtilities analog)", () => {
  test("mixes DI dependencies with runtime arguments", () => {
    const moduleRef: BazisModuleRef = {
      providers: [DI.singleton(DI.classProvider(GREETING, FormalGreeting))],
    };
    const container = createContainer(moduleRef);

    const letter = createInstance(container, Letter, [GREETING], "Ada");
    expect(letter.render()).toBe("Good day, Ada");
  });

  test("resolves keyed DI dependencies", () => {
    const moduleRef: BazisModuleRef = {
      providers: [
        DI.keyedSingleton("formal", DI.classProvider(GREETING, FormalGreeting)),
        DI.keyedSingleton("casual", DI.classProvider(GREETING, CasualGreeting)),
      ],
    };
    const container = createContainer(moduleRef);

    const letter = createInstance(container, Letter, [keyedDependency(GREETING, "casual")], "Grace");
    expect(letter.render()).toBe("Hey, Grace");
  });

  test("honors the resolver scope for scoped dependencies", () => {
    class RequestId {
      static seq = 0;
      readonly id = (RequestId.seq += 1);
    }
    const REQUEST_ID = createToken<RequestId>("RequestId");

    class Handler {
      public constructor(public readonly requestId: RequestId) {}
    }

    const moduleRef: BazisModuleRef = {
      providers: [DI.scoped(DI.classProvider(REQUEST_ID, RequestId))],
    };
    const container = createContainer(moduleRef);

    const scopeA = container.createScope();
    const scopeB = container.createScope();
    const a = createInstance(scopeA, Handler, [REQUEST_ID]);
    const b = createInstance(scopeB, Handler, [REQUEST_ID]);

    expect(a.requestId).toBe(scopeA.resolve(REQUEST_ID));
    expect(a.requestId.id).not.toBe(b.requestId.id);
  });

  test("works with no DI dependencies (runtime args only)", () => {
    class Point {
      public constructor(
        public readonly x: number,
        public readonly y: number,
      ) {}
    }
    const container = createContainer({ providers: [] });

    const point = createInstance(container, Point, [], 3, 4);
    expect(point.x).toBe(3);
    expect(point.y).toBe(4);
  });
});
