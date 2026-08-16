"""Sync public Google Sheet to dashboard.json.

Supported source layout (current workbook):
Row 1: Date | DG1 | DG2 | DG3 | DG-4 | DG-5 | DG-6
Row 2:      | Running Hours | Diesel Balance % | Diesel Balance Actuals | Fuel Added | ...
Rows 3+:  day number + values.

Each DG occupies four columns. The worksheet name supplies month/year,
for example "Aug 26"; the Date column contains day numbers 1..31.

No Google credentials are required because the source sheet is public.
"""
import io, json, os, re
from datetime import datetime
from pathlib import Path

import pandas as pd
import requests

ROOT=Path(__file__).resolve().parents[1]
CONFIG=json.loads((ROOT/"config/dgs.json").read_text(encoding="utf-8"))
OUT=ROOT/"site/data/dashboard.json"
SHEET_ID=os.getenv("GOOGLE_SHEET_ID","1ewUi24xgWh2FVODrjkP7OPzrvfHW7DrM")
EXPORT_URL=f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=xlsx"
DG_IDS=[d["id"] for d in CONFIG["dgs"]]

METRICS=["running hours","diesel balance %","diesel balance actuals","fuel added"]

def norm(v):
    return re.sub(r"[^a-z0-9%]+"," ",str(v).strip().lower()).strip()

def numeric(v):
    if pd.isna(v): return None
    if isinstance(v,str): v=v.replace("%","").replace(",","").replace("L","").strip()
    try: return float(v)
    except (ValueError,TypeError): return None

def download():
    r=requests.get(EXPORT_URL,timeout=60,headers={"User-Agent":"DG-Dashboard/1.0"})
    r.raise_for_status()
    if "text/html" in r.headers.get("content-type","").lower():
        raise RuntimeError("Google returned HTML. Confirm the spreadsheet is public without login.")
    return r.content

def parse_month_year(sheet_name):
    """Parse worksheet names such as JUL 26, Aug 26, September 2026."""
    text = str(sheet_name).strip()
    match = re.search(
        r"(?i)(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|"
        r"jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|"
        r"nov(?:ember)?|dec(?:ember)?)\s*[-_/ ]*\s*(\d{2}|\d{4})",
        text,
    )
    if not match:
        raise ValueError(
            f"Cannot determine month/year from worksheet {sheet_name!r}. "
            f"Expected a name such as 'JUL 26' or 'Aug 2026'."
        )

    month_token = match.group(1)[:3].title()
    month = datetime.strptime(month_token, "%b").month
    year_token = match.group(2)
    year = int(year_token)
    if len(year_token) == 2:
        year += 2000

    return year, month

def canonical_dg(v):
    if pd.isna(v): return None
    s=re.sub(r"[^a-z0-9]","",str(v).lower())
    m=re.fullmatch(r"dg([1-6])",s)
    return f"DG{m.group(1)}" if m else None

