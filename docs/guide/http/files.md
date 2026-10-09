# Файлы и загрузка

Как принять файл от клиента, ограничить размер, сохранить и отдать обратно.
Отдельного механизма для файлов в bazis нет — используются стандартные
`FormData`, `File` и `Bun.file`, а фреймворк добавляет пределы размера и
проверку типа содержимого.

Все примеры проверены на bazis 0.98.3.

## Загрузка

```ts
import { BadRequestError, Controller, HttpContext, Post } from "bazis/core/http";
import path from "node:path";

const UPLOADS = path.resolve("uploads");

@Controller("files")
export class FilesController {
  @Post("avatar", { maxBodySize: "5mb", consumes: "multipart/form-data" })
  async avatar(ctx: HttpContext) {
    const file = (await ctx.formData()).get("file");
    if (!(file instanceof File)) throw new BadRequestError('field "file" with a file is required');
    if (!["image/png", "image/jpeg"].includes(file.type)) throw new BadRequestError(`unsupported type ${file.type}`);

    const name = `${crypto.randomUUID()}${file.type === "image/png" ? ".png" : ".jpg"}`;
    await Bun.write(path.join(UPLOADS, name), file);
    return { name, size: file.size, type: file.type, original: file.name };
  }
}
```

```text
curl -F 'file=@photo.png;type=image/png' http://127.0.0.1:3000/files/avatar
→ 200 {"name":"321fc2d7-….png","size":2000,"type":"image/png","original":"photo.png"}
```

| Запрос | Ответ |
| --- | --- |
| Файл другого типа | `400 unsupported type text/plain;charset=utf-8` — проверка из примера |
| Форма без поля `file` | `400 field "file" with a file is required` |
| Файл больше 5 МБ | `413 {"error":"Payload Too Large","details":{"maxBytes":…}}` |
| JSON вместо формы | `415 Unsupported Media Type: expected multipart/form-data` |

Несколько файлов в одном поле — `getAll`:

```ts
const files = (await ctx.formData()).getAll("files").filter((item) => item instanceof File);
```

> [!WARNING]
> В модуле, где импортирован помощник ответа `File` из `bazis/core/http`,
> имя `File` занято им — `instanceof File` и тип загруженного файла
> перестают работать. В контроллерах загрузки помощник не импортируйте:
> файлы отдавайте через `Bun.file(path)` (см. ниже) или импортируйте
> помощник под другим именем — `import { File as FileResponse }`.

### Имя файла на диске

Не используйте присланное имя как путь: клиент может прислать
`../../package.json`. Генерируйте своё имя (`crypto.randomUUID()`), а
исходное храните отдельно — в базе или в ответе, как `original` в примере.

### Тип файла

`file.type` — то, что заявил клиент, а не проверенный факт. Для картинок
и документов, которые потом кто-то откроет, проверяйте содержимое
(«магические» первые байты) или прогоняйте файл через обработку —
например, перекодирование изображения.

## Предел размера

| Где | По умолчанию | Как изменить |
| --- | --- | --- |
| Всё приложение | 1 МиБ | `runApp(AppModule, { http: { maxBodyBytes: 10 * 1024 * 1024 } })`; `0` — без предела |
| Один маршрут | Как у приложения | `@Post("avatar", { maxBodySize: "5mb" })` — `b`, `kb`, `mb`, `gb` |

Если клиент заранее сообщил размер (`Content-Length`) и он больше предела,
запрос отклоняется с `413` до чтения тела. Без заявленного размера тело
читается до предела и обрывается на нём — тоже с `413`.

Предел действует для `ctx.formData()`, `ctx.text()`, `ctx.json()` и
моделей тела. Если читать `ctx.request.body` напрямую, предел за вас не
соблюдается — читайте тело через `ctx`.

## `consumes`

`consumes` в декораторе маршрута — обязательный `Content-Type` запроса.
Запрос с другим типом получает `415` ещё до вызова метода, как бы метод
ни читал тело. `GET`, `HEAD` и `OPTIONS` не проверяются.

> [!NOTE]
> Для маршрутов, которые читают тело через `ctx`, `consumes` работает с
> версии 0.98.3. Раньше он проверялся только у маршрутов с моделью тела.

## Отдать файл

```ts
@Get("report")
report() {
  return Bun.file(path.join(UPLOADS, "report.txt"));
}
```

Тип содержимого Bun определяет по расширению, файл отдаётся потоком,
запросы диапазонов (`Range: bytes=0-4` → `206`) работают сами. То же
делает помощник `File(path)` из `bazis/core/http`.

### Скачать с именем

Чтобы браузер сохранил файл, а не открыл, добавьте `Content-Disposition`
через `ResponseBuilder`:

```ts
@Get("download")
download(res: ResponseBuilder) {
  res.header("content-disposition", 'attachment; filename="report.txt"');
  return Bun.file(path.join(UPLOADS, "report.txt"));
}
```

### Файла нет

Если файла по пути нет, ответ — `500`: для сервера это ошибка, а не
«нет ресурса». Когда путь зависит от запроса, проверьте существование
сами и верните `404`:

```ts
@Get(":name")
async getByName(name: string) {
  const target = path.join(UPLOADS, path.basename(name));   // basename — отсекает ../
  if (!(await Bun.file(target).exists())) throw new NotFoundError(`file ${name} not found`);
  return Bun.file(target);
}
```

```text
GET /files/..%2F..%2Fpackage.json → 404 file ../../package.json not found
GET /files/report.txt            → 200
```

## Дальше

- [Ответы](../overview/responses.md)
- [Маршрутизация и привязка параметров](routing.md)
- [Версионирование API](versioning.md)
