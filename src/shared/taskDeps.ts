/**
 * Dependency resolution and validation for Camp tasks.
 *
 * Rules:
 * - A card whose dependsOn contains any card not done must not wake or start its assignee.
 * - Refuses dependency IDs that do not exist in tasks.json.
 * - Refuses circular dependencies (direct self-dependency, 2-node cycles, and multi-node cycles).
 * - Refuses workers/boss moving a task to 'doing' while its dependencies are not 'done'.
 * - Dynamic eligibility: when all dependencies reach 'done', the task automatically
 *   becomes eligible to wake and dispatch without requiring disk mutations.
 */

export interface TaskLike {
  id?: string;
  status?: string;
  assignee?: string;
  dependsOn?: string[];
}

export interface DependencyValidation {
  valid: boolean;
  reason?: string;
}

export interface StartCheckResult {
  ok: boolean;
  reason?: string;
  unmet?: string[];
}

/**
 * Validate that:
 * 1. All dependency IDs exist in `allTasks`.
 * 2. The task does not depend on itself.
 * 3. Adding `dependsOn` to `taskId` does not introduce a cycle.
 */
export function validateDependencies(
  taskId: string | undefined,
  dependsOn: readonly string[] | undefined,
  allTasks: readonly TaskLike[]
): DependencyValidation {
  if (!dependsOn || !Array.isArray(dependsOn) || dependsOn.length === 0) {
    return { valid: true };
  }

  // 1. Check self-dependency
  if (taskId && dependsOn.includes(taskId)) {
    return { valid: false, reason: `Task '${taskId}' cannot depend on itself` };
  }

  // 2. Check all dependency IDs exist in allTasks
  const existingIds = new Set<string>();
  for (const t of allTasks) {
    if (t && typeof t.id === 'string') {
      existingIds.add(t.id);
    }
  }

  for (const depId of dependsOn) {
    if (!existingIds.has(depId)) {
      return { valid: false, reason: `Dependency task '${depId}' does not exist` };
    }
  }

  // 3. Cycle detection
  // Build adjacency list: node -> array of dependency IDs
  const adj = new Map<string, string[]>();
  for (const t of allTasks) {
    if (t && typeof t.id === 'string') {
      adj.set(t.id, Array.isArray(t.dependsOn) ? [...t.dependsOn] : []);
    }
  }

  if (taskId) {
    adj.set(taskId, [...dependsOn]);
  }

  const visited = new Set<string>();
  const recStack = new Set<string>();

  function hasCycle(node: string): boolean {
    visited.add(node);
    recStack.add(node);

    const neighbors = adj.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (hasCycle(neighbor)) return true;
      } else if (recStack.has(neighbor)) {
        return true;
      }
    }

    recStack.delete(node);
    return false;
  }

  if (taskId) {
    if (hasCycle(taskId)) {
      return { valid: false, reason: `Circular dependency detected: cycle involving ${taskId}` };
    }
  } else {
    for (const depId of dependsOn) {
      if (!visited.has(depId)) {
        if (hasCycle(depId)) {
          return { valid: false, reason: `Circular dependency detected: cycle involving ${depId}` };
        }
      }
    }
  }

  return { valid: true };
}

/**
 * Returns true if the task has any dependency in dependsOn that is not 'done'.
 */
export function isBlockedByDeps(
  task: TaskLike,
  allTasks: readonly TaskLike[]
): boolean {
  return getUnmetDependencies(task, allTasks).length > 0;
}

/**
 * Returns the list of dependency IDs that are not 'done' (either non-done or missing).
 */
export function getUnmetDependencies(
  task: TaskLike,
  allTasks: readonly TaskLike[]
): string[] {
  if (!task || !Array.isArray(task.dependsOn) || task.dependsOn.length === 0) {
    return [];
  }

  const taskMap = new Map<string, TaskLike>();
  for (const t of allTasks) {
    if (t && typeof t.id === 'string') {
      taskMap.set(t.id, t);
    }
  }

  const unmet: string[] = [];
  for (const depId of task.dependsOn) {
    const depTask = taskMap.get(depId);
    if (!depTask || depTask.status !== 'done') {
      unmet.push(depId);
    }
  }

  return unmet;
}

/**
 * Checks whether a task is permitted to start (move to 'doing').
 * Returns { ok: false, reason: ... } if any dependency is not 'done'.
 */
export function canStartTask(
  task: TaskLike,
  allTasks: readonly TaskLike[]
): StartCheckResult {
  const unmet = getUnmetDependencies(task, allTasks);
  if (unmet.length > 0) {
    const idStr = task && task.id ? ` '${task.id}'` : '';
    return {
      ok: false,
      reason: `Cannot start task${idStr}: dependencies are not done (${unmet.join(', ')})`,
      unmet
    };
  }
  return { ok: true };
}

/**
 * Cycle-safe transitive lookup of all tasks waiting on `taskId`.
 */
export function findDependents(
  taskId: string,
  allTasks: readonly TaskLike[],
  seen?: Set<string>
): TaskLike[] {
  const visited = seen ?? new Set<string>();
  visited.add(taskId);
  const result: TaskLike[] = [];

  for (const t of allTasks) {
    if (t && typeof t.id === 'string' && !visited.has(t.id) && Array.isArray(t.dependsOn) && t.dependsOn.includes(taskId)) {
      visited.add(t.id);
      result.push(t);
      const downstream = findDependents(t.id, allTasks, visited);
      for (const d of downstream) {
        if (!result.includes(d)) {
          result.push(d);
        }
      }
    }
  }

  return result;
}
