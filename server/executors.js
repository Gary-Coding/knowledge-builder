import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_DETECT_TIMEOUT_MS = 5_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 120 * 60_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

export const EXECUTOR_DEFINITIONS = Object.freeze({
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    command: "codex",
    versionArgs: Object.freeze(["--version"]),
    authArgs: Object.freeze(["login", "status"]),
    executionArgs: Object.freeze([
      "exec",
      "--json",
      "--sandbox", "workspace-write",
      "--ephemeral",
      "--skip-git-repo-check",
      "-",
    ]),
  }),
  claude: Object.freeze({
    id: "claude",
    label: "Claude Code",
    command: "claude",
    versionArgs: Object.freeze(["--version"]),
    authArgs: Object.freeze(["auth", "status"]),
    executionArgs: Object.freeze([
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--safe-mode",
      "--no-session-persistence",
      "--permission-mode", "dontAsk",
      "--allowedTools", "Read,Write,Edit,Glob,Grep",
    ]),
  }),
});

export class ExecutorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutorError";
    this.code = code;
  }
}

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function assertRunDirectory(runRoot, runDir) {
  const [resolvedRoot, resolvedRunDir] = await Promise.all([
    fs.realpath(path.resolve(runRoot)),
    fs.realpath(path.resolve(runDir)),
  ]);
  if (!isInside(resolvedRoot, resolvedRunDir)) {
    throw new ExecutorError("RUN_PATH_OUTSIDE_ROOT", "执行目录不在允许的运行目录内");
  }
  const stat = await fs.stat(resolvedRunDir);
  if (!stat.isDirectory()) {
    throw new ExecutorError("RUN_PATH_NOT_DIRECTORY", "执行路径不是目录");
  }
  return resolvedRunDir;
}

export async function resolveExecutable(command, options = {}) {
  const env = options.env || process.env;
  const pathValue = env.PATH || "";
  const candidates = path.isAbsolute(command)
    ? [command]
    : pathValue.split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, command));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, 1);
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return await fs.realpath(candidate);
    } catch {
      // Continue searching PATH without exposing local filesystem details.
    }
  }
  return null;
}

function runProbe(executable, args, options = {}) {
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const timeoutMs = options.timeoutMs || DEFAULT_DETECT_TIMEOUT_MS;
  const env = options.env || process.env;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawnImpl(executable, args, {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const append = (current, chunk) => `${current}${chunk}`.slice(0, 16_384);
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", () => finish({ ok: false, reason: "launch_failed" }));
    child.on("close", (code) => finish({
      ok: code === 0,
      reason: code === 0 ? null : "command_failed",
      stdout,
      stderr,
    }));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);
  });
}

function sanitizedVersion(output) {
  return String(output || "").split(/\r?\n/, 1)[0].trim().slice(0, 200) || null;
}

export async function detectExecutor(id, options = {}) {
  const definition = EXECUTOR_DEFINITIONS[id];
  if (!definition) throw new ExecutorError("UNKNOWN_EXECUTOR", `不支持的执行器：${id}`);
  const executable = options.executable || await resolveExecutable(definition.command, options);
  const base = { id, label: definition.label, installed: false, ready: false, version: null, authenticated: false };
  if (!executable) return { ...base, reason: "not_installed" };

  const probeOptions = { ...options, cwd: options.cwd || process.cwd() };
  const versionResult = await runProbe(executable, definition.versionArgs, probeOptions);
  if (!versionResult.ok) return { ...base, installed: true, reason: "version_check_failed" };
  const version = sanitizedVersion(versionResult.stdout || versionResult.stderr);
  const authResult = await runProbe(executable, definition.authArgs, probeOptions);
  if (!authResult.ok) {
    return { ...base, installed: true, version, reason: "not_authenticated" };
  }
  return { ...base, installed: true, ready: true, version, authenticated: true, reason: null };
}

export async function detectExecutors(options = {}) {
  return Promise.all(Object.keys(EXECUTOR_DEFINITIONS).map((id) => detectExecutor(id, options)));
}

