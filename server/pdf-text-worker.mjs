// Reads one PDF on stdin and prints {"text", "pages"} as JSON on stdout, then exits.
// Spawned by pdfTextLayer() in materials-extract.ts as its own plain-node process. Under tsx, the
// server's runtime, pdfjs took ~510 MB to read an 8-page handout, which is over Cloud Run's
// 512 MiB and killed the container mid-request. In plain node the same read takes ~75 MB, and the
// process exiting hands all of it back. A malformed or hostile PDF can only take down this child.
import { PDFParse } from 'pdf-parse';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const parser = new PDFParse({ data: new Uint8Array(Buffer.concat(chunks)) });
try {
  const r = await parser.getText();
  process.stdout.write(JSON.stringify({ text: r?.text ?? '', pages: r?.total ?? 0 }));
} finally {
  await parser.destroy().catch(() => {});
}
