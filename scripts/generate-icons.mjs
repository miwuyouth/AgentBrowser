/**
 * 生成全套 Agent Browser 产品级 Logo 与图标资产：
 * 1. apps/desktop/assets/icon.svg (矢量母版)
 * 2. apps/desktop/assets/icon.png (1024x1024 超采样高清 PNG)
 * 3. apps/desktop/assets/icon.icns (macOS 原生多尺寸 .icns 图标包)
 * 4. packages/extension/icons/icon-{16,32,48,128}.png (Chrome 扩展图标)
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopAssetsDir = path.join(root, "apps/desktop/assets");
const extIconsDir = path.join(root, "packages/extension/icons");

mkdirSync(desktopAssetsDir, { recursive: true });
mkdirSync(extIconsDir, { recursive: true });

// 1. 生成矢量 SVG 母版（用于应用内顶栏、Favicon 及矢量引用）
const SVG_CONTENT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="none">
  <defs>
    <linearGradient id="bg-grad" x1="120" y1="90" x2="900" y2="940" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#172A54" />
      <stop offset="48%" stop-color="#0D162B" />
      <stop offset="100%" stop-color="#070B14" />
    </linearGradient>
    <radialGradient id="bg-glow" cx="65%" cy="32%" r="60%">
      <stop offset="0%" stop-color="#38BDF8" stop-opacity="0.28" />
      <stop offset="55%" stop-color="#2563EB" stop-opacity="0.10" />
      <stop offset="100%" stop-color="#070B14" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="ring-grad" x1="220" y1="780" x2="780" y2="220" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#3B82F6" />
      <stop offset="55%" stop-color="#38BDF8" />
      <stop offset="100%" stop-color="#7DD3FC" />
    </linearGradient>
    <linearGradient id="wing-top" x1="300" y1="320" x2="700" y2="540" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FFFFFF" />
      <stop offset="100%" stop-color="#E0F2FE" />
    </linearGradient>
    <linearGradient id="wing-bottom" x1="480" y1="340" x2="660" y2="740" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#BAE6FD" />
      <stop offset="100%" stop-color="#60A5FA" />
    </linearGradient>
    <linearGradient id="rim-grad" x1="100" y1="100" x2="924" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#93C5FD" stop-opacity="0.35" />
      <stop offset="100%" stop-color="#1E3A8A" stop-opacity="0.12" />
    </linearGradient>
  </defs>

  <!-- macOS Continuous Squircle Base -->
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg-grad)" />
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg-glow)" />
  <rect x="103" y="103" width="818" height="818" rx="183" stroke="url(#rim-grad)" stroke-width="6" />

  <!-- Inner Browser Latitude Arc -->
  <circle cx="512" cy="512" r="184" stroke="#38BDF8" stroke-opacity="0.22" stroke-width="18" stroke-dasharray="220 80" />

  <!-- Outer Browser Portal Ring (Open at NE for cursor breakthrough) -->
  <path d="M 730 378 A 256 256 0 1 1 646 294" stroke="url(#ring-grad)" stroke-width="48" stroke-linecap="round" />

  <!-- Signal Node on Orbit -->
  <circle cx="331" cy="331" r="28" fill="#38BDF8" />
  <circle cx="331" cy="331" r="13" fill="#FFFFFF" />

  <!-- Autonomous Agent Cursor Prism (2-Facet 3D Arrow) -->
  <!-- Upper-Left Sunlit Facet -->
  <path d="M 706 318 L 298 468 L 484 540 Z" fill="url(#wing-top)" />
  <!-- Lower-Right Shaded Facet -->
  <path d="M 706 318 L 484 540 L 556 726 Z" fill="url(#wing-bottom)" />
</svg>
`;

writeFileSync(path.join(desktopAssetsDir, "icon.svg"), SVG_CONTENT, "utf8");
writeFileSync(path.join(root, "apps/desktop/src/renderer/logo.svg"), SVG_CONTENT, "utf8");

// 2. 高精度 SDF / 向量几何超采样渲染器，生成 1024x1024 无损 RGBA PNG
const SIZE = 1024;
const buf = Buffer.alloc(SIZE * SIZE * 4);

function clamp(v, lo = 0, hi = 1) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(c1, c2, t) {
  return [
    mix(c1[0], c2[0], t),
    mix(c1[1], c2[1], t),
    mix(c1[2], c2[2], t),
  ];
}

// 点到线段的有向距离与投影参数
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? clamp((wx * vx + wy * vy) / len2) : 0;
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.hypot(dx, dy);
}

// 2D 三角形有向距离 (SDF): 内部为负，外部为正
function sdTriangle(px, py, x0, y0, x1, y1, x2, y2) {
  const d0 = distToSegment(px, py, x0, y0, x1, y1);
  const d1 = distToSegment(px, py, x1, y1, x2, y2);
  const d2 = distToSegment(px, py, x2, y2, x0, y0);
  const minDist = Math.min(d0, d1, d2);

  // 叉积判断点是否在三角形内（顺时针/逆时针）
  const c0 = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
  const c1 = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
  const c2 = (x0 - x2) * (py - y2) - (y0 - y2) * (px - x2);
  const inside = (c0 >= 0 && c1 >= 0 && c2 >= 0) || (c0 <= 0 && c1 <= 0 && c2 <= 0);
  return inside ? -minDist : minDist;
}

// 圆角矩形 SDF
function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const outDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inDist = Math.min(Math.max(qx, qy), 0);
  return outDist + inDist - r;
}

// 带缺口的圆环 SDF（缺口中心角 gapAngleRad，半张角 gapHalfRad）
function sdOpenRing(px, py, cx, cy, radius, halfThick, gapAngleRad, gapHalfRad) {
  const dx = px - cx;
  const dy = py - cy;
  const angle = Math.atan2(dy, dx);
  // 计算与缺口中心角的角度差 [-PI, PI]
  let diff = angle - gapAngleRad;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const absDiff = Math.abs(diff);

  const r = Math.hypot(dx, dy);
  if (absDiff > gapHalfRad) {
    return Math.abs(r - radius) - halfThick;
  }
  // 处于缺口扇区内时，计算到两个圆弧端点圆心的距离
  const end1Angle = gapAngleRad - gapHalfRad;
  const end2Angle = gapAngleRad + gapHalfRad;
  const d1 = Math.hypot(px - (cx + radius * Math.cos(end1Angle)), py - (cy + radius * Math.sin(end1Angle)));
  const d2 = Math.hypot(px - (cx + radius * Math.cos(end2Angle)), py - (cy + radius * Math.sin(end2Angle)));
  return Math.min(d1, d2) - halfThick;
}

// Alpha 混合辅助函数 (Premultiplied / Straight)
function blendOver(dstR, dstG, dstB, dstA, srcR, srcG, srcB, srcA) {
  if (srcA <= 0) return [dstR, dstG, dstB, dstA];
  if (srcA >= 1) return [srcR, srcG, srcB, 1];
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return [0, 0, 0, 0];
  const outR = (srcR * srcA + dstR * dstA * (1 - srcA)) / outA;
  const outG = (srcG * srcA + dstG * dstA * (1 - srcA)) / outA;
  const outB = (srcB * srcA + dstB * dstA * (1 - srcA)) / outA;
  return [outR, outG, outB, outA];
}

// 关键几何参数
const CX = 512;
const CY = 512;
const GAP_ANGLE = -Math.PI / 4; // 右上 45 度 (-45 deg in screen coords)
const GAP_HALF = 0.42; // 缺口半张角

// 箭头顶点
const TIP_X = 706, TIP_Y = 318;
const LEFT_X = 298, LEFT_Y = 468;
const MID_X = 484, MID_Y = 540;
const BOT_X = 556, BOT_Y = 726;

// 颜色定义
const C_BG_TOP = [23, 42, 84];      // #172A54
const C_BG_MID = [13, 22, 43];      // #0D162B
const C_BG_BOT = [7, 11, 20];       // #070B14
const C_GLOW_CYAN = [56, 189, 248]; // #38BDF8
const C_GLOW_BLUE = [37, 99, 235];  // #2563EB

const C_RING_START = [59, 130, 246]; // #3B82F6
const C_RING_MID = [56, 189, 248];   // #38BDF8
const C_RING_END = [125, 211, 252];  // #7DD3FC

const C_WING_TOP_1 = [255, 255, 255];
const C_WING_TOP_2 = [224, 242, 254];
const C_WING_BOT_1 = [186, 230, 253];
const C_WING_BOT_2 = [96, 165, 250];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5;
    const py = y + 0.5;

    let r = 0, g = 0, b = 0, a = 0;

    // 0. 柔和底部投影
    const shadowDist = sdRoundRect(px, py - 14, CX, CY, 412, 412, 186);
    if (shadowDist < 28) {
      const shadowAlpha = (1 - smoothstep(-10, 28, shadowDist)) * 0.38;
      [r, g, b, a] = blendOver(r, g, b, a, 0, 0, 0, shadowAlpha);
    }

    // 1. macOS 圆角底座 (824x824, rx=186)
    const dBase = sdRoundRect(px, py, CX, CY, 412, 412, 186);
    const baseCov = 1 - smoothstep(-0.8, 0.8, dBase);

    if (baseCov > 0) {
      // 主对角渐变
      const tGrad = clamp(((px - 100) * 0.45 + (py - 100) * 0.55) / 824);
      let bgCol = tGrad < 0.5
        ? mixColor(C_BG_TOP, C_BG_MID, tGrad * 2)
        : mixColor(C_BG_MID, C_BG_BOT, (tGrad - 0.5) * 2);

      // 右上方氛围高光
      const dGlow = Math.hypot(px - 640, py - 340) / 480;
      if (dGlow < 1) {
        const glowStrength = Math.pow(1 - dGlow, 2) * 0.30;
        bgCol = mixColor(bgCol, C_GLOW_CYAN, glowStrength);
      }

      // 中心微光
      const dCenterGlow = Math.hypot(px - CX, py - CY) / 380;
      if (dCenterGlow < 1) {
        bgCol = mixColor(bgCol, C_GLOW_BLUE, (1 - dCenterGlow) * 0.16);
      }

      // 内部高光描边 (Inner Rim)
      const rimDist = Math.abs(dBase + 3.5) - 2.2;
      const rimCov = 1 - smoothstep(-0.8, 0.8, rimDist);
      if (rimCov > 0) {
        const rimT = clamp(1 - (py - 100) / 824);
        const rimAlpha = rimCov * (0.08 + 0.28 * rimT);
        bgCol = mixColor(bgCol, [165, 216, 255], rimAlpha);
      }

      // 2. 内层轨道虚线圆环 (r=184, halfThick=8)
      const dInnerRing = Math.abs(Math.hypot(px - CX, py - CY) - 184) - 8;
      if (dInnerRing < 1) {
        const innerCov = (1 - smoothstep(-0.8, 0.8, dInnerRing)) * 0.20;
        bgCol = mixColor(bgCol, C_GLOW_CYAN, innerCov);
      }

      // 3. 主浏览器轨道环 (r=256, halfThick=24, 右上开口)
      const dRing = sdOpenRing(px, py, CX, CY, 256, 24, GAP_ANGLE, GAP_HALF);
      if (dRing < 20) {
        // 环的柔和外发光
        if (dRing >= 0) {
          const ringGlow = (1 - smoothstep(0, 20, dRing)) * 0.18;
          bgCol = mixColor(bgCol, C_GLOW_CYAN, ringGlow);
        }
        const ringCov = 1 - smoothstep(-0.8, 0.8, dRing);
        if (ringCov > 0) {
          const rt = clamp(((px - 220) - (py - 780)) / 1120);
          const ringCol = rt < 0.55
            ? mixColor(C_RING_START, C_RING_MID, rt / 0.55)
            : mixColor(C_RING_MID, C_RING_END, (rt - 0.55) / 0.45);
          bgCol = mixColor(bgCol, ringCol, ringCov);
        }
      }

      // 4. 左上轨道信号节点 (cx=331, cy=331)
      const dNodeOuter = Math.hypot(px - 331, py - 331) - 28;
      if (dNodeOuter < 1) {
        const cOuter = 1 - smoothstep(-0.8, 0.8, dNodeOuter);
        bgCol = mixColor(bgCol, C_GLOW_CYAN, cOuter);
      }
      const dNodeInner = Math.hypot(px - 331, py - 331) - 13;
      if (dNodeInner < 1) {
        const cInner = 1 - smoothstep(-0.8, 0.8, dNodeInner);
        bgCol = mixColor(bgCol, [255, 255, 255], cInner);
      }

      // 5. Agent 导航棱镜箭头投影
      const dShadowTop = sdTriangle(px - 6, py - 14, TIP_X, TIP_Y, LEFT_X, LEFT_Y, MID_X, MID_Y);
      const dShadowBot = sdTriangle(px - 6, py - 14, TIP_X, TIP_Y, MID_X, MID_Y, BOT_X, BOT_Y);
      const dArrowShadow = Math.min(dShadowTop, dShadowBot);
      if (dArrowShadow < 24) {
        const shAlpha = (1 - smoothstep(-4, 24, dArrowShadow)) * 0.42;
        bgCol = mixColor(bgCol, [4, 7, 15], shAlpha);
      }

      // 6. Agent 导航棱镜箭头：左上受光面 & 右下背光面
      const dWingTop = sdTriangle(px, py, TIP_X, TIP_Y, LEFT_X, LEFT_Y, MID_X, MID_Y);
      const dWingBot = sdTriangle(px, py, TIP_X, TIP_Y, MID_X, MID_Y, BOT_X, BOT_Y);

      if (dWingBot < 1) {
        const covBot = 1 - smoothstep(-0.8, 0.8, dWingBot);
        const tBot = clamp((py - 320) / 400);
        const colBot = mixColor(C_WING_BOT_1, C_WING_BOT_2, tBot);
        bgCol = mixColor(bgCol, colBot, covBot);
      }

      if (dWingTop < 1) {
        const covTop = 1 - smoothstep(-0.8, 0.8, dWingTop);
        const tTop = clamp((px - 300) / 400);
        const colTop = mixColor(C_WING_TOP_1, C_WING_TOP_2, tTop);
        bgCol = mixColor(bgCol, colTop, covTop);
      }

      [r, g, b, a] = blendOver(r, g, b, a, bgCol[0], bgCol[1], bgCol[2], baseCov);
    }

    const idx = (y * SIZE + x) * 4;
    buf[idx] = Math.round(clamp(r, 0, 255));
    buf[idx + 1] = Math.round(clamp(g, 0, 255));
    buf[idx + 2] = Math.round(clamp(b, 0, 255));
    buf[idx + 3] = Math.round(clamp(a * 255, 0, 255));
  }
}

// 编码标准 PNG 文件
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: None
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  function crc32(bufs) {
    let c = 0xffffffff;
    for (const b of bufs) {
      for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32([typeBuf, data]), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const masterPngPath = path.join(desktopAssetsDir, "icon.png");
writeFileSync(masterPngPath, encodePng(SIZE, SIZE, buf));
console.log(`Generated 1024x1024 PNG: ${masterPngPath}`);

// 3. 使用 macOS 原生 sips 与 iconutil 生成 icon.icns 及 Chrome 扩展多尺寸图标
const tmpIconset = path.join(os.tmpdir(), `agent-browser-${Date.now()}.iconset`);
mkdirSync(tmpIconset, { recursive: true });

const iconsetSizes = [
  { name: "icon_16x16.png", size: 16 },
  { name: "icon_16x16@2x.png", size: 32 },
  { name: "icon_32x32.png", size: 32 },
  { name: "icon_32x32@2x.png", size: 64 },
  { name: "icon_128x128.png", size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png", size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png", size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
];

for (const item of iconsetSizes) {
  const out = path.join(tmpIconset, item.name);
  execFileSync("sips", ["-z", String(item.size), String(item.size), masterPngPath, "--out", out], {
    stdio: "ignore",
  });
}

const icnsPath = path.join(desktopAssetsDir, "icon.icns");
execFileSync("iconutil", ["-c", "icns", tmpIconset, "-o", icnsPath]);
console.log(`Generated macOS ICNS: ${icnsPath}`);

// 生成 Chrome 扩展图标 (16, 32, 48, 128)
for (const sz of [16, 32, 48, 128]) {
  const out = path.join(extIconsDir, `icon-${sz}.png`);
  execFileSync("sips", ["-z", String(sz), String(sz), masterPngPath, "--out", out], {
    stdio: "ignore",
  });
}
console.log(`Generated extension icons in: ${extIconsDir}`);

rmSync(tmpIconset, { recursive: true, force: true });

// 同步更新本地开发环境中 Electron.app 的默认图标，使 pnpm dev 启动时 Dock 立即展示新图标
const electronAppResources = path.join(
  root,
  "apps/desktop/node_modules/electron/dist/Electron.app/Contents/Resources",
);
if (existsSync(electronAppResources)) {
  try {
    cpSync(icnsPath, path.join(electronAppResources, "electron.icns"));
    console.log("Updated local Electron.app bundle icon (electron.icns)");
  } catch {}
}
