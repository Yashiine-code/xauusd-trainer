import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve("data/r2-poc");
const bucket = process.env.R2_MARKET_BUCKET ?? "xauusd-market-data";
const wrangler = path.resolve("node_modules/.bin/wrangler");

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }));
  return nested.flat();
}

function upload(file) {
  const key = path.relative(root, file).split(path.sep).join("/");
  return new Promise((resolve, reject) => {
    const child = spawn(wrangler, [
      "r2", "object", "put", `${bucket}/${key}`,
      "--file", file,
      "--content-type", "application/json",
      "--cache-control", "public, max-age=31536000, immutable",
      "--remote",
    ], { stdio: "inherit", env: { ...process.env, WRANGLER_LOG_PATH: "/private/tmp/xauusd-r2-upload.log" } });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Upload failed for ${key} (${code}).`)));
  });
}

const files = (await filesBelow(root)).filter((file) => file.endsWith(".json"));
for (let index = 0; index < files.length; index += 4) {
  await Promise.all(files.slice(index, index + 4).map(upload));
}
console.log(`Uploaded ${files.length} immutable POC objects to ${bucket}.`);
