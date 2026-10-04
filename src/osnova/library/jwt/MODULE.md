# JWT

Версия паспорта: 1.2. Дата: 2026-09-14.
Тип: атомарная библиотечная функция, без собственного DI-модуля.
Путь: src/osnova/library/jwt. Публичный вход: [index.ts](index.ts), @osnova/library/jwt.
Статус: JWT-01–JWT-06 исправлены; добавлены ротация ключей и эксплуатационные проверки.
Область: ключи и их lifecycle, validate, issue/rotate и helpers base64url.
Вызовы с одним SigningAlgorithm сохраняются; добавлены JwtKeyRing и лимит размера.
Создание каркаса: историческая библиотека, команда создания неизвестна. Новый модуль не создаётся.

## 1. Ответственность и структура

Библиотека владеет подписью и проверкой compact JWS, JWT claims и выпуском пары
access/refresh. Это одна техническая функция. SigningAlgorithm остаётся портом
криптографии; JwtValidator проверяет недоверенный токен, TokenIssuer владеет
настройками выпуска, TokenService выбирает издателя по виду токена.

HTTP, DI, роли, состояние учётной записи, хранилище refresh, отзыв сессий и
выбор окружения принадлежат приложению. imports и DI-exports отсутствуют;
[AuthModule](../../../app/modules/auth/Auth.module.ts) регистрирует TokenService
через существующую фабрику. ORM, HTTP-контроллеры, фоновые службы и AI здесь не используются.

ООП/SOLID и простота: инварианты остаются у существующих владельцев, новых
подмодулей и внешних зависимостей нет. Снимки ключей и настроек создаются один раз.
Частый путь линейный по размеру токена; ключи Web Crypto кешируются после импорта.
Неизвестные критические JOSE-расширения отклоняются: их обработчик не заявлен.
Бинарное исполнение использует стандартные Web Crypto/TextEncoder/TextDecoder,
без чтения исходников и файлов ключей во время проверки.

## 2. Компоненты

| Компонент | Файл | Ответственность / вход |
| --- | --- | --- |
| Hs256Algorithm / hs256 | [signing/Hs256Algorithm.ts](signing/Hs256Algorithm.ts) | Снимок секрета, HMAC-SHA256; строка signingInput и байты подписи |
| Rs256Algorithm / rs256 | [signing/Rs256Algorithm.ts](signing/Rs256Algorithm.ts) | Снимок PEM-настроек; импорт RSA не слабее 2048 бит, sign/verify/exportPublicJwk |
| JwtKeyRing | [JwtKeyRing.ts](JwtKeyRing.ts) | Доверенный набор ключей, подготовка, атомарная замена, отзыв и безопасные метаданные |
| JwtValidator | [JwtValidator.ts](JwtValidator.ts) | Снимок validation options, строгий формат и зарегистрированные claims |
| JwtEncoder | [JwtEncoder.ts](JwtEncoder.ts) | Сериализация переданных claims и подпись; бизнес-правила claims принадлежат вызывающему |
| TokenIssuer | [TokenIssuer.ts](TokenIssuer.ts) | Проверенная конфигурация, subject, access/refresh, stateless rotate |
| TokenService | [TokenService.ts](TokenService.ts) | Реестр видов токенов; алгоритмы и аудитории назначает приложение |
| base64url | [base64url.ts](base64url.ts) | Каноническая base64url без padding; точный UTF-8 |
| limits | [limits.ts](limits.ts) | DEFAULT_MAX_TOKEN_LENGTH = 16384; проверка положительного safe integer |
| Ошибки и типы | [errors.ts](errors.ts), [claims.ts](claims.ts) | Публичные ошибки JWT и существующие TypeScript-контракты |

## 3. Ключи и lifecycle

Конструкторы алгоритмов вызываются приложением. Ключи — доверенная конфигурация,
не данные из kid или других полей токена. Сеть, JWKS discovery и файловый ввод
не используются. В одиночной стратегии kid сравнивается с настроенным значением;
в JwtKeyRing выбирает ровно одну доверенную стратегию из локальной Map.

| Поле | Тип / формат | Обязательно | null / default | Проверки и владение |
| --- | --- | --- | --- | --- |
| secret | string UTF-8 или Uint8Array | да, HS256 | нет / нет | Минимум 32 байта; собственная копия, включая Buffer/subarray |
| keys.publicKeyPem | string, SPKI PEM | да, RS256 | нет / нет | Непустая строка; Web Crypto импорт; modulusLength >= 2048 |
| keys.privateKeyPem | string, PKCS#8 PEM | для sign | нет / отсутствует | Непустая строка при наличии; импорт и modulusLength >= 2048 |
| keys.keyId | string | нет | нет / отсутствует | Непустая строка; снимок, записывается в kid |
| signingInput | string, header.payload | sign/verify | нет / нет | Байты UTF-8 передаются криптографическому алгоритму |
| signature | Uint8Array | verify | нет / нет | Несовпадение подписи возвращает false |

