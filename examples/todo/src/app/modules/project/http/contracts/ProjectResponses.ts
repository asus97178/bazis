import type { Project } from "../../model/Project.model";

export interface ProjectResponse {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toProjectResponse(entity: Project): ProjectResponse {
  return {
    id: entity.id,
    name: entity.name,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}
