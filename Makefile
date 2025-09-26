all: obj/emulator

obj/emulator: cachesim.cpp emulator.cpp
	mkdir -p obj
	g++ -o obj/emulator cachesim.cpp emulator.cpp -g -std=c++11
