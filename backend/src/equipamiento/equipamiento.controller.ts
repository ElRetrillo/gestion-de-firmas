import { Controller, Get, Post, Body, Param, Res, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  EquipamientoService,
  CrearTokenDto,
  CrearActaCustodiaDto,
  CrearContratoTokenDto,
  AsignarTokenFirmaDto,
} from './equipamiento.service';
import { Response, Request } from 'express';
import { Public, Roles } from '../common/auth.guards';

@ApiTags('Equipamiento USB, Contratos de Tokens y Actas de Custodia')
@ApiBearerAuth()
@Controller('api/v1/equipamiento')
export class EquipamientoController {
  constructor(private readonly equipamientoService: EquipamientoService) {}

  @Get('tokens')
  @ApiOperation({ summary: 'Inventario patrimonial de tokens criptográficos USB' })
  async listarTokens() {
    return this.equipamientoService.listarTokens();
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post('tokens')
  @ApiOperation({ summary: 'Registrar nuevo token criptográfico USB en inventario' })
  async crearToken(@Body() dto: CrearTokenDto) {
    return this.equipamientoService.registrarToken(dto);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post('asignar-token')
  @ApiOperation({
    summary: 'Asignar un token criptográfico y certificado de firma a un funcionario con fecha de expiración',
  })
  async asignarToken(@Body() dto: AsignarTokenFirmaDto) {
    return this.equipamientoService.asignarTokenAFuncionario(dto);
  }

  @Public()
  @Get('contratos')
  @ApiOperation({
    summary: 'Requisito 7: Listado de contratos de obtención de tokens con fecha de inicio, caducidad y documento PDF',
  })
  async listarContratos() {
    return this.equipamientoService.listarContratos();
  }

  @Public()
  @Post('contratos')
  @ApiOperation({
    summary: 'Requisito 7: Registrar nuevo contrato individual de obtención de tokens criptográficos por funcionario',
  })
  async crearContrato(@Body() dto: CrearContratoTokenDto) {
    return this.equipamientoService.crearContrato(dto);
  }

  @Public()
  @Get('contratos/:id/pdf')
  @ApiOperation({
    summary: 'Requisito 7: Previsualizar o descargar copia en PDF del contrato de obtención de tokens',
  })
  async descargarPdfContrato(@Param('id') id: string, @Res() res: Response) {
    const buffer = await this.equipamientoService.generarPdfContrato(id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="Contrato-Tokens-${id}.pdf"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  @Get('actas')
  @ApiOperation({ summary: 'Listado de actas digitales de custodia (entrega, devolución, traspaso, baja)' })
  async listarActas() {
    return this.equipamientoService.listarActasCustodia();
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post('actas')
  @ApiOperation({ summary: 'Generar y firmar digitalmente una nueva acta de custodia de token USB' })
  async crearActa(@Body() dto: CrearActaCustodiaDto, @Req() req: Request) {
    let emisorContext: { id?: string; rut?: string; nombre?: string; cargo?: string; email?: string } | undefined;

    // 1. Extraer si req.user fue inyectado por JwtAuthGuard
    const userReq = (req as any).user;
    if (userReq) {
      emisorContext = {
        id: userReq.sub,
        rut: userReq.rut,
        email: userReq.email,
      };
    }

    // 2. Extraer si viene en cabeceras directas (ej: X-Usuario-Rut, X-Usuario-Id)
    const headerRut = (req.headers['x-usuario-rut'] as string) || (req.headers['x-user-rut'] as string);
    const headerId = (req.headers['x-usuario-id'] as string) || (req.headers['x-user-id'] as string);
    const headerNombre = (req.headers['x-usuario-nombre'] as string) || (req.headers['x-user-name'] as string);

    if (headerRut || headerId || headerNombre) {
      emisorContext = {
        id: headerId || emisorContext?.id,
        rut: headerRut || emisorContext?.rut,
        nombre: headerNombre,
        email: emisorContext?.email,
      };
    }

    return this.equipamientoService.crearActaCustodia(dto, emisorContext);
  }

  @Public()
  @Get('actas/:id/pdf')
  @ApiOperation({ summary: 'Descargar PDF oficial firmado del acta de custodia (soporta token Bearer o ?access_token=)' })
  async descargarPdfActa(@Param('id') id: string, @Res() res: Response) {
    const buffer = await this.equipamientoService.generarPdfActaCustodia(id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="Acta-Custodia-${id}.pdf"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }
}
