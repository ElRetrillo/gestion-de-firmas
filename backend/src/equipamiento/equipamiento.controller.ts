import { Controller, Get, Post, Body, Param, Res } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { EquipamientoService, CrearTokenDto, CrearActaCustodiaDto } from './equipamiento.service';
import { Response } from 'express';

@ApiTags('Equipamiento USB y Actas de Custodia')
@Controller('api/v1/equipamiento')
export class EquipamientoController {
  constructor(private readonly equipamientoService: EquipamientoService) {}

  @Get('tokens')
  @ApiOperation({ summary: 'Inventario patrimonial de tokens criptográficos USB' })
  async listarTokens() {
    return this.equipamientoService.listarTokens();
  }

  @Post('tokens')
  @ApiOperation({ summary: 'Registrar nuevo token criptográfico USB en inventario' })
  async crearToken(@Body() dto: CrearTokenDto) {
    return this.equipamientoService.registrarToken(dto);
  }

  @Get('actas')
  @ApiOperation({ summary: 'Listado de actas digitales de custodia (entrega, devolución, traspaso, baja)' })
  async listarActas() {
    return this.equipamientoService.listarActasCustodia();
  }

  @Post('actas')
  @ApiOperation({ summary: 'Generar y firmar digitalmente una nueva acta de custodia de token USB' })
  async crearActa(@Body() dto: CrearActaCustodiaDto) {
    return this.equipamientoService.crearActaCustodia(dto);
  }

  @Get('actas/:id/pdf')
  @ApiOperation({ summary: 'Descargar PDF oficial firmado del acta de custodia (generado con pdf-lib)' })
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
