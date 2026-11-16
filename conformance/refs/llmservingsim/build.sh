#!/usr/bin/env bash
# Build LLMServingSim at the commit in `lock` into a directory, ready for `LLMSERVINGSIM_DIR=<dir> pnpm conformance:reference --ref llmservingsim`.
#
#     conformance/refs/llmservingsim/build.sh <dir> [<python>]
#
# Needs git, cmake, a C++17 compiler, protoc and its headers (Linux: build-essential cmake protobuf-compiler libprotobuf-dev; macOS: brew install cmake
# protobuf), and Python 3.10 with `requirements.txt` installed (<python> defaults to python3). Takes about five minutes. It does not run
# `scripts/compile.sh` (which needs `nproc`) and builds only the congestion-unaware analytical backend, which is the one the simulator uses by default;
# the ns-3 and htsim submodules are not fetched. Chakra is not pip-installed: the simulator imports `chakra.src.converter...` from the checkout's copy of
# it, so this script makes `<dir>/.chakra-shim/chakra` (symlinks to that copy's `src` and `schema`) and the runs use `LLMSERVINGSIM_PYTHONPATH=<dir>/.chakra-shim`.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="${1:?usage: build.sh <dir> [<python>]}"
commit="$(grep -v '^#' "$here/lock" | grep -E '^[0-9a-f]{40}$' | head -n 1)"
test -n "$commit" || { echo "$here/lock has no 40-character commit" >&2; exit 1; }

if [ ! -d "$dir/.git" ]; then git clone --quiet https://github.com/casys-kaist/LLMServingSim.git "$dir"; fi
git -C "$dir" checkout --quiet "$commit"
# the astra-sim submodule at its pinned commit, and only the sub-submodules the analytical build needs
git -C "$dir" submodule update --init -- astra-sim
git -C "$dir/astra-sim" submodule update --init --recursive -- extern/helper/fmt extern/helper/spdlog extern/graph_frontend/chakra extern/network_backend/analytical extern/memory_backend/analytical

build="$dir/astra-sim/build/astra_analytical/build"
proto="$dir/astra-sim/extern/graph_frontend/chakra/schema/protobuf"
mkdir -p "$build"
( cd "$proto" && protoc et_def.proto --proto_path=. --cpp_out=. && protoc et_def.proto --proto_path=. --python_out=. )

jobs="$( (command -v nproc >/dev/null && nproc) || sysctl -n hw.ncpu )"
flags=()
if [ "$(uname)" = Darwin ]; then
  # libc++ dropped std::unary_function and std::binary_function, which ASTRA-Sim's old dependencies use; Homebrew's protobuf needs abseil linked in
  brew_lib="$(brew --prefix)/lib"
  flags+=("-DCMAKE_CXX_FLAGS=-D_LIBCPP_ENABLE_CXX17_REMOVED_UNARY_BINARY_FUNCTION" "-DCMAKE_EXE_LINKER_FLAGS=-L$brew_lib $(ls "$brew_lib"/libabsl_*.dylib | grep -v '\.[0-9]*\.[0-9]*\.[0-9]*\.dylib$' | tr '\n' ' ')")
fi
( cd "$build" && cmake .. -DBUILDTARGET=congestion_unaware "${flags[@]}" && cmake --build . -j "$jobs" )
# the simulator starts the binary through this path (the upstream build script makes the same link)
mkdir -p "$build/AnalyticalAstra/bin"
ln -sfn "$build/bin/AstraSim_Analytical_Congestion_Unaware" "$build/AnalyticalAstra/bin/AnalyticalAstra"
chakra="$dir/astra-sim/extern/graph_frontend/chakra"
mkdir -p "$dir/.chakra-shim/chakra"
touch "$dir/.chakra-shim/chakra/__init__.py"
ln -sfn "$chakra/src" "$dir/.chakra-shim/chakra/src"
ln -sfn "$chakra/schema" "$dir/.chakra-shim/chakra/schema"
test -x "$build/bin/AstraSim_Analytical_Congestion_Unaware" || { echo "the analytical binary was not built" >&2; exit 1; }
echo "built $dir at $commit; run with LLMSERVINGSIM_DIR=$dir LLMSERVINGSIM_PYTHONPATH=$dir/.chakra-shim LLMSERVINGSIM_PYTHON=<python with requirements.txt>"
