import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const root = path.resolve("site");
const port = Number(process.env.PORT || 4173);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mmd": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${port}`).pathname);
    const filename = path.join(root, pathname === "/" ? "index.html" : pathname);
    if (!filename.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const data = await readFile(filename);
    response.setHeader("Content-Type", contentTypes[path.extname(filename)] || "application/octet-stream");
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end("Not Found");
  }
}).listen(port, () => {
  console.log(`http://127.0.0.1:${port}`);
});
