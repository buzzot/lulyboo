#!/usr/bin/env python3
"""Build public/Lulyboo_Supplier_Product_Template.xlsx — the bulk-upload / quotation template.

Layout (one sheet, read by src/importer.js):
  1. Factory details           — once per file (informational; the portal knows the supplier from the login)
  2. Terms for all products    — once per file: currency, Incoterm, port, payment, valid until, origin, sample lead time
  3. Products                  — one row per product; columns grouped Product / Price & order / Packing / Container / Other

Labels in sections 1–2 are "English / 中文" in one cell; the value goes in the cell to the right.
The product table has an English header row (read by the importer) and a Chinese header row (skipped).
Column labels come from src/fields.js so the importer always recognises them.

Usage: python3 scripts/make_template.py   (run from the repo root; needs openpyxl + node)
"""
import json, os, subprocess, sys
from openpyxl import Workbook
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter as L
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.comments import Comment

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fields = json.loads(subprocess.check_output(['node', os.path.join(ROOT, 'scripts', 'fields-json.js')]))
BY_KEY = {c['key']: c for c in fields['cols'] if c['key']}

# ── Product table columns (order + grouping). Header labels = fields.js csv names. ──
GROUPS = [
    ('PRODUCT', '产品信息', ['supplier_sku', 'product_name', 'category', 'subcategory', 'description', 'materials',
                         'product_size_cm', 'unit_net_weight_kg', 'packaging_type', 'certifications', 'hs_code', 'dangerous_goods']),
    ('PRICE & ORDER', '价格与订单', ['unit_price', 'moq', 'production_lead_days']),
    ('PACKING & MASTER CARTON', '包装与外箱', ['units_per_inner', 'units_per_carton', 'carton_l_cm', 'carton_w_cm', 'carton_h_cm',
                                          'carton_nw_kg', 'carton_gw_kg', '_cbm']),
    ('CONTAINER (optional)', '装柜（选填）', ['supplier_qty_20gp', 'supplier_qty_40gp', 'supplier_qty_40hq']),
    ('OTHER', '其他', ['photo_link', 'factory_notes']),
]
# Display labels (EN header must stay importer-compatible; CN row is free text)
EN = {k: BY_KEY[k]['csv'] for k in BY_KEY}
EN.update({'supplier_sku': 'Item No. / SKU', 'product_name': 'Product Name *', '_cbm': 'CBM per Carton (auto)'})
CN = {k: BY_KEY[k]['cn'] for k in BY_KEY}
CN.update({'unit_price': '单价（按上方币种）', '_cbm': '外箱体积 m³（自动）', 'supplier_qty_20gp': '20GP 装柜数量（件）',
           'supplier_qty_40gp': '40GP 装柜数量（件）', 'supplier_qty_40hq': '40HQ 装柜数量（件）'})
WIDTH = {'supplier_sku': 22, 'product_name': 28, 'category': 15, 'subcategory': 15, 'description': 34, 'materials': 18,
         'product_size_cm': 16, 'unit_net_weight_kg': 11, 'packaging_type': 16, 'certifications': 18, 'hs_code': 11,
         'dangerous_goods': 15, 'unit_price': 11, 'moq': 10, 'production_lead_days': 12, 'units_per_inner': 10,
         'units_per_carton': 10, 'carton_l_cm': 9, 'carton_w_cm': 9, 'carton_h_cm': 9, 'carton_nw_kg': 10,
         'carton_gw_kg': 10, '_cbm': 11, 'supplier_qty_20gp': 11, 'supplier_qty_40gp': 11, 'supplier_qty_40hq': 11,
         'photo_link': 26, 'factory_notes': 30}
EXAMPLE = {'supplier_sku': 'NB-1001', 'product_name': 'Example: Organic muslin swaddle 2-pack', 'category': 'Infant/Toddler',
           'subcategory': 'Swaddles', 'description': '2 prints per pack, gift box', 'materials': '100% organic cotton',
           'product_size_cm': '120 x 120', 'unit_net_weight_kg': 0.4, 'packaging_type': 'Gift box with window',
           'certifications': 'CPSIA, OEKO-TEX', 'hs_code': '6307.90', 'dangerous_goods': 'No', 'unit_price': 3.2,
           'moq': 1000, 'production_lead_days': 45, 'units_per_inner': 6, 'units_per_carton': 24, 'carton_l_cm': 50,
           'carton_w_cm': 35, 'carton_h_cm': 30, 'carton_nw_kg': 9.6, 'carton_gw_kg': 10.6,
           'photo_link': 'https://example.com/swaddle', 'factory_notes': ''}
