import { createApp } from './app';
import { loadEnv } from './config/env';
import { createLogger } from './lib/logger';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const app = createApp(env, logger);

app.listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT }, 'api listening');
});
