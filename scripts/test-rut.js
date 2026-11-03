const { getRutVariants, matchesRutSearch, formatRut } = require('c:/Users/Daniel UCN/gestion-de-firmas/backend/dist/common/rut.util.js');

console.log('--- Testing Camila Herrera Pasten (19.999.485-4) ---');
console.log('Unformatted input: 199994854');
console.log('formatRut("199994854"):', formatRut('199994854'));
console.log('getRutVariants("199994854"):', getRutVariants('199994854'));
console.log('matchesRutSearch("19.999.485-4", "199994854"):', matchesRutSearch('19.999.485-4', '199994854'));
console.log('matchesRutSearch("19.999.485-4", "19999485"):', matchesRutSearch('19.999.485-4', '19999485'));
console.log('matchesRutSearch("19.999.485-4", "19.999"):', matchesRutSearch('19.999.485-4', '19.999'));

console.log('\n--- Testing User Prompt Example: 12312312 ---');
console.log('getRutVariants("12312312"):', getRutVariants('12312312'));
console.log('matchesRutSearch("12.312.312-K", "12312312"):', matchesRutSearch('12.312.312-K', '12312312'));
console.log('matchesRutSearch("12.312.312-5", "12312312"):', matchesRutSearch('12.312.312-5', '12312312'));
console.log('matchesRutSearch("21.374.808-4", "12312312"):', matchesRutSearch('21.374.808-4', '12312312'));
