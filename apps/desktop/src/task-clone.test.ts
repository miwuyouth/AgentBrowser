import assert from "node:assert/strict";
import { cloneTaskItem, makeCloneName, type TaskItem } from "./shared.ts";

/**
 * 任务克隆（Task Clone）算法与数据完整性单元测试套件。
 */

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log("task-clone: makeCloneName");

test("首次克隆生成带有「(副本)」后缀的名称", () => {
  const result = makeCloneName("Bing 每日领取积分", ["Bing 每日领取积分", "chatgpt 每日聊天"]);
  assert.equal(result, "Bing 每日领取积分 (副本)");
});

test("当「(副本)」已存在时，递增生成「(副本 2)」", () => {
  const existing = ["Bing 每日领取积分", "Bing 每日领取积分 (副本)"];
  const result = makeCloneName("Bing 每日领取积分", existing);
  assert.equal(result, "Bing 每日领取积分 (副本 2)");
});

test("当「(副本 2)」也已存在时，递增生成「(副本 3)」", () => {
  const existing = ["Bing 每日领取积分", "Bing 每日领取积分 (副本)", "Bing 每日领取积分 (副本 2)"];
  const result = makeCloneName("Bing 每日领取积分", existing);
  assert.equal(result, "Bing 每日领取积分 (副本 3)");
});

test("克隆一个本身就是副本的任务时，自动提取原任务名并递增编号", () => {
  const existing = ["Bing 每日领取积分", "Bing 每日领取积分 (副本)"];
  const result = makeCloneName("Bing 每日领取积分 (副本)", existing);
  assert.equal(result, "Bing 每日领取积分 (副本 2)");
});

test("兼容空格变体「原名称 副本」的格式解析", () => {
  const existing = ["签到任务", "签到任务 副本"];
  const result = makeCloneName("签到任务 副本", existing);
  assert.equal(result, "签到任务 (副本 2)");
});

test("兼容全角中文括号「原名称（副本）」的格式解析", () => {
  const existing = ["每日签到", "每日签到（副本）"];
  const result = makeCloneName("每日签到（副本）", existing);
  assert.equal(result, "每日签到 (副本 2)");
});

test("空名称或纯空白时优雅回退", () => {
  const result = makeCloneName("   ", ["新任务"]);
  assert.equal(result, "新任务 (副本)");
});

console.log("\ntask-clone: cloneTaskItem");

test("克隆任务生成全新 ID、重置执行状态并保留全部配置参数", () => {
  const sourceTask: TaskItem = {
    id: "task-original-123",
    name: "每天签到领京豆",
    goal: "打开京东签到页面完成签到",
    url: "https://bean.jd.com",
    doneCondition: "出现已签到",
    fields: [
      { id: "f-1", name: "获得京豆数", type: "number", description: "提取数字" },
      { id: "f-2", name: "签到状态", type: "text" },
    ],
    kernelId: "cloakbrowser",
    kernel: "CloakBrowser",
    profileId: "profile-jd-01",
    profile: "JD",
    autoProfile: false,
    autoClose: true,
    headless: true,
    mode: "cron",
    schedule: "每天 00:00",
    repeatKind: "daily",
    repeatTime: "00:00",
    maxSteps: 40,
    timeoutMinutes: 15,
    lastStatus: "ok",
    lastRunTime: "10分钟前",
    lastDuration: "用时 00:45",
    updatedAt: 1000000,
  };

  const cloned = cloneTaskItem(sourceTask, [sourceTask.name]);

  // 1. 验证 ID 必须是新的，不能相同
  assert.notEqual(cloned.id, sourceTask.id);
  assert.ok(cloned.id.startsWith("task-"));

  // 2. 验证名称带有副本标识
  assert.equal(cloned.name, "每天签到领京豆 (副本)");

  // 3. 验证表单字段已深拷贝，且拥有新的唯一 ID
  assert.equal(cloned.fields?.length, 2);
  assert.equal(cloned.fields?.[0]?.name, "获得京豆数");
  assert.equal(cloned.fields?.[0]?.type, "number");
  assert.notEqual(cloned.fields?.[0]?.id, "f-1");
  assert.notEqual(cloned.fields?.[1]?.id, "f-2");

  // 4. 验证核心执行配置完整继承
  assert.equal(cloned.goal, sourceTask.goal);
  assert.equal(cloned.url, sourceTask.url);
  assert.equal(cloned.doneCondition, sourceTask.doneCondition);
  assert.equal(cloned.kernelId, sourceTask.kernelId);
  assert.equal(cloned.kernel, sourceTask.kernel);
  assert.equal(cloned.profileId, sourceTask.profileId);
  assert.equal(cloned.profile, sourceTask.profile);
  assert.equal(cloned.autoProfile, sourceTask.autoProfile);
  assert.equal(cloned.autoClose, sourceTask.autoClose);
  assert.equal(cloned.headless, sourceTask.headless);
  assert.equal(cloned.mode, sourceTask.mode);
  assert.equal(cloned.schedule, sourceTask.schedule);
  assert.equal(cloned.repeatKind, sourceTask.repeatKind);
  assert.equal(cloned.repeatTime, sourceTask.repeatTime);
  assert.equal(cloned.maxSteps, sourceTask.maxSteps);
  assert.equal(cloned.timeoutMinutes, sourceTask.timeoutMinutes);

  // 5. 验证执行状态已重置为全新状态
  assert.equal(cloned.lastStatus, "none");
  assert.equal(cloned.lastRunTime, "—");
  assert.equal(cloned.lastDuration, "—");
  assert.ok(cloned.updatedAt > sourceTask.updatedAt);
  assert.ok(cloned.lastScheduledAt && cloned.lastScheduledAt > 0);
});

console.log(`\n${passed} 个测试全部通过`);