DATA_ROWS = 200

# ── Styles ──
FONT = 'Arial'
BRAND, BRAND_SOFT, INK, MUTED = 'D9776A', 'FBEAE6', '2B2623', '7A716B'
INPUT = PatternFill('solid', fgColor='FFF9DB')     # cells the factory fills in
LABEL = PatternFill('solid', fgColor='F4F1EE')
EXFILL = PatternFill('solid', fgColor='EFEFEF')
AUTO = PatternFill('solid', fgColor='E8F0FB')      # calculated, do not type
BAR = PatternFill('solid', fgColor=BRAND)
GROUP_FILLS = ['F3D9D3', 'F6E6C8', 'DCEBDD', 'DDE6F3', 'ECE6F3']
thin = Side(style='thin', color='D8CFC8')
BOX = Border(left=thin, right=thin, top=thin, bottom=thin)
f = lambda **kw: Font(name=FONT, **kw)

wb = Workbook()
ws = wb.active
ws.title = 'Quotation 报价单'
ws.sheet_view.showGridLines = False
cols = [k for _, _, ks in GROUPS for k in ks]
NCOL = len(cols)
for i, k in enumerate(cols, 1):
    ws.column_dimensions[L(i)].width = WIDTH.get(k, 12)

def bar(row, text):
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=NCOL)
    c = ws.cell(row=row, column=1, value=text)
    c.font = f(bold=True, color='FFFFFF', size=11); c.fill = BAR; c.alignment = Alignment(vertical='center', indent=1)
    ws.row_dimensions[row].height = 22

def pair(row, col, label, span, key=None, fmt=None):
    """Label cell at col, value cell(s) to the right spanning `span` columns."""
    lc = ws.cell(row=row, column=col, value=label)
    lc.font = f(bold=True, size=9, color=INK); lc.fill = LABEL; lc.border = BOX
    lc.alignment = Alignment(wrap_text=True, vertical='center', indent=1)
    vc = ws.cell(row=row, column=col + 1)
    if span > 1: ws.merge_cells(start_row=row, start_column=col + 1, end_row=row, end_column=col + span)
    for cc in range(col + 1, col + span + 1):
        ws.cell(row=row, column=cc).fill = INPUT; ws.cell(row=row, column=cc).border = BOX
    vc.font = f(size=10); vc.alignment = Alignment(vertical='center', indent=1)
    if fmt: vc.number_format = fmt
    return vc

# ── Title ──
logo = os.path.join(ROOT, 'scripts', 'lulyboo-logo.png')
if os.path.exists(logo):
    img = XLImage(logo); img.width, img.height = 150, 52; ws.add_image(img, 'A1')
ws.merge_cells('C1:L1'); ws.merge_cells('C2:L2')
ws['C1'] = 'FACTORY QUOTATION  ·  工厂报价单'; ws['C1'].font = f(bold=True, size=18, color=INK)
ws['C2'] = 'Fill in the yellow cells. Factory details and terms once at the top, then one row per product.  请填写黄色单元格：顶部填写一次工厂信息和条款，下方每个产品填写一行。'
ws['C2'].font = f(size=9, color=MUTED)
for r, h in ((1, 30), (2, 18), (3, 8)): ws.row_dimensions[r].height = h

# ── 1. Factory details ──
bar(4, '1   FACTORY DETAILS  ·  工厂信息')
pair(5, 1, 'Factory / Company Name\n工厂 / 公司名称', 3)
pair(5, 5, 'Contact Person\n联系人', 3)
pair(5, 9, 'Phone / WeChat\n电话 / 微信', 3)
pair(6, 1, 'Factory Address\n工厂地址', 3)
pair(6, 5, 'Email\n邮箱', 3)
pair(6, 9, 'Quotation Date\n报价日期', 3, fmt='yyyy-mm-dd')
for r in (5, 6): ws.row_dimensions[r].height = 32
ws.row_dimensions[7].height = 8

# ── 2. Terms for all products ──
bar(8, '2   TERMS FOR ALL PRODUCTS IN THIS FILE  ·  以下条款适用于本文件所有产品')
cur = pair(9, 1, 'Currency\n币种', 1)
inc = pair(9, 3, 'Incoterm\n贸易术语', 1)
pair(9, 5, 'FOB Port / Delivery Point\nFOB 港口 / 交货地点', 3)
pair(9, 9, 'Payment Terms\n付款条款', 3)
valid = pair(10, 1, 'Quote Valid Until\n报价有效期至', 1, fmt='yyyy-mm-dd')
pair(10, 3, 'Country of Origin\n原产国', 1)
pair(10, 5, 'Sample Lead Time (days)\n样品交期（天）', 3, fmt='0')
for r in (9, 10): ws.row_dimensions[r].height = 32
cur.value, inc.value = 'USD', 'FOB'
ws.row_dimensions[11].height = 8

