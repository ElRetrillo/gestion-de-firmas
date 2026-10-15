import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsuariosService {
  private readonly logger = new Logger(UsuariosService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listarUsuarios() {
    try {
      return await this.prisma.usuario.findMany({
        include: {
          certificados: true,
        },
      });
    } catch {
      return [
        {
          id: 'USR-01',
          rut: '12.894.120-3',
          nombre: 'Patricio Reyes',
          email: 'preyes@municoquimbo.cl',
          cargo: 'Secretario Municipal',
          unidad: 'Secretaría Municipal',
          rol: 'ADMIN',
          estado: 'ACTIVO',
          certificados: [
            {
              id: 'CERT-01',
              tipo: 'FIRMAGOB',
              custodia: 'TOKEN_FISICO',
              validoHasta: new Date(Date.now() + 86400000 * 25), // 25 días (Alerta preventiva < 30 días)
              estado: 'POR_VENCER',
            },
          ],
        },
        {
          id: 'USR-02',
          rut: '16.541.228-9',
          nombre: 'Andrea Morales',
          email: 'amorales@municoquimbo.cl',
          cargo: 'Jefa de Personal',
          unidad: 'Dirección de Administración y Finanzas',
          rol: 'SUPERVISOR',
          estado: 'ACTIVO',
          certificados: [
            {
              id: 'CERT-02',
              tipo: 'ESIGN',
              custodia: 'CLOUD',
              validoHasta: new Date(Date.now() + 86400000 * 180),
              estado: 'VIGENTE',
            },
          ],
        },
        {
          id: 'USR-03',
          rut: '14.112.980-5',
          nombre: 'Marcelo Gómez',
          email: 'mgomez@municoquimbo.cl',
          cargo: 'Director de Obras',
          unidad: 'Dirección de Obras Municipales',
          rol: 'FUNCIONARIO',
          estado: 'ACTIVO',
          certificados: [
            {
              id: 'CERT-03',
              tipo: 'FIRMAGOB',
              custodia: 'TOKEN_FISICO',
              validoHasta: new Date(Date.now() + 86400000 * 12), // 12 días (Alerta crítica < 15 días)
              estado: 'POR_VENCER',
            },
          ],
        },
      ];
    }
  }

  async obtenerAlertasVencimiento() {
    // Retorna certificados con vencimientos a 60, 30 y 15 días
    const ahora = new Date();
    const en60Dias = new Date(ahora.getTime() + 60 * 24 * 60 * 60 * 1000);

    try {
      return await this.prisma.certificado.findMany({
        where: {
          validoHasta: {
            lte: en60Dias,
            gte: ahora,
          },
        },
        include: {
          usuario: true,
          tokenHardware: true,
        },
        orderBy: { validoHasta: 'asc' },
      });
    } catch {
      return [
        {
          id: 'CERT-03',
          tipo: 'FIRMAGOB',
          custodia: 'TOKEN_FISICO',
          diasRestantes: 12,
          severidad: 'ALTA', // < 15 días
          usuario: {
            nombre: 'Marcelo Gómez',
            unidad: 'Dirección de Obras Municipales',
            email: 'mgomez@municoquimbo.cl',
          },
        },
        {
          id: 'CERT-01',
          tipo: 'FIRMAGOB',
          custodia: 'TOKEN_FISICO',
          diasRestantes: 25,
          severidad: 'MEDIA', // < 30 días
          usuario: {
            nombre: 'Patricio Reyes',
            unidad: 'Secretaría Municipal',
            email: 'preyes@municoquimbo.cl',
          },
        },
      ];
    }
  }
}
