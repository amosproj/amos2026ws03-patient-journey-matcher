import { McpServer } from "@modelcontextprotocol/server";
import { expect, test } from "vitest";

test("creates a server with the v2 MCP SDK", () => {
  const server = new McpServer({ name: "mcp-server", version: "0.1.0" });
  expect(server).toBeInstanceOf(McpServer);
});
