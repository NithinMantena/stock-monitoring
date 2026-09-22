import { configurePacing } from "../supabase/functions/_shared/fetch-policy.ts";

// Production spaces Google requests seconds apart; tests use mocked fetches.
configurePacing({ search: 0, page: 0 });
