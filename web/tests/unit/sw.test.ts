// Runs the service worker's fetch handling against fake caches and a fake network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ORIGIN = "https://example.test";
const SCOPE = ORIGIN + "/apps/tasks/";
const source = readFileSync(
  new URL("../../public/sw.js", import.meta.url),
  "utf8",
);

function worker(network: (url: string) => Response | null) {
  const stored = new Map<string, Response>();
  const key = (r: string | { url: string }) =>
    typeof r === "string" ? r : r.url;
  const cache = {
    put: async (r: string | { url: string }, res: Response) => {
      stored.delete(key(r));
      stored.set(key(r), res);
    },
    keys: async () => [...stored.keys()].map((url) => ({ url })),
    delete: async (r: { url: string }) => stored.delete(r.url),
    addAll: async () => {},
  };
  const handlers: Record<string, (event: unknown) => void> = {};
  vm.runInNewContext(source, {
    self: {
      addEventListener: (type: string, fn: (event: unknown) => void) =>
        (handlers[type] = fn),
      registration: { scope: SCOPE },
      location: { origin: ORIGIN },
    },
    caches: {
      open: async () => cache,
      match: async (r: string | { url: string }) => stored.get(key(r))?.clone(),
    },
    fetch: async (request: { url: string }) => {
      const response = network(request.url);
      if (!response) throw new TypeError("offline");
      return response;
    },
    Response,
    URL,
    Promise,
    JSON,
  });
  /** What the page receives for a request; undefined when the worker leaves it to the browser. */
  const get = async (path: string) => {
    let answer: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    handlers.fetch({
      request: { url: SCOPE + path, method: "GET", mode: "cors" },
      respondWith: (p: Promise<Response>) => (answer = p),
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    const response = await answer;
    await new Promise((resolve) => setTimeout(resolve));
    await Promise.all(waits);
    return response && (await response.clone().text());
  };
  return { get, stored };
}

test("embed.js comes from the network, with the cache as the offline copy", async () => {
  let body: string | null = "first deploy";
  const { get } = worker(() => (body ? new Response(body) : null));
  assert.equal(await get("embed.js"), "first deploy");
  body = "second deploy";
  assert.equal(await get("embed.js"), "second deploy");
  body = null;
  assert.equal(await get("embed.js"), "second deploy");
});

test("hashed files come from the cache once they are stored", async () => {
  let fetches = 0;
  const { get } = worker(() => {
    fetches++;
    return new Response("code");
  });
  assert.equal(await get("assets/App-abc.js"), "code");
  assert.equal(await get("assets/App-abc.js"), "code");
  assert.equal(fetches, 1);
});

test("old hashed files make way, and other files stay", async () => {
  const { get, stored } = worker(() => new Response("code"));
  await get("embed.js");
  for (let i = 0; i < 65; i++) await get(`assets/App-${i}.js`);
  const assets = [...stored.keys()].filter((u) => u.includes("/assets/"));
  assert.equal(assets.length, 60);
  assert.ok(assets.includes(SCOPE + "assets/App-64.js"));
  assert.ok(!assets.includes(SCOPE + "assets/App-0.js"));
  assert.ok(stored.has(SCOPE + "embed.js"));
});

test("task data is never cached", async () => {
  const { get, stored } = worker(() => new Response("[]"));
  assert.equal(await get("api/v1/tasks"), undefined);
  assert.equal(stored.size, 0);
});
