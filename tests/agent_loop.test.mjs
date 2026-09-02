// Guards the agent loop's ANSWER GUARANTEE. Regression: the last allowed round could
// spend itself on tool calls, then the loop exited with results in hand but no answer —
// the tech got "finished without producing an answer" and all tool work was wasted.
// Stub provider here ignores tool_choice:"none" (as some do) to force that path.
// Run: node tests/agent_loop.test.mjs
// Scenario: the model ignores tool_choice:"none" and keeps emitting tool_calls on every
// round EXCEPT when it's the answer-only follow-up. Old code -> "no answer" error.
import http from "http";

let calls = 0, sawNoneAfterToolResults = false;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls++;
    const parsed = JSON.parse(body);
    const toolChoice = parsed.tool_choice;
    const lastMsgs = JSON.stringify(parsed.messages).includes("No more tool calls are available");
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (toolChoice === "none" && lastMsgs) {
      sawNoneAfterToolResults = true;
      // finally answer
      res.write('data: {"choices":[{"delta":{"content":"Bottom line: Do now — pull 0.2 AC. Verify — 3.4. Watch — FAf."},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    } else {
      // stubbornly call a tool every time (simulates ignoring tool_choice none)
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c'+calls+'","type":"function","function":{"name":"get_aggregates","arguments":"{}"}}]},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

process.env.XAI_API_KEY = "test";
process.env.XAI_MODEL = "grok-test";
const mod = await import("../netlify/functions/agent.mjs");
// point the module's xAI URL at our stub
const src = await import("fs");
// no way to patch the const, so intercept via global fetch
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => String(url).includes("api.x.ai")
  ? realFetch("http://127.0.0.1:" + port, opts)
  : realFetch(url, opts);

const res = await mod.default(new Request("http://x/", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "grok", messages: [{ role: "user", content: "voids low on the 0.38A, what do I change?" }] }),
}));
const text = await res.text();
const gotAnswer = /Bottom line/.test(text);
const gotError = /finished without producing an answer/.test(text);
console.log("provider calls:", calls);
console.log("answer-only retry fired:", sawNoneAfterToolResults ? "yes" : "no");
console.log("final answer streamed:", gotAnswer ? "YES ✓" : "no ✗");
console.log("error shown to tech:", gotError ? "YES ✗" : "no ✓");
server.close();
if (!gotAnswer || gotError) { console.log("\nFAIL — loop still loses the answer"); process.exit(1); }
console.log("\nPASS — tool work is never thrown away; tech always gets an answer");
