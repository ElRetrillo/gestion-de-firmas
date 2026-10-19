import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Validación de DTOs según lineamiento de ciberseguridad
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );

  // Configuración de CORS institucional
  app.enableCors({
    origin: '*',
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
    .addTag('Autenticación, OIDC y Seguridad eHSM')
    .addTag('Telemetría USB')
    .addTag('Orquestación de Firmas y Checksign')
    .addTag('Usuarios e Identidades Digitales')
    .addTag('Equipamiento Criptográfico y Actas de Custodia')
    .addTag('Auditoría Forense e Historial Inmutable (ANCI)')
    .addTag('Integraciones Externas y Webhooks (HMAC-SHA256)')
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
