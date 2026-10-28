// 下载 KataGo 引擎 + 权重到 bridge/katago/
//
//   node tools/fetch-katago.mjs              # 默认：CPU 版引擎 + 78 MB 权重
//   node tools/fetch-katago.mjs --gpu        # 额外再下一份 OpenCL 版引擎
//   node tools/fetch-katago.mjs --net b28c512nbt   # 换更大的网络（更准更慢）
//
// 权重来源是 katagotraining.org 的官方发布，引擎来自 KataGo 的 GitHub release。
// 已经存在的文件会跳过，所以可以重复跑。

import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', 'bridge', 'katago');

const ENGINE_TAG = 'v1.18.1'; // v1.18.2 起只编 CUDA 版，非 NVIDIA 显卡用这一版
const REPO = 'https://github.com/lightvector/KataGo/releases/download';
const NET_MIRROR = 'https://media.katagotraining.org/uploaded/networks/models/kata1';

// 每个网络挑一个稳定版本；文件名里带参数量对应的训练步数
const NETS = {
  b15c192: 'kata1-b15c192-s497233664-d1492386857',
  b18c384nbt: 'kata1-b18c384nbt-s9996604416-d4316597426',
  b28c512nbt: 'kata1-b28c512nbt-s12013130496-d5608824079',
  'tf3-b11c768': 'kata1-tf3-b11c768-s11003M-d5973M-7gres',
};

const args = process.argv.slice(2);
const wantGpu = args.includes('--gpu');
const netArg = args.indexOf('--net');
const netSize = netArg >= 0 ? args[netArg + 1] : 'b18c384nbt';

if (!NETS[netSize]) {
  console.error(`[x] 不认识的网络 ${netSize}，可选：${Object.keys(NETS).join(' / ')}`);
  process.exit(1);
}

async function exists(p) {
  try {
    const s = await stat(p);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  if (await exists(dest)) {
    console.log(`[=] 已有，跳过 ${path.basename(dest)}`);
    return true;
  }
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (e) {
    console.error(`[x] 连不上：${e.message}`);
    return false;
  }
  if (!res.ok) {
    console.error(`[x] HTTP ${res.status}  ${url}`);
    return false;
  }
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0;
  let last = 0;
  const stream = Readable.fromWeb(res.body);
  stream.on('data', (c) => {
    got += c.length;
    const now = Date.now();
    if (now - last > 3000) {
      last = now;
      const pct = total ? ((got / total) * 100).toFixed(0) + '%' : '';
      process.stdout.write(`\r    ${path.basename(dest)} ${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB ${pct}   `);
    }
  });
  try {
    await pipeline(stream, createWriteStream(dest));
  } catch (e) {
    console.error(`\n[x] 写入失败：${e.message}`);
    return false;
  }
  console.log(`\r[+] ${path.basename(dest)} ${(got / 1048576).toFixed(1)} MB，${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  return true;
}

function unzip(zip, outDir) {
  return new Promise((resolve) => {
    const ps = spawn('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${outDir}' -Force`,
    ], { stdio: 'inherit' });
    ps.on('error', (e) => {
      console.error(`[x] 解压失败：${e.message}`);
      resolve(false);
    });
    ps.on('exit', (code) => resolve(code === 0));
  });
}

await mkdir(ROOT, { recursive: true });

console.log(`[*] 目标目录 ${ROOT}`);
console.log(`[*] 网络 ${netSize}`);

// ── 引擎 ──
const engines = [['eigen', 'eigenavx2-windows-x64']];
if (wantGpu) engines.push(['opencl', 'opencl-windows-x64']);

for (const [dir, suffix] of engines) {
  const zipName = `katago-${ENGINE_TAG}-${suffix}.zip`;
  const zipPath = path.join(ROOT, zipName);
  const outDir = path.join(ROOT, dir);
  if (await exists(path.join(outDir, 'katago.exe'))) {
    console.log(`[=] 已有，跳过 ${dir}/katago.exe`);
    continue;
  }
  const ok = await download(`${REPO}/${ENGINE_TAG}/${zipName}`, zipPath);
  if (!ok) continue;
  console.log(`[*] 解压到 ${dir}/`);
  if (await unzip(zipPath, outDir)) {
    await unlink(zipPath).catch(() => {});
  }
}

// ── 权重 ──
const modelPath = path.join(ROOT, 'model.bin.gz');
await download(`${NET_MIRROR}/${NETS[netSize]}.bin.gz`, modelPath);

// ── 自检 ──
const hasEngine = (await exists(path.join(ROOT, 'eigen', 'katago.exe'))) || (await exists(path.join(ROOT, 'opencl', 'katago.exe')));
const hasModel = await exists(modelPath);
console.log('');
if (hasEngine && hasModel) {
  console.log('[ok] 齐了。引擎和权重都在 ' + ROOT);
  console.log('     dsh 里调 tts_judge 就能用。');
} else {
  console.log('[x] 还缺：' + [!hasEngine && '引擎', !hasModel && '权重'].filter(Boolean).join('、'));
  console.log('    引擎下不下来就手动去 ' + REPO + '/' + ENGINE_TAG + ' 拿 eigenavx2-windows-x64.zip，');
  console.log('    解压到 ' + path.join(ROOT, 'eigen') + ' 即可。');
}
