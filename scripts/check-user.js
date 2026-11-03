const { PrismaClient } = require('c:/Users/Daniel UCN/gestion-de-firmas/backend/node_modules/@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://postgres:postgres123@localhost:5432/gestion_firmas?schema=public' } } });

async function main() {
  const users = await prisma.usuario.findMany();
  console.log('Usuarios en DB:', users.map(u => ({
    id: u.id,
    rut: u.rut,
    nombre: u.nombre,
    email: u.email,
    rol: u.rol,
    debeCambiarPassword: u.debeCambiarPassword,
    hasPasswordHash: !!u.passwordHash,
  })));
  await prisma.$disconnect();
}

main().catch(console.error);
