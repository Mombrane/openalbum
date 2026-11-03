import { createHealthServer } from './interfaces/http/server.js';

const port = Number(process.env.PORT ?? 3000);
const server = createHealthServer();

server.listen(port, () => {
  console.log(`api listening on ${port}`);
});
