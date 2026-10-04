import { registerRequestModelClass, type RequestModelClass } from "./requestModelRegistry";

/**
 * Помечает класс как request-модель (DTO), адресуемую по имени.
 *
 * Совместимость для DTO вне сканируемых исходников и старого runtime-реестра.
 * Штатный codegen регистрирует DTO из сигнатур автоматически:
 *
 * ```ts
 * @RequestModel()
 * class CreateUserDto {
 *   @Validator({ required: true, minLength: 3 })
 *   name!: string;
 * }
 *
 * // В контроллере достаточно типа параметра:
 * @Post()
 * create(dto: CreateUserDto) { ... }
 * ```
 *
 * Для DTO в исходниках приложения декоратор не требуется.
 */
export function RequestModel() {
  return (value: RequestModelClass, _context: ClassDecoratorContext): void => {
    registerRequestModelClass(value);
  };
}
