import sys,zipfile,xml.etree.ElementTree as E,json,re
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as z:
 strings=[]
 if 'xl/sharedStrings.xml' in z.namelist():
  strings=[''.join(e.itertext()) for e in E.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si',ns)]
 rows=[]
 for row in E.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('.//s:sheetData/s:row',ns):
  out=[]
  for c in row.findall('s:c',ns):
   col=re.match('[A-Z]+',c.attrib['r'])[0];idx=0
   for ch in col:idx=idx*26+ord(ch)-64
   while len(out)<idx:out.append(None)
   v=c.find('s:v',ns);val=v.text if v is not None else None
   if c.attrib.get('t')=='s':val=strings[int(val)] if val is not None else ''
   elif c.attrib.get('t')=='inlineStr':val=''.join(c.find('s:is',ns).itertext())
   elif val is not None:
    try:val=float(val);val=int(val) if val.is_integer() else val
    except ValueError:pass
   out[idx-1]=val
  rows.append(out)
 print(json.dumps({'数据':rows},ensure_ascii=True))