# ── 3. Products ──
bar(12, '3   PRODUCTS — ONE ROW PER PRODUCT  ·  产品清单（每个产品一行）')
GR, HR, CR, EXR = 13, 14, 15, 16           # group row, EN header, CN header, example
FIRST = EXR + 1
LAST = FIRST + DATA_ROWS - 1
c0 = 1
for gi, (gen, gcn, ks) in enumerate(GROUPS):
    c1 = c0 + len(ks) - 1
    if c1 > c0: ws.merge_cells(start_row=GR, start_column=c0, end_row=GR, end_column=c1)
    g = ws.cell(row=GR, column=c0, value=f'{gen}  ·  {gcn}')
    g.font = f(bold=True, size=9, color=INK); g.alignment = Alignment(horizontal='center', vertical='center')
    for cc in range(c0, c1 + 1):
        ws.cell(row=GR, column=cc).fill = PatternFill('solid', fgColor=GROUP_FILLS[gi]); ws.cell(row=GR, column=cc).border = BOX
    c0 = c1 + 1
ws.row_dimensions[GR].height = 20

col_of = {k: i for i, k in enumerate(cols, 1)}
for k, i in col_of.items():
    h = ws.cell(row=HR, column=i, value=EN[k]); h.font = f(bold=True, size=9, color='FFFFFF')
    h.fill = PatternFill('solid', fgColor='5B524D' if k != '_cbm' else '6F8FB8'); h.border = BOX
    h.alignment = Alignment(wrap_text=True, horizontal='center', vertical='center')
    z = ws.cell(row=CR, column=i, value=CN[k]); z.font = f(size=9, color=MUTED); z.fill = PatternFill('solid', fgColor='F7F3F0')
    z.border = BOX; z.alignment = Alignment(wrap_text=True, horizontal='center', vertical='center')
ws.row_dimensions[HR].height = 40; ws.row_dimensions[CR].height = 30

NUM = {'unit_net_weight_kg': '0.000', 'unit_price': '#,##0.00##', 'moq': '#,##0', 'production_lead_days': '0',
       'units_per_inner': '#,##0', 'units_per_carton': '#,##0', 'carton_l_cm': '0.0', 'carton_w_cm': '0.0',
       'carton_h_cm': '0.0', 'carton_nw_kg': '0.00', 'carton_gw_kg': '0.00', 'supplier_qty_20gp': '#,##0',
       'supplier_qty_40gp': '#,##0', 'supplier_qty_40hq': '#,##0', '_cbm': '0.0000'}
Lc, Wc, Hc = (L(col_of[k]) for k in ('carton_l_cm', 'carton_w_cm', 'carton_h_cm'))
for r in range(EXR, LAST + 1):
    ex = r == EXR
    for k, i in col_of.items():
        c = ws.cell(row=r, column=i); c.border = BOX; c.font = f(size=10, color=MUTED if ex else INK)
        c.fill = EXFILL if ex else (AUTO if k == '_cbm' else INPUT)
        if k in NUM: c.number_format = NUM[k]
        if k in ('description', 'factory_notes'): c.alignment = Alignment(wrap_text=True, vertical='top')
        if k == '_cbm':
            c.value = f'=IF(AND(ISNUMBER({Lc}{r}),ISNUMBER({Wc}{r}),ISNUMBER({Hc}{r})),{Lc}{r}*{Wc}{r}*{Hc}{r}/1000000,"")'
        elif ex and k in EXAMPLE:
            c.value = EXAMPLE[k]

# ── Data validation ──
def dv_list(values, ref, title):
    dv = DataValidation(type='list', formula1='"' + ','.join(values) + '"', allow_blank=True, showErrorMessage=False,
                        promptTitle=title, prompt='Choose or type · 请选择或输入', showInputMessage=False)
    ws.add_data_validation(dv); dv.add(ref)
