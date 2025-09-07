export type TaskStatus = "open" | "done" | "cancelled";

export type Task = {
  id: string;
  createdAt: string;
  branch: string;
  title: string;
  description?: string;
  status: TaskStatus;
  primaryDir: string;
  workDirs: string[];
  tags?: string[];
  checklist?: string[];
  relatedPRs?: string[];
  assignees?: string[];
};
