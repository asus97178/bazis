import type { Task } from "../../model/Task.model";

export interface TaskResponse {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly done: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toTaskResponse(entity: Task): TaskResponse {
  return {
    id: entity.id,
    projectId: entity.projectId,
    title: entity.title,
    done: entity.done,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}
