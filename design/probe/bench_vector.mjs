// Noryth 向量扫描基准（Node 端，真实运行时）
// 用法: node design/probe/bench_vector.mjs
// 纯 JS + Float32Array，无依赖。测的是"要不要上 ANN"，不是绝对性能。

const DIM = 512;
const SIZES = [5_000, 20_000, 50_000, 120_000];
const RUNS = 3;

function makeVec(seed) {
  const v = new Float32Array(DIM);
  let s = seed >>> 0;
  for (let i = 0; i < DIM; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    v[i] = s / 2 ** 32 - 0.5;
  }
  return v;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
}

function bench(n) {
  const db = new Array(n);
  for (let i = 0; i < n; i++) db[i] = makeVec(i + 1);
  const q = makeVec(999_999);
  let qn = 0;
  for (let i = 0; i < DIM; i++) qn += q[i] * q[i];
  qn = Math.sqrt(qn) || 1;

  const times = [];
  let top = -2;
  for (let r = 0; r < RUNS; r++) {
    const t0 = process.hrtime.bigint();
    top = -2;
    for (let i = 0; i < n; i++) {
      const s = dot(q, db[i]) / qn;
      if (s > top) top = s;
    }
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  return { n, med: times[Math.floor(RUNS / 2)], per: times[Math.floor(RUNS / 2)] / n, top };
}

console.log("noryth 向量暴力扫描基准 · Float32Array · " + DIM + " 维 · " + RUNS + " 次中位数");
console.log("n".padEnd(10) + "p50(ms)".padStart(10) + "µs/条".padStart(10) + "内存(MB)".padStart(12));
let buf = null;
for (const n of SIZES) {
  const r = bench(n);
  buf = n * DIM * 4 / 1024 / 1024;
  console.log(
    String(n).padEnd(10) +
    r.med.toFixed(1).padStart(10) +
    r.per.toFixed(2).padStart(10) +
    buf.toFixed(0).padStart(12)
  );
}

// 线性外推（µs/条 用 20000 条的实测值）
const perUs = bench(20_000).per * 1000;
console.log("\n线性外推:");
for (const n of [50_000, 120_000, 500_000, 1_000_000]) {
  console.log(`  n=${String(n).padEnd(8)} ≈ ${(perUs * n / 1000).toFixed(0)} ms   内存 ${(n * DIM * 4 / 1024 / 1024).toFixed(0)} MB`);
}
