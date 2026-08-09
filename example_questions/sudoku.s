.text 
start:
	li sp 0x10000
	la s0 inputcnt
	lw s0 0(s0)
	la s5 inputs

input_loop:
	add a0 s5 zero
	addi a1 zero 0
	jal solve

	addi s5 s5 16
	addi s0 s0 -1
	bnez s0 input_loop

	la s0 inputcnt
	lw s0 0(s0)
	la s1 inputs
	la s2 answers
loop_answers:
	li s3 16
	addi s4 zero 0

	loop_answer:
		lb t2 0(s1)
		lb t3 0(s2)
		beq t2 t3 skip_different

		addi s4 s4 1

		skip_different:
		addi s1 s1 1
		addi s2 s2 1
		addi s3 s3 -1
		bnez s3 loop_answer

	li t4 0x10000
	sw s4 0(t4)

	addi s0 s0 -1
	bnez s0 loop_answers
	hcf


solve:
solve_pass:
	li t0 0          # cell index
	li t6 0          # whether this pass filled a cell

solve_cell:
	li a1 16
	bge t0 a1 solve_pass_done

	add t1 a0 t0
	lbu a2 0(t1)
	bnez a2 solve_next_cell

	# Candidate bits for values 1..4: 0b11110
	li t2 30

	# Exclude values already present in this cell's row.
	andi t3 t0 -4
	li t4 0

solve_row_loop:
	li a1 4
	bge t4 a1 solve_column_start

	add a1 t3 t4
	add a1 a0 a1
	lbu a2 0(a1)
	beq a2 zero solve_row_next

	li a3 1
	sll a3 a3 a2
	xori a3 a3 -1
	and t2 t2 a3

solve_row_next:
	addi t4 t4 1
	j solve_row_loop

	# Exclude values already present in this cell's column.
solve_column_start:
	andi t3 t0 3
	li t4 0

solve_column_loop:
	li a1 4
	bge t4 a1 solve_choose_value

	slli a1 t4 2
	add a1 a1 t3
	add a1 a0 a1
	lbu a2 0(a1)
	beq a2 zero solve_column_next

	li a3 1
	sll a3 a3 a2
	xori a3 a3 -1
	and t2 t2 a3

solve_column_next:
	addi t4 t4 1
	j solve_column_loop

	# Fill the cell only when exactly one candidate remains.
solve_choose_value:
	addi a1 t2 -1
	and a1 a1 t2
	bnez a1 solve_next_cell

	li t4 0

solve_bit_to_value:
	li a1 1
	beq t2 a1 solve_store_value
	srli t2 t2 1
	addi t4 t4 1
	j solve_bit_to_value

solve_store_value:
	sb t4 0(t1)
	li t6 1

solve_next_cell:
	addi t0 t0 1
	j solve_cell

solve_pass_done:
	bnez t6 solve_pass
	ret

### Do not modify beyond this point! ##<<
#########################################


.data
inputcnt:
.word 3
inputs: 
.byte 0 4 3 0 0 0 4 2 0 2 0 0 3 0 0 0
.byte 0 0 3 0 0 4 0 2 0 0 2 0 0 2 0 3
.byte 0 3 0 4 0 0 2 0 4 0 3 0 0 0 0 2

answers:
.byte 2 4 3 1 1 3 4 2 4 2 1 3 3 1 2 4 
.byte 2 1 3 4 3 4 1 2 4 3 2 1 1 2 4 3 
.byte 2 3 1 4 1 4 2 3 4 2 3 1 3 1 4 2 
