import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Keep privileged keys and the temporary owner session in memory only.
export async function cloudSession() {
  const keys = JSON.parse(
    execFileSync(
      "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        "npx.cmd supabase projects api-keys --project-ref tcfricxifanwwzgxgexj --reveal --output json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  const setup = JSON.parse(readFileSync(".local/cloud-setup.json", "utf8"));
  const admin = createClient(
    setup.url,
    keys.find((k: any) => k.name === "service_role").api_key,
    { auth: { persistSession: false } },
  );
  const client = createClient(
    setup.url,
    keys.find((k: any) => k.name === "anon").api_key,
    { auth: { persistSession: false } },
  );
  const { data: link, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: "nithin@mantena.com",
  });
  if (error) throw new Error("Unable to create maintenance session.");
  const { data: auth, error: authError } = await client.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  if (authError || !auth.session)
    throw new Error("Maintenance authentication failed.");
  const call = async (path: string, body?: unknown, method = "POST") => {
    const response = await fetch(setup.url + "/functions/v1/desk" + path, {
      method: body === undefined ? "GET" : method,
      headers: {
        Authorization: `Bearer ${auth.session!.access_token}`,
        "Content-Type": "application/json",
        ...(path.startsWith("/v1/") && body !== undefined ? { "Idempotency-Key": crypto.randomUUID() } : {}),
        Origin: "https://research-desk-2p0.pages.dev",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        `${path}: ${response.status} ${data.error || data.message}`,
      );
    return data;
  };
  return {
    admin,
    owner: setup.owner,
    call,
    close: () => client.auth.signOut({ scope: "local" }),
  };
}