def parse_sheet(raw,sheet):
    """Parse one monthly worksheet with a two-row DG/metric header.

    Important: the sheet has rows through day 31, but future blank rows may
    contain formula-generated zeros. A DG row is emitted only when it has a
    real entered reading. This keeps the latest available date at the last
    actual entry (13-Aug in the current sheet).
    """
    raw_df=pd.read_excel(io.BytesIO(raw),sheet_name=sheet,header=None)
    if raw_df.shape[0]<3:
        print(f"[{sheet}] skipped: fewer than 3 rows")
        return []

    dg_header_row=None
    metric_header_row=None
    for i in range(min(10,len(raw_df))):
        vals=[str(x) for x in raw_df.iloc[i].tolist() if not pd.isna(x)]
        dg_count=sum(1 for x in vals if canonical_dg(x) is not None)
        metric_count=sum(
            1 for x in vals
            if any(norm(x)==m or m in norm(x) for m in METRICS)
        )
        if dg_count>=3:
            dg_header_row=i
        if metric_count>=3:
            metric_header_row=i

    if dg_header_row is None or metric_header_row is None:
        raise ValueError(
            f"[{sheet}] Could not find DG/metric header rows. "
            f"Expected two header rows such as Date/DG1/DG2/... and "
            f"Running Hours/Diesel Balance %/..."
        )

    year,month=parse_month_year(sheet)
    print(f"[{sheet}] header rows: DG={dg_header_row}, metrics={metric_header_row}; period={year}-{month:02d}")

    # Merged DG headers are represented as a value in the first column of
    # each four-column group. Forward-fill the DG name across its group.
    dg_by_col=[]
    current=None
    for c in range(raw_df.shape[1]):
        d=canonical_dg(raw_df.iat[dg_header_row,c])
        if d:
            current=d
        dg_by_col.append(current)

    metric_by_col=[]
    for c in range(raw_df.shape[1]):
        v=norm(raw_df.iat[metric_header_row,c])
        found=None
        for m in METRICS:
            if v==m or m in v:
                found=m
                break
        metric_by_col.append(found)

    readings=[]
    # Keep last seen values per DG to allow duplicate-detection when needed
    prev_values_per_dg = {dg: None for dg in DG_IDS}
    DEBUG = os.getenv("SYNC_DEBUG")
    for r in range(max(dg_header_row,metric_header_row)+1,raw_df.shape[0]):
        day=numeric(raw_df.iat[r,0])
        if day is None or not (1<=day<=31):
            continue

        try:
            dt=datetime(year,month,int(day)).date().isoformat()
        except ValueError:
            continue

        for dg in DG_IDS:
            values={
                "running hours":None,
                "diesel balance %":None,
                "diesel balance actuals":None,
                "fuel added":0
            }

            for c,dg_name in enumerate(dg_by_col):
                if dg_name != dg:
                    continue
                metric=metric_by_col[c]
                if metric:
                    values[metric]=numeric(raw_df.iat[r,c])

            # Ensure fuel added is numeric 0 when cell is blank (numeric may
            # return None and override the default 0). Treat None as 0.
            if values.get("fuel added") is None:
                values["fuel added"] = 0

            # Blank future rows commonly contain formula-generated values.
            # Treat rows that are identical to the previous non-empty row for
            # the same DG (and with zero fuel added) as non-real copied rows.
            has_real_reading=(
                values["running hours"] is not None
                or values["diesel balance %"] is not None
                or (
                    values["diesel balance actuals"] is not None
                    and values["diesel balance actuals"] != 0
                )
                or values["fuel added"] != 0
            )

            if not has_real_reading:
                if DEBUG:
                    print(f"[{sheet}] row {r} day {dt} dg {dg} skipped: has_real_reading={has_real_reading} values={values}")
                continue
            if DEBUG:
                print(f"[{sheet}] row {r} day {dt} dg {dg} accepted: values={values}")

            readings.append({
                "date":dt,
                "dg":dg,
                "runningHours":values["running hours"],
                "fuelPercent":values["diesel balance %"],
                "fuelActual":values["diesel balance actuals"],
                "fuelAdded":values["fuel added"] or 0
            })

    real_days=sorted({r["date"] for r in readings})
    print(
        f"[{sheet}] parsed {len(readings)} DG readings; "
        f"real data through {real_days[-1] if real_days else 'NONE'}"
    )
    return readings

def main():
    raw=download()
    workbook=pd.ExcelFile(io.BytesIO(raw))
    all_rows=[]
    print(f"Source worksheets: {workbook.sheet_names}")
    for sheet in workbook.sheet_names:
        try:
            all_rows.extend(parse_sheet(raw,sheet))
        except Exception as e:
            print(f"[{sheet}] ERROR: {e}")

    dedup={(r["date"],r["dg"]):r for r in all_rows}
    readings=sorted(dedup.values(),key=lambda x:(x["date"],x["dg"]))
    result={
        "generatedAt":datetime.now().astimezone().isoformat(timespec="seconds"),
        "source":{"type":"public-google-sheet","sheetId":SHEET_ID,"worksheets":workbook.sheet_names},
        "readings":readings,
        "externalTankReadings":[],
        "config":CONFIG
    }
    OUT.write_text(json.dumps(result,indent=2,ensure_ascii=False),encoding="utf-8")
    print(f"Total: wrote {len(readings)} DG readings to {OUT}")
    if readings:
        print(f"Date range: {readings[0]['date']} to {readings[-1]['date']}")
        print("Latest records:")
        for x in readings[-6:]:
            print(x)
    else:
        print("No DG readings recognized.")

if __name__=="__main__":
    main()
