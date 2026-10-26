"""Fails unless torch sees the RTX 2070 (Turing, sm_75) through CUDA."""
import sys

import torch

ok = torch.cuda.is_available()
print("torch", torch.__version__, "cuda", torch.version.cuda, "available", ok)
if not ok:
    sys.exit("CUDA not available: check the NVIDIA driver and that the cu1xx torch wheel was installed")
cap = torch.cuda.get_device_capability(0)
arches = torch.cuda.get_arch_list()
print("device", torch.cuda.get_device_name(0), "capability", cap, "bf16", torch.cuda.is_bf16_supported())
print("arch list", arches)
if cap != (7, 5) or "sm_75" not in arches:
    sys.exit(f"expected capability (7, 5) with sm_75 kernels, got {cap} / {arches}")
# A real kernel launch catches "no kernel image is available" that the checks above miss.
print("matmul ok", float((torch.ones(64, 64, device="cuda") @ torch.ones(64, 64, device="cuda"))[0, 0]))
