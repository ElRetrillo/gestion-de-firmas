import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Request, Response, NextFunction, json, urlencoded } from 'express';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const jwtSecret = process.env.JWT_SECRET || '';
  if (!jwtSecret || jwtSecret === 'coquimbo_secret_key_ciberseguridad_2026' || jwtSecret === 'coquimbo_secret_key_2026') {
    if (process.env.NODE_ENV === 'production') {
      logger.error('CRÍTICO: JWT_SECRET no configurado o usando clave por defecto en PRODUCCIÓN.');
    } else {
      logger.warn('ADVERTENCIA: Usando JWT_SECRET por defecto de desarrollo. Cambiar para producción.');
    }
  }

  const app = await NestFactory.create(AppModule);

  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true, limit: '2mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );

  const corsOriginsEnv = process.env.CORS_ORIGINS;
  let allowedOrigins: string | string[] | boolean = true;
  if (corsOriginsEnv) {
    allowedOrigins =
      corsOriginsEnv === '*' ? '*' : corsOriginsEnv.split(',').map((o) => o.trim());
  } else {
    allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:80',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
    ];
  }

  app.enableCors({
    origin: allowedOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  const config = new DocumentBuilder()
    .setTitle('Sistema de Monitoreo y Telemetría de Tokens USB - I. Municipalidad de Coquimbo')
    .setDescription(
      'API de Monitoreo en Tiempo Real, Telemetría USB, Alertas de Vencimiento y Auditoría de Tokens Criptográficos.',
    )
    .setVersion('2.0.0')
    .addTag('Autenticación')
    .addTag('Telemetría USB')
    .addTag('Usuarios y Alertas')
    .addTag('Auditoría')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3001;
  await app.listen(port);
  logger.log(`Servidor Backend ejecutándose en el puerto ${port}`);
  logger.log(`Documentación Swagger disponible en http://localhost:${port}/api/docs`);
}

bootstrap();
