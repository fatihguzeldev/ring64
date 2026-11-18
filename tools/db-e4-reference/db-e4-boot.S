.section .multiboot,"a"
.align 4
.long 0x1badb002, 0, -0x1badb002

.section .text
.code32
.global _start
.extern probe_start, last_vector, fault_eip, resume_eip

_start:
    cli
    cld
    jmp 1f
1:  lgdt gdt_pointer
    ljmp $0x08, $2f
2:  movw $0x10, %ax
    movw %ax, %ds
    movw %ax, %es
    movw %ax, %fs
    movw %ax, %gs
    movw %ax, %ss
    movl $stack_end, %esp
    xorl %ebp, %ebp
    call probe_start
    ud2

.global probe_lidt
probe_lidt:
    movl 4(%esp), %eax
    lidt (%eax)
    ret

.macro handler num, error=0
.global probe_isr\num
probe_isr\num:
    .if \error
    addl $4, %esp
    .endif
    pushl $\num
    jmp handle
.endm
handler 6
handler 7
handler 8, 1
handler 13, 1
handler 14, 1
handler 16

handle:
    popl %eax
    movl %eax, last_vector
    movl (%esp), %eax
    movl %eax, fault_eip
    movl resume_eip, %eax
    testl %eax, %eax
    jz unexpected
    movl %eax, (%esp)
    iret
unexpected:
    movw $0xf4, %dx
    movl $2, %eax
    outl %eax, %dx
    cli
    hlt

.align 8
gdt:
    .quad 0
    .quad 0x00cf9a000000ffff
    .quad 0x00cf92000000ffff
gdt_pointer:
    .word 23
    .long gdt

.section .bss
.align 16
stack:
    .space 8192
stack_end:
.section .note.GNU-stack,"",@progbits
