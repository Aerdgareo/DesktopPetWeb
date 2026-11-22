#!/usr/bin/env node
/**
 * generate-rain-audio.mjs —— 雨声 / 雷声 16bit PCM WAV 生成器（C-RAIN-AUDIO@1 兜底）
 *
 * 用途：当无法联网取得「许可明确为 CC0-1.0 / Public Domain」的外部音频时，
 *       在项目内程序化合成**真实可播放**的音效，避免 0 字节或占位文本。
 *
 * 产物（默认写入 <repo>/web/assets/audio/）：
 *   - rain-loop.wav  10s，单声道 32kHz，约 640KB（可无缝循环：所有分量都是 1/时长 的整数倍频率）
 *   - thunder.wav     4s，单声道 32kHz，约 256KB（快速起音 + 指数衰减 + 滚雷次爆）
 *
 * 设计约束：
 *   - 零第三方依赖，只使用 Node 内置模块（node:fs / node:path / node:crypto / node:url）；
 *   - 合成使用**固定随机种子**（mulberry32），同一脚本每次产出字节完全一致，
 *     因此 LICENSES.md 中登记的 SHA-256 可被复验；
 *   - 输出为 16bit little-endian PCM、单声道、无附加 chunk，任何浏览器均可直接播放。
 *
 * 用法：
 *   node scripts/generate-rain-audio.mjs                  # 生成到默认目录（覆盖同名文件）
 *   node scripts/generate-rain-audio.mjs --out <dir>      # 指定输出目录
 *   node scripts/generate-rain-audio.mjs --only rain      # 只生成雨声 / thunder 只生成雷声
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** 采样率：32kHz 足以覆盖雨声主要能量（< 10kHz），同时把体积控制在 1MB 内 */
const SAMPLE_RATE = 32000;
/** 雨声时长（秒）：契约要求 >= 8s */
const RAIN_SECONDS = 10;
/** 雷声时长（秒）：契约要求 <= 5s */
const THUNDER_SECONDS = 4;
/** 雨声随机种子（修改会让 SHA-256 变化，须同步更新 LICENSES.md） */
const RAIN_SEED = 0x5a17c0de;
/** 雷声随机种子 */
const THUNDER_SEED = 0x7e3b9f21;
/** 归一化目标峰值（留 15% headroom，避免 16bit 削波） */
const PEAK_RAIN = 0.80;
const PEAK_THUNDER = 0.85;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_OUT_DIR = path.join(REPO_DIR, 'web', 'assets', 'audio');

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * mulberry32：小巧的确定性 PRNG，返回 [0,1) 浮点。
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 线性映射 */
function lerp(min, max, k) {
  return min + (max - min) * k;
}

/**
 * 归一化到指定峰值，并按需做首尾淡入淡出（避免边界爆音）。
 * @param {Float32Array} samples
 * @param {number} peak
 * @param {{ fadeInSeconds?: number, fadeOutSeconds?: number }} [fade]
 * @returns {Float32Array}
 */
function normalize(samples, peak, fade) {
  const opts = fade || {};
  const n = samples.length;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(samples[i]);
    if (v > max) max = v;
  }
  const gain = max > 0 ? peak / max : 0;

  const fadeIn = Math.max(0, Math.round((opts.fadeInSeconds || 0) * SAMPLE_RATE));
  const fadeOut = Math.max(0, Math.round((opts.fadeOutSeconds || 0) * SAMPLE_RATE));

  for (let i = 0; i < n; i++) {
    let k = gain;
    if (fadeIn > 0 && i < fadeIn) k *= i / fadeIn;
    if (fadeOut > 0 && i >= n - fadeOut) k *= (n - i) / fadeOut;
    samples[i] *= k;
  }
  return samples;
}

/**
 * 写入 16bit PCM 单声道 WAV（44 字节标准头 + 44.1kHz 兼容的通用结构）。
 * @param {string} filePath
 * @param {Float32Array} samples [-1,1]
 */
function writeWav(filePath, samples) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // audio format = PCM
  buffer.writeUInt16LE(1, 22); // channels = mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate = sr * channels * bytesPerSample
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i++) {
    let v = samples[i];
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    buffer.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return buffer.length;
}

/* ------------------------------------------------------------------ */
/* 雨声：带通白噪声的循环合成                                           */
/* ------------------------------------------------------------------ */

/**
 * 雨声频谱包络：低频滚降 + 2.6kHz 附近「沙沙」抬升，整体近似带通白噪声。
 * @param {number} f 频率（Hz）
 */
