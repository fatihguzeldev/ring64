"""Calibrate one run and summarize what each DB E4 case actually did."""
import collections
import json
from pathlib import Path
import re
import sys

OPS = ["90", "db e4", "d9 d0", "9b", "f0 db e4"]
ROW = re.compile(
    r"case=([0-4]) pending=([01]) mp_em_ts=([0-7]) cr0=([0-9a-f]{8}) "
    r"vector=([0-9a-f]{2}) fault_at_subject=([01]) "
    r"before=([0-9a-f]{48}/[0-9a-f]{160}) after=([0-9a-f]{48}/[0-9a-f]{160})"
)
HEADER = re.compile(
    r"^guest vendor=(\w+) signature=([0-9a-f]{8}) features_ecx=([0-9a-f]{8}) "
    r"cr0=([0-9a-f]{8}) mode=protected32 cpl=0$", re.M
)


def status(image):
    raw = bytes.fromhex(image.split("/")[0])
    return int.from_bytes(raw[0:2], "little"), int.from_bytes(raw[2:4], "little"), raw[4]


def verify(receipt, host=None):
    text = Path(receipt).read_text()
    header = HEADER.search(text)
    assert header and "probe-complete cases=80" in text, receipt
    vendor, signature, features, start_cr0 = header.groups()
    if host:
        host_vendor = re.search(r"^Vendor ID:\s+(\w+)\s*$", Path(host).read_text(), re.M)
        assert host_vendor and host_vendor[1] == vendor, f"host vs guest vendor: {host}, {vendor}"
        assert vendor in ("GenuineIntel", "AuthenticAMD"), vendor

    rows = {}
    for line in text.splitlines():
        if not line.startswith("case="):
            continue
        match = ROW.fullmatch(line)
        assert match, line
        op, pending, control, cr0, vector, exact_pc, before, after = match.groups()
        op, pending, control = map(int, (op, pending, control))
        vector, cr0 = int(vector, 16), int(cr0, 16)
        assert (op, pending, control) not in rows
        assert (cr0 & 0xe) == control << 1 and (cr0 & ~0xe) == int(start_cr0, 16)
        assert int(exact_pc) == bool(vector)
        cw, sw, tags = status(before)
        assert cw == (0x037e if pending else 0x037f)
        assert sw & 0x3881 == (0x3881 if pending else 0x3800) and tags == 0x81
        rows[(op, pending, control)] = (vector, before, after)
    assert len(rows) == 80, len(rows)

    for (op, pending, control), (vector, before, after) in rows.items():
        if op == 0:
            assert vector == 0 and before == after, (op, pending, control, vector)
        elif op == 2:
            want = 7 if control & 6 else 16 if pending else 0
            assert vector == want, (op, pending, control, vector, want)
        elif op == 3:
            want = 7 if control & 5 == 5 else 16 if pending else 0
            assert vector == want, (op, pending, control, vector, want)

    summary = collections.defaultdict(dict)
    for (op, pending, control), (vector, before, after) in rows.items():
        summary[OPS[op]][f"pending={pending},mp_em_ts={control}"] = {
            "vector": vector,
            "fxImagePreserved": before == after,
        }
    return {"guest": {"vendor": vendor, "signature": signature, "featuresECX": features},
            "samples": len(rows), "calibration": "passed", "results": dict(summary)}


if __name__ == "__main__":
    print(json.dumps(verify(*sys.argv[1:]), indent=2))
