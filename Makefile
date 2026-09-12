# Native build - whatever architecture this machine is.
all: obj/emulator

obj/emulator: cachesim.cpp emulator.cpp
	mkdir -p obj
	g++ -o obj/emulator cachesim.cpp emulator.cpp -g -std=c++11

# ---------------------------------------------------------------------
# Release binaries.
#
# electron-builder ships whatever is sitting at obj/emulator (obj/emulator.exe
# on Windows), so each target writes to that name and the per-platform npm
# scripts build the right one immediately before packaging.
#
# Linux and Windows are cross-built in containers so a release can be cut from
# a Mac. Both need Docker to be running.
# ---------------------------------------------------------------------

# One binary that runs on both Apple Silicon and Intel Macs.
release-mac: cachesim.cpp emulator.cpp
	rm -rf obj && mkdir -p obj
	g++ -arch arm64 -arch x86_64 -O2 -std=c++11 -o obj/emulator cachesim.cpp emulator.cpp
	lipo -archs obj/emulator

# Statically linked so it does not depend on the host's glibc version.
release-linux: cachesim.cpp emulator.cpp
	rm -rf obj && mkdir -p obj
	docker run --rm --platform linux/amd64 -v "$(CURDIR)":/src -w /src gcc:13 \
		g++ -O2 -std=c++11 -static -o obj/emulator cachesim.cpp emulator.cpp
	file obj/emulator

release-win: cachesim.cpp emulator.cpp
	rm -rf obj && mkdir -p obj
	docker run --rm --platform linux/amd64 -v "$(CURDIR)":/src -w /src debian:bookworm bash -lc "\
		apt-get update -qq && apt-get install -y -qq g++-mingw-w64-x86-64 >/dev/null && \
		x86_64-w64-mingw32-g++-posix -O2 -std=c++11 -static \
			-o obj/emulator.exe cachesim.cpp emulator.cpp"
	file obj/emulator.exe

clean:
	rm -rf obj

.PHONY: all release-mac release-linux release-win clean
