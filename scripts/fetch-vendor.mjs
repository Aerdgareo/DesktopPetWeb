#!/usr/bin/env node
/**
 * 拉取「不随仓库分发」的运行时库到 web/vendor/。
 *
 * 为什么不在仓库里内置：Live2D Cubism Core（4/5 代）与 Cubism 2.1 Core 属
 * **Live2D 专有许可**，公开仓库不宜直接再分发；因此改由本脚本按需下载，
 * 由使用者自行确认并遵守 Live2D 的 SDK 许可（见 THIRD-PARTY-NOTICES.md）。
 *
 * 运行：npm run fetch-vendor
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'web', 'vendor');
fs.mkdirSync(VENDOR, { recursive: true });

const TARGETS = [
  {
    file: 'live2dcubismcore.min.js',
    urls: [
      'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
      'https://cdn.jsdelivr.net/npm/live2dcubismcore@1.0.0/live2dcubismcore.min.js'
    ],
    note: 'Live2D Cubism Core（4/5 代）— Live2D 专有许可'
  },
  {
    file: 'live2d.min.js',
    urls: [
      'https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js'
    ],
    note: 'Live2D Cubism 2.1 Core — Live2D 专有许可'
  }
];

async function download(file, urls) {
  const dest = path.join(VENDOR, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
    console.log(`[fetch-vendor] 已存在，跳过：${file}`);
    return;
  }
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error('内容过小，疑似失败');
      fs.writeFileSync(dest, buf);
      console.log(`[fetch-vendor] 已下载 ${file} ← ${url}（${(buf.length / 1024).toFixed(0)} KB）`);
      return;
    } catch (err) {
      console.warn(`[fetch-vendor] 失败：${url} -> ${err.message}`);
    }
  }
  console.error(`[fetch-vendor] ✗ 无法获取 ${file}（请手动下载放入 web/vendor/）`);
  process.exitCode = 1;
}

console.log('=== 拉取 Live2D 运行时库到 web/vendor/（遵循 Live2D SDK 许可）===');
for (const t of TARGETS) {
  console.log(`- ${t.file}  // ${t.note}`);
  await download(t.file, t.urls);
}
console.log('完成。若下载失败，请手动获取并放入 web/vendor/。');