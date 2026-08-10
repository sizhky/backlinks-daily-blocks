import { Cache, Icon, MenuBarExtra, showToast, Toast } from "@raycast/api";
import { useCallback, useEffect, useState } from "react";
import { fetchDoingTasks, isObsidianRunning, moveTask, Task } from "./tasks";

const cache = new Cache();
const CACHE_KEY = "doing-tasks";

function readCache(): Task[] {
  try {
    return JSON.parse(cache.get(CACHE_KEY) ?? "[]") as Task[];
  } catch {
    return [];
  }
}

function writeCache(tasks: Task[]): void {
  cache.set(CACHE_KEY, JSON.stringify(tasks));
}

export default function Command() {
  const [tasks, setTasks] = useState<Task[]>(readCache);
  const [isLoading, setIsLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    const running = await isObsidianRunning();
    setIsOffline(!running);
    if (running) {
      try {
        const freshTasks = await fetchDoingTasks();
        setTasks(freshTasks);
        writeCache(freshTasks);
      } catch {
        setIsOffline(true);
      }
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function complete(task: Task) {
    const remaining = tasks.filter((candidate) => candidate.ref !== task.ref);
    try {
      await moveTask(task, "Done");
      setTasks(remaining);
      writeCache(remaining);
      await showToast({
        style: Toast.Style.Success,
        title: "Moved to Done",
        message: task.body,
        primaryAction: {
          title: "Undo",
          onAction: async () => {
            await moveTask(task, "Doing");
            const restored = [...remaining, task];
            setTasks(restored);
            writeCache(restored);
          },
        },
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not move task",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <MenuBarExtra
      icon={Icon.CheckCircle}
      title={`Doing: ${tasks.length}`}
      tooltip="Obsidian Doing tasks"
      isLoading={isLoading}
    >
      {isOffline ? <MenuBarExtra.Item title="Obsidian closed · showing saved tasks" /> : null}
      {tasks.length === 0 ? <MenuBarExtra.Item title="No tasks in Doing" /> : null}
      {tasks.map((task) => (
        <MenuBarExtra.Item
          key={task.ref}
          icon={Icon.Circle}
          title={task.body}
          subtitle={`${task.age} · ${task.file}`}
          onAction={() => complete(task)}
        />
      ))}
      <MenuBarExtra.Separator />
      <MenuBarExtra.Item icon={Icon.ArrowClockwise} title="Refresh" onAction={refresh} />
    </MenuBarExtra>
  );
}
