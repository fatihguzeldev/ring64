#include <cpuid.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { _Alignas(16) uint8_t bytes[512]; } Area;

static uint16_t word(const uint8_t *bytes) {
    uint16_t value;
    memcpy(&value, bytes, sizeof(value));
    return value;
}

static uint64_t quad(const uint8_t *bytes) {
    uint64_t value;
    memcpy(&value, bytes, sizeof(value));
    return value;
}

static void raw80(uint8_t *bytes, const char *hex) {
    if (!hex) return;
    if (strlen(hex) != 20) abort();
    const char high[5] = {hex[0], hex[1], hex[2], hex[3], 0};
    const uint16_t se = (uint16_t)strtoul(high, 0, 16);
    const uint64_t sig = strtoull(hex + 4, 0, 16);
    memcpy(bytes, &sig, sizeof(sig));
    memcpy(bytes + 8, &se, sizeof(se));
}

static void observe(const char *name, const char *x, const char *y, uint16_t cw) {
    Area in = {{0}}, out = {{0}}, host = {{0}};
    const uint16_t sw = 0x3a00; /* TOP 7, C1 initially set */
    const uint16_t fop = 0x456;
    const uint32_t mxcsr = 0x1f80;
    const uint64_t fdp = 0x123456789a;
    memcpy(in.bytes, &cw, sizeof(cw));
    memcpy(in.bytes + 2, &sw, sizeof(sw));
    in.bytes[4] = (x ? 0x80 : 0) | (y ? 1 : 0) | 2;
    memcpy(in.bytes + 6, &fop, sizeof(fop));
    memcpy(in.bytes + 16, &fdp, sizeof(fdp));
    memcpy(in.bytes + 24, &mxcsr, sizeof(mxcsr));
    raw80(in.bytes + 32, x);
    raw80(in.bytes + 48, y);
    raw80(in.bytes + 64, "bffddecafbad11223344");
    uintptr_t pc;
    __asm__ volatile(
        "lea 1f(%%rip), %[pc]; fxsave64 (%[host]); fxrstor64 (%[in]);"
        "1: fpatan; fxsave64 (%[out]); fxrstor64 (%[host])"
        : [pc] "=&r"(pc)
        : [host] "r"(&host), [in] "r"(&in), [out] "r"(&out)
        : "memory");
    printf("{\"case\":\"%s\",\"x\":\"%s\",\"y\":\"%s\",\"cw\":\"%04x\","
           "\"outCW\":\"%04x\",\"sw\":\"%04x\",\"ftw\":\"%02x\",\"fop\":\"%04x\","
           "\"fipMatches\":%s,\"fdpPreserved\":%s,\"slots\":[",
        name, x ? x : "empty", y ? y : "empty", cw,
        word(out.bytes), word(out.bytes + 2), out.bytes[4], word(out.bytes + 6),
        quad(out.bytes + 8) == pc ? "true" : "false",
        quad(out.bytes + 16) == fdp ? "true" : "false");
    for (unsigned logical = 0; logical < 8; logical++) {
        const size_t offset = 32 + 16 * logical;
        printf("%s\"%04x%016" PRIx64 "\"", logical ? "," : "",
            word(out.bytes + offset + 8), quad(out.bytes + offset));
    }
    puts("]}");
}

#define ONE "3fff8000000000000000"
#define HALF "3ffe8000000000000000"
#define ZERO "00000000000000000000"
#define NZERO "80000000000000000000"
#define INF "7fff8000000000000000"
#define NINF "ffff8000000000000000"
#define QNAN "7fffc000000000000042"
#define NQNAN "ffffc000000000000044"
#define SNAN "7fffa000000000000045"
#define UNKNOWN "40000000000000000011"
#define MINSUB "00000000000000000001"
#define PSEUDO "00008000000000000000"
#define MINNORMAL "00018000000000000000"
#define FOUR "40018000000000000000"

