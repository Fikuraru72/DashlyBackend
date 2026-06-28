import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json, urlencoded } from 'express';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Apply Global Exception Filter
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Increase payload size limit to 50mb for large GeoJSON & Base64 images
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ extended: true, limit: '50mb' }));

  // 1. Enable CORS agar Flutter tidak diblokir browser/engine
  app.enableCors();
  // 2. Listen di 0.0.0.0 agar bisa diakses oleh IP 192.168.x.x
  const port = process.env.PORT ?? 3001; // Tetap gunakan port dari .env (3001)
  await app.listen(port, '0.0.0.0');

  console.log(`Application is running on: http://0.0.0.0:${port}`);
}
bootstrap();