function rainSpectralGain(f) {
  const lowRolloff = 1 / (1 + Math.pow(f / 1500, 1.35));
  const sizzle = 0.62 * Math.exp(-Math.pow((f - 2600) / 1900, 2));
  const air = 0.10 / (1 + Math.pow(f / 6500, 2.2));
  return lowRolloff + sizzle + air;
}

/**
 * 合成可无缝循环的雨声。
 *
 * 关键点：所有正弦分量的频率都取 f0 = 1/时长 的整数倍（k * f0），
 * 因此在总时长处每个分量的相位恰好增加整数个周期 —— 首尾严格连续，可无限 loop。
 *
 * @returns {Float32Array}
 */
function generateRain() {
  const n = SAMPLE_RATE * RAIN_SECONDS;
  const out = new Float32Array(n);
  const rand = mulberry32(RAIN_SEED);
  const f0 = 1 / RAIN_SECONDS; // 基频：整段循环周期

  // ---- 1) 分量堆叠：对数分布 + 随机相位 ----
  const COMPONENTS = 420;
  const fMin = 180;
  const fMax = 9000;
  const logMin = Math.log(fMin);
  const logMax = Math.log(fMax);

  for (let c = 0; c < COMPONENTS; c++) {
    const ratio = c / (COMPONENTS - 1);
    // 对数均匀 → 低频分量不会过密，也不会让高频成为噪声墙
    const freq = Math.exp(lerp(logMin, logMax, ratio)) * lerp(0.92, 1.08, rand());
    const k = Math.max(1, Math.round(freq / f0));
    const exactFreq = k * f0; // 严格落在循环网格上
    const omega = (2 * Math.PI * exactFreq) / SAMPLE_RATE;
    const phase = rand() * Math.PI * 2;
    const amp = rainSpectralGain(exactFreq) * lerp(0.65, 1.35, rand());
    const weight = amp / Math.sqrt(COMPONENTS); // 分量数越多单分量越弱，避免叠加爆表

    let sinV = Math.sin(phase);
    let cosV = Math.cos(phase);
    const sinW = Math.sin(omega);
    const cosW = Math.cos(omega);
    // 旋转递推：sin/cos 逐样本旋转，比 Math.sin 快一个数量级；每 4096 样本校正一次漂移
    for (let i = 0; i < n; i++) {
      out[i] += sinV * weight;
      const nextSin = sinV * cosW + cosV * sinW;
      const nextCos = cosV * cosW - sinV * sinW;
      sinV = nextSin;
      cosV = nextCos;
      if ((i & 4095) === 4095) {
        const theta = omega * (i + 1) + phase;
        sinV = Math.sin(theta);
        cosV = Math.cos(theta);
      }
    }
  }

  // ---- 2) 缓慢的强弱起伏（整数周期，循环安全）----
  const mod1 = Math.sin((2 * Math.PI * 3 * 1) / RAIN_SECONDS); // 3 次/段
  const mod2 = Math.sin((2 * Math.PI * 7 * 1) / RAIN_SECONDS); // 7 次/段
  let s1 = Math.sin(rand() * Math.PI * 2);
  let c1 = Math.cos(rand() * Math.PI * 2);
  let s2 = Math.sin(rand() * Math.PI * 2);
  let c2 = Math.cos(rand() * Math.PI * 2);
  for (let i = 0; i < n; i++) {
    const env = 1 + 0.10 * s1 + 0.05 * s2;
    out[i] *= env;
    const ns1 = s1 * Math.cos(mod1) + c1 * Math.sin(mod1);
    const nc1 = c1 * Math.cos(mod1) - s1 * Math.sin(mod1);
    s1 = ns1;
    c1 = nc1;
    const ns2 = s2 * Math.cos(mod2) + c2 * Math.sin(mod2);
    const nc2 = c2 * Math.cos(mod2) - s2 * Math.sin(mod2);
    s2 = ns2;
    c2 = nc2;
  }

  // 循环素材不做首尾淡入淡出（会破坏无缝性），只做归一化
  return normalize(out, PEAK_RAIN);
}

/* ------------------------------------------------------------------ */
/* 雷声：低频噪声 + 衰减包络                                            */
/* ------------------------------------------------------------------ */

/** 雷声分段包络参数（秒 / 相对幅度 / 衰减时间常数） */
const THUNDER_BURSTS = [
  { at: 0.42, amp: 0.42, tau: 0.30 },
  { at: 0.95, amp: 0.30, tau: 0.42 },
  { at: 1.75, amp: 0.20, tau: 0.55 },
  { at: 2.60, amp: 0.12, tau: 0.60 }
];

