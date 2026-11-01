import { definePermissions } from "bazis/core/access";

/** What the module lets an administrator allow; the roles are the application's. */
export const orderPermissions = definePermissions({
  "orders.create": {
    title: { en: "Place orders", ru: "Оформлять заказы" },
  },
  "orders.read": {
    title: { en: "See orders", ru: "Видеть заказы" },
    on: { status: { type: "string" } },
    owner: "customerId",
  },
});
