import sys
from pathlib import Path
p=Path(__file__).resolve().parents[1]/".env.local"
secrets=[v for line in p.read_text().splitlines() if "=" in line for k,v in [line.split("=",1)] if len(v)>7 and any(x in k for x in ("PASSWORD","AUTH_KEY","TOKEN","SECRET"))]
for line in sys.stdin:
 for value in secrets:line=line.replace(value,"[REDACTED]")
 sys.stdout.write(line)
