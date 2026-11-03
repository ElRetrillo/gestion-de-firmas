const http = require('http');

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let respData = '';
        res.on('data', (c) => (respData += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(respData || '{}') }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let respData = '';
        res.on('data', (c) => (respData += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(respData || '[]') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  console.log('1. Probando Login con RUT sin formato: 213748084');
  const loginRes = await post('http://localhost:3001/api/v1/auth/login', {
    rut: '213748084',
    password: 'yhfSNnfBYXPswsKQ#9',
  });
  console.log('Login Status:', loginRes.status);
  console.log('Usuario:', loginRes.body.usuario?.nombre, 'RUT:', loginRes.body.usuario?.rut);
  const token = loginRes.body.accessToken;

  console.log('\n2. Probando Búsqueda q=213748084');
  const search1 = await get('http://localhost:3001/api/v1/usuarios?q=213748084', token);
  console.log('Resultados q=213748084:', search1.body.map((u) => `${u.nombre} (${u.rut})`));

  console.log('\n3. Probando Búsqueda q=21374808 (parcial sin puntos ni guion)');
  const search2 = await get('http://localhost:3001/api/v1/usuarios?q=21374808', token);
  console.log('Resultados q=21374808:', search2.body.map((u) => `${u.nombre} (${u.rut})`));

  console.log('\n4. Probando Búsqueda q=21.374.808-4 (formato completo)');
  const search3 = await get('http://localhost:3001/api/v1/usuarios?q=21.374.808-4', token);
  console.log('Resultados q=21.374.808-4:', search3.body.map((u) => `${u.nombre} (${u.rut})`));
}

run().catch(console.error);
