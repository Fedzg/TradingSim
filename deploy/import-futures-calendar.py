"""Import operator-verified CME Last Trade instants from CSV into the worker state."""
import csv
import json
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

def convert(row):
    symbol = row['symbol']
    if not re.fullmatch(r'(?:(?:GC|MGC)[FGHJKMNQUVXZ]\d{2}\.CMX|(?:CL|MCL|BZ)[FGHJKMNQUVXZ]\d{2}\.NYM)', symbol):
        raise ValueError('Contratto non valido')
    url = urlsplit(row['source'])
    if url.scheme != 'https' or url.hostname not in ('cmegroup.com','www.cmegroup.com') or len(url.path)<2:
        raise ValueError('Fonte CME richiesta')
    instant = datetime.fromisoformat(row['lastTradeAt'])
    zone = ZoneInfo(row['timezone'])
    if instant.tzinfo is None or not re.search(r'T\d\d:\d\d',row['lastTradeAt']) or instant.astimezone(zone).utcoffset()!=instant.utcoffset():
        raise ValueError('Ora locale e offset verificati richiesti')
    return dict(symbol=symbol,lastTradeAt=instant.isoformat(),source=row['source'],timezone=row['timezone'])

if __name__ == '__main__':
    target=Path(sys.argv[2])
    with open(sys.argv[1],newline='',encoding='utf-8-sig') as source:
        rows=[convert(row) for row in csv.DictReader(source)]
    if not rows or len(set(r['symbol'] for r in rows))!=len(rows):
        raise ValueError('Catalogo vuoto o duplicati')
    with tempfile.NamedTemporaryFile(mode='w',dir=target.parent,delete=False) as out:
        json.dump(rows,out)
        out.flush()
        os.fsync(out.fileno())
    os.replace(out.name,target)
