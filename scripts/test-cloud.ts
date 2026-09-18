import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const keys = JSON.parse(
  readFileSync(".local/supabase-keys.json", "utf8").replace(/^\uFEFF/, ""),
);
const setup = JSON.parse(readFileSync(".local/cloud-setup.json", "utf8"));
const admin = createClient(
  setup.url,
  keys.find((k: any) => k.name === "service_role").api_key,
  { auth: { persistSession: false } },
);
const anon = createClient(
  setup.url,
  keys.find((k: any) => k.name === "anon").api_key,
  { auth: { persistSession: false } },
);
const unauth = await fetch(setup.url + "/functions/v1/desk/bootstrap");
if (unauth.status !== 401)
  throw new Error(`Unauthenticated API status: ${unauth.status}`);
const { error: privateError, data: privateData } = await anon
  .from("desk_records")
  .select("id");
if (!privateError && privateData?.length)
  throw new Error("Anonymous data exposure");
const { data: link, error } = await admin.auth.admin.generateLink({
  type: "magiclink",
  email: "nithin@mantena.com",
});
if (error) throw new Error("Test session generation failed.");
const { data: auth, error: authError } = await anon.auth.verifyOtp({
  type: "magiclink",
  token_hash: link.properties.hashed_token,
});
if (authError || !auth.session) throw new Error("Test authentication failed.");
const headers = {
  Authorization: `Bearer ${auth.session.access_token}`,
  "Content-Type": "application/json",
};
const call = async (path: string, body?: any) => {
  const response = await fetch(setup.url + "/functions/v1/desk" + path, {
    headers,
    method: body ? "POST" : "GET",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      `${path}: ${response.status} ${result.error || result.message}`,
    );
  return result;
};
const state = await call("/bootstrap");
console.log(
  JSON.stringify({
    unauthenticatedBlocked: true,
    anonymousDatabaseBlocked: true,
    cloudBootstrap: true,
    typeSafeConnected: state.configuration.typesafe,
    stagedImports: state.imports.length,
  }),
);
if (process.argv.includes("--model")) {
  const created = await call("/companies", {
    name: "Synthetic Example Insurance",
    status: "inbox",
  });
  try {
    const result = await call(`/companies/${created.id}/analyze`, {
      title: "Synthetic Example Insurance cuts earnings guidance",
      text: "Synthetic Example Insurance announced that its annual profit forecast has fallen by 30 percent after a large increase in motor insurance claims. Management said the adverse claims trend is continuing. This is fictional test data.",
      url: "",
      publishedAt: new Date().toISOString(),
    });
    console.log(
      JSON.stringify({
        liveModelTest: true,
        priority: result.priority,
        model: result.classification?.model,
        evidenceAttached: !!result.evidence,
        error: result.classification?.error || null,
      }),
    );
    if (!result.classification?.model)
      throw new Error("TypeSafe screening did not complete.");
  } finally {
    const { data: events } = await admin
      .from("desk_records")
      .select("id,data")
      .eq("owner_id", setup.owner)
      .eq("kind", "event");
    for (const event of events || [])
      if (event.data.companyId === created.id)
        await admin
          .from("desk_records")
          .delete()
          .eq("owner_id", setup.owner)
          .eq("kind", "event")
          .eq("id", event.id);
    await admin
      .from("desk_records")
      .delete()
      .eq("owner_id", setup.owner)
      .eq("kind", "company")
      .eq("id", created.id);
  }
}
await anon.auth.signOut({ scope: "local" });
