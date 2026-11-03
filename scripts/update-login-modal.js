const fs = require('fs');

const path = 'c:/Users/Daniel UCN/gestion-de-firmas-frontend/src/components/LoginModal.tsx';
let content = fs.readFileSync(path, 'utf8');

// Add formatRut import if not present
if (!content.includes("from '../lib/rut'")) {
  content = content.replace(
    "import { Badge } from './ui/badge';",
    "import { Badge } from './ui/badge';\nimport { formatRut } from '../lib/rut';"
  );
}

// Update onChange in Login input
content = content.replace(
  'onChange={(e) => setRut(e.target.value)}',
  'onChange={(e) => setRut(formatRut(e.target.value))}'
);

// Update payload in handleLogin
content = content.replace(
  'rut: rut.trim(),',
  'rut: formatRut(rut.trim()) || rut.trim(),'
);

fs.writeFileSync(path, content, 'utf8');
console.log('LoginModal.tsx updated successfully');
