/** Базовая ошибка модуля кэша. */
export class CacheError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Некорректный ключ кэша (тип, длина, запрещённое имя). */
export class CacheKeyError extends CacheError {}

/** Некорректное значение (превышен лимит размера и т.п.). */
export class CacheValueError extends CacheError {}

/** Лимит незавершённых factory исчерпан; новая factory не запускалась. */
export class CacheCapacityError extends CacheError {}
