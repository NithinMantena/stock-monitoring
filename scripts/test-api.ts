export {};
const root = process.env.TEST_API_URL || "http://127.0.0.1:8787/api";
const bootstrap = await fetch(root + "/bootstrap");
if (!bootstrap.ok) throw new Error(`Bootstrap: ${bootstrap.status}`);
const state = await bootstrap.json();
console.log(
  JSON.stringify({
    apiReady: true,
    companies: state.companies.length,
    typesafeConfigured: state.configuration.typesafe,
    emailConfigured: state.configuration.email,
  }),
);
const forbidden = await fetch(root + "/bootstrap", {
  headers: { Origin: "https://untrusted.example" },
});
if (forbidden.status !== 403)
  throw new Error("Cross-origin local request was not blocked.");
console.log("Cross-origin protection passed.");
