import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();

  const configService = app.get(ConfigService);

  const port = (configService.get('API_PORT') as number) ?? 3000;

  await app.listen(port);
}
void bootstrap();