Минимальный размер RSA проверяется при ленивом импорте перед использованием.
Ошибки ключевой конфигурации — TypeError/RangeError либо ошибки Web Crypto.
Они не маскируются как ошибки недоверенного JWT. Ключи сохраняются в памяти
экземпляра; API отмены, явной очистки CryptoKey и автоматической ротации отсутствуют.
Повтор импорта после отказа возможен при следующем вызове; частично выполненный
выпуск пары не возвращает успешного результата.

### JwtKeyRing

Приложение вызывает `await JwtKeyRing.create(config)` до публикации TokenService.
`JwtEncoder`, `JwtValidator`, `TokenIssuerConfig.algorithm/refreshAlgorithm`
принимают этот объект вместо одиночной стратегии. При подготовке signing key
подписывает случайную служебную строку: правильная подпись должна проверяться,
изменённое сообщение — отклоняться. Public-only key импортируется при проверке
пустой подписи, которая обязана дать false. Это проверяет пригодность ключа,
но не заменяет доверие к реализации SigningAlgorithm.

| Поле | Тип / источник | Обязательность | null / default | Проверка / пример |
| --- | --- | --- | --- | --- |
| config.keys | readonly JwtKeyEntry[], аргумент create/replace | да | нет / нет | 1…32 элемента |
| config.keys[].keyId | string, доверенная конфигурация | да | нет / нет | 1…128 ASCII букв/цифр/`._-`; уникален; `auth-2026-09` |
| config.keys[].algorithm | SigningAlgorithm | да | нет / нет | Непустой alg кроме none; boolean canSign; sign/verify; algorithm.keyId при наличии совпадает |
| config.activeKeyId | string | для выпуска | нет / отсутствует | Id существующего canSign ключа; без поля только проверка |
| config.legacy | object {keyId, acceptUntil} | нет | нет / отсутствует | Явный переход JWT без kid; оба вложенных поля обязательны |
| config.legacy.keyId | string | при legacy | нет / нет | Один существующий ключ, формат id как выше |
| config.legacy.acceptUntil | number, Unix seconds | при legacy | нет / нет | Конечное число > 0; при now >= acceptUntil JWT без kid отклоняется |
| revoke(keyId) | string, команда оператора | да | нет / нет | Та же проверка id; результат boolean: был ли ключ в наборе |

`replace(config): Promise<void>` проверяет новый снимок, затем заменяет текущий
одним присваиванием. Ошибка подготовки оставляет текущий снимок. Конкурентное
replace/revoke меняет revision; запоздалая подготовка отклоняется обычным Error,
автоматический повтор отсутствует. Для плановой ротации передаются старый и новый
ключи, activeKeyId указывает новый. Сохраняющиеся экземпляры стратегий повторно
не импортируются. Поиск ключа O(1), обработка токена ограничена по длине.

`revoke` синхронно исключает ключ, отзывает его id и прерывает дальнейшую выдачу,
если он был активен. Завершающиеся encode/validate повторно сверяют выбранный ключ
после await; исключённый ключ даёт JwtClaimError. Уже завершённые операции
не отменяются. Удалённые при replace id также нельзя вернуть в этот экземпляр;
для новых ключей используются новые id. При смене алгоритма новый id обязателен.
Приложение не должно заменять ключевой материал под прежним id: библиотека
не сравнивает скрытые приватные ключи пользовательских SigningAlgorithm.

`status()` без аргументов возвращает замороженные revision:number,
activeKeyId:string|undefined, keys:readonly {keyId,alg,canSign}[] и необязательный
замороженный legacy:{keyId,acceptUntil}. Секретов и PEM
в результате нет. `signingKey`, `verificationKey`, `assertCurrent` — внутренние
методы Encoder/Validator, не API авторизации приложения.
Некорректная конфигурация даёт TypeError; crypto/self-test/конфликт — ошибки
провайдера или Error. Unknown kid либо missing kid без действующего legacy — JwtClaimError, подмена alg —
JwtAlgorithmError. Никакой перебор всех ключей или получение jku/x5u/jwk из JWT
не выполняется. Неизвестные поля конфигурации не используются.

Legacy по умолчанию выключен. Если задан, только отсутствие kid выбирает один
указанный ключ до фиксированного acceptUntil; неизвестный или пустой kid не
использует fallback. Подпись, alg и все claims остаются обязательными по настройкам
валидатора. Срок/выбор повторно проверяются после crypto, clock skew к этому сроку
не прибавляется. Новые JWT получают activeKeyId. Исключение ключа или legacy из
снимка прекращает миграцию; revoke legacy-ключа также удаляет его legacy policy.

