'use strict';
// Container planning · port map: where suppliers are, how full each loading port's next shipment is, and which
// moves between nearby ports (Shanghai ↔ Ningbo, Yantian ↔ Nansha) save money. Costs use the cheapest active
// logistics options (Logistics → costs); trucking between factory and port is an estimate.

const PL = require('./planning');

/** Loading ports on the map (UN/LOCODE → lon, lat of the container terminal). */
const PORT_GEO = {
  CNSHA: { ll: [122.07, 30.62], name: 'Shanghai', zh: '上海 · Yangshan', color: '#3a6fb0' },
  CNNGB: { ll: [121.86, 29.93], name: 'Ningbo', zh: '宁波 · Beilun', color: '#7a55b5' },
  CNYTN: { ll: [114.27, 22.58], name: 'Yantian', zh: '盐田 · Shenzhen', color: '#cf5a52' },
  CNCAN: { ll: [113.62, 22.74], name: 'Nansha', zh: '南沙 · Guangzhou', color: '#d08a1e' },
};
/** Map panels: the two areas where cargo can sensibly move between ports by truck. */
const REGIONS = [
  { id: 'east', title: 'East China · Shanghai & Ningbo', bb: [[118.4, 27.6], [123.5, 32.4]] },
  { id: 'south', title: 'South China · Yantian & Nansha', bb: [[111.8, 21.6], [118.9, 25.1]] },
];

// Manufacturing cities [key, English, 中文, lon, lat, extra aliases]
const C = (k, en, zh, lon, lat, ...alias) => ({ key: k, en, zh, ll: [lon, lat], alias });
const CITIES = [
  // Shanghai · Zhejiang · Jiangsu
  C('shanghai', 'Shanghai', '上海', 121.47, 31.23, 'songjiang', 'jiading', 'qingpu', 'fengxian', 'minhang', 'pudong', 'jinshan', '松江', '嘉定', '青浦', '奉贤', '闵行', '浦东', '金山'),
  C('ningbo', 'Ningbo', '宁波', 121.55, 29.87, 'beilun', 'yinzhou', 'zhenhai', '北仑', '鄞州', '镇海'),
  C('yuyao', 'Yuyao', '余姚', 121.15, 30.04), C('cixi', 'Cixi', '慈溪', 121.25, 30.17), C('fenghua', 'Fenghua', '奉化', 121.41, 29.66),
  C('ninghai', 'Ninghai', '宁海', 121.43, 29.29), C('xiangshan', 'Xiangshan', '象山', 121.87, 29.48), C('zhoushan', 'Zhoushan', '舟山', 122.2, 30.0),
  C('hangzhou', 'Hangzhou', '杭州', 120.16, 30.27, 'yuhang', 'xiaoshan', 'linping', '余杭', '萧山', '临平'), C('fuyang', 'Fuyang (Hangzhou)', '富阳', 119.96, 30.05),
  C('tonglu', 'Tonglu', '桐庐', 119.69, 29.79), C('jiaxing', 'Jiaxing', '嘉兴', 120.75, 30.75, 'jiashan', '嘉善'), C('haining', 'Haining', '海宁', 120.69, 30.51),
  C('tongxiang', 'Tongxiang', '桐乡', 120.56, 30.63), C('pinghu', 'Pinghu', '平湖', 121.02, 30.68), C('huzhou', 'Huzhou', '湖州', 120.09, 30.89, 'nanxun', '南浔'),
  C('anji', 'Anji', '安吉', 119.68, 30.64), C('deqing', 'Deqing', '德清', 119.97, 30.54), C('changxing', 'Changxing', '长兴', 119.91, 31.03),
  C('shaoxing', 'Shaoxing', '绍兴', 120.58, 30.03, 'keqiao', 'shangyu', '柯桥', '上虞'), C('zhuji', 'Zhuji', '诸暨', 120.24, 29.71), C('shengzhou', 'Shengzhou', '嵊州', 120.82, 29.59),
  C('jinhua', 'Jinhua', '金华', 119.65, 29.08), C('yiwu', 'Yiwu', '义乌', 120.07, 29.31), C('yongkang', 'Yongkang', '永康', 120.02, 28.9), C('dongyang', 'Dongyang', '东阳', 120.24, 29.29),
  C('wuyi', 'Wuyi', '武义', 119.81, 28.89), C('pujiang', 'Pujiang', '浦江', 119.89, 29.45), C('lanxi', 'Lanxi', '兰溪', 119.46, 29.21),
  C('taizhou-zj', 'Taizhou (Zhejiang)', '台州', 121.42, 28.66, 'jiaojiang', 'huangyan', 'luqiao', '黄岩', '路桥', '椒江'), C('wenling', 'Wenling', '温岭', 121.38, 28.37), C('linhai', 'Linhai', '临海', 121.14, 28.86),
  C('yuhuan', 'Yuhuan', '玉环', 121.23, 28.13), C('wenzhou', 'Wenzhou', '温州', 120.7, 28.0, 'ouhai', 'longwan', '瓯海', '龙湾'), C('ruian', 'Rui’an', '瑞安', 120.65, 27.78),
  C('yueqing', 'Yueqing', '乐清', 120.97, 28.12), C('lishui', 'Lishui', '丽水', 119.92, 28.45), C('quzhou', 'Quzhou', '衢州', 118.87, 28.94),
  C('suzhou', 'Suzhou', '苏州', 120.62, 31.3, 'wujiang', 'wuzhong', '吴江', '吴中'), C('kunshan', 'Kunshan', '昆山', 120.98, 31.39), C('changshu', 'Changshu', '常熟', 120.75, 31.65),
  C('zhangjiagang', 'Zhangjiagang', '张家港', 120.55, 31.88), C('taicang', 'Taicang', '太仓', 121.1, 31.46), C('wuxi', 'Wuxi', '无锡', 120.3, 31.57),
  C('jiangyin', 'Jiangyin', '江阴', 120.28, 31.92), C('yixing', 'Yixing', '宜兴', 119.82, 31.36), C('changzhou', 'Changzhou', '常州', 119.97, 31.81),
  C('nantong', 'Nantong', '南通', 120.86, 32.01, 'haimen', 'qidong', '海门', '启东'), C('nanjing', 'Nanjing', '南京', 118.8, 32.06), C('xuancheng', 'Xuancheng', '宣城', 118.76, 30.94),
  // Guangdong · Fujian
  C('guangzhou', 'Guangzhou', '广州', 113.26, 23.13, 'baiyun', 'tianhe', 'haizhu', '白云', '天河', '海珠'), C('panyu', 'Panyu', '番禺', 113.38, 22.94), C('huadu', 'Huadu', '花都', 113.22, 23.4),
  C('zengcheng', 'Zengcheng', '增城', 113.81, 23.29), C('conghua', 'Conghua', '从化', 113.59, 23.55), C('foshan', 'Foshan', '佛山', 113.12, 23.02, 'nanhai', '南海'),
  C('shunde', 'Shunde', '顺德', 113.29, 22.8), C('jiangmen', 'Jiangmen', '江门', 113.08, 22.58, 'xinhui', 'heshan', '新会', '鹤山'), C('zhongshan', 'Zhongshan', '中山', 113.39, 22.52),
  C('zhuhai', 'Zhuhai', '珠海', 113.58, 22.27), C('dongguan', 'Dongguan', '东莞', 113.75, 23.05, 'changan', 'humen', 'houjie', '长安', '虎门', '厚街'), C('shenzhen', 'Shenzhen', '深圳', 114.06, 22.54, 'baoan', 'longhua', 'longgang', '宝安', '龙华', '龙岗'),
  C('huizhou', 'Huizhou', '惠州', 114.42, 23.11, 'huiyang', 'boluo', 'huidong', '惠阳', '博罗', '惠东'), C('heyuan', 'Heyuan', '河源', 114.7, 23.74), C('qingyuan', 'Qingyuan', '清远', 113.06, 23.68),
  C('zhaoqing', 'Zhaoqing', '肇庆', 112.47, 23.05), C('shantou', 'Shantou', '汕头', 116.68, 23.35), C('chenghai', 'Chenghai', '澄海', 116.76, 23.47),
  C('chaozhou', 'Chaozhou', '潮州', 116.62, 23.66), C('jieyang', 'Jieyang', '揭阳', 116.37, 23.55, 'puning', '普宁'), C('shanwei', 'Shanwei', '汕尾', 115.37, 22.79),
  C('meizhou', 'Meizhou', '梅州', 116.12, 24.29), C('hongkong', 'Hong Kong', '香港', 114.17, 22.32), C('xiamen', 'Xiamen', '厦门', 118.09, 24.48),
  C('zhangzhou', 'Zhangzhou', '漳州', 117.65, 24.51), C('quanzhou', 'Quanzhou', '泉州', 118.59, 24.91), C('jinjiang', 'Jinjiang', '晋江', 118.55, 24.78),
];
const CITY = Object.fromEntries(CITIES.map((c) => [c.key, c]));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z一-鿿]/g, '');
const ALIASES = CITIES.flatMap((c) => [c.en, c.zh, ...c.alias].map((a) => [norm(a.replace(/\(.*\)/, '')), c.key])).filter(([a]) => a.length >= 2).sort((a, b) => b[0].length - a[0].length);

