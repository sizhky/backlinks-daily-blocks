import { execFile } from "node:child_process";

const OBSIDIAN = "/Applications/Obsidian.app/Contents/MacOS/obsidian";

export type Task = {
  ref: string;
  file: string;
  line: number;
  body: string;
  age: string;
};

function execute(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function evaluate(code: string): Promise<string> {
  return execute(OBSIDIAN, ["eval", `code=${code}`]);
}

export async function isObsidianRunning(): Promise<boolean> {
  try {
    await execute("/usr/bin/pgrep", ["-x", "Obsidian"]);
    return true;
  } catch {
    return false;
  }
}

export function parseTasks(output: string): Task[] {
  const result = output.includes("=>") ? output.slice(output.indexOf("=>") + 2) : output;
  return result
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [, ref, body, age] = row.split("\t");
      const separator = ref.lastIndexOf(":");
      return {
        ref,
        file: ref.slice(0, separator),
        line: Number(ref.slice(separator + 1)),
        body: body.replace(/\s+#kb\/[^\s]+/gi, "").trim(),
        age,
      };
    })
    .filter((task) => task.file && Number.isInteger(task.line));
}

export async function fetchDoingTasks(): Promise<Task[]> {
  const output = await evaluate('kb.active({col:"Doing"})');
  return parseTasks(output);
}

export async function moveTask(task: Task, column: "Doing" | "Done"): Promise<void> {
  const code = `kb.moveTask(${JSON.stringify(task.file)},${task.line},${JSON.stringify(column)})`;
  await evaluate(code);
}
