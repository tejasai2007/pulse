import { McpApplicationFactory } from '@nitrostack/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  process.env.NITROSTACK_APP_MODE ??= 'universal';
  const app = await McpApplicationFactory.create(AppModule);
  await app.start();
}

bootstrap().catch((error: unknown) => {
  console.error('Failed to start Pulse MCP server:', error);
  process.exit(1);
});
