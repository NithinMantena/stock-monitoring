import { cloudSession } from "./cloud-session.ts";
import { SupabaseStore } from "../supabase/functions/_shared/supabase-store.ts";
import { rescreenNews } from "../supabase/functions/_shared/jobs.ts";
import { SCREENING_VERSION } from "../supabase/functions/_shared/screening-policy.ts";
import type { DeskEvent } from "../supabase/functions/_shared/model.ts";
const session = await cloudSession();
try {
  const store = new SupabaseStore(session.admin, session.owner);
  if (process.argv.includes("--apply")) {
    const result = await rescreenNews(store, process.env, {
      limit: 24,
      milliseconds: 45000,
    });
    console.log(JSON.stringify({ rollout: result }));
  }
  const docs = await store.list<DeskEvent>("event", { summary: true });
  const upgraded = docs.filter(
    (d) => d.data.screening?.version === SCREENING_VERSION,
  );
  console.log(
    JSON.stringify({
      version: SCREENING_VERSION,
      upgraded: upgraded.length,
      roles: upgraded.reduce(
        (a, d) => {
          const key =
            d.data.screening?.articleRole ||
            d.data.screening?.reasonCode ||
            "unknown";
          a[key] = (a[key] || 0) + 1;
          return a;
        },
        {} as Record<string, number>,
      ),
      failures: upgraded.filter(
        (d) => d.data.screening?.reasonCode === "processing_failed",
      ).length,
    }),
  );
} finally {
  await session.close();
}
