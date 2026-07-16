interface BunFile extends Blob {
  exists(): Promise<boolean>;
}

interface BunServeOptions {
  hostname?: string;
  port?: number;
  fetch(request: Request): Response | Promise<Response>;
}

declare const Bun: {
  readonly argv: string[];
  file(path: string | URL): BunFile;
  serve(options: BunServeOptions): unknown;
};