/** City of a supplier: the one set by hand, else the first city found in its address, then its name. */
function cityOf(s) {
  if (s?.geo_city && CITY[s.geo_city]) return { city: CITY[s.geo_city], how: 'set' };
  for (const field of [s?.address, s?.name, s?.notes]) {
    const t = norm(field);
    if (!t) continue;
    const hit = ALIASES.find(([a]) => t.includes(a));
    if (hit) return { city: CITY[hit[1]], how: 'guessed' };
  }
  return null;
}

/** Road distance estimate (km): great-circle × 1.3. */
function km(a, b) {
  const R = 6371; const r = Math.PI / 180;
  const dl = (b[1] - a[1]) * r; const dn = (b[0] - a[0]) * r;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x)) * 1.3;
}

/** Cheapest active ocean costs per container type / LCL from Logistics options (with defaults). */
function rates(options = []) {
  const best = (mode) => options.filter((o) => o.active !== false && o.mode === mode).map((o) => ({ rate: Number(o.rate_usd) || 0, fees: Number(o.fees_per_shipment_usd) || 0, min: Number(o.min_charge_usd) || 0 })).sort((a, b) => (a.rate + a.fees) - (b.rate + b.fees))[0];
  const box = (mode, dflt) => { const b = best(mode); return b ? b.rate + b.fees : dflt; };
  const lcl = best('LCL');
  return { '40HQ': box('FCL_40HQ', 5300), '40GP': box('FCL_40GP', 5000), '20GP': box('FCL_20GP', 3800), lcl: lcl ? { perCbm: lcl.rate, min: lcl.min, fees: lcl.fees } : { perCbm: 95, min: 0, fees: 650 }, fromLogistics: options.some((o) => o.active !== false && /^FCL_|^LCL$/.test(o.mode)) };
}

module.exports = { PORT_GEO, REGIONS, CITIES, CITY, cityOf, km, rates, CAPS: Object.fromEntries(PL.BOXES.map((b) => [b.code, b.cap])), LCL_MAX: PL.LCL_MAX || 15 };