Состояние ring принадлежит процессу. Распространение набора и списка отзывов,
его безопасное хранение и восстановление после restart принадлежат host.
Обязательная последовательность rollout, TTL/clock skew и действия при
компрометации: [эксплуатационная инструкция](../../../../docs/audits/2026-09-14-jwt/OPERATIONS.md).

## 4. Настройки и публичные операции

### JwtValidator(algorithm, options?) и validate(token)

algorithm — SigningAlgorithm либо подготовленный JwtKeyRing, обязательная доверенная стратегия.
options — объект, по умолчанию {}; null и массив не допускаются. Известные поля
и массив audience копируются при создании, неизвестные поля не используются.

| Поле options | Тип | Обязательно | null / default | Проверка |
| --- | --- | --- | --- | --- |
| issuer | string | нет | нет / отсутствует | Непустая строка, точное сравнение iss |
| audience | string или readonly string[] | нет | нет / отсутствует | Непустые строки; непустой массив; совпадение хотя бы одной аудитории |
| expectedTokenUse | access или refresh | нет | нет / отсутствует | Точное сравнение token_use |
| clockSkewSeconds | number, секунды | нет | нет / 60 | Конечное число >= 0; без автоматического преобразования и верхней границы |
| requireExpiration | boolean | нет | нет / true | false отключает только обязательность exp |
| maxTokenLength | number, число ASCII-символов compact JWS | нет | нет / 16384 | Положительное safe integer; отказ до split/JSON/crypto |
| token | string, compact JWS | да, validate | нет / нет | Три непустых сегмента; base64url без пробелов, padding и неканонических pad bits |

Пример настроек: { issuer: "auth", audience: ["client"], expectedTokenUse: "access", clockSkewSeconds: 0 }.
Невалидные настройки отклоняются конструктором как TypeError/RangeError.

Header и payload должны декодироваться в JSON-объекты, не null/массивы.
Подпись проверяется до использования payload для claims. Неизвестные обычные
поля сохраняются; JSON.parse использует последнее значение дублирующегося ключа.
Неизвестные критические расширения и unencoded payload не поддерживаются.

| Поле токена | Runtime-тип / правило | Обязательность |
| --- | --- | --- |
| header.alg | string, совпадает с algorithm.alg | да |
| header.kid | string; совпадает с algorithm.keyId, если он задан | условная |
| header.typ / header.cty | string при наличии; не определяют права | нет |
| header.crit | неподдерживаемое расширение; наличие отвергается | не допускается |
| header.b64 | допускается только true; false/unencoded payload не поддерживается | нет |
| payload.exp | конечный NumericDate; now < exp + clockSkewSeconds | по умолчанию да |
| payload.nbf | конечный NumericDate; now + clockSkewSeconds >= nbf | нет |
| payload.iat | конечный NumericDate; проверяется тип, не возраст токена | нет |
| payload.iss / sub / jti | string при наличии; без приведения типов | iss обязателен при options.issuer |
| payload.aud | string или непустой массив строк; без приведения элементов | при options.audience |
| payload.token_use | точное expectedTokenUse, если он задан | условная |

Для присутствующих перечисленных полей null не допускается. NumericDate —
секунды Unix; дробные значения допустимы. Ограничений возраста по iat нет.
Неизвестные custom claims не интерпретируются; приложения валидируют свои поля.
Существующий JwtHeader описывает header, выпускаемый encoder (typ: JWT);
проверка входного typ не заменяет прикладной профиль JWT.

Результат validate: Promise<VerifiedToken> с исходными декодированными header/payload.
JwtMalformedError — формат/UTF-8/JOSE; JwtAlgorithmError — alg;
JwtSignatureError — неверная подпись; JwtClaimError — тип/значение claim или kid;
JwtExpiredError/JwtNotYetValidError — время. Криптографические операционные
отказы проходят как ошибки провайдера. HTTP-адаптер переводит JwtError в 401.

### TokenIssuer(config), issue(subject, claims?), verifyAccess, verifyRefresh, rotate

config — обязательный объект; известные поля фиксируются при создании.

