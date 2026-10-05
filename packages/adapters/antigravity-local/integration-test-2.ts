import { execute } from "./src/server/execute.js";

async function run() {
  const ctx = {
    runId: "test-run-id",
    agent: {
      id: "test-agent",
      companyId: "test-company",
      adapterConfig: { promptTemplate: "{{context.paperclipWake}}" }
    },
    context: {
      paperclipWake: "Reply only with: ANTIGRAVITY_PAPERCLIP_OK"
    },
    onLog: async (stream, chunk) => {
      // console.log(`[ONLOG ${stream}]`, chunk);
    },
    logger: console
  };

  try {
    const result = await execute(ctx as any);
    console.log("EXECUTE RESULT:", result);
  } catch (err) {
    console.error("EXECUTE ERROR:", err);
  }
}

run();