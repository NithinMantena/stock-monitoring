import { DeskClient } from "../client/desk-client.ts";
let accessToken = "";
export function setAccessToken(token: string) {
  accessToken = token;
}
const configured = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");
const base = configured.endsWith("/v1") ? configured : configured + "/v1";
const client = new DeskClient(
  base,
  () => accessToken,
  (...args) => fetch(...args),
);
export function api<T = any>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  return client.request(body === undefined ? "GET" : method, path, { body });
}
export function apiText(path: string): Promise<string> {
  return client.request("GET", path, { text: true });
}