int main(void) {
    unsigned a, b, c, d;
    char vendor[13];
    __cpuid(0, a, b, c, d);
    memcpy(vendor, &b, 4);
    memcpy(vendor + 4, &d, 4);
    memcpy(vendor + 8, &c, 4);
    vendor[12] = 0;
    __cpuid(1, a, b, c, d);
    printf("{\"vendor\":\"%s\",\"signature\":\"%08x\"}\n", vendor, a);

    const char *axis[] = {ZERO, NZERO, ONE, "bfff8000000000000000", INF, NINF};
    for (unsigned xi = 0; xi < 6; xi++)
        for (unsigned yi = 0; yi < 6; yi++)
            for (unsigned rc = 0; rc < 4; rc++)
                observe("axis", axis[xi], axis[yi], (uint16_t)(0x37f | (rc << 10)));

    const unsigned pc[] = {0, 2, 3};
    for (unsigned p = 0; p < 3; p++)
        for (unsigned rc = 0; rc < 4; rc++)
            for (unsigned masks = 0x5f; masks <= 0x7f; masks += 0x20) {
                const uint16_t cw = (uint16_t)(masks | (pc[p] << 8) | (rc << 10));
                observe("asymmetric", ONE, HALF, cw);
                observe("asymmetric-negative", ONE, "bffe8000000000000000", cw);
                observe("pi", "bfff8000000000000000", ZERO, cw);
            }

    const struct { const char *label, *x, *y; } inputs[] = {
        {"empty-x", 0, ONE}, {"empty-y", ONE, 0},
        {"empty-and-unsupported", 0, UNKNOWN}, {"empty-both", 0, 0},
        {"qnan-x", QNAN, ONE}, {"qnan-y", ONE, NQNAN},
        {"snan-x", SNAN, ONE}, {"snan-y", ONE, SNAN},
        {"qnan-pair", QNAN, NQNAN}, {"qnan-wins", SNAN, NQNAN},
        {"qnan-and-denormal", QNAN, MINSUB}, {"snan-and-denormal", MINSUB, SNAN},
        {"unsupported-wins", UNKNOWN, SNAN}, {"unsupported-x", UNKNOWN, ONE},
        {"denormal-x", MINSUB, FOUR}, {"denormal-y", FOUR, MINSUB},
        {"pseudo-x", PSEUDO, ONE}, {"pseudo-y", ONE, PSEUDO},
        {"denormal-x-yzero", MINSUB, ZERO}, {"denormal-x-yinf", MINSUB, INF},
        {"xzero-denormal-y", ZERO, MINSUB}, {"xinf-denormal-y", INF, MINSUB},
        {"xnegativeinf-denormal-y", NINF, MINSUB},
    };
    const uint16_t pre_masks[] = {0x37f, 0x37e, 0x37d, 0x36d};
    for (unsigned i = 0; i < sizeof(inputs) / sizeof(inputs[0]); i++)
        for (unsigned m = 0; m < sizeof(pre_masks) / sizeof(pre_masks[0]); m++)
            observe(inputs[i].label, inputs[i].x, inputs[i].y, pre_masks[m]);

    for (unsigned rc = 0; rc < 4; rc++)
        for (unsigned masks = 0x4f; masks <= 0x7f; masks += 0x10) {
            const uint16_t cw = (uint16_t)(0x300 | (rc << 10) | masks);
            observe("two-normal-underflow", FOUR, MINNORMAL, cw);
            observe("two-normal-near-pi", "c0018000000000000000", MINNORMAL, cw);
            observe("minimum-normal-seam", ONE, MINNORMAL, cw);
            observe("halfway-subnormal", "403f8000000000000000", "0002c000000000000000", cw);
            observe("tiny-ratio", ONE, "3f9b8000000000000000", cw);
            observe("lowest-ratio", "7ffeffffffffffffffff", MINSUB, cw);
        }
    return 0;
}
