#include <stdint.h>

struct area { _Alignas(16) uint8_t bytes[512]; };
struct gate { uint16_t lo, cs, type, hi; };
struct idtr { uint16_t limit; uint32_t base; } __attribute__((packed));
static struct gate idt[256];
volatile uint32_t last_vector, fault_eip, resume_eip;
static volatile uint32_t subject_eip;

extern void probe_lidt(const struct idtr *);
extern void probe_isr6(void), probe_isr7(void), probe_isr8(void);
extern void probe_isr13(void), probe_isr14(void), probe_isr16(void);

static void gate(unsigned i, void (*fn)(void)) {
    const uintptr_t address = (uintptr_t)fn;
    idt[i] = (struct gate){(uint16_t)address, 8, 0x8e00, (uint16_t)(address >> 16)};
}

static void outb(uint16_t port, uint8_t value) {
    __asm__ volatile ("outb %0, %1" :: "a"(value), "Nd"(port));
}

static uint8_t inb(uint16_t port) {
    uint8_t out;
    __asm__ volatile ("inb %1, %0" : "=a"(out) : "Nd"(port));
    return out;
}

static void serial(char value) {
    while (!(inb(0x3fd) & 0x20)) {}
    outb(0x3f8, (uint8_t)value);
}

static void text(const char *str) {
    while (*str) serial(*str++);
}

static void hex(uint32_t value, unsigned digits) {
    static const char map[] = "0123456789abcdef";
    while (digits) serial(map[(value >> (4 * --digits)) & 15]);
}

static void field(const char *key, uint32_t value, unsigned digits) {
    text(key);
    hex(value, digits);
}

static uint32_t cr0(void) {
    uint32_t value;
    __asm__ volatile ("mov %%cr0, %0" : "=r"(value));
    return value;
}

static void set_cr0(uint32_t value) {
    __asm__ volatile ("mov %0, %%cr0" :: "r"(value) : "memory");
}

static void base_cr4(void) {
    uint32_t value;
    __asm__ volatile ("mov %%cr4, %0" : "=r"(value));
    value |= 0x200;
    __asm__ volatile ("mov %0, %%cr4" :: "r"(value) : "memory");
}

static void cpuid(
    unsigned leaf, uint32_t *a, uint32_t *b, uint32_t *c, uint32_t *d
) {
    __asm__ volatile ("cpuid" : "=a"(*a), "=b"(*b), "=c"(*c), "=d"(*d) : "a"(leaf), "c"(0));
}

static void guest_identity(void) {
    uint32_t a, b, c, d;
    cpuid(0, &a, &b, &c, &d);
    text("guest vendor=");
    const uint32_t vendor[] = {b, d, c};
    for (unsigned i = 0; i < 3; ++i)
        for (unsigned j = 0; j < 4; ++j)
            serial((char)(vendor[i] >> (8 * j)));
    cpuid(1, &a, &b, &c, &d);
    field(" signature=", a, 8);
    field(" features_ecx=", c, 8);
    field(" cr0=", cr0(), 8);
    text(" mode=protected32 cpl=0\n");
}

static void write32(uint8_t *where, uint32_t value) {
    for (unsigned i = 0; i < 4; ++i) where[i] = (uint8_t)(value >> (8*i));
}

static void fxsave(struct area *area) {
    __asm__ volatile ("fxsave %0" : "=m"(*area) :: "memory");
}

static void fxrstor(const struct area *area) {
    __asm__ volatile ("fxrstor %0" :: "m"(*area) : "memory");
}

static void print_fx(const struct area *area) {
    for (unsigned i = 0; i < 24; ++i) hex(area->bytes[i], 2);
    serial('/');
    for (unsigned slot = 0; slot < 8; ++slot)
        for (unsigned i = 0; i < 10; ++i)
            hex(area->bytes[32 + 16*slot + i], 2);
}

#define INSN(bytes) \
    __asm__ volatile ("movl $1f, %0; movl $2f, %1; 1: .byte " bytes "; 2:" \
                      : "=m"(subject_eip), "=m"(resume_eip) :: "eax", "cc", "memory")

static void run_case(uint32_t base, unsigned control, unsigned pending, unsigned op) {
    static struct area seed, before, after;
    const uint16_t cw = pending ? 0x037e : 0x037f;
    const uint16_t sw = pending ? 0xba81 : 0x3a00;
    write32(seed.bytes, (uint32_t)sw << 16 | cw);
    write32(seed.bytes + 4, 0x01f30081);
    write32(seed.bytes + 8, 0x11112222);
    write32(seed.bytes + 12, 0x00000008);
    write32(seed.bytes + 16, 0x33334444);
    write32(seed.bytes + 20, 0x00000010);
    write32(seed.bytes + 24, 0x1f80);
    write32(seed.bytes + 36, 0x81234567);
    write32(seed.bytes + 40, 0x00003fff);
    write32(seed.bytes + 52, 0x92345678);
    write32(seed.bytes + 56, 0x0000bffe);

    fxrstor(&seed);
    fxsave(&before);
    last_vector = fault_eip = 0;
    const uint32_t requested = base | (control << 1);
    set_cr0(requested);
    switch (op) {
        case 0: INSN("0x90"); break;
        case 1: INSN("0xdb,0xe4"); break;
        case 2: INSN("0xd9,0xd0"); break;
        case 3: INSN("0x9b"); break;
        case 4: INSN("0xf0,0xdb,0xe4"); break;
    }
    resume_eip = 0;
    const uint32_t observed = cr0();
    set_cr0(base);
    fxsave(&after);
    __asm__ volatile ("fninit" ::: "memory");

    field("case=", op, 1);
    field(" pending=", pending, 1);
    field(" mp_em_ts=", control, 1);
    field(" cr0=", observed, 8);
    field(" vector=", last_vector, 2);
    field(" fault_at_subject=", last_vector != 0 && fault_eip == subject_eip, 1);
    text(" before=");
    print_fx(&before);
    text(" after=");
    print_fx(&after);
    serial('\n');
}

void probe_start(void) {
    outb(0x3f9, 0);
    outb(0x3fb, 0x80);
    outb(0x3f8, 1);
    outb(0x3f9, 0);
    outb(0x3fb, 3);

    gate(6, probe_isr6);
    gate(7, probe_isr7);
    gate(8, probe_isr8);
    gate(13, probe_isr13);
    gate(14, probe_isr14);
    gate(16, probe_isr16);
    const struct idtr pointer = {sizeof(idt)-1, (uintptr_t)idt};
    probe_lidt(&pointer);
    const uint32_t base = (cr0() | 0x20) & ~0x0e;
    set_cr0(base);
    base_cr4();
    guest_identity();

    for (unsigned op = 0; op < 5; ++op)
        for (unsigned pending = 0; pending < 2; ++pending)
            for (unsigned control = 0; control < 8; ++control)
                run_case(base, control, pending, op);

    text("probe-complete cases=80\n");
    __asm__ volatile ("outl %%eax, %%dx" :: "a"(1), "d"(0xf4) : "memory");
    for (;;) __asm__ volatile ("hlt");
}
