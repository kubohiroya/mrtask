export type TaskStatus = "open" | "done" | "cancelled";

export type GuardsLevel = 'ignore' | 'warn' | 'error';
export type TaskMode = 'isolated' | 'shared';

export type Task = {
  id: string;
  createdAt: string;
  branch: string;
  title: string;
  description?: string;
  status: TaskStatus;
  primaryDir: string;
  workDirs: string[];
  // New structured guards (preferred)
  guards?: { level: GuardsLevel };
  // Back-compat: old tri-state flag (not written anymore)
  strict?: boolean;
  // Task style (full worktree vs shared on an existing worktree)
  mode?: TaskMode;
  // Optional parent task linkage for shared tasks
  parentId?: string;
  tags?: string[];
  checklist?: string[];
  relatedPRs?: string[];
  assignees?: string[];
};
