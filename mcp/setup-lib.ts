import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
export const configDirectory = join(homedir(), ".config", "stock-monitoring");
export const imageName = "stock-monitoring-mcp:local";
export function dockerCommand() {
  return (
    [
      join(
        process.env.LOCALAPPDATA || "",
        "Programs",
        "DockerDesktop",
        "resources",
        "bin",
        "docker.exe",
      ),
      join(
        process.env.ProgramFiles || "C:\\Program Files",
        "Docker",
        "Docker",
        "resources",
        "bin",
        "docker.exe",
      ),
    ].find(existsSync) || "docker"
  );
}
export function run(command: string, args: string[], input?: string) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    input,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed (exit ${result.status ?? "unavailable"}).`,
    );
  return result.stdout.trim();
}
export function writePrivateConfig(channel: string, config: unknown) {
  if (!["mcp", "openclaw"].includes(channel))
    throw new Error("Unknown connection channel.");
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const sid = run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ]);
    if (!/^S-1-[\d-]+$/.test(sid))
      throw new Error("Cannot determine private file permissions.");
    run("icacls.exe", [
      configDirectory,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
    ]);
  } else chmodSync(configDirectory, 0o700);
  const path = join(configDirectory, `${channel}.json`),
    temp = join(configDirectory, `${crypto.randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, path);
  return path;
}
export function serverDefinition(url: string) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:")
    throw new Error("Docker configuration requires an HTTPS API.");
  return {
    name: "stock-monitoring",
    title: "Research Desk / Stock Monitoring",
    type: "server",
    image: imageName,
    description:
      "Read and update private stock research, watch points, alerts, news and background jobs.",
    env: [{ name: "STOCK_DESK_URL", value: url }],
    secrets: [
      {
        name: "stock-monitoring.api_token",
        env: "STOCK_DESK_TOKEN",
        example: "smt_integration_token",
      },
    ],
    allowHosts: [`${endpoint.hostname}:443`],
  };
}