export function createExecutionManager(options = {}) {
  if (!options.runRoot) throw new ExecutorError("RUN_ROOT_REQUIRED", "必须配置运行目录根路径");
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const timeoutMs = options.timeoutMs || DEFAULT_EXECUTION_TIMEOUT_MS;
  const outputLimitBytes = options.outputLimitBytes || DEFAULT_OUTPUT_LIMIT_BYTES;
  const executableOverrides = options.executables || {};
  let activeJob = null;

  async function start({ executorId, runDir, prompt, onEvent = () => {}, env = process.env }) {
    if (activeJob) throw new ExecutorError("EXECUTION_BUSY", "已有 AI 任务正在执行");
    const definition = EXECUTOR_DEFINITIONS[executorId];
    if (!definition) throw new ExecutorError("UNKNOWN_EXECUTOR", `不支持的执行器：${executorId}`);
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new ExecutorError("PROMPT_REQUIRED", "提示词不能为空");
    }

    const cwd = await assertRunDirectory(options.runRoot, runDir);
    const executable = executableOverrides[executorId]
      || await resolveExecutable(definition.command, { env });
    if (!executable) throw new ExecutorError("EXECUTOR_NOT_INSTALLED", `${definition.label} 未安装`);

    const executionId = crypto.randomUUID();
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let forceKillTimer;
    const child = spawnImpl(executable, definition.executionArgs, {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const safeEvent = (event) => {
      try {
        onEvent(event);
      } catch {
        // A UI/log callback must not terminate the managed child process.
      }
    };
    const emitChunk = (stream, chunk) => {
      const buffer = Buffer.from(chunk);
      const remaining = Math.max(0, outputLimitBytes - outputBytes);
      if (remaining > 0) {
        const visible = buffer.subarray(0, remaining);
        outputBytes += visible.length;
        safeEvent({ type: stream, executionId, data: visible.toString("utf8") });
      }
      if (buffer.length > remaining && !outputTruncated) {
        outputTruncated = true;
        safeEvent({ type: "output_limit", executionId });
      }
    };
    child.stdout?.on("data", (chunk) => emitChunk("stdout", chunk));
    child.stderr?.on("data", (chunk) => emitChunk("stderr", chunk));

    const completion = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(jobTimer);
        clearTimeout(forceKillTimer);
        activeJob = null;
        if (error) reject(error);
        else resolve(result);
      };
      child.on("error", () => finish(new ExecutorError("EXECUTION_LAUNCH_FAILED", "无法启动 AI 执行器")));
      child.on("close", (code, signal) => {
        const result = { executionId, executorId, code, signal, outputBytes, outputTruncated };
        if (timedOut) finish(new ExecutorError("EXECUTION_TIMEOUT", "AI 执行超时"));
        else if (cancelled) finish(new ExecutorError("EXECUTION_CANCELLED", "AI 执行已取消"));
        else if (code !== 0) finish(new ExecutorError("EXECUTION_FAILED", `AI 执行失败，退出码：${code ?? "unknown"}`));
        else finish(null, result);
      });
      const jobTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      }, timeoutMs);
    });
    completion.catch(() => {});

    activeJob = {
      executionId,
      child,
      completion,
      markCancelled() { cancelled = true; },
    };
    safeEvent({ type: "started", executionId, executorId });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    return { executionId, completion };
  }

  function cancel(executionId) {
    if (!activeJob || activeJob.executionId !== executionId) return false;
    activeJob.markCancelled();
    activeJob.child.kill("SIGTERM");
    return true;
  }

  function getActiveExecution() {
    if (!activeJob) return null;
    return { executionId: activeJob.executionId };
  }

  return { start, cancel, getActiveExecution };
}

const executionRecords = new Map();
let activeFacade = null;
let facadeStarting = false;

function publicRecord(record) {
  if (!record) return null;
  const { manager, completion, ...visible } = record;
  return { ...visible };
}

function remember(record) {
  executionRecords.set(record.executionId, record);
  while (executionRecords.size > 100) {
    const oldest = executionRecords.keys().next().value;
    executionRecords.delete(oldest);
  }
}

export async function startExecution({
  executor,
  runDir,
  runRootDir,
  promptPath,
  onEvent = () => {},
  env = process.env,
}) {
  if (!runRootDir) throw new ExecutorError("RUN_ROOT_REQUIRED", "必须配置运行目录根路径");
  if (!promptPath) throw new ExecutorError("PROMPT_PATH_REQUIRED", "必须提供提示词文件路径");
  if (activeFacade || facadeStarting) {
    throw new ExecutorError("EXECUTION_BUSY", "已有 AI 任务正在执行");
  }
  facadeStarting = true;
  try {
    const resolvedRunDir = await assertRunDirectory(runRootDir, runDir);
    const resolvedPromptPath = await fs.realpath(path.resolve(promptPath));
    if (!isInside(resolvedRunDir, resolvedPromptPath)) {
      throw new ExecutorError("PROMPT_PATH_OUTSIDE_RUN", "提示词文件不在当前运行目录内");
    }
    const prompt = await fs.readFile(resolvedPromptPath, "utf8");
    const manager = createExecutionManager({ runRoot: runRootDir });
    const startedAt = new Date().toISOString();
    const execution = await manager.start({
      executorId: executor,
      runDir: resolvedRunDir,
      prompt,
      env,
      onEvent,
    });
    const record = {
      executionId: execution.executionId,
      executor,
      runDir: resolvedRunDir,
      status: "running",
      startedAt,
      finishedAt: null,
      errorCode: null,
      manager,
      completion: execution.completion,
    };
    remember(record);
    activeFacade = record;
    execution.completion.then(
      (result) => {
        record.status = "completed";
        record.result = result;
        record.finishedAt = new Date().toISOString();
        if (activeFacade === record) activeFacade = null;
      },
      (error) => {
        record.status = error.code === "EXECUTION_CANCELLED" ? "cancelled" : "failed";
        record.errorCode = error.code || "EXECUTION_FAILED";
        record.finishedAt = new Date().toISOString();
        if (activeFacade === record) activeFacade = null;
      },
    );
    return { executionId: execution.executionId, completion: execution.completion };
  } finally {
    facadeStarting = false;
  }
}

export function cancelExecution(executionId) {
  const record = executionRecords.get(executionId);
  if (!record || record.status !== "running") return false;
  return record.manager.cancel(executionId);
}

export function getExecution(executionId) {
  return publicRecord(executionRecords.get(executionId));
}

export function listExecutions() {
  return [...executionRecords.values()].reverse().map(publicRecord);
}
