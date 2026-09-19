// Process entry: builds the app (api/server.ts) and listens on $PORT (Cloud Run sets it).
import server from './api/server.js';

const port = Number(process.env.PORT) || 8000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Poken listening on http://0.0.0.0:${port}`);
});
