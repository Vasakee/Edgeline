import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './orchestration/global-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Global exception filter — catches all unhandled errors, never crashes
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Enable CORS for client-side API calls
  app.enableCors();

  // Graceful shutdown hooks (SIGTERM, SIGINT)
  app.enableShutdownHooks();

  const port = process.env.API_PORT ?? 3001;
  await app.listen(port);
  console.log(`API is running on http://localhost:${port}`);
  console.log(`Agent status: http://localhost:${port}/agent/status`);
}

bootstrap();
