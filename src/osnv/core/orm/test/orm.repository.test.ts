import { describe, expect, test } from "bun:test";
import { DI, Module, ModuleEncapsulationError, createContainer } from "@/core/di";
import { Column, DbContext, Entity, IRepository, Key, registerRepositories, repositoryFor } from "@/core/orm";

@Entity()
class RepoContractEntity {
  @Key()
  id = 0;

  @Column({ type: "text" })
  name = "";
}

class RepoContractContext extends DbContext {}

describe("Repository<T> pure module contracts", () => {
  test("module without IRepository export fails encapsulation", () => {
    @Module({
      providers: [DI.scoped(DI.factoryProvider(RepoContractContext, [], () => { throw new Error("not used"); }))],
      configure: (di) => registerRepositories(di, RepoContractContext, [RepoContractEntity]),
      exports: [],
    })
    class PrivateOrmModule {}
    class Consumer { public constructor(public readonly repository: IRepository<RepoContractEntity>) {} }
    @Module({
      imports: [PrivateOrmModule],
      providers: [DI.scoped(DI.classProvider(Consumer, Consumer, [repositoryFor(RepoContractEntity)] as const))],
    })
    class ConsumerModule {}
    expect(() => createContainer(ConsumerModule)).toThrow(ModuleEncapsulationError);
  });
});
