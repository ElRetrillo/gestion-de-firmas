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

  // Soporte de payloads JSON/Base64 hasta 15MB para permitir archivos de hasta 5MB según protocolo FirmaGob v2
  app.use(json({ limit: '15mb' }));
  app.use(urlencoded({ extended: true, limit: '15mb' }));

  // Cabeceras de seguridad HTTP estándar (Equivalente Helmet sin dependencias externas)
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Validación estricta de DTOs según lineamiento de ciberseguridad
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );

  // Configuración de CORS institucional
  const corsOriginsEnv = process.env.CORS_ORIGINS;
  let allowedOrigins: string | string[] | boolean = true;
  if (corsOriginsEnv) {
    if (corsOriginsEnv === '*') {
      allowedOrigins = '*';
    } else {
      allowedOrigins = corsOriginsEnv.split(',').map((o) => o.trim());
    }
  } else {
    // Orígenes predeterminados de desarrollo y pasarela
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

  // Documentación OpenAPI / Swagger
  const config = new DocumentBuilder()
    .setTitle('Sistema de Gestión de Firmas y Telemetría de Tokens - I. Municipalidad de Coquimbo')
    .setDescription(
      'API Core Institucional conforme a Ley N° 19.799 (FEA), Ley N° 21.180 (Transformación Digital), Ley N° 21.663 (ANCI) e ISO/IEC 27001.',
    )
    .setVersion('2.0.0')
    .addTag('Autenticación y RBAC')
    .addTag('Telemetría USB')
    .addTag('Orquestación de Firmas y Checksign')
    .addTag('Usuarios e Identidades Digitales')
    .addTag('Equipamiento USB y Actas de Custodia')
    .addTag('Auditoría Forense ANCI y Trazabilidad JSONB')
    .addTag('Integraciones Externas y Webhooks HMAC')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3001;
  await app.listen(port);
  logger.log(`Servidor Backend Core ejecutándose en el puerto ${port}`);
  logger.log(`Documentación Swagger disponible en http://localhost:${port}/api/docs`);
}

bootstrap();
