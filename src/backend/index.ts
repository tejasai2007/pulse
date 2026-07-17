import { loadRuntimeConfig } from '../config.js';
import { createBackend } from './server.js';

const config = loadRuntimeConfig();
const { server, logger } = createBackend(config);

server.listen(config.BACKEND_PORT, config.BACKEND_HOST, () => {
  logger.info('Backend listening', {
    boundary: 'startup',
    host: config.BACKEND_HOST,
    port: config.BACKEND_PORT
  });
});

server.on('error', (error) => {
  logger.error('Backend failed', { boundary: 'startup', error: error.message });
  process.exitCode = 1;
});
