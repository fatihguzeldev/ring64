#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef __APPLE__
#include <sys/sysctl.h>
#endif

typedef struct { _Alignas(16) unsigned char bytes[512]; } image;
static image host;
static sigjmp_buf before;
static volatile sig_atomic_t stage, trapped, trap_code;

static void recover(int signum, siginfo_t *info, void *ctx) {
    (void)ctx;
    trapped = signum;
    trap_code = info->si_code;
    __asm__ volatile("fxrstor64 %0" : : "m"(host) : "memory");
    siglongjmp(before, 1);
}
static unsigned word(const image *data, unsigned offset) {
    uint16_t word;
    memcpy(&word, data->bytes + offset, 2);
    return word;
}
static unsigned long long quad(const image *data, unsigned offset) {
    unsigned long long quad;
    memcpy(&quad, data->bytes + offset, 8);
    return quad;
}
#define TEST(BYTES) __asm__ volatile( \
  "fxrstor64 %2; fxsave64 %0; movl $2,%3; " BYTES "; fxsave64 %1; fxrstor64 %4" \
  : "=m"(pre), "=m"(post), "+m"(in), "+m"(stage) : "m"(host) : "memory")
static void observe(unsigned pending, unsigned kind) {
    const char *names[] = {"INT-NOP", "DB-E4", "FNOP", "WAIT", "LOCK-DB-E4", "F3-DB-E4", "F2-DB-E4"};
    image in = host, pre = {{0}}, post = {{0}};
    const uint16_t cw = pending ? 0x037e : 0x037f;
    const uint16_t sw = pending ? 0xba81 : 0x3a00;
    const uint16_t opcode = 0x3d2;
    const uint64_t fip = 0x12345678, fdp = 0x87654321;
    memcpy(in.bytes, &cw, 2);
    memcpy(in.bytes+2, &sw, 2);
    in.bytes[4] = 0x80;
    memcpy(in.bytes+6, &opcode, 2);
    memcpy(in.bytes+8, &fip, 8);
    memcpy(in.bytes+16,&fdp,8);
    stage = 1;
    trapped = trap_code = 0;
    if (sigsetjmp(before, 1) == 0) {
        switch (kind) {
        case 0: TEST(".byte 0x66,0x90"); break;
        case 1: TEST(".byte 0xdb,0xe4"); break;
        case 2: TEST(".byte 0xd9,0xd0"); break;
        case 3: TEST(".byte 0x9b"); break;
        case 4: TEST(".byte 0xf0,0xdb,0xe4"); break;
        case 5: TEST(".byte 0xf3,0xdb,0xe4"); break;
        case 6: TEST(".byte 0xf2,0xdb,0xe4"); break;
        }
    }
    printf("%s pending=%u trapped=%d code=%d stage=%d cw=%04x/%04x sw=%04x/%04x fop=%04x/%04x fip=%llx/%llx fdp=%llx/%llx\n",
        names[kind],pending,trapped,trap_code,stage,word(&pre,0),word(&post,0),word(&pre,2),word(&post,2),
        word(&pre,6),word(&post,6),quad(&pre,8),quad(&post,8),quad(&pre,16),quad(&post,16));
}
int main(void) {
#ifdef __APPLE__
    int translated = 0;
    size_t length = sizeof(translated);
    if (!sysctlbyname("sysctl.proc_translated", &translated, &length, NULL, 0))
        printf("translated=%d\n", translated);
#endif
    struct sigaction sa = {.sa_sigaction = recover, .sa_flags = SA_SIGINFO};
    sigaction(SIGILL, &sa, NULL);
    sigaction(SIGFPE, &sa, NULL);
    sigaction(SIGSEGV, &sa, NULL);
    __asm__ volatile("fxsave64 %0" : "=m"(host) : : "memory");
    for (unsigned pending = 0; pending <= 1; pending++)
        for (unsigned kind = 0; kind <= 6; kind++)
            observe(pending, kind);
}
