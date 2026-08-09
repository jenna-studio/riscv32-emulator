.text 
start:
	# Load parameters and call solve
	li sp 0x10000
	la t0 inputcnt
	lw a0 0(t0)
	la a1 inputs
	la a2 masks

	jal solve


	# Compare answer
	la t0 answer
	lw t0 0(t0)
	la t1 submitted
	lw t1 0(t1)
	beq t0 t1 correct_answer

wrong_answer:
	li t4 0x10000
	li t0 1
	sw t0 0(t4)
	hcf

correct_answer:
	li t4 0x10000
	sw zero 0(t4)
	hcf

########################################
###### "solve" function should call this function
submit:
	la t0 submitted
	sw a0 0(t0)
	ret


solve:
	addi sp sp -4
	sw ra 0(sp)

	li t0 0          # index
	li t1 0          # sum

loop:
	bge t0 a0 done

	add t2 a1 t0
	lb t3 0(t2)      # signed input value

	add t2 a2 t0
	lbu t4 0(t2)     # mask value
	beq t4 zero skip

	add t1 t1 t3

skip:
	addi t0 t0 1
	j loop

done:
	mv a0 t1
	jal submit

	lw ra 0(sp)
	addi sp sp 4
	ret

### Do not modify beyond this point! ##<<
#########################################


.data
inputcnt:
.word 16
inputs: 
# all correct
.byte -1  4  3  1  1  3 -4  2 -4  2  1  3  3  1 -2  4 
masks:
.byte  1  1  0  1  0  0  1  0  1  0  0  0  1  1  1  1
answer:
.word  2
submitted:
.word  0

