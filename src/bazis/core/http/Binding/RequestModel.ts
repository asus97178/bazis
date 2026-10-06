import { registerRequestModelClass, type RequestModelClass } from "./requestModelRegistry";

/**
 * Marks a class as a request model (DTO) addressable by name.
 *
 * Needed only for DTOs declared outside the scanned sources (for example in
 * another package). Codegen registers all other DTOs from method signatures:
 *
 * ```ts
 * @RequestModel()
 * class CreateUserDto {
 *   @Validator({ required: true, minLength: 3 })
 *   name!: string;
 * }
 *
 * // In the controller the parameter type is enough:
 * @Post()
 * create(dto: CreateUserDto) { ... }
 * ```
 *
 * DTOs in the application sources do not need the decorator.
 */
export function RequestModel() {
  return (value: RequestModelClass, _context: ClassDecoratorContext): void => {
    registerRequestModelClass(value);
  };
}
