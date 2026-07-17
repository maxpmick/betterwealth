interface StaticFile extends Blob {
  exists(): Promise<boolean>;
}

interface BunRuntime {
  argv: string[];
  file(path: string | URL): StaticFile;
  serve(options: {
    hostname: string;
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): unknown;
}

const bun = (globalThis as typeof globalThis & { Bun: BunRuntime }).Bun;
// Containers need 0.0.0.0 and a service-name upstream; loopback defaults keep the
// bare-metal systemd layout unchanged.
const hostname = process.env.WEB_HOST ?? "127.0.0.1";
const port = Number(process.env.WEB_PORT ?? bun.argv[2] ?? 4173);
const apiUpstream = process.env.API_UPSTREAM_ORIGIN ?? "http://127.0.0.1:3001";
const index = bun.file(new URL("./dist/index.html", import.meta.url));

if (!(await index.exists())) {
  throw new Error("Missing dist/index.html. Run the production build before serving.");
}

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

bun.serve({
  hostname,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/v1")) {
      const upstream = new URL(`${url.pathname}${url.search}`, apiUpstream);
      const headers = new Headers(request.headers);
      headers.delete("host");
      const init: RequestInit = { method: request.method, headers, redirect: "manual" };
      if (!["GET", "HEAD"].includes(request.method)) init.body = await request.arrayBuffer();
      try {
        const response = await fetch(upstream, init);
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("X-Content-Type-Options", "nosniff");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      } catch {
        return Response.json(
          { error: { code: "API_UNAVAILABLE", message: "The API process is unavailable." } },
          { status: 502, headers: securityHeaders },
        );
      }
    }
    const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const requestedFile = bun.file(new URL(`./dist/${relativePath}`, import.meta.url));

    if (await requestedFile.exists()) {
      return new Response(requestedFile, { headers: securityHeaders });
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "API route is not served by the web process." } },
        { status: 404, headers: securityHeaders },
      );
    }

    return new Response(index, {
      headers: { ...securityHeaders, "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.info(`BetterWealth web is listening on http://${hostname}:${port}`);
