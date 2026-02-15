import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { EnvConfig } from './config/env.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));

  const config = app.get(ConfigService<EnvConfig, true>);

  const allowedOrigins = config.get('ALLOWED_ORIGINS').split(',').map((o: string) => o.trim().replace(/\/+$/, ''));
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  const port = config.get('PORT');
  await app.listen(port);
  console.log(`Helius WS proxy listening on :${port}`);

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      console.log(`${sig} received, shutting down…`);
      await app.close();
      process.exit(0);
    });
  }
}

bootstrap();
