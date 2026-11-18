#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include <cpuid.h>
#include <inttypes.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef __APPLE__
#include <sys/sysctl.h>
#include <sys/ucontext.h>
#else
#include <ucontext.h>
#endif

typedef struct { _Alignas(16) unsigned char data[512]; } Image;
typedef struct { const char *name, *raw; } Case;
static void put(Image *image, unsigned offset, uint64_t value, unsigned bytes) {
    memcpy(image->data + offset, &value, bytes);
}
static uint64_t get(const Image *image, unsigned offset, unsigned bytes) {
    uint64_t value = 0;
    memcpy(&value, image->data + offset, bytes);
    return value;
}
static void raw80(Image *image, unsigned slot, const char *raw) {
    const char exponent[5] = {raw[0], raw[1], raw[2], raw[3], 0};
    const unsigned at = 32 + slot * 16;
    put(image, at, strtoull(raw + 4, NULL, 16), 8);
    put(image, at + 8, strtoul(exponent, NULL, 16), 2);
}
static void describe(const Image *image, uintptr_t pc) {
    printf("{\"cw\":\"%04" PRIx64 "\",\"sw\":\"%04" PRIx64 "\",\"ftw\":\"%02x\","
           "\"fop\":\"%04" PRIx64 "\",\"fipMatches\":%s,\"seedFipPreserved\":%s,"
           "\"fdpPreserved\":%s,\"slots\":[",
           get(image, 0, 2), get(image, 2, 2), image->data[4], get(image, 6, 2),
           get(image, 8, 8) == pc ? "true" : "false",
           get(image, 8, 8) == UINT64_C(0xabcdeffedc) ? "true" : "false",
           get(image, 16, 8) == UINT64_C(0x123456789a) ? "true" : "false");
    for (unsigned slot = 0; slot < 8; ++slot) {
        const unsigned at = 32 + slot * 16;
        printf("%s\"%04" PRIx64 "%016" PRIx64 "\"", slot == 0 ? "" : ",",
               get(image, at + 8, 2), get(image, at, 8));
    }
    fputs("]}", stdout);
}
static volatile uintptr_t producer_pc, detector_pc, restore_pc;
static volatile sig_atomic_t fault_stage, fault_signal, fault_vector, fault_code;

static void handle_fault(int sig, siginfo_t *info, void *opaque) {
    ucontext_t *context = opaque;
#ifdef __APPLE__
    uintptr_t pc = context->uc_mcontext->__ss.__rip;
    fault_vector = context->uc_mcontext->__es.__trapno;
#else
    uintptr_t pc = context->uc_mcontext.gregs[REG_RIP];
    fault_vector = context->uc_mcontext.gregs[REG_TRAPNO];
#endif
    if (pc == producer_pc)
        fault_stage = 1;
    else if (pc == detector_pc)
        fault_stage = 2;
    else
        _Exit(128 + sig);
    fault_signal = sig;
    fault_code = info->si_code;
#ifdef __APPLE__
    context->uc_mcontext->__ss.__rip = restore_pc;
#else
    context->uc_mcontext.gregs[REG_RIP] = restore_pc;
#endif
}

#define CAPTURE(OP) \
    __asm__ volatile( \
        "lea 1f(%%rip), %%rax; movq %%rax,%[producer];" \
        "lea 2f(%%rip), %%rax; movq %%rax,%[detector];" \
        "lea 3f(%%rip), %%rax; movq %%rax,%[restore];" \
        "fxsave64 (%[host]); fxrstor64 (%[in]); fxsave64 (%[before]);" \
        "1: " OP "; fxsave64 (%[out]);" \
        "2: fwait; 3: fxrstor64 (%[host])" \
        : [producer] "=m"(producer_pc), [detector] "=m"(detector_pc), [restore] "=m"(restore_pc) \
        : [host] "r"(&host), [in] "r"(&in), [before] "r"(&before), [out] "r"(&out) \
        : "rax", "memory")

