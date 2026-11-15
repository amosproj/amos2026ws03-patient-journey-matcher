import { once } from "node:events";
import { createServer } from "node:http";
export interface Reply {
  status?: number;
  body: string;
  type?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  disconnect?: boolean;
  chunked?: boolean;
}
export async function createProviders() {
  const routes = new Map<string, Reply[] | ((url: URL) => Reply)>();
  const requests: string[] = [];
  const unexpected: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(url.pathname);
    const replies = routes.get(url.pathname);
    const reply =
      typeof replies === "function"
        ? replies(url)
        : replies?.length
          ? replies.length > 1
            ? replies.shift()
            : replies[0]
          : undefined;
    if (!reply) {
      unexpected.push(url.pathname);
      res.writeHead(500).end("Unrecognized fixture route");
      return;
    }
    res.writeHead(reply.status ?? 200, {
      "Content-Type": reply.type ?? "text/html",
      ...reply.headers,
    });
    if (reply.disconnect) {
      res.destroy();
      return;
    }
    if (reply.delayMs) {
      const timer = setTimeout(() => res.end(reply.body), reply.delayMs);
      res.on("close", () => clearTimeout(timer));
    } else if (reply.chunked) {
      for (let offset = 0; offset < reply.body.length; offset += 8192)
        res.write(reply.body.slice(offset, offset + 8192));
      res.end();
    } else res.end(reply.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const fetchLocal = (url: string, init?: RequestInit) => {
    const target = new URL(url);
    if (
      (target.origin === "https://zenodo.org" &&
        target.pathname.startsWith("/api/records/")) ||
      target.origin === "https://fixtures.example.org" ||
      target.origin === "https://pmc-oa-opendata.s3.amazonaws.com"
    ) {
      target.host = new URL(baseUrl).host;
      target.protocol = "http:";
    } else if (target.origin !== baseUrl)
      throw new Error("Unexpected outbound destination");
    return fetch(target, { ...init, redirect: "error" });
  };
  return {
    routes,
    requests,
    unexpected,
    baseUrl,
    fetchLocal,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
