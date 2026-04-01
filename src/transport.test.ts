import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer } from "./server.js";

/** Extract JSON-RPC message from an SSE response body. */
function parseSSE(text: string): Record<string, unknown> {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6));
    }
  }
  throw new Error("No data line found in SSE response");
}

const MCP_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
};

describe("HTTP transport layer", () => {
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    const server = await startTestServer();
    serverUrl = server.url;
    closeServer = server.close;
  });

  afterAll(async () => {
    await closeServer();
  });

  it("GET /health returns 200 with status and agent count", async () => {
    const response = await fetch(`${serverUrl}/health`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(typeof body.agents).toBe("number");
    expect(body.agents).toBe(0);
  });

  it("POST /mcp with MCP initialize returns valid response", async () => {
    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    };

    const response = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(initRequest),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    const body = text.startsWith("{") ? JSON.parse(text) : parseSSE(text);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result).toBeDefined();
    const result = body.result as Record<string, unknown>;
    expect(result.protocolVersion).toBeDefined();
    expect(result.serverInfo).toBeDefined();
    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe("cross-review-mcp");
  });

  it("unknown endpoint returns 404", async () => {
    const response = await fetch(`${serverUrl}/unknown`);
    expect(response.status).toBe(404);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });

  it("server shuts down cleanly", async () => {
    const server = await startTestServer();
    await expect(server.close()).resolves.toBeUndefined();
  });
});