static void capture(const Case *test, int source, int occupied, unsigned top, uint16_t cw, uint16_t cc, int control) {
    Image in = {{0}}, before = {{0}}, out = {{0}}, host = {{0}};
    unsigned previous = (top + 7) & 7, second = (top + 1) & 7;
    const uint16_t sw = (top << 11) | cc | (control == 2 || control == 3 ? 0x8081 : 0);
    put(&in, 0, cw, 2);
    put(&in, 2, sw, 2);
    in.data[4] = (source ? 1 << top : 0) | (occupied ? 1 << previous : 0) | 1 << second;
    put(&in, 6, 0x456, 2);
    put(&in, 8, 0xabcdeffedc, 8);
    put(&in, 16, 0x123456789a, 8);
    put(&in, 24, 0x1f80, 4);
    raw80(&in, 0, test->raw);
    raw80(&in, 1, "4001dedecafebabebeef");
    raw80(&in, 7, "bffe8888444422221111");
    fault_stage = fault_signal = fault_vector = fault_code = 0;
    if (control == 1) {
        CAPTURE("fsqrt");
    } else if (control == 3 || control == 4) {
        CAPTURE("nop");
    } else {
        CAPTURE("fsincos");
    }
    printf("{\"case\":\"%s\",\"raw\":\"%s\",\"source\":%d,\"occupied\":%d,\"top\":%u,\"before\":",
        test->name, test->raw, source, occupied, top);
    describe(&before, producer_pc);
    fputs(",\"out\":", stdout);
    describe(&out, producer_pc);
    printf(",\"control\":%d,\"faultStage\":%d,\"signal\":%d,\"vector\":%d,\"signalCode\":%d}\n",
        control, fault_stage, fault_signal, fault_vector, fault_code);
}

static void observe(const Case *test, int source, int occupied, unsigned top, uint16_t cw, uint16_t cc) {
    capture(test, source, occupied, top, cw, cc, 0);
}

int main(void) {
    struct sigaction action = {0};
    action.sa_sigaction = handle_fault;
    action.sa_flags = SA_SIGINFO;
    if (sigemptyset(&action.sa_mask) || sigaction(SIGFPE, &action, NULL)) {
        perror("install SIGFPE handler");
        return 1;
    }

    unsigned a, b, c, d;
    char vendor[13];
    __cpuid(0, a, b, c, d);
    memcpy(vendor, &b, 4);
    memcpy(vendor + 4, &d, 4);
    memcpy(vendor + 8, &c, 4);
    vendor[12] = 0;
    __cpuid(1, a, b, c, d);
    int translated = -1;
#ifdef __APPLE__
    size_t length = sizeof(translated);
    (void)sysctlbyname("sysctl.proc_translated", &translated, &length, NULL, 0);
#endif
    printf("{\"vendor\":\"%s\",\"signature\":\"%08x\",\"translated\":%d}\n", vendor, a, translated);

    const Case cases[] = {
        {"plus-zero", "00000000000000000000"}, {"minus-zero", "80000000000000000000"},
        {"half", "3ffe8000000000000000"}, {"minus-half", "bffe8000000000000000"},
        {"quarter", "3ffd8000000000000000"},
        {"threshold-below", "403dffffffffffffffff"}, {"threshold-at", "403e8000000000000000"},
        {"threshold-above", "403e8000000000000001"}, {"negative-threshold", "c03e8000000000000000"},
        {"plus-infinity", "7fff8000000000000000"}, {"minus-infinity", "ffff8000000000000000"},
        {"quiet", "ffffc000000000000042"}, {"signaling", "7fffa000000000000045"},
        {"unsupported", "40000000000000000011"},
        {"min-subnormal", "00000000000000000001"}, {"min-normal", "00018000000000000000"},
        {"negative-min-normal", "80018000000000000000"},
        {"negative-min-subnormal", "80000000000000000001"},
        {"pseudo-denormal", "00008000000000000000"},
        {"tiny-normal", "3f9b8000000000000000"}, {"negative-tiny-normal", "bf9b8000000000000000"},
    };
    capture(&cases[3], 1, 0, 0, 0x037e, 0x4700, 1);
    capture(&cases[2], 1, 0, 0, 0x037e, 0x4700, 2);
    capture(&cases[2], 1, 0, 0, 0x037e, 0x4700, 3);
    capture(&cases[2], 1, 0, 0, 0x037e, 0x4700, 4);
    const uint16_t cws[] = {0x37f, 0x37e, 0x37d, 0x36f, 0x35f, 0x36d, 0x34f};
    for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        for (int occupied = 0; occupied <= 1; ++occupied) {
            for (unsigned rc = 0; rc < 4; ++rc) {
                for (unsigned j = 0; j < sizeof(cws) / sizeof(cws[0]); ++j)
                    for (unsigned c2 = 0; c2 < 2; ++c2)
                        observe(&cases[i], 1, occupied, 0, cws[j] | (rc << 10), 0x4300 | (c2 << 10));
            }
        }
    }
    for (int occupied = 0; occupied <= 1; ++occupied) {
        observe(&cases[2], 0, occupied, 0, 0x037f, 0x4700);
        observe(&cases[2], 0, occupied, 0, 0x037e, 0x4700);
    }
    const unsigned pcs[] = {0, 2, 3};
    for (unsigned i = 0; i < sizeof(pcs)/sizeof(pcs[0]); ++i)
        for (unsigned rc = 0; rc < 4; ++rc)
            observe(&cases[2], 1, 0, 7, 0x007f | (pcs[i] << 8) | (rc << 10), 0x4700);
    return 0;
}
