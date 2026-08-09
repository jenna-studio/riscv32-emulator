.text
start:
	li sp 0x10000

	# sltu must be an unsigned comparison, not an addition
	li t0 5
	li t1 10
	sltu t2 t0 t1		# x07 expect 1
	sltu t3 t1 t0		# x28 expect 0
	li t4 -1
	sltu t5 t4 t0		# x30 expect 0  (0xffffffff >u 5)
	slt t6 t4 t0		# x31 expect 1  (-1 <s 5)

	# shift amounts must be masked to 5 bits
	li a0 1
	li a1 33
	sll a2 a0 a1		# x12 expect 2   (33 & 31 == 1)

	# srl is logical, sra is arithmetic
	li a3 -16
	srli a4 a3 1		# x14 expect 0x7ffffff8
	srai a5 a3 1		# x15 expect 0xfffffff8

	# writes to x0 must not stick
	add x0 t0 t1		# x00 expect 0

	# byte loads: signed vs unsigned
	la a6 bytes
	lb a7 0(a6)		# x17 expect 0xffffffff
	lbu s2 0(a6)		# x18 expect 0x000000ff

	hcf

.data
bytes:
	.byte -1
	.byte 1
	.byte 2
	.byte 3
