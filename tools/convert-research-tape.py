"""Aggregate complete 09:30-16:00 NY sessions from the reference Yahoo 5m fixture."""
import datetime as dt
import gzip
import json
import sys
from collections import defaultdict
from zoneinfo import ZoneInfo
with gzip.open(sys.argv[1]) as f:
    frame = json.load(f)["chart"]["result"][0]
ny = ZoneInfo("America/New_York")
prices = frame["indicators"]["quote"][0]
days = defaultdict(list)
for i, epoch in enumerate(frame["timestamp"]):
    at = dt.datetime.fromtimestamp(epoch, ny)
    if dt.time(9,30) <= at.time() < dt.time(16):
        days[at.date()].append((at, i))
sessions = []
for day, rows in sorted(days.items()):
    start = dt.datetime.combine(day, dt.time(9,30), ny)
    if len(rows) != 78 or any(t != start + dt.timedelta(minutes=5*i) for i,(t,_) in enumerate(rows)):
        continue
    if any(prices[k][j] is None for _,j in rows for k in ("open","high","low","close","volume")):
        continue
    bars = []
    for i in range(0,78,3):
        group = [j for _,j in rows[i:i+3]]
        bars.append(dict(t=rows[i][0].isoformat(),o=prices["open"][group[0]],c=prices["close"][group[-1]],
                         h=max(prices["high"][j] for j in group),l=min(prices["low"][j] for j in group),
                         v=sum(prices["volume"][j] for j in group)))
    sessions.append(dict(date=day.isoformat(),open="09:30",close="16:00",bars=bars))
json.dump(dict(symbol=frame["meta"]["symbol"],source="Yahoo 5m archive, day-trader-skill 3d0f4ef",sessions=sessions),sys.stdout)
