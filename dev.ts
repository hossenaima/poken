// Local dev only. In production Vercel imports api/server.ts and listens itself.
import server from './api/server.js';

const port = Number(process.env.PORT) || 8000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Poken dev server on http://localhost:${port}`);
});
