# `bazis/library/terminal`

Экраны CLI bazis: логотип, шаги, баннеры, рамки ошибок, язык вывода. На
нём построены `bazis dev`, `test`, `build` и экран запуска; подойдёт и для
своих скриптов в том же стиле. Список — по пакету 0.114.0.

| Экспорт | Что это |
| --- | --- |
| `Screen` | Экран: шапка с логотипом, разделы, шаги со спиннером, баннеры успеха и провала, панели, рамки проблем |
| `detectTerminal`, `Paint`, `PALETTE`, `PLAIN` | Есть ли цвет (`NO_COLOR`, `FORCE_COLOR`), раскраска, палитра bazis |
| `MODE` | Значки режима в логотипе |
| `resolveLanguage`, `detectLanguage`, `parseLanguage`, `projectLanguage`, `systemLanguage`, `LANGUAGES` | Язык вывода: `--lang`, `BAZIS_LANG`, `bazis.config.json`, язык системы |
| `messages(language)`, `count(messages, value, noun)` | Тексты CLI на языке; число с правильной формой слова: «3 файла» |
| `formatBytes`, `formatDuration` | `48 MB`, `1.2 s` |
| `widthOf`, `padStart`, `padEnd`, `plain` | Ширина в колонках, выравнивание, текст без escape-кодов |
| `colorAt(stops, t)` | Цвет на градиенте |

Типы: `Language`, `LanguageSources`, `Messages`, `Noun`, `Problem`,
`CodeFrame`, `ScreenOutput`, `Status`, `TerminalStyle`, `TreeRow`.

Как выглядят экраны — в главе [Команды CLI](../../cli/commands.md#вывод).
