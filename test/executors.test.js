import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createExecutionManager,
  detectExecutor,
  detectExecutors,
  ExecutorError,
  getExecution,
  listExecutions,
  resolveExecutable,
  startExecution,
} from "../server/executors.js";

async function createFakeExecutor(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-builder-executor-"));
  const executable = path.join(root, "fake-ai");
  const runRoot = path.join(root, "runs");
  const runDir = path.join(runRoot, "domain-one");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(executable, `#!/bin/sh
case "$1" in
  --version) echo "fake-ai 1.2.3" ;;
  login|auth) [ "$FAKE_AUTH" = "yes" ] ;;
  exec|--print)
    if [ "$FAKE_MODE" = "wait" ]; then
      trap 'exit 143' TERM
      while :; do sleep 1; done
    elif [ "$FAKE_MODE" = "large" ]; then
      printf '1234567890'
    else
      printf 'args:'
      printf '%s|' "$@"
      printf '\\nprompt:'
      cat
      printf '\\ncwd:%s' "$PWD"
    fi
    ;;
  *) exit 2 ;;
esac
`);
  await fs.chmod(executable, 0o755);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, executable, runRoot, runDir };
}

test("执行器检测只返回清理后的就绪信息", async (t) => {
  const fixture = await createFakeExecutor(t);
  const ready = await detectExecutor("codex", {
    executable: fixture.executable,
    env: { ...process.env, FAKE_AUTH: "yes" },
  });
  assert.deepEqual(ready, {
    id: "codex",
    label: "Codex",
    installed: true,
    ready: true,
    version: "fake-ai 1.2.3",
    authenticated: true,
    reason: null,
  });

  const unavailable = await detectExecutors({ env: { PATH: "" } });
  assert.deepEqual(unavailable.map(({ id, reason }) => ({ id, reason })), [
    { id: "codex", reason: "not_installed" },
    { id: "claude", reason: "not_installed" },
  ]);
  assert.equal(await resolveExecutable("missing-command", { env: { PATH: fixture.root } }), null);
});