| Поле | Тип | Обязательно | null / default | Проверки |
| --- | --- | --- | --- | --- |
| config.issuer / audience | string | да | нет / нет | Непустые строки, без trim |
| config.algorithm | SigningAlgorithm или JwtKeyRing | да | нет / нет | Стратегия с ключом подписи или подготовленный набор |
| config.refreshAlgorithm | SigningAlgorithm или JwtKeyRing | нет | нет / algorithm | Отдельная стратегия или набор refresh-ключей |
| config.accessTtlSeconds / refreshTtlSeconds | number, секунды | да | нет / нет | Конечные числа > 0; дробные допустимы |
| config.clockSkewSeconds | number, секунды | нет | нет / 60 | Как у JwtValidator |
| config.maxTokenLength | number | нет | нет / 16384 | Как у JwtValidator; также предел выдаваемого токена |
| subject | string | да, issue | нет / нет | Непустая строка; серверная идентичность задаётся вызывающим |
| claims | CustomClaims | нет | нет / отсутствует | Дополнительные поля access; встроенные sub/iss/aud/iat/exp/jti/token_use перекрывают одноимённые поля |
| token / refreshToken | string, compact JWS | да, verify/rotate | нет / нет | Общие правила validate плюс issuer/audience/token_use |

CustomClaims — существующий словарь значений string, number, boolean,
readonly string[] или null. Пользовательские зарегистрированные поля должны
соблюдать runtime-правила валидатора; encoder не является их отдельным валидатором.

issue/rotate возвращают Promise<TokenPair>: accessToken и refreshToken —
строки, tokenType — Bearer, expiresIn — accessTtlSeconds. verify возвращает
VerifiedToken. Ошибки токена принадлежат JwtError; ошибка настроек/ключей
не считается невалидной учётной записью. Отсутствующий subject при rotate
также даёт JwtClaimError.

Каждый выпуск создаёт новые jti. rotate не отзывает исходный refresh;
идемпотентность, reuse detection и транзакции хранилища принадлежат приложению.
Сигнатуры методов и TypeScript/DI-экспорты сохранены.

`JwtEncoder(algorithm, { maxTokenLength? })` имеет тот же предел. Превышение
при encode/issue даёт RangeError; превышение при validate/verify — JwtMalformedError.
**Изменение поведения:** ранее библиотека принимала токены без предела размера.
Потребитель токенов больше 16 KiB должен явно задать подходящий предел на обеих
сторонах. Сериализация доверенных claims происходит до проверки размера выпуска;
ограничение HTTP-body остаётся обязанностью транспорта.

### Helpers base64url

encode(Uint8Array)/encodeString(string) возвращают непаддированную base64url.
decode(string) возвращает Uint8Array; пустая строка допустима только у helper.
Невалидный алфавит, длина или pad bits дают ошибку формата. decodeToString
принимает только корректный UTF-8, сохраняя BOM как символ. JwtValidator
переводит ошибки этих helpers на своём недоверенном входе в JwtMalformedError.
timingSafeEqual остаётся совместимым экспортом; HMAC verify использует Web Crypto.

## 5. Проверки и границы

Текущий результат после подключения штатного Auth и bounded legacy migration:
[INTEGRATION.md](../../../../docs/audits/2026-09-14-jwt/INTEGRATION.md).
Числа ниже относятся к предыдущему снимку квалификации до этого подключения.

JWT, регрессии, HTTP-граница, config isolation/TTL и Admin access validation:
**103 PASS / 0 FAIL / 388 assertions**. Существующий Admin HTTP/PostgreSQL suite:
**8 PASS / 0 FAIL / 51 assertions**. Сценарий двух процессов с ключевой ротацией,
reuse, отзывом, restart, ошибками БД и нагрузкой: **1 PASS / 0 FAIL / 289 assertions**
как из TypeScript, так и на двух бинарниках. Самостоятельный JWT-бинарник
HS256/RS256 также запущен вне исходного каталога. Это Auth host, не полный AppModule/CLI.

Фаззинг: **100000 ожидаемых отказов + 3334 корректных контроля, 0 неожиданных
результатов**. Отдельный tsc затронутого графа и финальный полный tsc — PASS.
Нагрузка c1/16/64 и soak HS256 120 s с 23 ротациями — PASS по заранее заданным
локальным инженерным порогам, без объявления production SLA. Пиковый рост RSS
после прогрева — 5.75 MiB; отсутствие всех утечек этим не доказывается.

Доказательства, команды, SHA-256 и границы:
[квалификация](../../../../docs/audits/2026-09-14-jwt/QUALIFICATION.md).
История первоначальных шести исправлений и 30 audit-проб:
[FIXES.md](../../../../docs/audits/2026-09-14-jwt/FIXES.md).
Независимое внешнее заключение, production rollout ключей и SLO отсутствуют.
DI-конструкторы не менялись, результаты codegen вручную не редактировались.

## 6. Источники

- [Первичный аудит JWT](../../../../docs/audits/2026-09-14-jwt/REPORT.md).
- [Архитектура модулей](../../../../docs/architecture/MODULE_ARCHITECTURE.md).
- [RFC 7519](https://www.rfc-editor.org/rfc/rfc7519.html).
- [RFC 7515](https://www.rfc-editor.org/rfc/rfc7515.html).
- [RFC 7518](https://www.rfc-editor.org/rfc/rfc7518.html).
