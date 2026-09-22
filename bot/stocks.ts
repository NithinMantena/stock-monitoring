import { readFileSync } from "node:fs";
import { configuredClient } from "../client/config.ts";
import { operations, executeOperation } from "../client/operations.ts";
import { DeskError } from "../client/desk-client.ts";
const [name, file] = process.argv.slice(2);
if (!name || name === "help")
  console.log(
    JSON.stringify(
      operations.map((o) => ({
        name: o.name,
        description: o.description,
        scope: o.scope,
      })),
      null,
      2,
    ),
  );
else {
  try {
    const operation = operations.find((o) => o.name === name);
    if (!operation)
      throw new Error(
        "Unknown command. Run help for the supported operations.",
      );
    const input = file
      ? JSON.parse(readFileSync(file, "utf8"))
      : JSON.parse(readFileSync(0, "utf8") || "{}");
    console.log(
      JSON.stringify(
        await executeOperation(configuredClient("openclaw"), operation, input),
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        error:
          e instanceof DeskError
            ? { message: e.message, code: e.code, requestKey: e.requestKey }
            : { message: (e as Error).message },
      }),
    );
    process.exitCode = 1;
  }
}
