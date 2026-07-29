import test from "node:test";
import assert from "node:assert/strict";
import { agentLoop } from "../agent.js";

const emptyState = {
  getWalletBalances: async () => ({ sol: 2 }),
  getMyPositions: async () => ({ authoritative: true, total_positions: 0, positions: [] }),
};

function completionSequence(messages) {
  let i = 0;
  return async () => ({ choices: [{ message: messages[i++] }] });
}

test("SCREENER may return NO_DEPLOY without calling a tool", async () => {
  let toolCalls = 0;
  const result = await agentLoop("SCREENING CYCLE: choose a pool or NO_DEPLOY", 2, [], "SCREENER", "test", 256, {
    dependencies: {
      ...emptyState,
      createChatCompletion: completionSequence([{ role: "assistant", content: "⛔ NO DEPLOY" }]),
      executeTool: async () => { toolCalls += 1; return { success: true }; },
    },
  });
  assert.equal(result.content, "⛔ NO DEPLOY");
  assert.equal(toolCalls, 0);
});

test("atomically reserves deploy and serializes mutations while reads may overlap", async () => {
  const events = [];
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  let completionCount = 0;
  const createChatCompletion = async () => {
    completionCount += 1;
    if (completionCount === 1) return { choices: [{ message: {
      role: "assistant", content: null, tool_calls: [
        { id: "r1", function: { name: "get_wallet_balance", arguments: "{}" } },
        { id: "d1", function: { name: "deploy_position", arguments: "{\"pool_address\":\"pool\"}" } },
        { id: "d2", function: { name: "deploy_position", arguments: "{\"pool_address\":\"pool\"}" } },
        { id: "c1", function: { name: "close_position", arguments: "{\"position_address\":\"position\"}" } },
      ],
    } }] };
    return { choices: [{ message: { role: "assistant", content: "done" } }] };
  };
  const executeTool = async (name) => {
    events.push(`${name}:start`);
    if (name === "get_wallet_balance") await readGate;
    if (name === "deploy_position") await new Promise(resolve => setTimeout(resolve, 10));
    events.push(`${name}:end`);
    return { success: true };
  };
  const promise = agentLoop("deploy", 2, [], "GENERAL", "test", 256, {
    dependencies: { ...emptyState, createChatCompletion, executeTool },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.deepEqual(events.slice(0, 2), ["get_wallet_balance:start", "deploy_position:start"]);
  releaseRead();
  await promise;
  assert.equal(events.filter(x => x === "deploy_position:start").length, 1);
  assert.ok(events.indexOf("close_position:start") > events.indexOf("deploy_position:end"));
});

test("a failed deploy cannot be reported as deployed by orchestration outcome normalization", async () => {
  const result = await agentLoop("deploy", 2, [], "SCREENER", "test", 256, {
    autonomousDeploymentPlans: { pool: { __trustedAutonomousPlan: true, pool_address: "pool" } },
    dependencies: {
      ...emptyState,
      createChatCompletion: completionSequence([
        { role: "assistant", content: null, tool_calls: [{ id: "d1", function: { name: "deploy_position", arguments: "{\"pool_address\":\"pool\"}" } }] },
        { role: "assistant", content: "🚀 DEPLOYED fake" },
      ]),
      executeTool: async () => ({ success: false, error: "chain rejected" }),
    },
  });
  assert.doesNotMatch(result.content, /🚀\s*DEPLOYED/i);
  assert.match(result.content, /failed|chain rejected/i);
});

test("manager tool bindings prevent an instruction from closing another position", async () => {
  let executedArgs = null;
  await agentLoop("evaluate instruction", 2, [], "MANAGER", "test", 256, {
    toolArgBindings: { close_position: { position_address: "allowed-position" } },
    dependencies: {
      ...emptyState,
      createChatCompletion: completionSequence([
        { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "close_position", arguments: "{\"position_address\":\"other-position\"}" } }] },
        { role: "assistant", content: "closed" },
      ]),
      executeTool: async (_name, args) => { executedArgs = args; return { success: true }; },
    },
  });
  assert.equal(executedArgs.position_address, "allowed-position");
});

test("successful deploy status is generated from the real tool outcome", async () => {
  const result = await agentLoop("deploy", 2, [], "SCREENER", "test", 256, {
    autonomousDeploymentPlans: { pool: { __trustedAutonomousPlan: true, pool_address: "pool" } },
    dependencies: {
      ...emptyState,
      createChatCompletion: completionSequence([
        { role: "assistant", content: null, tool_calls: [{ id: "d1", function: { name: "deploy_position", arguments: "{\"pool_address\":\"pool\"}" } }] },
        { role: "assistant", content: "⛔ NO DEPLOY" },
      ]),
      executeTool: async () => ({ success: true, pool: "pool", position: "position", tx: "tx" }),
    },
  });
  assert.match(result.content, /^🚀 DEPLOYED — VERIFIED TOOL RESULT/);
  assert.match(result.content, /position/);
  assert.doesNotMatch(result.content, /^⛔ NO DEPLOY/);
});

test("partial on-chain deploy is reported as partial rather than full success or no deploy", async () => {
  const result = await agentLoop("deploy", 2, [], "SCREENER", "test", 256, {
    autonomousDeploymentPlans: { pool: { __trustedAutonomousPlan: true, pool_address: "pool" } },
    dependencies: {
      ...emptyState,
      createChatCompletion: completionSequence([
        { role: "assistant", content: null, tool_calls: [{ id: "d1", function: { name: "deploy_position", arguments: "{\"pool_address\":\"pool\"}" } }] },
        { role: "assistant", content: "🚀 DEPLOYED" },
      ]),
      executeTool: async () => ({ success: true, partial: true, pool: "pool", position: "position", warning: "second leg failed" }),
    },
  });
  assert.match(result.content, /^⚠️ PARTIAL DEPLOY — VERIFIED TOOL RESULT/);
  assert.match(result.content, /second leg failed/);
  assert.doesNotMatch(result.content, /^🚀 DEPLOYED/);
});
