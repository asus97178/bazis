import { describe, expect, test } from "bun:test";
import { Module, collectModuleUiProfiles } from "../index";

class ProductAdminUiProfile {}
class ProductEmployeeUiProfile {}
class UserAdminUiProfile {}

describe("@Module uiProfiles metadata", () => {
  test("collectModuleUiProfiles gathers profiles from module imports", () => {
    @Module({
      uiProfiles: [ProductAdminUiProfile, ProductEmployeeUiProfile],
    })
    class ProductModule {}

    @Module({
      uiProfiles: [UserAdminUiProfile],
    })
    class UsersModule {}

    @Module({
      imports: [ProductModule, UsersModule],
    })
    class AppModule {}

    expect(collectModuleUiProfiles([AppModule])).toEqual([
      ProductAdminUiProfile,
      ProductEmployeeUiProfile,
      UserAdminUiProfile,
    ]);
  });

  test("collectModuleUiProfiles deduplicates profile arrays by reference", () => {
    @Module({
      uiProfiles: [ProductAdminUiProfile],
    })
    class ProductAdminModule {}

    @Module({
      imports: [ProductAdminModule],
      uiProfiles: [ProductAdminUiProfile, ProductEmployeeUiProfile],
    })
    class AppModule {}

    expect(collectModuleUiProfiles([AppModule])).toEqual([
      ProductAdminUiProfile,
      ProductEmployeeUiProfile,
    ]);
  });
});