test("执行使用固定参数、stdin 和受限 cwd，并流式返回结果", async (t) => {
  const fixture = await createFakeExecutor(t);
  const events = [];
  const manager = createExecutionManager({
    runRoot: fixture.runRoot,
    executables: { codex: fixture.executable },
  });
  const execution = await manager.start({
    executorId: "codex",
    runDir: fixture.runDir,
    prompt: "private prompt",
    onEvent: (event) => events.push(event),
  });
  const result = await execution.completion;
  const realRunDir = await fs.realpath(fixture.runDir);
  const output = events.filter((event) => event.type === "stdout").map((event) => event.data).join("");

  assert.equal(result.code, 0);
  assert.match(output, /args:exec\|--json\|--sandbox\|workspace-write\|--ephemeral\|--skip-git-repo-check\|-\|/);
  assert.match(output, /prompt:private prompt/);
  assert.match(output, new RegExp(`cwd:${realRunDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(output, /dangerously|bypass|permission/i);
  assert.equal(manager.getActiveExecution(), null);
});

test("Claude 使用安全模式和最小文件工具白名单", async (t) => {
  const fixture = await createFakeExecutor(t);
  const events = [];
  const manager = createExecutionManager({
    runRoot: fixture.runRoot,
    executables: { claude: fixture.executable },
  });
  const execution = await manager.start({
    executorId: "claude",
    runDir: fixture.runDir,
    prompt: "test",
    onEvent: (event) => events.push(event),
  });
  await execution.completion;
  const output = events.filter((event) => event.type === "stdout").map((event) => event.data).join("");
  assert.match(output, /--safe-mode\|/);
  assert.match(output, /--no-session-persistence\|/);
  assert.match(output, /--permission-mode\|dontAsk\|/);
  assert.match(output, /--allowedTools\|Read,Write,Edit,Glob,Grep\|/);
  assert.doesNotMatch(output, /dangerously|bypassPermissions/);
  assert.doesNotMatch(output, /Bash/);
});

test("执行器拒绝越界路径和并发任务，并支持取消", async (t) => {
  const fixture = await createFakeExecutor(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-builder-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const manager = createExecutionManager({
    runRoot: fixture.runRoot,
    executables: { claude: fixture.executable },
    timeoutMs: 10_000,
  });

  await assert.rejects(
    manager.start({ executorId: "claude", runDir: outside, prompt: "test" }),
    (error) => error instanceof ExecutorError && error.code === "RUN_PATH_OUTSIDE_ROOT",
  );

  const running = await manager.start({
    executorId: "claude",
    runDir: fixture.runDir,
    prompt: "test",
    env: { ...process.env, FAKE_MODE: "wait" },
  });
  await assert.rejects(
    manager.start({ executorId: "claude", runDir: fixture.runDir, prompt: "second" }),
    (error) => error.code === "EXECUTION_BUSY",
  );
  assert.equal(manager.cancel(running.executionId), true);
  await assert.rejects(running.completion, (error) => error.code === "EXECUTION_CANCELLED");
});

test("执行日志受大小限制，超时任务会被终止", async (t) => {
  const fixture = await createFakeExecutor(t);
  const events = [];
  const cappedManager = createExecutionManager({
    runRoot: fixture.runRoot,
    executables: { codex: fixture.executable },
    outputLimitBytes: 5,
  });
  const capped = await cappedManager.start({
    executorId: "codex",
    runDir: fixture.runDir,
    prompt: "test",
    env: { ...process.env, FAKE_MODE: "large" },
    onEvent: (event) => events.push(event),
  });
  const cappedResult = await capped.completion;
  assert.equal(cappedResult.outputBytes, 5);
  assert.equal(cappedResult.outputTruncated, true);
  assert.equal(events.filter((event) => event.type === "stdout").map((event) => event.data).join(""), "12345");
  assert.equal(events.filter((event) => event.type === "output_limit").length, 1);

  const timeoutManager = createExecutionManager({
    runRoot: fixture.runRoot,
    executables: { codex: fixture.executable },
    timeoutMs: 30,
  });
  const timed = await timeoutManager.start({
    executorId: "codex",
    runDir: fixture.runDir,
    prompt: "test",
    env: { ...process.env, FAKE_MODE: "wait" },
  });
  await assert.rejects(timed.completion, (error) => error.code === "EXECUTION_TIMEOUT");
});

test("高层执行接口从运行目录读取提示词并保存可查询状态", async (t) => {
  const fixture = await createFakeExecutor(t);
  const codexPath = path.join(fixture.root, "codex");
  const promptPath = path.join(fixture.runDir, "AI_PROMPT.md");
  await fs.copyFile(fixture.executable, codexPath);
  await fs.chmod(codexPath, 0o755);
  await fs.writeFile(promptPath, "facade prompt");

  const execution = await startExecution({
    executor: "codex",
    runDir: fixture.runDir,
    runRootDir: fixture.runRoot,
    promptPath,
    env: { ...process.env, PATH: fixture.root },
  });
  await execution.completion;
  const status = getExecution(execution.executionId);
  assert.equal(status.status, "completed");
  assert.equal(status.executor, "codex");
  assert.equal("completion" in status, false);
  assert.equal("manager" in status, false);
  assert.equal(listExecutions().some((item) => item.executionId === execution.executionId), true);

  const outsidePrompt = path.join(fixture.root, "outside-prompt.md");
  await fs.writeFile(outsidePrompt, "outside");
  await assert.rejects(
    startExecution({
      executor: "codex",
      runDir: fixture.runDir,
      runRootDir: fixture.runRoot,
      promptPath: outsidePrompt,
      env: { ...process.env, PATH: fixture.root },
    }),
    (error) => error.code === "PROMPT_PATH_OUTSIDE_RUN",
  );
});