dv_list(fields['currencies'], cur.coordinate, 'Currency')
dv_list(fields['incoterms'], inc.coordinate, 'Incoterm')
dv_list(fields['categories'], f'{L(col_of["category"])}{FIRST}:{L(col_of["category"])}{LAST}', 'Category')
dv_list(['No', 'Battery', 'Magnet', 'Liquid', 'Other'], f'{L(col_of["dangerous_goods"])}{FIRST}:{L(col_of["dangerous_goods"])}{LAST}', 'Special cargo')
numdv = DataValidation(type='decimal', operator='greaterThanOrEqual', formula1='0', allow_blank=True, showErrorMessage=True,
                       errorTitle='Numbers only · 请填写数字', error='Enter a number without units (e.g. 10.6). 请只填写数字（如 10.6），不要带单位。')
ws.add_data_validation(numdv)
for k in NUM:
    if k != '_cbm': numdv.add(f'{L(col_of[k])}{FIRST}:{L(col_of[k])}{LAST}')
datedv = DataValidation(type='date', operator='greaterThan', formula1='1', allow_blank=True, showErrorMessage=True,
                        error='Enter a date, e.g. 2026-12-31 · 请填写日期，如 2026-12-31')
ws.add_data_validation(datedv); datedv.add(valid.coordinate)

ws.cell(row=HR, column=col_of['_cbm']).comment = Comment('Calculated from carton L × W × H. Do not type here.\n根据外箱长×宽×高自动计算，无需填写。', 'Lulyboo')
ws.cell(row=HR, column=col_of['unit_price']).comment = Comment('Price per piece, in the currency chosen at the top.\n每件单价，币种见上方。', 'Lulyboo')

ws.freeze_panes = ws.cell(row=FIRST, column=3)   # keep headers + SKU/name visible
ws.print_title_rows = f'{GR}:{CR}'
ws.page_setup.orientation = 'landscape'; ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0
ws.sheet_properties.pageSetUpPr.fitToPage = True

# ── Instructions sheet ──
ins = wb.create_sheet('Instructions 说明')
ins.sheet_view.showGridLines = False
ins.column_dimensions['A'].width = 4; ins.column_dimensions['B'].width = 70; ins.column_dimensions['C'].width = 60
rows = [
    ('How to fill in this quotation', '填写说明', True),
    ('', '', False),
    ('1. Fill in the yellow cells only. Grey row = example (it is ignored). Blue cells are calculated.', '1. 只需填写黄色单元格。灰色行为示例（不会导入），蓝色单元格为自动计算。', False),
    ('2. Factory details and terms are entered ONCE at the top and apply to every product.', '2. 工厂信息和条款只需在顶部填写一次，适用于所有产品。', False),
    ('3. Products: one row per product. Product Name is required.', '3. 产品清单：每个产品一行，产品名称为必填。', False),
    ('4. Unit Price is per piece, in the currency chosen at the top.', '4. 单价为每件价格，币种见顶部。', False),
    ('5. Sizes in centimetres (cm), weights in kilograms (kg). Numbers only, no units in the cells.', '5. 尺寸单位为厘米，重量单位为千克。单元格内只填数字，不要带单位。', False),
    ('6. Master carton = the outer shipping carton. CBM and container quantities are calculated for you.', '6. 外箱指出货大箱。体积和装柜数量会自动计算，装柜数量可选填。', False),
    ("7. Children's products: list certificates (CPSIA, CPC, ASTM F963…).", '7. 儿童产品请注明认证（CPSIA、CPC、ASTM F963 等）。', False),
    ('8. Upload this file in the Lulyboo Supplier Portal → Bulk upload. Then add photos to each product.', '8. 在 Lulyboo 供应商平台“批量上传”此文件，然后为每个产品上传图片。', False),
    ('9. Do not rename, move or delete the header rows or columns.', '9. 请勿修改、移动或删除标题行和列。', False),
]
for i, (en, zh, title) in enumerate(rows, 2):
    ins.cell(row=i, column=2, value=en).font = f(bold=title, size=14 if title else 10, color=INK)
    ins.cell(row=i, column=3, value=zh).font = f(bold=title, size=14 if title else 10, color=INK)
    for c in (2, 3): ins.cell(row=i, column=c).alignment = Alignment(wrap_text=True, vertical='top')
leg = len(rows) + 3
for j, (fill, en, zh) in enumerate([(INPUT, 'Fill in', '需填写'), (EXFILL, 'Example (ignored)', '示例（不导入）'), (AUTO, 'Calculated', '自动计算')]):
    c = ins.cell(row=leg + j, column=2, value=f'{en} · {zh}'); c.fill = fill; c.border = BOX; c.font = f(size=10)

out = os.path.join(ROOT, 'public', 'Lulyboo_Supplier_Product_Template.xlsx')
wb.save(out)
print(out, f'header row {HR}, first data row {FIRST}, columns {NCOL}')
