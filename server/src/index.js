import { connectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { createApp } from './app.js';

async function start() {
  await connectDatabase();
  console.log('Connected to MongoDB');

  const app = createApp();
  app.listen(env.PORT, () => {
    console.log(`LinkVault API listening on http://localhost:${env.PORT}`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
