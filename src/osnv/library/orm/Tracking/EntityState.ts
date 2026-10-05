/** Состояние сущности в трекере (как в EF Core). */
export enum EntityState {
  /** Не отслеживается. */
  Detached = "Detached",
  /** Загружена/прикреплена, изменений нет. */
  Unchanged = "Unchanged",
  /** Новая, будет вставлена. */
  Added = "Added",
  /** Изменена, будет обновлена. */
  Modified = "Modified",
  /** Будет удалена. */
  Deleted = "Deleted",
}
