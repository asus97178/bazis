# `bazis/library/orm`

ORM без подключения к приложению: сущности, контекст, запросы, схема,
ошибки — для скриптов и пакетов вне DI. В приложении берите
[`bazis/core/orm`](core-orm.md): там все эти экспорты и ещё
`ormBazisConnect`, `ormModule`, `IRepository`, `repositoryFor`,
`registerRepositories`, `paginate`, `databaseErrorStatus`, `encryptedWith`,
`DATABASE_PROVIDER`, службы `OrmLifecycle`, `OrmConnectionLifecycle`,
`OrmProviderReadyLifecycle` и типы `OrmModuleConfig`,
`PostgresOrmConfigShape`, `PageResult`.
