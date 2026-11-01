import { definePermissions } from "bazis/core/access";

export const auditPermissions = definePermissions({
  "audit.read": {
    title: { en: "See the audit log", ru: "Видеть журнал аудита" },
  },
});
