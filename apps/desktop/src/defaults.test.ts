import assert from "node:assert/strict";
import { pickDefaultKernel, pickDefaultProfile, type DefaultsInput } from "./defaults.ts";

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const chromium = { id: "chromium", installed: true };
const cloak = { id: "cloak", installed: true };
/** Chromium 自带内置 Profile；CloakBrowser 是指纹浏览器，只有用户新建的 */
const refs = [
  { id: "chromium::default", kernelId: "chromium" },
  { id: "chromium::shop", kernelId: "chromium" },
  { id: "cloak::a", kernelId: "cloak" },
];
const input = (over: Partial<DefaultsInput> = {}): DefaultsInput => ({
  kernels: [chromium, cloak],
  refs,
  savedProfile: "",
  legacyKernel: "",
  ...over,
});

console.log("defaults");
test("用户选的默认 Profile 生效，默认内核跟着它走", () => {
  const i = input({ savedProfile: "cloak::a" });
  assert.equal(pickDefaultProfile(i), "cloak::a");
  assert.equal(pickDefaultKernel(i), "cloak");
});
test("什么都没设置：取第一个可用的 Profile", () => {
  const i = input();
  assert.equal(pickDefaultProfile(i), "chromium::default");
  assert.equal(pickDefaultKernel(i), "chromium");
});
test("迁移：旧版本的默认内核是 CloakBrowser，默认就落在它的 Profile 上，不会悄悄变回 Chromium", () => {
  const i = input({ legacyKernel: "cloak" });
  assert.equal(pickDefaultProfile(i), "cloak::a");
  assert.equal(pickDefaultKernel(i), "cloak");
});
test("已经选过默认 Profile 时，旧的默认内核不再起作用", () => {
  const i = input({ savedProfile: "chromium::shop", legacyKernel: "cloak" });
  assert.equal(pickDefaultProfile(i), "chromium::shop");
  assert.equal(pickDefaultKernel(i), "chromium");
});
test("默认 Profile 所在的内核被卸载：回退到别的内核的 Profile", () => {
  const i = input({ savedProfile: "cloak::a", kernels: [chromium, { id: "cloak", installed: false }] });
  assert.equal(pickDefaultProfile(i), "chromium::default");
  assert.equal(pickDefaultKernel(i), "chromium");
});
test("默认 Profile 已被删除：回退", () => {
  const i = input({ savedProfile: "chromium::gone" });
  assert.equal(pickDefaultProfile(i), "chromium::default");
});
test("只装了 CloakBrowser 且还没有 Profile：默认内核仍是它", () => {
  const i = input({ kernels: [{ id: "chromium", installed: false }, cloak], refs: [{ id: "chromium::default", kernelId: "chromium" }] });
  assert.equal(pickDefaultKernel(i), "cloak");
});
test("一个内核都没装：不报错，给出第一个", () => {
  const i = input({ kernels: [{ id: "chromium", installed: false }, { id: "cloak", installed: false }] });
  assert.equal(pickDefaultProfile(i), "chromium::default");
  assert.equal(pickDefaultKernel(i), "chromium");
});

console.log(`\n${passed} 个测试全部通过`);
