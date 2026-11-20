export function cleanRut(rut: string): string {
  return (rut || '').replace(/[^0-9kK]/g, '').toUpperCase();
}

export function formatRut(value: string): string {
  const clean = cleanRut(value).slice(0, 9);
  if (!clean) return '';
  if (clean.length <= 1) return clean;

  const dv = clean.slice(-1);
  const cuerpo = clean.slice(0, -1);

  let cuerpoFormateado = '';
  let count = 0;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    cuerpoFormateado = cuerpo[i] + cuerpoFormateado;
    count++;
    if (count === 3 && i > 0) {
      cuerpoFormateado = '.' + cuerpoFormateado;
      count = 0;
    }
  }
  return `${cuerpoFormateado}-${dv}`;
}

export function getRutVariants(query: string): string[] {
  const clean = cleanRut(query);
  const variants = new Set<string>();
  const trimmed = (query || '').trim();
  if (trimmed) variants.add(trimmed);

  if (clean.length >= 4) {
    const dv = clean.slice(-1);
    const cuerpo = clean.slice(0, -1);
    let f1 = '';
    let count = 0;
    for (let i = cuerpo.length - 1; i >= 0; i--) {
      f1 = cuerpo[i] + f1;
      count++;
      if (count === 3 && i > 0) {
        f1 = '.' + f1;
        count = 0;
      }
    }
    variants.add(`${f1}-${dv}`);

    let f2 = '';
    count = 0;
    for (let i = clean.length - 1; i >= 0; i--) {
      f2 = clean[i] + f2;
      count++;
      if (count === 3 && i > 0) {
        f2 = '.' + f2;
        count = 0;
      }
    }
    variants.add(f2);
  }

  return Array.from(variants);
}

export function matchesRutSearch(rutValue: string, query: string): boolean {
  if (!query || !query.trim()) return true;
  const qTrim = query.trim().toLowerCase();
  const qClean = cleanRut(query);
  const rClean = cleanRut(rutValue);

  if (qClean.length > 0 && rClean.includes(qClean)) {
    return true;
  }
  return (rutValue || '').toLowerCase().includes(qTrim);
}
