import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Validación estricta de DTOs según lineamiento de ciberseguridad
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
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
    .setTitle('Sistema de Gestión de Firmas y Telemetría de Tokens')
    .setDescription(
      'API Core para orquestación de firmas electrónicas (FirmaGob / ESIGN) y telemetría de hardware USB - Ilustre Municipalidad de Coquimbo',
    )
    .setVersion('1.0.0')
    .addTag('Telemetría USB')
    .addTag('Orquestación de Firmas y Checksign')
    .addTag('Usuarios e Identidades Digitales')
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
