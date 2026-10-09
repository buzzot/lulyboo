// Prints template columns as JSON (used to build the Excel/CSV templates).
const F = require('../src/fields');
const cols = [{ csv: 'Supplier / Factory Name', cn: '工厂 / 公司名称', key: null },
  ...F.PRODUCT_FIELDS.map((f) => ({ csv: f.csv, cn: f.cn, key: f.key, type: f.type, required: !!f.required, options: f.options || null }))];
console.log(JSON.stringify({ cols, categories: F.CATEGORIES, incoterms: F.INCOTERMS, currencies: F.CURRENCIES }));
