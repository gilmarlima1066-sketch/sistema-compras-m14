import csv, sys, openpyxl, time
origem, destino = sys.argv[1], sys.argv[2]
t0 = time.time()
wb = openpyxl.load_workbook(origem, read_only=True, data_only=True)
ws = wb[wb.sheetnames[0]]
n = 0
with open(destino, 'w', newline='', encoding='utf-8') as fh:
    w = csv.writer(fh)
    for row in ws.iter_rows(values_only=True):
        w.writerow(['' if c is None else (c.isoformat(sep=' ') if hasattr(c, 'isoformat') else c) for c in row])
        n += 1
wb.close()
print(f"{destino}: {n} linhas em {time.time()-t0:.0f}s")
