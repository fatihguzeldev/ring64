#!/usr/bin/env python3
# Exact integer/Fraction arithmetic; expected values never call the production backend.
import argparse, fractions, json, pathlib, random
parser = argparse.ArgumentParser(description='Independent exact Fraction/raw80 x87 acceptance oracle; no Ring64 imports')
parser.add_argument('--output', required=True)
args = parser.parse_args()
rng = random.Random(116632353)
SIGN = 1 << 79

def frac(raw):
    exp = raw >> 64 & 32767
    sig = raw & (1 << 64) - 1
    power = (-16382 if exp == 0 else exp - 16383) - 63
    return fractions.Fraction((-1 if raw & SIGN else 1) * sig) * fractions.Fraction(2) ** power

def normexp(x):
    x = abs(x)
    n = x.numerator
    d = x.denominator
    e = n.bit_length() - d.bit_length()
    if x < fractions.Fraction(2) ** e:
        e -= 1
    return e

def raw(x, negativezero=False):
    if not x:
        return SIGN if negativezero else 0
    neg = x < 0
    x = abs(x)
    e = normexp(x)
    if e < -16382:
        v = x / fractions.Fraction(2) ** (-16445)
        assert v.denominator == 1
        mant = v.numerator
        exp = 0
    else:
        v = x / fractions.Fraction(2) ** (e - 63)
        assert v.denominator == 1
        mant = v.numerator
        exp = e + 16383
    assert 0 <= mant < 1 << 64 and 0 <= exp < 32767, (x, e, mant)
    return (SIGN if neg else 0) | exp << 64 | mant
rows = []
for i in range(600):
    ea = rng.choice([0, 1, 2, 16319, 16320, 16383, 16384, 16447, 16448, 32766, rng.randrange(1, 32767)])
    eb = rng.choice([0, 1, 2, 16383, max(1, min(32766, ea - rng.choice([-2, -1, 0, 1, 31, 32, 63, 64, 65, 96]))), rng.randrange(1, 32767)])
    a = rng.randrange(2) << 79 | ea << 64 | (rng.getrandbits(64) if ea == 0 else rng.getrandbits(63) | 1 << 63)
    b = rng.randrange(2) << 79 | eb << 64 | (rng.getrandbits(64) if eb == 0 else rng.getrandbits(63) | 1 << 63)
    if frac(b) == 0:
        continue
    for nearest in [False, True]:
        x, y = (frac(a), frac(b))
        D = normexp(x) - normexp(y) if x else -1
        partial = D >= 64
        shift = D - (32 + D % 32) if partial else 0
        z = x / y / fractions.Fraction(2) ** shift
        q = abs(z.numerator) // z.denominator
        if nearest and (not partial):
            rem = abs(z) - q
            q += rem > fractions.Fraction(1, 2) or (rem == fractions.Fraction(1, 2) and q & 1)
        q = -q if z < 0 else q
        result = x - y * q * fractions.Fraction(2) ** shift
        flags = 1024 if partial else (abs(q) & 4) << 6 | (abs(q) & 2) << 13 | (abs(q) & 1) << 9
        de = int(a >> 64 & 32767 == 0 and bool(a & (1 << 64) - 1) or (b >> 64 & 32767 == 0 and bool(b & (1 << 64) - 1))) << 1
        rows.append({'a': hex(a), 'b': hex(b), 'nearest': nearest, 'cw': rng.choice([895, 127, 639, 1919, 2943, 3967]), 'raw': hex(raw(result, bool(a & SIGN))), 'sw': flags | de})
remainder_rows = [{'operation': 'fprem1' if row.pop('nearest') else 'fprem', **row} for row in rows]
rng = random.Random(23258045)
S = 1 << 79
M = (1 << 64) - 1
INF = 604453686435277732577280

def floor_exp(x):
    e = x.numerator.bit_length() - x.denominator.bit_length()
    return e - (x < fractions.Fraction(2) ** e)

def rawq(x):
    if not x:
        return 0
    negative = x < 0
    x = abs(x)
    e = floor_exp(x)
    mant = x / fractions.Fraction(2) ** (e - 63)
    assert mant.denominator == 1
    return (S if negative else 0) | e + 16383 << 64 | mant.numerator
rows = []
for i in range(1000):
    exp = rng.choice([0, 1, 2, 16383, 32766, rng.randrange(1, 32767)])
    sig = rng.getrandbits(64) if exp == 0 else rng.getrandbits(63) | 1 << 63
    sig = sig or 1
    negative = bool(rng.randrange(2))
    a = (S if negative else 0) | exp << 64 | sig
    val = rng.choice([-100000, -50000, -32768, -16384, -65, -64, -1, 0, 1, 63, 64, 16384, 32768, 50000, 100000, rng.randrange(-40000, 40000)])
    bv = fractions.Fraction(val) + rng.choice([0, fractions.Fraction(3, 4), -fractions.Fraction(3, 4)])
    b = rawq(bv)
    n = abs(bv.numerator) // bv.denominator
    n = -n if bv < 0 else n
    masks = rng.randrange(64)
    rc = rng.randrange(4)
    cw = 64 | masks | rng.choice([0, 2, 3]) << 8 | rc << 10
    e = (-16445 if exp == 0 else exp - 16383 - 63) + sig.bit_length() - 1 + n
    mant = sig << 64 - sig.bit_length()
    pre = 2 if exp == 0 else 0
    post = 0
    up = False
    if pre & ~cw:
        out = a
        raised = pre
    else:
        sign = S if negative else 0
        if e > 16383:
            if not masks & 8:
                out = sign | INF if e - 24576 > 16383 else sign | e - 24576 + 16383 << 64 | mant
                post = 8
            else:
                infinity = rc == 0 or (rc == 1 and negative) or (rc == 2 and (not negative))
                out = sign | (INF if infinity else 604444463063240877801471)
                post = 40
                up = infinity
        elif e < -16382:
            if not masks & 16:
                out = sign if e + 24576 < -16382 else sign | e + 24576 + 16383 << 64 | mant
                post = 16
            else:
                shift = -16382 - e
                den = 1 << shift
                q, r = divmod(mant, den)
                up = bool(r and (rc == 0 and (2 * r > den or (2 * r == den and q & 1)) or (rc == 1 and negative) or (rc == 2 and (not negative))))
                q += up
                out = sign | (1 if q >= 1 << 63 else 0) << 64 | q
                post = 48 if r else 0
        else:
            out = sign | e + 16383 << 64 | mant
        raised = pre | post
    sw = raised | (512 if up else 0) | (32896 if raised & ~cw & 63 else 0)
    rows.append({'a': hex(a), 'b': hex(b), 'cw': cw, 'raw': hex(out), 'sw': sw})
scale_rows = [{'operation': 'fscale', **row} for row in rows]
report = {'kind': 'independent-exact-rational-raw80-oracle', 'seeds': {'remainder': '0x6f3ab21', 'scale': '0x162e3bd'}, 'ceiling': 'Finite operand arithmetic/status checks only; no hardware, invalid-class, encoding or memory-fault oracle.', 'cases': remainder_rows + scale_rows}
pathlib.Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
print(f'authored {len(remainder_rows)} remainder and {len(scale_rows)} scale cases')