/**
 * 合成单次雷声：主爆（5ms 起音 + 指数衰减）+ 滚雷次爆 + 低频隆隆。
 * @returns {Float32Array}
 */
function generateThunder() {
  const n = SAMPLE_RATE * THUNDER_SECONDS;
  const out = new Float32Array(n);
  const rand = mulberry32(THUNDER_SEED);

  // 二阶低通（one-pole 串联）：截止频率随时间下移，声音越听越闷
  let lp1 = 0;
  let lp2 = 0;

  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;

    // --- 噪声主体 ---
    const white = rand() * 2 - 1;
    const cutoff = 1200 * Math.exp(-t * 0.9) + 120;
    const alpha = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
    lp1 += alpha * (white - lp1);
    lp2 += alpha * (lp1 - lp2);
    const body = lp2 * 2.6;

    // --- 低频隆隆（频率缓慢下滑 + 轻微颤动）---
    const rumble =
      0.34 * Math.sin(2 * Math.PI * (38 * t - 2.2 * t * t)) +
      0.22 * Math.sin(2 * Math.PI * (57 * t - 3.1 * t * t) + 1.7) +
      0.12 * Math.sin(2 * Math.PI * (83 * t + 0.4 * Math.sin(2 * Math.PI * 0.7 * t)));

    // --- 主爆包络 ---
    const attack = t < 0.012 ? t / 0.012 : 1;
    const main = attack * Math.exp(-Math.max(0, t - 0.012) * 1.35);

    // --- 滚雷次爆 ---
    let burst = 0;
    for (let b = 0; b < THUNDER_BURSTS.length; b++) {
      const seg = THUNDER_BURSTS[b];
      if (t < seg.at) continue;
      const dt = t - seg.at;
      const rise = dt < 0.008 ? dt / 0.008 : 1;
      burst += seg.amp * rise * Math.exp(-dt / seg.tau);
    }

    // 次爆轻微激励低频，让滚雷有「推背感」
    const env = main + burst * 0.9;
    const lowWeight = 0.5 * main + 0.85 * burst;
    out[i] = body * env + rumble * lowWeight;
  }

  // 首 4ms 淡入、尾 400ms 淡出（雷声非循环，但仍需避免截断爆音）
  return normalize(out, PEAK_THUNDER, { fadeInSeconds: 0.004, fadeOutSeconds: 0.4 });
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

/**
 * 解析命令行参数。
 * @param {string[]} argv
 * @returns {{ outDir: string, only: 'all'|'rain'|'thunder' }}
 */
function parseArgs(argv) {
  const result = { outDir: DEFAULT_OUT_DIR, only: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      const next = argv[++i];
      if (!next) throw new Error('--out 需要一个目录参数');
      result.outDir = path.resolve(next);
    } else if (arg === '--only') {
      const next = argv[++i];
      if (next !== 'rain' && next !== 'thunder' && next !== 'all') {
        throw new Error('--only 只接受 rain | thunder | all');
      }
      result.only = next;
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/generate-rain-audio.mjs [--out <dir>] [--only rain|thunder|all]');
      process.exit(0);
    } else {
      throw new Error('未知参数：' + arg);
    }
  }
  return result;
}

/** 打印文件大小与 SHA-256（可直接抄进 LICENSES.md） */
function report(filePath, bytes) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const kb = (bytes / 1024).toFixed(1);
  console.log('[generate-rain-audio] ' + path.basename(filePath) + '  ' + bytes + ' B (' + kb + ' KB)');
  console.log('[generate-rain-audio]   SHA-256: ' + sha);
  return sha;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outDir, { recursive: true });

  const summary = [];

  if (args.only === 'all' || args.only === 'rain') {
    const samples = generateRain();
    const file = path.join(args.outDir, 'rain-loop.wav');
    const bytes = writeWav(file, samples);
    summary.push({ file: 'rain-loop.wav', bytes, sha256: report(file, bytes), seconds: RAIN_SECONDS });
  }

  if (args.only === 'all' || args.only === 'thunder') {
    const samples = generateThunder();
    const file = path.join(args.outDir, 'thunder.wav');
    const bytes = writeWav(file, samples);
    summary.push({ file: 'thunder.wav', bytes, sha256: report(file, bytes), seconds: THUNDER_SECONDS });
  }

  console.log('[generate-rain-audio] 完成，输出目录：' + args.outDir);
  console.log('[generate-rain-audio] 许可：项目内自制，CC0-1.0（见 web/assets/audio/LICENSES.md）');
  return summary;
}

try {
  main();
} catch (err) {
  console.error('[generate-rain-audio] 生成失败：' + (err && err.message ? err.message : err));
  process.exitCode = 1;
}