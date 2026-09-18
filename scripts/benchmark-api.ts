import { writeFileSync } from "node:fs";
const samples: number[] = [];
let bytes = 0;
let companies = 0;
for (let i = 0; i < 31; i++) {
  const start = performance.now();
  const response = await fetch("http://127.0.0.1:8787/api/bootstrap");
  if (!response.ok) throw new Error("Benchmark API failed.");
  const text = await response.text();
  const elapsed = performance.now() - start;
  const data = JSON.parse(text);
  companies = data.companies.length;
  bytes = new TextEncoder().encode(text).byteLength;
  if (i) samples.push(elapsed);
}
samples.sort((a, b) => a - b);
const result = {
  scope:
    "Local API bootstrap, warm, includes response transfer; not a browser paint measurement",
  companies,
  payloadBytes: bytes,
  samples: samples.length,
  medianMs: Number(samples[15].toFixed(2)),
  p95Ms: Number(samples[28].toFixed(2)),
  maximumMs: Number(samples.at(-1)!.toFixed(2)),
  at: new Date().toISOString(),
};
writeFileSync(".local/performance.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
